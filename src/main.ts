import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  MAP_FILE_REFUSAL_CLASSES,
  TICK_RATE,
  TOWER_FOOTPRINT_CELLS,
  cellForSpotId,
  checkSpot,
  createSimulation,
  createTrainingScenario,
  spotCenter,
  spotIdForCell,
  trainingGrid,
  trainingPlan,
} from './game-core/index.ts';
import type { CellKind, Command, CommandResult, MapCell, MatchSnapshot, MatchStatus, SimulationEvent } from './game-core/index.ts';
import { createMap, createMinimap } from './client/map.ts';
import { readSkin, splitRules } from './client/skin.ts';
import type { SkinDefinition } from './client/skin.ts';
import { createProps } from './client/props.ts';
import type { PropModel, PropsReadings } from './client/props.ts';
import type { TerrainReadings } from './client/terrain.ts';
import { createTowers } from './client/towers.ts';
import type { LoadedModel, TowerClipReading, TowerModelReading } from './client/towers.ts';
import { createEnemies } from './client/enemies.ts';
import type { EnemyModelReading } from './client/enemies.ts';
import { createCombatFx } from './client/combat-fx.ts';
import { PROBE_WEIGHTS, isProbeMaterial, setEnvironmentTexture, withProbeWeight } from './client/shared.ts';
import type { ProbeMaterialReading, ProbeRole } from './client/shared.ts';
import {
  CONTENT_VERSION,
  DEFAULT_SESSION_PORT,
  MAP_VERSION,
  PROTOCOL_VERSION,
  SESSION_REFUSAL_TEXT,
  EVENT_TYPES,
  isKnownCommand,
  isRoomName,
  readCommandAnswer,
  readHandshakeAnswer,
  readLifecycleAnswer,
  readSessionFrame,
} from './protocol/index.ts';
import type {
  EventTally,
  HandshakeRequest,
  RoomClosure,
  RoomCommand,
  RoomRole,
  RoomVerb,
  SessionFrame,
  VersionStamp,
} from './protocol/index.ts';
import { ASSET_MANIFEST_URL, AssetContractError, TERRAIN_ID_PREFIX, createAssetRegistry, instancedEntries, isTerrainRecord, parseAssetManifest, resolveModelUrl, terrainEntries } from './asset-registry.ts';
import type {
  AssetChecks,
  AssetRegistry,
  AssetStatus,
  ManifestRecord,
  ModelCheck,
  ModelFootprintReading,
  ModelManifestEntry,
  TerrainModelEntry,
} from './asset-registry.ts';
import {
  MODEL_BUDGET,
  REGISTRY_BUDGET,
  SCENE_BUDGET,
  TERRAIN_MODEL_BUDGET,
  WORLD_FOOTPRINT_BUDGET,
  checkClipTargets,
  checkModelContract,
  checkNodeTypes,
  checkRegistryBudgets,
  checkSceneBudget,
  checkWorldFootprint,
  describeFailures,
  gltfPathForTrack,
  sumRegistry,
} from './asset-budgets.ts';
import type { AssetFailure, ClipTargetReading, NodeReading, SceneReading } from './asset-budgets.ts';
// Two files, both committed and both imported at build time rather than fetched: the owner's map, and
// the skin that was written for it. The map is the same module `game-core` reads, so the rows the
// fingerprint is taken over are the rows the grid was read from and not a second copy of them.
import mapFile from '../content/maps/burrow-01.json' with { type: 'json' };
import skinFile from '../content/skins/forest.json' with { type: 'json' };
import './styles.css';

type RenderCounters = {
  pads: number;
  towers: number;
  enemies: number;
  routeSegments: number;
};

/**
 * What the game read out of the skin file, and what it did about it.
 *
 * The two halves are the point. `cellSize` and `reliefAsWritten` are the file's own numbers; `relief`
 * is what the ground is painted at. They are published side by side because the conversion between
 * them is the one place in this work where a unit crossed a boundary, and a seam that only carried the
 * answer would make the arithmetic unfalsifiable.
 */
type SkinReading = {
  version: number;
  name: string;
  cellSize: number;
  fingerprint: string;
  plateWidth: number;
  plateHeight: number;
  relief: { blockedLift: number; roadSink: number; roadFlatten: number };
  reliefAsWritten: { blockedLift: number; roadSink: number };
  heights: Record<CellKind, number>;
  palette: Record<CellKind, readonly [string, string]>;
  openRules: string[];
  occupiedRulesLeftOut: string[];
  tiles: number;
  fog: { near: number; far: number; color: string };
  sun: { dir: readonly [number, number, number]; intensity: number; color: string };
  exposure: number;
  waterDrawn: false;
};

type CommandLogEntry = {
  tick: number;
  // The tick the core was actually on when this entry reached it. In the run that recorded it
  // that is the tick it was issued on, so a replay that applies it anywhere else is visible here
  // per command instead of only as a different terminal tick at the end of the match.
  appliedTick: number | null;
  command: Command;
};

type ClockMark = {
  label: string;
  tick: number;
  waveTick: number;
  at: number;
  accumulator: number;
  paused: boolean;
};

type MatchReport = {
  status: MatchStatus;
  tick: number;
  gold: number;
  coreHealth: number;
  leaksThisWave: number;
  eventCounts: Record<SimulationEvent['type'], number>;
};

// A rebuilt run, read inside the page on the tick the rebuild stopped on. A loaded match is live
// again the moment it has been rebuilt, so the state it arrived at cannot be read from outside the
// page without landing on a later tick — the same reason a terminal report is captured in
// `applySnapshot` rather than polled by a test.
type RebuildReading = {
  // The tick the slot asked for and the tick the rebuild reached. They are the same number, or the
  // claim "the same match" is not met.
  requestedTick: number;
  tick: number;
  snapshot: MatchSnapshot;
  eventCounts: Record<SimulationEvent['type'], number>;
  commandCount: number;
  replayIndex: number;
  replaying: boolean;
  matchReports: MatchReport[];
  poses: Array<{ entityId: number; towerId: string; clip: TowerClipReading | null }>;
};

// A rebuild with no tick to stop on — Restart in solo, New match — is the same reading without the
// asked-for tick, because there is no slot behind it that asked for anything. It exists because a fresh
// preparation is running again before anything outside the page can ask about it, and its arrival is
// only readable where it happened: `EOB-021` closed the same hole for a load.
type FreshRunReading = Omit<RebuildReading, 'requestedTick'>;

// Which of the two things Continue acts on the entry screen, and what the entry is offering right
// now. `live` is the entry MENU opened over a match the player is in the middle of; the rest are
// states of the slot. `confirm` is not a state of the slot but of the button: the first New match
// press arms it, and only the second one erases anything.
type EntryMode = 'empty' | 'slot' | 'unreadable' | 'live' | 'confirm' | 'room';

// Where this page stands with respect to a match. `local` is the product: the page owns the core.
// Everything else is a room, and in a room the page owns nothing except the picture it draws.
type SessionState = 'local' | 'idle' | 'connecting' | 'live' | 'offline' | 'refused';

type SessionReading = {
  mode: 'solo' | 'remote';
  state: SessionState;
  roomId: string | null;
  clientId: string | null;
  tickRate: number;
  players: number;
  seq: number;
  frames: number;
  commandCount: number;
  versions: VersionStamp | null;
  refusal: { reason: string; text: string; found: string | null } | null;
  lastCommand: { commandId: number; accepted: boolean; reason: string | null; tick: number } | null;
  // The seat this connection holds and what it may do with it. The token is published because a test
  // has to be able to hand the same seat to a second context, and a token read off this page buys
  // nothing a second reader of the page did not already have: it is only ever the room that decides
  // whether a token counts.
  seatToken: string | null;
  seatRole: RoomRole | null;
  // Why this connection stopped having a place in the room: the owner closed it, or a later
  // connection took the seat. Null while the connection still has one.
  closure: RoomClosure | null;
  // The cost of getting here, measured inside the page: the handshake exchange, and the delay of the
  // frame that opened the stream after it. `reconnects` counts the handshakes that presented a seat,
  // which is how a test tells a reconnect from a first entry without watching the transport.
  connect: {
    handshakes: number;
    reconnects: number;
    handshakeMs: number | null;
    firstFrameMs: number | null;
  };
  lastVerb: { verb: RoomVerb; accepted: boolean; reason: string | null; tick: number; role: RoomRole } | null;
  deliveryMs: number | null;
};

// One frame as this client applied it. The log is bounded and kept because two clients of one room can
// only be compared at a sequence number both of them saw: a reading of "where I am now" races the tick
// that is already on its way.
type FrameLogEntry = {
  seq: number;
  kind: SessionFrame['kind'];
  tick: number;
  gold: number;
  status: MatchStatus;
  players: number;
  commandCount: number;
  eventCounts: EventTally;
  pads: Record<string, string | null>;
  // The page's own clock when the frame was applied, and the one-way delay the frame carried from the
  // room's clock. Two numbers, both taken inside the page, so a delivery time measured from them holds
  // no round-trip between the test process and the browser.
  at: number;
  deliveryMs: number;
};

type MapGeometryReading = {
  /**
   * Half the width of the carriageway in world units, and half the side of the core's cell. Both are
   * half a cell now, and they are half a cell for the same reason: a road cell is one unit wide and the
   * core stands in one cell. They stay in the seam under their old names because the seam is a
   * contract that scenarios read, and a name is cheaper to keep than a set of scenarios to rewrite.
   */
  roadHalfWidth: number;
  chamberRadius: number;
  routeLength: number;
  routeSegments: number;
  bends: number;
  bays: number;
  wallBlocks: number;
  openCells: number;
  coreEndsRoute: boolean;
  /**
   * The three cell counts, counted from both ends: what the file holds and what the scene painted.
   * Equal numbers in the two are the proof that the picture is the file, and they are published
   * separately so the check is a comparison a reader can make rather than a promise.
   */
  cells: {
    grid: { free: number; road: number; occupied: number };
    painted: { free: number; road: number; occupied: number };
  };
  /** The cell the core stands on, in the owner's cell coordinates, and its world position. */
  coreCell: { x: number; y: number };
  /**
   * Every route, with its length in cells and in units and whether it ends on the core cell. A route
   * that does not end at the core is a route that walks past it, and this is where that shows up.
   */
  routes: Array<{
    routeId: string;
    cells: number;
    points: number;
    lengthInCells: number;
    lengthInUnits: number;
    endsAtCoreCell: boolean;
  }>;
  // The frustum the corridor was fitted into, in world units, plus the stand it was fitted from. A
  // map that is silently cropped by a hardcoded view height is a map the player cannot see, and the
  // numbers are how that gets said out loud instead of by eye.
  frame: { left: number; right: number; top: number; bottom: number; aspect: number };
  fit: { halfWidth: number; halfHeight: number; fitHalfHeight: number; canvasAspect: number };
  rig: { azimuth: number; elevation: number; zoom: number; targetX: number; targetZ: number };
  // The frustum as a lens: what half of the map it holds, the two ends of the range, and how many
  // pixels a world unit is at each of them. On the forty-unit map the creature was 13.8 pixels and
  // no framing of it could make it twenty-five; on this one the player drives there, and these are
  // the numbers that say so.
  view: {
    halfHeight: number;
    minView: number;
    maxView: number;
    pixelsPerUnit: number;
    minPixelsPerUnit: number;
    maxPixelsPerUnit: number;
  };
  // Whether the minimap is on the page, how many pixels one world unit is on it, and what it is
  // currently showing of the wave. A minimap that drew from its own copy of the match would be the
  // one surface on the page that could be a frame behind, so the counts come from the snapshot.
  minimap: { present: boolean; unit: number; enemies: number; towers: number };
  // What a click on each pad would do from where the camera stands right now, and what stands in the
  // way when it would not. Honest picking means some angles can hide a niche, and the point of
  // measuring it is that the answer is a number instead of a shrug.
  /**
   * How a click resolves, sampled at the spots worth checking rather than at all two thousand.
   *
   * It used to be one entry per pad, and that was affordable at a dozen and is not at 2 192: a real
   * read would project and ray-test every place on the plate several times a second. So this names what
   * it sampled and how, and `spotProbe` below answers for any single spot on demand — the seam keeps a
   * way to ask about a specific cell without the page paying for the whole board every frame.
   */
  picks: Array<{ padId: string; pickable: boolean; blocker: string | null; onScreen: boolean }>;
  /** Which spots `picks` holds, so a reader knows the sample is a sample and not the board. */
  picksSampled: number;
  picksTotal: number;
/**
 * The cell a click at a given canvas position resolves to, and the square that would hold it.
 *
 * A click is a claim about where the cursor is, and the property that has to survive 100%, 125% and
 * 150% system scale is exactly that claim — so it is askable at any point without dispatching a command
 * and without changing the board. The seam asks it; a real click sets the same answer in `lastPick`.
 */
  cellAtCanvas: (canvasX: number, canvasY: number) => {
    cell: { x: number; y: number } | null;
    /** What the map file says is at that cell: `free`, `road`, `occupied` or null off the plate. */
    kind: CellKind | null;
    spotId: string | null;
    anchor: { x: number; y: number } | null;
  };
  /** A sample of spots with both coverage readings, so a reader sees the shape of the board cheaply. */
  pads: Array<{
    padId: string;
    x: number;
    z: number;
    roadDistance: number;
    clearOfRoad: boolean;
    /** Road cells the spot covers per tower — the whole plate's road, the number that reads largest. */
    coverage: Record<string, number>;
    /** Route cells the spot covers per tower — the cells creatures actually walk. */
    routeCoverage: Record<string, number>;
  }>;
  /**
   * The whole board's placement currency in one reading, so the numbers do not have to be sampled to be
   * believed: how many spots exist, how many reach any road, and the worst and best coverage per tower.
   * Computed once when the map is read rather than per frame — it is a property of the plate.
   */
  spotSurvey: {
    total: number;
    /** How many anchors have all sixteen cells free, which is the number that matters for the board. */
    buildable: number;
    perTower: Array<{
      towerId: string;
      range: number;
      spotsCoveringAnyRoad: number;
      spotsCoveringAnyRoute: number;
      worstRoad: number;
      bestRoad: number;
      worstRoute: number;
      bestRoute: number;
      /** best/worst over the spots that cover something, so the ratio is of real places and not of zero. */
      spread: number;
    }>;
    /** Every spot name reads back as its own cell, over the whole set — the round-trip, counted. */
    namesRoundTrip: number;
  };
  /** One spot, asked for by name, for a caller that wants a fact about a specific cell. */
  spotProbe: (padId: string) => {
    padId: string;
    cell: { x: number; y: number } | null;
    buildable: boolean;
    coverage: Record<string, number>;
    routeCoverage: Record<string, number>;
    roadDistance: number;
  } | null;
  /**
   * Which map file this page is running, and the three classes of mistake it could have been refused
   * for. The seam only exists on a page that loaded, so "loaded" is true by construction here and the
   * refusals themselves are read from the refusal block on a page that did not.
   */
  map: { id: string; name: string; version: number; loaded: true; refusalClasses: readonly string[] };
};

type DebugState = {
  ready: boolean;
  renderer: string;
  camera: string;
  seed: number;
  tickRate: number;
  mapId: string;
  routeIds: string[];
  padIds: string[];
  waveCount: number;
  eventsDrained: number;
  snapshot: MatchSnapshot;
  dispatch: (command: Command) => CommandResult | null;
  readonly selectedTowerId: string;
  readonly feedback: { state: FeedbackState; message: string; reason: string | null };
  /**
   * The last click resolved to a cell, by number, with the square that held it. A click is a claim about
   * where the cursor is, and the property that has to hold at 100%, 125% and 150% system scale is that
   * claim — so it is readable on its own, without building a tower to see it.
   */
  readonly lastPick: {
    screen: { x: number; y: number };
    cell: { x: number; y: number } | null;
    spotId: string | null;
    anchor: { x: number; y: number } | null;
  } | null;
  readonly objectCount: number;
  readonly rendered: RenderCounters;
  readonly towerPositions: Array<{ x: number; z: number }>;
  readonly enemyPositions: Array<{ x: number; z: number }>;
  readonly padScreenPositions: Array<{ padId: string; x: number; y: number }>;
  // The corridor as a measurement, not as a claim: road width, length and turn count, the niche and
  // chamber inventory, and per pad the distance to the road plus how much of the road each tower
  // range reaches. "A niche is off the road" and "niches differ" are then numbers a test can read.
  readonly mapGeometry: MapGeometryReading;
  /**
   * The skin as the game believes it: the exporter's cell size, the plate it was written for, and the
   * relief on both sides of the division. Published in full because the unit is the one number in this
   * work that could have gone either way, and a reader has to be able to check the arithmetic rather
   * than take it: `relief.blockedLift` is what the ground is painted at and `reliefAsWritten` is what
   * the file said, and the ratio between them is the whole decision.
   */
  readonly skin: SkinReading;
  /** What the ground is made of, and what stands on it: cells, faces, cover, and where each kind sits. */
  readonly terrain: TerrainReadings;
  /** The forty props, by slot, with the counts a scene walk would find. Null until the registry settles. */
  readonly props: PropsReadings | null;
  readonly eventCounts: Record<SimulationEvent['type'], number>;
  readonly recentEvents: SimulationEvent[];
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly replaying: boolean;
  readonly replayIndex: number;
  readonly commandCount: number;
  readonly matchReports: MatchReport[];
  // The run a rebuild arrived at, captured in the page on the tick it stopped on, and `null` until
  // a Load in this page session has finished one.
  readonly lastRebuild: RebuildReading | null;
  // The same reading for a rebuild with no tick to stop on — Restart in solo, New match — captured on
  // the tick the new core was built at rather than polled, because the clock that rebuild started is
  // already running by the time a round trip would have answered.
  readonly lastFreshRun: FreshRunReading | null;
  // The entry screen as the page sees it. `continuing` names the one thing the Continue button will
  // do, which is the difference between a restore and a resume and therefore the claim that the
  // entry did not grow a second implementation of Load.
  readonly entry: {
    open: boolean;
    mode: EntryMode;
    armed: boolean;
    continuing: 'slot' | 'match' | null;
  };
  // The frame clock, and the seam that puts a fat frame on purpose. `null` is the product's only
  // mode: measure the real frame. An armed value goes through the same clamp a real frame does, so
  // a test cannot ask for a frame the product would never produce.
  readonly frameDelta: number | null;
  forceFrameDelta: (seconds: number | null) => void;
  // The multiplier the player has the clock on, and the steps the control offers. The core's own
  // `tickRate` is above and is not affected by either: this is how many ticks a frame may spend, not
  // how long a tick is.
  readonly speed: number;
  readonly speedSteps: number[];
  // Every recorded command with the tick it was issued on and the tick it was applied on.
  readonly commandPlan: CommandLogEntry[];
  // Clock readings taken inside the page at the moment something happened there, so a test measures
  // the match clock instead of the round-trip between the test process and the page.
  readonly clockMarks: ClockMark[];
  markClock: (label: string) => void;
  // Who owns the match, and everything a test needs to say so without reading the transport: the room,
  // the connection, the versions both sides agreed on, the reason the room gave for a refusal, and the
  // bounded log of frames as this client applied them. In solo the answer is `local` and the log is
  // empty, because there is no stream to log.
  readonly session: SessionReading;
  readonly frameLog: FrameLogEntry[];
  // The versions this client declares in its handshake are armable, because a version mismatch has to
  // be reachable from a test without patching the build. It changes what the client says, never what
  // the room accepts: the refusal is still the room's answer to a wrong number.
  forceHandshake: (overrides: Partial<HandshakeRequest> | null) => void;
  // Drops the update stream the way a lost connection does — the same `closeSession` path, the same
  // `offline` state, the same entry coming back with the way in. It is a network event and not a code
  // change, so what the reconnect policy is tested against is the product's own error handling rather
  // than a patched one. It does nothing outside a room, because a solo page has no stream to drop.
  breakStream: () => void;
  // Frames this page has drawn. A page that is alive but not ticking is the whole claim behind "the
  // room owns the clock in remote mode", and it cannot be told apart from a frozen picture without it.
  readonly frames: number;
  readonly motion: {
    reducedMotion: boolean;
    combatBursts: number;
    shotTraces: number;
    shotsFired: number;
    enemyBob: number;
    clips: number;
    clipsPlaying: number;
  };
  readonly assets: { status: AssetStatus; models: string[]; error: string | null };
  // The environment probe sits on the scene at full strength, so what dims it is a property of
  // each material. The seam publishes every standard material of the live scene with the weight it
  // actually carries, so a material left on the silent default of 1 is visible without reading code.
  readonly probe: {
    environment: boolean;
    materials: ProbeMaterialReading[];
    undeclared: number;
  };
  // Budgets, what was measured, and which checks actually ran. `renderer.info` and the load
  // time are the only non-deterministic numbers here, so a test may only check that they land
  // inside the budget, never their exact value.
  readonly assetBudgets: {
    budgets: {
      model: typeof MODEL_BUDGET;
      registry: typeof REGISTRY_BUDGET;
      scene: typeof SCENE_BUDGET;
      worldFootprint: typeof WORLD_FOOTPRINT_BUDGET;
    };
    checks: AssetChecks;
    failures: string[];
  };
  readonly towerModels: TowerModelReading[];
  // The same reading for the creatures: what they are made of, how high they stand, and where the bar
  // sits against the body it measures. A creature is the one thing on this board a player reads at ten
  // pixels, so its numbers have to be readable without a screenshot.
  readonly enemyModels: EnemyModelReading[];
};

type FeedbackState = 'idle' | 'accepted' | 'rejected' | 'terminal';

type EventFeedEntry = {
  type: SimulationEvent['type'];
  text: string;
};

type BuildOption = {
  button: HTMLButtonElement;
  towerId: string;
  name: string;
};

declare global {
  interface Window {
    __ECHOES_DEBUG__?: DebugState;
  }
}

const sceneMount = document.querySelector<HTMLDivElement>('#scene');
const minimapCanvas = document.querySelector<HTMLCanvasElement>('[data-testid="minimap-canvas"]');
const statusLabel = document.querySelector<HTMLSpanElement>('[data-testid="scene-status"]');
const selectionStatus = document.querySelector<HTMLElement>('[data-testid="selection-status"]');
const commandFeedback = document.querySelector<HTMLElement>('[data-testid="command-feedback"]');
const selectionCardName = document.querySelector<HTMLElement>('[data-testid="selection-card-name"]');
const selectionCardDetail = document.querySelector<HTMLElement>('[data-testid="selection-card-detail"]');
const goldValue = document.querySelector<HTMLElement>('[data-testid="gold-value"]');
const integrityValue = document.querySelector<HTMLElement>('[data-testid="core-integrity"]');
const waveValue = document.querySelector<HTMLElement>('[data-testid="wave-status"]');
const viewportShell = document.querySelector<HTMLElement>('[data-testid="viewport"]');
const matchPhase = document.querySelector<HTMLElement>('[data-testid="match-phase"]');
const phaseTimer = document.querySelector<HTMLElement>('[data-testid="phase-timer"]');
const enemyCount = document.querySelector<HTMLElement>('[data-testid="enemy-count"]');
const objectiveDetail = document.querySelector<HTMLElement>('[data-testid="objective-detail"]');
const eventFeed = document.querySelector<HTMLUListElement>('[data-testid="event-feed"]');
const resultBanner = document.querySelector<HTMLElement>('[data-testid="match-result"]');
const stateBadge = document.querySelector<HTMLElement>('[data-testid="state-badge"]');
const startWaveButton = document.querySelector<HTMLButtonElement>('[data-testid="start-wave"]');
const pauseToggle = document.querySelector<HTMLButtonElement>('[data-testid="pause-toggle"]');
const restartButton = document.querySelector<HTMLButtonElement>('[data-testid="restart-match"]');
const endRoomButton = document.querySelector<HTMLButtonElement>('[data-testid="end-room"]');
const sceneReport = document.querySelector<HTMLElement>('[data-testid="scene-report"]');
const sceneReportReason = document.querySelector<HTMLElement>('[data-testid="scene-report-reason"]');
const saveSlotLabel = document.querySelector<HTMLElement>('[data-testid="save-slot"]');
const saveFeedback = document.querySelector<HTMLElement>('[data-testid="save-feedback"]');
const saveButton = document.querySelector<HTMLButtonElement>('[data-testid="save-match"]');
const loadButton = document.querySelector<HTMLButtonElement>('[data-testid="load-match"]');
const newMatchButton = document.querySelector<HTMLButtonElement>('[data-testid="new-match"]');
const menuButton = document.querySelector<HTMLButtonElement>('[data-testid="menu-button"]');
const gameShell = document.querySelector<HTMLElement>('.game-shell');
const entryScreen = document.querySelector<HTMLElement>('[data-testid="entry-screen"]');
const entrySlot = document.querySelector<HTMLElement>('[data-testid="entry-slot"]');
const entryHint = document.querySelector<HTMLElement>('[data-testid="entry-hint"]');
const entryFeedback = document.querySelector<HTMLElement>('[data-testid="entry-feedback"]');
const entryContinueButton = document.querySelector<HTMLButtonElement>('[data-testid="entry-continue"]');
const entryNewMatchButton = document.querySelector<HTMLButtonElement>('[data-testid="entry-new-match"]');
const sessionStrip = document.querySelector<HTMLElement>('[data-testid="session-strip"]');
const sessionName = document.querySelector<HTMLElement>('[data-testid="session-name"]');
const sessionDetail = document.querySelector<HTMLElement>('[data-testid="session-detail"]');
const entryRoom = document.querySelector<HTMLElement>('[data-testid="entry-room"]');
const entryRoomLine = document.querySelector<HTMLElement>('[data-testid="entry-room-line"]');
const entryRoomInput = document.querySelector<HTMLInputElement>('[data-testid="entry-room-input"]');
const entryJoinRoom = document.querySelector<HTMLButtonElement>('[data-testid="entry-join-room"]');

