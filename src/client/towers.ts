import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AssetContractError } from '../asset-registry.ts';
import type { ModelFootprintReading, ModelManifestEntry } from '../asset-registry.ts';
import type { BuildPadDefinition, MatchSnapshot } from '../game-core/index.ts';
import { disposeInstance, withProbeWeight } from './shared.ts';
import type { ProbeRole } from './shared.ts';

export type LoadedModel = {
  entry: ModelManifestEntry;
  scene: THREE.Group;
  emissiveNode: string;
  clips: THREE.AnimationClip[];
  // What the load measured about the model on its own ground plane, kept with the model so a view that
  // has to place it — a creature lifted to the height its manifest declares — does not have to walk the
  // geometry again to find out where the body already stands.
  footprint: ModelFootprintReading;
};

export type TowerModelReading = {
  entityId: number;
  towerId: string;
  source: 'procedural' | 'model';
  modelId: string | null;
  meshCount: number;
  // The growth level the seat is standing at, and the two numbers that put it there. Published so a
  // level can be read off the scene rather than off the snapshot the scene was built from — a view
  // that says level 4 while its seat is scaled for level 3 is a defect nothing else would catch.
  growthLevel: number;
  seatScale: { x: number; y: number; z: number };
  crystalNode: string | null;
  crystalBaseY: number;
  crystalY: number;
  crystalScale: number;
  crystalEmissive: number;
  // Null on a tower without a skeleton. `time` and `pose` are the facts the determinism claim rests
  // on: the same tick has to give the same two numbers in a run and in the replay of that run.
  clip: TowerClipReading | null;
};

