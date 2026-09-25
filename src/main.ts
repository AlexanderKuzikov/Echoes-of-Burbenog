import * as THREE from 'three';
import './styles.css';

type DebugState = {
  ready: boolean;
  renderer: string;
  objectCount: number;
  camera: string;
};

declare global {
  interface Window {
    __ECHOES_DEBUG__?: DebugState;
  }
}

const sceneMount = document.querySelector<HTMLDivElement>('#scene');
const statusLabel = document.querySelector<HTMLSpanElement>('[data-testid="scene-status"]');
const selectionStatus = document.querySelector<HTMLElement>('[data-testid="selection-status"]');

if (!sceneMount || !statusLabel || !selectionStatus) {
  throw new Error('Bootstrap DOM is incomplete');
}

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  alpha: false,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(sceneMount.clientWidth || 1, sceneMount.clientHeight || 1, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
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
const ground = new THREE.Mesh(new THREE.PlaneGeometry(18, 12), groundMaterial);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(18, 18, 0x3d7376, 0x24464e);
grid.position.y = 0.012;
scene.add(grid);

const pathMaterial = new THREE.MeshStandardMaterial({
  color: 0x2e5c5c,
  emissive: 0x0c2425,
  emissiveIntensity: 0.65,
  roughness: 0.82,
});
const pathCurve = new THREE.CatmullRomCurve3([
  new THREE.Vector3(-6.6, 0.08, -2.9),
  new THREE.Vector3(-4.5, 0.08, -2.2),
  new THREE.Vector3(-2.8, 0.08, -0.4),
  new THREE.Vector3(-1.1, 0.08, 1.1),
  new THREE.Vector3(1.2, 0.08, 1.3),
  new THREE.Vector3(3.2, 0.08, 0.2),
  new THREE.Vector3(4.7, 0.08, -1.9),
  new THREE.Vector3(6.5, 0.08, -2.8),
]);
const path = new THREE.Mesh(new THREE.TubeGeometry(pathCurve, 72, 0.34, 8, false), pathMaterial);
path.receiveShadow = true;
scene.add(path);

const padGeometry = new THREE.CylinderGeometry(0.62, 0.72, 0.14, 6);
const padMaterial = new THREE.MeshStandardMaterial({
  color: 0x2b7073,
  emissive: 0x0b3135,
  emissiveIntensity: 0.9,
  roughness: 0.48,
  metalness: 0.18,
});
const padPositions = [
  new THREE.Vector3(-4.8, 0.12, -0.9),
  new THREE.Vector3(-2.4, 0.12, 2.3),
  new THREE.Vector3(0.1, 0.12, -1.7),
  new THREE.Vector3(2.4, 0.12, 2.1),
  new THREE.Vector3(4.8, 0.12, 0.7),
];
for (const position of padPositions) {
  const pad = new THREE.Mesh(padGeometry, padMaterial);
  pad.position.copy(position);
  pad.castShadow = true;
  pad.receiveShadow = true;
  scene.add(pad);

  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.72, 0.8, 6),
    new THREE.MeshBasicMaterial({ color: 0x6ee2cf, transparent: true, opacity: 0.48, side: THREE.DoubleSide }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(position.x, 0.205, position.z);
  scene.add(ring);
}

const animatedTowers: Array<{ group: THREE.Group; crystal: THREE.Mesh }> = [];
const animatedEnemies: Array<{ group: THREE.Group; healthFill: THREE.Mesh }> = [];

const createTower = (x: number, z: number, accent: number, roofColor: number) => {
  const group = new THREE.Group();
  group.position.set(x, 0.14, z);

  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
    new THREE.MeshStandardMaterial({ color: 0x1d4651, roughness: 0.46, metalness: 0.34 }),
  );
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
    new THREE.MeshStandardMaterial({ color: roofColor, roughness: 0.3, metalness: 0.3 }),
  );
  roof.position.y = 1.08;
  roof.castShadow = true;
  group.add(roof);

  const crystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.18, 0),
    new THREE.MeshStandardMaterial({
      color: accent,
      emissive: accent,
      emissiveIntensity: 2.4,
      roughness: 0.18,
      metalness: 0.15,
    }),
  );
  crystal.position.y = 1.43;
  group.add(crystal);

  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(0.57, 0.025, 8, 32),
    new THREE.MeshBasicMaterial({ color: accent, transparent: true, opacity: 0.7 }),
  );
  aura.rotation.x = Math.PI / 2;
  aura.position.y = 0.18;
  group.add(aura);

  scene.add(group);
  animatedTowers.push({ group, crystal });
};

createTower(-4.8, -0.9, 0x6ee2cf, 0xd29b62);
createTower(-2.4, 2.3, 0x8cd6ff, 0x8d6bb5);
createTower(2.4, 2.1, 0xffc56b, 0xbe6b55);

const createEnemy = (x: number, z: number, scale: number, color: number) => {
  const group = new THREE.Group();
  group.position.set(x, 0.28, z);
  group.scale.setScalar(scale);

  const body = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 1),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.45, roughness: 0.62 }),
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
  healthFill.position.set(-0.06, 0.78, 0.025);
  group.add(healthFill);

  scene.add(group);
  animatedEnemies.push({ group, healthFill });
};

createEnemy(5.6, -2.7, 0.78, 0xe46c62);
createEnemy(4.3, -2.3, 0.92, 0xf0a85d);
createEnemy(2.9, -1.2, 0.66, 0xd85c8b);
createEnemy(1.6, -0.2, 0.8, 0xe46c62);
createEnemy(0.1, 0.9, 0.62, 0xf0a85d);

const core = new THREE.Group();
core.position.set(-6.3, 0.3, 2.5);
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

const buildButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-build]'));
for (const button of buildButtons) {
  button.addEventListener('click', () => {
    const buildName = button.dataset.build ?? 'Module';
    selectionStatus.textContent = `${buildName} ready`;
    for (const candidate of buildButtons) {
      const isSelected = candidate === button;
      candidate.classList.toggle('is-selected', isSelected);
      candidate.setAttribute('aria-pressed', String(isSelected));
    }
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

const clock = new THREE.Clock();
let elapsed = 0;
const renderFrame = () => {
  const delta = Math.min(clock.getDelta(), 0.05);
  elapsed += delta;
  for (const [index, tower] of animatedTowers.entries()) {
    tower.group.rotation.y += delta * (0.34 + index * 0.08);
    tower.crystal.position.y = 1.43 + Math.sin(elapsed * 2.1 + index) * 0.07;
  }
  for (const [index, enemy] of animatedEnemies.entries()) {
    enemy.group.rotation.y += delta * (0.7 + index * 0.12);
    enemy.group.position.y = 0.28 + Math.sin(elapsed * 2.8 + index * 0.7) * 0.045;
    enemy.healthFill.scale.x = 0.78 + Math.sin(elapsed * 1.5 + index) * 0.12;
  }
  coreCrystal.rotation.y += delta * 0.6;
  coreRing.rotation.z += delta * 0.25;
  particles.rotation.y += delta * 0.08;
  renderer.render(scene, camera);
  requestAnimationFrame(renderFrame);
};

statusLabel.textContent = 'Scene online';
window.__ECHOES_DEBUG__ = {
  ready: true,
  renderer: 'Three.js WebGL',
  objectCount: scene.children.length,
  camera: 'orthographic',
};
renderFrame();
