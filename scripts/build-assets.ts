import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Own zero-dependency glTF 2.0 binary generator. Models live in this file as text,
// artifacts are written to public/models and are not committed, so a diff of the model
// shape is a diff of this source instead of an unreadable binary blob.

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(PROJECT_ROOT, 'public', 'models');
const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json');
const PRECISION = 1e5;

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT_BYTE_SIZE: Record<number, number> = { 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_SHORT = 5123;
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
const MODE_TRIANGLES = 4;

type Vec3 = [number, number, number];

type Geometry = {
  positions: number[];
  normals: number[];
  indices: number[];
};

type MaterialDefinition = {
  baseColorHex: number;
  opacity?: number;
  metallicFactor: number;
  roughnessFactor: number;
  emissiveHex?: number;
};

type PartDefinition = {
  name: string;
  translation: Vec3;
  geometry: Geometry;
  material: MaterialDefinition;
};

type ModelDefinition = {
  id: string;
  emissiveNode: string;
  parts: PartDefinition[];
};

type ManifestEntry = {
  id: string;
  file: string;
  bytes: number;
  contentHash: string;
  triangles: number;
  emissiveNode: string;
};

// Annotated as a never-returning function so the compiler treats every call as a narrowing
// point, which is what makes the validation below readable instead of a ladder of throws.
const fail: (message: string) => never = (message) => {
  throw new Error(`asset contract violation: ${message}`);
};

// Rounded coordinates keep the JSON readable and remove the last-ulp noise of the trig
// functions, so two runs of the generator cannot differ by a float printed differently.
const round = (value: number): number => {
  const rounded = Math.round(value * PRECISION) / PRECISION;
  return rounded === 0 ? 0 : rounded;
};

const linearChannel = (value: number): number => {
  const channel = value / 255;
  return round(channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4));
};

// glTF factors are linear, while every colour in main.ts is written as an sRGB hex, so the
// conversion has to happen here or the same tower would come back a different colour.
const linearColor = (hex: number): number[] => [
  linearChannel((hex >> 16) & 255),
  linearChannel((hex >> 8) & 255),
  linearChannel(hex & 255),
];

const createMesh = () => {
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  return {
    positions,
    normals,
    indices,
    vertex(position: Vec3, normal: Vec3): number {
      positions.push(round(position[0]), round(position[1]), round(position[2]));
      normals.push(round(normal[0]), round(normal[1]), round(normal[2]));
      return positions.length / 3 - 1;
    },
    triangle(a: number, b: number, c: number): void {
      indices.push(a, b, c);
    },
  };
};

type MeshBuilder = ReturnType<typeof createMesh>;

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];

const normalize = (vector: Vec3): Vec3 => {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length === 0) {
    return [0, 1, 0];
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
};

const flatTriangle = (mesh: MeshBuilder, a: Vec3, b: Vec3, c: Vec3): void => {
  const normal = normalize(cross(subtract(b, a), subtract(c, a)));
  mesh.triangle(mesh.vertex(a, normal), mesh.vertex(b, normal), mesh.vertex(c, normal));
};

const capFan = (mesh: MeshBuilder, radius: number, y: number, radialSegments: number, sign: number): void => {
  const normal: Vec3 = [0, sign, 0];
  const center = mesh.vertex([0, y, 0], normal);
  const ring: number[] = [];
  for (let segment = 0; segment <= radialSegments; segment += 1) {
    const theta = (segment / radialSegments) * Math.PI * 2;
    ring.push(mesh.vertex([radius * Math.sin(theta), y, radius * Math.cos(theta)], normal));
  }
  for (let segment = 0; segment < radialSegments; segment += 1) {
    if (sign > 0) {
      mesh.triangle(ring[segment], ring[segment + 1], center);
    } else {
      mesh.triangle(ring[segment + 1], ring[segment], center);
    }
  }
};

