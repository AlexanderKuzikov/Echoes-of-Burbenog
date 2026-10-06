// Single source of truth about what an asset is allowed to be. Pure data and predicates: no
// Three.js, no DOM and no Node API, because the generator under `scripts/` and the browser
// client import this exact file. One edited limit has to break the build and the runtime check
// at the same time, so no number from here may be written down a second time anywhere.

const MIB = 1024 * 1024;

// These numbers were set for an integrated graphics class (GT 1030 / UHD 620, WebGL2, 8 GB RAM).
// They are provisional until the owner fixes the minimum test hardware (`EOB-002`), and every
// consumer of this module inherits that provisional status.
export type ModelBudget = {
  triangles: number;
  bytes: number;
  nodes: number;
  meshes: number;
  materials: number;
  textures: number;
  skins: number;
  morphTargets: number;
  animationClips: number;
  // Skeleton budget. Bones and the influence limits bound what a single tower view may ask the GPU
  // to transform every frame, and the clip limits bound what the mixer may have to seek.
  bones: number;
  weightSlots: number;
  boneInfluences: number;
  clipSeconds: number;
  // Optional, because the two record kinds are not the same question. `height` and
  // `footprintRadius` are the answer to "how big is this artifact in its own file", and that answer
  // is only a limit for a model that is about to be multiplied into a tower seat: a tree seven units
  // tall is a tree, and refusing it for standing taller than a tower would be refusing the artefact
  // for being a tree. A terrain record leaves both out rather than inventing a number for them.
  height?: number;
  footprintRadius?: number;
  pivotYTolerance?: number;
};

export type RegistryBudget = {
  bytes: number;
  triangles: number;
  models: number;
};

export type SceneBudget = {
  drawCalls: number;
  renderedTriangles: number;
  shaderPrograms: number;
  assetLoadMs: number;
};

export const MODEL_BUDGET: ModelBudget = {
  triangles: 5_000,
  bytes: 1 * MIB,
  nodes: 32,
  meshes: 32,
  materials: 16,
  // Textures and morph targets stay zero on purpose: each of them needs its own budget and its own
  // task, and a contract that cannot execute a feature must not accept the feature. Skeletons and
  // clips now have a budget of their own, so one skin with one looping clip is allowed.
  textures: 0,
  skins: 1,
  morphTargets: 0,
  animationClips: 1,
  bones: 24,
  // The influence vectors are VEC4, so four slots and four influencing bones are the format limit
  // rather than a number of our own choosing.
  weightSlots: 4,
  boneInfluences: 4,
  clipSeconds: 2,
  height: 4.0,
  // A model may not reach further from the pivot than a pad click does, or the picture and the
  // picking would disagree about where a tower is.
  footprintRadius: 0.85,
  pivotYTolerance: 0.01,
};

export const REGISTRY_BUDGET: RegistryBudget = {
  bytes: 8 * MIB,
  triangles: 150_000,
  models: 64,
};

export const SCENE_BUDGET: SceneBudget = {
  drawCalls: 400,
  renderedTriangles: 250_000,
  shaderPrograms: 32,
  assetLoadMs: 1_500,
};

// The one size limit that is compared with the world instead of with the file. `footprintRadius`
// above answers "how far does this artifact reach", and it is a file-space question: the client puts
// a model into a seat that multiplies it, so a file that passes can still land outside the pad it was
// placed on. The number is the world half-width of a build niche (2.0 x 2.0), and it is checked by
// the client rather than by the generator, because the generator only ever sees its own primitives.
//
// The two limits live in the same table on purpose. They are different coordinates of the same fact,
// and the decision that moved the tower contract into the world is what made them two numbers instead
// of one: a model refused here would have been accepted on its own terms by every other gate.
export type WorldFootprintBudget = {
  radius: number;
};

export const WORLD_FOOTPRINT_BUDGET: WorldFootprintBudget = {
  radius: 1.0,
};