export type TowerClipReading = {
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

// The animated part of a tower view. It is presentation state and lives with the view: the
// snapshot does not know it exists, and nothing in the simulation reads it. `applied` is the
// presentation time the clip has been brought up to, so the update is a difference between two
// readings of one clock and never a function of where in the frame the view was created.
export type TowerClip = {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  clipName: string;
  duration: number;
  phase: number;
  bone: THREE.Bone;
  applied: number;
};

export type TowerView = {
  towerId: string;
  group: THREE.Group;
  // The lit part of the tower: the mesh whose material carries the glow and whose scale answers a shot.
  // `accentNode` is what the idle moves, and for a loaded artifact the two are deliberately different
  // objects. An exporter names the node that holds the gem and leaves that node at the model's origin,
  // so a gem three units up is carried by a node standing on the ground: bobbing the node would lift
  // the gem by the wrong amount, and swelling it would throw the gem into the air. A pivot is put at
  // the gem and the mesh is hung on it, which makes the two paths one path.
  crystal: THREE.Mesh;
  accentNode: THREE.Object3D;
  crystalMaterial: THREE.MeshStandardMaterial;
  // The idle bob is measured from wherever the accent starts, so a loaded model and the procedural
  // placeholder cannot drift apart on a hardcoded height.
  crystalBaseY: number;
  source: 'procedural' | 'model';
  modelId: string | null;
  // The growth level the seat is currently standing at, kept beside the seat so a view swapped in
  // place can be given the level its predecessor was at instead of snapping back to level 1.
  growthLevel: number;
  clip: TowerClip | null;
  firedUntil: number;
  aimAngle: number;
  // Releases exactly what this view owns: the geometry and the source materials of a loaded
  // model stay with the registry, or the next view of the same model would get a disposed one.
  release: () => void;
};

// A shot the tower drew, as the two points it runs between. Both vectors are scratch the module
// reuses on the next event, so the caller draws from them before the next event arrives and does
// not keep them.
export type ShotEndpoints = {
  from: THREE.Vector3;
  to: THREE.Vector3;
};

// The tower domain: procedural and model views, the clip each one plays, the aim and flash a shot
// produces, and the readings the debug seam publishes. `presentationTime` is the match clock the
// clips follow, passed in as a number because the page owns that clock and a second copy of it in
// two places is how a pose ends up a function of frame order.
export type TowerPresentation = {
  applySnapshot: (next: MatchSnapshot, presentationTime: number) => void;
  animate: (elapsed: number, ambientDelta: number, presentationTime: number) => void;
  onFired: (entityId: number, target: THREE.Vector3 | null, elapsed: number) => ShotEndpoints | null;
  upgradeWithModels: (presentationTime: number) => void;
  resetFired: () => void;
  setReducedMotion: (reduced: boolean) => void;
  // The multiplier the seat of this tower will scale a model by, which is the number the world
  // footprint gate measures a model against before it is ever put on screen. Every id in the look
  // table has a seat, including the one no table has an entry for, because an unknown tower still
  // stands somewhere.
  seatScaleFor: (towerId: string) => number;
  viewCount: () => number;
  positions: () => Array<{ x: number; z: number }>;
  modelReadings: () => TowerModelReading[];
  poseReadings: () => Array<{ entityId: number; towerId: string; clip: TowerClipReading | null }>;
  clipMotion: () => { clips: number; clipsPlaying: number };
};

// The idle intensity of a lit crystal. It is a number the suite reads, not a taste: "lit" means
// brighter than this, everywhere in the project, so a breath that rose above it would be
// indistinguishable from a shot that has not finished.
const towerCrystalIdleIntensity = 2.4;
const towerCrystalFireIntensity = 6.6;
// How much the crystal swells at the peak of a shot. It has to be a scale above one: the reading is
// what tells a lit tower from a tower that is merely standing there.
const towerCrystalFireScale = 0.55;
const towerFireFlashSeconds = 0.22;
// The share of the flash window held at the peak before it dies. A flash that decayed from the first
// frame would spend most of its life in the range where it looks like a tower that is merely glowing.
const towerFlashHoldShare = 0.75;
// Where a shot leaves a tower and where it lands on a body. `onFired` no longer starts the beam at
// `towerMuzzleHeight` — it starts it at the crystal, the one part of a tower that is lit — and the
// constant is what a shot falls back to if that world position ever comes back degenerate. A beam
// from the pad floor is a wrong picture, and no picture at all is the better failure.
const towerMuzzleHeight = 0.92;
const enemyImpactHeight = 0.3;
// The pad floor is at 0.19, so a tower seated at 0.14 is socketed a little way into its own pad
// rather than balanced on top of it. All three stands come from here, and none of them lifts itself.
const towerSeatHeight = 0.14;
// The camera looks down at 38 degrees, so a unit of height reaches the screen at cos(38) = 0.79 of
// what a unit of width does: a tower authored at its true height reads as a squat object sitting in
// its own niche. Every seat is stretched by this much. It is a fact about the camera and not about
// any one tower, which is why it is a constant and not a field of the look table — and it is applied
// to the loaded model exactly as it is to the procedural placeholder, because the two-phase swap
// puts the artifact into this same seat and a difference here would be a jump in the picture.
const towerHeightCompensation = 1.2;

// What a growth level looks like from the outside: how much taller a tower stands than it did at
// level 1. Ten numbers, level 1 first, and level 1 is 1.00 — so the picture a match opens on is byte
// for byte the one `0037` was accepted for, and a tower only starts to move once it has actually
// killed something.
//
// Height only. There is no width table and that is the invariant, not a shortage: the world gate
// allows a tower a footprint radius of 1.00, the seat multiplier is chosen so that the artifact
// reaches 0.99464 / 0.96163 / 0.99001 in the world on level 1, and width growth was the only thing
// that could break that number — at the 1.228 this table used to end on, the same three files stood
// at 1.2213, 1.1809 and 1.2157, that is 18 to 22 per cent of a tower standing on the stone in front
// of the next niche. The gate measures the seat on load, where the level is 1, and rewriting it to
// know about growth would mean refusing a model out of the player's hands on the tenth level. So the
// invariant holds the only way it can: width does not grow, and height is free to.
//
// What is lost is the smaller of two growth signals, and it is the smaller one. Height still grows
// 1.56 against a width of 1.00, so "this tower grew" is still on screen as a change of proportion —
// on a 37-pixel tower the last level is about 58 pixels — and only the addition to the width is gone.
//
// Size and no colour, and that is a decision rather than a shortage. `0028` moved these three towers
// apart on silhouette and proportion after a difference of colour had already failed once, and at the
// pixels a unit that a match is actually played at, a hue is not a distance anything survives. A
// levelled tower has to be told from an unlevelled one across the board, so it is told by standing
// differently.
const towerGrowthHeight = [1, 1.057, 1.116, 1.176, 1.238, 1.3, 1.363, 1.428, 1.493, 1.56] as const;

// The level a snapshot gave, read off a table that is never asked for a level it does not have. A
// level out of range falls back to the ends rather than to `undefined`: a tower with an unreadable
// level has to stand at one size or the other, and level 1 is the one that costs nothing.
const growthHeightAt = (level: number): number => towerGrowthHeight[level - 1] ?? towerGrowthHeight[0];

// One clip per view, started at a slot-derived offset instead of at a random moment. The offset
// comes from the order the towers were built in, which the replay reproduces, so two spires never
// stand in the same pose and a restart still lands on the same one.
const TOWER_CLIP_PHASE_SECONDS = 0.37;

// The read of one tower at a glance. Three of these and an enemy have to be told apart from an
// orbiting orthographic camera, so the silhouette and the proportions do the work and the colour only
// confirms it. The three outlines are deliberately three different shapes rather than three sizes of
// one: a solid mass widest at its foot and tapering to a point, a narrow upright with a hole in it,
// and a broad flat top held up on a stem. Nothing that walks the road is any of the three. None of
// these numbers is a gameplay value.
type TowerLook = {
  accent: number;
  base: number;
  stem: number;
  roof: number;
  // The one edge that catches the light: a rim, a lintel, an antenna. Kept apart from `roof` so a
  // tower can have a broad face and a bright edge, which at this scale is the difference between a
  // shape the eye can trace and a shape that is only a colour.
  lip: number;
  // How the tower stands in its niche. The scale and the lean live on a seat below the group, not on
  // the group itself, because the group carries the aim yaw and a rotation that has to be both a
  // posture and a bearing is a rotation that will be wrong half of the time.
  scale: number;
  // One tower's own answer to the squatness of the artifact it is built from. The camera
  // compensation above is a fact about the camera and belongs to all three; this is a fact about a
  // shape nobody here may change, so it lives in that one look. One for the other two.
  rise: number;
  tiltX: number;
  tiltZ: number;
  // How far the seat travels out of that rest lean while the match runs.
  nod: number;
  // The idle yaw drift of a tower that is not shooting, in radians per second.
  spin: number;
  // The breath of the crystal: how far it bobs, how far it rolls, and how far its light dips below
  // the idle intensity.
  bob: number;
  roll: number;
  breath: number;
  // What a loaded artifact is multiplied by, per role. A file arrives with its colour baked into its
  // vertices and with no materials in it at all, so the material the client raises on top is the only
  // place our palette can act: with `vertexColors` the colour on screen is `material.color x COLOR_0`,
  // which makes the whole of a role's palette one number. `0` is not "leave it alone", it is black, so
  // a role the file got right and we want as it is carries 1.
  //
  // The two numbers exist to hold one order of reading, and the order is the whole point. Measured on
  // the accepted files, in linear light: the bodies of the three towers sit at 0.236, 0.380 and 0.430,
  // their accents at 0.310, 0.331 and 0.824. `frost-relay`'s accent is therefore 1.9 times its own body
  // before we multiply anything, and at 0.8 on the accent against 0.45 on the body it arrived on screen
  // as a white blob with a gate hidden behind it — the eye took the light and never got to the shape.
  // The body is raised and the accent is lowered, which is the same statement in two numbers: the mass
  // is the subject, the gem is a highlight on it. Neither number is "correct" alone; the pair is what
  // puts form before light.
  modelTone: number;
  modelAccentTone: number;
  build: (seat: THREE.Object3D, look: TowerLook) => THREE.Mesh;
};

type TowerPart = {
  geometry: THREE.BufferGeometry;
  color: number;
  role: ProbeRole;
  y: number;
  x?: number;
  roughness: number;
  metalness: number;
};

// Every structural part is a Three.js primitive with a declared probe weight. The scene walks its own
// materials, so a standard material that arrives without a role turns up as undeclared, and a new
// role is not an option here: three parallel sessions edit one table of them.
const structurePart = (seat: THREE.Object3D, part: TowerPart): THREE.Mesh => {
  const mesh = new THREE.Mesh(
    part.geometry,
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: part.color,
        roughness: part.roughness,
        metalness: part.metalness,
      }),
      part.role,
    ),
  );
  mesh.position.set(part.x ?? 0, part.y, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  seat.add(mesh);
  return mesh;
};

