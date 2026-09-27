// The versioned boundary between a client and a session. Three sides build against it — the room on
// the server, the browser client and the E2E suite — and none of them gets to invent a field the
// others do not check, so the shape, the versions and the refusal codes live here rather than being
// written down on each side separately.
//
// There is no DOM, no Three.js and no Node API in this module, because the room and the browser have
// to agree on it at build time. It imports types from the pure core and nothing else: the wire
// carries `MatchSnapshot`, `Command` and `SimulationEvent` as they are, unwrapped and unrenamed.

import type { Command, MatchSnapshot, SimulationEvent } from '../game-core/index.ts';

// Bumped when the meaning of anything on the wire changes. A client that speaks a different dialect
// is refused here rather than allowed to guess, because two clients of one room that disagree about
// what a frame means is exactly the silent rule-split this phase exists to prevent.
export const PROTOCOL_VERSION = 1;

// The content the room runs and the client renders. It is declared here and nowhere else, so the save
// slot, the room handshake and this contract cannot drift apart on a number nobody compares.
export const CONTENT_VERSION = 1;

// The map is versioned apart from the content it is packed in, because a map is the thing a client
// projects: two builds can share every tower and enemy and still lay the pads out differently.
export const MAP_VERSION = 1;

// Where a room lives when nobody says otherwise. The server takes this as its default port and the
// client as its default origin, so the two halves of the same local session cannot disagree about the
// address and fail to meet. Both sides accept an override. It is deliberately clear of the 5173/5174
// pair Vite uses, because a dev server that drifts onto the port a second server wants turns a wiring
// mistake into a session that cannot be reached.
export const DEFAULT_SESSION_PORT = 5180;

