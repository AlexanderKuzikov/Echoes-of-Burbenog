// A room is one match and the one owner of the `Simulation` behind it. Nothing in this file decides
// anything about a match: it steps the core, counts what the core produced and hands the result to
// whoever is connected. A rule that is not the core's does not exist here, because a second rule book
// next to the core is exactly what the whole phase forbids.
//
// What this file *does* own is the lifecycle of the room, because nobody else can own it: who is
// sitting in it, which seat may restart or close it, and what a connection that has lost its seat is
// told. Those are three permissions and no more. `placeTower` and `startWave` are core commands and
// any seat may send them — the board and the aether belong to the room, and splitting either would be
// a second rule book, which is the next task's decision and not this file's.

import { randomBytes } from 'node:crypto';
import { TICK_RATE, createSimulation, createTrainingScenario } from '../game-core/index.ts';
import type { Command, MatchConfig, Simulation, SimulationEvent } from '../game-core/index.ts';
import {
  CONTENT_VERSION,
  MAP_VERSION,
  PROTOCOL_VERSION,
  checkHandshake,
  emptyEventTally,
  isSeatToken,
} from '../protocol/index.ts';
import type {
  CommandAnswer,
  EventTally,
  HandshakeRefused,
  LifecycleAnswer,
  RoomClosure,
  RoomCommand,
  RoomRole,
  RoomVerb,
  SessionFrame,
  VersionStamp,
} from '../protocol/index.ts';

type Subscriber = {
  clientId: string;
  send: (frame: SessionFrame) => void;
  // How much of the command log this connection has already been given. The log is the room's and it
  // only grows when a command lands, so most frames do not carry it and the ones that do carry it once.
  sentCommands: number;
};

// A seat is a place in the room, and it is the unit of identity in v1. The role lives here rather
// than on the connection, which is the whole reason a dropped stream and a reload are the same
// event: both of them hand the same token back, and the role comes back with it.
type Seat = {
  token: string;
  role: RoomRole;
  // The connection holding the seat right now, or null when nobody does. A seat outlives the
  // connection on purpose — a seat nobody is holding is still the seat the same player gets back by
  // presenting its token, and a seat that was destroyed on disconnect would turn every reconnect into
  // a new guest.
  heldBy: string | null;
};

const TICK_MILLISECONDS = 1000 / TICK_RATE;

export type Admission =
  | { accepted: true; clientId: string; seatToken: string; seatRole: RoomRole }
  | { accepted: false; refusal: HandshakeRefused };

export class SessionRoom {
  public readonly id: string;
  public readonly versions: VersionStamp;

  private readonly config: MatchConfig;
  private simulation: Simulation;
  // Seats by token, and the index that finds a connection's seat in one step. Both are written in
  // `bindSeat` and cleared in `detach` and nowhere else, so "which connection is in the room" and
  // "which seat is taken" cannot drift apart.
  private readonly seats = new Map<string, Seat>();
  private readonly seatOfClient = new Map<string, string>();
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly commands: RoomCommand[] = [];
  private tallies: EventTally = emptyEventTally();
  private seq = 0;
  private commandId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  public constructor(id: string, config: MatchConfig = createTrainingScenario()) {
    this.id = id;
    this.config = config;
    this.simulation = createSimulation(config);
    this.versions = {
      protocolVersion: PROTOCOL_VERSION,
      contentVersion: CONTENT_VERSION,
      mapVersion: MAP_VERSION,
      seed: config.seed,
    };
  }

  public get tickRate(): number {
    return TICK_RATE;
  }

  public get playerCount(): number {
    return this.subscribers.size;
  }

  public get status(): string {
    return this.simulation.getSnapshot().status;
  }

  public get tick(): number {
    return this.simulation.getSnapshot().tick;
  }

  public get commandCount(): number {
    return this.commands.length;
  }

