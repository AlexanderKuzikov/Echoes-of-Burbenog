// Single source of truth about what an asset is allowed to be. Pure data and predicates: no
// Three.js, no DOM and no Node API, because the generator under `scripts/` and the browser
// client import this exact file. One edited limit has to break the build and the runtime check
// at the same time, so no number from here may be written down a second time anywhere.

const MIB = 1024 * 1024;

// The штаб set these numbers for an integrated graphics class (GT 1030 / UHD 620, WebGL2,
// 8 GB RAM). They are provisional until the owner fixes the minimum test hardware (`EOB-002`),
// and every consumer of this module inherits that provisional status.
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
  height: number;
  footprintRadius: number;
  pivotYTolerance: number;
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
  // Textures, skins, morphs and clips are zero on purpose: each of them needs its own budget and
  // its own task, and a contract that cannot execute a feature must not accept the feature.
  textures: 0,
  skins: 0,
  morphTargets: 0,
  animationClips: 0,
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

// What `cloneModelNode` in the client can reproduce. A node type outside this set is refused on
// load, because `SkinnedMesh` is also a `Mesh` and would otherwise render broken with no error.
export const SUPPORTED_NODE_TYPES: readonly string[] = ['Mesh', 'Group'];

export type NodeReading = { type: string; path: string };

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
  height?: number;
  footprintRadius?: number;
  pivotY?: number;
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
  | 'animationClips';

const OPTIONAL_MODEL_COUNTS: readonly MeasuredCountKey[] = [
  'nodes',
  'meshes',
  'materials',
  'textures',
  'skins',
  'morphTargets',
  'animationClips',
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
  if (measurement.height !== undefined && measurement.height > budget.height) {
    failures.push(overBudget(id, 'height', measurement.height, budget.height));
  }
  if (measurement.footprintRadius !== undefined && measurement.footprintRadius > budget.footprintRadius) {
    failures.push(overBudget(id, 'footprint radius', measurement.footprintRadius, budget.footprintRadius));
  }
  if (measurement.pivotY !== undefined && Math.abs(measurement.pivotY) > budget.pivotYTolerance) {
    failures.push(overBudget(id, 'pivot Y', measurement.pivotY, budget.pivotYTolerance));
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
      reason: `${modelId}: node ${node.path} is a ${node.type}; only ${supported.join(' and ')} can be instantiated`,
    }));

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
