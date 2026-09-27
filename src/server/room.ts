// A room is one match and the one owner of the `Simulation` behind it. Nothing in this file decides
// anything about a match: it steps the core, counts what the core produced and hands the result to
// whoever is connected. A rule that is not the core's does not exist here, because a second rule book
// next to the core is exactly what the whole phase forbids.

import { TICK_RATE, createSimulation, createTrainingScenario } from '../game-core/index.ts';
import type { Command, MatchConfig, Simulation, SimulationEvent } from '../game-core/index.ts';
import {
  CONTENT_VERSION,
  MAP_VERSION,
  PROTOCOL_VERSION,
  checkHandshake,
  emptyEventTally,
} from '../protocol/index.ts';
import type { CommandAnswer, EventTally, HandshakeRefused, RoomCommand, SessionFrame, VersionStamp } from '../protocol/index.ts';

type Subscriber = {
  clientId: string;
  send: (frame: SessionFrame) => void;
  // How much of the command log this connection has already been given. The log is the room's and it
  // only grows when a command lands, so most frames do not carry it and the ones that do carry it once.
  sentCommands: number;
};

const TICK_MILLISECONDS = 1000 / TICK_RATE;

export type Admission =
  | { accepted: true; clientId: string }
  | { accepted: false; refusal: HandshakeRefused };

export class SessionRoom {
  public readonly id: string;
  public readonly versions: VersionStamp;

  private readonly config: MatchConfig;
  private readonly simulation: Simulation;
  // A client that passed the handshake but has not opened its stream yet. It is admitted, not attached:
  // it may look, and it may not act, because a client that has not been shown the room has nothing to
  // act on. Both sets empty out together when the connection ends, so a stale name cannot linger.
  private readonly admitted = new Set<string>();
  private readonly subscribers = new Map<string, Subscriber>();
  private readonly commands: RoomCommand[] = [];
  private readonly tallies: EventTally = emptyEventTally();
  private seq = 0;
  private commandId = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

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

  // The one place a client is let in, and the one place its declared versions are read. The room owns
  // the numbers, so the comparison belongs to the room: a client that is refused has been refused by
  // the match it asked for, not by a guess made on the way to it. Nothing else in the codebase
  // compares a version, which is what keeps the rule from growing a second copy.
  public admit(declared: unknown, nextClientId: string): Admission {
    const refusal = checkHandshake(declared, this.versions);
    if (refusal !== null) {
      return { accepted: false, refusal };
    }
    this.admitted.add(nextClientId);
    return { accepted: true, clientId: nextClientId };
  }

  // The stream is opened with the whole room, not with a fresh match. A client that arrives late
  // therefore starts on the tick everyone else is on, with the gold, the pads and the running event
  // totals it missed — the alternative would be a second match that only looked like this one.
  public attach(clientId: string, send: (frame: SessionFrame) => void): boolean {
    if (!this.admitted.has(clientId) || this.subscribers.has(clientId)) {
      return false;
    }
    const subscriber: Subscriber = { clientId, send, sentCommands: 0 };
    this.subscribers.set(clientId, subscriber);
    this.startTicking();
    this.broadcast('state', [], subscriber);
    return true;
  }

  public detach(clientId: string): void {
    this.admitted.delete(clientId);
    if (!this.subscribers.delete(clientId)) {
      return;
    }
    if (this.subscribers.size === 0) {
      this.stopTicking();
    }
  }

  public has(clientId: string): boolean {
    return this.admitted.has(clientId);
  }

  // A room that is going away stops holding a timer open: an interval nobody asked for is the one way a
  // process refuses to exit, and a session server that cannot be stopped is a session server that gets
  // left running after the run is over.
  public shutdown(): void {
    this.stopTicking();
    this.subscribers.clear();
    this.admitted.clear();
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

  private startTicking(): void {
    if (this.timer !== null) {
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
}
