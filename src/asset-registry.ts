// Data layer of the asset pipeline. It knows the model registry contract and nothing else:
// no Three.js, no DOM, no scene. A tower id without a manifest entry is normal and stays
// procedural, while a broken contract is an error the client has to show instead of hiding.
//
// The measured values and the record of which checks actually ran live here as well, because
// both are facts about a load and not about the scene: the QA seam reads them, and the client
// decides what to refuse.

import type { ClipTargetReading, RegistryReading, SceneReading } from './asset-budgets.ts';

const ASSET_BASE_URL = '/models/';
export const ASSET_MANIFEST_URL = `${ASSET_BASE_URL}manifest.json`;
const ASSET_MANIFEST_VERSION = 1;

// Two producers write this one file. Everything the client lights and animates — towers and
// creatures — keeps the shape and the ids it had, and a terrain model is a record whose id starts
// with this prefix and which carries a `land` block instead. The prefix is the whole rule for telling
// the two apart, so it is enforced from both sides: a prefixed record without the block is refused,
// and so is a block on a record that is not terrain. With only one half of that, the boundary would
// be a convention — a prop could claim a slot that nothing places it in while the slot stayed empty.
const TERRAIN_ID_PREFIX = 'land.';

// How many slots a terrain set fills. It is a fact about the grid the skin file describes and not
// about the model, so the registry refuses numbers outside the range a slot can have and keeps no
// list of which slots exist: that list belongs to the file the map editor writes.
export const TERRAIN_SLOT_COUNT = 40;

// What a slot may hold. A list rather than an open shape, because the next terrain set will bring
// kinds this one has never seen and the contract should refuse the unknown kind by name instead of
// placing a prop nobody described.
export const TERRAIN_KINDS = ['tree', 'bush', 'rock', 'debris', 'ruin', 'bone'] as const;
export type TerrainKind = (typeof TERRAIN_KINDS)[number];

// The kinds a monster walks through and that do not block sight, and the kinds that stop both. A
// record that claims otherwise is not a style detail: `solid` decides whether a monster may cross
// the cell and whether the prop hides the field behind it, so a wrong claim is a wrong map.
const LOW_KINDS: readonly TerrainKind[] = ['bush', 'bone'];
const BLOCKING_KINDS: readonly TerrainKind[] = ['tree', 'rock', 'ruin'];

// Forty terrain models on one grid share the scene budget with everything else on it, so a terrain
// record is capped far below what a tower may spend on itself. The cap is a rule about the record
// kind and not a budget measured on a loaded artifact, so it lives next to the contract that reads
// it: a terrain file over the cap is refused while the registry is parsed, before a byte is fetched.
export const TERRAIN_TRIANGLE_LIMIT = 1500;

export type AssetStatus = 'loading' | 'ready' | 'error';

// Where a terrain model stands and what it does to the cell it stands in. `slot` is the number the
// skin file gave the place, `kind` is what the prop is, `footprint` how many cells it takes, and
// `solid` whether a monster may walk through it — which is the same question as whether it blocks
// the sight behind it.
export type TerrainPlacement = {
  slot: number;
  kind: TerrainKind;
  footprint: 1 | 2;
  solid: boolean;
};

type ModelManifestCommon = {
  id: string;
  file: string;
  bytes: number;
  contentHash: string;
  triangles: number;
  // How high the body of this model stands above the ground it is placed on, in the same units as
  // the model itself. Optional because most models stand on it: a floater declares a gap so the
  // client can put its health bar over the body instead of through it, and a walker that omits the
  // field is not claiming a gap of zero, it is making no claim. It was demanded by the first export
  // and had nowhere to live, which is why the contract grew it here rather than in the file.
  hoverY?: number;
};

// A model the client puts in a seat: a tower or a creature. It has to name the node to light, and
// the parser refuses a record of this kind that omits it — the client looks the node up by name and
// would be looking for `undefined`. The requirement the first export asked for therefore lives in
// two places instead of one: the type for the code, the parser for the file.
export type ModelManifestEntry = ModelManifestCommon & {
  emissiveNode: string;
};

// A model the terrain grid places. `emissiveNode` is optional here on purpose: a rock, a stump and
// a skull have no lit node at all, and the ten accepted records all carry one only because all ten
// are towers and creatures. A prop that does have one may still name it.
export type TerrainModelEntry = ModelManifestCommon & {
  emissiveNode?: string;
  land: TerrainPlacement;
};

// One record of the file, in either role.
export type ManifestRecord = ModelManifestEntry | TerrainModelEntry;

export type AssetManifest = {
  version: number;
  models: ManifestRecord[];
};

export class AssetContractError extends Error {}