if (
  !sceneMount ||
  !statusLabel ||
  !selectionStatus ||
  !commandFeedback ||
  !selectionCardName ||
  !selectionCardDetail ||
  !goldValue ||
  !integrityValue ||
  !waveValue ||
  !viewportShell ||
  !matchPhase ||
  !phaseTimer ||
  !enemyCount ||
  !objectiveDetail ||
  !eventFeed ||
  !resultBanner ||
  !stateBadge ||
  !startWaveButton ||
  !pauseToggle ||
  !restartButton ||
  !endRoomButton ||
  !sceneReport ||
  !sceneReportReason ||
  !saveSlotLabel ||
  !saveFeedback ||
  !saveButton ||
  !loadButton ||
  !newMatchButton ||
  !menuButton ||
  !gameShell ||
  !entryScreen ||
  !entrySlot ||
  !entryHint ||
  !entryFeedback ||
  !entryContinueButton ||
  !entryNewMatchButton ||
  !sessionStrip ||
  !sessionName ||
  !sessionDetail ||
  !entryRoom ||
  !entryRoomLine ||
  !entryRoomInput ||
  !entryJoinRoom
) {
  throw new Error('Bootstrap DOM is incomplete');
}

// Diagnostics are a developer surface, not a HUD control, so the flag is a query parameter and the
// element is created only when it is asked for. Without the flag there is nothing in the DOM to
// hide, which is what makes "no diagnostics in the screenshot" true by construction instead of by
// a stylesheet rule that a screenshot can outvote.
const devFlag = new URLSearchParams(window.location.search).get('dev');
const devDiagnosticsOn = devFlag !== null && devFlag !== '0' && devFlag !== 'false';

type DevDiagnostics = {
  rows: Record<string, HTMLElement>;
};

// One row per reading, each with a stable `data-diag` key, so a test compares the block against the
// seam instead of against a formatted string nobody can parse.
const createDevDiagnostics = (): DevDiagnostics => {
  const element = document.createElement('div');
  element.className = 'scene-diagnostics';
  element.dataset.testid = 'scene-diagnostics';
  const kicker = document.createElement('span');
  kicker.className = 'scene-diagnostics-kicker';
  kicker.textContent = 'Dev diagnostics · ?dev';
  element.append(kicker);
  const rows: Record<string, HTMLElement> = {};
  for (const key of ['scene', 'model', 'models', 'registry', 'checks']) {
    const row = document.createElement('p');
    row.dataset.diag = key;
    element.append(row);
    rows[key] = row;
  }
  // Into the dock, not onto the board. It is a `?dev` block, it is not the game, and the board it used
  // to sit on has no room left for it: with the rail beside the picture the status line can wrap to
  // three lines, and a block that cannot be placed without standing on something does not belong on
  // the board. The dock already carries readouts, and under `?dev` it is the only surface that is
  // allowed to grow.
  document.querySelector('.command-dock')?.append(element);
  return { rows };
};

const devDiagnostics = devDiagnosticsOn ? createDevDiagnostics() : null;

// A map file this build cannot read stops the page here, and it says so on the page before it stops.
//
// The field is not built yet when the refusal happens and nothing is drawn over it, so the refusal
// lands on the empty viewport the document already has: the board does not change, it simply never
// arrives, and the reason is the only thing on screen that is new. It goes into the block that already
// exists for refusals — the same block the asset registry writes to — because a full reason does not fit
// on the one-line status chip, and "map refused" on its own leaves a reader with nothing to act on. The
// throw after that keeps the rest of this module from running against a config that does not exist.
const config = (() => {
  try {
    return createTrainingScenario();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    sceneReport.hidden = false;
    // The block's kicker is static text in the document and it says "asset refusal", which would be a
    // lie here — nothing failed to load an artifact, the map itself was refused. The kicker is set
    // rather than the document rewritten, because the honest answer is one word on a surface that
    // already exists.
    const kicker = sceneReport.querySelector<HTMLElement>('.scene-report-kicker');
    if (kicker) {
      kicker.textContent = 'Map refusal';
    }
    sceneReportReason.dataset.reason = reason;
    sceneReportReason.textContent = reason;
    statusLabel.textContent = `Scene refused · ${reason}`;
    throw error;
  }
})();
const towerDefinitions = new Map(config.towers.map((tower) => [tower.id, tower]));
const enemyDefinitions = new Map(config.enemies.map((enemy) => [enemy.id, enemy]));
const waveCount = config.waves.length;
// The presentation clock, stated once and handed to every domain as a number: a second copy of it
// inside two modules is a class of defect this project has already paid for once.
const STEP_SECONDS = 1 / TICK_RATE;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reducedMotionQuery.matches;
let paused = false;
let replaying = false;
let replayIndex = 0;
let terminalReported = false;
const commandLog: CommandLogEntry[] = [];
const matchReports: MatchReport[] = [];
let simulation = createSimulation(config);
const padDefinitions = new Map(config.map.buildPads.map((pad) => [pad.id, pad]));
// The grid the map is made of, read once from the plan the config was built from. `spotCenter` and
// `checkSpot` both need it, and both are pure functions of it, so there is nothing here to keep in step:
// it is the same object the scene paints and the routes were walked over.
const grid = trainingGrid();

// The skin: one JSON file carrying the palettes, the three relief numbers, the sky and the forty prop
// slots. It is imported at build time the same way the map is, so it is a file in this repository and
// never a request, and it is read here — before the renderer exists — because a match cannot be drawn
// without it: the ground's colour and the plate's three heights both come out of this file.
//
// **A skin that does not match the plate stops the page rather than being drawn around.** The one
// refusal that matters is the fingerprint: a skin written for a different map carries palettes,
// counters and forty slots that all describe a different plate, and there is no honest way to put
// that on this one. A default would be a picture that is wrong in every cell at once and says nothing,
// which is the failure this project has already paid for twice — in the map's numbers and in a click
// that painted the wrong cell. `readSkin` checks that the fingerprint, the size and the cell size all
// agree before a single triangle exists, so this throw is unreachable while the two files in the
// repository agree with each other, and the console error below is what a reader would see if they
// ever stopped.
const skin: SkinDefinition = (() => {
  try {
    return readSkin(skinFile, { width: mapFile.width, height: mapFile.height, rows: mapFile.grid });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`skin refused: ${reason}`);
    throw error;
  }
})();

// The light the file describes, and the one place its numbers become the scene's. The sun direction is
// the only conversion here that is not an identity: the file states it as a direction, and a
// directional light wants one too, so the two agree without arithmetic.
const sky = skin.light.sky;
const sunDirection = new THREE.Vector3(sky.sunDir[0], sky.sunDir[1], sky.sunDir[2]).normalize();
const plateWidth = mapFile.width;

/**
 * The sky the file describes, as the one texture the scene shows behind the plate.
 *
 * A gradient from the top of the sky to the bottom of it, with the sun's halo drawn where `sunDir`
 * puts it. A canvas rather than a colour, because one colour cannot carry a gradient and a flat
 * backdrop behind a forest reads as a card rather than as air. `glow` is the halo's radius as a share
 * of the frame height, which is the field's whole job; the halo's colour is the sun colour, so
 * nothing here is invented.
 *
 * The sun's place is a mapping onto the backdrop, not a projection: the horizontal part of its
 * direction decides which side of the frame it sits on and the vertical part how high. The sky does
 * not turn with the camera, and projecting it properly would mean rebuilding the texture on every
 * frame of a turn to move something the player cannot tell apart from a gradient anyway.
 */
const skyTexture = (reading: typeof sky): THREE.Texture => {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (context === null) {
    return new THREE.Texture();
  }
  const gradient = context.createLinearGradient(0, 0, 0, size);
  gradient.addColorStop(0, reading.top);
  gradient.addColorStop(1, reading.bottom);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  const horizontal = Math.hypot(reading.sunDir[0], reading.sunDir[2]) || 1;
  const sunX = (0.5 + (reading.sunDir[0] / horizontal) * 0.5) * size;
  const sunY = (1 - Math.max(0, Math.min(1, reading.sunDir[1]))) * size * 0.5;
  const radius = Math.max(8, reading.glow * size);
  const halo = context.createRadialGradient(sunX, sunY, 0, sunX, sunY, radius);
  halo.addColorStop(0, reading.sun);
  halo.addColorStop(0.45, `${reading.sun}80`);
  halo.addColorStop(1, `${reading.sun}00`);
  context.fillStyle = halo;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(sceneMount.clientWidth || 1, sceneMount.clientHeight || 1, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// The exposure the skin states, replacing the 1.12 this file used to carry as a literal. It is a
// multiplier on the tone curve and nothing else, so it is read rather than re-derived.
renderer.toneMappingExposure = sky.exposure;
renderer.domElement.dataset.testid = 'scene-canvas';
renderer.domElement.setAttribute('aria-label', '3D tactical scene');
sceneMount.append(renderer.domElement);

const scene = new THREE.Scene();
// The sky the file describes. It replaces the single dark colour this scene used to carry, which was
// standing in for a sky nobody had written down.
scene.background = skyTexture(sky);
// The fog was 15..31, tuned while the map was twenty-two units across and the stand was fixed over
// the middle of it: everything in frame sat inside it, and it did its job. A ninety-six unit plate
// seen from the same stand puts the far corners seventy-eight units away, and at 15..31 the map was
// a lit strip about a quarter of the frame tall with the rest of the vault dissolved into the
// background — the wide lens, which is the whole point of the free camera, could not show the map at
// all. Thirty to a hundred and sixty-five keeps the depth cue where it was (the far corner carries
// about a third of it) and lets the plate be read edge to edge. The band itself is set further down,
// where the stand's reach is declared: it is a depth from the camera, and the camera moved.

// Image based lighting: metalness and roughness only read as metal under an environment, so
// the PBR materials of the generated models get a prefiltered room probe. There is no scene-wide
// share of it: a scene multiplier applies to every material in the frame, including materials added
// later, and leaves no record of why a surface looks the way it does. The share belongs to the
// material, next to the colour and roughness it modifies.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const roomEnvironment = new RoomEnvironment();
const environmentTarget = pmremGenerator.fromScene(roomEnvironment, 0.04);
scene.environment = environmentTarget.texture;
roomEnvironment.dispose();
pmremGenerator.dispose();

// The one prefiltered probe texture of the page, handed to the shared block that writes probe
// weights. A material that takes a share of the probe has to own this texture by name — `three`
// reads `envMapIntensity` only for a material that holds an `envMap` of its own — and the page is
// the only place it is made.
setEnvironmentTexture(environmentTarget.texture);

const cameraTarget = new THREE.Vector3(0, 0, 0);
const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100);
camera.position.set(9, 10, 9);
camera.lookAt(cameraTarget);

const hemisphereLight = new THREE.HemisphereLight(sky.hemiSky, sky.hemiGround, sky.hemiI);
scene.add(hemisphereLight);

const keyLight = new THREE.DirectionalLight(sky.sun, sky.sunI);
// The sun stands where the file says it stands: the direction is the light's own, and it is applied
// once per frame by `followKeyLight` so the light travels with the view instead of sliding across the
// plate as the player turns. The shadow frustum covers what is in frame rather than a fixed box —
// with sixteen hundred props in the picture a box that covers a fifth of the frame width puts a hard
// edge across the forest where the shadows stop, which is worse than the softer shadow the wider box
// costs. The map size is doubled to hold the resolution: covering the frame at 1024 would be about ten
// pixels to a unit, and a tree trunk at ten pixels is a smudge.
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.bias = -0.0006;
scene.add(keyLight);
scene.add(keyLight.target);

/** The sun's offset from the point it lights, at a length that puts it above the tallest tree. */
const KEY_LIGHT_REACH = 40;

const followKeyLight = (): void => {
  keyLight.target.position.set(cameraRig.targetX, 0, cameraRig.targetZ);
  keyLight.position.set(
    cameraRig.targetX + sunDirection.x * KEY_LIGHT_REACH,
    sunDirection.y * KEY_LIGHT_REACH,
    cameraRig.targetZ + sunDirection.z * KEY_LIGHT_REACH,
  );
  keyLight.target.updateMatrixWorld();
};

// The fill is a second directional light standing opposite the sun, at the file's own colour and
// strength. It exists for the shadow side: a hemisphere alone leaves everything the sun does not reach
// flat, and the trees are read mostly by the shape of that darkness.
const fillLight = new THREE.DirectionalLight(sky.fill, sky.fillI);
fillLight.position.set(-sunDirection.x, Math.abs(sunDirection.y) * 0.7, -sunDirection.z);
scene.add(fillLight);

/**
 * The shadow frustum, sized to the view.
 *
 * Declared here and written by `resize`, because the view is what the shadow has to cover: a fixed box
 * works while the camera looks at the middle of the map and stops working the moment the player zooms
 * out, which is when the whole plate is in frame and every tree in it wants to cast. One tenth on top
 * of the frame keeps a prop standing at the edge from losing its shadow to the boundary.
 */
const fitShadowToView = (halfWidth: number, halfHeight: number): void => {
  const reach = Math.max(halfWidth, halfHeight) * 1.1;
  const camera = keyLight.shadow.camera;
  if (camera.right !== reach) {
    camera.left = -reach;
    camera.right = reach;
    camera.top = reach;
    camera.bottom = -reach;
    camera.updateProjectionMatrix();
  }
};

/**
 * The ground a match is fought on: the free cells, the road and the occupied cells, all read from the
 * owner's map file and painted from the skin. There is no plate quad here any more and there was no
 * reason for one to survive — it covered the whole 96 by 96 with one colour, and now the file says
 * which of its cells are that colour and which are something else, so a single quad under the three
 * cell surfaces would be a fourth description of the same ground. The map owns the ground; this file
 * owns the light on it.
 */
const mapPresentation = createMap(scene, config, skin);

// The survey and the sample are declared here rather than beside the config because they read the map
// the scene just built — the spots and the coverage are properties of what was drawn, so asking before
// it exists would mean asking a different question.
const spotSurvey = (() => {
  const perTower = config.towers.map((tower) => {
    let coveringRoad = 0;
    let coveringRoute = 0;
    let worstRoad = Number.POSITIVE_INFINITY;
    let bestRoad = 0;
    let worstRoute = Number.POSITIVE_INFINITY;
    let bestRoute = 0;
    for (const cell of mapPresentation.spots) {
      const position = spotCenter(grid, cell);
      const road = mapPresentation.roadCoverage(position.x, position.z, tower.range);
      const route = mapPresentation.routeCoverage(position.x, position.z, tower.range);
      if (road > 0) {
        coveringRoad += 1;
        bestRoad = Math.max(bestRoad, road);
        worstRoad = Math.min(worstRoad, road);
      }
      if (route > 0) {
        coveringRoute += 1;
        bestRoute = Math.max(bestRoute, route);
        worstRoute = Math.min(worstRoute, route);
      }
    }
    // The spread is over the spots that cover something. A worst of zero would make the ratio infinite,
    // and that would be a statement about the plate having ground no tower can reach rather than about
    // placement mattering — so how much of the board is blind is named in its own two numbers instead.
    const spread = Number.isFinite(worstRoute) && worstRoute > 0
      ? Math.round((bestRoute / worstRoute) * 100) / 100
      : 0;
    return {
      towerId: tower.id,
      range: tower.range,
      spotsCoveringAnyRoad: coveringRoad,
      spotsCoveringAnyRoute: coveringRoute,
      worstRoad: Number.isFinite(worstRoad) ? worstRoad : 0,
      bestRoad,
      worstRoute: Number.isFinite(worstRoute) ? worstRoute : 0,
      bestRoute,
      spread,
    };
  });
  // The round-trip over the whole set rather than over the sample: every spot name has to read back as
  // its own cell, because a save stores that name, and a name that cannot be read back is a save that
  // replays onto ground the player never chose.
  let namesRoundTrip = 0;
  for (const cell of mapPresentation.spots) {
    const back = cellForSpotId(spotIdForCell(cell));
    if (back !== null && back.x === cell.x && back.y === cell.y) {
      namesRoundTrip += 1;
    }
  }
  return {
    total: mapPresentation.spots.length,
    buildable: mapPresentation.spots.length,
    perTower,
    namesRoundTrip,
  };
})();

// The spots the per-frame readings hold. A sample, and named as one: the whole board is 2 192 places
// and projecting each one several times a second is not a seam, it is a second renderer. So this takes
// the best and worst by route coverage per tower plus an even stride across the plate, which is enough
// to see the shape, and any specific cell is one real click or one `spotProbe` call away.
const spotSample: ReadonlyArray<MapCell> = (() => {
  const chosen = new Set<string>();
  for (const tower of config.towers) {
    const scored = mapPresentation.spots
      .map((cell) => {
        const position = spotCenter(grid, cell);
        return {
          key: `${cell.x},${cell.y}`,
          route: mapPresentation.routeCoverage(position.x, position.z, tower.range),
        };
      })
      .sort((left, right) => right.route - left.route || left.key.localeCompare(right.key));
    for (const entry of scored.slice(0, 6)) chosen.add(entry.key);
    for (const entry of scored.slice(-4)) chosen.add(entry.key);
  }
  for (let index = 0; index < mapPresentation.spots.length; index += 89) {
    const cell = mapPresentation.spots[index];
    if (cell) chosen.add(`${cell.x},${cell.y}`);
  }
  return [...chosen].map((key) => {
    const parts = key.split(',').map(Number);
    return { x: parts[0] as number, y: parts[1] as number };
  });
})();

// The minimap reads the road the board drew and the pads the core declared, and nothing else: a
// second description of the map in the page is a second one to fall out of step with the first.
const minimap = minimapCanvas
  ? createMinimap(minimapCanvas, config, mapPresentation.roadRects)
  : null;

// The tower views, the models they borrow from the registry, and the clip each one plays.
const modelStore = new Map<string, LoadedModel>();
const towers = createTowers(scene, modelStore, padDefinitions);
// The store is handed to both domains because both of them borrow the same artifacts, and the towers
// got it first; a creature that cannot be handed a model is a creature the registry loaded for nothing.
// The creatures and the ground they walk on, from one answer. The road is sunk by the skin and its
// height is read out of the same three numbers the ground was painted from, so a creature's feet and
// the road under it cannot come to be two heights that happen to agree.
const enemies = createEnemies(scene, modelStore, mapPresentation.surfaceHeights.road);
// Kill bursts and shot traces. A burst is born from an enemy event and a trace from a tower event,
// and both need the position of a view that belongs to somebody else, so they get their own module
// and are handed plain positions.
const combatFx = createCombatFx(scene, mapPresentation.surfaceHeights.road);

// The forty terrain models, keyed by the file the skin names rather than by the registry id, because
// that is the key the plate asks with: a slot says "this file, this kind, this many cells", and a map
// from id to file would be a second thing to keep in step with the skin.
const propStore = new Map<string, PropModel>();

// The props are mounted once, after the registry settles, because they need the files to be there.
// Until then the occupied cells stand as raised ground with nothing on them, which is a forest with
// no trees rather than a forest of something else — the point the set-without-props rule turns on.
let propsPresentation: ReturnType<typeof createProps> | null = null;
let propsReadings: PropsReadings | null = null;

/** Puts the forty props on the occupied cells, or states why they cannot go up. */
const mountProps = (): string[] => {
  propsPresentation = createProps(scene, grid, skin, propStore, mapPresentation.surfaceHeights.occupied);
  propsReadings = propsPresentation.readings;
  return propsReadings.refusals.map((entry) => `${entry.reason} (slot ${entry.slot}, ${entry.file})`);
};
// One presentation flag for the whole page, told to every domain the moment it changes, and set once
// here so a browser that already asked for reduced motion is obeyed before the first frame. The page
// reads it too: the guard, the ambient delta and the tower clip all have to agree.
enemies.setReducedMotion(reducedMotion);
towers.setReducedMotion(reducedMotion);

const buildButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-tower-id]'));
const buildOptions: BuildOption[] = buildButtons.map((button) => {
  const towerId = button.dataset.towerId ?? '';
  const definition = towerDefinitions.get(towerId);
  if (!definition) {
    throw new Error(`Build button references unknown tower ${towerId}`);
  }
  return { button, towerId, name: definition.name };
});
for (const tower of config.towers) {
  if (!buildOptions.some((option) => option.towerId === tower.id)) {
    throw new Error(`Tower ${tower.id} has no build button`);
  }
}

const assetRegistry: AssetRegistry = createAssetRegistry();
const gltfLoader = new GLTFLoader();

// Budget failures that are not attached to a single model. Model failures live on their own
// check, so the seam can report every reason without this list having to mirror them.
let registryBudgetFailures: AssetFailure[] = [];
let sceneBudgetFailures: AssetFailure[] = [];

// The path is what makes an unsupported node readable in the viewport: a type name on its own
// does not say which part of the model has to change.
const readNodeTypes = (root: THREE.Object3D): NodeReading[] => {
  const readings: NodeReading[] = [];
  const walk = (node: THREE.Object3D, path: string) => {
    readings.push({ type: node.type, path });
    for (const child of node.children) {
      walk(child, `${path}/${child.name || child.type}`);
    }
  };
  walk(root, root.name || root.type);
  return readings;
};

// `crypto.subtle` needs a secure context, so a bare http dev setup on the LAN legitimately has
// none. Reporting that as a fact is the whole point: a hash check that silently did not run
// would look exactly like a hash check that passed.
const hashArtifact = async (bytes: ArrayBuffer): Promise<{ hash: string | null; skippedReason: string | null }> => {
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (!subtle) {
    return { hash: null, skippedReason: 'crypto.subtle needs a secure context (https or localhost)' };
  }
  try {
    const digest = await subtle.digest('SHA-256', bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    return { hash: `sha256:${hex}`, skippedReason: null };
  } catch (error) {
    return { hash: null, skippedReason: `crypto.subtle.digest failed: ${error instanceof Error ? error.message : String(error)}` };
  }
};

type ModelReading = Omit<ModelCheck, 'modelId' | 'accepted' | 'failures'>;

// The one place a model is accepted. Every refusal is recorded first and then thrown, so the
// seam can name the model that was refused instead of reporting a registry that is simply broken.
const refuseModel = (entry: ManifestRecord, reading: ModelReading, reason: string): never => {
  assetRegistry.recordModelCheck({ modelId: entry.id, accepted: false, ...reading, failures: [reason] });
  throw new AssetContractError(reason);
};

// The generated model is the reason the probe exists, so its materials take all of it. Stating it
// here rather than leaning on the default of 1 is the whole point: a model material that arrives
// with a different weight has to be a decision on record, not an accident of the constructor.
const declareModelProbe = (root: THREE.Object3D) => {
  root.traverse((child) => {
    const material = (child as THREE.Mesh).material;
    if (!material) {
      return;
    }
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (isProbeMaterial(entry)) {
        entry.envMap = environmentTarget.texture;
        withProbeWeight(entry, 'model');
      }
    }
  });
};

