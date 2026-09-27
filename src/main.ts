import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { TICK_RATE, createSimulation, createTrainingScenario } from './game-core/index.ts';
import type { Command, CommandResult, MatchSnapshot, MatchStatus, SimulationEvent } from './game-core/index.ts';
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
  readSessionFrame,
} from './protocol/index.ts';
import type { EventTally, HandshakeRequest, RoomCommand, SessionFrame, VersionStamp } from './protocol/index.ts';
import { ASSET_MANIFEST_URL, AssetContractError, createAssetRegistry, parseAssetManifest, resolveModelUrl } from './asset-registry.ts';
import type { AssetChecks, AssetRegistry, AssetStatus, ModelCheck, ModelManifestEntry } from './asset-registry.ts';
import {
  MODEL_BUDGET,
  REGISTRY_BUDGET,
  SCENE_BUDGET,
  checkClipTargets,
  checkModelContract,
  checkNodeTypes,
  checkRegistryBudgets,
  checkSceneBudget,
  describeFailures,
  gltfPathForTrack,
  sumRegistry,
} from './asset-budgets.ts';
import type { AssetFailure, ClipTargetReading, NodeReading, SceneReading } from './asset-budgets.ts';
import './styles.css';

type RenderCounters = {
  pads: number;
  towers: number;
  enemies: number;
  routeSegments: number;
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
  readonly objectCount: number;
  readonly rendered: RenderCounters;
  readonly towerPositions: Array<{ x: number; z: number }>;
  readonly enemyPositions: Array<{ x: number; z: number }>;
  readonly padScreenPositions: Array<{ padId: string; x: number; y: number }>;
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
  // Frames this page has drawn. A page that is alive but not ticking is the whole claim behind "the
  // room owns the clock in remote mode", and it cannot be told apart from a frozen picture without it.
  readonly frames: number;
  readonly motion: { reducedMotion: boolean; combatBursts: number; enemyBob: number; clips: number; clipsPlaying: number };
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
    budgets: { model: typeof MODEL_BUDGET; registry: typeof REGISTRY_BUDGET; scene: typeof SCENE_BUDGET };
    checks: AssetChecks;
    failures: string[];
  };
  readonly towerModels: TowerModelReading[];
};

type FeedbackState = 'idle' | 'accepted' | 'rejected' | 'terminal';

type CombatBurst = {
  mesh: THREE.Mesh;
  started: number;
  duration: number;
};

type EventFeedEntry = {
  type: SimulationEvent['type'];
  text: string;
};

type BuildOption = {
  button: HTMLButtonElement;
  towerId: string;
  name: string;
};

type PadView = {
  id: string;
  base: THREE.Mesh;
  ring: THREE.Mesh;
  occupied: boolean;
  errorUntil: number;
};

type LoadedModel = {
  entry: ModelManifestEntry;
  scene: THREE.Group;
  emissiveNode: string;
  clips: THREE.AnimationClip[];
};

type TowerModelReading = {
  entityId: number;
  towerId: string;
  source: 'procedural' | 'model';
  modelId: string | null;
  meshCount: number;
  crystalNode: string | null;
  crystalBaseY: number;
  crystalY: number;
  crystalScale: number;
  crystalEmissive: number;
  // Null on a tower without a skeleton. `time` and `pose` are the facts the determinism claim rests
  // on: the same tick has to give the same two numbers in a run and in the replay of that run.
  clip: TowerClipReading | null;
};

type TowerClipReading = {
  clipName: string;
  duration: number;
  // Slot-derived offset the clip starts at, in seconds. Two spires never stand in the same pose,
  // and the offset comes from the order the towers were built, so it replays with them.
  phase: number;
  time: number;
  playing: boolean;
  boneName: string;
  pose: [number, number, number, number];
};

type ProbeMaterialReading = {
  // Scene-graph path of the mesh that owns the material, which is what localises a material whose
  // role was never declared.
  path: string;
  className: string;
  // The role that declared this material's weight, or null when nothing declared one.
  role: string | null;
  envMapIntensity: number;
  // Whether the material owns the probe itself. A standard material without its own `envMap` has
  // its `envMapIntensity` overwritten by the renderer, so a weight reported without this flag is
  // a value the picture never saw.
  ownsProbe: boolean;
  // Instance identity: two views of one model must never report the same one, or they would be
  // sharing a material and a crystal flash would light every view of that tower at once.
  materialId: string;
  // True only when a declared role is present, the material carries that role's weight, and the
  // renderer will actually read it.
  explicit: boolean;
};

// The animated part of a tower view. It is presentation state and lives with the view: the
// snapshot does not know it exists, and nothing in the simulation reads it. `applied` is the
// presentation time the clip has been brought up to, so the update is a difference between two
// readings of one clock and never a function of where in the frame the view was created.
type TowerClip = {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  clipName: string;
  duration: number;
  phase: number;
  bone: THREE.Bone;
  applied: number;
};

type TowerView = {
  towerId: string;
  group: THREE.Group;
  crystal: THREE.Mesh;
  crystalMaterial: THREE.MeshStandardMaterial;
  // The idle bob is measured from wherever the emissive node starts, so a loaded model and
  // the procedural placeholder cannot drift apart on a hardcoded height.
  crystalBaseY: number;
  source: 'procedural' | 'model';
  modelId: string | null;
  clip: TowerClip | null;
  firedUntil: number;
  aimAngle: number;
  // Releases exactly what this view owns: the geometry and the source materials of a loaded
  // model stay with the registry, or the next view of the same model would get a disposed one.
  release: () => void;
};

type EnemyView = {
  group: THREE.Group;
  body: THREE.Mesh;
  healthFill: THREE.Mesh;
};

declare global {
  interface Window {
    __ECHOES_DEBUG__?: DebugState;
  }
}

const sceneMount = document.querySelector<HTMLDivElement>('#scene');
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
  for (const key of ['scene', 'model', 'registry', 'checks']) {
    const row = document.createElement('p');
    row.dataset.diag = key;
    element.append(row);
    rows[key] = row;
  }
  viewportShell.append(element);
  return { rows };
};

const devDiagnostics = devDiagnosticsOn ? createDevDiagnostics() : null;

const config = createTrainingScenario();
let simulation = createSimulation(config);
const padDefinitions = new Map(config.map.buildPads.map((pad) => [pad.id, pad]));
const towerDefinitions = new Map(config.towers.map((tower) => [tower.id, tower]));
const enemyDefinitions = new Map(config.enemies.map((enemy) => [enemy.id, enemy]));
const waveCount = config.waves.length;
const STEP_SECONDS = 1 / TICK_RATE;
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
let reducedMotion = reducedMotionQuery.matches;
let paused = false;
let replaying = false;
let replayIndex = 0;
let terminalReported = false;
const commandLog: CommandLogEntry[] = [];
const matchReports: MatchReport[] = [];

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
renderer.toneMappingExposure = 1.12;
renderer.domElement.dataset.testid = 'scene-canvas';
renderer.domElement.setAttribute('aria-label', '3D tactical scene');
sceneMount.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08131b);
scene.fog = new THREE.Fog(0x08131b, 15, 31);

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