const cylinderGeometry = (radiusTop: number, radiusBottom: number, height: number, radialSegments: number): Geometry => {
  const mesh = createMesh();
  const halfHeight = height / 2;
  const slope = (radiusBottom - radiusTop) / height;
  const top: number[] = [];
  const bottom: number[] = [];
  for (let row = 0; row < 2; row += 1) {
    const radius = row === 0 ? radiusTop : radiusBottom;
    const y = row === 0 ? halfHeight : -halfHeight;
    const target = row === 0 ? top : bottom;
    for (let segment = 0; segment <= radialSegments; segment += 1) {
      const theta = (segment / radialSegments) * Math.PI * 2;
      const sin = Math.sin(theta);
      const cos = Math.cos(theta);
      target.push(mesh.vertex([radius * sin, y, radius * cos], normalize([sin, slope, cos])));
    }
  }
  for (let segment = 0; segment < radialSegments; segment += 1) {
    // A cone degenerates its top row into the apex, so the triangle that would collapse
    // onto a point is dropped instead of being emitted as a zero-area face.
    if (radiusTop > 0) {
      mesh.triangle(top[segment], bottom[segment], top[segment + 1]);
    }
    if (radiusBottom > 0) {
      mesh.triangle(bottom[segment], bottom[segment + 1], top[segment + 1]);
    }
  }
  if (radiusTop > 0) {
    capFan(mesh, radiusTop, halfHeight, radialSegments, 1);
  }
  if (radiusBottom > 0) {
    capFan(mesh, radiusBottom, -halfHeight, radialSegments, -1);
  }
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices };
};

const coneGeometry = (radius: number, height: number, radialSegments: number): Geometry =>
  cylinderGeometry(0, radius, height, radialSegments);

const octahedronGeometry = (radius: number): Geometry => {
  const mesh = createMesh();
  const equator: Vec3[] = [[radius, 0, 0], [0, radius, 0], [-radius, 0, 0], [0, -radius, 0]];
  const north: Vec3 = [0, 0, radius];
  const south: Vec3 = [0, 0, -radius];
  for (let side = 0; side < 4; side += 1) {
    const current = equator[side];
    const next = equator[(side + 1) % 4];
    flatTriangle(mesh, current, next, north);
    flatTriangle(mesh, next, current, south);
  }
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices };
};

const torusGeometry = (radius: number, tube: number, radialSegments: number, tubularSegments: number): Geometry => {
  const mesh = createMesh();
  const grid: number[][] = [];
  for (let ring = 0; ring <= radialSegments; ring += 1) {
    const v = (ring / radialSegments) * Math.PI * 2;
    const cosV = Math.cos(v);
    const sinV = Math.sin(v);
    const row: number[] = [];
    for (let segment = 0; segment <= tubularSegments; segment += 1) {
      const u = (segment / tubularSegments) * Math.PI * 2;
      const cosU = Math.cos(u);
      const sinU = Math.sin(u);
      const reach = radius + tube * cosV;
      row.push(
        mesh.vertex([reach * cosU, tube * sinV, reach * sinU], [cosV * cosU, sinV, cosV * sinU]),
      );
    }
    grid.push(row);
  }
  for (let ring = 0; ring < radialSegments; ring += 1) {
    for (let segment = 0; segment < tubularSegments; segment += 1) {
      const a = grid[ring][segment];
      const b = grid[ring + 1][segment];
      const c = grid[ring + 1][segment + 1];
      const d = grid[ring][segment + 1];
      mesh.triangle(a, b, d);
      mesh.triangle(b, c, d);
    }
  }
  return { positions: mesh.positions, normals: mesh.normals, indices: mesh.indices };
};

// Node names are the contract the client animates: `crystal` carries the emissive state and
// the other four are the readable parts that make a model diff legible.
const pulseSpire = (): ModelDefinition => ({
  id: 'pulse-spire',
  emissiveNode: 'crystal',
  parts: [
    {
      name: 'base',
      translation: [0, 0.15, 0],
      geometry: cylinderGeometry(0.46, 0.56, 0.3, 6),
      material: { baseColorHex: 0x1d4651, metallicFactor: 0.34, roughnessFactor: 0.46 },
    },
    {
      name: 'stem',
      translation: [0, 0.5, 0],
      geometry: cylinderGeometry(0.2, 0.28, 0.78, 6),
      material: { baseColorHex: 0x346f75, metallicFactor: 0.5, roughnessFactor: 0.34 },
    },
    {
      name: 'roof',
      translation: [0, 1.08, 0],
      geometry: coneGeometry(0.45, 0.42, 6),
      material: { baseColorHex: 0xd29b62, metallicFactor: 0.3, roughnessFactor: 0.3 },
    },
    {
      name: 'crystal',
      translation: [0, 1.43, 0],
      geometry: octahedronGeometry(0.18),
      material: {
        baseColorHex: 0x6ee2cf,
        emissiveHex: 0x6ee2cf,
        metallicFactor: 0.15,
        roughnessFactor: 0.18,
      },
    },
    {
      // glTF has no unlit material, so the procedural basic-material ring is approximated
      // with a blended emissive PBR material that keeps the same silhouette and alpha.
      name: 'aura',
      translation: [0, 0.18, 0],
      geometry: torusGeometry(0.57, 0.025, 8, 32),
      material: {
        baseColorHex: 0x6ee2cf,
        emissiveHex: 0x6ee2cf,
        opacity: 0.7,
        metallicFactor: 0,
        roughnessFactor: 0.25,
      },
    },
  ],
});