// A terrain model is not a tower in a smaller seat, so it is not budgeted as one. Two of the numbers
// above have no meaning here and are left out on purpose rather than set to a value large enough to
// never fire: `height` and `footprintRadius` exist to keep a multiplied model inside the 2x2 world a
// tower is placed in, and a tree is not multiplied and is not placed in one. Its own extent is a
// question about art — a canopy that overhangs its cell is what a canopy does — so there is no number
// here that would mean anything, and inventing one would be a limit nobody could act on.
//
// Everything that is left is a per-file cost, which is the same question for both kinds of record:
// how much this one artefact asks the GPU for. The triangle cap is the binding one, because forty of
// these share one frame with everything else on it.
export const TERRAIN_MODEL_BUDGET: ModelBudget = {
  triangles: 1_500,
  bytes: 1 * MIB,
  nodes: 8,
  meshes: 4,
  materials: 4,
  textures: 0,
  skins: 0,
  morphTargets: 0,
  animationClips: 0,
  bones: 0,
  weightSlots: 0,
  boneInfluences: 0,
  clipSeconds: 0,
};

// What the client can instantiate out of a loaded model. A node type outside this set is refused on
// load, because the client walks a known tree and nothing tells it how to reproduce a light node or
// a point cloud. `SkinnedMesh` and `Bone` are in the set because `SkeletonUtils.clone` rebuilds the
// skeleton, and both arrive as ordinary clones of a model the contract already accepted.
export const SUPPORTED_NODE_TYPES: readonly string[] = ['Mesh', 'Group', 'SkinnedMesh', 'Bone'];

// The animation channels the client plays. A clip is only reproducible if everything it animates is
// something the mixer can drive from the model alone: `weights` needs morph targets, which the model
// budget forbids, so a clip carrying one is refused instead of half-played.
export const REPLAYABLE_CLIP_PATHS: readonly string[] = ['translation', 'rotation', 'scale'];

// A glTF channel names the transform it animates, while a Three.js track names the property the
// mixer writes. The two sides of the pipeline read different halves of that sentence, so the
// mapping belongs here: a list on one side only would refuse every model the other side produced.
const TRACK_PROPERTIES: Readonly<Record<string, string>> = {
  position: 'translation',
  quaternion: 'rotation',
  scale: 'scale',
  morphTargetInfluences: 'weights',
};

export const gltfPathForTrack = (trackName: string): string => {
  const property = trackName.split('.').pop() ?? '';
  return TRACK_PROPERTIES[property] ?? property;
};

export type NodeReading = { type: string; path: string };

export type ClipTargetReading = { clip: string; node: string; path: string };

export type RegistryReading = { models: number; bytes: number; triangles: number };

export type SceneReading = {
  drawCalls: number;
  renderedTriangles: number;
  shaderPrograms: number;
  assetLoadMs: number;
};

export type RegistryModelReading = { id: string; bytes: number; triangles: number };

// Optional fields mean "this side cannot measure it": the generator measures the whole geometry,
// while the client only knows what the manifest declares plus the node types it found in the
// loaded tree. A missing measurement is never treated as a passing one — it is simply not made.
export type ModelMeasurement = {
  id: string;
  bytes: number;
  triangles: number;
  nodes?: number;
  meshes?: number;
  materials?: number;
  textures?: number;
  skins?: number;
  morphTargets?: number;
  animationClips?: number;
  bones?: number;
  weightSlots?: number;
  boneInfluences?: number;
  clipSeconds?: number;
  height?: number;
  footprintRadius?: number;
  pivotY?: number;
  /** Vertices in `POSITION`, and in `COLOR_0` where the model carries one. See `checkModelContract`. */
  positionVertices?: number;
  colorVertices?: number | null;
};

export type AssetFailure = { modelId: string; parameter: string; reason: string };

const overBudget = (modelId: string, parameter: string, actual: number, limit: number): AssetFailure => ({
  modelId,
  parameter,
  reason: `${modelId}: ${parameter} is ${actual}, budget allows ${limit}`,
});