// The lit part of a tower and the only node the client animates. It is deliberately left without a
// name: `crystalNode` reads `null` exactly when a view has no model behind it, and a name here would
// make the placeholder claim the same node as the artifact it stands in for.
const crystalPart = (
  seat: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  accent: number,
  y: number,
  roughness: number,
  metalness: number,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(
    geometry,
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        emissiveIntensity: towerCrystalIdleIntensity,
        roughness,
        metalness,
      }),
      'towerCrystal',
    ),
  );
  mesh.position.y = y;
  mesh.castShadow = true;
  seat.add(mesh);
  return mesh;
};

// Pulse Spire: tall, narrow, closed, one vertical axis with a cone on it. Its procedural form
// reproduces the generated artifact part for part, down to the crystal at 1.43, because the
// two-phase swap puts the GLB into this exact seat and any difference would be a jump in the picture.
// The artifact owns this tower's shape, so its life has to come out of posture and light.
const spireBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
    color: look.base,
    role: 'towerBase',
    y: 0.15,
    roughness: 0.46,
    metalness: 0.34,
  });
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.2, 0.28, 0.78, 6),
    color: look.stem,
    role: 'towerStem',
    y: 0.5,
    roughness: 0.34,
    metalness: 0.5,
  });
  structurePart(seat, {
    geometry: new THREE.ConeGeometry(0.45, 0.42, 6),
    color: look.roof,
    role: 'towerRoof',
    y: 1.08,
    roughness: 0.3,
    metalness: 0.3,
  });
  const crystal = crystalPart(seat, new THREE.OctahedronGeometry(0.18, 0), look.accent, 1.43, 0.18, 0.15);
  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(0.57, 0.025, 8, 32),
    new THREE.MeshBasicMaterial({ color: look.accent, transparent: true, opacity: 0.7 }),
  );
  aura.rotation.x = Math.PI / 2;
  aura.position.y = 0.18;
  seat.add(aura);
  return crystal;
};

// Grove Lens: a canopy held up on a leaning stem, and the widest part of this tower is its top —
// the one thing the spire and the relay are not. It is stepped rather than smooth, because a smooth
// disc of a canopy is a lily pad and the spire's cap is a smooth bright mass, so a single tier would
// be the same picture one colour over. Two tiers with air between them read as a profile — wide,
// narrower, a point of light — that neither a cone nor a frame can be mistaken for, and the step
// survives the aim yaw because it is a profile and not a bearing.
//
// The light stands on a spike above the canopy instead of lying in it: a gem encircled by this
// tower's own green would be the wisp's picture, and `0022` gave the wisp a bright ball inside a
// closed halo.
//
// Saturated green, and not the pale sage `0023` moved it to. Sage is a desaturated version of the
// stone's own hue, which is exactly why the tower disappeared into the turquoise: the separation had
// been made against the enemies' palette instead of against the frame the tower stands in. There is
// no green anywhere on this board, so a green tower is the one thing on the map that cannot be
// mistaken for the rock it stands on. It is separated by hue and not by brightness: a canopy bright
// enough to shout turns the tower into one green blob and hands the eye nothing else to read. Each
// tier is tilted far enough to stay a readable ellipse at every azimuth the aim yaw can turn it to,
// and no further: past about half a radian its rim turns edge-on and the tower becomes a line.
const lensTilt = 0.34;
// Two canopies, the lower one wide and the upper one a third narrower, with a hand's width of air
// between them. The gap is the whole point: without it the two tiers merge into one thick disc, and
// with it the tower has a stepped profile that a cone has no way of imitating.
const lensTiers = [
  { y: 1.16, outer: 0.72, inner: 0.3, thickness: 0.2 },
  { y: 1.6, outer: 0.48, inner: 0.22, thickness: 0.18 },
] as const;
const lensBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.5, 0.58, 0.2, 8),
    color: look.base,
    role: 'towerBase',
    y: 0.1,
    roughness: 0.5,
    metalness: 0.3,
  });
  for (const side of [-1, 1]) {
    // A plain post reads as a lamp, and a lamp is not a category. The braces run from the wide foot
    // up to the narrow stem, so the tower is visibly held up rather than planted.
    const brace = structurePart(seat, {
      geometry: new THREE.BoxGeometry(0.42, 0.07, 0.07),
      color: look.stem,
      role: 'towerStem',
      y: 0.4,
      x: side * 0.23,
      roughness: 0.35,
      metalness: 0.5,
    });
    brace.rotation.z = -side * 0.62;
  }
  const stem = structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.11, 0.17, 1.36, 6),
    color: look.stem,
    role: 'towerStem',
    y: 0.86,
    roughness: 0.35,
    metalness: 0.5,
  });
  // The lean is small on purpose. The seat carries the aim yaw, so a pronounced lean would swing
  // round with the target and read as a tower falling over rather than as a canopy that is angled.
  stem.rotation.x = -0.1;
  for (const tier of lensTiers) {
    const canopy = new THREE.Group();
    canopy.position.y = tier.y;
    canopy.rotation.x = lensTilt;
    seat.add(canopy);
    structurePart(canopy, {
      geometry: new THREE.CylinderGeometry(tier.outer, tier.inner, tier.thickness, 8),
      color: look.roof,
      role: 'towerRoof',
      y: 0,
      roughness: 0.32,
      metalness: 0.4,
    });
    // The lit rim is what draws the outline, so the eye can trace the shape instead of guessing at
    // it. It is the only bright edge on this tower, which is why the canopy itself stays mid green.
    const lip = structurePart(canopy, {
      geometry: new THREE.TorusGeometry(tier.outer - 0.02, 0.045, 6, 18),
      color: look.lip,
      role: 'towerRoof',
      y: tier.thickness / 2,
      roughness: 0.26,
      metalness: 0.45,
    });
    lip.rotation.x = Math.PI / 2;
  }
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.05, 0.07, 0.26, 5),
    color: look.stem,
    role: 'towerStem',
    y: 1.88,
    roughness: 0.35,
    metalness: 0.5,
  });
  return crystalPart(seat, new THREE.OctahedronGeometry(0.17, 0), look.accent, 2.06, 0.16, 0.12);
};