const MODELS: ModelDefinition[] = [pulseSpire()];

type Json = Record<string, unknown>;

type AccessorDefinition = {
  bufferView: number;
  byteOffset: number;
  componentType: number;
  count: number;
  type: string;
  min: number[];
  max: number[];
};

const vectorBounds = (values: number[], components: number): { min: number[]; max: number[] } => {
  const min = new Array<number>(components).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(components).fill(Number.NEGATIVE_INFINITY);
  for (const [index, value] of values.entries()) {
    const component = index % components;
    min[component] = Math.min(min[component], value);
    max[component] = Math.max(max[component], value);
  }
  return { min: min.map(round), max: max.map(round) };
};

const buildGlb = (model: ModelDefinition): { bytes: Buffer; triangles: number } => {
  const binParts: Buffer[] = [];
  const bufferViews: Json[] = [];
  const accessors: AccessorDefinition[] = [];
  const meshes: Json[] = [];
  const materials: Json[] = [];
  const nodes: Json[] = [];
  let binLength = 0;
  let triangles = 0;

  const appendView = (data: Buffer, target: number): number => {
    const padding = (4 - (binLength % 4)) % 4;
    if (padding > 0) {
      binParts.push(Buffer.alloc(padding));
      binLength += padding;
    }
    const byteOffset = binLength;
    binParts.push(data);
    binLength += data.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    return bufferViews.length - 1;
  };

  const vectorAccessor = (values: number[]): number => {
    if (values.length % 3 !== 0 || values.length === 0) {
      fail(`model ${model.id} has a position buffer that is not a non-empty VEC3 list`);
    }
    const data = Buffer.from(new Float32Array(values).buffer);
    const bounds = vectorBounds(values, 3);
    return (
      accessors.push({
        bufferView: appendView(data, TARGET_ARRAY_BUFFER),
        byteOffset: 0,
        componentType: COMPONENT_FLOAT,
        count: values.length / 3,
        type: 'VEC3',
        min: bounds.min,
        max: bounds.max,
      }) - 1
    );
  };

  const indexAccessor = (indices: number[], vertexCount: number): number => {
    if (indices.length === 0 || indices.length % 3 !== 0) {
      fail(`model ${model.id} has an index buffer that is not a whole number of triangles`);
    }
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount) {
        fail(`model ${model.id} references vertex ${index} outside its ${vertexCount} vertex accessor`);
      }
      min = Math.min(min, index);
      max = Math.max(max, index);
    }
    if (vertexCount > 65536) {
      fail(`model ${model.id} exceeds the UNSIGNED_SHORT index range`);
    }
    triangles += indices.length / 3;
    const data = Buffer.from(new Uint16Array(indices).buffer);
    return (
      accessors.push({
        bufferView: appendView(data, TARGET_ELEMENT_ARRAY_BUFFER),
        byteOffset: 0,
        componentType: COMPONENT_UNSIGNED_SHORT,
        count: indices.length,
        type: 'SCALAR',
        min: [min],
        max: [max],
      }) - 1
    );
  };

  for (const part of model.parts) {
    const positionAccessor = vectorAccessor(part.geometry.positions);
    if (part.geometry.normals.length !== part.geometry.positions.length) {
      fail(`model ${model.id} node ${part.name} has a normal per vertex mismatch`);
    }
    const normalAccessor = vectorAccessor(part.geometry.normals);
    const indices = indexAccessor(part.geometry.indices, part.geometry.positions.length / 3);
    materials.push({
      name: `${part.name}-material`,
      doubleSided: false,
      alphaMode: part.material.opacity === undefined ? 'OPAQUE' : 'BLEND',
      pbrMetallicRoughness: {
        baseColorFactor: [...linearColor(part.material.baseColorHex), part.material.opacity ?? 1],
        metallicFactor: part.material.metallicFactor,
        roughnessFactor: part.material.roughnessFactor,
      },
      ...(part.material.emissiveHex === undefined ? {} : { emissiveFactor: linearColor(part.material.emissiveHex) }),
    });
    meshes.push({
      name: `${part.name}-mesh`,
      primitives: [
        {
          attributes: { POSITION: positionAccessor, NORMAL: normalAccessor },
          indices,
          material: meshes.length,
          mode: MODE_TRIANGLES,
        },
      ],
    });
    nodes.push({ name: part.name, mesh: meshes.length - 1, translation: part.translation });
  }

  if (model.parts.length === 0) {
    fail(`model ${model.id} has no parts`);
  }
  if (!nodes.some((node) => node.name === model.emissiveNode)) {
    fail(`model ${model.id} has no ${model.emissiveNode} node`);
  }

  const gltf = {
    asset: { version: '2.0', generator: 'echoes-of-burbenog/build-assets' },
    scene: 0,
    scenes: [{ name: model.id, nodes: model.parts.map((_, index) => index) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonChunk = Buffer.concat([jsonBytes, Buffer.alloc((4 - (jsonBytes.length % 4)) % 4, 0x20)]);
  const binBytes = Buffer.concat(binParts);
  const binChunk = Buffer.concat([binBytes, Buffer.alloc((4 - (binBytes.length % 4)) % 4)]);
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(GLB_MAGIC, 0);
  glb.writeUInt32LE(GLB_VERSION, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonChunk.length, 12);
  glb.writeUInt32LE(CHUNK_JSON, 16);
  jsonChunk.copy(glb, 20);
  const binHeader = 20 + jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, binHeader);
  glb.writeUInt32LE(CHUNK_BIN, binHeader + 4);
  binChunk.copy(glb, binHeader + 8);
  return { bytes: glb, triangles };
};

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const readComponent = (bytes: Buffer, offset: number, componentType: number): number => {
  if (componentType === COMPONENT_FLOAT) {
    return bytes.readFloatLE(offset);
  }
  if (componentType === COMPONENT_UNSIGNED_SHORT) {
    return bytes.readUInt16LE(offset);
  }
  fail(`unsupported component type ${componentType}`);
};

type Chunk = { start: number; length: number };

const readChunks = (bytes: Buffer, label: string): Map<number, Chunk> => {
  if (bytes.length < 12) {
    fail(`${label}: file is shorter than a GLB header`);
  }
  if (bytes.readUInt32LE(0) !== GLB_MAGIC) {
    fail(`${label}: bad magic, expected glTF`);
  }
  const version = bytes.readUInt32LE(4);
  if (version !== GLB_VERSION) {
    fail(`${label}: unsupported container version ${version}`);
  }
  const declared = bytes.readUInt32LE(8);
  if (declared !== bytes.length) {
    fail(`${label}: header length ${declared} does not match the ${bytes.length} bytes on disk`);
  }
  const chunks = new Map<number, Chunk>();
  let cursor = 12;
  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length) {
      fail(`${label}: truncated chunk header at byte ${cursor}`);
    }
    const length = bytes.readUInt32LE(cursor);
    const type = bytes.readUInt32LE(cursor + 4);
    const start = cursor + 8;
    if (length % 4 !== 0) {
      fail(`${label}: chunk 0x${type.toString(16)} length ${length} is not 4-byte aligned`);
    }
    if (start + length > bytes.length) {
      fail(`${label}: chunk 0x${type.toString(16)} runs past the end of the file`);
    }
    if (chunks.has(type)) {
      fail(`${label}: duplicate chunk 0x${type.toString(16)}`);
    }
    chunks.set(type, { start, length });
    cursor = start + length;
  }
  if (cursor !== bytes.length) {
    fail(`${label}: chunk table does not cover the file`);
  }
  return chunks;
};