// Every check the client can report as having run. `contentHash` is separate from `bytes` on
// purpose: it needs a secure context, so a legal http dev setup legitimately performs it not at
// all, and a seam that could not tell those two cases apart would be lying about the load.
// `worldFootprint` is separate from `modelBudget` for the same kind of reason: the file-space limits
// come out of the manifest, while the world-space one needs a measurement and a seat.
export type AssetCheckName =
  | 'bytes'
  | 'contentHash'
  | 'nodeTypes'
  | 'modelBudget'
  | 'worldFootprint'
  | 'registryBudget'
  | 'sceneBudget';

// What the loaded tree measures about its own ground plane, and what that becomes once it is in the
// seat it is going to stand in. Published rather than merely checked, because a gate that refuses a
// model without saying which number was over cannot be argued with by the person who exported it.
export type ModelFootprintReading = {
  // The furthest any vertex of the model reaches from its own origin, measured in the ground plane:
  // the same quantity the generator calls `footprintRadius`, measured here on the loaded tree so a
  // file the generator never built is measured the same way.
  fileRadius: number;
  // The lowest point of the model. A floater declares `hoverY` in the manifest and this is the number
  // that has to agree with it, which is why both are reported: a lift the client applied and a gap
  // the file already had are not the same fact.
  minY: number;
  // Null when nothing will ever put this model in a seat, in which case there is no world size to
  // speak of and the gate has nothing to compare.
  seatScale: number | null;
  worldRadius: number | null;
};

// What the loaded tree said about its own skeleton, measured on the client and not declared by the
// manifest: the joint count, the influence vectors, and the clips that came with the file. It is
// published so the budget check can be compared against real numbers instead of against a claim.
export type ModelSkeletonReading = {
  skins: number;
  bones: number;
  animationClips: number;
  weightSlots: number;
  boneInfluences: number;
  clipSeconds: number;
  clipNames: string[];
  clipTargets: ClipTargetReading[];
};

export type ModelCheck = {
  modelId: string;
  accepted: boolean;
  expectedBytes: number;
  actualBytes: number;
  triangles: number;
  nodeTypes: string[];
  skeleton: ModelSkeletonReading | null;
  footprint: ModelFootprintReading | null;
  contentHash: { performed: boolean; matches: boolean; skippedReason: string | null };
  failures: string[];
};

export type AssetChecks = {
  performed: Record<AssetCheckName, boolean>;
  models: ModelCheck[];
  registry: RegistryReading | null;
  scene: SceneReading | null;
};

const emptyChecks = (): AssetChecks => ({
  performed: {
    bytes: false,
    contentHash: false,
    nodeTypes: false,
    modelBudget: false,
    worldFootprint: false,
    registryBudget: false,
    sceneBudget: false,
  },
  models: [],
  registry: null,
  scene: null,
});

const contractFail = (message: string): never => {
  throw new AssetContractError(message);
};

const readString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    return contractFail(`model registry field ${field} must be a non-empty string`);
  }
  return value;
};

const readCount = (value: unknown, field: string): number => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return contractFail(`model registry field ${field} must be a positive integer`);
  }
  return value;
};

// An absent optional field and a malformed one are different answers: `undefined` means the exporter
// makes no claim, and anything else has to be a number or the registry is refused. A gap is a
// measurement, and a measurement that arrived as text is not one.
const readOptionalMeasure = (value: unknown, field: string): number | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return contractFail(`model registry field ${field} must be a number when present`);
  }
  return value;
};

// The value that was found goes into the message. "Invalid format" costs the exporter a round trip
// and usually a guess, and the whole reason this contract grew is that a demand could not be met
// and had nowhere to live — so a refusal that does not say what arrived is the same defect with a
// nicer font.
const describeValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `an array of ${value.length}`;
  }
  return String(value);
};

const isTerrainKind = (value: string): value is TerrainKind => (TERRAIN_KINDS as readonly string[]).includes(value);

const readTerrainPlacement = (value: unknown, at: string): TerrainPlacement => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return contractFail(`${at} must be an object with slot, kind, footprint and solid, found ${describeValue(value)}`);
  }
  const block = value as Record<string, unknown>;
  const slot = block.slot;
  if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 1 || slot > TERRAIN_SLOT_COUNT) {
    return contractFail(`${at}.slot ${describeValue(slot)} must be a whole number in 1..${TERRAIN_SLOT_COUNT}`);
  }
  const kind = block.kind;
  if (typeof kind !== 'string' || !isTerrainKind(kind)) {
    return contractFail(`${at}.kind ${describeValue(kind)} is not one of ${TERRAIN_KINDS.join(', ')}`);
  }
  const footprint = block.footprint;
  if (footprint !== 1 && footprint !== 2) {
    return contractFail(`${at}.footprint ${describeValue(footprint)} is neither 1 nor 2`);
  }
  const solid = block.solid;
  if (typeof solid !== 'boolean') {
    return contractFail(`${at}.solid ${describeValue(solid)} must be true or false`);
  }
  if (solid && LOW_KINDS.includes(kind)) {
    return contractFail(`${at}.solid true is not a ${kind}: it is low, a monster walks through it and it does not block sight`);
  }
  if (!solid && BLOCKING_KINDS.includes(kind)) {
    return contractFail(`${at}.solid false is not a ${kind}: it stops both a monster and the sight behind it`);
  }
  return { slot, kind, footprint, solid };
};