// Frost Relay: a gate. Two struts lean in under a lintel, a hanger drops from the lintel into the
// opening, and the gem hangs at the end of it. Almost everything this tower is made of is air, and
// that is the point: a narrow upright with a bar across the top, a bar across the foot and a light
// in the middle is the one outline on this board with a hole in it, and nothing that walks the road
// will ever have one. The bars are the brightest structure on the board after the spire's cap, so
// the frame carries the read on its own and the gem only has to be the warm note in it.
const relayBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.42, 0.5, 0.18, 6),
    color: look.base,
    role: 'towerBase',
    y: 0.09,
    roughness: 0.52,
    metalness: 0.28,
  });
  structurePart(seat, {
    geometry: new THREE.BoxGeometry(0.84, 0.09, 0.11),
    color: look.roof,
    role: 'towerRoof',
    y: 0.24,
    roughness: 0.3,
    metalness: 0.4,
  });
  for (const side of [-1, 1]) {
    const leg = structurePart(seat, {
      geometry: new THREE.CylinderGeometry(0.06, 0.085, 1.5, 5),
      color: look.stem,
      role: 'towerStem',
      y: 0.9,
      x: side * 0.3,
      roughness: 0.34,
      metalness: 0.55,
    });
    // Signed by the side, so both struts lean inward and meet under the lintel instead of splaying
    // away from each other.
    leg.rotation.z = side * 0.15;
    const antenna = structurePart(seat, {
      geometry: new THREE.BoxGeometry(0.26, 0.05, 0.05),
      color: look.lip,
      role: 'towerRoof',
      y: 0.62,
      x: side * 0.33,
      roughness: 0.3,
      metalness: 0.4,
    });
    antenna.rotation.z = -side * 0.3;
  }
  structurePart(seat, {
    geometry: new THREE.BoxGeometry(0.92, 0.11, 0.12),
    color: look.roof,
    role: 'towerRoof',
    y: 1.68,
    roughness: 0.3,
    metalness: 0.4,
  });
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.025, 0.025, 0.6, 4),
    color: look.stem,
    role: 'towerStem',
    y: 1.32,
    roughness: 0.34,
    metalness: 0.55,
  });
  // A tetrahedron and not an octahedron, so the gem is not the same shape as the spire's crystal
  // and not the same shape as the lens's: three towers, three gems, and the shape of the light is
  // part of what tells them apart.
  const crystal = crystalPart(seat, new THREE.TetrahedronGeometry(0.3), look.accent, 0.86, 0.16, 0.12);
  crystal.rotation.y = Math.PI / 4;
  return crystal;
};