// What the loaded tree says about its own skeleton, measured rather than declared: the joints the
// skin names, the influence count of the heaviest vertex, and the clips that came with the file.
// The budget lives in the shared module, so the same limits the build enforced apply here.
const readSkeleton = (scene: THREE.Object3D, clips: readonly THREE.AnimationClip[]) => {
  let bones = 0;
  let skins = 0;
  let weightSlots = 0;
  let boneInfluences = 0;
  scene.traverse((child) => {
    if (child instanceof THREE.Bone) {
      bones += 1;
    }
    if (!(child instanceof THREE.SkinnedMesh)) {
      return;
    }
    skins += 1;
    const indices = child.geometry.getAttribute('skinIndex');
    const weights = child.geometry.getAttribute('skinWeight');
    if (indices === undefined || weights === undefined) {
      return;
    }
    weightSlots = Math.max(weightSlots, weights.itemSize);
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      let influences = 0;
      for (let slot = 0; slot < weights.itemSize; slot += 1) {
        if (weights.getComponent(vertex, slot) > 0) {
          influences += 1;
        }
      }
      boneInfluences = Math.max(boneInfluences, influences);
    }
  });
  const targets: ClipTargetReading[] = clips.flatMap((clip) =>
    clip.tracks.map((track) => ({
      clip: clip.name,
      node: track.name.split('.')[0] ?? track.name,
      // A track names the property the mixer writes, so it has to be read as the glTF channel the
      // contract talks about before anything can be compared with the replayable list.
      path: gltfPathForTrack(track.name),
    })),
  );
  const clipSeconds = clips.reduce((longest, clip) => Math.max(longest, clip.duration), 0);
  return {
    targets,
    reading: {
      skins,
      bones,
      animationClips: clips.length,
      weightSlots,
      boneInfluences,
      clipSeconds,
      clipNames: clips.map((clip) => clip.name),
      clipTargets: targets,
    },
    measurement: { skins, bones, animationClips: clips.length, weightSlots, boneInfluences, clipSeconds },
  };
};

// The ground plane of a loaded model, measured on the tree that was actually parsed: the furthest a
// vertex reaches from the model's own origin, and the lowest point of its body. Both numbers come
// from the same walk the node types and the skeleton come from, because they are the same kind of
// fact — something the file says about itself, which the manifest does not have to repeat and cannot
// be trusted to.
//
// The radius is the file's, not the world's, and the seat multiplier turns it into one. The generator
// measures the same quantity on the arrays it writes, so the two measurements are in the same units
// and a file it never built is still compared against the same niche.
const readFootprint = (root: THREE.Object3D): { fileRadius: number; minY: number } => {
  let fileRadius = 0;
  let minY = Number.POSITIVE_INFINITY;
  // A node may carry its own transform, and a model is measured in the space it will be placed in, so
  // the vertex is read through the world matrix rather than in the mesh's own frame.
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const position = (child as THREE.Mesh).geometry?.getAttribute('position');
    if (position === undefined) {
      return;
    }
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      footprintVertex.set(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).applyMatrix4(child.matrixWorld);
      minY = Math.min(minY, footprintVertex.y);
      fileRadius = Math.max(fileRadius, Math.hypot(footprintVertex.x, footprintVertex.z));
    }
  });
  return { fileRadius: roundMeasure(fileRadius), minY: roundMeasure(Number.isFinite(minY) ? minY : 0) };
};

const footprintVertex = new THREE.Vector3();
const roundMeasure = (value: number): number => Number(value.toFixed(5));

/**
 * How many vertices `POSITION` and `COLOR_0` each carry, measured on the loaded tree.
 *
 * `colorVertices` is null when the model has no colour attribute at all, and that is a different
 * answer from zero: a model with no `COLOR_0` is a model whose material carries the colour, which is
 * a legitimate file, while a `COLOR_0` of a length other than `POSITION` is a file that will paint the
 * wrong vertices and pass every other gate on the way. So the absence is reported and the mismatch is
 * refused, and the two never collapse into one number.
 */
const readVertexAttributes = (scene: THREE.Object3D): { positionVertices: number; colorVertices: number | null } => {
  let positionVertices = 0;
  let colorVertices: number | null = null;
  scene.traverse((child) => {
    const geometry = (child as THREE.Mesh).geometry;
    if (geometry === undefined || geometry === null) {
      return;
    }
    const position = geometry.getAttribute('position');
    if (position === undefined) {
      return;
    }
    // One model can hold several meshes, and the question is per mesh rather than per file: a single
    // primitive whose colours are the wrong length is the defect, and summing first would let a second
    // mesh's length hide it.
    if (positionVertices !== position.count || colorVertices !== null) {
      positionVertices = position.count;
      colorVertices = geometry.getAttribute('color')?.count ?? null;
    }
  });
  return { positionVertices, colorVertices };
};