// What a client says it is. It is not a seat: it names the kind of client, and the room refuses
// anything it does not admit. Who may close the room is the room's answer, not the client's claim.
export const SESSION_ROLES = ['player'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

// Who a seat is inside a room. `owner` is the seat the room issued to the client whose handshake
// created it, and every seat after that is a `guest`. The role belongs to the seat and not to the
// connection holding it, so presenting the seat token again brings the role back with it — which is
// what makes reconnect the same player rather than a new one.
//
// There is no `spectator` and no kick. Without accounts a guest cannot be told apart from somebody
// who is reconnecting, so "remove this player" is not a thing the room can honestly do; closing the
// room is, and the room says that in words rather than pretending.
export const ROOM_ROLES = ['owner', 'guest'] as const;
export type RoomRole = (typeof ROOM_ROLES)[number];

// A seat token is the whole of identity in v1, and it means exactly one thing: "this is the same
// seat". It is not an account, it is not a name, and it carries no rights — what a seat may do is
// decided by the room when it issues the token. The shape lives here so the room that mints one and
// the client that offers one cannot grow two opinions about what a token looks like; the client never
// checks it before offering one, because deciding whether a token counts is the room's job.
export const SEAT_TOKEN_PATTERN = /^[a-z0-9]{22}$/;

export const isSeatToken = (value: unknown): value is string =>
  typeof value === 'string' && SEAT_TOKEN_PATTERN.test(value);

export type VersionStamp = {
  protocolVersion: number;
  contentVersion: number;
  mapVersion: number;
  seed: number;
};

export type HandshakeRequest = VersionStamp & {
  role: SessionRole;
  // The seat this client is claiming. Absent when it holds none, and the room then issues one.
  // Present when the client is coming back — by reload or by a dropped stream — and the room binds
  // the same seat, and the same role, to the connection that presents it.
  seatToken?: string;
};

export type HandshakeAccepted = {
  accepted: true;
  roomId: string;
  clientId: string;
  // The seat this connection now holds and what it may do with it. Issued on the first handshake and
  // handed back unchanged on every handshake that presents it, so a client never has to remember
  // which room a token belongs to in order to find out whether it still has a place.
  seatToken: string;
  seatRole: RoomRole;
  tickRate: number;
  versions: VersionStamp;
};

export type HandshakeRefusalReason =
  | 'handshake-shape'
  | 'role-not-permitted'
  | 'seat-shape'
  | 'protocol-version-mismatch'
  | 'content-version-mismatch'
  | 'map-version-mismatch'
  | 'seed-mismatch';

export type HandshakeRefused = {
  accepted: false;
  reason: HandshakeRefusalReason;
  // The value that arrived, spelled out. A refusal that only names what it wanted leaves the other
  // side guessing, and a mismatch between two versions is a question, not a verdict.
  found: string;
  versions: VersionStamp;
};

export type HandshakeAnswer = HandshakeAccepted | HandshakeRefused;

// One entry of the room's command log. The issued tick and the applied tick are both the room's
// answer rather than the client's guess: a command the room took on a different tick than the one it
// was sent on would be a fact only the room knows, so only the room reports it.
export type RoomCommand = {
  tick: number;
  appliedTick: number;
  command: Command;
};

export type EventTally = Record<SimulationEvent['type'], number>;

// Why a connection stopped having a place in a room, said on the stream it was already reading. It is
// a notice about the connection, not a fact about the match, so it rides the same frame rather than
// opening a second channel: one stream, one shape, and a client that lost its seat is owed a name and
// not only a verdict.
export type RoomClosure = {
  // `room-closed` — the owner closed the room. Its name is free again and the match it held is gone.
  // `seat-taken` — a later connection presented this connection's seat token, so the seat is that
  // connection's now and this one has no place in the room until it takes a new one.
  reason: 'room-closed' | 'seat-taken';
  // Who ended it, when the room knows: the owner seat is the only one that can close a room. Null for
  // `seat-taken`, where nothing was closed and the party that took the seat is named by `found`.
  by: RoomRole | null;
  // The client id that took the seat, for `seat-taken`.
  found: string | null;
};

// The one stream shape. A `state` frame opens a connection and carries the whole room; a `tick` frame
// carries what the tick changed; a `closed` frame is the last one a connection is given, and says why
// it will not be given another. All three carry the snapshot, the running event totals and the length
// of the command log, so a client is never in a position where it has to guess what it is looking at.
// `commands` rides along only on the frame where the log changed for that connection, and `versions`
// only on the frame that opens it.
export type SessionFrame = {
  kind: 'state' | 'tick' | 'closed';
  seq: number;
  sentAt: number;
  tickRate: number;
  players: number;
  snapshot: MatchSnapshot;
  eventCounts: EventTally;
  events: SimulationEvent[];
  commandCount: number;
  commands?: RoomCommand[];
  versions?: VersionStamp;
  closure?: RoomClosure;
};

export type CommandRequest = {
  clientId: string;
  command: Command;
};

export type CommandAnswer = {
  commandId: number;
  accepted: boolean;
  // The room's reason, and only the room's reason. A client that guessed at it would be a second
  // implementation of the rules, which is the one thing this phase must not produce.
  reason?: string;
  tick: number;
  seq: number;
};

// The two acts that belong to the room rather than to the match. `placeTower` and `startWave` are core
// commands and any seat may send them: the economy and the board belong to the room, and splitting
// either would be a second rule book (`0019`). These two are the room's own lifecycle, and only the
// owner seat may ask for them.
export const ROOM_VERBS = ['restartRun', 'endRoom'] as const;
export type RoomVerb = (typeof ROOM_VERBS)[number];

export const isRoomVerb = (value: unknown): value is RoomVerb =>
  typeof value === 'string' && (ROOM_VERBS as readonly string[]).includes(value);

export type LifecycleRequest = {
  clientId: string;
  verb: RoomVerb;
};

export type LifecycleAnswer = {
  verb: RoomVerb;
  accepted: boolean;
  // The room's reason, in the same vocabulary as a command refusal and for the same reason: the client
  // shows it and decides nothing about it.
  reason?: string;
  // The role the room decided for this seat, so a refusal can be read as a role problem rather than
  // as a mystery. A client that is told "guest" can see exactly which door is not its own.
  role: RoomRole;
  tick: number;
  seq: number;
  // How many clients the room holds after the answer, so a refused client can see that nothing moved
  // and a closing one can see the room empty itself.
  players: number;
};

export const emptyEventTally = (): EventTally => ({
  towerPlaced: 0,
  preparationEnded: 0,
  waveStarted: 0,
  enemySpawned: 0,
  towerFired: 0,
  enemyKilled: 0,
  coreDamaged: 0,
  waveCleared: 0,
  victory: 0,
  defeat: 0,
});

export const EVENT_TYPES = Object.keys(emptyEventTally()) as Array<SimulationEvent['type']>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const isTick = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0;

// The command shapes of the current contract, and nothing else: the room hands only these to the core,
// and the save slot may only claim a command this build knows how to hand over. Whether the core would
// accept it is not decided here — that is the core's answer, and both callers record it as it comes.
export const isKnownCommand = (value: unknown): value is Command => {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'startWave') {
    return true;
  }
  return (
    value.type === 'placeTower' &&
    typeof value.padId === 'string' &&
    typeof value.towerId === 'string'
  );
};

export const isSessionRole = (value: unknown): value is SessionRole =>
  typeof value === 'string' && (SESSION_ROLES as readonly string[]).includes(value);

export const isRoomRole = (value: unknown): value is RoomRole =>
  typeof value === 'string' && (ROOM_ROLES as readonly string[]).includes(value);