// The share of the environment probe each material takes, and the only dimmer left in the scene.
// `envMapIntensity` defaults to 1, so leaving a material unset would read as "full probe" — the
// wrong default for a deliberately dark tactical read. Ground and routes take almost none of it:
// a rough near-dielectric surface gains nothing from a soft room and only loses the slate it was
// authored as. The share grows with the metalness of the part, and the generated model keeps the
// whole probe, because it is the reason the probe exists.
const PROBE_WEIGHTS = {
  ground: 0.1,
  path: 0.15,
  padBase: 0.2,
  towerBase: 0.25,
  towerStem: 0.35,
  towerRoof: 0.4,
  towerCrystal: 0.3,
  enemyBody: 0.2,
  enemyCrest: 0.25,
  coreBase: 0.3,
  coreCrystal: 0.45,
  model: 1,
} as const;

type ProbeRole = keyof typeof PROBE_WEIGHTS;

// Writes the declared weight onto the material and names the role that declared it. The stamp is
// what tells "set on purpose" apart from "inherited": 1 is both the Three.js default and the
// weight of the generated model, so the value alone cannot.
//
// The `envMap` line is load-bearing and must not be "cleaned up". Three.js only reads
// `material.envMapIntensity` when the material owns an `envMap`: with `envMap === null` and the
// probe on `scene.environment`, the renderer overwrites that uniform with the scene's own
// `environmentIntensity` and the weight below is silently ignored. Measured on a frozen midwave
// frame, dropping this line brightens the ground by about 16 levels of luminance instead of
// darkening it, while every reported weight still reads as declared. Owning the probe is what
// makes this the last dimmer in the scene: with no material left on the scene path, a scene-wide
// multiplier has nothing left to multiply.
const withProbeWeight = <T extends THREE.MeshStandardMaterial>(material: T, role: ProbeRole): T => {
  material.envMap = environmentTarget.texture;
  material.envMapIntensity = PROBE_WEIGHTS[role];
  material.userData.probeRole = role;
  return material;
};

// `MeshPhysicalMaterial` extends `MeshStandardMaterial`, so this single check covers both classes
// that sample the probe. `MeshBasicMaterial` and `PointsMaterial` never read it and stay untouched.
const isProbeMaterial = (material: THREE.Material): material is THREE.MeshStandardMaterial =>
  material instanceof THREE.MeshStandardMaterial;

const camera = new THREE.OrthographicCamera(-8, 8, 5, -5, 0.1, 100);
camera.position.set(9, 10, 9);
camera.lookAt(0, 0, 0);

const hemisphereLight = new THREE.HemisphereLight(0xa9c9e8, 0x142329, 2.2);
scene.add(hemisphereLight);

const keyLight = new THREE.DirectionalLight(0xffe4bf, 3.4);
keyLight.position.set(-5, 12, 7);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -10;
keyLight.shadow.camera.right = 10;
keyLight.shadow.camera.top = 10;
keyLight.shadow.camera.bottom = -10;
scene.add(keyLight);

const fillLight = new THREE.PointLight(0x2ac7b5, 3.2, 12, 2);
fillLight.position.set(4, 3, -4);
scene.add(fillLight);

const groundMaterial = withProbeWeight(
  new THREE.MeshStandardMaterial({
    color: 0x163039,
    roughness: 0.92,
    metalness: 0.04,
  }),
  'ground',
);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(config.map.width, config.map.depth), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(config.map.width, config.map.width, 0x3d7376, 0x24464e);
grid.position.y = 0.012;
scene.add(grid);

const pathMaterial = withProbeWeight(
  new THREE.MeshStandardMaterial({
    color: 0x2e5c5c,
    emissive: 0x0c2425,
    emissiveIntensity: 0.65,
    roughness: 0.82,
  }),
  'path',
);
const PATH_Y = 0.08;
const routeSegmentCount = config.map.routes.reduce((total, route) => total + route.points.length - 1, 0);
for (const [routeIndex, route] of config.map.routes.entries()) {
  for (let index = 1; index < route.points.length; index += 1) {
    const start = route.points[index - 1];
    const end = route.points[index];
    const deltaX = end.x - start.x;
    const deltaZ = end.z - start.z;
    const length = Math.hypot(deltaX, deltaZ);
    const segment = new THREE.Mesh(new THREE.BoxGeometry(length, 0.08, 0.62), pathMaterial);
    segment.position.set((start.x + end.x) / 2, PATH_Y + routeIndex * 0.004, (start.z + end.z) / 2);
    // Three.js rotates local +X toward -Z, so the Y angle is negated.
    segment.rotation.y = Math.atan2(-deltaZ, deltaX);
    segment.receiveShadow = true;
    segment.name = `route:${route.id}`;
    scene.add(segment);
  }
}

const padGeometry = new THREE.CylinderGeometry(0.62, 0.72, 0.14, 6);
const padViews = new Map<string, PadView>();
const padPickTargets: THREE.Mesh[] = [];
for (const pad of config.map.buildPads) {
  const group = new THREE.Group();
  group.position.set(pad.position.x, 0, pad.position.z);
  group.name = `pad:${pad.id}`;

  const base = new THREE.Mesh(
    padGeometry,
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: 0x2b7073,
        emissive: 0x0b3135,
        emissiveIntensity: 0.9,
        roughness: 0.48,
        metalness: 0.18,
      }),
      'padBase',
    ),
  );
  base.position.y = 0.12;
  base.castShadow = true;
  base.receiveShadow = true;
  base.name = `pad-base:${pad.id}`;
  group.add(base);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.8, 6),
    new THREE.MeshBasicMaterial({ color: 0x6ee2cf, transparent: true, opacity: 0.48, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.205;
  ring.name = `pad-ring:${pad.id}`;
  group.add(ring);

  base.userData.padId = pad.id;
  ring.userData.padId = pad.id;
  padPickTargets.push(base, ring);

  scene.add(group);
  padViews.set(pad.id, { id: pad.id, base, ring, occupied: false, errorUntil: 0 });
}

const towerVisuals: Record<string, { accent: number; roof: number; scale: number }> = {
  'pulse-spire': { accent: 0x6ee2cf, roof: 0xd29b62, scale: 1 },
  'grove-lens': { accent: 0x8cd6ff, roof: 0x8d6bb5, scale: 0.95 },
  'frost-relay': { accent: 0xffc56b, roof: 0xbe6b55, scale: 1.05 },
};
const unknownTowerVisual = { accent: 0x9fd6c8, roof: 0x5b7f86, scale: 1 };

const towerViews = new Map<number, TowerView>();
const modelStore = new Map<string, LoadedModel>();

// The loaded scene stays the single owner of its geometry and of its source materials. A view
// borrows that geometry and gets its own material copies, because the crystal emissive is
// per-tower presentation state: on a shared material one tower firing would flash every tower
// of that type at the same time. `SkeletonUtils.clone` is what makes a skinned model clonable at
// all — it rebuilds the skeleton and rebinds the copy to its own bones — and it hands geometry and
// materials back by reference, so the material copies are made here, after the clone.
const cloneModelNode = (source: THREE.Object3D, owned: THREE.Material[]): THREE.Object3D => {
  const clone = SkeletonUtils.clone(source);
  clone.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) {
      return;
    }
    // `Material.copy` carries the probe across: `envMap`, `envMapIntensity` and the `userData`
    // stamp are all part of what a copy is, so a per-view material must not arrive with a
    // declared weight of 1 and no probe of its own.
    const material = (child.material as THREE.Material).clone();
    owned.push(material);
    child.material = material;
    child.castShadow = true;
    child.receiveShadow = true;
  });
  return clone;
};