const loadModel = async (entry: ManifestRecord): Promise<LoadedModel | PropModel> => {
  const response = await fetch(resolveModelUrl(entry));
  if (!response.ok) {
    throw new AssetContractError(`model ${entry.id} responded ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const digest = await hashArtifact(buffer);
  // Which of the two record kinds this is, asked once. Everything below branches on it: the budget, the
  // lit node, and whether a seat exists at all.
  const terrain = isTerrainRecord(entry);
  const contentHash = {
    performed: digest.hash !== null,
    matches: digest.hash === entry.contentHash,
    skippedReason: digest.skippedReason,
  };
  const reading: ModelReading = {
    expectedBytes: entry.bytes,
    actualBytes: buffer.byteLength,
    triangles: entry.triangles,
    nodeTypes: [],
    skeleton: null,
    footprint: null,
    contentHash,
  };
  assetRegistry.markCheckPerformed('bytes');
  if (contentHash.performed) {
    assetRegistry.markCheckPerformed('contentHash');
  }
  if (reading.actualBytes !== entry.bytes) {
    return refuseModel(
      entry,
      reading,
      `model ${entry.id} arrived with ${reading.actualBytes} bytes but the manifest claims ${entry.bytes}`,
    );
  }
  if (contentHash.performed && !contentHash.matches) {
    return refuseModel(
      entry,
      reading,
      `model ${entry.id} content hash ${digest.hash} does not match the manifest claim ${entry.contentHash}`,
    );
  }
  const gltf = await gltfLoader.parseAsync(buffer, '');
  const nodes = readNodeTypes(gltf.scene);
  reading.nodeTypes = [...new Set(nodes.map((node) => node.type))].sort();
  assetRegistry.markCheckPerformed('nodeTypes');
  const skeleton = readSkeleton(gltf.scene, gltf.animations);
  reading.skeleton = skeleton.reading;
  // The world gate, and the only one that needs the seat a model is about to be put in. Both
  // presentation domains own a multiplier — a tower scales its seat, a creature stands in world units
  // — so the page asks both and takes the answer from whichever claims the id. A model nothing will
  // ever instantiate has no seat, and the gate stays out of it rather than inventing a number.
  const geometry = readFootprint(gltf.scene);
  const seatScale = terrain ? null : towers.seatScaleFor(entry.id) ?? enemies.seatScaleFor(entry.id);
  reading.footprint = {
    ...geometry,
    seatScale,
    worldRadius: seatScale === null ? null : roundMeasure(geometry.fileRadius * seatScale),
  };
  const failures = [
    // Two record kinds, two budgets, and the difference is not a detail: a tower is about to be
    // multiplied into a 2x2 seat and a tree is not multiplied at all, so the two numbers that only mean
    // something for a tower are absent from the terrain budget rather than set high enough to pass.
    ...checkModelContract(
      { id: entry.id, bytes: entry.bytes, triangles: entry.triangles, ...skeleton.measurement, ...readVertexAttributes(gltf.scene) },
      terrain ? TERRAIN_MODEL_BUDGET : MODEL_BUDGET,
    ),
    ...checkNodeTypes(entry.id, nodes),
    ...checkClipTargets(entry.id, skeleton.targets),
    ...(seatScale === null ? [] : checkWorldFootprint(entry.id, geometry.fileRadius, seatScale)),
  ];
  assetRegistry.markCheckPerformed('modelBudget');
  assetRegistry.markCheckPerformed('worldFootprint');
  if (failures.length > 0) {
    return refuseModel(entry, reading, describeFailures(failures));
  }
  // A terrain record has no lit node and is honest about it: a rock, a stump and a skull have nothing
  // to light. The tower contract still has to name one, because the client goes looking for it.
  const towerEntry = terrain ? null : (entry as ModelManifestEntry);
  if (towerEntry !== null && !gltf.scene.getObjectByName(towerEntry.emissiveNode)) {
    return refuseModel(entry, reading, `model ${entry.id} has no ${towerEntry.emissiveNode} node to animate`);
  }
  declareModelProbe(gltf.scene);
  assetRegistry.recordModelCheck({ modelId: entry.id, accepted: true, ...reading, failures: [] });
  // The footprint travels with the model: the reading is the measurement, and a view that has to put the
  // body at the height the manifest declares needs the same two numbers the gate just compared.
  // A terrain record is returned as the plainer shape it is — a file and a tree — because a prop is
  // placed by slot rather than swapped into a seat and has no lit node to name or a clip to play.
  return towerEntry === null
    ? { entry: entry as TerrainModelEntry, scene: gltf.scene }
    : {
        entry: towerEntry,
        scene: gltf.scene,
        emissiveNode: towerEntry.emissiveNode,
        clips: gltf.animations,
        footprint: reading.footprint as ModelFootprintReading,
      };
};

// The status line is a single line of viewport chrome, and two whole digests are exactly what
// pushed the sector caption out of the way. Only the display is shortened: `assets.error` and
// `assetBudgets.failures` keep the full reason, so an operator reading the seam still gets the
// exact value to compare.
const viewportRefusal = (reason: string): string => reason.replace(/(sha256:)([0-9a-f]{8})[0-9a-f]+/gi, '$1$2…');

// Two surfaces, one source. What a player reads is the state of the match, how many models came with
// it, what they are made of and whether the artifact was checked; every number this machine measured —
// scene budgets, renderer counters, load time, which checks ran — is developer information. A budget is
// measured on the build machine and is not a promise to a player on a slow connection, so printing it
// in the status line would be a false alarm dressed as a trustworthy status.
//
// The line counts and names the split instead of listing ten ids. `0013` promised one line, and ten
// names do not fit on one: the chip wrapped to two and walked left over the sector caption, which is
// the exact regression that promise was made to prevent. A count and a split say everything a player
// needs from this line — ten models arrived, three of them towers, seven creatures — and the names
// stay where detail belongs, in the `?dev` block.
const gameplayStatus = (): string => {
  const status = assetRegistry.status;
  if (status === 'ready') {
    // Which checks ran is part of the message, not a detail of the debug seam: without it a
    // skipped hash verification is indistinguishable from a passed one.
    const integrity = assetRegistry.checks.performed.contentHash
      ? 'integrity checked'
      : `content hash not checked (${assetRegistry.modelChecks.find((check) => check.contentHash.skippedReason)?.contentHash.skippedReason ?? 'no reason given'})`;
    const ids = assetRegistry.modelIds;
    // Three roles, asked of the same two seat lookups the world gate uses plus one list of our own: a
    // model with an enemy seat is a creature, a record that begins `land.` is a prop the plate places by
    // slot, and everything else is a tower. Inventing a third list here would be one more place to
    // forget a name in — and a line that said "43 towers" would be worse than no line.
    const props = ids.filter((id) => id.startsWith(TERRAIN_ID_PREFIX)).length;
    const seats = ids.filter((id) => !id.startsWith(TERRAIN_ID_PREFIX));
    const creatures = seats.filter((id) => enemies.seatScaleFor(id) !== null).length;
    return `Scene online · ${ids.length} models (${seats.length - creatures} towers · ${creatures} creatures · ${props} props) · ${integrity}`;
  }
  if (status === 'error') {
    return `Scene online · model registry failed: ${viewportRefusal(assetRegistry.error ?? 'unknown reason')}`;
  }
  return 'Scene online · loading models';
};

// The refusal has its own place because the one-line chip is not allowed to grow: a digest that
// does not fit is exactly the case this block exists for. It is never shortened here, and the
// reason is also written to `data-reason`, so the exact string can be read without parsing text.
const applyAssetRefusal = (status: AssetStatus) => {
  const reason = status === 'error' ? assetRegistry.error ?? 'unknown reason' : null;
  sceneReport.hidden = reason === null;
  sceneReportReason.dataset.reason = reason ?? '';
  sceneReportReason.textContent = reason ?? '';
};

const paintDevDiagnostics = () => {
  if (!devDiagnostics) {
    return;
  }
  const { performed, models, registry, scene } = assetRegistry.checks;
  const [model] = models;
  const rig = model?.skeleton ?? null;
  const modelLine = model
    ? `Model ${model.modelId} ${model.actualBytes}/${MODEL_BUDGET.bytes} B · ${model.triangles}/${MODEL_BUDGET.triangles} tris · ${rig?.bones ?? 0}/${MODEL_BUDGET.bones} bones · ${rig?.animationClips ?? 0}/${MODEL_BUDGET.animationClips} clips`
    : `Model — / ${MODEL_BUDGET.bytes} B · — / ${MODEL_BUDGET.triangles} tris · — / ${MODEL_BUDGET.bones} bones · — / ${MODEL_BUDGET.animationClips} clips`;
  devDiagnostics.rows.scene!.textContent = scene
    ? `Scene ${scene.drawCalls}/${SCENE_BUDGET.drawCalls} calls · ${scene.renderedTriangles}/${SCENE_BUDGET.renderedTriangles} tris · ${scene.shaderPrograms}/${SCENE_BUDGET.shaderPrograms} programs · ${Math.round(scene.assetLoadMs)}/${SCENE_BUDGET.assetLoadMs} ms load`
    : 'Scene not measured yet';
  devDiagnostics.rows.model!.textContent = modelLine;
  // The names of all ten, which is what the status line gave up when it started counting instead of
  // listing. The chip is one line of viewport chrome; this is a `?dev` block in the dock, and a list of
  // ids belongs to the surface that is allowed to grow.
  devDiagnostics.rows.models!.textContent = assetRegistry.modelIds.length > 0
    ? `Models ${assetRegistry.modelIds.join(', ')}`
    : 'Models none loaded';
  devDiagnostics.rows.registry!.textContent = registry
    ? `Registry ${registry.models}/${REGISTRY_BUDGET.models} models · ${registry.bytes}/${REGISTRY_BUDGET.bytes} B · ${registry.triangles}/${REGISTRY_BUDGET.triangles} tris`
    : 'Registry not measured yet';
  // A check that did not run is stated as such, and a hash that was skipped carries its reason: a
  // green reading must never be producible by not looking.
  const skippedHash = model?.contentHash.skippedReason;
  devDiagnostics.rows.checks!.textContent = [
    `bytes ${performed.bytes ? '✓' : 'not run'}`,
    `content hash ${performed.contentHash ? '✓' : skippedHash ? `skipped (${skippedHash})` : 'not run'}`,
    `node types ${performed.nodeTypes ? '✓' : 'not run'}`,
    `model budget ${performed.modelBudget ? '✓' : 'not run'}`,
    `registry budget ${performed.registryBudget ? '✓' : 'not run'}`,
    `scene budget ${performed.sceneBudget ? '✓' : 'not run'}`,
  ].join(' · ');
};

const applyAssetStatus = () => {
  const status = assetRegistry.status;
  viewportShell.dataset.assets = status;
  viewportShell.dataset.diagnostics = devDiagnosticsOn ? 'on' : 'off';
  statusLabel.textContent = gameplayStatus();
  applyAssetRefusal(status);
  paintDevDiagnostics();
};

// Walks the live scene rather than a list of known materials: a standard material added later
// without a declared weight has to turn up here as undeclared, instead of quietly rendering at
// the full probe the Three.js default gives it.
const objectPath = (object: THREE.Object3D): string => {
  const segments = [object.name || object.type];
  for (let node = object.parent; node && node !== scene; node = node.parent) {
    segments.unshift(node.name || node.type);
  }
  return segments.join('/');
};

const readProbeMaterials = (): ProbeMaterialReading[] => {
  const readings: ProbeMaterialReading[] = [];
  scene.traverse((object) => {
    const material = (object as THREE.Mesh).material;
    if (!material) {
      return;
    }
    for (const entry of Array.isArray(material) ? material : [material]) {
      if (!isProbeMaterial(entry)) {
        continue;
      }
      const role = typeof entry.userData.probeRole === 'string' ? entry.userData.probeRole : null;
      const ownsProbe = entry.envMap !== null;
      readings.push({
        path: objectPath(object),
        className: entry.type,
        role,
        envMapIntensity: entry.envMapIntensity,
        ownsProbe,
        materialId: entry.uuid,
        // An unknown role name is as good as no role at all, so the lookup is allowed to miss.
        explicit: role !== null && PROBE_WEIGHTS[role as ProbeRole] === entry.envMapIntensity && ownsProbe,
      });
    }
  });
  return readings;
};

const bootAssets = async () => {
  applyAssetStatus();
  const startedAt = performance.now();
  const accepted: string[] = [];
  const terrainAccepted: string[] = [];
  let refusal: string | null = null;
  try {
    const response = await fetch(ASSET_MANIFEST_URL);
    if (!response.ok) {
      throw new AssetContractError(`model registry responded ${response.status}`);
    }
    const manifest = parseAssetManifest(await response.json());
    assetRegistry.setManifest(manifest);
    assetRegistry.recordRegistryReading(sumRegistry(manifest.models));
    assetRegistry.markCheckPerformed('registryBudget');
    // The registry totals are a property of the manifest, so they are checked before a single
    // byte of a model is fetched: a registry that cannot fit is refused instead of downloaded.
    registryBudgetFailures = checkRegistryBudgets(manifest.models);
    if (registryBudgetFailures.length > 0) {
      throw new AssetContractError(describeFailures(registryBudgetFailures));
    }
    // The forty terrain records are fetched with the rest of the registry and in the same pass, because
    // they are in the same manifest and a separate load would be a second answer to "what does this
    // registry hold". They go into their own store: a prop is placed by slot on the plate and never
    // swapped into a seat, so putting one where a tower's model goes would let a tree be drawn in a
    // tower's place the moment an id collided.
    const entries: ManifestRecord[] = [...instancedEntries(manifest), ...terrainEntries(manifest)];
    const settled = await Promise.all(
      entries.map((entry) =>
        assetRegistry
          .load<LoadedModel | PropModel>(entry, () => loadModel(entry))
          .then((model) => ({ model }))
          .catch((error: unknown) => ({ error })),
      ),
    );
    const refusals: string[] = [];
    for (const outcome of settled) {
      if ('model' in outcome) {
        const id = outcome.model.entry.id;
        if (isTerrainRecord(outcome.model.entry)) {
          propStore.set(outcome.model.entry.file, outcome.model as PropModel);
          terrainAccepted.push(id);
        } else {
          modelStore.set(id, outcome.model as LoadedModel);
          accepted.push(id);
        }
        continue;
      }
      refusals.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
    }
    // A set with a hole in it is not drawn with a hole in it. The props go up as one thing or not at
    // all, and the refusal is stated rather than swallowed: the alternative is an occupied cell the map
    // calls blocked and the picture calls walkable, which is the one disagreement this whole cell model
    // exists to prevent. The ground and the cover on open ground still draw, so the match is playable
    // and the reason is on screen.
    const propRefusals = mountProps();
    if (propRefusals.length > 0) {
      refusals.push(...propRefusals);
    }
    if (refusals.length > 0) {
      refusal = refusals.join(' | ');
    }
  } catch (error) {
    // A broken contract is stated in the viewport instead of degrading silently, and the scene
    // keeps rendering procedural placeholders so the match stays playable.
    refusal = error instanceof Error ? error.message : String(error);
  }
  assetRegistry.recordAssetLoadMs(performance.now() - startedAt);
  if (refusal === null) {
    assetRegistry.markReady([...accepted, ...terrainAccepted]);
  } else {
    assetRegistry.markFailed(refusal, [...accepted, ...terrainAccepted]);
  }
  applyAssetStatus();
  towers.upgradeWithModels(presentationTime());
  enemies.upgradeWithModels();
};

const rejectionMessages: Record<string, string> = {
  'pad-occupied': 'A tower already stands here',
  'not-enough-gold': 'Not enough aether',
  'unknown-pad': 'Unknown build spot',
  'unknown-tower': 'Unknown module',
  // The three ways free ground can refuse a tower, and they are three sentences because they are three
  // different facts about the ground rather than three ways of saying "no". What a player does next is
  // different in each case: move off the road, move off the taken ground, or move a cell to get the
  // whole four-by-four clear.
  'spot-on-road': 'The road carries the wave · a tower cannot stand on it',
  'spot-on-occupied': 'This ground is already taken · a tower cannot stand on it',
  'spot-off-plate': 'That is off the map',
  'spot-square-blocked': 'A tower needs four by four clear cells',
  'match-finished': 'Match already finished',
  'wave-already-active': 'Wave already active',
  // The core answers the manual start with this and nothing else. Waves run on a clock now, so there
  // is nothing for the command to do and the honest answer is the one that says so.
  'waves-run-on-their-own': 'Waves land on their own clock · there is nothing to start',
  // The reasons a room owns rather than the core. They are named in one place on purpose: a refusal the
  // player cannot read is a refusal the player has to guess about, and the codes are the room's.
  'command-shape': 'The room did not read that as a command',
  'command-unreadable': 'The room did not answer that command',
  'session-unreachable': 'The session server could not be reached',
  'session-not-live': 'There is no room to send this command to',
};

let selectedTowerId = buildOptions[0]?.towerId ?? '';
let feedbackState: FeedbackState = 'idle';

const setFeedback = (state: FeedbackState, message: string, reason?: string) => {
  feedbackState = state;
  commandFeedback.textContent = message;
  commandFeedback.setAttribute('data-feedback', state);
  if (reason) {
    commandFeedback.setAttribute('data-reason', reason);
  } else {
    commandFeedback.removeAttribute('data-reason');
  }
};

const syncSelection = () => {
  for (const option of buildOptions) {
    const isSelected = option.towerId === selectedTowerId;
    option.button.classList.toggle('is-selected', isSelected);
    option.button.setAttribute('aria-pressed', String(isSelected));
  }
  const definition = towerDefinitions.get(selectedTowerId);
  if (!definition) {
    return;
  }
  selectionStatus.textContent = `${definition.name} ready`;
  selectionCardName.textContent = definition.name;
  const damageLabel = Number.isInteger(definition.damage) ? String(definition.damage) : definition.damage.toFixed(1);
  selectionCardDetail.textContent = `Range ${definition.range} · Damage ${damageLabel}`;
};

for (const option of buildOptions) {
  option.button.addEventListener('click', () => {
    selectedTowerId = option.towerId;
    syncSelection();
    setFeedback('idle', `${option.name} selected`);
  });
}

// The speed is a clock the player drives, not a rule of the match. `TICK_RATE` in the core is what it
// is and the core is frozen: a tick is the same length of match time whatever the multiplier says, and
// the multiplier only decides how many of those ticks one frame is allowed to spend. That is the whole
// difference between one times and four, and it is why the two produce the same match to the tick —
// the same commands land on the same ticks, the same enemies die on the same ticks, the same terminal
// report comes out. A speed that changed the length of a tick would be a different game wearing the
// same seed, and nothing on the surface would be able to say so.
const SPEED_STEPS = [0.5, 1, 2, 4];
const speedButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.speed-button'));
let gameSpeed = 1;

const syncSpeed = (): void => {
  for (const button of speedButtons) {
    const running = Number(button.dataset.speed) === gameSpeed;
    button.setAttribute('aria-pressed', running ? 'true' : 'false');
  }
};

for (const button of speedButtons) {
  button.addEventListener('click', () => {
    const wanted = Number(button.dataset.speed);
    if (!Number.isFinite(wanted) || wanted === gameSpeed) {
      return;
    }
    gameSpeed = wanted;
    syncSpeed();
  });
}

// The camera is a stand the player flies over the map and walks around. What moves is where the stand
// looks (the target), how much of the map the frustum covers (the zoom) and which way it is turned (the
// azimuth and the pitch). A left drag is the orbit again, and the map it turned away from — "a
// ninety-six unit map does not fit in a canvas by turning to face it" — was never true: the map does
// not fit at any azimuth, which is what the free zoom and the minimap are for, and turning to face it
// is the one thing a player expects from a game with a 3D board.
//
// The angle is the one the fog, the shadows and the whole read of the map were tuned at, and it is the
// middle of the band the pitch may leave. It is not derived from the reach below, and that is not a
// nicety: an orthographic camera moved along its own view axis draws exactly the same frame, so the
// reach can grow to whatever the clip planes need without moving a pixel of the picture.
const CAMERA_ELEVATION = Math.asin(10 / 16.16);
// How far the pitch may leave that angle, and why it is a band and not a free angle. Both ends are
// measured, not chosen: at thirty degrees the massif stands in front of three niches and they stop
// being clickable — thirty-three is the first whole degree above that, and it is a floor for the same
// reason the minimap left the board, a niche a player cannot click is a niche the player cannot play.
// The ceiling is a near-plan read of a ninety-six unit plate, where the depth stops carrying any shape
// and the terraces read as a texture; nothing is covered there. The table of both ends at four
// azimuths is in the report of `0036`.
const CAMERA_ELEVATION_MIN = (33 * Math.PI) / 180;
const CAMERA_ELEVATION_MAX = (58 * Math.PI) / 180;
// How far a drag turns the stand. Half a degree a pixel is a quarter turn in a swipe across a third of
// the board and a full turn in about one and a half screens, which is the whole range a player asked
// for: a ninety-six unit map with four throats has nothing to hide from any one of them, so there is no
// reason to make the turn slower than a wrist. The pitch is a quarter of that, because a pitch is a
// trim and a turn is a look.
const CAMERA_ORBIT_DEGREES_PER_PIXEL = 0.5;
const CAMERA_PITCH_DEGREES_PER_PIXEL = 0.12;
const DEGREES = Math.PI / 180;
// How much of the map the frustum holds, in world units of its own half-height at zoom 1, and it is the
// whole plate. It used to be a fixed sixteen — "the middle of the well and the four throats", which is
// what a player read a wave on while the map was a ring with four roads into a well. Neither the well
// nor the throats are on this map: there is one road network across the whole plate, and the thing to
// read at the moment a match opens is all of it. So zoom 1 is the lens `wholeMapView` measures for the
// plate and the canvas, which makes the wheel's wide end the home view and leaves the player zooming in
// from the whole map rather than out to it. The narrow end is still 1.2 — a tower filling the screen —
// and it is a lens the player drives, not a limit the map is built to.
const CAMERA_MIN_VIEW = 1.2;
// A ceiling on the wide end, not its value: the value is measured from the plate and the canvas in
// `measureWholeMapView` below, because a ninety-six unit map on a three-to-one canvas is limited by
// its depth and on a square one by its width, and forty-two — the number that would have fitted the
// old map — fits neither. Sixty is here so a very tall canvas cannot ask for a lens that shows the
// plate and half the void around it.
const CAMERA_MAX_VIEW = 60;
// How far the stand reaches, and why it is not the sixteen-sixteen it was on the forty-unit map.
//
// The camera plane — the plane through the camera, square to the view — crosses the ground
// `reach / cos(elevation)` in front of the target, and every part of the plate past that line is
// *behind* the camera. The renderer clips it at the near plane and the picker cannot reach it at
// all: three's orthographic `setFromCamera` starts the pick ray in the camera plane, and since r186
// it takes neither `near` nor `far` from the camera, so nothing widens it back out. The stand
// reaches that far because the target may walk to the edge of the plate (the limit `clampTarget`
// applies, at its widest, which is the narrowest lens), and the plate's own half depth has to be in
// front of the camera on top of that. At sixteen-sixteen the reach covered twenty units of a
// ninety-six unit plate: the fourteen niches on the near bank were drawn nowhere, clickable nowhere,
// and marked on the minimap all the same — a third of the board, six of those the only ground on
// the map that covers air.
//
// It is a function of the pitch because the pitch moves the plane. The frame reaches
// `halfHeight / cos(elevation)` in front of the target and the target clamp keeps that inside the
// plate's half depth, so a pitch anywhere in the band above needs a little more of the plate in
// front of the camera than a flat one does, and the numbers below hold at every angle in it.
const cameraTargetReach = (elevation: number): number =>
  Math.max(0, config.map.depth / 2 - CAMERA_MIN_VIEW / Math.cos(elevation));
// The stand's own distance from the target, which is the reach folded back along the view. It moves
// with the pitch, and everything stated in view space moves with it: the far plane and the fog band.
const cameraRadiusAt = (elevation: number): number =>
  (config.map.depth / 2 + cameraTargetReach(elevation)) * Math.cos(elevation) + 1;
let cameraRadius = cameraRadiusAt(CAMERA_ELEVATION);
// The frustum's own depth, from that same reach. Nothing on the plate is nearer to the camera than
// the camera is, and the far plane has to hold the far corner of the plate from this far back.
const CAMERA_NEAR = 0.1;
// The fog band the skin states, as offsets from the stand rather than from the world origin. `fogK` is
// a pair of fractions **of the plate**, not distances: the exporter writes them against the size of the
// map so that a plate twice as wide in world units pushes both ends out twice as far, and reading them
// as units would put the whole match inside the near band. The plate here is `plateWidth` cells wide
// and one cell is one world unit, so the fraction multiplies that and nothing else — the same
// conversion the relief went through, reached without dividing again because the multiplier is the
// plate's own width rather than the exporter's cell size.
//
// The numbers this replaces were 30 and 165 measured on the old twenty-two unit map; this forest set
// puts them at 91.2 and 403.2 world units, so within the frame the fog is much weaker than it was and
// the far edge of the plate no longer dissolves into the background. That is what the file says, and
// it is named here because a lighter fog is a visible change rather than a detail.
const FOG_NEAR_OFFSET = sky.fogK[0] * plateWidth;
const FOG_FAR_OFFSET = sky.fogK[1] * plateWidth;
const sceneFog = new THREE.Fog(
  sky.fog,
  cameraRadius + FOG_NEAR_OFFSET,
  cameraRadius + FOG_FAR_OFFSET,
);
scene.fog = sceneFog;
camera.near = CAMERA_NEAR;
camera.far = cameraRadius + config.map.depth;

// The stand is moved back along its own axis when the pitch changes, which is the only thing about a
// pitch that a pixel of the picture can see: an orthographic camera on the same view axis draws the
// same frame. Everything that is stated in view space — the far plane, the fog band, how much of the
// plate the widest lens can hold — follows it here, and everything stated in the world does not move
// at all. The lens the player is *on* is deliberately not touched: a pitch that also changed the zoom
// would be a camera that breathes under the hand, and the one thing a turn must not do is move the
// frame on its own. The new ceiling is simply there to be wheeled out to.
const syncCameraReach = (elevation: number): void => {
  const radius = cameraRadiusAt(elevation);
  if (radius === cameraRadius) {
    return;
  }
  cameraRadius = radius;
  camera.far = radius + config.map.depth;
  sceneFog.near = radius + FOG_NEAR_OFFSET;
  sceneFog.far = radius + FOG_FAR_OFFSET;
  const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1);
  cameraMaxView = wholeMapView(aspect);
};
// A drag that ends here was a click, and a click is a placement. Below it, the gesture was a swipe
// across the map and placing a tower by accident is worse than not placing one.
const CAMERA_CLICK_SLOP_PX = 4;
// Held keys pan in world units per second as a fraction of what the frame currently shows, so a held
// key crosses the same part of the map in the same time whether the player is looking at the whole
// vault or at one enemy, and the two speeds can never drift apart.
const CAMERA_KEY_PAN_PER_VIEW = 0.55;
// The frame is nudged down so that the thing being defended does not open the match under the sector
// caption; the space it moves into is the open ground below the road, which is the one part of the
// plate with nothing on it. `wholeMapView` above divides by one-minus-this, because a biased frame
// clears the far edge of the plate by that much less than a centred one and the home view has to hold
// all of it.
const CAMERA_FRAME_BIAS = 0.1;
// The margin the corridor measurement is scaled by. The fit has no control left in it — the frustum
// follows the target — so this only shapes the reading the seam publishes, and it is kept as a number
// because that reading is what says whether the road is on screen.
const FRAME_MARGIN = 1.05;
const CAMERA_KEYS = {
  KeyW: [0, -1], ArrowUp: [0, -1],
  KeyS: [0, 1], ArrowDown: [0, 1],
  KeyA: [-1, 0], ArrowLeft: [-1, 0],
  KeyD: [1, 0], ArrowRight: [1, 0],
} as const;

const cameraRig = {
  // Zero is a symmetry axis of this map: the ring and its four throats repeat every ninety degrees,
  // so the match opens on the same view four times out of four. The elevation is the one the fog and
  // the shadows were tuned at, and it is the only angle there is — the view is a map read from above
  // and slightly to the side, not a diorama on a turntable.
  azimuth: 0,
  elevation: CAMERA_ELEVATION,
  zoom: 1,
  targetX: 0,
  targetZ: 0,
};

const defaultCameraRig = { ...cameraRig };

// How far out the wheel can pull, measured from the plate and the canvas rather than guessed. The
// stand is tilted, so the map's depth is foreshortened by the sine of the elevation and its width is
// not: a ninety-six unit square in a three-to-one canvas is limited by its depth, and in a square
// canvas by its width. Whichever binds, with a tenth of margin, and the ceiling above.
//
// The depth is asked for as the frame will actually place it and not as the frustum is centred: the
// frame bias below takes a slice off the top of the frustum and gives it to the bottom, so a height
// that clears the plate about the centre clears it by that much less at the top. Dividing by
// one-minus-the-bias is the whole correction, and without it the home view crops the far edge of the
// plate by a couple of pixels — which is two pixels of nothing, and two pixels is how a "whole plate
// in frame" claim quietly stops being true.
const wholeMapView = (aspect: number): number => {
  const byDepth = (config.map.depth / 2) * Math.sin(cameraRig.elevation) / Math.max(0.2, 1 - CAMERA_FRAME_BIAS);
  const byWidth = config.map.width / 2 / Math.max(0.2, aspect);
  return Math.min(CAMERA_MAX_VIEW, Math.max(byDepth, byWidth) * 1.1);
};

let cameraMaxView = CAMERA_MAX_VIEW;
// The lens at zoom 1. It is the same measurement the wheel's wide end uses, which is the point: the
// home view is the widest view, so `cameraMaxZoom()` is one and the wheel only ever pulls in.
const homeView = (): number => cameraMaxView;
const cameraMaxZoom = (): number => cameraMaxView / homeView();
const cameraMinZoom = (): number => CAMERA_MIN_VIEW / homeView();

// What the frustum holds right now, in its own half-height. Everything about the view is derived from
// this and from the target, which is the fix for the pan that never panned: the frustum used to be
// fitted to the corridor every frame, so the target was written, looked at, and then overridden.
const viewHalfHeight = (): number =>
  Math.min(cameraMaxView, Math.max(CAMERA_MIN_VIEW, homeView() * cameraRig.zoom));

// Screen-up is not world -z while the stand is tilted, so the target is projected into the camera's
// own basis rather than assumed to be the middle of the frame. That projection is also what lets the
// frustum follow a target anywhere on the map without the tilt smearing it.
const framePoint = new THREE.Vector3();

const placeCamera = (): void => {
  const horizontal = Math.cos(cameraRig.elevation) * cameraRadius;
  camera.position.set(
    cameraRig.targetX + horizontal * Math.sin(cameraRig.azimuth),
    Math.sin(cameraRig.elevation) * cameraRadius,
    cameraRig.targetZ + horizontal * Math.cos(cameraRig.azimuth),
  );
  camera.lookAt(cameraTarget.set(cameraRig.targetX, 0, cameraRig.targetZ));
  camera.updateMatrixWorld(true);
};

// The target is kept on the map, and the limit is the edge of what the frame can see rather than a
// fixed margin: at the home zoom the stand may not walk off the plate, and zoomed all the way out the
// whole plate is in frame, so the limit collapses to the middle and the stand sits still. A clamp that
// did not move with the zoom let the player push the map off the screen on a wide lens and could not
// bring it back without a zoom change first.
const clampTarget = (): void => {
  placeCamera();
  const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1);
  const halfHeight = viewHalfHeight();
  const halfWidth = halfHeight * aspect;
  // World z is foreshortened by the tilt, so a unit of screen height is more than a unit of ground.
  const groundReachZ = halfHeight / Math.max(0.2, Math.cos(cameraRig.elevation));
  const limitX = Math.max(0, config.map.width / 2 - halfWidth);
  const limitZ = Math.max(0, config.map.depth / 2 - groundReachZ);
  cameraRig.targetX = Math.min(limitX, Math.max(-limitX, cameraRig.targetX));
  cameraRig.targetZ = Math.min(limitZ, Math.max(-limitZ, cameraRig.targetZ));
};

const resetCamera = (): void => {
  Object.assign(cameraRig, defaultCameraRig);
  applyCameraRig();
};

// How much of the plate the frame would hold, and where its middle is. It is a measurement and not a
// control any more — the frustum follows the target now — so it is here for the seam and for the
// honest answer to "is the map on screen", and it is the only surviving use of the sample points.
const measureCorridor = (): { centerX: number; centerY: number; halfWidth: number; halfHeight: number } => {
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.POSITIVE_INFINITY;
  let top = Number.NEGATIVE_INFINITY;
  for (const [x, z] of mapPresentation.corridorSamplePoints) {
    const view = framePoint.set(x, 0, z).applyMatrix4(camera.matrixWorldInverse);
    left = Math.min(left, view.x);
    right = Math.max(right, view.x);
    bottom = Math.min(bottom, view.y);
    top = Math.max(top, view.y);
  }
  return {
    centerX: (left + right) / 2,
    centerY: (bottom + top) / 2,
    halfWidth: ((right - left) / 2) * FRAME_MARGIN,
    halfHeight: ((top - bottom) / 2) * FRAME_MARGIN,
  };
};

// The margin that measurement is scaled by is `FRAME_MARGIN`, declared with the rest of the camera
// numbers above.

const applyCameraRig = (): void => {
  // The reach follows the pitch before anything is placed, because where the stand is decides how much
  // of the plate is in front of the camera at all, and the frustum below is measured from the stand.
  syncCameraReach(cameraRig.elevation);
  clampTarget();
  placeCamera();
  const aspect = (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1);
  const halfHeight = viewHalfHeight();
  const halfWidth = halfHeight * aspect;
  // Biased down a little: the well's own centre puts the core chamber under the sector caption in the
  // top corner, and the thing being defended should not open the match hidden behind a label. The
  // space it moves into is the rock below the road, which is the one part of the frame with nothing
  // in it. On a map this size the bias is a per-cent of the frame, not a band of rock to give up.
  const centre = framePoint.set(cameraRig.targetX, 0, cameraRig.targetZ).applyMatrix4(camera.matrixWorldInverse);
  const centreY = centre.y - halfHeight * CAMERA_FRAME_BIAS;
  camera.left = centre.x - halfWidth;
  camera.right = centre.x + halfWidth;
  camera.top = centreY + halfHeight;
  camera.bottom = centreY - halfHeight;
  camera.updateProjectionMatrix();
  // The shadow frustum follows the frame, for the reason `fitShadowToView` gives. Written here rather
  // than in `resize` because the frame changes on every zoom and every turn, not only when the window
  // does — a shadow box sized to the window but frozen across a zoom-out would put its edge in the
  // middle of the plate.
  fitShadowToView(halfWidth, halfHeight);
};

let appliedViewportWidth = 0;
let appliedViewportHeight = 0;

const resize = () => {
  const width = sceneMount.clientWidth || 1;
  const height = sceneMount.clientHeight || 1;
  if (width === appliedViewportWidth && height === appliedViewportHeight) {
    return;
  }
  appliedViewportWidth = width;
  appliedViewportHeight = height;
  cameraMaxView = wholeMapView(width / height);
  // The rig's own zoom is re-clamped rather than reset: a window that grew should not throw away
  // where the player was looking, but a view that no longer fits the plate has to come back in.
  cameraRig.zoom = Math.min(cameraMaxZoom(), Math.max(cameraMinZoom(), cameraRig.zoom));
  applyCameraRig();
  renderer.setSize(width, height, false);
};

// The dock, the save panel and the entry overlay all change how much room the scene gets without
// the window changing size, so a `resize` listener alone leaves the frustum fitted to a box that is
// no longer there — the map gets cut off by chrome that grew under it. The observer is the only thing
// that notices, and the size guard keeps its own `setSize` from waking it again.
const mountSizeObserver = new ResizeObserver(() => {
  resize();
});
mountSizeObserver.observe(sceneMount);
resize();

const EVENT_FEED_LIMIT = 5;
const RECENT_EVENT_LIMIT = 16;

let elapsed = 0;
// Presentation time is the time the match clock has been stepped for, which is the tick the
// projection is at times one tick. It is not wall time: `elapsed` above is, and it keeps running
// while the match is paused, which is what the ambient bob wants. A skeleton follows the match
// instead, so a paused snapshot and a paused screenshot show the same pose, and a restarted match
// puts every tower back into the pose its tick implies.
const presentationTime = (): number => snapshot.tick * STEP_SECONDS;

const phaseLabels: Record<MatchStatus, string> = {
  preparation: 'Preparation',
  wave: 'Wave active',
  victory: 'Victory',
  defeat: 'Defeat',
};

const resultLabels: Record<'victory' | 'defeat', string> = {
  victory: 'Sector secured',
  defeat: 'Core breached',
};

const formatClock = (ticks: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ticks * STEP_SECONDS));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

// `preparationTicksLeft` is the countdown to the next wave, and it is zero except inside that wave's
// own prep window, so the clock says which of the two things the player is looking at: how long the
// wave on the map has been running, or how long until the next one lands on top of it.
const phaseTimerText = (state: MatchSnapshot): string => {
  if (state.status === 'preparation') {
    // The content prep window is short, so an elapsed countdown is shown as a neutral
    // awaiting-start label instead of a frozen `T-00:00` that reads as a live timer.
    return state.preparationTicksLeft > 0 ? `T-${formatClock(state.preparationTicksLeft)}` : 'Awaiting start';
  }
  if (state.status === 'wave') {
    return state.preparationTicksLeft > 0
      ? `Next T-${formatClock(state.preparationTicksLeft)}`
      : `W+${formatClock(state.waveTick)}`;
  }
  return state.status === 'victory' ? 'Cleared' : 'Breached';
};

const objectiveSummary = (state: MatchSnapshot): string => {
  if (state.status === 'preparation') {
    return 'Waves land on their own · build while the clock runs';
  }
  if (state.status === 'wave') {
    // Leaks are counted since the last wave launched, so the number is the pressure the player is
    // under right now rather than a total for a wave that is not over and, with overlapping waves,
    // never will be.
    return `Leaks ${state.leaksThisWave}`;
  }
  if (state.status === 'victory') {
    return 'Objective complete';
  }
  return `Core lost on wave ${state.waveIndex + 1}`;
};

let snapshot = simulation.getSnapshot();

const terminalFeedbackLabels: Record<'victory' | 'defeat', string> = {
  victory: 'Sector secured · restart repeats this run exactly',
  defeat: 'Core breached · restart repeats this run exactly',
};

// A control the player may not press has to say why, and the reason is a code the room uses rather
// than a sentence invented here: the same refusal the room would have given is what the hint names, so
// a disabled button and a sent request can never tell the player two different stories. Both the code
// and the words are written from one place, which is what keeps them from coming apart.
const setControlHint = (button: HTMLButtonElement, reason: string | null, text: string): void => {
  if (reason === null) {
    button.removeAttribute('data-reason');
  } else {
    button.setAttribute('data-reason', reason);
  }
  button.title = text;
};

const roomVerbText = (reason: string): string => SESSION_REFUSAL_TEXT[reason] ?? reason;

const syncRoomControlHints = (): void => {
  if (mode !== 'remote') {
    return;
  }
  const live = sessionState === 'live';
  const owner = live && sessionSeatRole === 'owner';
  if (live && owner) {
    setControlHint(restartButton, null, 'Restart the room run for every client in it');
    setControlHint(endRoomButton, null, 'Close this room for everyone; nobody can sit in it again');
    return;
  }
  if (!live) {
    const noRoom = roomVerbText('session-not-live');
    setControlHint(restartButton, 'session-not-live', noRoom);
    setControlHint(endRoomButton, 'session-not-live', noRoom);
    return;
  }
  setControlHint(restartButton, 'owner-only-restart', roomVerbText('owner-only-restart'));
  setControlHint(endRoomButton, 'owner-only-end-room', roomVerbText('owner-only-end-room'));
};

const syncHud = () => {
  const remote = mode === 'remote';
  // In a room the seat decides, not the button: the owner may restart the run and close the room, a
  // guest may not, and neither may do either of them while there is no room to ask. The room decides
  // that, this page only shows it — the control being off is the same answer the room would give.
  const roomLive = remote && sessionState === 'live';
  const roomOwner = roomLive && sessionSeatRole === 'owner';
  goldValue.textContent = String(snapshot.gold);
  const integrity = snapshot.maxCoreHealth > 0 ? snapshot.coreHealth / snapshot.maxCoreHealth : 0;
  integrityValue.textContent = `${Math.round(integrity * 100)}%`;
  waveValue.textContent = `${String(snapshot.waveIndex + 1).padStart(2, '0')} / ${String(waveCount).padStart(2, '0')}`;
  matchPhase.textContent = phaseLabels[snapshot.status];
  matchPhase.dataset.phase = snapshot.status;
  viewportShell.dataset.phase = snapshot.status;
  phaseTimer.dataset.kind = snapshot.status;
  phaseTimer.textContent = phaseTimerText(snapshot);
  enemyCount.textContent = String(snapshot.enemies.length);
  objectiveDetail.textContent = objectiveSummary(snapshot);
  // The manual start is gone from the rules, and this row now says when the next wave lands instead of
  // offering a button that would be refused. It is still the one place the schedule is visible, so it
  // is a readout and not a control: a permanently disabled button that says nothing is chrome, and one
  // that says "Next wave in 0:12" is the thing the player is actually playing against.
  const nextWaveIn = snapshot.preparationTicksLeft;
  const wavesLeft = waveCount - (snapshot.waveIndex + (snapshot.status === 'wave' ? 1 : 0));
  startWaveButton.disabled = true;
  startWaveButton.dataset.counting = nextWaveIn > 0 ? 'yes' : 'no';
  startWaveButton.textContent = nextWaveIn > 0
    ? `Next wave in ${formatClock(nextWaveIn)}`
    : wavesLeft > 0
      ? `Wave ${snapshot.waveIndex + 1} on the field`
      : `Last wave · ${snapshot.enemies.length} left`;
  // Restart is a room verb and a local rebuild, and the two are never both: in a room the run belongs
  // to the room, so the button asks the room to start over and every client is given the new
  // preparation. In solo it rebuilds the core this page owns, and it has nothing to rebuild until
  // something has been recorded.
  restartButton.disabled = remote ? !roomOwner : commandLog.length === 0;
  // Closing a room is only meaningful in one, so the control is not on the dock at all in solo rather
  // than being present and permanently off.
  endRoomButton.hidden = !remote;
  endRoomButton.disabled = !roomOwner;
  restartButton.dataset.seat = sessionSeatRole ?? '';
  endRoomButton.dataset.seat = sessionSeatRole ?? '';
  // A log under replay names commands the rebuilt run has not reached yet, so the slot cannot be
  // written from the middle of one. New match stays available throughout: it is the way out.
  saveButton.disabled = remote || replaying;
  newMatchButton.disabled = remote;
  pauseToggle.disabled = remote;
  pauseToggle.textContent = paused ? 'Resume' : 'Pause';
  pauseToggle.setAttribute('aria-pressed', String(paused));
  viewportShell.dataset.paused = String(paused);
  viewportShell.dataset.replay = replaying ? 'running' : 'idle';
  // Pause and replay are independent clocks, so the badge has to name both at once.
  stateBadge.dataset.state = replaying ? (paused ? 'paused-replay' : 'replay') : paused ? 'paused' : 'idle';
  if (replaying) {
    const progress = `${replayIndex} / ${commandLog.length} commands`;
    stateBadge.textContent = paused ? `Replay paused · ${progress}` : `Replay · ${progress}`;
    stateBadge.hidden = false;
  } else if (paused) {
    stateBadge.textContent = 'Paused';
    stateBadge.hidden = false;
  } else {
    stateBadge.hidden = true;
  }
  for (const option of buildOptions) {
    // In a room the palette is not locked by a replay — it is open, because the build buttons are a
    // choice of what to ask the room for and a choice is not a command.
    option.button.disabled = remote ? sessionState !== 'live' : replaying;
  }
  if (snapshot.status === 'victory' || snapshot.status === 'defeat') {
    resultBanner.hidden = false;
    resultBanner.dataset.result = snapshot.status;
    resultBanner.textContent = resultLabels[snapshot.status];
    // The terminal result outranks whatever command feedback was still on screen.
    if (feedbackState !== 'terminal') {
      setFeedback('terminal', terminalFeedbackLabels[snapshot.status]);
    }
  } else {
    resultBanner.hidden = true;
    resultBanner.dataset.result = 'none';
  }
  syncRoomControlHints();
};

const applySnapshot = (next: MatchSnapshot) => {
  snapshot = next;

  // The two domains read the same snapshot and each owns its own views. The order they are called
  // in is the order their views were built in before this was split into modules. The map is not one
  // of them any more: it has no state that arrives with the snapshot — no pad to fill, no core to
  // recolour — so there is nothing for it to read here.
  towers.applySnapshot(next, presentationTime());
  enemies.applySnapshot(next);

  // One report per match, captured while the frame is still in sync with the events of
  // the terminal tick, so a replay can be compared against the run it reproduced.
  if (!terminalReported && (next.status === 'victory' || next.status === 'defeat')) {
    terminalReported = true;
    matchReports.push({
      status: next.status,
      tick: next.tick,
      gold: next.gold,
      coreHealth: next.coreHealth,
      leaksThisWave: next.leaksThisWave,
      eventCounts: { ...eventCounts },
    });
  }

  syncHud();
};

const syncFromCore = () => {
  const next = simulation.getSnapshot();
  if (next.tick === snapshot.tick && next.status === snapshot.status) {
    return;
  }
  applySnapshot(next);
};

const dispatchCommand = (command: Command): CommandResult => {
  const result = simulation.dispatch(command);
  // Command events are consumed in the same task as the input so feedback, event
  // counts and the snapshot never lag the click by a frame.
  eventsDrained += consumeLocalEvents();
  applySnapshot(simulation.getSnapshot());
  return result;
};

const replayBlockedReason = 'replay-in-progress';
const replayBlockedFeedback = 'Recorded run is replaying · commands are locked until it finishes';

// The one place an outcome becomes a sentence. Both modes end up here and nowhere else: solo reaches
// it in the same task as the click, a room reaches it when the room's answer arrives. A client that
// turned an answer into its own verdict would be a second implementation of the rules, so this function
// only ever reads what it is given — the reason it shows is the reason its owner produced.
const reportCommandResult = (command: Command, result: CommandResult) => {
  if (result.accepted) {
    if (command.type === 'startWave') {
      setFeedback('accepted', `Wave ${snapshot.waveIndex + 1} started`);
      return;
    }
    const name = towerDefinitions.get(command.towerId)?.name ?? command.towerId;
    setFeedback('accepted', `${name} built on cell ${spotCellLabel(command.padId)}`);
    return;
  }
  const reason = result.reason ?? 'rejected';
  if (reason === replayBlockedReason) {
    // The guard already explained that the recorded run owns the core; a pad flash would claim the core
    // rejected a build it never saw.
    setFeedback('rejected', replayBlockedFeedback, reason);
    return;
  }
  const message = rejectionMessages[reason];
  // A blocked square says how many of its sixteen cells are spoken for, because "the square is not
  // free" is not something a player can act on and "four of them are taken" is. The count comes from
  // the core that refused, not from a second reading of the map here.
  const counted = message !== undefined && result.detail !== undefined
    ? `${message} · ${result.detail} of ${TOWER_FOOTPRINT_CELLS * TOWER_FOOTPRINT_CELLS} taken`
    : message;
  setFeedback('rejected', counted ?? `Rejected: ${reason}`, reason);
};

/** A spot name as the player reads a cell: the coordinates, not the internal prefix. */
const spotCellLabel = (padId: string): string => {
  const cell = cellForSpotId(padId);
  return cell === null ? padId : `${cell.x}, ${cell.y}`;
};

// What the two room verbs did, in words. Only the room decides either, so the accepted sentence is a
// statement about what it published — every client of the room got the same thing — and a refusal
// quotes the reason the room gave rather than a phrase invented here.
const roomVerbLabels: Record<RoomVerb, { done: string; refused: string }> = {
  restartRun: { done: 'Room run restarted · every client got the new preparation', refused: 'owner-only-restart' },
  endRoom: { done: 'Room closed · nobody can sit in it again', refused: 'owner-only-end-room' },
};

const reportRoomVerb = (verb: RoomVerb, result: { accepted: boolean; reason?: string }): void => {
  const labels = roomVerbLabels[verb];
  if (result.accepted) {
    setFeedback('accepted', labels.done);
    return;
  }
  const reason = result.reason ?? 'rejected';
  setFeedback(
    'rejected',
    SESSION_REFUSAL_TEXT[reason] ?? rejectionMessages[reason] ?? `Rejected: ${reason}`,
    reason,
  );
};

// Player intent is logged with the tick it was issued on. Seed plus the tick-ordered
// log is the whole input of a match, so replaying the log on a fresh core reproduces it.
// This is also the only place that may append to the log, so it carries the replay guard:
// while a replay is running nothing outside `applyReplayPlan` can fork the run, no matter
// whether the command arrives from a pad click, Start Wave or the QA seam.
const dispatchPlayerCommand = (command: Command): CommandResult => {
  if (replaying) {
    const blocked: CommandResult = { accepted: false, reason: replayBlockedReason };
    reportCommandResult(command, blocked);
    return blocked;
  }
  commandLog.push({ tick: snapshot.tick, appliedTick: snapshot.tick, command });
  const result = dispatchCommand(command);
  reportCommandResult(command, result);
  return result;
};

const resetEventPresentations = () => {
  for (const type of Object.keys(eventCounts) as Array<keyof typeof eventCounts>) {
    eventCounts[type] = 0;
  }
  recentEvents.length = 0;
  eventFeedEntries.length = 0;
  renderEventFeed();
  eventsDrained = 0;
  combatFx.clearCombatBursts();
  towers.resetFired();
};

// The tick a rebuild stops on, or `null` when the run it rebuilt is free to continue. It answers a
// different question from `replaying`, which is "commands are locked": a match that recorded no
// command still has a tick to rebuild, and in that case there is nothing to lock in the first place.
let rebuildStopTick: number | null = null;

// The rebuild that has to be recorded, and the recording of the last one. The capture happens at the
// end of the frame that arrived, not inside the arrival, so the reading belongs to the same tick as
// the presentation around it.
let pendingRebuild: { requestedTick: number; tick: number } | null = null;
let lastRebuild: RebuildReading | null = null;
// The last rebuild that had no tick to stop on, read on the tick it was built at. It is a separate mark
// rather than another state of `lastRebuild`, because `lastRebuild` means "a slot was loaded here" and
// twenty-odd assertions read that meaning.
let lastFreshRun: FreshRunReading | null = null;

// The one way this page rebuilds a run: a new core from the same seed and content, the recorded
// commands re-applied at their original ticks by the frame loop, and presentation state put back
// afterwards from the snapshot — exactly what a restart has always been. Restart is this with no
// stop, Load is this with a tick to stop on, New match is this with an empty log. A saved match is
// therefore not restored by a second path of its own; it is the replay that already exists, stopped
// on a tick. The pause state stays as the player left it, so a frozen clock stays frozen.
const beginRecordedRun = (stopTick: number | null) => {
  simulation = createSimulation(config);
  terminalReported = false;
  accumulator = 0;
  resetEventPresentations();
  replayIndex = 0;
  replaying = commandLog.length > 0;
  rebuildStopTick = stopTick;
  setFeedback('idle', replaying ? 'Replaying recorded commands' : 'Nothing recorded yet · place a module first');
  applySnapshot(simulation.getSnapshot());
  // A rebuild with a tick to stop on is recorded when it arrives, at the end of the frame that got
  // there. A rebuild with none has nothing to wait for and no frame that could hold still for it: the
  // clock is free again the moment this returns, so the state the new core was built from is read here
  // and now. Read from outside, it would name a later tick and say nothing about the arrival — which is
  // what a test asserting "the fresh preparation is on tick 0" was measuring instead.
  lastFreshRun = readRunState(snapshot.tick);
};

// Restart is one verb and two owners of the match. In solo it rebuilds the run on the core this page
// owns. In a room the run belongs to the room, so the owner asks the room to start over and every
// client is given the new preparation in a frame — a local rebuild here would put this window in a
// different match from the other one, which is the exact failure the room exists to prevent. A guest
// never reaches this: the control is off and carries the reason, and the room would refuse it anyway.
const restartMatch = () => {
  if (mode === 'remote') {
    void sendRoomVerb('restartRun');
    return;
  }
  beginRecordedRun(null);
};

// Closing a room ends it for everyone, so the control is on the dock next to Restart rather than
// behind a menu: it is a decision about a match that is being played right now, and burying it would
// make it something a player has to go looking for.
const endRoom = () => {
  if (mode !== 'remote') {
    return;
  }
  void sendRoomVerb('endRoom');
};

const applyReplayPlan = () => {
  while (replayIndex < commandLog.length && snapshot.tick >= commandLog[replayIndex].tick) {
    const entry = commandLog[replayIndex];
    entry.appliedTick = snapshot.tick;
    replayIndex += 1;
    dispatchCommand(entry.command);
  }
  if (replayIndex >= commandLog.length) {
    replaying = false;
    setFeedback('idle', `Replay finished · ${commandLog.length} commands applied`);
    syncHud();
  }
};

let eventsDrained = 0;

const eventCounts: Record<SimulationEvent['type'], number> = {
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
};
const recentEvents: SimulationEvent[] = [];
const eventFeedEntries: EventFeedEntry[] = [];

// --- Match persistence ---------------------------------------------------------------------
// The slot holds the input of a match, not its state: seed, content version, schema version, the
// tick and the tick-ordered command log. A snapshot is a function of exactly those, so Load rebuilds
// a match by replaying the log to the saved tick on the path Restart already uses, and the only
// thing a reload has to carry is the input. Nothing below decides anything about a match: the
// validator checks the shape and the versions of a local artifact, and every change of state still
// goes through `Simulation`. A payload that fails validation is left where it is, so the player can
// read the reason and decide what to do with the slot.

const MATCH_SAVE_KEY = 'echoes-of-burbenog:match:v1';
const MATCH_SAVE_SCHEMA = 1;

// Content is versioned separately from the runtime code, and the training scenario carries no version
// of its own, so the client declares the content it was built against — and it declares the same number
// the session contract declares, because a slot written against one content and a room running another
// are the same mistake in two places. A slot written by a build with other content describes a match
// this client cannot reproduce, and is refused rather than replayed into something it never said.
const TRAINING_CONTENT_VERSION = CONTENT_VERSION;

// The slot is a local artifact that a player, an extension or a stray script can edit, so the number
// of commands it may claim is bounded before anything is replayed. The training match records six.
const MAX_SAVED_COMMANDS = 512;

type SavedCommandEntry = {
  tick: number;
  command: Command;
};

type MatchSavePayload = {
  schemaVersion: number;
  contentVersion: number;
  seed: number;
  tick: number;
  log: SavedCommandEntry[];
  // The room seat this browser holds, when it holds one. It is not part of the match: a slot without it
  // rebuilds the same run, which is why the rebuild never reads it. It is here because the slot is the
  // only thing this browser keeps between visits, and a seat that lived in page memory alone would make
  // every reload a new guest — which, for an owner, would mean losing the right to restart or close
  // their own room to a page refresh.
  roomToken?: string;
};

type SaveSlotReading =
  | { state: 'empty'; roomToken: string | null }
  | { state: 'ready'; payload: MatchSavePayload; roomToken: string | null }
  | { state: 'refused'; reason: string; message: string; roomToken: string | null };

const refuseSlot = (reason: string, message: string, roomToken: string | null = null): SaveSlotReading => ({
  state: 'refused',
  reason,
  message,
  roomToken,
});

// Whether a command is one this build knows how to hand over is asked in the protocol module, because
// the room asks the same question of a POST body and the two answers cannot differ: a command the slot
// validator accepts and the room rejects would be one artifact with two grammars. Whether the command
// would be *accepted* is not asked here at all — that is the core's answer in solo and the room's answer
// in a room, and both are recorded per command in the log either way.

const readSaveSlot = (): SaveSlotReading => {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(MATCH_SAVE_KEY);
  } catch {
    return refuseSlot('save-slot-unreadable', 'This browser context cannot read the save slot');
  }
  if (raw === null) {
    return { state: 'empty', roomToken: null };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuseSlot('save-slot-unreadable', 'Save slot is not readable JSON · slot left untouched');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuseSlot('save-payload-shape', 'Save slot is not a save payload · slot left untouched');
  }

  // The seat is read before anything else and travels with every answer, including a refusal: a slot
  // this build cannot rebuild may still name the room seat the player is coming back to, and losing it
  // over an unrelated version would quietly turn an owner into a guest. It is taken as a plain string
  // on purpose — whether a token is one a room issued is that room's answer, not this validator's.
  const roomToken = typeof (parsed as { roomToken?: unknown }).roomToken === 'string' ? (parsed as { roomToken: string }).roomToken : null;
  const fail = (reason: string, message: string): SaveSlotReading => refuseSlot(reason, message, roomToken);

  const candidate = parsed as Partial<Record<keyof MatchSavePayload, unknown>>;
  if (candidate.schemaVersion !== MATCH_SAVE_SCHEMA) {
    return fail(
      'save-schema-version',
      `Save format v${String(candidate.schemaVersion)} is not the v${MATCH_SAVE_SCHEMA} this build reads · slot left untouched`,
    );
  }
  if (candidate.contentVersion !== TRAINING_CONTENT_VERSION) {
    return fail(
      'save-content-version',
      `Save holds content v${String(candidate.contentVersion)} · this build runs v${TRAINING_CONTENT_VERSION} · slot left untouched`,
    );
  }
  if (candidate.seed !== config.seed) {
    return fail(
      'save-seed-mismatch',
      `Save holds seed ${String(candidate.seed)} · this build runs ${config.seed} · slot left untouched`,
    );
  }
  const tick = candidate.tick;
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
    return fail(
      'save-tick-invalid',
      `Save tick ${String(tick)} is not a whole tick count · slot left untouched`,
    );
  }
  if (!Array.isArray(candidate.log)) {
    return fail('save-log-invalid', 'Save holds no command log · slot left untouched');
  }
  if (candidate.log.length > MAX_SAVED_COMMANDS) {
    return fail(
      'save-log-invalid',
      `Save claims ${candidate.log.length} commands · limit is ${MAX_SAVED_COMMANDS} · slot left untouched`,
    );
  }

  const log: SavedCommandEntry[] = [];
  let previousTick = 0;
  for (const [index, entry] of candidate.log.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return fail('save-entry-shape', `Save command ${index} is not a record · slot left untouched`);
    }
    const { tick: entryTick, command } = entry as { tick?: unknown; command?: unknown };
    if (typeof entryTick !== 'number' || !Number.isInteger(entryTick) || entryTick < 0 || entryTick > tick) {
      return fail(
        'save-entry-tick-out-of-range',
        `Save command ${index} claims tick ${String(entryTick)} outside [0, ${tick}] · slot left untouched`,
      );
    }
    // The replay applies a command on the tick it names and can only move forward, so a log that
    // goes back in time is not a run this client could rebuild. This is a property of the artifact.
    if (index > 0 && entryTick < previousTick) {
      return fail(
        'save-entry-out-of-order',
        `Save command ${index} claims tick ${entryTick} after tick ${previousTick} · slot left untouched`,
      );
    }
    if (!isKnownCommand(command)) {
      return fail(
        'save-command-unknown',
        `Save command ${index} is not a command this build knows · slot left untouched`,
      );
    }
    log.push({ tick: entryTick, command });
    previousTick = entryTick;
  }

  return {
    state: 'ready',
    roomToken,
    payload: {
      schemaVersion: MATCH_SAVE_SCHEMA,
      contentVersion: TRAINING_CONTENT_VERSION,
      seed: config.seed,
      tick,
      log,
      ...(roomToken === null ? {} : { roomToken }),
    },
  };
};

const setSaveFeedback = (result: 'idle' | 'saved' | 'loaded' | 'refused' | 'cleared', message: string, reason?: string) => {
  // One writer, two surfaces. The dock line is where the result belongs while a match is being
  // played, and the entry line is the same sentence where the player can read it before there is a
  // match — a refusal that happens at the entry would otherwise be reported behind a closed
  // overlay, which is the one place a player cannot act on it.
  for (const line of [saveFeedback, entryFeedback]) {
    line.textContent = message;
    line.dataset.result = result;
    if (reason) {
      line.setAttribute('data-reason', reason);
    } else {
      line.removeAttribute('data-reason');
    }
  }
};

// The reading the entry and the dock share. It is kept rather than re-read at each use so that the
// two surfaces answer the same question from the same moment: `refreshSaveSlot` is the only reader
// of the slot in the page, and whatever it last saw is what both of them are describing.
let slotReading: SaveSlotReading = { state: 'empty', roomToken: null };

// Save is named the same way wherever it is read, including its plural, so the entry and the dock
// cannot drift into two formats of the same fact.
const commandCountLabel = (commands: number): string =>
  `${commands} ${commands === 1 ? 'command' : 'commands'}`;

const slotStateLabel = (payload: MatchSavePayload): string =>
  `Save · tick ${payload.tick} · ${commandCountLabel(payload.log.length)}`;

// The slot is read on boot and after every action that touches it, so a slot that exists is visible
// before anything is loaded from it and there is no state in which a match is restored behind the
// player's back. An unreadable slot keeps Load available: the player asked for the reason, and New
// match is what clears it.
const refreshSaveSlot = (): SaveSlotReading => {
  // The reading is taken first and the display branches afterwards, because the seat is not part of the
  // match: a room still has to be able to read the seat out of the same artifact, and a second reader
  // of localStorage is a second answer to the same question.
  const reading = readSaveSlot();
  slotReading = reading;
  if (mode === 'remote') {
    // A room's match has no slot in this browser, and the panel is not allowed to describe a slot that
    // belongs to a different match: a leftover local save sitting under a room that never asked for it
    // would name a tick and a command count of a game that is not on screen. The line says what the
    // panel is instead — and it stays true, because what is kept here in a room is a seat, not a match.
    saveSlotLabel.textContent = 'Room match · not saved here';
    saveSlotLabel.dataset.state = 'room';
    loadButton.disabled = true;
    return reading;
  }
  if (reading.state === 'empty') {
    saveSlotLabel.textContent = 'No save slot';
    saveSlotLabel.dataset.state = 'empty';
    loadButton.disabled = true;
    return reading;
  }
  if (reading.state === 'refused') {
    saveSlotLabel.textContent = 'Save unreadable';
    saveSlotLabel.dataset.state = 'unreadable';
    loadButton.disabled = false;
    return reading;
  }
  saveSlotLabel.textContent = slotStateLabel(reading.payload);
  saveSlotLabel.dataset.state = 'ready';
  loadButton.disabled = false;
  return reading;
};

// Keeping a seat is a write, and it is the only write a room makes here. The payload is read, the
// token is added and the payload goes back — the match in it is never touched. A browser with no slot
// gets the smallest true one, a preparation with nothing recorded, because a seat has to survive a
// reload and this is the only place this browser has to put it.
const persistSeatToken = (token: string): void => {
  const reading = refreshSaveSlot();
  const payload: MatchSavePayload =
    reading.state === 'ready'
      ? { ...reading.payload, roomToken: token }
      : {
          schemaVersion: MATCH_SAVE_SCHEMA,
          contentVersion: TRAINING_CONTENT_VERSION,
          seed: config.seed,
          tick: 0,
          log: [],
          roomToken: token,
        };
  try {
    window.localStorage.setItem(MATCH_SAVE_KEY, JSON.stringify(payload));
  } catch {
    // The seat works for this page session and the player is told it will not work after a reload,
    // because a seat that silently forgets itself would look exactly like a room that forgot it.
    setSaveFeedback('refused', 'This browser refused to keep the room seat', 'seat-not-persisted');
    return;
  }
  refreshSaveSlot();
  if (mode !== 'remote') {
    setSaveFeedback('idle', 'Local slot · this browser');
  }
};

// Save writes the input of the run as it stands. It reads the snapshot and the log and touches
// nothing else, so saving cannot change the match it saved.
const saveMatch = () => {
  if (replaying) {
    // A log under replay still holds commands the rebuilt run has not reached, so a save taken now
    // would claim entries past its own tick — a payload its own validator would refuse.
    setSaveFeedback('refused', 'The recorded run is being rebuilt · save when the replay finishes', 'save-blocked-during-replay');
    return;
  }
  const payload: MatchSavePayload = {
    schemaVersion: MATCH_SAVE_SCHEMA,
    contentVersion: TRAINING_CONTENT_VERSION,
    seed: config.seed,
    tick: snapshot.tick,
    log: commandLog.map((entry) => ({ tick: entry.tick, command: entry.command })),
    // The seat rides along. Overwriting it with nothing on every save would hand the owner a guest
    // seat the next time this browser loads, which is the one loss a save must never cause.
    ...(sessionSeatToken === null ? {} : { roomToken: sessionSeatToken }),
  };
  try {
    window.localStorage.setItem(MATCH_SAVE_KEY, JSON.stringify(payload));
  } catch {
    setSaveFeedback('refused', 'This browser context refused to write the save slot', 'save-write-failed');
    return;
  }
  refreshSaveSlot();
  setSaveFeedback('saved', `Saved · tick ${payload.tick}`);
};

// Letting a seat go is not something the product offers on purpose: the seat is dropped when the slot
// it lives in is erased, because a New match is the player saying this browser keeps nothing here.
const forgetSeatToken = (): void => {
  sessionSeatToken = null;
  sessionSeatRole = null;
};

// Load is the one restore path, and it is shared: the dock's Load and the entry's Continue are the
// same call, so the entry cannot have grown a restore of its own. It answers whether the run was
// handed to the rebuild, because a refused slot has to leave the player where they were — with the
// reason on screen — instead of closing a surface that just refused to do anything.
const loadMatch = (): boolean => {
  const reading = refreshSaveSlot();
  if (reading.state === 'refused') {
    setSaveFeedback('refused', reading.message, reading.reason);
    return false;
  }
  if (reading.state === 'empty') {
    setSaveFeedback('refused', 'There is no save to load', 'save-slot-missing');
    return false;
  }
  // The slot becomes the log of the run that is about to be rebuilt: the log is the whole input of
  // a match, so this is the one place where a load replaces what the page remembered.
  commandLog.length = 0;
  for (const entry of reading.payload.log) {
    commandLog.push({ tick: entry.tick, appliedTick: null, command: entry.command });
  }
  beginRecordedRun(reading.payload.tick);
  setSaveFeedback('idle', `Rebuilding to tick ${reading.payload.tick}`);
  return true;
};

// New match is a different action from Restart and means something else: the slot goes away and the
// recorded run is not replayed at all, so the next match starts from a preparation of its own.
const newMatch = () => {
  let clearFailure: string | null = null;
  try {
    window.localStorage.removeItem(MATCH_SAVE_KEY);
  } catch {
    clearFailure = 'This browser context refused to clear the save slot';
  }
  forgetSeatToken();
  refreshSaveSlot();
  commandLog.length = 0;
  beginRecordedRun(null);
  setFeedback('idle', 'New match · fresh preparation, nothing recorded');
  setSaveFeedback(
    clearFailure === null ? 'cleared' : 'refused',
    clearFailure ?? 'Slot cleared',
    clearFailure === null ? undefined : 'save-clear-failed',
  );
};

// --- Entry screen ---------------------------------------------------------------------------
// One overlay in the same document, opened on boot and by MENU, and it has exactly three jobs: say
// what there is to continue, offer the two actions that exist, and get out of the way. It is not a
// router and not a second bootstrap — the same `Simulation` and the same slot reading the dock uses
// are behind it, and the shell is `inert` while it is open, so nothing can happen off-screen.
//
// The match clock is stopped while the entry is open, and that is not a pause the player asked for:
// it is the entry being a place where the game is not running. It is also what makes "MENU changes
// nothing" true — the match that comes back is the match that went away, on the same tick — and it
// is why the entry can be read at all while a saved match is being rebuilt behind it.
let entryOpen = true;
let entryFromMenu = false;
let entryArmed = false;

const entryHasSave = (): boolean => slotReading.state !== 'empty';

const entryModeFor = (reading: SaveSlotReading): EntryMode => {
  // The room outranks everything the slot has to say: in a room the local slot describes a different
  // match, so there is nothing for Continue or New match to act on and the entry is a room instead.
  if (mode === 'remote') {
    return 'room';
  }
  // The armed state outranks the slot state, because it describes the button and not the slot: the
  // slot is still exactly where it was while the first press is waiting for a second one.
  if (entryArmed) {
    return 'confirm';
  }
  if (entryFromMenu) {
    return 'live';
  }
  if (reading.state === 'empty') {
    return 'empty';
  }
  return reading.state === 'ready' ? 'slot' : 'unreadable';
};

const entrySlotText = (entryMode: EntryMode, reading: SaveSlotReading): string => {
  if (entryMode === 'live') {
    return `In progress · tick ${snapshot.tick} · ${commandCountLabel(commandLog.length)}`;
  }
  // The armed state describes the button and not the slot, so the line keeps saying what the slot
  // holds: "unreadable" here would be the one case where the copy is worse than the truth.
  if (reading.state === 'ready') {
    return slotStateLabel(reading.payload);
  }
  if (reading.state === 'refused') {
    return 'Save slot unreadable';
  }
  return 'No saved match in this browser';
};

const entryHintText = (entryMode: EntryMode): string => {
  switch (entryMode) {
    case 'room':
      return sessionEntryHint();
    case 'live':
      return 'Menu kept the match and the save where they were. Continue goes back into the match.';
    case 'slot':
      return 'Continue rebuilds the saved match by replaying its commands up to the saved tick.';
    case 'unreadable':
      return 'Continue says why the save cannot be read. New match erases it and starts over.';
    case 'confirm':
      return 'New match erases the save in this browser. Press again to confirm.';
    default:
      return 'New match starts a fresh preparation. Nothing is recorded yet.';
  }
};

const syncEntry = () => {
  // A closed entry reads nothing: the slot is looked at on boot and by the actions that can change
  // it, and an overlay that is not on screen has no reason to hold a second opinion.
  const reading = entryOpen ? refreshSaveSlot() : slotReading;
  const entryMode = entryOpen ? entryModeFor(reading) : 'empty';
  const inRoom = entryMode === 'room';
  entryScreen.hidden = !entryOpen;
  gameShell.inert = entryOpen;
  entryScreen.dataset.entry = entryMode;
  entrySlot.dataset.slotState =
    entryMode === 'live' ? 'live' : reading.state === 'refused' ? 'unreadable' : reading.state === 'ready' ? 'slot' : 'empty';
  // The slot line is the state of the thing Continue acts on. In a room Continue does not act on a slot,
  // so the line is not shown at all rather than shown empty — a room has its own line right below it.
  entrySlot.hidden = inRoom;
  entrySlot.textContent = entryOpen && !inRoom ? entrySlotText(entryMode, reading) : '';
  entryHint.textContent = entryOpen ? entryHintText(entryMode) : '';
  // Continue is offered whenever there is something to continue: a save to rebuild, a match of the
  // player's own to go back into, or a live room to return to. In a room it appears only over a match
  // that is already connected, because that is the one thing the room panel cannot offer — its own
  // button is how a player leaves. A room that is not live is entered from the room panel instead, where
  // the room name is and where the button says Continue when this browser already holds a seat in it;
  // two buttons doing the same thing in one state would be one button with a choice attached.
  const roomResume = inRoom && entryFromMenu && sessionState === 'live';
  entryContinueButton.hidden = !entryOpen || entryMode === 'empty' || (inRoom && !roomResume);
  entryNewMatchButton.hidden = inRoom;
  entryNewMatchButton.dataset.confirm = entryArmed ? 'armed' : 'idle';
  entryNewMatchButton.textContent = entryArmed ? 'Erase the save' : 'New match';
  paintSession();
};

const openEntry = (fromMenu: boolean) => {
  entryFromMenu = fromMenu;
  entryArmed = false;
  entryOpen = true;
  syncEntry();
  // Focus goes to the action that is there, so a keyboard player lands on Continue when there is
  // something to continue and on New match when there is not. A room has its own way in, and its own way
  // back into a connected match, and focus follows whichever of the two is on screen.
  if (mode === 'remote') {
    (entryFromMenu && sessionState === 'live' ? entryContinueButton : entryJoinRoom).focus();
    return;
  }
  (entryContinueButton.hidden ? entryNewMatchButton : entryContinueButton).focus();
};

const closeEntry = () => {
  entryOpen = false;
  entryArmed = false;
  syncEntry();
  // Focus goes back where it came from: MENU returns the player to the button that opened the entry,
  // and the boot entry hands over to the control the next action starts from — which is a build card
  // now, because there is no wave to start and the first thing a player does is spend.
  (entryFromMenu ? menuButton : buildOptions[0]?.button ?? menuButton).focus();
};

// Continue is the same call as the dock's Load, and nothing else. On the boot entry there is no match
// of the player's own yet, so continuing means rebuilding the saved one. From MENU the match is
// still there, so continuing means letting it run again: rebuilding it from the slot would replace a
// match nobody asked to replace, with a copy of one that may be several ticks behind it. In a room it is
// the way back into a match that is already connected, and it touches nothing: the room's clock is not
// this page's to stop or start, and a way in is all this overlay ever is.
const continueFromEntry = () => {
  // In a room, continuing is only ever returning to a match that is already there: the room's clock is
  // not this page's to stop or start, so the way back into it touches nothing at all. From MENU in solo
  // it is the same sentence about a local match.
  if (mode === 'remote' || entryFromMenu) {
    closeEntry();
    return;
  }
  if (!loadMatch()) {
    return;
  }
  closeEntry();
};

// New match is the only irreversible action in the game, so on the entry it asks a second time —
// and only when there is a save to destroy, because that is what the confirmation is for. With
// nothing there to lose the first press is the whole action. The armed press changes the button and
// the copy; it does not touch the slot, the log or the match.
const newMatchFromEntry = () => {
  if (entryHasSave() && !entryArmed) {
    entryArmed = true;
    syncEntry();
    return;
  }
  newMatch();
  closeEntry();
};

entryContinueButton.addEventListener('click', continueFromEntry);
entryNewMatchButton.addEventListener('click', newMatchFromEntry);
// MENU is the way back and it erases nothing: no slot, no log, no core. The match is simply frozen
// behind the overlay and released again by Continue. In a room it freezes nothing at all — the room's
// clock is not this page's to stop — and the entry becomes the room's own panel.
menuButton.addEventListener('click', () => {
  openEntry(true);
});

// --- Session: one client, two owners of the match ----------------------------------------------
// Solo stays the product: the page owns the `Simulation`, ticks it, and everything below is off. A room
// is entered by address — `?room=<name>` — and nothing else turns this page into a client, because a
// mode that turns itself on is a mode a player cannot see. What changes between the two is exactly two
// things: where the snapshot comes from, and where a command goes. The projection, the event path, the
// feedback and the log are the same code in both, which is the only way two phases from now will not
// have two clients that behave differently.
const roomParam = new URLSearchParams(window.location.search).get('room');
// The address names the room; the origin says where rooms live. Both are overridable so a session on
// another machine is a URL rather than a rebuild, and both fall back to the number the protocol module
// declares, which is the same number the server falls back to.
const sessionOrigin = (): string => {
  const override = new URLSearchParams(window.location.search).get('session');
  if (override !== null && override.length > 0) {
    return override.replace(/\/$/, '');
  }
  const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
  return `${window.location.protocol}//${host}:${DEFAULT_SESSION_PORT}`;
};

let mode: 'solo' | 'remote' = isRoomName(roomParam) ? 'remote' : 'solo';
let sessionState: SessionState = mode === 'remote' ? 'idle' : 'local';
let sessionRoomId: string | null = mode === 'remote' ? roomParam : null;
let sessionClientId: string | null = null;
let sessionVersions: VersionStamp | null = null;
let sessionPlayers = 0;
let sessionSeq = 0;
let sessionFrames = 0;
let sessionTickRate = TICK_RATE;
let sessionDeliveryMs: number | null = null;
let sessionRefusal: { reason: string; text: string; found: string | null } | null = null;
let sessionLastCommand: { commandId: number; accepted: boolean; reason: string | null; tick: number } | null = null;
let sessionLastVerb: { verb: RoomVerb; accepted: boolean; reason: string | null; tick: number; role: RoomRole } | null =
  null;
let sessionClosure: RoomClosure | null = null;
let sessionSource: EventSource | null = null;
let forcedHandshake: Partial<HandshakeRequest> | null = null;

// The seat this browser holds in a room, and what that seat may do. The token lives in the page for
// the session and in the save slot across visits; the role is never asked for, never declared and never
// guessed — the room hands it back with every accepted handshake, so a guest cannot talk its way to a
// door it does not own and this page never has to decide who anybody is.
let sessionSeatToken: string | null = null;
let sessionSeatRole: RoomRole | null = null;

// The cost of the current connection, taken on this page's own clock: the handshake exchange, and the
// wait from sending it to the first frame of the stream it opened. Both numbers are page-side on
// purpose — a delay measured from the test process would contain a round-trip between two machines
// that has nothing to do with the room.
let sessionHandshakes = 0;
let sessionReconnects = 0;
let sessionHandshakeMs: number | null = null;
let sessionFirstFrameMs: number | null = null;
let handshakeStartedAt = 0;
let awaitingFirstFrame = false;

// Enough of the recent stream to compare two clients of one room at a sequence number they both saw. A
// client that joined late is missing the frames before its own, so the two logs only overlap from the
// moment of its first frame onwards, and that overlap is the only place a comparison means anything.
//
// The bound is sized for measurement rather than for tidiness: the room sends twenty frames a second, so
// a window of a few hundred is a quarter of a minute of warm client — long enough for a tail to exist at
// all, since a p99 over sixty frames is the p99 of a second and a half.
const FRAME_LOG_LIMIT = 400;
const frameLog: FrameLogEntry[] = [];

const clientCountLabel = (players: number): string => `${players} ${players === 1 ? 'client' : 'clients'}`;

const sessionDetailText = (): string => {
  if (mode === 'solo') {
    return 'Local match · this browser';
  }
  switch (sessionState) {
    case 'idle':
      return 'Not entered';
    case 'connecting':
      return 'Handshake in flight';
    case 'live':
      return `${clientCountLabel(sessionPlayers)} · the room's clock · shared aether`;
    case 'offline':
      return 'Update stream lost · the room keeps running';
    case 'refused':
      return sessionRefusal?.text ?? 'The room refused the handshake';
    default:
      return 'Local match · this browser';
  }
};

const sessionEntryHint = (): string => {
  if (sessionState === 'refused') {
    if (sessionRefusal?.reason === 'room-closed') {
      return 'The owner closed this room and everyone was sent back here. The name is free again, and the next client to enter it opens a new match as its owner.';
    }
    if (sessionRefusal?.reason === 'seat-taken') {
      return 'A later connection presented this seat, so this one has no place in the room. Entering again takes a new seat — and only an owner restarts the run or closes the room.';
    }
    return `The room did not take this client: ${sessionRefusal?.found ?? 'no reason given'}. The versions both sides run are named on the line above.`;
  }
  if (sessionState === 'live') {
    return 'The room owns this match. Aether is shared: the room spends it, so the gold on screen is everyone\'s. Any client may build and start a wave; only the owner restarts the run or closes the room.';
  }
  if (sessionState === 'offline') {
    return 'The update stream stopped. The match has not paused — the room went on without this client, and a room with no clients stands still. Continue goes back in as the same seat and the room comes whole.';
  }
  return 'Name a room to play the same match in two browsers. The page keeps solo as the default.';
};

// One writer for the two surfaces that name the session, so the strip in the top bar and the panel on
// the entry cannot describe two different connections. It is called from `syncEntry` and from the frame
// handler, and it only ever writes the connection's identity — never the tick, which is in the HUD and
// belongs to whoever owns the match.
let paintedSessionState: SessionState | null = null;
let paintedSessionPlayers = -1;
let paintedSessionRoom: string | null = null;

const paintSession = (): void => {
  const room = sessionRoomId;
  if (
    paintedSessionState === sessionState &&
    paintedSessionPlayers === sessionPlayers &&
    paintedSessionRoom === room
  ) {
    return;
  }
  paintedSessionState = sessionState;
  paintedSessionPlayers = sessionPlayers;
  paintedSessionRoom = room;
  sessionStrip.dataset.mode = mode;
  sessionStrip.dataset.state = sessionState;
  sessionStrip.dataset.room = room ?? '';
  sessionStrip.dataset.clients = String(sessionPlayers);
  sessionName.textContent = mode === 'solo' ? 'Solo' : `Room ${room ?? '—'}`;
  sessionDetail.textContent = sessionDetailText();
  entryRoom.dataset.state = sessionState;
  entryRoomLine.textContent = mode === 'solo' ? 'Solo · local match in this browser' : `Room ${room ?? '—'} · ${sessionDetailText()}`;
  // The input shows the room the page is about, which is the room in the address when there is one and
  // an empty field when there is not: typing a name is the whole of choosing a room.
  if (document.activeElement !== entryRoomInput && entryRoomInput.value !== (room ?? '')) {
    entryRoomInput.value = room ?? '';
  }
  const live = sessionState === 'live';
  // One button, and it says what pressing it will do. In a room that is the whole of Continue: going
  // back in as the seat this browser already holds, which is also the reconnect after a dropped
  // stream. Two buttons saying the same thing would be one button with a choice attached.
  if (live) {
    entryJoinRoom.textContent = 'Leave room';
    entryJoinRoom.dataset.action = 'leave';
  } else if (mode === 'solo') {
    entryJoinRoom.textContent = 'Join room';
    entryJoinRoom.dataset.action = 'enter';
  } else {
    const held = sessionSeatToken !== null;
    entryJoinRoom.textContent = held ? 'Continue' : 'Enter room';
    entryJoinRoom.dataset.action = held ? 'continue' : 'enter';
  }
  entryJoinRoom.disabled = !live && !isRoomName(entryRoomInput.value);
  entryJoinRoom.dataset.seat = sessionSeatRole ?? '';
  if (sessionState === 'refused' && sessionRefusal !== null) {
    setSaveFeedback('refused', sessionRefusal.text, sessionRefusal.reason);
  } else if (mode === 'remote') {
    setSaveFeedback('idle', `Room ${room ?? '—'} · the room keeps the state`);
  }
  syncHud();
};

const applySessionFrame = (frame: SessionFrame) => {
  sessionSeq = frame.seq;
  sessionFrames += 1;
  sessionPlayers = frame.players;
  sessionTickRate = frame.tickRate;
  if (frame.versions !== undefined) {
    sessionVersions = frame.versions;
  }
  // The room's log is the room's. In a room this page does not append to it: a command it sends comes
  // back in a frame, with the tick the room sent it on and the tick its core was standing on, so the
  // same `commandPlan` a solo run publishes is a projection here rather than a local guess. A frame that
  // carries the log carries all of it, so the local list is replaced rather than added to — appending a
  // whole log to a whole log would publish six commands for a room that was given three.
  if (frame.commands !== undefined || frame.kind === 'state') {
    commandLog.length = 0;
    for (const entry of frame.commands ?? []) {
      commandLog.push(roomCommandEntry(entry));
    }
  }
  adoptEventCounts(frame.eventCounts);
  if (frame.events.length > 0) {
    eventsDrained += frame.events.length;
    presentEvents(frame.events);
  }
  applySnapshot(frame.snapshot);
  const deliveryMs = Math.max(0, Date.now() - frame.sentAt);
  sessionDeliveryMs = deliveryMs;
  frameLog.push({
    seq: frame.seq,
    kind: frame.kind,
    tick: frame.snapshot.tick,
    gold: frame.snapshot.gold,
    status: frame.snapshot.status,
    players: frame.players,
    commandCount: frame.commandCount,
    eventCounts: { ...frame.eventCounts },
    pads: { ...frame.snapshot.pads },
    at: performance.now(),
    deliveryMs,
  });
  while (frameLog.length > FRAME_LOG_LIMIT) {
    frameLog.shift();
  }
  if (frame.closure !== undefined) {
    // The room ended this connection's place in it — the owner closed the room, or a later connection
    // took the seat. The state that came with the notice is still applied, because it is the last thing
    // the room actually had, and then the session is closed and the entry comes back: a client left
    // showing a match it has been removed from would be showing a fiction, and the reason has to be
    // somewhere the player can read it rather than in a strip that quietly changes colour.
    //
    // The role goes with the place and the token does not. A room that ended has no seats left to be
    // anything in, and a client that still called itself its owner would be reporting a door that is not
    // there. The token is a different matter: it is what this browser holds, and if the same name is
    // opened again the room is the one that decides what that token is worth.
    sessionClosure = frame.closure;
    sessionSeatRole = null;
    closeSession('refused', frame.closure.reason, frame.closure.found);
    openEntry(false);
    return;
  }
  if (frame.kind === 'state') {
    // A `state` frame is the room as a whole, whether it opened a first connection, a late one or a
    // reconnect. In every one of those the run on screen is whatever the room just published, so the
    // client's own bookkeeping about the previous run is dropped here: a command log under replay
    // belongs to a run this client is not replaying, and a terminal report describes a run that ended.
    replaying = false;
    replayIndex = 0;
    terminalReported = false;
    matchReports.length = 0;
    if (awaitingFirstFrame) {
      sessionFirstFrameMs = performance.now() - handshakeStartedAt;
      awaitingFirstFrame = false;
    }
  }
  // The entry stays up until the room has actually said what the match is. Closing it on the strength
  // of a successful handshake would put a local preparation of tick 0 on screen for a frame, which is
  // the one thing this page is not allowed to show about a match it does not own.
  if (frame.kind === 'state' && sessionState === 'connecting') {
    sessionState = 'live';
    setFeedback('idle', `Joined room ${sessionRoomId ?? ''} · tick ${frame.snapshot.tick}`);
    closeEntry();
  }
  paintSession();
};

const roomCommandEntry = (entry: RoomCommand): CommandLogEntry => ({
  tick: entry.tick,
  appliedTick: entry.appliedTick,
  command: entry.command,
});

const closeSession = (state: SessionState, reason: string, found: string | null) => {
  sessionSource?.close();
  sessionSource = null;
  sessionState = state;
  sessionRefusal = reason === '' ? null : { reason, text: SESSION_REFUSAL_TEXT[reason] ?? reason, found };
  syncHud();
  paintSession();
};

const connectToRoom = async (roomId: string) => {
  if (!isRoomName(roomId) || sessionState === 'connecting' || sessionState === 'live') {
    return;
  }
  const origin = sessionOrigin();
  sessionState = 'connecting';
  sessionRoomId = roomId;
  sessionRefusal = null;
  sessionClosure = null;
  sessionClientId = null;
  sessionSeatRole = null;
  sessionPlayers = 0;
  sessionSeq = 0;
  sessionFrames = 0;
  frameLog.length = 0;
  commandLog.length = 0;
  terminalReported = false;
  syncHud();
  paintSession();

  // The handshake is explicit and it happens before the first tick: the client says what it is and the
  // room either agrees or names the number it disagrees about. A room that would take a client on trust
  // could be running rules the client cannot reproduce, and the whole point of `MatchSnapshot` is that
  // what is drawn is what was simulated.
  //
  // The seat goes in the same request, and it is what makes a return a return: a client that holds a
  // token is asking for its own place back, with the role that came with it, rather than for a new seat
  // in someone else's room. There is no second exchange for it and no catch-up to ask for — the frame
  // that opens the stream is the whole room, which is the same thing a late joiner gets.
  const seatClaim = sessionSeatToken;
  const declared: HandshakeRequest = {
    role: 'player',
    protocolVersion: PROTOCOL_VERSION,
    contentVersion: CONTENT_VERSION,
    mapVersion: MAP_VERSION,
    seed: config.seed,
    ...(seatClaim === null ? {} : { seatToken: seatClaim }),
    ...(forcedHandshake ?? {}),
  };
  sessionHandshakes += 1;
  if (seatClaim !== null) {
    sessionReconnects += 1;
  }
  handshakeStartedAt = performance.now();
  awaitingFirstFrame = true;
  let parsed: unknown = null;
  try {
    const response = await fetch(`${origin}/api/rooms/${encodeURIComponent(roomId)}/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(declared),
    });
    parsed = await response.json();
  } catch {
    closeSession('offline', 'session-unreachable', origin);
    return;
  }
  sessionHandshakeMs = performance.now() - handshakeStartedAt;
  const answer = readHandshakeAnswer(parsed);
  if (answer === null) {
    closeSession('refused', 'handshake-shape', 'the answer was not a handshake this build reads');
    return;
  }
  if (!answer.accepted) {
    // The refusal is the room's sentence about the numbers this client sent, and it is shown as it came
    // back. The match does not start, the stream is never opened, and the local core is never touched.
    if (answer.reason === 'seat-shape') {
      // The room would not read the token this browser was offering, so the browser stops offering it.
      // That is not the page deciding anything about seats — the room called it, and the client only
      // forgets what the room named — and without this a token no room would accept would be offered
      // to every room this browser ever entered, forever.
      forgetSeatToken();
    }
    closeSession('refused', answer.reason, answer.found);
    return;
  }
  sessionClientId = answer.clientId;
  sessionVersions = answer.versions;
  sessionTickRate = answer.tickRate;
  if (answer.seatToken !== sessionSeatToken) {
    sessionSeatToken = answer.seatToken;
    persistSeatToken(answer.seatToken);
  }
  sessionSeatRole = answer.seatRole;
  syncHud();
  paintSession();

  const source = new EventSource(`${origin}/api/rooms/${encodeURIComponent(roomId)}/stream?client=${encodeURIComponent(answer.clientId)}`);
  sessionSource = source;
  source.onmessage = (event: MessageEvent<string>) => {
    let raw: unknown = null;
    try {
      raw = JSON.parse(event.data);
    } catch {
      raw = null;
    }
    const frame = readSessionFrame(raw);
    if (frame === null) {
      // A frame this build cannot read is never merged into the match it is presenting. Refusing the
      // whole stream is the honest answer: there is no partial projection of a frame with no meaning.
      closeSession('refused', 'session-frame-unreadable', event.data.slice(0, 120));
      return;
    }
    applySessionFrame(frame);
  };
  source.onerror = () => {
    // No automatic reconnection. A client that quietly starts guessing where it left off is the failure
    // mode this whole phase exists to prevent, and reconnect is a policy rather than a reflex: the seat
    // token is what makes coming back the same player, and a token is only worth anything if the client
    // that offers it is the one that asked. The way back is the entry, where Continue re-enters through
    // the same handshake.
    closeSession('offline', 'stream-refused', sessionRoomId);
    openEntry(false);
  };
};

// The room's own two acts, asked for and never decided here. This is the only door a room verb leaves
// by, and it is the same shape as the command door: an answer that names what the room did, and a
// sentence built out of the room's reason. A guest is refused by the room even if it reaches the route,
// which is what makes the disabled control on screen a description of the rule rather than a substitute
// for it.
const sendRoomVerb = async (verb: RoomVerb): Promise<void> => {
  if (sessionState !== 'live' || sessionClientId === null || sessionRoomId === null) {
    reportRoomVerb(verb, { accepted: false, reason: 'session-not-live' });
    return;
  }
  let parsed: unknown = null;
  try {
    const response = await fetch(`${sessionOrigin()}/api/rooms/${encodeURIComponent(sessionRoomId)}/lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: sessionClientId, verb }),
    });
    parsed = await response.json();
  } catch {
    reportRoomVerb(verb, { accepted: false, reason: 'session-unreachable' });
    return;
  }
  const answer = readLifecycleAnswer(parsed);
  if (answer === null) {
    reportRoomVerb(verb, { accepted: false, reason: 'command-unreadable' });
    return;
  }
  sessionLastVerb = {
    verb: answer.verb,
    accepted: answer.accepted,
    reason: answer.reason ?? null,
    tick: answer.tick,
    role: answer.role,
  };
  reportRoomVerb(answer.verb, answer);
};

