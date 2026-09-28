// Look sheet for the seven enemy kinds: side by side on the corridor's own road band, at the same
// camera the match opens at. It imports the real `src/client/enemies.ts`, so whatever is on the sheet
// is what the game draws — a form is tuned here instead of through an edit-build-screenshot cycle.
//
// How to open: `npm run dev`, then http://localhost:5173/tools/look/look.html
// Query parameters:
//   ?scale=       pixels per world unit. Two named values and no default worth guessing:
//                   `game`  17.2 — the scale the match opens on, measured on the 1280x720 view
//                             (scene 1234x403). This is the default, and it is the one a decision
//                             about readability belongs on.
//                   `loupe` 50.5 — 2.9x the match, for working on a form. The player never sees it.
//                   a number is a number you typed, and the sheet says so on the caption.
//   ?gap=<units>   spacing between the creatures, default: derived so the row always fits
//   ?kind=<id>     one creature and a slowed twin of it, centred — what the loupe needs, because at
//                  400 px per unit the whole roster no longer fits and a cropped row is neither a
//                  shape nor a comparison.
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

const query = new URLSearchParams(location.search);
const WIDTH = 1400;
const HEIGHT = 760;
// Pixels per world unit. The default is the scale the match actually opens at, measured through the
// seam on the 1280x720 view, so what is on the sheet is what the player sees. Before 0031 this was
// 50.5 and the comment above called it the match scale: it was 2.9 times larger than the game, and
// every readability decision taken on this sheet since 0022 was taken at a scale that never shipped.
// The loupe is still here, under a name that says what it is.
const GAME_SCALE = 17.19;
const LOUPE_SCALE = 50.5;
const requestedScale = query.get('scale');
const PX_PER_UNIT = requestedScale === null || requestedScale === 'game'
  ? GAME_SCALE
  : requestedScale === 'loupe'
    ? LOUPE_SCALE
    : Number(requestedScale);
const FRAME_WIDTH = WIDTH / PX_PER_UNIT;
// The caption is the part that keeps the tool honest: a picture of the roster at a scale nobody plays
// at looks exactly like a picture of the roster at the scale they do.
const scaleCaption = requestedScale === null || requestedScale === 'game'
  ? 'the scale the match opens at, measured on the 1280x720 view (scene 1234x403)'
  : requestedScale === 'loupe'
    ? 'a loupe for working on a form — 2.9x the match, the player never sees this'
    : 'a number typed into ?scale=, not a claim about the match';
const caption = document.createElement('div');
caption.textContent = `${PX_PER_UNIT} px per world unit — ${scaleCaption}. `
  + `The row is ${FRAME_WIDTH.toFixed(1)} units wide, wider than the match frame: `
  + 'the sheet fits the whole roster in one row. Add ?gap= to close it up.';
Object.assign(caption.style, {
  position: 'fixed',
  top: '10px',
  left: '12px',
  maxWidth: '900px',
  padding: '6px 10px',
  borderRadius: '6px',
  background: 'rgba(4, 12, 18, 0.82)',
  color: '#cfe6e2',
  font: '13px/1.45 system-ui, sans-serif',
});
document.body.append(caption);

const keyLight = new THREE.DirectionalLight(0xffe4bf, 3.4);
keyLight.position.set(6, 14, 8);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(1024, 1024);
// The shadow frustum follows the frame, which is now 81 units wide at the match scale and 28 at the
// loupe: a fixed fourteen-unit box would drop the shadows of the creatures at both ends, which are the
// two the player is comparing.
const shadowSpan = Math.max(14, FRAME_WIDTH * 0.6);
keyLight.shadow.camera.left = -shadowSpan;
keyLight.shadow.camera.right = shadowSpan;
keyLight.shadow.camera.top = shadowSpan;
keyLight.shadow.camera.bottom = -shadowSpan;
scene.add(keyLight);
scene.add(new THREE.PointLight(0x2ac7b5, 3.2, 12, 2));

// The road band at its real width of 1.2, so the fit of a creature to the corridor is on the sheet:
// anything wider than the band visibly hangs over the edge, and that is the only place the boss fills
// it. The band runs as far as the frame is wide, because a fixed-length strip would end in the middle
// of the row with nothing under two thirds of it.
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(Math.max(14, FRAME_WIDTH * 1.1), 1.2),
  new THREE.MeshStandardMaterial({ color: 0x2a6a6e, roughness: 0.9 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = 0.079;
ground.receiveShadow = true;
scene.add(ground);

const enemies = createEnemies(scene);

// The seven kinds in roster order, with the two that carry the slow cue doubled right behind their own
// twin: the biggest common enemy and the smallest thing on the road. The only visible difference
// between a pair is the body emissive, and that difference is the whole slow cue — so the pair is
// worth spending two slots on at both sizes, because the tiniest creature is the one where the cue
// has the least room left to show itself.
const kinds = query.has('kind')
  ? [query.get('kind') as string, query.get('kind') as string]
  : ['husk', 'husk', 'runner', 'wisp', 'swarmling', 'swarmling', 'carapace', 'mote', 'maw'];
const slowed = new Set(query.has('kind') ? [1] : [1, 5]);
// One bar at half, on the runner: the bars are the one part of a creature whose length is its own, so
// a row where every bar is full says nothing about that.
const damaged = query.has('kind') ? -1 : 2;
// Unless it is given, the spacing is derived so the row always fits the frame at any zoom: one gap per
// neighbour and one more of them left as margin. A fixed gap is what makes a loupe crop the row
// instead of showing it.
const gap = Number(query.get('gap') ?? (FRAME_WIDTH / (kinds.length + 1)).toFixed(3));
const snapshot = {
  tick: 0,
  enemies: kinds.map((enemyId, index) => ({
    entityId: index + 1,
    enemyId,
    x: (index - (kinds.length - 1) / 2) * gap,
    z: 0,
    health: index === damaged ? 26 : 100,
    maxHealth: index === damaged ? 52 : 100,
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
// Zero, because that is the azimuth the match opens at: the map is 4-fold symmetric and the frame is
// fitted on a symmetry axis. The sheet looking down the other diagonal would be a second, different
// "the game" for a tool whose whole job is to be the game.
const azimuth = 0;
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