const isRoomClosure = (value: unknown): value is RoomClosure =>
  isRecord(value) &&
  (value.reason === 'room-closed' || value.reason === 'seat-taken') &&
  (value.by === null || isRoomRole(value.by)) &&
  (value.found === null || typeof value.found === 'string');

export const isEventTally = (value: unknown): value is EventTally => {
  if (!isRecord(value)) {
    return false;
  }
  return EVENT_TYPES.every((type) => isCount(value[type]));
};

export const isVersionStamp = (value: unknown): value is VersionStamp => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isCount(value.protocolVersion) &&
    isCount(value.contentVersion) &&
    isCount(value.mapVersion) &&
    isCount(value.seed)
  );
};

const isRoomCommand = (value: unknown): value is RoomCommand =>
  isRecord(value) && isTick(value.tick) && isTick(value.appliedTick) && isKnownCommand(value.command);

const isMatchSnapshot = (value: unknown): value is MatchSnapshot => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    isTick(value.tick) &&
    typeof value.status === 'string' &&
    isCount(value.gold) &&
    isCount(value.coreHealth) &&
    isCount(value.maxCoreHealth) &&
    isCount(value.waveIndex) &&
    isCount(value.waveTick) &&
    isCount(value.preparationTicksLeft) &&
    isRecord(value.pads) &&
    Array.isArray(value.towers) &&
    Array.isArray(value.enemies)
  );
};

// Everything a client is about to apply is checked here, once, before it reaches the projection. The
// stream is a trust boundary like any other input: a frame the client cannot read is refused rather
// than merged into the match it is presenting.
export const readSessionFrame = (value: unknown): SessionFrame | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind !== 'state' && value.kind !== 'tick' && value.kind !== 'closed') {
    return null;
  }
  if (!isTick(value.seq) || !isCount(value.sentAt) || !isCount(value.tickRate) || value.tickRate <= 0) {
    return null;
  }
  if (!Number.isInteger(value.players) || (value.players as number) < 0) {
    return null;
  }
  if (!isMatchSnapshot(value.snapshot) || !isEventTally(value.eventCounts)) {
    return null;
  }
  if (!Array.isArray(value.events) || !isTick(value.commandCount)) {
    return null;
  }
  if (value.commands !== undefined && (!Array.isArray(value.commands) || !value.commands.every(isRoomCommand))) {
    return null;
  }
  if (value.versions !== undefined && !isVersionStamp(value.versions)) {
    return null;
  }
  // A notice that says the connection is over has to be on the frame that says so, and a frame that
  // is still about the match has no business carrying one: a closure read off a live frame would put
  // a client into a room it has just been removed from.
  if (value.kind === 'closed' ? !isRoomClosure(value.closure) : value.closure !== undefined) {
    return null;
  }
  return value as unknown as SessionFrame;
};

// The single place a version mismatch is decided. The room owns the numbers; the client owns the
// request; nothing else in the codebase compares a version, so there is nowhere for the rule to grow
// a second copy. Every refusal names the value that arrived.
export const checkHandshake = (declared: unknown, room: VersionStamp): HandshakeRefused | null => {
  const refuse = (reason: HandshakeRefusalReason, found: string): HandshakeRefused => ({
    accepted: false,
    reason,
    found,
    versions: room,
  });
  if (!isRecord(declared)) {
    return refuse('handshake-shape', typeof declared);
  }
  if (!isSessionRole(declared.role)) {
    return refuse('role-not-permitted', String(declared.role));
  }
  // A seat token is either absent or a token this protocol knows how to read. The client offers what
  // it has and does not filter it, because a token that is not the room's to accept is the room's
  // sentence to give — and the name of what arrived is what lets the client stop offering it again.
  if (declared.seatToken !== undefined && declared.seatToken !== null && !isSeatToken(declared.seatToken)) {
    return refuse('seat-shape', String(declared.seatToken));
  }
  if (!isCount(declared.protocolVersion) || !isCount(declared.contentVersion)) {
    return refuse('handshake-shape', 'versions are not numbers');
  }
  if (!isCount(declared.mapVersion) || !isCount(declared.seed)) {
    return refuse('handshake-shape', 'map version or seed is not a number');
  }
  if (declared.protocolVersion !== room.protocolVersion) {
    return refuse(
      'protocol-version-mismatch',
      `protocol v${declared.protocolVersion} against room v${room.protocolVersion}`,
    );
  }
  if (declared.contentVersion !== room.contentVersion) {
    return refuse(
      'content-version-mismatch',
      `content v${declared.contentVersion} against room v${room.contentVersion}`,
    );
  }
  if (declared.mapVersion !== room.mapVersion) {
    return refuse(
      'map-version-mismatch',
      `map v${declared.mapVersion} against room v${room.mapVersion}`,
    );
  }
  if (declared.seed !== room.seed) {
    return refuse('seed-mismatch', `seed ${declared.seed} against room ${room.seed}`);
  }
  return null;
};