const readGltfJson = (bytes: Buffer, label: string): { gltf: Json; bin: Chunk } => {
  const chunks = readChunks(bytes, label);
  const json = chunks.get(CHUNK_JSON);
  if (!json) {
    fail(`${label}: no JSON chunk`);
  }
  const bin = chunks.get(CHUNK_BIN);
  if (!bin) {
    fail(`${label}: no BIN chunk`);
  }
  let gltf: Json;
  try {
    gltf = JSON.parse(bytes.subarray(json.start, json.start + json.length).toString('utf8')) as Json;
  } catch (error) {
    fail(`${label}: JSON chunk does not parse (${(error as Error).message})`);
  }
  return { gltf, bin };
};

const asArray = (value: unknown, label: string): Json[] => {
  if (!Array.isArray(value)) {
    fail(`expected an array for ${label}`);
  }
  return value as Json[];
};

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`expected a finite number for ${label}`);
  }
  return value;
};

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`expected a non-empty string for ${label}`);
  }
  return value;
};

type AccessorValues = { values: number[]; count: number; components: number };

const readAccessorValues = (
  bytes: Buffer,
  gltf: Json,
  bin: Chunk,
  accessorIndex: number,
  label: string,
): AccessorValues => {
  const accessors = asArray(gltf.accessors, `${label} accessors`);
  const accessor = accessors[accessorIndex];
  if (!accessor) {
    fail(`${label}: accessor ${accessorIndex} does not exist`);
  }
  const componentType = asNumber(accessor.componentType, `${label} accessor ${accessorIndex} componentType`);
  const componentSize = COMPONENT_BYTE_SIZE[componentType];
  if (componentSize === undefined) {
    fail(`${label}: accessor ${accessorIndex} uses unsupported component type ${componentType}`);
  }
  const components = TYPE_COMPONENTS[asString(accessor.type, `${label} accessor ${accessorIndex} type`)];
  if (components === undefined) {
    fail(`${label}: accessor ${accessorIndex} uses unsupported type ${String(accessor.type)}`);
  }
  const count = asNumber(accessor.count, `${label} accessor ${accessorIndex} count`);
  if (!Number.isInteger(count) || count <= 0) {
    fail(`${label}: accessor ${accessorIndex} count ${count} is not a positive integer`);
  }
  const bufferViews = asArray(gltf.bufferViews, `${label} bufferViews`);
  const view = bufferViews[asNumber(accessor.bufferView, `${label} accessor ${accessorIndex} bufferView`)];
  if (!view) {
    fail(`${label}: accessor ${accessorIndex} points at a missing bufferView`);
  }
  const viewOffset = asNumber(view.byteOffset, `${label} bufferView byteOffset`);
  const accessorOffset = accessor.byteOffset === undefined ? 0 : asNumber(accessor.byteOffset, `${label} accessor byteOffset`);
  const values: number[] = [];
  for (let element = 0; element < count; element += 1) {
    for (let component = 0; component < components; component += 1) {
      const offset = bin.start + viewOffset + accessorOffset + (element * components + component) * componentSize;
      if (offset + componentSize > bytes.length) {
        fail(`${label}: accessor ${accessorIndex} element ${element} reads past the end of the file`);
      }
      values.push(readComponent(bytes, offset, componentType));
    }
  }
  return { values, count, components };
};

