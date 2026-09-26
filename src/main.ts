import * as THREE from 'three';
import { TICK_RATE, createSimulation, createTrainingScenario } from './game-core/index.ts';
import type { Command, CommandResult, MatchSnapshot } from './game-core/index.ts';
import './styles.css';

type RenderCounters = {
  pads: number;
  towers: number;
  enemies: number;
  routeSegments: number;
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
};

type FeedbackState = 'idle' | 'accepted' | 'rejected';

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

type TowerView = {
  group: THREE.Group;
  crystal: THREE.Mesh;
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

if (
  !sceneMount ||
  !statusLabel ||
  !selectionStatus ||
  !commandFeedback ||
  !selectionCardName ||
  !selectionCardDetail ||
  !goldValue ||
  !integrityValue ||
  !waveValue
) {
  throw new Error('Bootstrap DOM is incomplete');
}

const config = createTrainingScenario();
const simulation = createSimulation(config);
const padDefinitions = new Map(config.map.buildPads.map((pad) => [pad.id, pad]));
const towerDefinitions = new Map(config.towers.map((tower) => [tower.id, tower]));
const waveCount = config.waves.length;
const STEP_SECONDS = 1 / TICK_RATE;

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

const groundMaterial = new THREE.MeshStandardMaterial({
  color: 0x163039,
  roughness: 0.92,
  metalness: 0.04,
});
const ground = new THREE.Mesh(new THREE.PlaneGeometry(config.map.width, config.map.depth), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(config.map.width, config.map.width, 0x3d7376, 0x24464e);
grid.position.y = 0.012;
scene.add(grid);

const pathMaterial = new THREE.MeshStandardMaterial({
  color: 0x2e5c5c,
  emissive: 0x0c2425,
  emissiveIntensity: 0.65,
  roughness: 0.82,
});
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
    new THREE.MeshStandardMaterial({
      color: 0x2b7073,
      emissive: 0x0b3135,
      emissiveIntensity: 0.9,
      roughness: 0.48,
      metalness: 0.18,
    }),
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
const createTowerView = (towerId: string): TowerView => {
  const visual = towerVisuals[towerId] ?? unknownTowerVisual;
  const group = new THREE.Group();
  group.scale.setScalar(visual.scale);
  group.name = `tower:${towerId}`;

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
    new THREE.MeshStandardMaterial({ color: 0x1d4651, roughness: 0.46, metalness: 0.34 }),
  );
  base.position.y = 0.15;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);

  const stem = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.28, 0.78, 6),
    new THREE.MeshStandardMaterial({ color: 0x346f75, roughness: 0.34, metalness: 0.5 }),
  );
  stem.position.y = 0.5;
  stem.castShadow = true;
  group.add(stem);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(0.45, 0.42, 6),
    new THREE.MeshStandardMaterial({ color: visual.roof, roughness: 0.3, metalness: 0.3 }),
  );
  roof.position.y = 1.08;
  roof.castShadow = true;
  group.add(roof);

  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.18, 0),
    new THREE.MeshStandardMaterial({
      color: visual.accent,
      emissive: visual.accent,
      emissiveIntensity: 2.4,
      roughness: 0.18,
      metalness: 0.15,
    }),
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

  return { group, crystal };
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
    new THREE.MeshStandardMaterial({ color: visual.color, emissive: visual.color, emissiveIntensity: 0.45, roughness: 0.62 }),
  );
  body.castShadow = true;
  group.add(body);

  const crest = new THREE.Mesh(
    new THREE.ConeGeometry(0.18, 0.42, 5),
    new THREE.MeshStandardMaterial({ color: 0xf3b77b, roughness: 0.5 }),
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

const core = new THREE.Group();
core.position.set(config.map.corePosition.x, 0.3, config.map.corePosition.z);
core.name = 'core';
const coreBase = new THREE.Mesh(
  new THREE.CylinderGeometry(0.8, 0.95, 0.32, 8),
  new THREE.MeshStandardMaterial({ color: 0x285a62, roughness: 0.38, metalness: 0.42 }),
);
coreBase.castShadow = true;
core.add(coreBase);
const coreCrystal = new THREE.Mesh(
  new THREE.OctahedronGeometry(0.7, 1),
  new THREE.MeshStandardMaterial({
    color: 0x7ce7d2,
    emissive: 0x2ac7b5,
    emissiveIntensity: 1.8,
    roughness: 0.16,
    metalness: 0.22,
  }),
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

const rejectionMessages: Record<string, string> = {
  'pad-occupied': 'Pad already occupied',
  'not-enough-gold': 'Not enough aether',
  'unknown-pad': 'Unknown build pad',
  'unknown-tower': 'Unknown module',
  'match-finished': 'Match already finished',
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
const coreFailing = new THREE.Color(0xe46c62);
const baseBodyEmissive = 0.45;
const slowedBodyEmissive = 1.15;
const enemyBaseY = 0.28;
const padErrorFlashSeconds = 0.7;

let elapsed = 0;

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

let coreDefeated = false;
let snapshot = simulation.getSnapshot();

const syncHud = () => {
  goldValue.textContent = String(snapshot.gold);
  const integrity = snapshot.maxCoreHealth > 0 ? snapshot.coreHealth / snapshot.maxCoreHealth : 0;
  integrityValue.textContent = `${Math.round(integrity * 100)}%`;
  waveValue.textContent = `${String(snapshot.waveIndex + 1).padStart(2, '0')} / ${String(waveCount).padStart(2, '0')}`;
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
    disposeInstance(view.group);
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
    coreRing.material.color.copy(defeated ? coreFailing : padFreeRing);
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
  applySnapshot(simulation.getSnapshot());
  return result;
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
  const result = dispatchCommand({ type: 'placeTower', padId, towerId: selectedTowerId });
  const name = towerDefinitions.get(selectedTowerId)?.name ?? selectedTowerId;
  if (result.accepted) {
    setFeedback('accepted', `${name} built on ${padId}`);
    return;
  }
  const reason = result.reason ?? 'rejected';
  flashPadError(padId);
  setFeedback('rejected', rejectionMessages[reason] ?? `Rejected: ${reason}`, reason);
};

renderer.domElement.addEventListener('click', (event) => {
  const padId = pickPad(event.clientX, event.clientY);
  if (padId) {
    attemptPlacement(padId);
  }
});

syncSelection();
setFeedback('idle', 'Left click a build pad to place');
applySnapshot(snapshot);

let eventsDrained = 0;
let accumulator = 0;
let previousTimestamp = performance.now();

statusLabel.textContent = 'Scene online';
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
  dispatch: dispatchCommand,
};

const renderFrame = (timestamp: number) => {
  const frameDelta = Math.min((timestamp - previousTimestamp) / 1000, 0.25);
  previousTimestamp = timestamp;
  accumulator += frameDelta;
  let stepped = false;
  while (accumulator >= STEP_SECONDS) {
    simulation.step();
    accumulator -= STEP_SECONDS;
    stepped = true;
  }
  if (stepped) {
    eventsDrained += simulation.drainEvents().length;
    syncFromCore();
  }

  elapsed += frameDelta;
  for (const padView of padViews.values()) {
    if (padView.errorUntil > 0 && elapsed >= padView.errorUntil) {
      padView.errorUntil = 0;
      refreshPadStyle(padView);
    }
  }
  let towerSlot = 0;
  for (const view of towerViews.values()) {
    view.group.rotation.y += frameDelta * (0.34 + towerSlot * 0.08);
    view.crystal.position.y = 1.43 + Math.sin(elapsed * 2.1 + towerSlot) * 0.07;
    towerSlot += 1;
  }
  let enemySlot = 0;
  for (const view of enemyViews.values()) {
    view.group.rotation.y += frameDelta * (0.7 + enemySlot * 0.12);
    view.group.position.y = enemyBaseY + Math.sin(elapsed * 2.8 + enemySlot * 0.7) * 0.045;
    enemySlot += 1;
  }
  coreCrystal.rotation.y += frameDelta * 0.6;
  coreRing.rotation.z += frameDelta * 0.25;
  particles.rotation.y += frameDelta * 0.08;
  renderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
};

requestAnimationFrame(renderFrame);