  public get mapId(): string {
    return this.config.map.id;
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  // The one place a client is let in, and the one place its declared versions and its seat are read.
  // The room owns the numbers, so the comparison belongs to the room: a client that is refused has
  // been refused by the match it asked for, not by a guess made on the way to it. Nothing else in the
  // codebase compares a version, which is what keeps the rule from growing a second copy.
  public admit(declared: unknown, nextClientId: string): Admission {
    const refusal = checkHandshake(declared, this.versions);
    if (refusal !== null) {
      return { accepted: false, refusal };
    }
    const claim = (declared as { seatToken?: unknown }).seatToken;
    const seat = this.bindSeat(typeof claim === 'string' ? claim : null, nextClientId);
    return { accepted: true, clientId: nextClientId, seatToken: seat.token, seatRole: seat.role };
  }

  // The stream is opened with the whole room, not with a fresh match. A client that arrives late
  // therefore starts on the tick everyone else is on, with the gold, the pads and the running event
  // totals it missed — the alternative would be a second match that only looked like this one. The
  // same frame is what a client that reconnects gets, and it is deliberately the only one: a room
  // keeps no history of frames for a client to catch up on, because a second path of state is a
  // second implementation of the match.
  public attach(clientId: string, send: (frame: SessionFrame) => void): boolean {
    if (this.seatOfClient.has(clientId) === false || this.subscribers.has(clientId)) {
      return false;
    }
    const subscriber: Subscriber = { clientId, send, sentCommands: 0 };
    this.subscribers.set(clientId, subscriber);
    this.startTicking();
    this.broadcast('state', [], subscriber);
    return true;
  }

  public detach(clientId: string): void {
    const token = this.seatOfClient.get(clientId);
    this.seatOfClient.delete(clientId);
    if (token !== undefined) {
      const seat = this.seats.get(token);
      // The seat is freed, not destroyed: the token still means the same place, and the role it
      // carries is what a reconnect is coming back for.
      if (seat !== undefined && seat.heldBy === clientId) {
        seat.heldBy = null;
      }
    }
    if (!this.subscribers.delete(clientId)) {
      return;
    }
    if (this.subscribers.size === 0) {
      this.stopTicking();
    }
  }

  public has(clientId: string): boolean {
    return this.seatOfClient.has(clientId);
  }

  // A room that is going away stops holding a timer open: an interval nobody asked for is the one way a
  // process refuses to exit, and a session server that cannot be stopped is a session server that gets
  // left running after the run is over.
  public shutdown(): void {
    this.stopTicking();
    this.subscribers.clear();
    this.seatOfClient.clear();
    this.seats.clear();
  }

  // The one path a command takes. The core answers, the room repeats that answer verbatim, and the log
  // records both the tick the command was sent on and the tick the core was standing on — which are the
  // same number here and are still reported separately, because "the same number" is a fact about this
  // room rather than a law about rooms.
  public dispatch(clientId: string, command: Command): CommandAnswer | null {
    if (!this.subscribers.has(clientId)) {
      return null;
    }
    this.commandId += 1;
    const before = this.simulation.getSnapshot();
    const result = this.simulation.dispatch(command);
    const after = this.simulation.getSnapshot();
    if (result.accepted) {
      this.commands.push({ tick: before.tick, appliedTick: after.tick, command });
    }
    const drained = this.drain();
    for (const event of drained) {
      this.tallies[event.type] += 1;
    }
    // The frame goes out before the answer does, so a client that hears "accepted" has already been
    // given the state that acceptance produced. Anything else would leave a visible gap between the
    // sentence and the pad it is talking about.
    this.broadcast('tick', drained);
    return {
      commandId: this.commandId,
      accepted: result.accepted,
      reason: result.reason,
      tick: after.tick,
      seq: this.seq,
    };
  }

  // The two room verbs, behind one door so neither of them can grow a second path. Both are the room's
  // own lifecycle rather than anything the core decides, and both are the owner's alone: restarting
  // throws away a match everybody is playing, and closing throws away the room itself.
  //
  // A refused verb returns an answer and changes nothing at all — no tick, no log, no seat. That is the
  // whole of a permission in v1, and it is checkable from outside: the match is still there afterwards.
  public lifecycle(clientId: string, verb: RoomVerb): LifecycleAnswer | null {
    const seat = this.seatFor(clientId);
    if (seat === null) {
      return null;
    }
    const ownerOnly: Record<RoomVerb, string> = {
      restartRun: 'owner-only-restart',
      endRoom: 'owner-only-end-room',
    };
    if (seat.role !== 'owner') {
      return {
        verb,
        accepted: false,
        reason: ownerOnly[verb],
        role: seat.role,
        tick: this.tick,
        seq: this.seq,
        players: this.playerCount,
      };
    }
    if (verb === 'restartRun') {
      this.restartRun();
    } else {
      this.close();
    }
    return {
      verb,
      accepted: true,
      role: seat.role,
      tick: this.tick,
      seq: this.seq,
      players: this.playerCount,
    };
  }

  // A new core from the same config, an empty log and zeroed totals, told to everyone as a whole state
  // frame. Every client therefore lands on the same preparation of tick 0 with the same empty pads,
  // which is the only way two windows are in the same match again. The seats are untouched: a run is
  // not a room, and an owner who restarts the run does not stop being its owner.
  private restartRun(): void {
    this.simulation = createSimulation(this.config);
    this.commands.length = 0;
    this.tallies = emptyEventTally();
    this.broadcast('state', []);
  }

  // The end of a room, said once to everyone who is in it. The name is the transport's to give back —
  // it owns the map of names — so this only closes the room and refuses it further clients; the route
  // that carries `endRoom` is what removes the name. The answer to the owner is still produced, because
  // the client that asked deserves a sentence as much as the clients that did not.
  private close(): void {
    this.closed = true;
    this.announceClosure({ reason: 'room-closed', by: 'owner', found: null });
    this.stopTicking();
    this.subscribers.clear();
    this.seatOfClient.clear();
    this.seats.clear();
  }

  private seatFor(clientId: string): Seat | null {
    const token = this.seatOfClient.get(clientId);
    return token === undefined ? null : (this.seats.get(token) ?? null);
  }

  // Seat binding is one function so the two ways of getting a seat cannot disagree. A token the room
  // issued is handed back as the same seat, role and all; a token it has never issued becomes a new
  // seat under that same token, which is not a hole: the role is never read out of a token, so a
  // guessed one buys nothing a client would not already have by arriving first. Refusing unknown
  // tokens instead would be a trap — the room it belonged to may simply have been recreated — and a
  // dead end is worse than a name the room did not recognise.
  private bindSeat(claim: string | null, clientId: string): Seat {
    const token = claim !== null && isSeatToken(claim) ? claim : this.issueToken();
    const existing = this.seats.get(token);
    // The first seat of a room is the seat that opened it, and it is the only one that can restart or
    // close the room. Everyone after it is a guest, and there is no third role.
    const seat = existing ?? { token, role: this.seats.size === 0 ? 'owner' : 'guest', heldBy: null };
    this.seats.set(token, seat);
    const previous = seat.heldBy;
    seat.heldBy = clientId;
    this.seatOfClient.set(clientId, token);
    if (previous !== null && previous !== clientId) {
      // The last connection to present a seat holds it. The one that loses it is told so on the stream
      // it is already reading and is no longer a client of the room: without accounts there is no
      // telling a guest apart from somebody reconnecting, so a second live connection on one seat is
      // resolved by taking it away from the earlier one rather than by pretending both may sit.
      this.seatOfClient.delete(previous);
      this.refuseSeat(previous, clientId);
    }
    return seat;
  }

  // 22 hex characters, because that is exactly what the protocol module's token pattern reads and
  // the room must not mint something its own contract would refuse.
  private issueToken(): string {
    return randomBytes(16).toString('hex').slice(0, 22);
  }

  private refuseSeat(clientId: string, takenBy: string): void {
    const subscriber = this.subscribers.get(clientId);
    if (subscriber !== undefined) {
      // Told first, dropped second. The notice travels on the stream the loser is still reading, so it
      // has to be sent before the subscriber leaves the set the notice is broadcast from — and dropping
      // it afterwards is what takes the place out of the room rather than only out of the seat.
      this.announceClosure({ reason: 'seat-taken', by: null, found: takenBy }, subscriber);
    }
    this.subscribers.delete(clientId);
    if (this.subscribers.size === 0) {
      this.stopTicking();
    }
  }

  private startTicking(): void {
    if (this.timer !== null || this.closed) {
      return;
    }
    this.timer = setInterval(() => this.tickOnce(), TICK_MILLISECONDS);
  }

  private stopTicking(): void {
    if (this.timer === null) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  private tickOnce(): void {
    if (this.subscribers.size === 0) {
      this.stopTicking();
      return;
    }
    this.simulation.step();
    const drained = this.drain();
    for (const event of drained) {
      this.tallies[event.type] += 1;
    }
    this.broadcast('tick', drained);
    // A finished match has nothing left to step and nothing left to say, so the room goes quiet instead
    // of spending twenty frames a second repeating a result. Anyone who joins afterwards is still given
    // the final state in full.
    const status = this.simulation.getSnapshot().status;
    if (status === 'victory' || status === 'defeat') {
      this.stopTicking();
    }
  }

  private drain(): SimulationEvent[] {
    return this.simulation.drainEvents();
  }

  private broadcast(kind: SessionFrame['kind'], events: SimulationEvent[], only?: Subscriber): void {
    this.seq += 1;
    const snapshot = this.simulation.getSnapshot();
    const sentAt = Date.now();
    for (const subscriber of this.subscribers.values()) {
      if (only !== undefined && subscriber !== only) {
        continue;
      }
      const frame: SessionFrame = {
        kind,
        seq: this.seq,
        sentAt,
        tickRate: TICK_RATE,
        players: this.subscribers.size,
        snapshot,
        eventCounts: { ...this.tallies },
        events,
        commandCount: this.commands.length,
      };
      // The frame that opens a connection always carries the versions: that connection has no other way
      // of learning what the room runs, and a room that has taken no command yet sends no log.
      if (kind === 'state') {
        frame.versions = { ...this.versions };
      }
      if (subscriber.sentCommands !== this.commands.length) {
        frame.commands = this.commands.map((entry) => ({ ...entry }));
        frame.versions = { ...this.versions };
        subscriber.sentCommands = this.commands.length;
      }
      subscriber.send(frame);
    }
  }

  // The last frame a connection is given. It carries the whole room as it stands, so a client that has
  // just been removed still has something true on screen, and it takes a sequence number of its own so
  // that a frame only one client ever saw cannot be mistaken for a frame two clients share.
  private announceClosure(closure: RoomClosure, only?: Subscriber): void {
    this.seq += 1;
    const snapshot = this.simulation.getSnapshot();
    const sentAt = Date.now();
    for (const subscriber of this.subscribers.values()) {
      if (only !== undefined && subscriber !== only) {
        continue;
      }
      subscriber.send({
        kind: 'closed',
        seq: this.seq,
        sentAt,
        tickRate: TICK_RATE,
        players: this.subscribers.size,
        snapshot,
        eventCounts: { ...this.tallies },
        events: [],
        commandCount: this.commands.length,
        versions: { ...this.versions },
        closure,
      });
    }
  }
}