export const parseAssetManifest = (raw: unknown): AssetManifest => {
  if (typeof raw !== 'object' || raw === null) {
    return contractFail('model registry is not an object');
  }
  const candidate = raw as Partial<AssetManifest>;
  if (candidate.version !== ASSET_MANIFEST_VERSION) {
    return contractFail(`model registry version ${String(candidate.version)} is not supported`);
  }
  if (!Array.isArray(candidate.models) || candidate.models.length === 0) {
    return contractFail('model registry lists no models');
  }
  const models: ManifestRecord[] = candidate.models.map((model, index) => {
    if (typeof model !== 'object' || model === null) {
      return contractFail(`model registry entry ${index} is not an object`);
    }
    const where = `model registry entry ${index}`;
    const fields = `models[${index}]`;
    const file = readString(model.file, `${fields}.file`);
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      // The registry is data, so a path in it is a trust boundary: only a bare file name of the
      // generated artifact may be resolved, never a path that walks out of the models directory.
      return contractFail(`model registry entry ${index} must name a file, not a path`);
    }
    // The id comes first from here on: it is what says which of the two producers wrote the record,
    // and every reason below has to name the record it is about.
    const id = readString(model.id, `${fields}.id`);
    const hoverY = readOptionalMeasure(model.hoverY, `${fields}.hoverY`);
    // What arrived is raw data, not a record yet: `Partial` says every claim may be missing, and each
    // reader below decides whether the absence is allowed or refused.
    const claim = model as Partial<TerrainModelEntry>;
    const emissiveNode = claim.emissiveNode === undefined ? undefined : readString(claim.emissiveNode, `${fields}.emissiveNode`);
    const land = claim.land === undefined ? undefined : readTerrainPlacement(claim.land, `${fields}.land`);
    const common = {
      id,
      file,
      bytes: readCount(model.bytes, `${fields}.bytes`),
      contentHash: readString(model.contentHash, `${fields}.contentHash`),
      triangles: readCount(model.triangles, `${fields}.triangles`),
    };
    // The optional claims are spread on last and in this order, so a record the generator republishes
    // is written with the keys in the same order it had before terrain records existed. The file is
    // data, not a diff, but an artifact that reorders itself on an unrelated change is one nobody can
    // compare by eye afterwards.
    if (id.startsWith(TERRAIN_ID_PREFIX)) {
      if (land === undefined) {
        return contractFail(`${where} ${id} is a terrain model and must carry a land block, found none`);
      }
      if (common.triangles > TERRAIN_TRIANGLE_LIMIT) {
        return contractFail(
          `${where} ${id} claims ${common.triangles} triangles, a terrain model allows ${TERRAIN_TRIANGLE_LIMIT}`,
        );
      }
      return {
        ...common,
        land,
        ...(emissiveNode === undefined ? {} : { emissiveNode }),
        ...(hoverY === undefined ? {} : { hoverY }),
      };
    }
    if (land !== undefined) {
      return contractFail(
        `${where} ${id} must not carry a land block, and it claims slot ${land.slot} kind ${land.kind}: ` +
          `only ids starting with ${TERRAIN_ID_PREFIX} place themselves on the terrain grid`,
      );
    }
    if (emissiveNode === undefined) {
      return contractFail(`${where} ${id} must name an emissiveNode, found none: only terrain models may go without one`);
    }
    return { ...common, emissiveNode, ...(hoverY === undefined ? {} : { hoverY }) };
  });
  const duplicates = models.filter((model, index) => models.findIndex((other) => other.id === model.id) !== index);
  if (duplicates.length > 0) {
    return contractFail(`model registry repeats ${duplicates.map((model) => model.id).join(', ')}`);
  }
  return { version: ASSET_MANIFEST_VERSION, models };
};

