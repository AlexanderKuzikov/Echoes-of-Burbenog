import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { TICK_RATE, createSimulation, createTrainingScenario } from './game-core/index.ts';
import type { Command, CommandResult, MatchSnapshot, MatchStatus, SimulationEvent } from './game-core/index.ts';
import { ASSET_MANIFEST_URL, AssetContractError, createAssetRegistry, parseAssetManifest, resolveModelUrl } from './asset-registry.ts';
import type { AssetChecks, AssetRegistry, AssetStatus, ModelCheck, ModelManifestEntry } from './asset-registry.ts';
import {
  MODEL_BUDGET,
  REGISTRY_BUDGET,
  SCENE_BUDGET,
  checkModelContract,
  checkNodeTypes,
  checkRegistryBudgets,
  checkSceneBudget,
  describeFailures,
  sumRegistry,
} from './asset-budgets.ts';
import type { AssetFailure, NodeReading, SceneReading } from './asset-budgets.ts';
import './styles.css';

type RenderCounters = {
  pads: number;
  towers: number;
  enemies: number;
  routeSegments: number;
};

type CommandLogEntry = {
  tick: number;
  command: Command;
};

type MatchReport = {
  status: MatchStatus;
  tick: number;
  gold: number;
  coreHealth: number;
  leaksThisWave: number;
  eventCounts: Record<SimulationEvent['type'], number>;
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
  dispatch: (command: Command) => CommandResult;
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
  readonly motion: { reducedMotion: boolean; combatBursts: number; enemyBob: number };
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
  !restartButton
) {
  throw new Error('Bootstrap DOM is incomplete');
}

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
// of that type at the same time. No skin, no morph and no clip, so a structural clone is the
// whole of what instantiating a model needs.
const cloneModelNode = (source: THREE.Object3D, owned: THREE.Material[]): THREE.Object3D => {
  if (source instanceof THREE.Mesh) {
    const material = (source.material as THREE.Material).clone();
    owned.push(material);
    const mesh = new THREE.Mesh(source.geometry, material);
    mesh.name = source.name;
    mesh.position.copy(source.position);
    mesh.quaternion.copy(source.quaternion);
    mesh.scale.copy(source.scale);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
  const group = new THREE.Group();
  group.name = source.name;
  group.position.copy(source.position);
  group.quaternion.copy(source.quaternion);
  group.scale.copy(source.scale);
  for (const child of source.children) {
    group.add(cloneModelNode(child, owned));
  }
  return group;
};

const createModelTowerView = (towerId: string, model: LoadedModel): TowerView => {
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
  return {
    towerId,
    group,
    crystal: emissive,
    crystalMaterial,
    crystalBaseY: emissive.position.y,
    source: 'model',
    modelId: model.entry.id,
    firedUntil: 0,
    aimAngle: 0,
    release: () => {
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
    firedUntil: 0,
    aimAngle: 0,
    release: () => disposeInstance(group),
  };
};

const createTowerView = (towerId: string): TowerView => {
  const model = modelStore.get(towerId);
  return model ? createModelTowerView(towerId, model) : createProceduralTowerView(towerId);
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
  const failures = [
    ...checkModelContract({ id: entry.id, bytes: entry.bytes, triangles: entry.triangles }),
    ...checkNodeTypes(entry.id, nodes),
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
  return { entry, scene: gltf.scene, emissiveNode: entry.emissiveNode };
};

// The status line is a single line of viewport chrome, and two whole digests are exactly what
// pushed the sector caption out of the way. Only the display is shortened: `assets.error` and
// `assetBudgets.failures` keep the full reason, so an operator reading the seam still gets the
// exact value to compare.
const viewportRefusal = (reason: string): string => reason.replace(/(sha256:)([0-9a-f]{8})[0-9a-f]+/gi, '$1$2…');

const applyAssetStatus = () => {
  const status = assetRegistry.status;
  viewportShell.dataset.assets = status;
  if (status === 'ready') {
    // Which checks ran is part of the message, not a detail of the debug seam: without it a
    // skipped hash verification is indistinguishable from a passed one.
    const integrity = assetRegistry.checks.performed.contentHash
      ? 'integrity checked'
      : `content hash not checked (${assetRegistry.modelChecks.find((check) => check.contentHash.skippedReason)?.contentHash.skippedReason ?? 'no reason given'})`;
    const overBudget = sceneBudgetFailures.length > 0 ? ` · scene over budget: ${describeFailures(sceneBudgetFailures)}` : '';
    statusLabel.textContent = `Scene online · models ready (${assetRegistry.modelIds.join(', ')}) · ${integrity}${overBudget}`;
    return;
  }
  if (status === 'error') {
    statusLabel.textContent = `Scene online · model registry failed: ${viewportRefusal(assetRegistry.error ?? 'unknown reason')}`;
    return;
  }
  statusLabel.textContent = 'Scene online · loading models';
};

// Two-phase swap. A view built before the registry answered keeps rendering, and once the model
// is in it is replaced in place: no entity is recreated, no position changes and the snapshot is
// not touched, so a late model cannot make two replays of the same run look different.
const upgradeTowerViews = () => {
  for (const [entityId, view] of [...towerViews]) {
    if (view.source === 'model' || !modelStore.has(view.towerId)) {
      continue;
    }
    const next = createTowerView(view.towerId);
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
  startWaveButton.disabled = snapshot.status !== 'preparation' || replaying;
  restartButton.disabled = commandLog.length === 0;
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
    option.button.disabled = replaying;
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
      view = createTowerView(tower.towerId);
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
  eventsDrained += consumeEvents();
  applySnapshot(simulation.getSnapshot());
  return result;
};

const replayBlockedReason = 'replay-in-progress';
const replayBlockedFeedback = 'Recorded run is replaying · commands are locked until it finishes';

// Player intent is logged with the tick it was issued on. Seed plus the tick-ordered
// log is the whole input of a match, so replaying the log on a fresh core reproduces it.
// This is also the only place that may append to the log, so it carries the replay guard:
// while a replay is running nothing outside `applyReplayPlan` can fork the run, no matter
// whether the command arrives from a pad click, Start Wave or the QA seam.
const dispatchPlayerCommand = (command: Command): CommandResult => {
  if (replaying) {
    setFeedback('rejected', replayBlockedFeedback, replayBlockedReason);
    return { accepted: false, reason: replayBlockedReason };
  }
  commandLog.push({ tick: snapshot.tick, command });
  return dispatchCommand(command);
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

// Client-side QA restart: a new core from the same seed and content, with the recorded
// commands re-applied at their original ticks by the frame loop. No persistence involved,
// and the pause state stays as the player left it, so a frozen clock stays frozen.
const restartMatch = () => {
  simulation = createSimulation(config);
  terminalReported = false;
  accumulator = 0;
  resetEventPresentations();
  replayIndex = 0;
  replaying = commandLog.length > 0;
  setFeedback('idle', replaying ? 'Replaying recorded commands' : 'Nothing recorded yet · place a module first');
  applySnapshot(simulation.getSnapshot());
};

const applyReplayPlan = () => {
  while (replayIndex < commandLog.length && snapshot.tick >= commandLog[replayIndex].tick) {
    const entry = commandLog[replayIndex];
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

const consumeEvents = (): number => {
  const drained = simulation.drainEvents();
  if (drained.length === 0) {
    return 0;
  }
  let feedDirty = false;
  for (const event of drained) {
    eventCounts[event.type] += 1;
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
  return drained.length;
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

const attemptPlacement = (padId: string) => {
  const result = dispatchPlayerCommand({ type: 'placeTower', padId, towerId: selectedTowerId });
  const name = towerDefinitions.get(selectedTowerId)?.name ?? selectedTowerId;
  if (result.accepted) {
    setFeedback('accepted', `${name} built on ${padId}`);
    return;
  }
  const reason = result.reason ?? 'rejected';
  if (reason === replayBlockedReason) {
    // The guard already explained that the recorded run owns the core; a pad flash
    // would claim the core rejected a build it never saw.
    return;
  }
  flashPadError(padId);
  setFeedback('rejected', rejectionMessages[reason] ?? `Rejected: ${reason}`, reason);
};

renderer.domElement.addEventListener('click', (event) => {
  const padId = pickPad(event.clientX, event.clientY);
  if (padId) {
    attemptPlacement(padId);
  }
});

const attemptWaveStart = () => {
  const result = dispatchPlayerCommand({ type: 'startWave' });
  if (result.accepted) {
    setFeedback('accepted', `Wave ${snapshot.waveIndex + 1} started`);
    return;
  }
  const reason = result.reason ?? 'rejected';
  if (reason === replayBlockedReason) {
    return;
  }
  setFeedback('rejected', rejectionMessages[reason] ?? `Rejected: ${reason}`, reason);
};

startWaveButton.addEventListener('click', attemptWaveStart);

// Pause is a clock control only: commands still reach the core, but `step()` does not
// run, so the snapshot, the projection and the rendered positions stay frozen.
const setPaused = (next: boolean) => {
  paused = next;
  syncHud();
};

pauseToggle.addEventListener('click', () => {
  setPaused(!paused);
});
restartButton.addEventListener('click', restartMatch);
reducedMotionQuery.addEventListener('change', (event) => {
  reducedMotion = event.matches;
});

syncSelection();
setFeedback('idle', 'Left click a build pad to place');
applySnapshot(snapshot);
void bootAssets();

let accumulator = 0;
let previousTimestamp = performance.now();

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
  get matchReports() {
    return matchReports.map((report) => ({ ...report, eventCounts: { ...report.eventCounts } }));
  },
  get motion() {
    return { reducedMotion, combatBursts: combatBursts.length, enemyBob: enemyBobOffset };
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
    }));
  },
  // The QA seam goes through the logging path as well, so the command log always stays
  // the complete input of the match that Restart replays.
  dispatch: dispatchPlayerCommand,
};

const renderFrame = (timestamp: number) => {
  const frameDelta = Math.min((timestamp - previousTimestamp) / 1000, 0.25);
  previousTimestamp = timestamp;
  if (!paused) {
    accumulator += frameDelta;
    let stepped = false;
    while (accumulator >= STEP_SECONDS) {
      simulation.step();
      accumulator -= STEP_SECONDS;
      stepped = true;
    }
    if (stepped) {
      eventsDrained += consumeEvents();
      syncFromCore();
    }
    if (replaying) {
      applyReplayPlan();
    }
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
  renderer.render(scene, camera);
  sampleSceneBudget();
  requestAnimationFrame(renderFrame);
};

requestAnimationFrame(renderFrame);
