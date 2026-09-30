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

export type AssetStatus = 'loading' | 'ready' | 'error';

export type ModelManifestEntry = {
  id: string;
  file: string;
  bytes: number;
  contentHash: string;
  triangles: number;
  emissiveNode: string;
  // How high the body of this model stands above the ground it is placed on, in the same units as
  // the model itself. Optional because most models stand on it: a floater declares a gap so the
  // client can put its health bar over the body instead of through it, and a walker that omits the
  // field is not claiming a gap of zero, it is making no claim. It was demanded by the first export
  // and had nowhere to live, which is why the contract grew it here rather than in the file.
  hoverY?: number;
};

export type AssetManifest = {
  version: number;
  models: ModelManifestEntry[];
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
  const models: ModelManifestEntry[] = candidate.models.map((model, index) => {
    if (typeof model !== 'object' || model === null) {
      return contractFail(`model registry entry ${index} is not an object`);
    }
    const file = readString(model.file, `models[${index}].file`);
    if (file.includes('/') || file.includes('\\') || file.includes('..')) {
      // The registry is data, so a path in it is a trust boundary: only a bare file name of the
      // generated artifact may be resolved, never a path that walks out of the models directory.
      return contractFail(`model registry entry ${index} must name a file, not a path`);
    }
    const hoverY = readOptionalMeasure(model.hoverY, `models[${index}].hoverY`);
    return {
      id: readString(model.id, `models[${index}].id`),
      file,
      bytes: readCount(model.bytes, `models[${index}].bytes`),
      contentHash: readString(model.contentHash, `models[${index}].contentHash`),
      triangles: readCount(model.triangles, `models[${index}].triangles`),
      emissiveNode: readString(model.emissiveNode, `models[${index}].emissiveNode`),
      ...(hoverY === undefined ? {} : { hoverY }),
    };
  });
  const duplicates = models.filter((model, index) => models.findIndex((other) => other.id === model.id) !== index);
  if (duplicates.length > 0) {
    return contractFail(`model registry repeats ${duplicates.map((model) => model.id).join(', ')}`);
  }
  return { version: ASSET_MANIFEST_VERSION, models };
};

// The manifest is the only place that knows which file backs a tower, so the client never spells
// out a model path and a registry change does not touch the code.
export const resolveModelUrl = (entry: ModelManifestEntry): string => `${ASSET_BASE_URL}${entry.file}`;

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
    entries(): ModelManifestEntry[] {
      return requireManifest().models;
    },
    // Absent entry is a legitimate answer, not an error: not every tower has a model yet.
    resolve(towerId: string): ModelManifestEntry | null {
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
    // model never triggers a second request or a second set of GPU resources.
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