const towerLooks: Record<string, TowerLook> = {
  'pulse-spire': {
    accent: 0x6ee2cf,
    base: 0x1d4651,
    stem: 0x346f75,
    roof: 0xd29b62,
    lip: 0xd29b62,
    // The seat of this tower is two numbers, and both of them are set by the model that now stands in
    // it rather than by the form it replaced. The width is the world gate: the artifact reaches 0.70045
    // from its own origin, so 1.42 puts it at 0.99464 in the world, inside the 1.00 a niche allows and
    // against the 2.02-wide tower the procedural drum used to occupy. The height is what the drum was
    // doing with `rise: 1.5`, and the artifact does not need it: the file is 3.2 tall against 1.4 wide
    // where the drum was 1.61 against 1.19, so the same 4.91 world height is reached with 0.9. The
    // procedural form still stands in this seat as the fallback, and it now stands at half the height
    // it used to — the price of a seat that belongs to the artifact, paid only while a model is missing.
    scale: 1.42,
    rise: 0.9,
    tiltX: 0.02,
    tiltZ: 0.03,
    nod: 0,
    spin: 0.34,
    // No breath and no nod: this tower's idle intensity is a number the suite reads, and its crystal
    // already moves every two seconds on the clip.
    bob: 0.07,
    roll: 0.05,
    breath: 0,
    // The artifact's body is the darkest of the three towers — 0.236 in linear light, and it arrives
    // with a tenth of its vertices at full white — so it takes the largest lift of the three. 1.05 puts
    // its lit mass on top of the board's own value, which is the point: a silhouette the eye can only
    // find by looking for a light is not a silhouette.
    modelTone: 1.05,
    // The gem is bright by construction and is given an emissive on top of that, so it does not need
    // 0.8 to be the brightest pixel of its own model — it needs to stop being the brightest thing in the
    // frame. 0.19 leaves it unmistakably the lit crystal on top of a spire and nothing more.
    modelAccentTone: 0.19,
    build: spireBody,
  },
  'grove-lens': {
    accent: 0x00b03c,
    base: 0x14291d,
    stem: 0x24543a,
    roof: 0x2f7d52,
    lip: 0x7ff0b0,
    // 0.8362 from its own origin, so 1.15 puts it at 0.96163 in the world; the canopy it replaces was
    // 1.8 wide in the world and this is 1.92, which is the same tower on a slightly wider file. `rise`
    // answers the same thing here as it does on the spire: the file is 2.9 tall where the procedural
    // canopy stood at 2.23, so the height the board was opened with, 3.35, needs 0.84 of it.
    scale: 1.15,
    rise: 0.84,
    tiltX: 0,
    tiltZ: 0.02,
    // A canopy on a leaning stem does not bob, it sweeps. The body already carries its lean, so all
    // the seat has left to give is that slow turn across the road, and the turn is a little quicker
    // than it was: the canopy is the widest thing a tower puts on the board, so it is also the thing
    // whose angle the player is most likely to read as its state.
    nod: 0.05,
    spin: 0.26,
    bob: 0.02,
    roll: 0,
    breath: 0.35,
    // Same argument as the spire's, and this file's body is the second darkest of the three at 0.380
    // against the spire's 0.236, so it takes the same lift. The two land on one mass on purpose: they
    // are told apart by outline, which is what `0028` bought, and a difference of brightness between
    // them would be a difference of brightness the player has to learn instead.
    modelTone: 1.05,
    // Its crystal averages 0.331, a shade darker than the spire's gem, but it is a broad disc rather
    // than a point and a disc covers more of the frame at any given value. 0.18 keeps the rim lit and
    // drops the disc back to a highlight.
    modelAccentTone: 0.18,
    build: lensBody,
  },
  'frost-relay': {
    accent: 0xf07a10,
    base: 0x1b2a34,
    stem: 0x8fa9bb,
    roof: 0xc9dcea,
    lip: 0xffc46b,
    // The gate is the tallest of the three and the narrowest. A frame that is mostly air can be that
    // tall without becoming a solid mass, which is what keeps it off the spire's outline, and the
    // bright steel is what keeps it off the stone: this board is cold and mid-value everywhere, and
    // the one tower built out of near-white bars is the one the eye finds first.
    // The gate is what moves this tower the most: the file reaches 1.01021 from its origin, deeper than
    // the 0.85 the primitive was held to, so at the old 1.8 it stood 1.82 in the world — on the stone
    // in front of the next niche, which is the whole reason the world gate exists. 0.98 brings it to
    // 0.99001 and, in doing so, turns a wide A-frame into what this tower was accepted as being: a
    // narrow upright with a hole in it, 1.72 wide and 1.96 deep. `rise` puts the height back, 3.73
    // against the 3.75 the frame used to reach.
    scale: 0.98,
    rise: 1.22,
    tiltX: 0,
    tiltZ: 0,
    nod: 0,
    // The fastest turn of the three, because a frame with nothing solid in it has to be read as
    // aimed by its motion rather than by its mass.
    spin: 0.5,
    // A gem hung in a frame is free to rock, and the air around it is what this tower is made of.
    bob: 0.04,
    roll: 0.09,
    breath: 0.28,
    // The relay's struts are the whitest thing in the accepted set and they were the first thing to
    // leave the board in the first frame, so it takes the smallest lift of the three: its body already
    // measures 0.430 in linear light, the lightest of the towers. 0.8 keeps it clear of white under the
    // key light, which is what 0.45 was bought for, and still leaves the mass reading.
    modelTone: 1,
    // The one accent that was genuinely out of order, and the reason this whole direction is measurable
    // rather than a matter of taste: the file's crystal averages 0.824 in linear light — near-white, and
    // 1.9 times its own body — so at 0.8 it was a white blob with a gate hidden behind it, and the
    // player's first read of this tower was a sphere. 0.07 is the smallest pull that clears it: the lit
    // gem drops under the body's own value and the A-frame comes back. The warm base ring is part of the
    // same node, and that ring is what tells the tower off the stone, so this is not driven to zero.
    modelAccentTone: 0.07,
    build: relayBody,
  },
};
// A tower no table has an entry for still has to stand on a pad and fire, so it stands as the
// spire does, in the neutral colours the placeholder has always used.
const unknownTowerLook: TowerLook = {
  accent: 0x9fd6c8,
  base: 0x1d4651,
  stem: 0x346f75,
  roof: 0x5b7f86,
  lip: 0x5b7f86,
  scale: 1,
  rise: 1,
  tiltX: 0,
  tiltZ: 0,
  nod: 0,
  spin: 0.34,
  bob: 0.07,
  roll: 0.05,
  breath: 0,
  modelTone: 1,
  modelAccentTone: 1,
  build: spireBody,
};
const lookOf = (towerId: string): TowerLook => towerLooks[towerId] ?? unknownTowerLook;