const verifyGlb = (bytes: Buffer, entry: ManifestEntry): void => {
  const label = entry.file;
  if (bytes.length !== entry.bytes) {
    fail(`${label}: ${bytes.length} bytes on disk but the manifest claims ${entry.bytes}`);
  }
  const hash = sha256(bytes);
  if (hash !== entry.contentHash) {
    fail(`${label}: content hash ${hash} does not match the manifest claim ${entry.contentHash}`);
  }
  const { gltf, bin } = readGltfJson(bytes, label);

  const asset = gltf.asset as Json | undefined;
  if (!asset || asset.version !== '2.0') {
    fail(`${label}: asset.version must be 2.0`);
  }
  if (gltf.extensions !== undefined || gltf.extensionsUsed !== undefined || gltf.extensionsRequired !== undefined) {
    fail(`${label}: extensions are not allowed in this pipeline`);
  }
  if (gltf.animations !== undefined) {
    fail(`${label}: animation clips are not allowed in this pipeline`);
  }
  if (gltf.skins !== undefined) {
    fail(`${label}: skinned meshes are not allowed in this pipeline`);
  }
  const buffers = asArray(gltf.buffers, `${label} buffers`);
  if (buffers.length !== 1) {
    fail(`${label}: expected exactly one embedded buffer, found ${buffers.length}`);
  }
  const buffer = buffers[0];
  if (buffer.uri !== undefined) {
    fail(`${label}: external buffer URIs are not allowed`);
  }
  const bufferLength = asNumber(buffer.byteLength, `${label} buffer byteLength`);
  if (bufferLength > bin.length || bin.length - bufferLength >= 4) {
    fail(`${label}: buffer byteLength ${bufferLength} does not match the ${bin.length} byte BIN chunk`);
  }

  const bufferViews = asArray(gltf.bufferViews, `${label} bufferViews`);
  const accessors = asArray(gltf.accessors, `${label} accessors`);
  for (const [index, view] of bufferViews.entries()) {
    const offset = asNumber(view.byteOffset ?? 0, `${label} bufferView ${index} byteOffset`);
    const length = asNumber(view.byteLength, `${label} bufferView ${index} byteLength`);
    if (offset % 4 !== 0) {
      fail(`${label}: bufferView ${index} byteOffset ${offset} is not 4-byte aligned`);
    }
    if (offset + length > bufferLength) {
      fail(`${label}: bufferView ${index} runs past the ${bufferLength} byte buffer`);
    }
  }
  for (const [index, accessor] of accessors.entries()) {
    const componentType = asNumber(accessor.componentType, `${label} accessor ${index} componentType`);
    const componentSize = COMPONENT_BYTE_SIZE[componentType];
    if (componentSize === undefined) {
      fail(`${label}: accessor ${index} uses unsupported component type ${componentType}`);
    }
    const components = TYPE_COMPONENTS[asString(accessor.type, `${label} accessor ${index} type`)];
    if (components === undefined) {
      fail(`${label}: accessor ${index} uses unsupported type ${String(accessor.type)}`);
    }
    const view = bufferViews[asNumber(accessor.bufferView, `${label} accessor ${index} bufferView`)];
    if (!view) {
      fail(`${label}: accessor ${index} points at a missing bufferView`);
    }
    const accessorOffset = accessor.byteOffset === undefined ? 0 : asNumber(accessor.byteOffset, `${label} accessor ${index} byteOffset`);
    if (accessorOffset % componentSize !== 0) {
      fail(`${label}: accessor ${index} byteOffset ${accessorOffset} is not aligned to its component size`);
    }
    const viewLength = asNumber(view.byteLength, `${label} bufferView ${view.bufferView as number} byteLength`);
    if (accessorOffset + asNumber(accessor.count, `${label} accessor ${index} count`) * components * componentSize > viewLength) {
      fail(`${label}: accessor ${index} does not fit its bufferView`);
    }
  }

  const nodes = asArray(gltf.nodes, `${label} nodes`);
  const meshes = asArray(gltf.meshes, `${label} meshes`);
  const materials = asArray(gltf.materials, `${label} materials`);
  let triangleCount = 0;
  for (const [meshIndex, mesh] of meshes.entries()) {
    const primitives = asArray(mesh.primitives, `${label} mesh ${meshIndex} primitives`);
    for (const [primitiveIndex, primitive] of primitives.entries()) {
      const where = `${label} mesh ${meshIndex} primitive ${primitiveIndex}`;
      const attributes = primitive.attributes as Json | undefined;
      if (!attributes) {
        fail(`${where}: no attributes`);
      }
      const positionAccessor = asNumber(attributes.POSITION, `${where} POSITION`);
      if (attributes.NORMAL === undefined) {
        fail(`${where}: normals are required`);
      }
      const positions = readAccessorValues(bytes, gltf, bin, positionAccessor, where);
      if (positions.components !== 3) {
        fail(`${where}: POSITION must be VEC3`);
      }
      const range = accessors[positionAccessor];
      const min = range.min as number[] | undefined;
      const max = range.max as number[] | undefined;
      if (!Array.isArray(min) || min.length !== 3 || !Array.isArray(max) || max.length !== 3) {
        fail(`${where}: POSITION accessor needs min and max`);
      }
      const normals = readAccessorValues(
        bytes,
        gltf,
        bin,
        asNumber(attributes.NORMAL, `${where} NORMAL`),
        where,
      );
      if (normals.count !== positions.count) {
        fail(`${where}: NORMAL count ${normals.count} does not match POSITION count ${positions.count}`);
      }
      if (primitive.mode !== undefined && primitive.mode !== MODE_TRIANGLES) {
        fail(`${where}: mode ${String(primitive.mode)} is not TRIANGLES`);
      }
      const materialIndex = asNumber(primitive.material, `${where} material`);
      const material = materials[materialIndex];
      if (!material) {
        fail(`${where}: material ${materialIndex} does not exist`);
      }
      if (material.pbrMetallicRoughness === undefined) {
        fail(`${where}: pbrMetallicRoughness is required`);
      }
      const indices = readAccessorValues(bytes, gltf, bin, asNumber(primitive.indices, `${where} indices`), where);
      if (indices.components !== 1) {
        fail(`${where}: indices must be SCALAR`);
      }
      if (indices.count % 3 !== 0) {
        fail(`${where}: ${indices.count} indices are not a whole number of triangles`);
      }
      triangleCount += indices.count / 3;
      for (const [triangle, index] of indices.values.entries()) {
        if (index >= positions.count) {
          fail(`${where}: triangle ${triangle} references vertex ${index} of a ${positions.count} vertex accessor`);
        }
      }
      // Winding and vertex normals have to agree, otherwise front faces point inwards and the
      // model renders as an empty shell under backface culling.
      for (let triangle = 0; triangle < indices.count; triangle += 3) {
        const read = (element: number, component: number) =>
          positions.values[element * 3 + component] as number;
        const normalAt = (element: number, component: number) => normals.values[element * 3 + component] as number;
        const [first, second, third] = [
          indices.values[triangle] as number,
          indices.values[triangle + 1] as number,
          indices.values[triangle + 2] as number,
        ];
        const edgeA: Vec3 = [read(second, 0) - read(first, 0), read(second, 1) - read(first, 1), read(second, 2) - read(first, 2)];
        const edgeB: Vec3 = [read(third, 0) - read(first, 0), read(third, 1) - read(first, 1), read(third, 2) - read(first, 2)];
        const faceNormal = cross(edgeA, edgeB);
        const stored: Vec3 = [
          normalAt(first, 0) + normalAt(second, 0) + normalAt(third, 0),
          normalAt(first, 1) + normalAt(second, 1) + normalAt(third, 1),
          normalAt(first, 2) + normalAt(second, 2) + normalAt(third, 2),
        ];
        if (faceNormal[0] * stored[0] + faceNormal[1] * stored[1] + faceNormal[2] * stored[2] <= 0) {
          fail(`${where}: triangle ${triangle / 3} winds against its vertex normals`);
        }
      }
    }
  }
  if (triangleCount !== entry.triangles) {
    fail(`${label}: ${triangleCount} triangles in the file but the manifest claims ${entry.triangles}`);
  }

  const emissiveNode = nodes.find((node) => node.name === entry.emissiveNode);
  if (!emissiveNode) {
    fail(`${label}: no node named ${entry.emissiveNode}`);
  }
  const emissiveMesh = meshes[asNumber(emissiveNode.mesh, `${label} emissive node mesh`)];
  if (!emissiveMesh) {
    fail(`${label}: emissive node ${entry.emissiveNode} has no mesh`);
  }
  const emissivePrimitive = asArray(emissiveMesh.primitives, `${label} emissive primitives`)[0];
  if (!emissivePrimitive) {
    fail(`${label}: emissive node ${entry.emissiveNode} has no primitive`);
  }
  const emissiveMaterial = materials[asNumber(emissivePrimitive.material, `${label} emissive material`)];
  const pbr = (emissiveMaterial?.pbrMetallicRoughness ?? {}) as Json;
  if (emissiveMaterial?.emissiveFactor === undefined) {
    fail(`${label}: emissive node ${entry.emissiveNode} has no emissiveFactor`);
  }
  if (pbr.baseColorFactor === undefined || pbr.metallicFactor === undefined || pbr.roughnessFactor === undefined) {
    fail(`${label}: emissive node ${entry.emissiveNode} needs baseColorFactor, metallicFactor and roughnessFactor`);
  }
  for (const [index, material] of materials.entries()) {
    if (material.textures !== undefined) {
      fail(`${label}: material ${index} declares textures`);
    }
  }
};