const sendRoomCommand = async (command: Command): Promise<void> => {
  if (sessionState !== 'live' || sessionClientId === null || sessionRoomId === null) {
    reportCommandResult(command, { accepted: false, reason: 'session-not-live' });
    return;
  }
  let parsed: unknown = null;
  try {
    const response = await fetch(`${sessionOrigin()}/api/rooms/${encodeURIComponent(sessionRoomId)}/commands`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: sessionClientId, command }),
    });
    parsed = await response.json();
  } catch {
    sessionLastCommand = null;
    reportCommandResult(command, { accepted: false, reason: 'session-unreachable' });
    return;
  }
  const answer = readCommandAnswer(parsed);
  if (answer === null) {
    reportCommandResult(command, { accepted: false, reason: 'command-unreadable' });
    return;
  }
  sessionLastCommand = {
    commandId: answer.commandId,
    accepted: answer.accepted,
    reason: answer.reason ?? null,
    tick: answer.tick,
  };
  // The verdict, the reason and the state it produced all come from the room. Nothing here decides
  // whether the command was allowed, and nothing here applies it.
  reportCommandResult(command, { accepted: answer.accepted, reason: answer.reason });
};

// The one place a command leaves the page. Solo hands the intent to the core this page owns and answers
// in the same task; a room posts it and answers when the room does. Past this line the two are the same
// code, which is what keeps a pad click, Start Wave and a QA injection from growing separate rules.
const submitCommand = (command: Command): CommandResult | null => {
  if (mode === 'remote') {
    void sendRoomCommand(command);
    return null;
  }
  return dispatchPlayerCommand(command);
};