export const readCommandRequest = (value: unknown): CommandRequest | null => {
  if (!isRecord(value) || typeof value.clientId !== 'string' || value.clientId.length === 0) {
    return null;
  }
  return isKnownCommand(value.command) ? { clientId: value.clientId, command: value.command } : null;
};

// The lifecycle body is read with the same discipline as a command body: a verb this build does not
// know is refused by name rather than ignored, because a verb the room did not recognise would
// otherwise be a room verb that silently does nothing.
export const readLifecycleRequest = (value: unknown): LifecycleRequest | null => {
  if (!isRecord(value) || typeof value.clientId !== 'string' || value.clientId.length === 0) {
    return null;
  }
  return isRoomVerb(value.verb) ? { clientId: value.clientId, verb: value.verb } : null;
};

// A room name arrives out of a URL, so both sides read it with the same rule instead of each having an
// opinion about what a room may be called. It is also the name the client puts in its own link, which
// is why a name that could not be typed is a name that could not be joined.
export const isRoomName = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,23}$/.test(value);

export const readHandshakeAnswer = (value: unknown): HandshakeAnswer | null => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean' || !isVersionStamp(value.versions)) {
    return null;
  }
  if (value.accepted) {
    // The seat is not optional in an accepted handshake. A client that cannot name the seat it holds
    // cannot come back to it, and a client that comes back to nothing is a guest in someone else's
    // room — so the answer without a seat is an answer this build does not read.
    if (
      typeof value.roomId !== 'string' ||
      typeof value.clientId !== 'string' ||
      !isSeatToken(value.seatToken) ||
      !isRoomRole(value.seatRole) ||
      !isCount(value.tickRate)
    ) {
      return null;
    }
    return value as unknown as HandshakeAccepted;
  }
  if (typeof value.reason !== 'string' || typeof value.found !== 'string') {
    return null;
  }
  return value as unknown as HandshakeRefused;
};

export const readCommandAnswer = (value: unknown): CommandAnswer | null => {
  if (!isRecord(value) || typeof value.accepted !== 'boolean' || !isTick(value.tick) || !isTick(value.seq)) {
    return null;
  }
  if (value.commandId !== undefined && !isTick(value.commandId)) {
    return null;
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return null;
  }
  return value as unknown as CommandAnswer;
};

export const readLifecycleAnswer = (value: unknown): LifecycleAnswer | null => {
  if (
    !isRecord(value) ||
    !isRoomVerb(value.verb) ||
    typeof value.accepted !== 'boolean' ||
    !isRoomRole(value.role) ||
    !isTick(value.tick) ||
    !isTick(value.seq) ||
    !Number.isInteger(value.players) ||
    (value.players as number) < 0
  ) {
    return null;
  }
  if (value.reason !== undefined && typeof value.reason !== 'string') {
    return null;
  }
  return value as unknown as LifecycleAnswer;
};

// The refusal sentences a client can show. They live next to the codes on purpose: a reason that only
// exists in one place is a reason the other side cannot name, and an unnamed refusal is a refusal the
// player has to guess about.
export const SESSION_REFUSAL_TEXT: Record<string, string> = {
  'handshake-shape': 'The session request was not a handshake this build reads',
  'role-not-permitted': 'This room does not admit that role',
  'seat-shape': 'The seat token was not one this room can read',
  'protocol-version-mismatch': 'The room speaks a different protocol version',
  'content-version-mismatch': 'The room runs different content',
  'map-version-mismatch': 'The room runs a different map version',
  'seed-mismatch': 'The room runs a different seed',
  'unknown-room': 'That room does not exist',
  'unknown-client': 'This client is not in the room',
  'command-shape': 'The room did not read that as a command',
  'command-unreadable': 'The room did not answer that command',
  'verb-shape': 'The room did not read that as one of its own acts',
  // Two rooms verbs, two sentences: a guest is told which door is not its own rather than being told
  // "rejected", because a control that is off with a reason on it is the difference between a rule
  // and a bug.
  'owner-only-restart': 'Only the room owner restarts the run',
  'owner-only-end-room': 'Only the room owner closes the room',
  'room-closed': 'The room owner closed this room',
  'seat-taken': 'A later connection took this seat',
  'seat-not-persisted': 'This browser refused to keep the room seat',
  'request-too-large': 'The command was larger than the room accepts',
  'stream-refused': 'The room refused the update stream',
  'session-unreachable': 'The session server could not be reached',
  'session-not-live': 'There is no room to send this command to',
  'session-frame-unreadable': 'The room sent an update this build cannot read',
};
