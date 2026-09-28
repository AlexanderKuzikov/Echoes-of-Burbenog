// Look sheet for the three enemy kinds: side by side on the corridor's own road band, at the same
// camera the match opens at. It imports the real `src/client/enemies.ts`, so whatever is on the sheet
// is what the game draws — a form is tuned here instead of through an edit-build-screenshot cycle.
//
// How to open: `npm run dev`, then http://localhost:5173/tools/look/look.html
// Two query parameters:
//   ?gap=<units>   spacing between the creatures, default 1.1
//   ?scale=<px>    pixels per world unit, default 50.5 — the scale the match opens at.
//                  400 is a loupe for small detail and is not what the player sees.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createEnemies } from '../../src/client/enemies.ts';
import { setEnvironmentTexture } from '../../src/client/shared.ts';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x08131b);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(2);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;
document.body.append(renderer.domElement);

const pmrem = new THREE.PMREMGenerator(renderer);
setEnvironmentTexture(pmrem.fromScene(new RoomEnvironment(), 0.04).texture);

const keyLight = new THREE.DirectionalLight(0xffe4bf, 3.4);
keyLight.position.set(6, 14, 8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
keyLight.shadow.camera.left = -14;
keyLight.shadow.camera.right = 14;
keyLight.shadow.camera.top = 14;
keyLight.shadow.camera.bottom = -14;
scene.add(keyLight);
scene.add(new THREE.PointLight(0x2ac7b5, 3.2, 12, 2));

// The road band, at its real width of 1.2, so the fit of a creature to the corridor is on the sheet.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(14, 3),
  new THREE.MeshStandardMaterial({ color: 0x2a6a6e, roughness: 0.9 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0.079;
ground.receiveShadow = true;
scene.add(ground);

const enemies = createEnemies(scene);

const query = new URLSearchParams(location.search);
const WIDTH = 1400;
const HEIGHT = 760;
// Pixels per world unit. The default is the scale the match opens at, so what is on the sheet is
// what the player sees — and at that scale a creature is a coloured speck, which is the point. 400 is
// a loupe for working on a form, and it is not a view of the game.
const PX_PER_UNIT = Number(query.get('scale') ?? '50.5');
// Unless it is given, the spacing is derived so the row always fits the frame at any zoom: the frame
// is `WIDTH / PX_PER_UNIT` units wide and the row is four gaps, with a fifth of that left as margin.
// A fixed gap is what makes a loupe crop the row instead of showing it.
const FRAME_WIDTH = WIDTH / PX_PER_UNIT;
const gap = Number(query.get('gap') ?? (FRAME_WIDTH / 5).toFixed(3));
// Two of each of the two kinds that share a category, then the same pair again under the frost: the
// only visible difference between the pair is the body emissive, and that difference is the whole
// slow cue.
const kinds = ['husk', 'runner', 'wisp', 'wisp', 'husk'];
const slowed = new Set([3, 4]);
const snapshot = {
  tick: 0,
  enemies: kinds.map((enemyId, index) => ({
    entityId: index + 1,
    enemyId,
    x: (index - 2) * gap,
    z: 0,
    health: index === 1 ? 26 : 100,
    maxHealth: index === 1 ? 52 : 100,
    slowTicks: slowed.has(index) ? 6 : 0,
  })),
};
// Two passes: the first gives every view its spawn position, the second is what the picture shows.
enemies.applySnapshot(snapshot as never);
for (const entry of snapshot.enemies) {
  entry.x += 0.001;
}
enemies.applySnapshot({ ...snapshot, enemies: snapshot.enemies.map((e) => ({ ...e })) } as never);

const camera = new THREE.OrthographicCamera(-1.8, 1.8, 0.95, -0.95, 0.1, 100);
const target = new THREE.Vector3(0, 0.4, 0);
const azimuth = Math.PI / 4;
const elevation = Math.asin(10 / 16.16);
const radius = 6;
const horizontal = Math.cos(elevation) * radius;
camera.position.set(
  target.x + horizontal * Math.sin(azimuth),
  target.y + Math.sin(elevation) * radius,
  target.z + horizontal * Math.cos(azimuth),
);
camera.lookAt(target);
camera.updateMatrixWorld(true);

renderer.setSize(WIDTH, HEIGHT, true);
{
  const halfHeight = HEIGHT / (2 * PX_PER_UNIT);
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.right = halfHeight * (WIDTH / HEIGHT);
  camera.left = -halfHeight * (WIDTH / HEIGHT);
  camera.updateProjectionMatrix();
}

let elapsed = 0;
const render = () => {
  elapsed += 1 / 60;
  enemies.animate(elapsed, 1 / 60);
  renderer.render(scene, camera);
  requestAnimationFrame(render);
};
render();