const joinRoomFromEntry = () => {
  if (mode === 'remote' && sessionState === 'live') {
    // Leaving is a navigation, not a teardown: the room keeps its match, and the page that comes back to
    // the same address walks in through the handshake again with the seat it already holds.
    window.location.assign('/');
    return;
  }
  const wanted = entryRoomInput.value.trim().toLowerCase();
  if (!isRoomName(wanted)) {
    return;
  }
  if (mode === 'remote' && wanted === sessionRoomId) {
    // This is the reconnect, and it is the same door as a first entry: one handshake, the seat token
    // this browser holds, and the whole room in the frame that opens the stream. Nothing is asked of
    // the frames that went missing in between, because the room kept none for anybody.
    void connectToRoom(wanted);
    return;
  }
  // A different room is a different address, because the address is what chooses the mode and there is
  // no second source of truth about which match this page is in.
  window.location.assign(`/?room=${encodeURIComponent(wanted)}`);
};

entryJoinRoom.addEventListener('click', joinRoomFromEntry);
entryRoomInput.addEventListener('input', () => {
  entryJoinRoom.disabled = !isRoomName(entryRoomInput.value.trim().toLowerCase());
});
entryRoomInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    joinRoomFromEntry();
  }
});

const sessionReading = (): SessionReading => ({
  mode,
  state: sessionState,
  roomId: sessionRoomId,
  clientId: sessionClientId,
  tickRate: sessionTickRate,
  players: sessionPlayers,
  seq: sessionSeq,
  frames: sessionFrames,
  commandCount: commandLog.length,
  versions: sessionVersions,
  refusal: sessionRefusal,
  lastCommand: sessionLastCommand,
  seatToken: sessionSeatToken,
  seatRole: sessionSeatRole,
  closure: sessionClosure,
  connect: {
    handshakes: sessionHandshakes,
    reconnects: sessionReconnects,
    handshakeMs: sessionHandshakeMs,
    firstFrameMs: sessionFirstFrameMs,
  },
  lastVerb: sessionLastVerb,
  deliveryMs: sessionDeliveryMs,
});