type MeasuredCountKey =
  | 'nodes'
  | 'meshes'
  | 'materials'
  | 'textures'
  | 'skins'
  | 'morphTargets'
  | 'animationClips'
  | 'bones'
  | 'weightSlots'
  | 'boneInfluences';

const OPTIONAL_MODEL_COUNTS: readonly MeasuredCountKey[] = [
  'nodes',
  'meshes',
  'materials',
  'textures',
  'skins',
  'morphTargets',
  'animationClips',
  'bones',
  'weightSlots',
  'boneInfluences',
];

export const checkModelContract = (
  measurement: ModelMeasurement,
  budget: ModelBudget = MODEL_BUDGET,
): AssetFailure[] => {
  const { id } = measurement;
  const failures: AssetFailure[] = [];
  if (measurement.triangles > budget.triangles) {
    failures.push(overBudget(id, 'triangles', measurement.triangles, budget.triangles));
  }
  if (measurement.bytes > budget.bytes) {
    failures.push(overBudget(id, 'bytes', measurement.bytes, budget.bytes));
  }
  for (const parameter of OPTIONAL_MODEL_COUNTS) {
    const actual = measurement[parameter];
    if (typeof actual === 'number' && actual > budget[parameter]) {
      failures.push(overBudget(id, parameter, actual, budget[parameter]));
    }
  }
  if (measurement.height !== undefined && budget.height !== undefined && measurement.height > budget.height) {
    failures.push(overBudget(id, 'height', measurement.height, budget.height));
  }
  if (measurement.footprintRadius !== undefined && budget.footprintRadius !== undefined && measurement.footprintRadius > budget.footprintRadius) {
    failures.push(overBudget(id, 'footprint radius', measurement.footprintRadius, budget.footprintRadius));
  }
  if (measurement.pivotY !== undefined && budget.pivotYTolerance !== undefined && Math.abs(measurement.pivotY) > budget.pivotYTolerance) {
    failures.push(overBudget(id, 'pivot Y', measurement.pivotY, budget.pivotYTolerance));
  }
  // The colour buffer has to be exactly as long as the position buffer, and this is the one check in
  // the file that nothing before it can catch.
  //
  // A `COLOR_0` three times the length of `POSITION` is a valid glTF file. The renderer reads it,
  // `GLTFLoader` parses it, the builder hashes it and every budget above is satisfied — and the mesh
  // is painted with the wrong vertices, in a way that is only visible by looking at it. Our accepted
  // artefacts carry their colour exactly this way (`COLOR_0`, no material), so the shape is not
  // hypothetical: it is how all fifty of them are coloured. A missing colour buffer is not this
  // defect — that is a model with no colour at all, which is a different question and not a failure.
  if (
    measurement.positionVertices !== undefined &&
    typeof measurement.colorVertices === 'number' &&
    measurement.colorVertices !== measurement.positionVertices
  ) {
    failures.push({
      modelId: id,
      parameter: 'color vertices',
      reason:
        `${id}: COLOR_0 carries ${measurement.colorVertices} vertices but POSITION carries ` +
        `${measurement.positionVertices} · a colour buffer of another length passes the renderer, the ` +
        `loader and every budget above, and paints the mesh with the wrong vertices`,
    });
  }
  // A clip length is a duration rather than a count, so it cannot ride the table above: a loop the
  // mixer has to seek inside costs more the longer it is, and two seconds is what one idle sway of
  // a schematic tower needs.
  if (measurement.clipSeconds !== undefined && measurement.clipSeconds > budget.clipSeconds) {
    failures.push(overBudget(id, 'clip seconds', measurement.clipSeconds, budget.clipSeconds));
  }
  return failures;
};