const expectRejection = (bytes: Buffer, entry: ManifestEntry, pattern: RegExp, label: string): void => {
  let message: string | null = null;
  try {
    verifyGlb(bytes, entry);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === null) {
    fail(`self-test: a corrupted file (${label}) was accepted, so the check proves nothing`);
  }
  if (!pattern.test(message)) {
    fail(`self-test: ${label} failed with an unexpected message: ${message}`);
  }
  console.log(`  red check ok: ${label} -> ${message}`);
};

const runSelfTest = (model: ModelDefinition, entry: ManifestEntry, bytes: Buffer): void => {
  // Determinism first: the same description has to produce the same bytes, otherwise the
  // manifest hash is meaningless and a rebuild looks like a change of the model.
  const rebuilt = buildGlb(model);
  assert(rebuilt.bytes.equals(bytes), 'generator is not deterministic: a second build produced different bytes');
  assert.equal(sha256(rebuilt.bytes), entry.contentHash, 'generator is not deterministic: content hash changed');

  // Every corrupted file is rehashed against the manifest, so the rejection has to come from
  // the structural check under test and never from the byte-identity check in front of it.
  const rehash = (corrupted: Buffer): ManifestEntry => ({
    ...entry,
    bytes: corrupted.length,
    contentHash: sha256(corrupted),
  });

  const brokenMagic = Buffer.from(bytes);
  brokenMagic.writeUInt32LE(0x12345678, 0);
  expectRejection(brokenMagic, rehash(brokenMagic), /bad magic/, 'broken magic');

  const truncated = Buffer.from(bytes.subarray(0, bytes.length - 8));
  truncated.writeUInt32LE(truncated.length, 8);
  expectRejection(truncated, rehash(truncated), /runs past the end of the file/, 'truncated chunk');

  // One index rewritten past the end of its position accessor.
  const { gltf, bin } = readGltfJson(bytes, entry.file);
  const nodes = asArray(gltf.nodes, `${entry.file} nodes`);
  const meshes = asArray(gltf.meshes, `${entry.file} meshes`);
  const accessors = asArray(gltf.accessors, `${entry.file} accessors`);
  const bufferViews = asArray(gltf.bufferViews, `${entry.file} bufferViews`);
  const node = nodes[0];
  const mesh = meshes[asNumber(node?.mesh, 'node mesh')];
  const primitive = asArray(mesh?.primitives, 'mesh primitives')[0];
  const indexAccessor = accessors[asNumber(primitive?.indices, 'primitive indices')];
  const view = bufferViews[asNumber(indexAccessor?.bufferView, 'index bufferView')];
  const vertexCount = asNumber(
    (accessors[asNumber((primitive?.attributes as Json)?.POSITION, 'POSITION accessor')] ?? {}).count,
    'position count',
  );
  const corrupted = Buffer.from(bytes);
  const firstIndexOffset = bin.start + asNumber(view.byteOffset, 'view byteOffset');
  corrupted.writeUInt16LE(vertexCount + 7, firstIndexOffset);
  expectRejection(
    corrupted,
    rehash(corrupted),
    /references vertex .* of a .* vertex accessor/,
    'index outside the accessor',
  );

  const brokenVersion = Buffer.from(bytes);
  brokenVersion.writeUInt32LE(1, 4);
  expectRejection(brokenVersion, rehash(brokenVersion), /unsupported container version/, 'unsupported container version');

  const badLength = Buffer.from(bytes);
  badLength.writeUInt32LE(bytes.length + 4, 8);
  expectRejection(badLength, rehash(badLength), /does not match the .* bytes on disk/, 'header length mismatch');
};

