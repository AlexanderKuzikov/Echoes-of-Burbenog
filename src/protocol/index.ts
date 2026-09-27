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

// One role today. The handshake still names it, because the check is where a second role goes in
// `0018` and a check that only appears with the second role is a check nobody has ever run.
export const SESSION_ROLES = ['player'] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export type VersionStamp = {
  protocolVersion: number;
  contentVersion: number;
  mapVersion: number;
  seed: number;
};

export type HandshakeRequest = VersionStamp & {
  role: SessionRole;
};

export type HandshakeAccepted = {
  accepted: true;
  roomId: string;
  clientId: string;
  tickRate: number;
  versions: VersionStamp;
};

export type HandshakeRefusalReason =
  | 'handshake-shape'
  | 'role-not-permitted'
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

// The one stream shape. A `state` frame opens a connection and carries the whole room; a `tick` frame
// carries what the tick changed. Both carry the snapshot, the running event totals and the length of
// the command log, so a client is never in a position where it has to guess what it is looking at.
// `commands` rides along only on the frame where the log changed for that connection, and `versions`
// only on the frame that opens it.
export type SessionFrame = {
  kind: 'state' | 'tick';
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
  if (value.kind !== 'state' && value.kind !== 'tick') {
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
    if (typeof value.roomId !== 'string' || typeof value.clientId !== 'string' || !isCount(value.tickRate)) {
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

// The refusal sentences a client can show. They live next to the codes on purpose: a reason that only
// exists in one place is a reason the other side cannot name, and an unnamed refusal is a refusal the
// player has to guess about.
export const SESSION_REFUSAL_TEXT: Record<string, string> = {
  'handshake-shape': 'The session request was not a handshake this build reads',
  'role-not-permitted': 'This room does not admit that role',
  'protocol-version-mismatch': 'The room speaks a different protocol version',
  'content-version-mismatch': 'The room runs different content',
  'map-version-mismatch': 'The room runs a different map version',
  'seed-mismatch': 'The room runs a different seed',
  'unknown-room': 'That room does not exist',
  'unknown-client': 'This client is not in the room',
  'command-shape': 'The room did not read that as a command',
  'command-unreadable': 'The room did not answer that command',
  'request-too-large': 'The command was larger than the room accepts',
  'stream-refused': 'The room refused the update stream',
  'session-unreachable': 'The session server could not be reached',
  'session-not-live': 'There is no room to send this command to',
  'session-frame-unreadable': 'The room sent an update this build cannot read',
};