// One clip per view, started at a slot-derived offset instead of at a random moment. The offset
// comes from the order the towers were built in, which the replay reproduces, so two spires never
// stand in the same pose and a restart still lands on the same one.
const TOWER_CLIP_PHASE_SECONDS = 0.37;

const startTowerClip = (root: THREE.Object3D, clip: THREE.AnimationClip, phase: number): TowerClip | null => {
  if (clip.tracks.length === 0) {
    return null;
  }
  // Every channel of the clip has to land on a bone of this copy, not just the first one: the mixer
  // resolves a track by name inside the root it was given, and a name it cannot find is a channel
  // that silently does nothing.
  const bones: THREE.Bone[] = [];
  for (const track of clip.tracks) {
    const name = track.name.split('.')[0] ?? '';
    const bone = root.getObjectByName(name) as THREE.Bone | undefined;
    if (bone?.isBone !== true) {
      throw new AssetContractError(`clip ${clip.name} drives ${name}, which is not a bone of the model`);
    }
    bones.push(bone);
  }
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  // Reduced motion does not slow the clip down, it stops it: without a play call the bones stay in
  // the rest pose the model was authored in.
  if (!reducedMotion) {
    action.play();
  }
  action.time = phase % clip.duration;
  return { mixer, action, clipName: clip.name, duration: clip.duration, phase, bone: bones[0] as THREE.Bone, applied: presentationTime() };
};

const readTowerClip = (clip: TowerClip): TowerClipReading => ({
  clipName: clip.clipName,
  duration: clip.duration,
  phase: clip.phase,
  time: clip.action.time,
  playing: clip.action.isRunning(),
  boneName: clip.bone.name,
  pose: [clip.bone.quaternion.x, clip.bone.quaternion.y, clip.bone.quaternion.z, clip.bone.quaternion.w],
});

const createModelTowerView = (towerId: string, model: LoadedModel, slot: number): TowerView => {
  const visual = towerVisuals[towerId] ?? unknownTowerVisual;
  const owned: THREE.Material[] = [];
  const root = cloneModelNode(model.scene, owned) as THREE.Group;
  const group = new THREE.Group();
  group.name = `tower:${towerId}`;
  group.scale.setScalar(visual.scale);
  group.add(root);
  const emissive = root.getObjectByName(model.emissiveNode);
  if (!(emissive instanceof THREE.Mesh) || !(emissive.material instanceof THREE.MeshStandardMaterial)) {
    throw new AssetContractError(`model ${model.entry.id} has no ${model.emissiveNode} mesh to animate`);
  }
  const crystalMaterial = emissive.material;
  crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
  const clip = model.clips[0] === undefined ? null : startTowerClip(root, model.clips[0], slot * TOWER_CLIP_PHASE_SECONDS);
  return {
    towerId,
    group,
    crystal: emissive,
    crystalMaterial,
    crystalBaseY: emissive.position.y,
    source: 'model',
    modelId: model.entry.id,
    clip,
    firedUntil: 0,
    aimAngle: 0,
    release: () => {
      // A mixer keeps its bindings and its actions alive on its own, so a tower that is removed
      // has to give them back: thirty removed towers would otherwise leave thirty mixers running
      // against a skeleton nothing renders any more.
      if (clip !== null) {
        clip.mixer.stopAllAction();
        clip.mixer.uncacheRoot(root);
      }
      for (const material of owned) {
        material.dispose();
      }
    },
  };
};

const createProceduralTowerView = (towerId: string): TowerView => {
  const visual = towerVisuals[towerId] ?? unknownTowerVisual;
  const group = new THREE.Group();
  group.scale.setScalar(visual.scale);
  group.name = `tower:${towerId}`;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
    withProbeWeight(
      new THREE.MeshStandardMaterial({ color: 0x1d4651, roughness: 0.46, metalness: 0.34 }),
      'towerBase',
    ),
  );
  base.position.y = 0.15;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.28, 0.78, 6),
    withProbeWeight(
      new THREE.MeshStandardMaterial({ color: 0x346f75, roughness: 0.34, metalness: 0.5 }),
      'towerStem',
    ),
  );
  stem.position.y = 0.5;
  stem.castShadow = true;
  group.add(stem);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 0.42, 6),
    withProbeWeight(
      new THREE.MeshStandardMaterial({ color: visual.roof, roughness: 0.3, metalness: 0.3 }),
      'towerRoof',
    ),
  );
  roof.position.y = 1.08;
  roof.castShadow = true;
  group.add(roof);

  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.18, 0),
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: visual.accent,
        emissive: visual.accent,
        emissiveIntensity: towerCrystalIdleIntensity,
        roughness: 0.18,
        metalness: 0.15,
      }),
      'towerCrystal',
    ),
  );
  crystal.position.y = 1.43;
  group.add(crystal);

  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(0.57, 0.025, 8, 32),
    new THREE.MeshBasicMaterial({ color: visual.accent, transparent: true, opacity: 0.7 }),
  );
  aura.rotation.x = Math.PI / 2;
  aura.position.y = 0.18;
  group.add(aura);

  return {
    towerId,
    group,
    crystal,
    crystalMaterial: crystal.material as THREE.MeshStandardMaterial,
    crystalBaseY: crystal.position.y,
    source: 'procedural',
    modelId: null,
    // The placeholder has no rig, so there is no clip and nothing to stop when the view is released.
    clip: null,
    firedUntil: 0,
    aimAngle: 0,
    release: () => disposeInstance(group),
  };
};

const createTowerView = (towerId: string, slot: number): TowerView => {
  const model = modelStore.get(towerId);
  return model ? createModelTowerView(towerId, model, slot) : createProceduralTowerView(towerId);
};

const enemyVisuals: Record<string, { color: number; scale: number }> = {
  husk: { color: 0xe46c62, scale: 0.84 },
  runner: { color: 0xf0a85d, scale: 0.68 },
  wisp: { color: 0xd85c8b, scale: 0.76 },
};
const unknownEnemyVisual = { color: 0xc9a27a, scale: 0.74 };

const enemyViews = new Map<number, EnemyView>();
const createEnemyView = (enemyId: string): EnemyView => {
  const visual = enemyVisuals[enemyId] ?? unknownEnemyVisual;
  const group = new THREE.Group();
  group.scale.setScalar(visual.scale);
  group.name = `enemy:${enemyId}`;

  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 1),
    withProbeWeight(
      new THREE.MeshStandardMaterial({ color: visual.color, emissive: visual.color, emissiveIntensity: 0.45, roughness: 0.62 }),
      'enemyBody',
    ),
  );
  body.castShadow = true;
  group.add(body);

  const crest = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.42, 5),
    withProbeWeight(new THREE.MeshStandardMaterial({ color: 0xf3b77b, roughness: 0.5 }), 'enemyCrest'),
  );
  crest.position.y = 0.34;
  crest.rotation.z = Math.PI;
  group.add(crest);

  const healthBack = new THREE.Mesh(
    new THREE.BoxGeometry(0.88, 0.08, 0.04),
    new THREE.MeshBasicMaterial({ color: 0x152229 }),
  );
  healthBack.position.y = 0.78;
  group.add(healthBack);

  const healthFill = new THREE.Mesh(
    new THREE.BoxGeometry(0.76, 0.045, 0.045),
    new THREE.MeshBasicMaterial({ color: 0x74e0b4 }),
  );
  healthFill.position.set(0, 0.78, 0.025);
  group.add(healthFill);

  return { group, body, healthFill };
};

