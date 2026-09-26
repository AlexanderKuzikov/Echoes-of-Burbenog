// Data layer of the asset pipeline. It knows the model registry contract and nothing else:
// no Three.js, no DOM, no scene. A tower id without a manifest entry is normal and stays
// procedural, while a broken contract is an error the client has to show instead of hiding.

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
};

export type AssetManifest = {
  version: number;
  models: ModelManifestEntry[];
};

export class AssetContractError extends Error {}

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
    return {
      id: readString(model.id, `models[${index}].id`),
      file,
      bytes: readCount(model.bytes, `models[${index}].bytes`),
      contentHash: readString(model.contentHash, `models[${index}].contentHash`),
      triangles: readCount(model.triangles, `models[${index}].triangles`),
      emissiveNode: readString(model.emissiveNode, `models[${index}].emissiveNode`),
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
    markFailed(reason: string): void {
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
  };
};

export type AssetRegistry = ReturnType<typeof createAssetRegistry>;
