import * as THREE from 'three';

// The block every domain module needs and none of them may own: the share of the environment probe a
// material takes, and the disposal of a view nobody else owns. It exists because the map, the towers
// and the enemies all sample the probe and all release their own geometry — three copies of the probe
// table would be three places where a material could be declared differently from its neighbours.

// The share of the environment probe each material takes, and the only dimmer left in the scene.
// `envMapIntensity` defaults to 1, so leaving a material unset would read as "full probe" — the
// wrong default for a deliberately dark tactical read. Ground and routes take almost none of it:
// a rough near-dielectric surface gains nothing from a soft room and only loses the slate it was
// authored as. The share grows with the metalness of the part, and the generated model keeps the
// whole probe, because it is the reason the probe exists.
export const PROBE_WEIGHTS = {
  ground: 0.1,
  path: 0.15,
  // Terrain props take a little more of the probe than the ground they stand on: they are the only
  // thing on the plate with a silhouette, so they are the only thing worth a soft light landing on.
  prop: 0.2,
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

export type ProbeRole = keyof typeof PROBE_WEIGHTS;

export type ProbeMaterialReading = {
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

// The one prefiltered probe texture of the page, handed over once. It lives on `scene.environment`,
// and a material that samples it has to hold the same texture by name — so the value is declared
// here rather than imported, and the page sets it before any domain module builds a material.
let environmentTexture: THREE.Texture | null = null;

export const setEnvironmentTexture = (texture: THREE.Texture): void => {
  environmentTexture = texture;
};

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
export const withProbeWeight = <T extends THREE.MeshStandardMaterial>(material: T, role: ProbeRole): T => {
  material.envMap = environmentTexture;
  material.envMapIntensity = PROBE_WEIGHTS[role];
  material.userData.probeRole = role;
  return material;
};

// `MeshPhysicalMaterial` extends `MeshStandardMaterial`, so this single check covers both classes
// that sample the probe. `MeshBasicMaterial` and `PointsMaterial` never read it and stay untouched.
export const isProbeMaterial = (material: THREE.Material): material is THREE.MeshStandardMaterial =>
  material instanceof THREE.MeshStandardMaterial;

export const disposeInstance = (object: THREE.Object3D) => {
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

// ---------------------------------------------------------------------------------------------
// A number that belongs to a cell and to nothing else.
//
// The ground cover and the props are placed once and never moved, so their placement cannot be a
// random walk: a stream would make the forest depend on the order the scene happened to build in,
// and two runs of the same map would stand differently with no way to tell why. So the scatter is
// read out of the cell itself — the same cell always yields the same four numbers, in any order, on
// any machine — and `salt` is what lets one cell hold a tree, a bush and two tufts without them
// landing on top of each other.
//
// Integer mixing rather than a floating one, because a hash that loses precision above 2^24 starts
// giving the same answer for neighbouring cells, and neighbouring cells are precisely the ones whose
// answers must differ.
// ---------------------------------------------------------------------------------------------

const mix = (value: number): number => {
  let mixed = Math.imul(value ^ (value >>> 16), 0x7feb352d);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x846ca68b);
  return (mixed ^ (mixed >>> 16)) >>> 0;
};

/** A stable number in `[0, 1)` for one cell and one salt. The same call always answers the same. */
export const cellNoise = (x: number, y: number, salt: number): number =>
  mix(Math.imul(x + 1, 0x9e3779b1) ^ Math.imul(y + 1, 0x85ebca77) ^ Math.imul(salt + 1, 0xc2b2ae3d)) / 0x100000000;

/** How many things a cell carries, drawn from the cell rather than from a counter that ran. */
export const cellCount = (x: number, y: number, salt: number, atMost: number): number =>
  Math.min(atMost, Math.floor(cellNoise(x, y, salt) * atMost));;