// The tick of the slot has been reached, so the rebuilt run is the saved match and the clock may run
// on. The reading is left to the end of the frame, where the presentation of this tick is in place.
const settleRebuild = () => {
  if (rebuildStopTick === null || snapshot.tick < rebuildStopTick) {
    return;
  }
  pendingRebuild = { requestedTick: rebuildStopTick, tick: snapshot.tick };
  rebuildStopTick = null;
  setSaveFeedback('loaded', `Loaded · tick ${snapshot.tick}`);
  syncHud();
};

// The run as it stands, read on a named tick. Both rebuild readings are this: the slot one adds the
// tick the slot asked for, because a load that stopped on the wrong tick is the failure it exists to
// catch, and a fresh one has no asked-for tick behind it at all.
const readRunState = (tick: number): FreshRunReading => ({
  tick,
  snapshot,
  eventCounts: { ...eventCounts },
  commandCount: commandLog.length,
  replayIndex,
  replaying,
  matchReports: matchReports.map((report) => ({ ...report, eventCounts: { ...report.eventCounts } })),
  poses: towers.poseReadings(),
});

const readRebuildReading = (arrival: { requestedTick: number; tick: number }): RebuildReading => ({
  requestedTick: arrival.requestedTick,
  ...readRunState(arrival.tick),
});

const towerName = (towerId: string) => towerDefinitions.get(towerId)?.name ?? towerId;
const enemyName = (enemyId: string) => enemyDefinitions.get(enemyId)?.name ?? enemyId;

// `towerFired` is represented in the scene by the tower aim-and-flash instead of a log
// line, otherwise the feed would only ever show repeated shots.
const describeEvent = (event: SimulationEvent): string | null => {
  switch (event.type) {
    case 'towerPlaced':
      return `${towerName(event.towerId)} built on ${event.padId}`;
    case 'preparationEnded':
      return `Wave ${event.waveIndex + 1} is landing`;
    case 'waveStarted':
      return `Wave ${event.waveIndex + 1} engaged · +${event.bounty} aether`;
    case 'enemySpawned':
      return `${enemyName(event.enemyId)} inbound`;
    case 'towerFired':
      return null;
    case 'enemyKilled':
      return `Target down · +${event.reward} aether`;
    case 'coreDamaged':
      return `Core hit · -${event.amount} integrity`;
    case 'waveCleared':
      // Not "cleared": with waves on a clock this is the tick the last enemy of that wave walked out of
      // the mouth, and everything it sent is on the map. The bounty was paid when it launched.
      return `Wave ${event.waveIndex + 1} fully on the field · ${event.leaks} leaks`;
    case 'victory':
      return 'Sector secured';
    case 'defeat':
      return 'Core breached';
  }
};

const renderEventFeed = () => {
  eventFeed.replaceChildren(
    ...eventFeedEntries.map((entry) => {
      const item = document.createElement('li');
      item.dataset.eventType = entry.type;
      item.textContent = entry.text;
      return item;
    }),
  );
};

// The three domains that react to a single event, each handed a position rather than a view: the
// tower that fired is asked where its shot runs, the enemy that died where its burst goes, the core
// how long it flashes. Nothing here knows how any of them is drawn.
const applyEventPresentation = (event: SimulationEvent) => {
  if (event.type === 'towerFired') {
    const shot = towers.onFired(event.entityId, enemies.positionOf(event.targetId), elapsed);
    if (shot) {
      combatFx.spawnShotTrace(shot.from, shot.to, elapsed);
    }
    return;
  }
  if (event.type === 'enemyKilled') {
    const position = enemies.positionOf(event.entityId);
    if (position !== null && !reducedMotion) {
      combatFx.spawnCombatBurst(position, elapsed);
    }
  }
};

// The transient half of a batch of events: bounded feed, recent list and the 3D reactions. It runs for
// the events of the update that just arrived and for nothing else, because a frame of history is not
// something to flash at: a kill the room remembers is not a kill this client saw happen.
const presentEvents = (events: readonly SimulationEvent[]): void => {
  if (events.length === 0) {
    return;
  }
  let feedDirty = false;
  for (const event of events) {
    recentEvents.push(event);
    applyEventPresentation(event);
    const text = describeEvent(event);
    if (text === null) {
      continue;
    }
    eventFeedEntries.unshift({ type: event.type, text });
    feedDirty = true;
  }
  if (recentEvents.length > RECENT_EVENT_LIMIT) {
    recentEvents.splice(0, recentEvents.length - RECENT_EVENT_LIMIT);
  }
  if (eventFeedEntries.length > EVENT_FEED_LIMIT) {
    eventFeedEntries.length = EVENT_FEED_LIMIT;
  }
  if (feedDirty) {
    renderEventFeed();
  }
};

// Counting is separated from presenting because the running totals belong to whoever owns the match. In
// solo that is this page, and the core's drain is the truth. In a room it is the room, and the totals
// arrive with every frame — which is also what lets a client that joined late report the same numbers as
// one that was there from the first tick, instead of counting from whatever it happened to witness.
const consumeLocalEvents = (): number => {
  const drained = simulation.drainEvents();
  if (drained.length === 0) {
    return 0;
  }
  for (const event of drained) {
    eventCounts[event.type] += 1;
  }
  presentEvents(drained);
  return drained.length;
};

const adoptEventCounts = (counts: Readonly<EventTally>): void => {
  for (const type of EVENT_TYPES) {
    eventCounts[type] = counts[type] ?? 0;
  }
};

const PAD_PICK_HEIGHT = 0.19;
const padRaycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const projectedPad = new THREE.Vector3();

// Picking a cell, not a mesh.
//
// The board has 2 192 spots and the map answers "what is at this cell" exactly, so the pick is the
// same arithmetic run backwards: a ray from the camera meets the plate, the meeting point becomes a
// cell, and the cell becomes a spot name. There is no mesh to hit and no radius to guess with, which
// is the whole reason this is a different implementation rather than the old picker with a new list —
// a guess only agrees with the picture while the camera stands still, and this camera is turned by
// hand.
//
// The plate has three heights and the cursor can be over any of them, so the pick is a walk over three
// planes rather than one. It has to be, and the reason is the order the ray meets them: the camera looks
// down and forward, so along one ray the ray crosses the highest surface first, then the middle, then
// the lowest, and the first crossing whose cell is *of that kind* is the surface the player is looking
// at. A single plane cannot answer that — it answers for the ground it was built at and is wrong by the
// height of whatever is between the cursor and that ground, which on this plate is half a cell of road
// and would put a click on the road edge into the free cell behind it.
const groundHit = new THREE.Vector3();

// Highest first, because that is the order the ray meets them. Read from the map's own three heights
// rather than from a list written here, so a skin that moved a surface moved the picker with it.
const pickSurfaces = (Object.entries(mapPresentation.surfaceHeights) as Array<[CellKind, number]>)
  .sort((a, b) => b[1] - a[1])
  .map(([kind, height]) => ({ kind, plane: new THREE.Plane(new THREE.Vector3(0, 1, 0), -height) }));

/** The cell under the cursor, or null when the click misses the plate or lands off its edge. */
const pickCell = (clientX: number, clientY: number): MapCell | null => {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  padRaycaster.setFromCamera(pointerNdc, camera);
  // The first crossing that lands on a cell of the kind that crossing is the surface of. A crossing that
  // lands on some other kind is not a miss to give up on — it is a nearer surface of another height in
  // the way, and the walk continues past it to the one the player can actually see.
  for (const surface of pickSurfaces) {
    const met = padRaycaster.ray.intersectPlane(surface.plane, groundHit);
    if (met === null) {
      continue;
    }
    const cell = mapPresentation.cellAtWorld(met.x, met.z);
    if (cell !== null && grid.kindAt(cell) === surface.kind) {
      return cell;
    }
  }
  // Nothing along the ray sits on its own surface, which means the cursor is over a cell whose kind and
  // height disagree — only reachable if the ground moved after this list was built. The free ground is
  // the answer that matches every arrangement the picker has ever had, so it is the fallback rather than
  // a null: refusing every click would be worse than one cell of slack in an impossible case.
  const fallback = padRaycaster.ray.intersectPlane(pickSurfaces[pickSurfaces.length - 1]?.plane ?? new THREE.Plane(new THREE.Vector3(0, 1, 0), -mapPresentation.groundHeight), groundHit);
  return fallback === null ? null : mapPresentation.cellAtWorld(fallback.x, fallback.z);
};

/**
 * Which spot a click names.
 *
 * A tower occupies four by four cells and stands in the middle of them, so a click inside a square
 * should build in that square — not in the square that starts at the cell the cursor happens to be
 * over. The two differ: the cell under the cursor is the anchor's cell or one of its neighbours, and
 * resolving by anchor alone would put a tower a cell or two from where the player aimed, which on a
 * plate covered in buildable ground means aiming at a spot and being refused for standing half in the
 * road.
 *
 * Squares overlap, so a cell can sit inside more than one of them. The map decided which one owns it,
 * once, when it read the grid — this asks that decision rather than making a second one, and a second
 * one is how a picker and a picture stop agreeing about the same ground.
 *
 * A cell inside no declared square is named by its own anchor. That is not a special case — it is the
 * same name the cell would have had, and the core refuses it with the reason: road, ground already
 * taken, or a square that is not all free. Three different answers, from the cells rather than from a
 * list of places.
 */
const pickPad = (clientX: number, clientY: number): string | null => {
  const cell = pickCell(clientX, clientY);
  if (cell === null) {
    return null;
  }
  return spotIdForCell(mapPresentation.spotAtCell(cell) ?? cell);
};

const projectPadToCanvas = (padId: string): { padId: string; x: number; y: number } | null => {
  const pad = padDefinitions.get(padId);
  if (!pad) {
    return null;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  projectedPad.set(pad.position.x, PAD_PICK_HEIGHT, pad.position.z).project(camera);
  return {
    padId: pad.id,
    x: ((projectedPad.x + 1) / 2) * rect.width,
    y: ((1 - projectedPad.y) / 2) * rect.height,
  };
};

// Camera gestures, and the one rule that keeps them from eating placements: a pointer that travels
// further than the slop was a drag, so the placement only fires for a press that stayed put. Left drag
// is the orbit again — the turn and the pitch, the two things a player reaches for before anything else
// — and it does not take the click away, because a click is a press that stayed put and a drag is a
// press that did not. Right drag slides the stand, the wheel changes the lens, held keys walk it, and R
// puts it back. Every one of them ends up in `cameraRig` and one function applies it — there is no
// second copy of the view.
type CameraGesture = 'orbit' | 'pan' | null;

let cameraGesture: CameraGesture = null;
let cameraGestureMoved = false;
let gestureStartX = 0;
let gestureStartY = 0;
let gestureTargetX = 0;
let gestureTargetZ = 0;
let gestureAzimuth = 0;
let gestureElevation = CAMERA_ELEVATION;

const applyCameraGesture = (event: PointerEvent): void => {
  const deltaX = event.clientX - gestureStartX;
  const deltaY = event.clientY - gestureStartY;
  if (Math.hypot(deltaX, deltaY) > CAMERA_CLICK_SLOP_PX) {
    cameraGestureMoved = true;
  }
  if (cameraGesture === 'orbit') {
    // Written from the press, not accumulated per move event: a gesture is one turn from where it
    // began, so a pointer that comes back to where it started has turned the stand nowhere, and a
    // browser that coalesces or drops a move cannot leave the view a quarter turn off from the
    // player's hand. The pitch is clamped into the band the reach and the fog are stated for, and the
    // azimuth is not clamped at all: this map has nothing to hide from any side of it, and a turn that
    // stops at a wall is a turn the player has to fight.
    cameraRig.azimuth = gestureAzimuth + deltaX * CAMERA_ORBIT_DEGREES_PER_PIXEL * DEGREES;
    cameraRig.elevation = Math.min(
      CAMERA_ELEVATION_MAX,
      Math.max(
        CAMERA_ELEVATION_MIN,
        gestureElevation - deltaY * CAMERA_PITCH_DEGREES_PER_PIXEL * DEGREES,
      ),
    );
  }
  if (cameraGesture === 'pan') {
    // Pan is in the ground plane, so the pointer's pixels have to become world units through the
    // camera's own basis: a fixed number per pixel would move the map twice as fast at one zoom as at
    // another, and in the wrong direction at some azimuths.
    const unitsPerPixel = (camera.right - camera.left) / Math.max(1, renderer.domElement.clientWidth);
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    cameraRig.targetX = gestureTargetX - (right.x * deltaX - up.x * deltaY) * unitsPerPixel;
    cameraRig.targetZ = gestureTargetZ - (right.z * deltaX - up.z * deltaY) * unitsPerPixel;
  }
  if (cameraGestureMoved) {
    applyCameraRig();
  }
};

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 && event.button !== 2) {
    return;
  }
  // Both buttons start a gesture, and the slop above is what separates them from a placement: a left
  // press that stays put builds, a left press that travels turns the stand, and nothing in between.
  cameraGesture = event.button === 0 ? 'orbit' : 'pan';
  cameraGestureMoved = false;
  gestureStartX = event.clientX;
  gestureStartY = event.clientY;
  gestureTargetX = cameraRig.targetX;
  gestureTargetZ = cameraRig.targetZ;
  gestureAzimuth = cameraRig.azimuth;
  gestureElevation = cameraRig.elevation;
  try {
    // Capture keeps a drag alive when the pointer leaves the canvas, which a full turn across a
    // ninety-six unit board will do. A pointer id that was never really down has nothing to capture,
    // and that is not a reason to drop the gesture.
    renderer.domElement.setPointerCapture(event.pointerId);
  } catch {
    // A pointer id that was never really down has nothing to capture, and that is not a reason to
    // drop the gesture.
  }
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (cameraGesture === null) {
    return;
  }
  applyCameraGesture(event);
});

const endCameraGesture = (event: PointerEvent): void => {
  if (cameraGesture === null) {
    return;
  }
  cameraGesture = null;
  if (renderer.domElement.hasPointerCapture(event.pointerId)) {
    renderer.domElement.releasePointerCapture(event.pointerId);
  }
};

renderer.domElement.addEventListener('pointerup', endCameraGesture);
renderer.domElement.addEventListener('pointercancel', endCameraGesture);
// A right drag is a camera gesture, not a request for the browser's menu, and the menu would sit
// exactly where the player is trying to look.
renderer.domElement.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

renderer.domElement.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    // Scaled by the delta, not by its sign: a trackpad and a notched wheel report different amounts
    // per notch, and both should feel like the same zoom per notch. Capped per event so one violent
    // flick cannot jump the whole range — and the range is the whole point here, from a tower filling
    // the screen to the entire vault, so a cap of a third of a unit of view per flick is the only
    // thing standing between a player and a full crossing in two notches.
    const step = Math.max(-0.12, Math.min(0.12, event.deltaY * 0.0006));
    cameraRig.zoom = Math.min(cameraMaxZoom(), Math.max(cameraMinZoom(), cameraRig.zoom * Math.exp(step)));
    applyCameraRig();
  },
  { passive: false },
);

// Held keys walk the stand. The state is a set of pressed codes and nothing else: a key's own
// up/down pair has to be visible here or a key held while the pointer left the canvas would keep
// walking forever, and the target is written from here into the same rig the drag writes into.
const heldCameraKeys = new Set<string>();
const isTextEntry = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(
    element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable),
  );
};

window.addEventListener('keydown', (event) => {
  if (isTextEntry(event.target)) {
    return;
  }
  if (event.key === 'r' || event.key === 'R' || event.key === 'к' || event.key === 'К') {
    resetCamera();
    return;
  }
  if (event.code in CAMERA_KEYS) {
    heldCameraKeys.add(event.code);
    // The page scrolls under four arrow keys otherwise, which on a map this size means the stand
    // walks and the document moves with it.
    event.preventDefault();
  }
});

window.addEventListener('keyup', (event) => {
  heldCameraKeys.delete(event.code);
});

// A lost focus is a released key. Anything that took the window — a dialog, another tab, a minimap
// drag that escaped the canvas — leaves the set holding a code nobody will ever press again, and the
// stand walks off the map with the match paused.
window.addEventListener('blur', () => {
  heldCameraKeys.clear();
});

// A click on the minimap is a camera command and nothing else: it does not place, it does not select
// and it does not reach the core. It is handled on the canvas rather than through the pad picker on
// purpose — a click that both moved the view and built a tower would make the minimap a build menu.
minimapCanvas?.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  event.stopPropagation();
  if (!minimap) {
    return;
  }
  const point = minimap.worldAt(event.clientX, event.clientY);
  if (!point) {
    return;
  }
  cameraRig.targetX = point.x;
  cameraRig.targetZ = point.z;
  applyCameraRig();
});

const applyHeldCameraKeys = (deltaSeconds: number): void => {
  if (heldCameraKeys.size === 0 || deltaSeconds <= 0) {
    return;
  }
  let alongX = 0;
  let alongZ = 0;
  for (const code of heldCameraKeys) {
    const direction = CAMERA_KEYS[code as keyof typeof CAMERA_KEYS];
    if (!direction) {
      continue;
    }
    alongX += direction[0];
    alongZ += direction[1];
  }
  if (alongX === 0 && alongZ === 0) {
    return;
  }
  const length = Math.hypot(alongX, alongZ) || 1;
  // Ground units, not screen units: the view is tilted, so a unit of world z is more than a unit of
  // screen height and a key that moved at the screen's rate would outrun the same key on x.
  const groundReachZ = viewHalfHeight() / Math.max(0.2, Math.cos(cameraRig.elevation));
  const perSecond = viewHalfHeight() * CAMERA_KEY_PAN_PER_VIEW;
  cameraRig.targetX += (alongX / length) * perSecond * deltaSeconds;
  cameraRig.targetZ += (alongZ / length) * groundReachZ * CAMERA_KEY_PAN_PER_VIEW * deltaSeconds;
  applyCameraRig();
};

// The last cell a click resolved to, and how it got there. Published because the picker's answer is a
// claim about where the cursor is, and a claim about input has to be checkable by number: the seam can
// say "this click named cell 47, 44" without the page having to build something for the claim to be
// visible. It is a reading of the last click and holds no state of its own beyond that.
let lastPick: {
  screen: { x: number; y: number };
  cell: { x: number; y: number } | null;
  spotId: string | null;
  /** The square that held the cell, or null when the cell is inside no declared square. */
  anchor: { x: number; y: number } | null;
} | null = null;

// A pad click is the only way a player starts anything: a wave starts on its own clock, in the core.
// There is no second path and no mode that builds locally.
const attemptPlacement = (padId: string) => {
  submitCommand({ type: 'placeTower', padId, towerId: selectedTowerId });
};

renderer.domElement.addEventListener('click', (event) => {
  if (cameraGestureMoved) {
    // The press that became a drag already moved the camera; placing on the way up would be a tower
    // the player never aimed at.
    cameraGestureMoved = false;
    return;
  }
  // The cell is read before the pick, so a click that resolves to nothing — off the plate, or a miss —
  // still records which cell the cursor was over rather than nothing at all. A reading that says null
  // because the click missed cannot be told apart from a reading that was never taken.
  const cell = pickCell(event.clientX, event.clientY);
  const padId = cell === null ? null : pickPad(event.clientX, event.clientY);
  lastPick = {
    screen: { x: event.clientX, y: event.clientY },
    cell,
    spotId: padId,
    anchor: cell === null ? null : mapPresentation.spotAtCell(cell),
  };
  if (padId) {
    attemptPlacement(padId);
  }
});