const parseManifest = (raw: string): { version: number; models: ManifestEntry[] } => {
  const parsed = JSON.parse(raw) as Json;
  const version = asNumber(parsed.version, 'manifest version');
  if (version !== 1) {
    fail(`manifest version ${version} is not supported`);
  }
  const models = asArray(parsed.models, 'manifest models');
  if (models.length === 0) {
    fail('manifest lists no models');
  }
  for (const [index, model] of models.entries()) {
    for (const field of ['id', 'file', 'contentHash', 'emissiveNode'] as const) {
      asString(model[field], `manifest model ${index} ${field}`);
    }
    for (const field of ['bytes', 'triangles'] as const) {
      asNumber(model[field], `manifest model ${index} ${field}`);
    }
  }
  return { version, models: models as unknown as ManifestEntry[] };
};

const build = (): { entries: ManifestEntry[]; built: Map<string, Buffer> } => {
  const entries: ManifestEntry[] = [];
  const built = new Map<string, Buffer>();
  for (const model of MODELS) {
    const result = buildGlb(model);
    const entry: ManifestEntry = {
      id: model.id,
      file: `${model.id}.glb`,
      bytes: result.bytes.length,
      contentHash: sha256(result.bytes),
      triangles: result.triangles,
      emissiveNode: model.emissiveNode,
    };
    verifyGlb(result.bytes, entry);
    writeFileSync(join(OUTPUT_DIR, entry.file), result.bytes);
    built.set(model.id, result.bytes);
    entries.push(entry);
  }
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ version: 1, models: entries }, null, 2)}\n`);
  return { entries, built };
};

const check = (): ManifestEntry[] => {
  const { models } = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of models) {
    verifyGlb(readFileSync(join(OUTPUT_DIR, entry.file)), entry);
  }
  return models;
};

const main = (): void => {
  const mode = process.argv[2] ?? '--write';
  if (!['--write', '--test', '--check'].includes(mode)) {
    fail(`unknown mode ${mode}, expected --write, --test or --check`);
  }
  if (mode === '--check') {
    const models = check();
    console.log(`asset check: ok (${models.map((entry) => `${entry.id} ${entry.triangles} tris`).join(', ')})`);
    return;
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const { entries, built } = build();
  check();
  if (mode === '--test') {
    const first = entries[0];
    runSelfTest(MODELS[0], first, built.get(first.id) as Buffer);
  }
  for (const entry of entries) {
    console.log(`${entry.id}: ${entry.file} ${entry.bytes} bytes, ${entry.triangles} triangles, ${entry.contentHash}`);
  }
  console.log(`assets: ok (${mode})`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