// A registry overrun is attributed to the model that pushed the running sum over the limit, so a
// refusal always names a model instead of reporting a nameless "the whole registry is broken".
export const checkRegistryBudgets = (
  models: readonly RegistryModelReading[],
  budget: RegistryBudget = REGISTRY_BUDGET,
): AssetFailure[] => {
  const failures: AssetFailure[] = [];
  const weights: ReadonlyArray<[keyof RegistryBudget, (model: RegistryModelReading) => number]> = [
    ['bytes', (model) => model.bytes],
    ['triangles', (model) => model.triangles],
    ['models', () => 1],
  ];
  for (const [parameter, weight] of weights) {
    let total = 0;
    for (const model of models) {
      total += weight(model);
      if (total > budget[parameter] && !failures.some((failure) => failure.parameter === parameter)) {
        failures.push(overBudget(model.id, `registry ${parameter}`, total, budget[parameter]));
      }
    }
  }
  return failures;
};

// "Mesh, Group, SkinnedMesh and Bone" — the refusal text names every type the client does accept,
// so an operator reading it in the viewport does not have to open this file to learn the list.
const joinList = (items: readonly string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

export const checkNodeTypes = (
  modelId: string,
  nodes: readonly NodeReading[],
  supported: readonly string[] = SUPPORTED_NODE_TYPES,
): AssetFailure[] =>
  nodes
    .filter((node) => !supported.includes(node.type))
    .map((node) => ({
      modelId,
      parameter: 'nodeType',
      reason: `${modelId}: node ${node.path} is a ${node.type}; only ${joinList(supported)} can be instantiated`,
    }));

// Both sides read the same list, so a channel the generator would write and a channel the client
// would refuse can never drift apart into a green build and a broken picture.
export const checkClipTargets = (
  modelId: string,
  targets: readonly ClipTargetReading[],
  supported: readonly string[] = REPLAYABLE_CLIP_PATHS,
): AssetFailure[] =>
  targets
    .filter((target) => !supported.includes(target.path))
    .map((target) => ({
      modelId,
      parameter: 'clipTarget',
      reason: `${modelId}: clip ${target.clip} animates ${target.node} .${target.path}; the client plays only ${joinList(supported)}`,
    }));

// The world's own answer to "how big is this model", and the only gate a foreign artifact can reach:
// the file radius is measured on the loaded tree and the seat multiplier is the one the client is
// about to put it in, so the number compared here is the width a player would actually see. The
// refusal names all three, because "too big" without the arithmetic is a shrug.
export const checkWorldFootprint = (
  modelId: string,
  fileRadius: number,
  seatScale: number,
  budget: WorldFootprintBudget = WORLD_FOOTPRINT_BUDGET,
): AssetFailure[] => {
  const worldRadius = fileRadius * seatScale;
  if (worldRadius <= budget.radius) {
    return [];
  }
  return [
    {
      modelId,
      parameter: 'world footprint radius',
      reason:
        `${modelId}: world footprint radius is ${round(worldRadius)} ` +
        `(file radius ${round(fileRadius)} x seat ${seatScale}), the world allows ${budget.radius}`,
    },
  ];
};

const round = (value: number): number => Number(value.toFixed(5));

export const checkSceneBudget = (reading: SceneReading, budget: SceneBudget = SCENE_BUDGET): AssetFailure[] => {
  const failures: AssetFailure[] = [];
  const measured: ReadonlyArray<[keyof SceneBudget, number]> = [
    ['drawCalls', reading.drawCalls],
    ['renderedTriangles', reading.renderedTriangles],
    ['shaderPrograms', reading.shaderPrograms],
    ['assetLoadMs', reading.assetLoadMs],
  ];
  for (const [parameter, actual] of measured) {
    if (actual > budget[parameter]) {
      failures.push(overBudget('scene', parameter, actual, budget[parameter]));
    }
  }
  return failures;
};

export const sumRegistry = (models: readonly RegistryModelReading[]): RegistryReading => ({
  models: models.length,
  bytes: models.reduce((total, model) => total + model.bytes, 0),
  triangles: models.reduce((total, model) => total + model.triangles, 0),
});

export const describeFailures = (failures: readonly AssetFailure[]): string =>
  failures.map((failure) => failure.reason).join('; ');