const disposeInstance = (object: THREE.Object3D) => {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = mesh.material;
    if (Array.isArray(material)) {
      for (const entry of material) {
        entry.dispose();
      }
    } else {
      material?.dispose();
    }
  });
};

const combatBursts: CombatBurst[] = [];
const combatBurstGeometry = new THREE.RingGeometry(0.22, 0.34, 18);
const combatBurstColor = new THREE.Color(0x9ff0c9);

const removeCombatBurst = (burst: CombatBurst) => {
  scene.remove(burst.mesh);
  (burst.mesh.material as THREE.Material).dispose();
};

const core = new THREE.Group();
core.position.set(config.map.corePosition.x, 0.3, config.map.corePosition.z);
core.name = 'core';
const coreBase = new THREE.Mesh(
  new THREE.CylinderGeometry(0.8, 0.95, 0.32, 8),
  withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x285a62, roughness: 0.38, metalness: 0.42 }),
    'coreBase',
  ),
);
coreBase.castShadow = true;
core.add(coreBase);
const coreCrystal = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.7, 1),
  withProbeWeight(
    new THREE.MeshStandardMaterial({
      color: 0x7ce7d2,
      emissive: 0x2ac7b5,
      emissiveIntensity: 1.8,
      roughness: 0.16,
      metalness: 0.22,
    }),
    'coreCrystal',
  ),
);
coreCrystal.position.y = 1.05;
coreCrystal.castShadow = true;
core.add(coreCrystal);
const coreRing = new THREE.Mesh(
  new THREE.TorusGeometry(1.05, 0.035, 8, 36),
  new THREE.MeshBasicMaterial({ color: 0x6ee2cf, transparent: true, opacity: 0.62 }),
);
coreRing.rotation.x = Math.PI / 2;
coreRing.position.y = 0.24;
core.add(coreRing);
scene.add(core);