// How much of a shot is left, as 1 at the peak and 0 the moment it is over. A flash that switched off
// at a fixed time reads as a switch; this one holds and then dies, which is what a shot looks like
// when the thing that fired is still standing there afterwards.
const shotFlash = (firedUntil: number, elapsed: number): number => {
  if (elapsed >= firedUntil) {
    return 0;
  }
  const remaining = (firedUntil - elapsed) / towerFireFlashSeconds;
  return remaining > towerFlashHoldShare ? 1 : remaining / towerFlashHoldShare;
};

// The colour a mesh was exported in, read off its own vertices. This is how the accent learns to glow
// without a colour of our own: a file that carries no material gets one here, and the only honest
// question is what the file already looks like, so the answer is measured rather than declared. A mesh
// with no vertex colours at all has no colour to be, and gets the white one.
const meanVertexColor = (mesh: THREE.Mesh): THREE.Color => {
  const color = new THREE.Color(1, 1, 1);
  const attribute = mesh.geometry.getAttribute('color');
  if (attribute === undefined || attribute.count === 0) {
    return color;
  }
  const sum = new THREE.Vector3();
  for (let vertex = 0; vertex < attribute.count; vertex += 1) {
    sum.x += attribute.getX(vertex);
    sum.y += attribute.getY(vertex);
    sum.z += attribute.getZ(vertex);
  }
  color.setRGB(sum.x / attribute.count, sum.y / attribute.count, sum.z / attribute.count, THREE.LinearSRGBColorSpace);
  return color;
};

// A pivot at the centre of a mesh's own geometry, in the mesh's parent space. The accent of a loaded
// artifact needs one and the procedural forms must not have it: an exporter names the node that holds
// the gem and leaves that node at the origin of the model, so the gem's height lives in the geometry
// and not in the transform. Without the pivot the idle would lift a gem by its own distance from the
// ground and a shot would swell it into the sky.
const geometryCentre = (mesh: THREE.Mesh): THREE.Vector3 => {
  if (mesh.geometry.boundingBox === null) {
    mesh.geometry.computeBoundingBox();
  }
  const box = mesh.geometry.boundingBox as THREE.Box3;
  return box.getCenter(new THREE.Vector3()).applyMatrix4(mesh.matrix);
};