// Pause is a clock control only: commands still reach the core, but `step()` does not
// run, so the snapshot, the projection and the rendered positions stay frozen. The clock is
// marked here, inside the click, because the tick a resume starts from is a property of the page
// and not of when the test process is told the click happened.
const setPaused = (next: boolean) => {
  paused = next;
  markClock(next ? 'pause' : 'resume');
  syncHud();
};

pauseToggle.addEventListener('click', () => {
  setPaused(!paused);
});
restartButton.addEventListener('click', restartMatch);
endRoomButton.addEventListener('click', endRoom);
saveButton.addEventListener('click', saveMatch);
loadButton.addEventListener('click', () => {
  loadMatch();
});
newMatchButton.addEventListener('click', newMatch);
reducedMotionQuery.addEventListener('change', (event) => {
  reducedMotion = event.matches;
  // Each domain is told on the same tick the page is, and the towers own the one thing that has more
  // to it than a flag: turning reduced motion on mid-match has to do the same thing it does from the
  // start, so the clip stops and the bones go back to the rest pose instead of freezing wherever the
  // last frame left them. Reading the pose from `setTime(0)` before the action stops is what applies it.
  enemies.setReducedMotion(reducedMotion);
  towers.setReducedMotion(reducedMotion);
});

syncSelection();
// The speed control is painted by the same function that repaints it on a press, so the state the page
// opens with is the state the product says it is in and not a value left in the markup.
syncSpeed();
setFeedback('idle', 'Left click free ground to place a tower');
applySnapshot(snapshot);
// The page opens on the entry screen rather than in a preparation: the slot is looked at, never
// loaded, and the match behind the overlay is a fresh preparation of tick 0 that the player has not
// asked for yet. Nothing runs until an action on the entry says so.
setSaveFeedback('idle', mode === 'remote' ? `Room ${sessionRoomId ?? ''} · the room keeps the state` : 'Local slot · this browser');
// The seat this browser already holds, offered back out of the one artifact it keeps, and adopted once
// while the page holds no seat of its own. The reading comes from the same reader the dock and the
// entry use, so there is no second opinion about what is in the slot.
const bootSlot = refreshSaveSlot();
if (sessionSeatToken === null) {
  sessionSeatToken = bootSlot.roomToken;
}
// The controls that act on a local `Simulation` say so in a room instead of sitting there inert with a
// solo tooltip. A disabled button with the wrong explanation is worse than no button, because it tells
// the reader what the control would have done. Restart and End room are not in this list: they are room
// verbs, and what stands in their way there is the seat, which `syncRoomControlHints` names.
if (mode === 'remote') {
  pauseToggle.title = 'The room owns the clock in a room; there is nothing here to pause';
  for (const button of speedButtons) {
    button.disabled = true;
    button.title = 'The room owns the clock in a room; there is nothing here to speed up';
  }
  saveButton.title = 'A room match is not written into this browser';
  loadButton.title = 'A room match is not read from this browser';
  newMatchButton.title = 'Leave the room from the entry to play a match of your own';
}
openEntry(false);
void bootAssets();

let accumulator = 0;
let previousTimestamp = performance.now();

// The frame clock. `MAX_FRAME_SECONDS` is the product's clamp: a stall longer than this is dropped
// rather than fast-forwarded, and it is also the largest number of ticks one frame may ever step.
const MAX_FRAME_SECONDS = 0.25;

// QA clock seam. While a delta is armed every frame is charged exactly that many seconds instead of
// its own, and it goes through the same clamp a real frame does, so a test can only ask for a frame
// the product would really produce. Because the armed value divides the tick exactly, the ticks of
// the run are a function of the armed delta and not of when the browser got around to drawing: that
// is what lets a test place a multi-tick frame across a recorded command's tick on purpose instead
// of waiting for machine load to produce one by luck.
let forcedFrameDelta: number | null = null;

// How many frames this page has drawn. It exists for one claim: that a remote client whose stream
// stopped is a live page with a stopped match, and not a page that froze. Without a counter that keeps
// moving, "the tick stood still" and "the browser died" look the same from outside.
let framesRendered = 0;

const readFrameDelta = (timestamp: number): number => {
  const measured = (timestamp - previousTimestamp) / 1000;
  previousTimestamp = timestamp;
  return Math.min(forcedFrameDelta ?? measured, MAX_FRAME_SECONDS);
};

// Clock readings are taken where the thing happened, not where a test happens to look. `tick` is the
// match tick and `at` is the page's own clock, so a duration measured from two marks contains no
// round-trip between the test process and the page.
const clockMarks: ClockMark[] = [];

const markClock = (label: string) => {
  clockMarks.push({
    label,
    tick: snapshot.tick,
    waveTick: snapshot.waveTick,
    at: performance.now(),
    accumulator,
    paused,
  });
};

// Draw calls, drawn triangles and compiled programs are read straight after `render()`, because
// `renderer.info` is reset by every render call: read anywhere else it would report the previous
// frame. The reading is only re-checked when a number actually moves, so the scene budget costs
// nothing per frame and the status line is not rewritten on every tick.
let lastSceneCounters: SceneReading | null = null;

const sampleSceneBudget = () => {
  const counters = {
    drawCalls: renderer.info.render.calls,
    renderedTriangles: renderer.info.render.triangles,
    shaderPrograms: renderer.info.programs?.length ?? 0,
    assetLoadMs: 0,
  };
  const previous = lastSceneCounters;
  if (
    previous &&
    previous.drawCalls === counters.drawCalls &&
    previous.renderedTriangles === counters.renderedTriangles &&
    previous.shaderPrograms === counters.shaderPrograms
  ) {
    return;
  }
  lastSceneCounters = counters;
  assetRegistry.recordSceneCounters(counters);
  const reading = assetRegistry.sceneReading;
  if (!reading) {
    // The registry is still loading, so the load time is unknown and the budget would pass on a
    // half-measured load. It is checked again as soon as the load finishes.
    return;
  }
  const failures = checkSceneBudget(reading);
  assetRegistry.markCheckPerformed('sceneBudget');
  const changed =
    failures.length !== sceneBudgetFailures.length ||
    failures.some((failure, index) => failure.reason !== sceneBudgetFailures[index]?.reason);
  sceneBudgetFailures = failures;
  // The diagnostics block follows the measurement, not the verdict: without this the block could
  // keep an older reading while the seam already publishes a newer one, and a test comparing the
  // two would be comparing two moments. The game line is rewritten only when the verdict changes.
  paintDevDiagnostics();
  if (changed) {
    applyAssetStatus();
  }
};

window.__ECHOES_DEBUG__ = {
  ready: true,
  renderer: 'Three.js WebGL',
  camera: 'orthographic',
  seed: config.seed,
  tickRate: TICK_RATE,
  mapId: config.map.id,
  routeIds: config.map.routes.map((route) => route.id),
  padIds: config.map.buildPads.map((pad) => pad.id),
  waveCount,
  get eventsDrained() {
    return eventsDrained;
  },
  get snapshot() {
    return snapshot;
  },
  get selectedTowerId() {
    return selectedTowerId;
  },
  get feedback() {
    return {
      state: feedbackState,
      message: commandFeedback.textContent ?? '',
      reason: commandFeedback.getAttribute('data-reason'),
    };
  },
  get objectCount() {
    return scene.children.length;
  },
  get rendered() {
    return {
      pads: mapPresentation.padCount(),
      towers: towers.viewCount(),
      enemies: enemies.viewCount(),
      routeSegments: mapPresentation.routeSegmentCount,
    };
  },
  get towerPositions() {
    return towers.positions();
  },
  get enemyPositions() {
    return enemies.positions();
  },
  get padScreenPositions() {
    return config.map.buildPads
      .map((pad) => projectPadToCanvas(pad.id))
      .filter((point): point is { padId: string; x: number; y: number } => point !== null);
  },
  get mapGeometry(): MapGeometryReading {
    return {
      roadHalfWidth: mapPresentation.roadHalfWidth,
      chamberRadius: mapPresentation.roadHalfWidth,
      routeLength: Math.round(mapPresentation.routeLength * 100) / 100,
      routeSegments: mapPresentation.routeSegmentCount,
      bends: config.map.routes.reduce((total, route) => total + Math.max(0, route.points.length - 2), 0),
      // Three readings that are zero or absent on this map and are kept because the seam is a
      // contract the scenarios read. The rock is gone, so there are no wall blocks; the niches went
      // with it, so there are no bays and nothing for a pad to sit in. `openCells` is the free-cell
      // count, which is what it always meant тАФ the cells a tower may stand on тАФ and it now has a
      // source: the grid.
      bays: 0,
      wallBlocks: 0,
      openCells: mapPresentation.gridCells.free,
      cells: { grid: mapPresentation.gridCells, painted: mapPresentation.paintedCells },
      coreCell: mapPresentation.coreCell,
      routes: mapPresentation.routeReadings,
      map: {
        id: config.map.id,
        name: trainingPlan().grid.name,
        version: trainingPlan().grid.version,
        loaded: true,
        refusalClasses: MAP_FILE_REFUSAL_CLASSES,
      },
      frame: {
        left: camera.left,
        right: camera.right,
        top: camera.top,
        bottom: camera.bottom,
        aspect: (camera.right - camera.left) / (camera.top - camera.bottom),
      },
      fit: {
        ...measureCorridor(),
        fitHalfHeight: viewHalfHeight(),
        canvasAspect:
          (renderer.domElement.clientWidth || 1) / (renderer.domElement.clientHeight || 1),
      },
      rig: { ...cameraRig },
      // The camera as a lens rather than as a multiplier, because the range is now the feature: the
      // 13.8-pixel husk the map used to be stuck at is a function of what the frustum holds, and the
      // only honest way to say the player can drive past it is to publish both ends in pixels.
      view: {
        halfHeight: viewHalfHeight(),
        minView: CAMERA_MIN_VIEW,
        maxView: cameraMaxView,
        pixelsPerUnit:
          (renderer.domElement.clientHeight || 1) / (2 * viewHalfHeight()),
        minPixelsPerUnit: (renderer.domElement.clientHeight || 1) / (2 * cameraMaxView),
        maxPixelsPerUnit: (renderer.domElement.clientHeight || 1) / (2 * CAMERA_MIN_VIEW),
      },
      minimap: {
        present: minimap !== null,
        // A click is proven by moving the rig, so the reading that matters is the target before and
        // after тАФ the seam cannot see the click, the test can.
        unit: minimap ? Math.round(minimap.scale() * 1000) / 1000 : 0,
        enemies: snapshot.enemies.length,
        towers: snapshot.towers.length,
      },
      // A click names the cell it lands on, so "pickable" is decided by asking the picker whether a
      // click at that spot's own screen position comes back with that spot's own name. It is the same
      // question the real click asks, asked of the same function тАФ not a second opinion about what is
      // visible, which is how a picker and a picture drift apart.
      picks: spotSample.map((spot) => {
        const padId = spotIdForCell(spot);
        const point = projectPadToCanvas(padId);
        const rect = renderer.domElement.getBoundingClientRect();
        if (!point) {
          return { padId, pickable: false, blocker: 'off-screen', onScreen: false };
        }
        const onScreen = point.x >= 0 && point.x <= rect.width && point.y >= 0 && point.y <= rect.height;
        const hitPadId = onScreen ? pickPad(rect.left + point.x, rect.top + point.y) : null;
        return {
          padId,
          pickable: hitPadId === padId,
          blocker: hitPadId === padId ? null : hitPadId ?? 'off-screen',
          onScreen,
        };
      }),
      picksSampled: spotSample.length,
      picksTotal: mapPresentation.spots.length,
      coreEndsRoute: config.map.routes.every((route) => {
        const last = route.points[route.points.length - 1];
        return last.x === config.map.corePosition.x && last.z === config.map.corePosition.z;
      }),
      pads: spotSample.map((spot) => {
        const position = spotCenter(trainingGrid(), spot);
        const coverage: Record<string, number> = {};
        const routeCoverage: Record<string, number> = {};
        for (const tower of config.towers) {
          coverage[tower.id] = mapPresentation.roadCoverage(position.x, position.z, tower.range);
          routeCoverage[tower.id] = mapPresentation.routeCoverage(position.x, position.z, tower.range);
        }
        const roadDistance = Math.round(mapPresentation.distanceToRoad(position.x, position.z) * 100) / 100;
        return {
          padId: spotIdForCell(spot),
          x: position.x,
          z: position.z,
          roadDistance,
          clearOfRoad: roadDistance > mapPresentation.roadHalfWidth + 0.5,
          coverage,
          routeCoverage,
        };
      }),
      spotSurvey,
      cellAtCanvas: (canvasX: number, canvasY: number) => {
        const rect = renderer.domElement.getBoundingClientRect();
        const cell = pickCell(rect.left + canvasX, rect.top + canvasY);
        return {
          cell,
          kind: cell === null ? null : grid.kindAt(cell),
          spotId: cell === null ? null : spotIdForCell(mapPresentation.spotAtCell(cell) ?? cell),
          anchor: cell === null ? null : mapPresentation.spotAtCell(cell),
        };
      },
      spotProbe: (padId: string) => {
        const cell = cellForSpotId(padId);
        if (cell === null) {
          return null;
        }
        const position = spotCenter(trainingGrid(), cell);
        const coverage: Record<string, number> = {};
        const routeCoverage: Record<string, number> = {};
        for (const tower of config.towers) {
          coverage[tower.id] = mapPresentation.roadCoverage(position.x, position.z, tower.range);
          routeCoverage[tower.id] = mapPresentation.routeCoverage(position.x, position.z, tower.range);
        }
        return {
          padId,
          cell,
          buildable: checkSpot(trainingGrid(), cell).allowed,
          coverage,
          routeCoverage,
          roadDistance: Math.round(mapPresentation.distanceToRoad(position.x, position.z) * 100) / 100,
        };
      },
    };
  },
  get skin(): SkinReading {
    return {
      version: skin.version,
      name: skin.name,
      cellSize: skin.cellSize,
      fingerprint: skin.map.fingerprint,
      plateWidth: skin.map.width,
      plateHeight: skin.map.height,
      relief: skin.relief,
      reliefAsWritten: skin.reliefAsWritten,
      heights: mapPresentation.surfaceHeights,
      palette: {
        free: skin.ground.free,
        road: skin.ground.road,
        occupied: skin.ground.occupied,
      },
      openRules: splitRules(skin).open.map((rule) => rule.id),
      occupiedRulesLeftOut: splitRules(skin).occupied.map((rule) => rule.id),
      tiles: skin.tiles.length,
      fog: { near: FOG_NEAR_OFFSET, far: FOG_FAR_OFFSET, color: sky.fog },
      sun: { dir: sky.sunDir, intensity: sky.sunI, color: sky.sun },
      exposure: sky.exposure,
      waterDrawn: false,
    };
  },
  get terrain(): TerrainReadings {
    return mapPresentation.terrain;
  },
  get props(): PropsReadings | null {
    return propsReadings;
  },
  get lastPick() {
    return lastPick === null ? null : { ...lastPick, cell: lastPick.cell && { ...lastPick.cell }, anchor: lastPick.anchor && { ...lastPick.anchor } };
  },
  get eventCounts() {
    return { ...eventCounts };
  },
  get recentEvents() {
    return [...recentEvents];
  },
  get paused() {
    return paused;
  },
  get reducedMotion() {
    return reducedMotion;
  },
  get replaying() {
    return replaying;
  },
  get replayIndex() {
    return replayIndex;
  },
  get commandCount() {
    return commandLog.length;
  },
  get frameDelta() {
    return forcedFrameDelta;
  },
  // The clock the player is driving, next to the tick rate it is not changing. Both readings are here
  // because the claim "the multiplier does not touch the simulation" is only checkable if a test can
  // see which multiplier was in force and what the core's own rate still is.
  get speed() {
    return gameSpeed;
  },
  speedSteps: [...SPEED_STEPS],
  forceFrameDelta(seconds: number | null) {
    forcedFrameDelta = seconds === null ? null : Math.max(0, seconds);
  },
  get commandPlan() {
    return commandLog.map((entry) => ({ ...entry }));
  },
  get clockMarks() {
    return clockMarks.map((mark) => ({ ...mark }));
  },
  markClock,
  get session() {
    return sessionReading();
  },
  get frameLog() {
    return frameLog.map((entry) => ({ ...entry, eventCounts: { ...entry.eventCounts }, pads: { ...entry.pads } }));
  },
  forceHandshake(overrides) {
    forcedHandshake = overrides;
  },
  breakStream() {
    if (sessionSource === null) {
      return;
    }
    // Exactly the path a lost connection takes, and nothing more: the same `closeSession`, the same
    // `offline`, the same entry coming back with the way in. A test that patched the transport instead
    // would be testing the patch, so the seam opens the same door the network opens.
    closeSession('offline', 'stream-refused', sessionRoomId);
    openEntry(false);
  },
  get frames() {
    return framesRendered;
  },
  get matchReports() {
    return matchReports.map((report) => ({ ...report, eventCounts: { ...report.eventCounts } }));
  },
  get lastRebuild() {
    return lastRebuild;
  },
  get lastFreshRun() {
    return lastFreshRun;
  },
  get entry() {
    return {
      open: entryOpen,
      mode: entryOpen ? entryModeFor(slotReading) : 'empty',
      armed: entryArmed,
      // What the Continue button will do, named rather than inferred: restoring the slot or going
      // back into the match the player left running. `null` when there is no Continue to press.
      continuing: entryOpen && !entryContinueButton.hidden ? (entryFromMenu ? ('match' as const) : ('slot' as const)) : null,
    };
  },
  get motion() {
    return {
      reducedMotion,
      combatBursts: combatFx.liveBursts(),
      // Shots drawn right now, and shots drawn since boot. The live count is what a screenshot can
      // never prove — a trace lives a fraction of a second — so the total is what says a tower is
      // actually firing something, and it grows on the same `towerFired` event the core reports.
      shotTraces: combatFx.liveTraces(),
      shotsFired: combatFx.tracesFired(),
      enemyBob: enemies.bobOffset(),
      // One mixer per animated view and no more: a tower that was removed or upgraded in place must
      // not leave a second animation running against the same skeleton.
      ...towers.clipMotion(),
    };
  },
  get assets() {
    return { status: assetRegistry.status, models: assetRegistry.modelIds, error: assetRegistry.error };
  },
  get probe() {
    const materials = readProbeMaterials();
    return {
      environment: scene.environment !== null,
      materials,
      undeclared: materials.filter((entry) => !entry.explicit).length,
    };
  },
  get assetBudgets() {
    return {
      budgets: { model: MODEL_BUDGET, registry: REGISTRY_BUDGET, scene: SCENE_BUDGET, worldFootprint: WORLD_FOOTPRINT_BUDGET },
      checks: assetRegistry.checks,
      failures: [
        ...assetRegistry.modelChecks.flatMap((check) => check.failures),
        ...[...registryBudgetFailures, ...sceneBudgetFailures].map((failure) => failure.reason),
      ],
    };
  },
  get towerModels(): TowerModelReading[] {
    return towers.modelReadings();
  },
  get enemyModels(): EnemyModelReading[] {
    return enemies.modelReadings();
  },
  // The QA seam goes through the same door a pad click does, so a command a test injects cannot take a
  // route the product does not take — in a room that means it is posted, not applied to a local core.
  dispatch: submitCommand,
};

// The tick the next recorded command is due on, or `null` when nothing is pending. This is the only
// thing the frame loop is allowed to consult about the replay before it steps: a command that has
// not been applied yet owns the tick it was recorded on.
const pendingCommandTick = (): number | null =>
  replaying && replayIndex < commandLog.length ? commandLog[replayIndex].tick : null;

const renderFrame = (timestamp: number) => {
  framesRendered += 1;
  const frameDelta = readFrameDelta(timestamp);
  // The entry screen stops the match clock the same way a pause does, and for the same reason the
  // pause is a clock control and not a state of the match: what the player comes back to has to be
  // the match they left. `paused` is the player's own switch and stays exactly as they left it, so
  // Continue from MENU returns a frozen match still frozen if it was frozen.
  //
  // `mode === 'solo'` is the whole of "this page owns the match". In a room the local core is not
  // stepped, not dispatched and not drained: the only thing that moves the snapshot is a frame from the
  // room, so a client that lost the stream shows a picture that has stopped rather than a match it kept
  // running on its own. Everything below this line — the ambient motion, the animations, the render —
  // runs in both modes, because a client that stops drawing is a broken client and not an honest one.
  if (mode === 'solo' && !paused && !entryOpen) {
    // The speed multiplies the time one frame is charged and nothing else. The tick is still
    // `STEP_SECONDS` of match time, the loop below still spends whole ticks only, and the surplus that
    // does not fit a frame stays in the accumulator for the next one — so four times the clock is four
    // times the ticks a second and not one tick four times as long. The clamp above is still the
    // product's: a stall longer than `MAX_FRAME_SECONDS` is dropped rather than fast-forwarded, and at
    // four times it drops four times as much, which is the same statement about a faster clock.
    accumulator += frameDelta * gameSpeed;
    // A frame may spend whole ticks only up to the tick of the next recorded command. Without this
    // ceiling a frame that steps five ticks walks straight over that tick, and `applyReplayPlan`
    // then applies the command on the tick the frame happened to end on — the log is right and the
    // replay is late, which is how two runs of one match end on different terminal ticks. The time
    // that does not fit stays in the accumulator and is spent by the following frames, so a replay
    // clock may briefly trail the wall clock and the simulation stays exact: the surplus is never
    // dropped to make up ground.
    const pending = pendingCommandTick();
    // `snapshot` is the projection of the core and is in sync with it here, because every path that
    // touches the core — `step`, `dispatch` and `beginRecordedRun` — refreshes the projection.
    const tickCeiling = pending === null ? Infinity : pending - snapshot.tick;
    // A rebuild adds the same kind of deadline from the other side: the frame may not step past the
    // tick the slot named either, or it would arrive late by up to one frame of ticks and the loaded
    // match would start from a tick its save never had.
    const stopCeiling = rebuildStopTick === null ? Infinity : rebuildStopTick - snapshot.tick;
    const ceiling = Math.min(tickCeiling, stopCeiling);
    let steps = 0;
    while (steps < ceiling && accumulator >= STEP_SECONDS) {
      simulation.step();
      accumulator -= STEP_SECONDS;
      steps += 1;
    }
    if (steps > 0) {
      eventsDrained += consumeLocalEvents();
      syncFromCore();
    }
    if (replaying) {
      applyReplayPlan();
    }
    settleRebuild();
  }

  elapsed += frameDelta;
  // Reduced motion freezes ambient movement and transient effects; the projected
  // positions, health and materials stay readable because they come from the snapshot.
  const ambientDelta = reducedMotion ? 0 : frameDelta;
  // The held keys move the stand, not the match: this runs whether the clock is stopped or not, so a
  // player can look around a paused board, and it is kept out of the reduced-motion gate because a
  // camera the player is driving is not ambient motion.
  applyHeldCameraKeys(frameDelta);
  followKeyLight();
  // The frame in the order it was drawn before the split: the towers, the enemies, then the
  // bursts and the shot traces that belong to nobody in particular. The map has nothing to animate —
  // it is a plate, a road and a square, and all three are still — so it is not in the list.
  towers.animate(elapsed, ambientDelta, presentationTime());
  enemies.animate(elapsed, ambientDelta);
  combatFx.animate(elapsed);

  // The arrival of a rebuild is recorded here, at the end of the frame that got there, so the
  // reading belongs to the same tick as the presentation around it and not to the frame before.
  if (pendingRebuild !== null) {
    lastRebuild = readRebuildReading(pendingRebuild);
    pendingRebuild = null;
  }
  renderer.render(scene, camera);
  if (minimap) {
    // Drawn from the same snapshot the scene was just projected from, in the same frame, after the
    // camera has already been placed — so the frame rectangle on it is this frame's view and not the
    // one the last wheel notch left behind.
    minimap.draw(snapshot, {
      halfWidth: (camera.right - camera.left) / 2,
      halfHeight: (camera.top - camera.bottom) / 2,
      targetX: cameraRig.targetX,
      targetZ: cameraRig.targetZ,
    });
  }
  sampleSceneBudget();
  requestAnimationFrame(renderFrame);
};

requestAnimationFrame(renderFrame);