// Which producer wrote a record, asked the one way everywhere. The parser refuses a record whose id
// and block disagree, so after `parseAssetManifest` the id and the block say the same thing, and the
// client asks the id because both kinds of record have one.
export const isTerrainRecord = (record: ManifestRecord): record is TerrainModelEntry =>
  record.id.startsWith(TERRAIN_ID_PREFIX);

// The records the client instantiates, in file order. A terrain record is in the registry, is counted
// against the registry budget and carries its placement, but nothing in the client places it yet, and
// fetching one would be refused for the very thing it is honestly allowed not to have.
export const instancedEntries = (manifest: AssetManifest): ModelManifestEntry[] =>
  manifest.models.filter((record): record is ModelManifestEntry => !isTerrainRecord(record));

// The manifest is the only place that knows which file backs a model, so the client never spells
// out a model path and a registry change does not touch the code.
export const resolveModelUrl = (entry: ManifestRecord): string => `${ASSET_BASE_URL}${entry.file}`;

export const createAssetRegistry = () => {
  let status: AssetStatus = 'loading';
  let error: string | null = null;
  let manifest: AssetManifest | null = null;
  let loadedModelIds: string[] = [];
  const inFlight = new Map<string, Promise<unknown>>();
  let checks = emptyChecks();
  let assetLoadMs: number | null = null;
  let sceneCounters: Omit<SceneReading, 'assetLoadMs'> | null = null;

  const requireManifest = (): AssetManifest => {
    if (!manifest) {
      return contractFail('model registry was queried before its manifest arrived');
    }
    return manifest;
  };

  return {
    get status(): AssetStatus {
      return status;
    },
    get error(): string | null {
      return error;
    },
    get modelIds(): string[] {
      return [...loadedModelIds];
    },
    get modelChecks(): ModelCheck[] {
      return checks.models.map((check) => ({
        ...check,
        nodeTypes: [...check.nodeTypes],
        skeleton: check.skeleton === null ? null : { ...check.skeleton, clipNames: [...check.skeleton.clipNames], clipTargets: check.skeleton.clipTargets.map((target) => ({ ...target })) },
        footprint: check.footprint === null ? null : { ...check.footprint },
        contentHash: { ...check.contentHash },
        failures: [...check.failures],
      }));
    },
    // The scene reading is only complete once the load finished: a frame counter without the
    // load time would let the scene budget pass on a half-measured load.
    get sceneReading(): SceneReading | null {
      if (!sceneCounters || assetLoadMs === null) {
        return null;
      }
      return { ...sceneCounters, assetLoadMs };
    },
    get checks(): AssetChecks {
      return {
        performed: { ...checks.performed },
        models: this.modelChecks,
        registry: checks.registry ? { ...checks.registry } : null,
        scene: this.sceneReading,
      };
    },
    setManifest(next: AssetManifest): void {
      manifest = next;
    },
    // Every record of the file, terrain included: what the registry has to budget and to report is
    // what the file lists, not what the client happens to load today.
    entries(): ManifestRecord[] {
      return requireManifest().models;
    },
    // Absent entry is a legitimate answer, not an error: not every tower has a model yet.
    resolve(towerId: string): ManifestRecord | null {
      return requireManifest().models.find((model) => model.id === towerId) ?? null;
    },
    markReady(modelIds: string[]): void {
      loadedModelIds = [...modelIds];
      status = 'ready';
      error = null;
    },
    // A refusal is local, so the models that did pass still have to be listed: they are swapped
    // in while the named one stays procedural.
    markFailed(reason: string, modelIds: string[] = []): void {
      loadedModelIds = [...modelIds];
      status = 'error';
      error = reason;
    },
    // One load per file, no matter how many towers ask for it, so a second view of the same
    // model never triggers a second request or a second set of GPU resources. Typed on the record
    // the client instantiates, because that is the only kind of entry this path may be handed.
    load<T>(entry: ModelManifestEntry, loader: () => Promise<T>): Promise<T> {
      const cached = inFlight.get(entry.file);
      if (cached) {
        return cached as Promise<T>;
      }
      const pending = loader();
      inFlight.set(entry.file, pending);
      return pending;
    },
    markCheckPerformed(name: AssetCheckName): void {
      checks = { ...checks, performed: { ...checks.performed, [name]: true } };
    },
    recordModelCheck(check: ModelCheck): void {
      checks = { ...checks, models: [...checks.models, check] };
    },
    recordRegistryReading(reading: RegistryReading): void {
      checks = { ...checks, registry: reading };
    },
    recordAssetLoadMs(milliseconds: number): void {
      assetLoadMs = milliseconds;
    },
    recordSceneCounters(counters: Omit<SceneReading, 'assetLoadMs'>): void {
      sceneCounters = counters;
    },
  };
};

export type AssetRegistry = ReturnType<typeof createAssetRegistry>;