export const createTowers = (
  scene: THREE.Scene,
  modelStore: Map<string, LoadedModel>,
  padDefinitions: ReadonlyMap<string, BuildPadDefinition>,
): TowerPresentation => {
  const towerViews = new Map<number, TowerView>();
  // The seat of every live view, by entity. It lives beside the view rather than inside it because
  // `TowerView` is a shape the page reads, and a view swapped in place has to give its seat back
  // before the replacement claims the same id.
  const viewSeats = new Map<number, THREE.Object3D>();
  const shotMuzzle = new THREE.Vector3();
  const shotImpact = new THREE.Vector3();
  let reducedMotion = false;

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

  const startTowerClip = (
    root: THREE.Object3D,
    clip: THREE.AnimationClip,
    phase: number,
    presentationTime: number,
  ): TowerClip | null => {
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
    return { mixer, action, clipName: clip.name, duration: clip.duration, phase, bone: bones[0] as THREE.Bone, applied: presentationTime };
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

  // One seat and one body, whichever source they come from. A loaded model is not special here: a
  // skinned mesh keeps its bind inverse in step with its own world matrix, so the seat's scale and
  // lean reach a model exactly once and land on a procedural tower exactly once, which is what makes
  // the swap in place invisible.
  //
  // The horizontal pair carries no growth at all, and that is the gate holding: `look.scale` is the
  // number the world footprint check compared at load, and multiplying it by a level-dependent width
  // is what put all three accepted files over 1.00 by the tenth level. The vertical axis answers
  // growth on its own, and the camera flattens height anyway.
  const seatScale = (look: TowerLook, level: number): THREE.Vector3 =>
    new THREE.Vector3(
      look.scale,
      look.scale * towerHeightCompensation * look.rise * growthHeightAt(level),
      look.scale,
    );

  const createTowerView = (
    entityId: number,
    towerId: string,
    slot: number,
    presentationTime: number,
    level: number,
  ): TowerView => {
    const look = lookOf(towerId);
    const seat = new THREE.Group();
    seat.name = 'seat';
    seat.scale.copy(seatScale(look, level));
    const model = modelStore.get(towerId);
    const owned: THREE.Material[] = [];
    let crystal: THREE.Mesh;
    let crystalMaterial: THREE.MeshStandardMaterial;
    let accentNode: THREE.Object3D;
    let modelRoot: THREE.Object3D | null = null;
    let clip: TowerClip | null = null;
    if (model === undefined) {
      crystal = look.build(seat, look);
      crystalMaterial = crystal.material as THREE.MeshStandardMaterial;
      accentNode = crystal;
    } else {
      const root = cloneModelNode(model.scene, owned) as THREE.Group;
      const emissive = root.getObjectByName(model.emissiveNode);
      if (!(emissive instanceof THREE.Mesh) || !(emissive.material instanceof THREE.MeshStandardMaterial)) {
        throw new AssetContractError(`model ${model.entry.id} has no ${model.emissiveNode} mesh to animate`);
      }
      // The palette. The file brought its colour in its vertices and no materials, and the material the
      // client raises on top of it is the only lever there is: with `vertexColors` on, the colour that
      // reaches the screen is `material.color x COLOR_0`, so a role's palette is one number and a hue
      // the file did not bring cannot be put back. The accent is also given the emissive its own
      // vertices carry, because the shot flash and the idle breath are written as intensities on this
      // material and an emissive of black would make both of them invisible.
      //
      // A file with no materials in it gets one material from the loader for the whole file, so the body
      // and the gem arrive holding the same object. Two roles cannot share a multiplier — the body would
      // be dimmed by the accent's as well — so the gem is given a copy of it. `Material.copy` carries
      // the probe and the declared role across, and the copy is per view, which is the policy this module
      // already runs on: a crystal's emissive is per-tower animation state.
      const gem = root.getObjectByName(model.emissiveNode) as THREE.Mesh;
      for (const child of root.children) {
        const mesh = child as THREE.Mesh;
        if (!(mesh instanceof THREE.Mesh)) {
          continue;
        }
        if (mesh === gem) {
          mesh.material = (mesh.material as THREE.MeshStandardMaterial).clone();
          const material = mesh.material as THREE.MeshStandardMaterial;
          material.color.multiplyScalar(look.modelAccentTone);
          material.emissive.copy(meanVertexColor(mesh)).multiplyScalar(look.modelAccentTone);
          continue;
        }
        (mesh.material as THREE.MeshStandardMaterial).color.multiplyScalar(look.modelTone);
      }
      const pivot = new THREE.Object3D();
      pivot.name = 'accent-pivot';
      pivot.position.copy(geometryCentre(emissive));
      (emissive.parent as THREE.Object3D).add(pivot);
      // `attach` keeps the mesh where it is on screen while re-parenting it, which is what makes this a
      // change of bookkeeping rather than a change of the picture.
      pivot.attach(emissive);
      seat.add(root);
      crystal = emissive;
      crystalMaterial = emissive.material;
      accentNode = pivot;
      modelRoot = root;
      clip = model.clips[0] === undefined
        ? null
        : startTowerClip(root, model.clips[0], slot * TOWER_CLIP_PHASE_SECONDS, presentationTime);
    }
    crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
    const group = new THREE.Group();
    group.name = `tower:${towerId}`;
    group.add(seat);
    viewSeats.set(entityId, seat);
    return {
      towerId,
      group,
      crystal,
      accentNode,
      crystalMaterial,
      crystalBaseY: accentNode.position.y,
      source: model === undefined ? 'procedural' : 'model',
      modelId: model?.entry.id ?? null,
      growthLevel: level,
      clip,
      firedUntil: 0,
      aimAngle: 0,
      release: () => {
        // A mixer keeps its bindings and its actions alive on its own, so a tower that is removed
        // has to give them back: thirty removed towers would otherwise leave thirty mixers running
        // against a skeleton nothing renders any more.
        if (clip !== null && modelRoot !== null) {
          clip.mixer.stopAllAction();
          clip.mixer.uncacheRoot(modelRoot);
        }
        for (const material of owned) {
          material.dispose();
        }
        // A procedural tower owns its geometry; a loaded model's geometry and source materials stay
        // with the registry, or the next view of that model would get a disposed one.
        if (model === undefined) {
          disposeInstance(seat);
        }
        // A view that has already been replaced in place has given the id to its successor, and the
        // seat it is releasing is no longer the one on record.
        if (viewSeats.get(entityId) === seat) {
          viewSeats.delete(entityId);
        }
      },
    };
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

  return {
    applySnapshot: (next: MatchSnapshot, presentationTime: number) => {
      const aliveTowers = new Set<number>();
      for (const tower of next.towers) {
        aliveTowers.add(tower.entityId);
        let view = towerViews.get(tower.entityId);
        if (!view) {
          const pad = padDefinitions.get(tower.padId);
          if (!pad) {
            continue;
          }
          view = createTowerView(tower.entityId, tower.towerId, towerViews.size, presentationTime, tower.level);
          view.group.position.set(pad.position.x, towerSeatHeight, pad.position.z);
          scene.add(view.group);
          towerViews.set(tower.entityId, view);
          continue;
        }
        // The level is read here, off the snapshot, and not in `animate`: a tower's size is a fact
        // about the match and not about where in the frame the picture happened to be drawn, so a
        // replay of the same run puts the same pixels on the same tick. The step is instant and not
        // eased, because the pop *is* the news — a tower that quietly swelled over two seconds would
        // leave the player unsure which of the two he was looking at had changed.
        if (tower.level !== view.growthLevel) {
          const seat = viewSeats.get(tower.entityId);
          if (seat !== undefined) {
            seat.scale.copy(seatScale(lookOf(view.towerId), tower.level));
          }
          view.growthLevel = tower.level;
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
    },
    animate: (elapsed: number, ambientDelta: number, presentationTime: number) => {
      for (const [entityId, view] of towerViews) {
        const look = lookOf(view.towerId);
        const flash = shotFlash(view.firedUntil, elapsed);
        if (flash > 0) {
          view.group.rotation.y = view.aimAngle;
        } else {
          view.group.rotation.y += ambientDelta * look.spin;
        }
        view.crystal.scale.setScalar(1 + towerCrystalFireScale * flash);
        // The light breathes downward out of the idle intensity and only a shot crosses it, so that
        // "brighter than idle" keeps meaning the same thing here as it does in the rest of the
        // project.
        view.crystalMaterial.emissiveIntensity =
          towerCrystalIdleIntensity -
          look.breath * (0.5 + 0.5 * Math.sin(elapsed * 1.7 + entityId)) +
          (towerCrystalFireIntensity - towerCrystalIdleIntensity) * flash;
        // The bob moves the accent, not the mesh: for a loaded artifact those are two objects, and the
        // one that holds the gem is the one standing at its height.
        view.accentNode.position.y = view.crystalBaseY + (reducedMotion ? 0 : Math.sin(elapsed * 2.1 + entityId) * look.bob);
        // A roll is the one idle channel the artifact's crystal can take on top of its own sway, and
        // it is what stops an idle spire from looking like a gem parked on a roof.
        view.crystal.rotation.z = reducedMotion ? 0 : Math.sin(elapsed * 1.6 + entityId) * look.roll;
        const seat = viewSeats.get(entityId);
        if (seat !== undefined) {
          seat.rotation.x = look.tiltX + (reducedMotion ? 0 : Math.sin(elapsed * 0.9 + entityId) * look.nod);
          seat.rotation.z = look.tiltZ;
        }
        // The clip and the bob share one reduced-motion guard and two clocks. The skeleton is brought
        // up to the match clock rather than advanced by the frame, so the pose of a tick is a function
        // of that tick: a tower built by a pad click and the same tower rebuilt by a replay both start
        // at zero on the tick they were placed, and the terminal tick holds its pose in both runs.
        if (view.clip !== null && !reducedMotion) {
          const due = presentationTime - view.clip.applied;
          if (due > 0) {
            view.clip.mixer.update(due);
            view.clip.applied = presentationTime;
          }
        }
      }
    },
    onFired: (entityId: number, target: THREE.Vector3 | null, elapsed: number): ShotEndpoints | null => {
      const view = towerViews.get(entityId);
      if (!view || reducedMotion) {
        return null;
      }
      view.firedUntil = elapsed + towerFireFlashSeconds;
      if (target === null) {
        return null;
      }
      // Three.js rotates local +X toward -Z, so the Y angle is negated.
      view.aimAngle = Math.atan2(
        -(target.z - view.group.position.z),
        target.x - view.group.position.x,
      );
      // The shot itself, from the lit part of the tower to where the target is standing on the tick the
      // event describes. Without it the only evidence of a tower working is the target's disappearance,
      // and a beam that left a fixed height above the pad left the tower somewhere the player cannot see
      // the light. `getWorldPosition` updates the chain it reads, so the point belongs to this frame
      // rather than to the one before it, and it is the gem itself whether that gem is a primitive or
      // the mesh an exported artifact named — the pivot is what puts the node at the gem.
      view.accentNode.getWorldPosition(shotMuzzle);
      if (!Number.isFinite(shotMuzzle.y)) {
        shotMuzzle.set(view.group.position.x, view.group.position.y + towerMuzzleHeight, view.group.position.z);
      }
      shotImpact.set(target.x, target.y + enemyImpactHeight, target.z);
      return { from: shotMuzzle, to: shotImpact };
    },
    // Two-phase swap. A view built before the registry answered keeps rendering, and once the model
    // is in it is replaced in place: no entity is recreated, no position changes and the snapshot is
    // not touched, so a late model cannot make two replays of the same run look different.
    upgradeWithModels: (presentationTime: number) => {
      for (const [entityId, view] of [...towerViews]) {
        if (view.source === 'model' || !modelStore.has(view.towerId)) {
          continue;
        }
        // The slot is the order the towers were built in, so a tower that is upgraded in place keeps
        // the clip phase it would have had if the model had arrived on time.
        const slot = [...towerViews.keys()].indexOf(entityId);
        // The level comes across with the position: a tower swapped in place must not drop back to
        // level 1 for the frame or two the registry took to answer, or a late model would reset a
        // grown tower and the two runs of one match would not look the same.
        const next = createTowerView(entityId, view.towerId, slot, presentationTime, view.growthLevel);
        next.group.position.copy(view.group.position);
        next.group.rotation.y = view.group.rotation.y;
        next.firedUntil = view.firedUntil;
        next.aimAngle = view.aimAngle;
        scene.remove(view.group);
        view.release();
        scene.add(next.group);
        towerViews.set(entityId, next);
      }
    },
    resetFired: () => {
      for (const view of towerViews.values()) {
        view.firedUntil = 0;
      }
    },
    setReducedMotion: (reduced: boolean) => {
      reducedMotion = reduced;
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
    },
    seatScaleFor: (towerId: string) => lookOf(towerId).scale,
    viewCount: () => towerViews.size,
    positions: () => Array.from(towerViews.values(), (view) => ({ x: view.group.position.x, z: view.group.position.z })),
    modelReadings: () =>
      Array.from(towerViews, ([entityId, view]): TowerModelReading => {
        const seat = viewSeats.get(entityId);
        return {
          entityId,
          towerId: view.towerId,
          source: view.source,
          modelId: view.modelId,
          meshCount: countMeshes(view.group),
          growthLevel: view.growthLevel,
          seatScale: {
            x: seat?.scale.x ?? 0,
            y: seat?.scale.y ?? 0,
            z: seat?.scale.z ?? 0,
          },
          // The procedural placeholder has no name on its emissive mesh, so this is also the
          // cheapest way to see which node of the model the client ended up animating.
          crystalNode: view.crystal.name || null,
          crystalBaseY: view.crystalBaseY,
          crystalY: view.accentNode.position.y,
          crystalScale: view.crystal.scale.x,
          crystalEmissive: view.crystalMaterial.emissiveIntensity,
          clip: view.clip === null ? null : readTowerClip(view.clip),
        };
      }),
    poseReadings: () =>
      Array.from(towerViews, ([entityId, view]) => ({
        entityId,
        towerId: view.towerId,
        clip: view.clip === null ? null : readTowerClip(view.clip),
      })),
    clipMotion: () => {
      const clips = Array.from(towerViews.values(), (view) => view.clip);
      return {
        // One mixer per animated view and no more: a tower that was removed or upgraded in place must
        // not leave a second animation running against the same skeleton.
        clips: clips.filter((clip) => clip !== null).length,
        clipsPlaying: clips.filter((clip) => clip?.action.isRunning() === true).length,
      };
    },
  };
};