const particles = new THREE.Points(
  new THREE.BufferGeometry(),
  new THREE.PointsMaterial({ color: 0x6ee2cf, size: 0.045, transparent: true, opacity: 0.62 }),
);
const particlePositions = new Float32Array(54 * 3);
for (let index = 0; index < 54; index += 1) {
  particlePositions[index * 3] = -5.4 + (index % 9) * 1.35;
  particlePositions[index * 3 + 1] = 0.35 + ((index * 7) % 11) * 0.08;
  particlePositions[index * 3 + 2] = -3.2 + ((index * 5) % 8) * 0.72;
}
particles.geometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
scene.add(particles);

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
const refuseModel = (entry: ModelManifestEntry, reading: ModelReading, reason: string): never => {
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

const loadModel = async (entry: ModelManifestEntry): Promise<LoadedModel> => {
  const response = await fetch(resolveModelUrl(entry));
  if (!response.ok) {
    throw new AssetContractError(`model ${entry.id} responded ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  const digest = await hashArtifact(buffer);
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
  const failures = [
    ...checkModelContract({ id: entry.id, bytes: entry.bytes, triangles: entry.triangles, ...skeleton.measurement }),
    ...checkNodeTypes(entry.id, nodes),
    ...checkClipTargets(entry.id, skeleton.targets),
  ];
  assetRegistry.markCheckPerformed('modelBudget');
  if (failures.length > 0) {
    return refuseModel(entry, reading, describeFailures(failures));
  }
  if (!gltf.scene.getObjectByName(entry.emissiveNode)) {
    return refuseModel(entry, reading, `model ${entry.id} has no ${entry.emissiveNode} node to animate`);
  }
  declareModelProbe(gltf.scene);
  assetRegistry.recordModelCheck({ modelId: entry.id, accepted: true, ...reading, failures: [] });
  return { entry, scene: gltf.scene, emissiveNode: entry.emissiveNode, clips: gltf.animations };
};

// The status line is a single line of viewport chrome, and two whole digests are exactly what
// pushed the sector caption out of the way. Only the display is shortened: `assets.error` and
// `assetBudgets.failures` keep the full reason, so an operator reading the seam still gets the
// exact value to compare.
const viewportRefusal = (reason: string): string => reason.replace(/(sha256:)([0-9a-f]{8})[0-9a-f]+/gi, '$1$2…');

// Two surfaces, one source. What a player reads is the state of the match, the models that came
// with it and whether the artifact was checked; every number this machine measured — scene budgets,
// renderer counters, load time, which checks ran — is developer information. A budget is measured
// on the build machine and is not a promise to a player on a slow connection, so printing it in
// the status line would be a false alarm dressed as a trustworthy status.
const gameplayStatus = (): string => {
  const status = assetRegistry.status;
  if (status === 'ready') {
    // Which checks ran is part of the message, not a detail of the debug seam: without it a
    // skipped hash verification is indistinguishable from a passed one.
    const integrity = assetRegistry.checks.performed.contentHash
      ? 'integrity checked'
      : `content hash not checked (${assetRegistry.modelChecks.find((check) => check.contentHash.skippedReason)?.contentHash.skippedReason ?? 'no reason given'})`;
    return `Scene online · models ready (${assetRegistry.modelIds.join(', ')}) · ${integrity}`;
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

// Two-phase swap. A view built before the registry answered keeps rendering, and once the model
// is in it is replaced in place: no entity is recreated, no position changes and the snapshot is
// not touched, so a late model cannot make two replays of the same run look different.
const upgradeTowerViews = () => {
  for (const [entityId, view] of [...towerViews]) {
    if (view.source === 'model' || !modelStore.has(view.towerId)) {
      continue;
    }
    // The slot is the order the towers were built in, so a tower that is upgraded in place keeps
    // the clip phase it would have had if the model had arrived on time.
    const slot = [...towerViews.keys()].indexOf(entityId);
    const next = createTowerView(view.towerId, slot);
    next.group.position.copy(view.group.position);
    next.group.rotation.y = view.group.rotation.y;
    next.firedUntil = view.firedUntil;
    next.aimAngle = view.aimAngle;
    scene.remove(view.group);
    view.release();
    scene.add(next.group);
    towerViews.set(entityId, next);
  }
};

const countMeshes = (object: THREE.Object3D): number => {
  let total = 0;
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      total += 1;
    }
  });
  return total;
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
    // One refused model must not take the rest of the registry down with it: the refusal names
    // the model, the accepted ones are still swapped in, and the scene keeps its placeholders.
    const settled = await Promise.all(
      manifest.models.map((entry) =>
        assetRegistry
          .load<LoadedModel>(entry, () => loadModel(entry))
          .then((model) => ({ model }))
          .catch((error: unknown) => ({ error })),
      ),
    );
    const refusals: string[] = [];
    for (const outcome of settled) {
      if ('model' in outcome) {
        modelStore.set(outcome.model.entry.id, outcome.model);
        accepted.push(outcome.model.entry.id);
        continue;
      }
      refusals.push(outcome.error instanceof Error ? outcome.error.message : String(outcome.error));
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
    assetRegistry.markReady(accepted);
  } else {
    assetRegistry.markFailed(refusal, accepted);
  }
  applyAssetStatus();
  upgradeTowerViews();
};

const rejectionMessages: Record<string, string> = {
  'pad-occupied': 'Pad already occupied',
  'not-enough-gold': 'Not enough aether',
  'unknown-pad': 'Unknown build pad',
  'unknown-tower': 'Unknown module',
  'match-finished': 'Match already finished',
  'wave-already-active': 'Wave already active',
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

const resize = () => {
  const width = sceneMount.clientWidth || 1;
  const height = sceneMount.clientHeight || 1;
  const aspect = width / height;
  const viewHeight = 9.6;
  camera.left = (-viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
};

window.addEventListener('resize', resize);
resize();

const padFreeColor = new THREE.Color(0x2b7073);
const padFreeEmissive = new THREE.Color(0x0b3135);
const padOccupiedColor = new THREE.Color(0x3a4b55);
const padOccupiedEmissive = new THREE.Color(0x0a1a1e);
const padFreeRing = new THREE.Color(0x6ee2cf);
const padOccupiedRing = new THREE.Color(0xffc56b);
const padErrorEmissive = new THREE.Color(0x5a1410);
const padErrorRing = new THREE.Color(0xff6f61);
const coreHealthy = new THREE.Color(0x2ac7b5);
const coreHealthyRing = new THREE.Color(0x6ee2cf);
const coreFailing = new THREE.Color(0xe46c62);
const coreWarningRing = new THREE.Color(0xffc56b);
const baseBodyEmissive = 0.45;
const slowedBodyEmissive = 1.15;
const enemyBaseY = 0.28;
const padErrorFlashSeconds = 0.7;
const towerCrystalIdleIntensity = 2.4;
const towerCrystalFireIntensity = 5.2;
const towerFireFlashSeconds = 0.22;
const coreDamageFlashSeconds = 0.6;
const combatBurstSeconds = 0.55;
const EVENT_FEED_LIMIT = 5;
const RECENT_EVENT_LIMIT = 16;
const MAX_COMBAT_BURSTS = 14;

let elapsed = 0;
let enemyBobOffset = 0;
// Presentation time is the time the match clock has been stepped for, which is the tick the
// projection is at times one tick. It is not wall time: `elapsed` above is, and it keeps running
// while the match is paused, which is what the ambient bob wants. A skeleton follows the match
// instead, so a paused snapshot and a paused screenshot show the same pose, and a restarted match
// puts every tower back into the pose its tick implies.
const presentationTime = (): number => snapshot.tick * STEP_SECONDS;

const refreshPadStyle = (padView: PadView) => {
  const flashing = elapsed < padView.errorUntil;
  const baseMaterial = padView.base.material as THREE.MeshStandardMaterial;
  const ringMaterial = padView.ring.material as THREE.MeshBasicMaterial;
  baseMaterial.color.copy(padView.occupied ? padOccupiedColor : padFreeColor);
  baseMaterial.emissive.copy(flashing ? padErrorEmissive : padView.occupied ? padOccupiedEmissive : padFreeEmissive);
  baseMaterial.emissiveIntensity = flashing ? 1.3 : padView.occupied ? 0.4 : 0.9;
  ringMaterial.color.copy(flashing ? padErrorRing : padView.occupied ? padOccupiedRing : padFreeRing);
  ringMaterial.opacity = flashing ? 0.95 : padView.occupied ? 0.72 : 0.48;
};

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

const phaseTimerText = (state: MatchSnapshot): string => {
  if (state.status === 'preparation') {
    // The content prep window is short, so an elapsed countdown is shown as a neutral
    // awaiting-start label instead of a frozen `T-00:00` that reads as a live timer.
    return state.preparationTicksLeft > 0 ? `T-${formatClock(state.preparationTicksLeft)}` : 'Awaiting start';
  }
  if (state.status === 'wave') {
    return `W+${formatClock(state.waveTick)}`;
  }
  return state.status === 'victory' ? 'Cleared' : 'Breached';
};

const objectiveSummary = (state: MatchSnapshot): string => {
  if (state.status === 'preparation') {
    return 'Awaiting start command';
  }
  if (state.status === 'wave') {
    return `Leaks ${state.leaksThisWave}`;
  }
  if (state.status === 'victory') {
    return 'Objective complete';
  }
  return `Core lost on wave ${state.waveIndex + 1}`;
};

let coreDefeated = false;
let coreDamagedUntil = 0;
let snapshot = simulation.getSnapshot();

const terminalFeedbackLabels: Record<'victory' | 'defeat', string> = {
  victory: 'Sector secured · restart repeats this run exactly',
  defeat: 'Core breached · restart repeats this run exactly',
};

const syncHud = () => {
  const remote = mode === 'remote';
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
  // Start Wave is a command, so it stays available in a room — it just goes to the room instead of to a
  // core this page owns. The four controls that act on a local `Simulation` are not commands at all, and
  // a control that would do nothing but look available is a lie with a button on it.
  startWaveButton.disabled = remote ? sessionState !== 'live' : snapshot.status !== 'preparation' || replaying;
  restartButton.disabled = remote || commandLog.length === 0;
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
};

const applySnapshot = (next: MatchSnapshot) => {
  snapshot = next;

  for (const padView of padViews.values()) {
    const occupant = next.pads[padView.id];
    const occupied = occupant !== null && occupant !== undefined;
    if (occupied === padView.occupied) {
      continue;
    }
    padView.occupied = occupied;
    refreshPadStyle(padView);
  }

  const aliveTowers = new Set<number>();
  for (const tower of next.towers) {
    aliveTowers.add(tower.entityId);
    let view = towerViews.get(tower.entityId);
    if (!view) {
      const pad = padDefinitions.get(tower.padId);
      if (!pad) {
        continue;
      }
      view = createTowerView(tower.towerId, towerViews.size);
      view.group.position.set(pad.position.x, 0.14, pad.position.z);
      scene.add(view.group);
      towerViews.set(tower.entityId, view);
    }
  }
  for (const [entityId, view] of towerViews) {
    if (aliveTowers.has(entityId)) {
      continue;
    }
    scene.remove(view.group);
    view.release();
    towerViews.delete(entityId);
  }

  const aliveEnemies = new Set<number>();
  for (const enemy of next.enemies) {
    aliveEnemies.add(enemy.entityId);
    let view = enemyViews.get(enemy.entityId);
    if (!view) {
      view = createEnemyView(enemy.enemyId);
      scene.add(view.group);
      enemyViews.set(enemy.entityId, view);
    }
    view.group.position.set(enemy.x, enemyBaseY, enemy.z);
    const healthRatio = enemy.maxHealth > 0 ? Math.max(0, Math.min(1, enemy.health / enemy.maxHealth)) : 0;
    view.healthFill.scale.x = Math.max(healthRatio, 0.001);
    view.healthFill.position.x = -0.38 + 0.38 * healthRatio;
    const bodyMaterial = view.body.material as THREE.MeshStandardMaterial;
    bodyMaterial.emissiveIntensity = enemy.slowTicks > 0 ? slowedBodyEmissive : baseBodyEmissive;
  }
  for (const [entityId, view] of enemyViews) {
    if (aliveEnemies.has(entityId)) {
      continue;
    }
    scene.remove(view.group);
    disposeInstance(view.group);
    enemyViews.delete(entityId);
  }

  const integrity = next.maxCoreHealth > 0 ? next.coreHealth / next.maxCoreHealth : 0;
  coreCrystal.material.emissiveIntensity = 0.6 + 1.5 * integrity;
  const defeated = next.status === 'defeat';
  if (defeated !== coreDefeated) {
    coreDefeated = defeated;
    coreCrystal.material.emissive.copy(defeated ? coreFailing : coreHealthy);
  }

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
    setFeedback('accepted', `${name} built on ${command.padId}`);
    return;
  }
  const reason = result.reason ?? 'rejected';
  if (reason === replayBlockedReason) {
    // The guard already explained that the recorded run owns the core; a pad flash would claim the core
    // rejected a build it never saw.
    setFeedback('rejected', replayBlockedFeedback, reason);
    return;
  }
  if (command.type === 'placeTower') {
    flashPadError(command.padId);
  }
  setFeedback('rejected', rejectionMessages[reason] ?? `Rejected: ${reason}`, reason);
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

const clearCombatBursts = () => {
  for (const burst of combatBursts) {
    removeCombatBurst(burst);
  }
  combatBursts.length = 0;
};

const resetEventPresentations = () => {
  for (const type of Object.keys(eventCounts) as Array<keyof typeof eventCounts>) {
    eventCounts[type] = 0;
  }
  recentEvents.length = 0;
  eventFeedEntries.length = 0;
  renderEventFeed();
  eventsDrained = 0;
  coreDamagedUntil = 0;
  clearCombatBursts();
  for (const view of towerViews.values()) {
    view.firedUntil = 0;
  }
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
};

const restartMatch = () => {
  beginRecordedRun(null);
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
};

type SaveSlotReading =
  | { state: 'empty' }
  | { state: 'ready'; payload: MatchSavePayload }
  | { state: 'refused'; reason: string; message: string };

const refuseSlot = (reason: string, message: string): SaveSlotReading => ({ state: 'refused', reason, message });

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
    return { state: 'empty' };
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

  const candidate = parsed as Partial<Record<keyof MatchSavePayload, unknown>>;
  if (candidate.schemaVersion !== MATCH_SAVE_SCHEMA) {
    return refuseSlot(
      'save-schema-version',
      `Save format v${String(candidate.schemaVersion)} is not the v${MATCH_SAVE_SCHEMA} this build reads · slot left untouched`,
    );
  }
  if (candidate.contentVersion !== TRAINING_CONTENT_VERSION) {
    return refuseSlot(
      'save-content-version',
      `Save holds content v${String(candidate.contentVersion)} · this build runs v${TRAINING_CONTENT_VERSION} · slot left untouched`,
    );
  }
  if (candidate.seed !== config.seed) {
    return refuseSlot(
      'save-seed-mismatch',
      `Save holds seed ${String(candidate.seed)} · this build runs ${config.seed} · slot left untouched`,
    );
  }
  const tick = candidate.tick;
  if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0) {
    return refuseSlot(
      'save-tick-invalid',
      `Save tick ${String(tick)} is not a whole tick count · slot left untouched`,
    );
  }
  if (!Array.isArray(candidate.log)) {
    return refuseSlot('save-log-invalid', 'Save holds no command log · slot left untouched');
  }
  if (candidate.log.length > MAX_SAVED_COMMANDS) {
    return refuseSlot(
      'save-log-invalid',
      `Save claims ${candidate.log.length} commands · limit is ${MAX_SAVED_COMMANDS} · slot left untouched`,
    );
  }

  const log: SavedCommandEntry[] = [];
  let previousTick = 0;
  for (const [index, entry] of candidate.log.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      return refuseSlot('save-entry-shape', `Save command ${index} is not a record · slot left untouched`);
    }
    const { tick: entryTick, command } = entry as { tick?: unknown; command?: unknown };
    if (typeof entryTick !== 'number' || !Number.isInteger(entryTick) || entryTick < 0 || entryTick > tick) {
      return refuseSlot(
        'save-entry-tick-out-of-range',
        `Save command ${index} claims tick ${String(entryTick)} outside [0, ${tick}] · slot left untouched`,
      );
    }
    // The replay applies a command on the tick it names and can only move forward, so a log that
    // goes back in time is not a run this client could rebuild. This is a property of the artifact.
    if (index > 0 && entryTick < previousTick) {
      return refuseSlot(
        'save-entry-out-of-order',
        `Save command ${index} claims tick ${entryTick} after tick ${previousTick} · slot left untouched`,
      );
    }
    if (!isKnownCommand(command)) {
      return refuseSlot(
        'save-command-unknown',
        `Save command ${index} is not a command this build knows · slot left untouched`,
      );
    }
    log.push({ tick: entryTick, command });
    previousTick = entryTick;
  }

  return {
    state: 'ready',
    payload: {
      schemaVersion: MATCH_SAVE_SCHEMA,
      contentVersion: TRAINING_CONTENT_VERSION,
      seed: config.seed,
      tick,
      log,
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
let slotReading: SaveSlotReading = { state: 'empty' };

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
  if (mode === 'remote') {
    // A room's match has no slot in this browser, and the panel is not allowed to describe a slot that
    // belongs to a different match: a leftover local save sitting under a room that never asked for it
    // would name a tick and a command count of a game that is not on screen. The line says what the
    // panel is instead.
    saveSlotLabel.textContent = 'Room match · not saved here';
    saveSlotLabel.dataset.state = 'room';
    loadButton.disabled = true;
    return slotReading;
  }
  const reading = readSaveSlot();
  slotReading = reading;
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
  // Continue is offered whenever there is something to continue: a save to rebuild, or a match of the
  // player's own to go back into. It stays available in the armed state, which is the way out of it
  // that does not destroy anything. Neither action exists in a room, where both would act on a match
  // this page does not own.
  entryContinueButton.hidden = !entryOpen || entryMode === 'empty' || inRoom;
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
  // something to continue and on New match when there is not. A room has one action of its own.
  if (mode === 'remote') {
    entryJoinRoom.focus();
    return;
  }
  (entryContinueButton.hidden ? entryNewMatchButton : entryContinueButton).focus();
};

const closeEntry = () => {
  entryOpen = false;
  entryArmed = false;
  syncEntry();
  // Focus goes back where it came from: MENU returns the player to the button that opened the entry,
  // and the boot entry hands over to the control the next action starts from.
  (entryFromMenu ? menuButton : startWaveButton).focus();
};

// Continue is the same call as the dock's Load, and nothing else. On the boot entry there is no match
// of the player's own yet, so continuing means rebuilding the saved one. From MENU the match is
// still there, so continuing means letting it run again: rebuilding it from the slot would replace a
// match nobody asked to replace, with a copy of one that may be several ticks behind it.
const continueFromEntry = () => {
  if (entryFromMenu) {
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
let sessionSource: EventSource | null = null;
let forcedHandshake: Partial<HandshakeRequest> | null = null;

// Enough of the recent stream to compare two clients of one room at a sequence number they both saw. A
// client that joined late is missing the frames before its own, so the two logs only overlap from the
// moment of its first frame onwards, and that overlap is the only place a comparison means anything.
const FRAME_LOG_LIMIT = 64;
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
      return `${clientCountLabel(sessionPlayers)} · the room's clock`;
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
    return `The room did not take this client: ${sessionRefusal?.found ?? 'no reason given'}. The versions both sides run are named on the line above.`;
  }
  if (sessionState === 'live') {
    return 'The room owns this match. Commands go to it, and every client in it sees the same state.';
  }
  if (sessionState === 'offline') {
    return 'The update stream stopped. The match has not paused — the room went on without this client.';
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
  entryJoinRoom.textContent = live ? 'Leave room' : mode === 'solo' ? 'Join room' : 'Enter room';
  entryJoinRoom.dataset.action = live ? 'leave' : 'enter';
  entryJoinRoom.disabled = !live && !isRoomName(entryRoomInput.value);
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
  sessionClientId = null;
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
  const declared: HandshakeRequest = {
    role: 'player',
    protocolVersion: PROTOCOL_VERSION,
    contentVersion: CONTENT_VERSION,
    mapVersion: MAP_VERSION,
    seed: config.seed,
    ...(forcedHandshake ?? {}),
  };
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
  const answer = readHandshakeAnswer(parsed);
  if (answer === null) {
    closeSession('refused', 'handshake-shape', 'the answer was not a handshake this build reads');
    return;
  }
  if (!answer.accepted) {
    // The refusal is the room's sentence about the numbers this client sent, and it is shown as it came
    // back. The match does not start, the stream is never opened, and the local core is never touched.
    closeSession('refused', answer.reason, answer.found);
    return;
  }
  sessionClientId = answer.clientId;
  sessionVersions = answer.versions;
  sessionTickRate = answer.tickRate;

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
    // No automatic reconnection: a client that quietly starts guessing where it left off is the failure
    // mode this whole phase exists to prevent, and `0018` is where reconnect becomes a policy.
    closeSession('offline', 'stream-refused', sessionRoomId);
  };
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
    // the same address walks in through the handshake again. Reconnecting in place is `0018`.
    window.location.assign('/');
    return;
  }
  const wanted = entryRoomInput.value.trim().toLowerCase();
  if (!isRoomName(wanted)) {
    return;
  }
  if (mode === 'remote' && wanted === sessionRoomId) {
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

const readRebuildReading = (arrival: { requestedTick: number; tick: number }): RebuildReading => ({
  requestedTick: arrival.requestedTick,
  tick: arrival.tick,
  snapshot,
  eventCounts: { ...eventCounts },
  commandCount: commandLog.length,
  replayIndex,
  replaying,
  matchReports: matchReports.map((report) => ({ ...report, eventCounts: { ...report.eventCounts } })),
  poses: Array.from(towerViews, ([entityId, view]) => ({
    entityId,
    towerId: view.towerId,
    clip: view.clip === null ? null : readTowerClip(view.clip),
  })),
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
      return 'Prep window elapsed · start the wave';
    case 'waveStarted':
      return `Wave ${event.waveIndex + 1} engaged · roll ${event.roll.toFixed(2)}`;
    case 'enemySpawned':
      return `${enemyName(event.enemyId)} inbound`;
    case 'towerFired':
      return null;
    case 'enemyKilled':
      return `Target down · +${event.reward} aether`;
    case 'coreDamaged':
      return `Core hit · -${event.amount} integrity`;
    case 'waveCleared':
      return `Wave ${event.waveIndex + 1} cleared · leaks ${event.leaks} · bounty ${event.bounty}`;
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

const spawnCombatBurst = (position: THREE.Vector3) => {
  const mesh = new THREE.Mesh(
    combatBurstGeometry,
    new THREE.MeshBasicMaterial({
      color: combatBurstColor,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(position.x, enemyBaseY + 0.08, position.z);
  scene.add(mesh);
  combatBursts.push({ mesh, started: elapsed, duration: combatBurstSeconds });
  while (combatBursts.length > MAX_COMBAT_BURSTS) {
    const stale = combatBursts.shift();
    if (stale) {
      removeCombatBurst(stale);
    }
  }
};

const applyEventPresentation = (event: SimulationEvent) => {
  if (event.type === 'towerFired') {
    const view = towerViews.get(event.entityId);
    if (!view || reducedMotion) {
      return;
    }
    view.firedUntil = elapsed + towerFireFlashSeconds;
    const target = enemyViews.get(event.targetId);
    if (target) {
      // Three.js rotates local +X toward -Z, so the Y angle is negated.
      view.aimAngle = Math.atan2(
        -(target.group.position.z - view.group.position.z),
        target.group.position.x - view.group.position.x,
      );
    }
    return;
  }
  if (event.type === 'enemyKilled') {
    const view = enemyViews.get(event.entityId);
    if (view && !reducedMotion) {
      spawnCombatBurst(view.group.position);
    }
    return;
  }
  if (event.type === 'coreDamaged') {
    coreDamagedUntil = elapsed + coreDamageFlashSeconds;
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
// techdebt: fixed generous hit radius, no occlusion test against towers; revisit when camera zoom or drag-rotate lands.
const PAD_PICK_RADIUS = 0.85;
const padPickPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -PAD_PICK_HEIGHT);
const padRaycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();
const planeHit = new THREE.Vector3();
const projectedPad = new THREE.Vector3();

const pickPad = (clientX: number, clientY: number): string | null => {
  const rect = renderer.domElement.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  pointerNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointerNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  padRaycaster.setFromCamera(pointerNdc, camera);

  const [direct] = padRaycaster.intersectObjects(padPickTargets, false);
  const directPadId = direct?.object.userData.padId;
  if (typeof directPadId === 'string') {
    return directPadId;
  }

  if (!padRaycaster.ray.intersectPlane(padPickPlane, planeHit)) {
    return null;
  }
  let nearestPadId: string | null = null;
  let nearestDistance = PAD_PICK_RADIUS;
  for (const pad of config.map.buildPads) {
    const distance = Math.hypot(planeHit.x - pad.position.x, planeHit.z - pad.position.z);
    if (distance <= nearestDistance) {
      nearestDistance = distance;
      nearestPadId = pad.id;
    }
  }
  return nearestPadId;
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

const flashPadError = (padId: string) => {
  const padView = padViews.get(padId);
  if (padView) {
    padView.errorUntil = elapsed + padErrorFlashSeconds;
    refreshPadStyle(padView);
  }
};

// A pad click and Start Wave are the only two ways a player starts anything, and both go through the one
// function that decides where the intent goes. There is no third path and no mode that builds locally.
const attemptPlacement = (padId: string) => {
  submitCommand({ type: 'placeTower', padId, towerId: selectedTowerId });
};

renderer.domElement.addEventListener('click', (event) => {
  const padId = pickPad(event.clientX, event.clientY);
  if (padId) {
    attemptPlacement(padId);
  }
});

const attemptWaveStart = () => {
  submitCommand({ type: 'startWave' });
};

startWaveButton.addEventListener('click', attemptWaveStart);

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
saveButton.addEventListener('click', saveMatch);
loadButton.addEventListener('click', () => {
  loadMatch();
});
newMatchButton.addEventListener('click', newMatch);
reducedMotionQuery.addEventListener('change', (event) => {
  reducedMotion = event.matches;
  if (!reducedMotion) {
    return;
  }
  // Turning reduced motion on mid-match has to do the same thing it does from the start: the clip
  // stops, and the bones go back to the rest pose instead of freezing wherever the last frame left
  // them. Reading the pose from `setTime(0)` before the action stops is what applies it.
  for (const view of towerViews.values()) {
    if (view.clip === null) {
      continue;
    }
    view.clip.mixer.setTime(0);
    view.clip.action.stop();
  }
});

syncSelection();
setFeedback('idle', 'Left click a build pad to place');
applySnapshot(snapshot);
// The page opens on the entry screen rather than in a preparation: the slot is looked at, never
// loaded, and the match behind the overlay is a fresh preparation of tick 0 that the player has not
// asked for yet. Nothing runs until an action on the entry says so.
setSaveFeedback('idle', mode === 'remote' ? `Room ${sessionRoomId ?? ''} · the room keeps the state` : 'Local slot · this browser');
// The controls that act on a local `Simulation` say so in a room instead of sitting there inert with a
// solo tooltip. A disabled button with the wrong explanation is worse than no button, because it tells
// the reader what the control would have done.
if (mode === 'remote') {
  pauseToggle.title = 'The room owns the clock in a room; there is nothing here to pause';
  restartButton.title = 'A room keeps its own match; Restart has no core to rebuild here';
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
      pads: padViews.size,
      towers: towerViews.size,
      enemies: enemyViews.size,
      routeSegments: routeSegmentCount,
    };
  },
  get towerPositions() {
    return Array.from(towerViews.values(), (view) => ({ x: view.group.position.x, z: view.group.position.z }));
  },
  get enemyPositions() {
    return Array.from(enemyViews.values(), (view) => ({ x: view.group.position.x, z: view.group.position.z }));
  },
  get padScreenPositions() {
    return config.map.buildPads
      .map((pad) => projectPadToCanvas(pad.id))
      .filter((point): point is { padId: string; x: number; y: number } => point !== null);
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
  get frames() {
    return framesRendered;
  },
  get matchReports() {
    return matchReports.map((report) => ({ ...report, eventCounts: { ...report.eventCounts } }));
  },
  get lastRebuild() {
    return lastRebuild;
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
    const clips = Array.from(towerViews.values(), (view) => view.clip);
    return {
      reducedMotion,
      combatBursts: combatBursts.length,
      enemyBob: enemyBobOffset,
      // One mixer per animated view and no more: a tower that was removed or upgraded in place must
      // not leave a second animation running against the same skeleton.
      clips: clips.filter((clip) => clip !== null).length,
      clipsPlaying: clips.filter((clip) => clip?.action.isRunning() === true).length,
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
      budgets: { model: MODEL_BUDGET, registry: REGISTRY_BUDGET, scene: SCENE_BUDGET },
      checks: assetRegistry.checks,
      failures: [
        ...assetRegistry.modelChecks.flatMap((check) => check.failures),
        ...[...registryBudgetFailures, ...sceneBudgetFailures].map((failure) => failure.reason),
      ],
    };
  },
  get towerModels(): TowerModelReading[] {
    return Array.from(towerViews, ([entityId, view]) => ({
      entityId,
      towerId: view.towerId,
      source: view.source,
      modelId: view.modelId,
      meshCount: countMeshes(view.group),
      // The procedural placeholder has no name on its emissive mesh, so this is also the
      // cheapest way to see which node of the model the client ended up animating.
      crystalNode: view.crystal.name || null,
      crystalBaseY: view.crystalBaseY,
      crystalY: view.crystal.position.y,
      crystalScale: view.crystal.scale.x,
      crystalEmissive: view.crystalMaterial.emissiveIntensity,
      clip: view.clip === null ? null : readTowerClip(view.clip),
    }));
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
    accumulator += frameDelta;
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
  enemyBobOffset = 0;
  for (const padView of padViews.values()) {
    if (padView.errorUntil > 0 && elapsed >= padView.errorUntil) {
      padView.errorUntil = 0;
      refreshPadStyle(padView);
    }
  }
  let towerSlot = 0;
  for (const view of towerViews.values()) {
    if (elapsed < view.firedUntil) {
      view.group.rotation.y = view.aimAngle;
      view.crystal.scale.setScalar(1.55);
      view.crystalMaterial.emissiveIntensity = towerCrystalFireIntensity;
    } else {
      view.group.rotation.y += ambientDelta * (0.34 + towerSlot * 0.08);
      view.crystal.scale.setScalar(1);
      view.crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
    }
    view.crystal.position.y = view.crystalBaseY + (reducedMotion ? 0 : Math.sin(elapsed * 2.1 + towerSlot) * 0.07);
    // The clip and the bob share one reduced-motion guard and two clocks. The skeleton is brought
    // up to the match clock rather than advanced by the frame, so the pose of a tick is a function
    // of that tick: a tower built by a pad click and the same tower rebuilt by a replay both start
    // at zero on the tick they were placed, and the terminal tick holds its pose in both runs.
    if (view.clip !== null && !reducedMotion) {
      const due = presentationTime() - view.clip.applied;
      if (due > 0) {
        view.clip.mixer.update(due);
        view.clip.applied = presentationTime();
      }
    }
    towerSlot += 1;
  }
  let enemySlot = 0;
  for (const view of enemyViews.values()) {
    view.group.rotation.y += ambientDelta * (0.7 + enemySlot * 0.12);
    const bob = reducedMotion ? 0 : Math.sin(elapsed * 2.8 + enemySlot * 0.7) * 0.045;
    view.group.position.y = enemyBaseY + bob;
    enemyBobOffset = Math.max(enemyBobOffset, Math.abs(bob));
    enemySlot += 1;
  }
  for (let index = combatBursts.length - 1; index >= 0; index -= 1) {
    const burst = combatBursts[index];
    if (!burst) {
      continue;
    }
    const progress = (elapsed - burst.started) / burst.duration;
    if (progress >= 1) {
      removeCombatBurst(burst);
      combatBursts.splice(index, 1);
      continue;
    }
    (burst.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - progress);
    burst.mesh.scale.setScalar(1 + progress * 1.9);
  }
  // The terminal state wins over the transient damage pulse, and reduced motion keeps
  // the readable colour change without the scale pulse.
  const coreFlashing = elapsed < coreDamagedUntil && !coreDefeated;
  coreRing.material.color.copy(coreFlashing ? coreWarningRing : coreDefeated ? coreFailing : coreHealthyRing);
  const corePulse = coreFlashing && !reducedMotion ? 1 + 0.18 * (1 - (coreDamagedUntil - elapsed) / coreDamageFlashSeconds) : 1;
  coreRing.scale.setScalar(corePulse);
  coreCrystal.rotation.y += ambientDelta * 0.6;
  coreRing.rotation.z += ambientDelta * 0.25;
  particles.rotation.y += ambientDelta * 0.08;
  // The arrival of a rebuild is recorded here, at the end of the frame that got there, so the
  // reading belongs to the same tick as the presentation around it and not to the frame before.
  if (pendingRebuild !== null) {
    lastRebuild = readRebuildReading(pendingRebuild);
    pendingRebuild = null;
  }
  renderer.render(scene, camera);
  sampleSceneBudget();
  requestAnimationFrame(renderFrame);
};

requestAnimationFrame(renderFrame);
