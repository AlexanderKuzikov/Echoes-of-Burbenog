import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MODEL_BUDGET,
  REGISTRY_BUDGET,
  TERRAIN_MODEL_BUDGET,
  checkClipTargets,
  checkModelContract,
  checkNodeTypes,
  checkRegistryBudgets,
  describeFailures,
  sumRegistry,
} from '../src/asset-budgets.ts';
import type {
  ClipTargetReading,
  ModelMeasurement,
  NodeReading,
  RegistryModelReading,
} from '../src/asset-budgets.ts';
import {
  TERRAIN_SLOT_COUNT,
  TERRAIN_TRIANGLE_LIMIT,
  instancedEntries,
  isTerrainRecord,
  parseAssetManifest,
} from '../src/asset-registry.ts';
import type { AssetManifest, ModelManifestEntry, TerrainModelEntry, TerrainPlacement } from '../src/asset-registry.ts';

// Own zero-dependency glTF 2.0 binary generator. Models live in this file as text,
// artifacts are written to public/models and are not committed, so a diff of the model
// shape is a diff of this source instead of an unreadable binary blob. The limits it has to
// respect are not written here: they live in src/asset-budgets.ts, which the client imports too.

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUTPUT_DIR = join(PROJECT_ROOT, 'public', 'models');
const MANIFEST_PATH = join(OUTPUT_DIR, 'manifest.json');
// The second source. `NexusDefense` exported these ten GLB and the manifest that describes them, and
// they live in the repository as they arrived: the models a player loads have to come out of a tree
// that also holds the game, and a path into a neighbouring checkout is a promise rather than a build
// input. `build-assets.ts` copies them, so the copy can never drift from the source it claims to be.
const ACCEPTED_DIR = join(PROJECT_ROOT, 'assets', 'accepted');
const ACCEPTED_MANIFEST_PATH = join(ACCEPTED_DIR, 'manifest.json');
// The third source, and it is a third directory rather than more records in the second one. The forty
// terrain models came out of `NexusModeler` as their own export with their own manifest, and keeping
// them beside the towers and creatures would mix two producers' bytes into one file that claims to be
// one export — and the day the sets diverge there would be nothing in the tree saying whose is whose.
// Same reason, same treatment: files in the repository as they arrived, copied here so the copy cannot
// drift from what it claims to be.
const LAND_DIR = join(ACCEPTED_DIR, 'land');
const LAND_MANIFEST_PATH = join(LAND_DIR, 'manifest.json');
const PRECISION = 1e5;

const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
const COMPONENT_BYTE_SIZE: Record<number, number> = { 5123: 2, 5125: 4, 5126: 4 };
const COMPONENT_FLOAT = 5126;
const COMPONENT_UNSIGNED_SHORT = 5123;
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;
const MODE_TRIANGLES = 4;
// The length of a face normal below which a triangle covers no ground at all: the cross product of
// two edges that lie on top of each other. Models in this pipeline are a few world units tall, so
// anything under this cannot be a face anyone would ever see.
const DEGENERATE_FACE_NORMAL = 1e-9;
// JOINTS_0 and WEIGHTS_0 are VEC4, so a vertex can name four bones whether or not it uses them.
const WEIGHT_SLOTS = 4;

type Vec3 = [number, number, number];
type Vec4 = [number, number, number, number];

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

// A bone is a translation in the bind pose. The hierarchy is written out by name so the rig stays
// readable in this file instead of becoming an array of parent indices.
type BoneDefinition = {
  name: string;
  translation: Vec3;
  parent: string | null;
};

// One looping clip, keyed on the bone it drives. `times` and `rotations` are the same arrays that go
// into the accessors, so the clip the file carries is the clip this file describes.
type ClipDefinition = {
  name: string;
  bone: string;
  times: number[];
  rotations: Vec4[];
  // The probe models use this to write a channel the client is not able to play. A `weights` channel
  // also needs morph targets, which the model budget is at zero, so the file would be refused for two
  // reasons and only the first one is worth testing.
  path?: 'rotation' | 'weights';
};

type SkeletonDefinition = {
  // The contract allows one skinned mesh per model, and naming the part here keeps that promise
  // next to the rig instead of spread over the node table.
  skinnedPart: string;
  bones: BoneDefinition[];
  clip: ClipDefinition;
};

type ModelDefinition = {
  id: string;
  emissiveNode: string;
  parts: PartDefinition[];
  skeleton?: SkeletonDefinition;
};

type ManifestEntry = {
  id: string;
  file: string;
  bytes: number;
  contentHash: string;
  triangles: number;
  // Optional, because a terrain record may honestly have nothing to light and the towers and creatures
  // may not. The client's parser is what decides which records must name one; here the field is only
  // ever read when the file being verified claims it.
  emissiveNode?: string;
  // Carried through from the accepted export untouched: a model that declares a gap above the ground
  // has to reach the client in the published manifest, or the field the exporter wrote is a comment.
  hoverY?: number;
  // The placement a terrain record carries from the producer. Never written by this generator — it
  // publishes towers and creatures of its own — but read off the records it copies, so a republish
  // cannot drop the one field that says which cell a prop stands on.
  land?: TerrainPlacement;
};

type ModelBuild = {
  bytes: Buffer;
  triangles: number;
  measurement: ModelMeasurement;
  nodeTypes: NodeReading[];
  clipTargets: ClipTargetReading[];
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

// A rotation of `radians` about Z, in the (x, y, z, w) order glTF stores quaternions in. The sway
// keys are the same rotation and its opposite, so the first key of the loop is the identity and the
// rest pose is a pose the clip actually contains.
const rotationAboutZ = (radians: number): Vec4 => [
  0,
  0,
  round(Math.sin(radians / 2)),
  round(Math.cos(radians / 2)),
];

const REST_POSE: Vec4 = [0, 0, 0, 1];

// The inverse bind matrix of a joint is the inverse of its world transform in the bind pose. Bind
// pose bones are translations along their chain, so the inverse is the negated sum of the chain and
// this is that sum, written as a column-major 4x4 the way glTF expects.
const inverseBindMatrix = (chainTranslation: Vec3): number[] => {
  const columnMajor = new Array<number>(16).fill(0);
  columnMajor[0] = 1;
  columnMajor[5] = 1;
  columnMajor[10] = 1;
  columnMajor[15] = 1;
  columnMajor[12] = round(-chainTranslation[0]);
  columnMajor[13] = round(-chainTranslation[1]);
  columnMajor[14] = round(-chainTranslation[2]);
  return columnMajor;
};

const sumVec3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// The heaviest vertex decides the budget, so the count is taken over the array that goes into the
// accessor rather than over the intent that produced it.
const countInfluences = (weights: number[], slots: number): number => {
  let heaviest = 0;
  for (let vertex = 0; vertex * slots < weights.length; vertex += 1) {
    let influences = 0;
    for (let slot = 0; slot < slots; slot += 1) {
      if ((weights[vertex * slots + slot] ?? 0) > 0) {
        influences += 1;
      }
    }
    heaviest = Math.max(heaviest, influences);
  }
  return heaviest;
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
  // The crystal is the one skinned mesh of the model: its vertices are bound to the sway bone, and
  // a two second loop rocks it ±0.18 rad about Z. The first key is the rest pose, so a model that
  // plays no clip at all stands exactly where the mesh data says it should.
  skeleton: {
    skinnedPart: 'crystal',
    bones: [
      { name: 'crystal-root', translation: [0, 1.43, 0], parent: null },
      { name: 'crystal-sway', translation: [0, 0, 0], parent: 'crystal-root' },
    ],
    clip: {
      name: 'pulse',
      bone: 'crystal-sway',
      times: [0, 1, 2],
      rotations: [REST_POSE, rotationAboutZ(0.18), REST_POSE],
    },
  },
});

const MODELS: ModelDefinition[] = [pulseSpire()];

// A model built only to be refused: one tiny part per material the budget allows, plus one over.
// Every part sits on the ground plane, so the probe breaks exactly one budget and the check
// cannot pass for a reason the geometry caused by accident. It is a real model rather than a
// hand-made measurement, so the self-test proves the gate is reachable from the write path.
const overBudgetModel = (parts: number): ModelDefinition => ({
  id: 'budget-probe',
  emissiveNode: 'part-0',
  parts: Array.from({ length: parts }, (_, index) => ({
    name: `part-${index}`,
    translation: [0, 0.05, 0],
    geometry: octahedronGeometry(0.05),
    material: {
      baseColorHex: 0x6ee2cf,
      // The contract check in front of the gate needs an emissive node, otherwise the probe
      // would be refused for the wrong reason and would prove nothing about the budget.
      ...(index === 0 ? { emissiveHex: 0x6ee2cf } : {}),
      metallicFactor: 0,
      roughnessFactor: 0.5,
    },
  })),
});

// Two probes around the skeleton, both real models so that the refusals they cause come out of the
// write path. The first carries more bones than the budget allows and nothing else wrong; the second
// keeps the rig intact and writes one channel the client does not play, so the file still parses and
// still loads — the refusal has to come from the contract, not from a broken container.
const skeletonProbes = () => {
  const base = pulseSpire();
  const rig = base.skeleton as SkeletonDefinition;
  const extraBones: BoneDefinition[] = Array.from({ length: MODEL_BUDGET.bones }, (_, index) => ({
    name: `crystal-bone-${index}`,
    translation: [0, 0, 0],
    parent: 'crystal-root',
  }));
  return {
    overBoneBudget: {
      ...base,
      id: 'skeleton-probe',
      skeleton: { ...rig, bones: [...rig.bones, ...extraBones] },
    },
    unplayableClip: {
      ...base,
      id: 'clip-probe',
      skeleton: { ...rig, clip: { ...rig.clip, path: 'weights' as const } },
    },
  };
};

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

// A node that carries a mesh arrives at the client as a Mesh, a joint as a Bone, a node with a mesh
// and a skin as a SkinnedMesh, and a node without one as a Group. The generator reports the same
// three.js types the loader will produce, so one contract check covers both sides of the pipeline.
const gltfNodeType = (node: Json, index: number, joints: ReadonlySet<number>): string => {
  if (joints.has(index)) {
    return 'Bone';
  }
  if (node.mesh !== undefined) {
    return node.skin === undefined ? 'Mesh' : 'SkinnedMesh';
  }
  return Array.isArray(node.children) && node.children.length > 0 ? 'Group' : 'Object3D';
};

const TEXTURE_SLOTS: readonly string[] = [
  'normalTexture',
  'occlusionTexture',
  'emissiveTexture',
];

const countsTexture = (material: Json): boolean => {
  const pbr = (material.pbrMetallicRoughness ?? {}) as Json;
  if (pbr.baseColorTexture !== undefined || pbr.metallicRoughnessTexture !== undefined) {
    return true;
  }
  return TEXTURE_SLOTS.some((slot) => material[slot] !== undefined);
};

// Everything the budget check needs, measured off the same arrays that go into the file: the
// positions below are the rounded values the accessors carry, so the height, the footprint and
// the pivot the gate sees are the ones a player will actually see in the scene. The skeleton is
// measured the same way: bones are the joints the skin names, the influence count is the heaviest
// vertex of the weight array, and the clip length is the last key of the input accessor.
const measureModel = (
  model: ModelDefinition,
  gltf: Json,
  bytes: number,
  triangles: number,
  boneInfluences: number,
): ModelMeasurement => {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let footprint = 0;
  for (const part of model.parts) {
    const [offsetX, offsetY, offsetZ] = part.translation;
    const positions = part.geometry.positions;
    for (let index = 0; index + 2 < positions.length; index += 3) {
      const x = (positions[index] as number) + offsetX;
      const y = (positions[index + 1] as number) + offsetY;
      const z = (positions[index + 2] as number) + offsetZ;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      footprint = Math.max(footprint, Math.hypot(x, z));
    }
  }
  const nodes = asArray(gltf.nodes, `model ${model.id} nodes`);
  const meshes = asArray(gltf.meshes, `model ${model.id} meshes`);
  const materials = asArray(gltf.materials, `model ${model.id} materials`);
  const skins = asArray(gltf.skins ?? [], `model ${model.id} skins`);
  const animations = asArray(gltf.animations ?? [], `model ${model.id} animations`);
  let morphTargets = 0;
  for (const [meshIndex, mesh] of meshes.entries()) {
    const primitives = asArray(mesh.primitives, `model ${model.id} mesh ${meshIndex} primitives`);
    for (const primitive of primitives) {
      morphTargets += ((primitive.targets ?? []) as Json[]).length;
    }
  }
  let clipSeconds = 0;
  const accessorTable = asArray(gltf.accessors, `model ${model.id} accessors`);
  for (const animation of animations) {
    for (const sampler of asArray(animation.samplers, `model ${model.id} animation samplers`)) {
      const input = accessorTable[asNumber(sampler.input, `model ${model.id} animation input`)];
      const bounds = (input?.max ?? []) as number[];
      clipSeconds = Math.max(clipSeconds, bounds[bounds.length - 1] ?? 0);
    }
  }
  const bones = skins.reduce((total, skin) => total + asArray(skin.joints, `model ${model.id} skin joints`).length, 0);
  return {
    id: model.id,
    bytes,
    triangles,
    nodes: nodes.length,
    meshes: meshes.length,
    materials: materials.length,
    textures: materials.filter(countsTexture).length,
    skins: skins.length,
    morphTargets,
    animationClips: animations.length,
    bones,
    weightSlots: WEIGHT_SLOTS,
    boneInfluences,
    clipSeconds,
    height: round(maxY - minY),
    footprintRadius: round(footprint),
    pivotY: round(minY),
  };
};

const buildGlb = (model: ModelDefinition): ModelBuild => {
  const binParts: Buffer[] = [];
  const bufferViews: Json[] = [];
  const accessors: AccessorDefinition[] = [];
  const meshes: Json[] = [];
  const materials: Json[] = [];
  const nodes: Json[] = [];
  const parts = new Map<string, { node: number; mesh: number; vertexCount: number }>();
  let binLength = 0;
  let triangles = 0;

  // A target is only declared for data the GPU reads through a vertex attribute pointer. The
  // inverse bind matrices and the animation samplers are read by the CPU into a skeleton and a clip,
  // so glTF asks for them to carry no target at all.
  const appendView = (data: Buffer, target?: number): number => {
    const padding = (4 - (binLength % 4)) % 4;
    if (padding > 0) {
      binParts.push(Buffer.alloc(padding));
      binLength += padding;
    }
    const byteOffset = binLength;
    binParts.push(data);
    binLength += data.length;
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, ...(target === undefined ? {} : { target }) });
    return bufferViews.length - 1;
  };

  const vectorAccessor = (values: number[], type: 'VEC3' | 'VEC4' | 'MAT4' = 'VEC3'): number => {
    const components = TYPE_COMPONENTS[type];
    if (components === undefined || values.length % components !== 0 || values.length === 0) {
      fail(`model ${model.id} has a buffer that is not a non-empty ${type} list`);
    }
    const data = Buffer.from(new Float32Array(values).buffer);
    const bounds = vectorBounds(values, components);
    return (
      accessors.push({
        bufferView: appendView(data, type === 'MAT4' ? undefined : TARGET_ARRAY_BUFFER),
        byteOffset: 0,
        componentType: COMPONENT_FLOAT,
        count: values.length / components,
        type,
        min: bounds.min,
        max: bounds.max,
      }) - 1
    );
  };

  // Animation sampler input. glTF asks for min and max on it, and the same bounds are what the
  // clip length is measured from on both sides of the pipeline.
  const scalarAccessor = (values: number[]): number => {
    if (values.length === 0) {
      fail(`model ${model.id} has an empty animation sampler input`);
    }
    const data = Buffer.from(new Float32Array(values).buffer);
    return (
      accessors.push({
        bufferView: appendView(data),
        byteOffset: 0,
        componentType: COMPONENT_FLOAT,
        count: values.length,
        type: 'SCALAR',
        min: [round(Math.min(...values))],
        max: [round(Math.max(...values))],
      }) - 1
    );
  };

  // JOINTS_0 is a list of bone indices, so it is not a float buffer and it is not a list of triples.
  const jointAccessor = (values: number[], vertexCount: number, label: string): number => {
    if (values.length !== vertexCount * WEIGHT_SLOTS) {
      fail(`model ${model.id} has ${label} for ${vertexCount} vertices that is not ${WEIGHT_SLOTS} per vertex`);
    }
    for (const value of values) {
      if (!Number.isInteger(value) || value < 0) {
        fail(`model ${model.id} has ${label} entry ${value} that is not a bone index`);
      }
    }
    const data = Buffer.from(new Uint16Array(values).buffer);
    const bounds = vectorBounds(values, WEIGHT_SLOTS);
    return (
      accessors.push({
        bufferView: appendView(data, TARGET_ARRAY_BUFFER),
        byteOffset: 0,
        componentType: COMPONENT_UNSIGNED_SHORT,
        count: vertexCount,
        type: 'VEC4',
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
    const vertexCount = part.geometry.positions.length / 3;
    const positionAccessor = vectorAccessor(part.geometry.positions);
    if (part.geometry.normals.length !== part.geometry.positions.length) {
      fail(`model ${model.id} node ${part.name} has a normal per vertex mismatch`);
    }
    const normalAccessor = vectorAccessor(part.geometry.normals);
    const indices = indexAccessor(part.geometry.indices, vertexCount);
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
          material: materials.length - 1,
          mode: MODE_TRIANGLES,
        },
      ],
    });
    nodes.push({ name: part.name, mesh: meshes.length - 1, translation: part.translation });
    parts.set(part.name, { node: nodes.length - 1, mesh: meshes.length - 1, vertexCount });
  }

  if (model.parts.length === 0) {
    fail(`model ${model.id} has no parts`);
  }
  if (!parts.has(model.emissiveNode)) {
    fail(`model ${model.id} has no ${model.emissiveNode} node`);
  }

  // The skeleton: joints after the parts, so the parts keep the low node indices the model diff and
  // the emissive contract were written against. A joint carries no mesh, which is what tells the
  // loader to build a Bone rather than an empty group.
  const skins: Json[] = [];
  const animations: Json[] = [];
  const clipTargets: ClipTargetReading[] = [];
  const joints = new Set<number>();
  let boneInfluences = 0;
  const rootNodes: number[] = model.parts.map((_, index) => index);
  if (model.skeleton !== undefined) {
    const skeleton = model.skeleton;
    const nodeIndexByName = new Map<string, number>();
    for (const bone of skeleton.bones) {
      const index = nodes.length;
      nodes.push({ name: bone.name, translation: bone.translation });
      nodeIndexByName.set(bone.name, index);
      joints.add(index);
    }
    for (const bone of skeleton.bones) {
      const index = nodeIndexByName.get(bone.name) as number;
      if (bone.parent === null) {
        rootNodes.push(index);
        continue;
      }
      const parentIndex = nodeIndexByName.get(bone.parent);
      if (parentIndex === undefined) {
        fail(`model ${model.id} bone ${bone.name} has no parent ${bone.parent}`);
      }
      const parent = nodes[parentIndex] as Json;
      const children = (parent.children ?? []) as number[];
      children.push(index);
      parent.children = children;
    }
    if (skeleton.bones.length === 0) {
      fail(`model ${model.id} declares a skeleton with no bones`);
    }

    // One bone per joint, in the order the joints are listed, each with the inverse of its bind
    // pose world transform.
    const jointIndices = skeleton.bones.map((bone) => nodeIndexByName.get(bone.name) as number);
    const bindMatrices: number[] = [];
    for (const bone of skeleton.bones) {
      let world: Vec3 = [0, 0, 0];
      let ancestor: BoneDefinition | undefined = bone;
      while (ancestor !== undefined) {
        world = sumVec3(world, ancestor.translation);
        ancestor = ancestor.parent === null ? undefined : skeleton.bones.find((entry) => entry.name === ancestor?.parent);
      }
      bindMatrices.push(...inverseBindMatrix(world));
    }
    const inverseBindAccessor = vectorAccessor(bindMatrices, 'MAT4');
    skins.push({ name: `${skeleton.skinnedPart}-skin`, joints: jointIndices, inverseBindMatrices: inverseBindAccessor });

    // The skinned part binds every vertex to the clip's bone, which is what a schematic tower needs
    // and what keeps the influence count at one instead of a blend the eye would not read.
    const skinned = parts.get(skeleton.skinnedPart);
    if (skinned === undefined) {
      fail(`model ${model.id} skins ${skeleton.skinnedPart}, which is not one of its parts`);
    }
    const boneSlot = jointIndices.indexOf(nodeIndexByName.get(skeleton.clip.bone) as number);
    if (boneSlot < 0) {
      fail(`model ${model.id} clip ${skeleton.clip.name} drives ${skeleton.clip.bone}, which is not a joint`);
    }
    const jointValues = new Array<number>(skinned.vertexCount * WEIGHT_SLOTS).fill(0);
    const weightValues = new Array<number>(skinned.vertexCount * WEIGHT_SLOTS).fill(0);
    for (let vertex = 0; vertex < skinned.vertexCount; vertex += 1) {
      jointValues[vertex * WEIGHT_SLOTS] = boneSlot;
      weightValues[vertex * WEIGHT_SLOTS] = 1;
    }
    boneInfluences = countInfluences(weightValues, WEIGHT_SLOTS);
    const skinnedPrimitive = asArray(
      (meshes[skinned.mesh] as Json).primitives,
      `model ${model.id} skinned primitives`,
    )[0] as Json;
    (skinnedPrimitive.attributes as Json).JOINTS_0 = jointAccessor(jointValues, skinned.vertexCount, 'JOINTS_0');
    (skinnedPrimitive.attributes as Json).WEIGHTS_0 = vectorAccessor(weightValues, 'VEC4');
    (nodes[skinned.node] as Json).skin = 0;

    const clip = skeleton.clip;
    if (clip.times.length !== clip.rotations.length || clip.times.length < 2) {
      fail(`model ${model.id} clip ${clip.name} has ${clip.times.length} keys and ${clip.rotations.length} rotations`);
    }
    for (let key = 1; key < clip.times.length; key += 1) {
      if ((clip.times[key] as number) <= (clip.times[key - 1] as number)) {
        fail(`model ${model.id} clip ${clip.name} key ${key} does not move forward in time`);
      }
    }
    animations.push({
      name: clip.name,
      channels: [
        {
          sampler: 0,
          target: { node: nodeIndexByName.get(clip.bone), path: clip.path ?? 'rotation' },
        },
      ],
      samplers: [
        {
          input: scalarAccessor(clip.times.map(round)),
          output: vectorAccessor(clip.rotations.flatMap((rotation) => rotation.map(round)), 'VEC4'),
          interpolation: 'LINEAR',
        },
      ],
    });
    clipTargets.push({ clip: clip.name, node: clip.bone, path: clip.path ?? 'rotation' });
  }

  const gltf = {
    asset: { version: '2.0', generator: 'echoes-of-burbenog/build-assets' },
    scene: 0,
    scenes: [{ name: model.id, nodes: rootNodes }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
    ...(skins.length === 0 ? {} : { skins }),
    ...(animations.length === 0 ? {} : { animations }),
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
  // The scene root becomes the group the client walks, so it is reported next to the node parts.
  const nodeTypes: NodeReading[] = [
    { type: 'Group', path: model.id },
    ...nodes.map((node, index) => ({
      type: gltfNodeType(node, index, joints),
      path: `${model.id}/${String(node.name)}`,
    })),
  ];
  return {
    bytes: glb,
    triangles,
    measurement: measureModel(model, gltf, glb.length, triangles, boneInfluences),
    nodeTypes,
    clipTargets,
  };
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

/**
 * How many vertices `POSITION` and `COLOR_0` carry in each mesh of a file, for the budget to compare.
 *
 * Read off the file rather than declared by it, because the whole point is that a manifest cannot be
 * trusted on this and neither can the accessor count in isolation: what has to be compared is one
 * primitive's `COLOR_0` against the same primitive's `POSITION`, and only a walk knows which is which.
 * A file with no colour attribute reports null, which is a different answer from zero — a model whose
 * colour lives in its material is legitimate, and a `COLOR_0` of the wrong length is not.
 */
const readVertexCounts = (bytes: Buffer): { positionVertices: number; colorVertices: number | null } => {
  const { gltf } = readGltfJson(bytes, 'colour counts');
  const accessors = asArray(gltf.accessors, 'colour counts accessors');
  let positionVertices = 0;
  let colorVertices: number | null = null;
  for (const mesh of asArray(gltf.meshes, 'colour counts meshes')) {
    for (const primitive of asArray(mesh.primitives, 'colour counts primitives')) {
      const attributes = primitive.attributes as Json | undefined;
      const position = attributes?.POSITION;
      if (position === undefined) {
        continue;
      }
      // The first primitive with positions is the one measured, and the colour read beside it rather
      // than separately: a file whose second primitive has a longer colour buffer is still a file the
      // renderer will draw wrong, and `verifyGlb` walks every primitive to catch exactly that.
      const colors = attributes?.COLOR_0;
      positionVertices = asNumber((accessors[asNumber(position, 'POSITION')] as Json).count, 'POSITION count');
      colorVertices = colors === undefined ? null : asNumber((accessors[asNumber(colors, 'COLOR_0')] as Json).count, 'COLOR_0 count');
      return { positionVertices, colorVertices };
    }
  }
  return { positionVertices, colorVertices };
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
  // An absent `materials` list is legal here, and it is the shape an imported model arrives in: its
  // colour lives in COLOR_0 and the client raises the material it needs on the node it animates. What
  // the file must not do is declare a material and leave it half described, so the material rules
  // below apply to the materials that are there rather than to the ones that are missing.
  const materials = asArray(gltf.materials ?? [], `${label} materials`);
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
      // And the colour buffer, which is the one attribute whose length nothing else in the pipeline
      // looks at. A `COLOR_0` of any other length is a valid file that the renderer, the loader, the
      // budget and this function all accept, and it paints the mesh with the wrong vertices — so it is
      // checked here, against POSITION, at the one point where both lengths are already in hand. The
      // colour of the accepted models lives exactly this way: no material, all of it in `COLOR_0`.
      if (attributes.COLOR_0 !== undefined) {
        const colors = readAccessorValues(
          bytes,
          gltf,
          bin,
          asNumber(attributes.COLOR_0, `${where} COLOR_0`),
          where,
        );
        if (colors.count !== positions.count) {
          fail(`${where}: COLOR_0 count ${colors.count} does not match POSITION count ${positions.count}`);
        }
      }
      if (primitive.mode !== undefined && primitive.mode !== MODE_TRIANGLES) {
        fail(`${where}: mode ${String(primitive.mode)} is not TRIANGLES`);
      }
      if (primitive.material !== undefined) {
        const materialIndex = asNumber(primitive.material, `${where} material`);
        const material = materials[materialIndex];
        if (!material) {
          fail(`${where}: material ${materialIndex} does not exist`);
        }
        if (material.pbrMetallicRoughness === undefined) {
          fail(`${where}: pbrMetallicRoughness is required`);
        }
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
      // model renders as an empty shell under backface culling. A triangle with no area is not that
      // case and is not refused: it draws nothing in either winding, it has no front face to point
      // the wrong way, and an exporter that simplifies a mesh leaves a few of them behind. What is
      // still refused is a triangle that covers ground and says its normals point the other way.
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
        const faceLength = Math.hypot(faceNormal[0], faceNormal[1], faceNormal[2]);
        if (faceLength > DEGENERATE_FACE_NORMAL && faceNormal[0] * stored[0] + faceNormal[1] * stored[1] + faceNormal[2] * stored[2] <= 0) {
          fail(`${where}: triangle ${triangle / 3} winds against its vertex normals`);
        }
      }
    }
  }
  if (triangleCount !== entry.triangles) {
    fail(`${label}: ${triangleCount} triangles in the file but the manifest claims ${entry.triangles}`);
  }

  // The lit node is looked up only of a record that claims one. A terrain record may honestly carry
  // none — a rock, a stump and a skull have nothing to light — and the parser is what refuses a record
  // that promises a node it does not have, so the two halves of that rule live in one place each and
  // neither has to make an exception for the other.
  if (entry.emissiveNode === undefined) {
    verifySkeleton(bytes, gltf, bin, label);
    return;
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
  if (emissivePrimitive.material !== undefined) {
    const emissiveMaterial = materials[asNumber(emissivePrimitive.material, `${label} emissive material`)] as Json | undefined;
    const pbr = (emissiveMaterial?.pbrMetallicRoughness ?? {}) as Json;
    if (emissiveMaterial?.emissiveFactor === undefined) {
      fail(`${label}: emissive node ${entry.emissiveNode} has no emissiveFactor`);
    }
    if (pbr.baseColorFactor === undefined || pbr.metallicFactor === undefined || pbr.roughnessFactor === undefined) {
      fail(`${label}: emissive node ${entry.emissiveNode} needs baseColorFactor, metallicFactor and roughnessFactor`);
    }
  }
  for (const [index, material] of materials.entries()) {
    if (material.textures !== undefined) {
      fail(`${label}: material ${index} declares textures`);
    }
  }
  verifySkeleton(bytes, gltf, bin, label);
};

// The skeleton is verified as structure, not as a budget: the numbers go to `checkModelContract`,
// while this answers the questions only the file can answer. Is there exactly one skinned mesh, are
// the joints and the inverse bind matrices the same length, does every vertex sum its weights to
// one, and does the clip only address bones the mixer can drive.
const verifySkeleton = (bytes: Buffer, gltf: Json, bin: Chunk, label: string): void => {
  const nodes = asArray(gltf.nodes, `${label} nodes`);
  const meshes = asArray(gltf.meshes, `${label} meshes`);
  const skins = asArray(gltf.skins ?? [], `${label} skins`);
  const animations = asArray(gltf.animations ?? [], `${label} animations`);
  if (skins.length === 0 && animations.length === 0) {
    return;
  }
  if (skins.length !== 1) {
    fail(`${label}: a model carries at most one skin, found ${skins.length}`);
  }
  const skin = skins[0] as Json;
  const joints = asArray(skin.joints, `${label} skin joints`);
  if (joints.length === 0) {
    fail(`${label}: skin has no joints`);
  }
  const jointIndices = joints.map((joint) => asNumber(joint, `${label} skin joint index`));
  for (const [position, index] of jointIndices.entries()) {
    const node = nodes[index];
    if (!node) {
      fail(`${label}: skin joint ${position} points at missing node ${index}`);
    }
    if (node.mesh !== undefined) {
      fail(`${label}: joint ${String(node.name)} carries a mesh, so it would load as a Mesh and not a Bone`);
    }
  }
  // A joint the scene does not reach would be absent from the loaded tree, and the clip that drives
  // it would then animate a node that does not exist.
  const reachable = new Set<number>();
  const walk = (index: number): void => {
    if (reachable.has(index)) {
      return;
    }
    reachable.add(index);
    const node = nodes[index] as Json | undefined;
    for (const child of (node?.children ?? []) as number[]) {
      walk(child);
    }
  };
  for (const root of asArray((asArray(gltf.scenes, `${label} scenes`)[0] as Json).nodes, `${label} scene nodes`)) {
    walk(asNumber(root, `${label} scene node index`));
  }
  for (const index of jointIndices) {
    if (!reachable.has(index)) {
      fail(`${label}: joint ${String((nodes[index] as Json).name)} is not reachable from the scene`);
    }
  }

  const inverseBinds = readAccessorValues(
    bytes,
    gltf,
    bin,
    asNumber(skin.inverseBindMatrices, `${label} inverseBindMatrices`),
    `${label} inverseBindMatrices`,
  );
  if (inverseBinds.components !== 16) {
    fail(`${label}: inverseBindMatrices must be MAT4`);
  }
  if (inverseBinds.count !== jointIndices.length) {
    fail(`${label}: ${inverseBinds.count} inverse bind matrices for ${jointIndices.length} joints`);
  }

  const skinnedNodeIndexes: number[] = [];
  for (const [index, node] of nodes.entries()) {
    if (node.skin === undefined) {
      continue;
    }
    if (asNumber(node.skin, `${label} node skin index`) !== 0) {
      fail(`${label}: node ${String(node.name)} points at a skin that does not exist`);
    }
    skinnedNodeIndexes.push(index);
  }
  if (skinnedNodeIndexes.length !== 1) {
    fail(`${label}: expected exactly one skinned node, found ${skinnedNodeIndexes.length}`);
  }
  const skinnedNode = nodes[skinnedNodeIndexes[0] as number] as Json;
  const skinnedMesh = meshes[asNumber(skinnedNode.mesh, `${label} skinned node mesh`)] as Json | undefined;
  for (const [index, primitive] of asArray(skinnedMesh?.primitives, `${label} skinned primitives`).entries()) {
    const where = `${label} skinned primitive ${index}`;
    const attributes = (primitive as Json).attributes as Json | undefined;
    const jointAccessorIndex = asNumber(attributes?.JOINTS_0, `${where} JOINTS_0`);
    const weightAccessorIndex = asNumber(attributes?.WEIGHTS_0, `${where} WEIGHTS_0`);
    const jointAccessorDef = asArray(gltf.accessors, `${label} accessors`)[jointAccessorIndex] as Json;
    const weightAccessorDef = asArray(gltf.accessors, `${label} accessors`)[weightAccessorIndex] as Json;
    if (jointAccessorDef?.type !== 'VEC4' || weightAccessorDef?.type !== 'VEC4') {
      fail(`${where}: JOINTS_0 and WEIGHTS_0 must both be VEC4`);
    }
    const joints_ = readAccessorValues(bytes, gltf, bin, jointAccessorIndex, `${where} JOINTS_0`);
    const weights = readAccessorValues(bytes, gltf, bin, weightAccessorIndex, `${where} WEIGHTS_0`);
    if (joints_.count !== weights.count) {
      fail(`${where}: ${joints_.count} joint slots for ${weights.count} weights`);
    }
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      let total = 0;
      for (let slot = 0; slot < WEIGHT_SLOTS; slot += 1) {
        const joint = joints_.values[vertex * WEIGHT_SLOTS + slot] as number;
        const weight = weights.values[vertex * WEIGHT_SLOTS + slot] as number;
        if (joint >= jointIndices.length) {
          fail(`${where}: vertex ${vertex} is bound to joint ${joint} of ${jointIndices.length}`);
        }
        if (weight < 0 || weight > 1) {
          fail(`${where}: vertex ${vertex} has weight ${weight}, which is outside [0, 1]`);
        }
        total += weight;
      }
      // The generator rounds to five decimals, so a sum of one is only exact within that tolerance.
      if (Math.abs(total - 1) > 10 * (1 / PRECISION)) {
        fail(`${where}: vertex ${vertex} weights sum to ${round(total)}, not to 1`);
      }
    }
  }

  const targets: ClipTargetReading[] = [];
  for (const [index, animation] of animations.entries()) {
    const name = asString(animation.name, `${label} animation ${index} name`);
    const channels = asArray(animation.channels, `${label} animation ${index} channels`);
    const samplers = asArray(animation.samplers, `${label} animation ${index} samplers`);
    if (channels.length === 0) {
      fail(`${label}: animation ${name} has no channels`);
    }
    for (const channel of channels) {
      const target = channel.target as Json | undefined;
      const path = asString(target?.path, `${label} animation ${name} channel path`);
      const nodeIndex = asNumber(target?.node, `${label} animation ${name} channel node`);
      const node = nodes[nodeIndex] as Json | undefined;
      if (!node) {
        fail(`${label}: animation ${name} drives missing node ${nodeIndex}`);
      }
      if (!jointIndices.includes(nodeIndex)) {
        fail(`${label}: animation ${name} drives ${String(node.name)}, which is not a joint`);
      }
      targets.push({ clip: name, node: String(node.name), path });
      const sampler = samplers[asNumber(channel.sampler, `${label} animation ${name} sampler`)];
      if (!sampler) {
        fail(`${label}: animation ${name} uses sampler ${String(channel.sampler)}, which does not exist`);
      }
      if ((sampler.interpolation ?? 'LINEAR') !== 'LINEAR') {
        fail(`${label}: animation ${name} uses ${String(sampler.interpolation)} interpolation, only LINEAR is in the contract`);
      }
      const times = readAccessorValues(bytes, gltf, bin, asNumber(sampler.input, `${label} animation ${name} input`), `${label} animation ${name} input`);
      const values = readAccessorValues(bytes, gltf, bin, asNumber(sampler.output, `${label} animation ${name} output`), `${label} animation ${name} output`);
      if (times.count < 2) {
        fail(`${label}: animation ${name} needs at least two keys`);
      }
      if (times.count !== values.count) {
        fail(`${label}: animation ${name} has ${times.count} keys and ${values.count} values`);
      }
      const first = times.values[0] as number;
      const last = times.values[times.count - 1] as number;
      if (round(last - first) > MODEL_BUDGET.clipSeconds) {
        fail(`${label}: animation ${name} is ${round(last - first)}s long, budget allows ${MODEL_BUDGET.clipSeconds}s`);
      }
    }
  }
  // The same list the client refuses by, so a clip the build would accept and the browser cannot
  // play cannot be both true.
  const refused = checkClipTargets(label, targets);
  if (refused.length > 0) {
    fail(`budget check refused: ${describeFailures(refused)}`);
  }
};

const expectFailure = (action: () => void, pattern: RegExp, label: string): void => {
  let message: string | null = null;
  try {
    action();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === null) {
    fail(`self-test: ${label} was accepted, so the check proves nothing`);
  }
  if (!pattern.test(message)) {
    fail(`self-test: ${label} failed with an unexpected message: ${message}`);
  }
  console.log(`  red check ok: ${label} -> ${message}`);
};

const expectRejection = (bytes: Buffer, entry: ManifestEntry, pattern: RegExp, label: string): void =>
  expectFailure(() => verifyGlb(bytes, entry), pattern, label);

/**
 * A real accepted file with its `COLOR_0` made three times as long as its `POSITION`.
 *
 * This is the red run the colour check exists for, and it is built out of a file the project actually
 * ships rather than out of a probe object, because the defect is precisely that a valid file gets
 * through: the container, the bufferViews, the accessors, the triangles and the manifest all agree with
 * each other on the way in. So the surgery has to be honest about all of them — the colour data is
 * repeated in the buffer, the view grows by the same amount, the accessor's count triples and the
 * manifest's `bytes` and `contentHash` are recomputed to match, which is what the build itself would
 * write. Only one thing is wrong with the result, and it has to be the one thing the check names.
 *
 * A file whose `COLOR_0` merely *claimed* to be longer would prove nothing: the structural checks
 * would refuse it first, on the accessor not fitting its view, and the colour check would never run.
 */
const stretchColorBuffer = (bytes: Buffer, times: number): Buffer => {
  const chunks = readChunks(bytes, 'colour probe');
  const json = chunks.get(CHUNK_JSON);
  const bin = chunks.get(CHUNK_BIN);
  if (!json || !bin) {
    fail('colour probe: file has no JSON or BIN chunk');
  }
  const gltf = JSON.parse(bytes.subarray(json.start, json.start + json.length).toString('utf8')) as Json;
  const accessors = asArray(gltf.accessors, 'colour probe accessors');
  const views = asArray(gltf.bufferViews, 'colour probe bufferViews');
  const mesh = asArray(gltf.meshes, 'colour probe meshes')[0];
  const primitive = asArray(mesh?.primitives ?? [], 'colour probe primitives')[0];
  const attributes = primitive?.attributes as Json | undefined;
  const colorIndex = attributes?.COLOR_0;
  if (colorIndex === undefined) {
    fail('colour probe: the file carries no COLOR_0 to stretch');
  }
  const accessor = accessors[asNumber(colorIndex, 'colour probe COLOR_0')] as Json;
  const view = views[asNumber(accessor.bufferView, 'colour probe bufferView')] as Json;
  const viewOffset = asNumber(view.byteOffset ?? 0, 'colour probe view offset');
  const viewLength = asNumber(view.byteLength, 'colour probe view length');
  const original = Buffer.from(bytes.subarray(bin.start + viewOffset, bin.start + viewOffset + viewLength));
  const grown = Buffer.concat(Array.from({ length: times }, () => original));
  // The extra data goes at the end of the buffer so no existing view has to move, and the old view's
  // length is left alone: a second view is opened on the tail, which is how a real exporter would have
  // written it and which leaves every other accessor in the file exactly where it was.
  const tailOffset = bin.length;
  const grownView = { buffer: 0, byteOffset: tailOffset, byteLength: grown.length, target: TARGET_ARRAY_BUFFER };
  const grownAccessor = {
    ...accessor,
    bufferView: views.length,
    count: asNumber(accessor.count, 'colour probe accessor count') * times,
  };
  gltf.bufferViews = [...views, grownView];
  gltf.accessors = [...accessors, grownAccessor];
  (mesh.primitives as Json[])[0] = {
    ...(primitive as Json),
    attributes: { ...attributes, COLOR_0: accessors.length },
  };
  const binChunk = Buffer.concat([bytes.subarray(bin.start, bin.start + bin.length), grown]);
  const paddedBin = binChunk.length % 4 === 0 ? binChunk : Buffer.concat([binChunk, Buffer.alloc(4 - (binChunk.length % 4))]);
  const buffers = asArray(gltf.buffers, 'colour probe buffers');
  buffers[0] = { ...buffers[0], byteLength: paddedBin.length };
  const jsonChunk = Buffer.from(JSON.stringify(gltf), 'utf8');
  const paddedJson = jsonChunk.length % 4 === 0 ? jsonChunk : Buffer.concat([jsonChunk, Buffer.alloc(4 - (jsonChunk.length % 4), 0x20)]);
  const total = 12 + 8 + paddedJson.length + 8 + paddedBin.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(GLB_VERSION, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(paddedJson.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  paddedJson.copy(out, 20);
  let cursor = 20 + paddedJson.length;
  out.writeUInt32LE(paddedBin.length, cursor);
  out.writeUInt32LE(CHUNK_BIN, cursor + 4);
  paddedBin.copy(out, cursor + 8);
  return out;
};

// The gate every write goes through. Nothing reaches the disk before it: a refused model must
// leave no artifact and no manifest entry behind, or a broken model would ship next to a
// healthy one and the registry would stop being a description of what is actually there.
const gateModel = (
  measurement: ModelMeasurement,
  nodeTypes: readonly NodeReading[],
  clipTargets: readonly ClipTargetReading[],
  totals: readonly RegistryModelReading[],
): void => {
  const failures = [
    ...checkModelContract(measurement),
    ...checkNodeTypes(measurement.id, nodeTypes),
    ...checkClipTargets(measurement.id, clipTargets),
    ...checkRegistryBudgets(totals),
  ];
  if (failures.length > 0) {
    fail(`budget check refused: ${describeFailures(failures)}`);
  }
};

const runSelfTest = (
  model: ModelDefinition,
  entry: ManifestEntry,
  build: ModelBuild,
  totals: readonly RegistryModelReading[],
): void => {
  const bytes = build.bytes;
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

  // The budget gate has to refuse an over-budget model through the very function a real write
  // goes through, otherwise a gate that was never wired in would still look tested. The probe is
  // a real model with one part per material the budget allows plus one, so the refusal has to
  // come from the measured geometry and not from a hand-made measurement.
  const materialLimit = MODEL_BUDGET.materials;
  expectFailure(
    () => assemble([overBudgetModel(materialLimit + 1)]),
    new RegExp(`materials is ${materialLimit + 1}, budget allows ${materialLimit}`),
    'model over the material budget, refused before any write',
  );

  // The registry total and the node type are separate gates, so they are probed through the gate
  // itself. The probe values are derived from the budget, so these checks follow the limit
  // instead of freezing a copy of it.
  const triangleLimit = MODEL_BUDGET.triangles;
  expectFailure(
    () => gateModel({ ...build.measurement, triangles: triangleLimit + 1 }, build.nodeTypes, build.clipTargets, totals),
    new RegExp(`triangles is ${triangleLimit + 1}, budget allows ${triangleLimit}`),
    'model over the triangle budget',
  );
  const registryLimit = REGISTRY_BUDGET.bytes;
  const probeBytes = registryLimit + 1;
  const probeTotal = totals.reduce((total, model) => total + model.bytes, 0) + probeBytes;
  expectFailure(
    () =>
      gateModel(build.measurement, build.nodeTypes, build.clipTargets, [
        ...totals,
        { id: 'registry-probe', bytes: probeBytes, triangles: 0 },
      ]),
    new RegExp(`registry-probe: registry bytes is ${probeTotal}, budget allows ${registryLimit}`),
    'registry over the byte budget',
  );
  // A skeleton is now part of the contract, so the node type that is refused has to be one the
  // client still has nothing to clone with. A rig inside the budget is accepted: the model under
  // test carries one, and this gate is what accepted it.
  expectFailure(
    () =>
      gateModel(
        build.measurement,
        [
          { type: 'SkinnedMesh', path: 'pulse-spire/crystal' },
          { type: 'Bone', path: 'pulse-spire/crystal-sway' },
          { type: 'Points', path: 'pulse-spire/aura' },
        ],
        build.clipTargets,
        totals,
      ),
    /node pulse-spire\/aura is a Points; only Mesh, Group, SkinnedMesh and Bone can be instantiated/,
    'node type the client cannot instantiate',
  );

  // Two skeleton gates, both reached through the write path. The rig that is one bone over the
  // budget is refused by `checkModelContract`, and the clip the client cannot play is refused by
  // `verifySkeleton` before the file could ever reach the budget table.
  const probes = skeletonProbes();
  const overBudget = probes.overBoneBudget;
  const boneLimit = MODEL_BUDGET.bones;
  const probeBoneCount = (overBudget.skeleton as SkeletonDefinition).bones.length;
  expectFailure(
    () => assemble([overBudget]),
    new RegExp(`bones is ${probeBoneCount}, budget allows ${boneLimit}`),
    'skeleton over the bone budget, refused before any write',
  );
  expectFailure(
    () => assemble([probes.unplayableClip]),
    /clip pulse animates crystal-sway \.weights; the client plays only translation, rotation and scale/,
    'clip the client cannot reproduce',
  );
};

// The manifest contract, probed through the parser the browser loads the file with. Every rule gets
// a red run, including the ones this generator never trips on its own, because a rule with no probe
// is a rule that survives a later edit until an exporter finds it. Each probe asserts the message and
// not only the refusal: a reason that does not name the value it found is the defect this contract
// was grown to end, and it has to be caught here rather than in an exporter's report.
//
// The terrain records are hand-built, since nothing in this pipeline produces them yet. One is well
// formed and has to pass, or a set of probes that only refuse things would say nothing about the
// case the contract exists for.
const runContractRedChecks = (published: readonly ManifestEntry[]): void => {
  const lit = published.find((entry) => entry.id === 'pulse-spire') ?? published[0];
  const terrain = { id: 'land.forest.01', file: 'land.forest.01.glb', bytes: 4096, contentHash: 'sha256:probe', triangles: 1200 };
  const valid = { slot: 7, kind: 'rock', footprint: 2, solid: true };
  const withBlock = (land: unknown, extra: Json = {}): unknown => ({ version: 1, models: [{ ...terrain, land, ...extra }] });
  const withoutBlock = (extra: Json = {}): unknown => ({ version: 1, models: [{ ...terrain, ...extra }] });
  const withTower = (extra: Json): unknown => ({ version: 1, models: [{ ...lit, ...extra }] });
  // A file that omits the field omits the key, and a key holding `undefined` is a different file:
  // the probe has to be the one an exporter would actually send.
  const dropEmissiveNode = (entry: ManifestEntry): Json => {
    const copy = { ...entry } as Json;
    delete copy.emissiveNode;
    return copy;
  };

  const accepted = parseAssetManifest(withBlock(valid));
  assert.equal(accepted.models.length, 1, 'a well-formed terrain record must be accepted');
  const record = accepted.models[0];
  assert(isTerrainRecord(record), 'a land.* record has to come back as a terrain record');
  assert.deepEqual(record.land, valid, 'the land block has to survive the parse unchanged');
  assert.equal(instancedEntries(accepted).length, 0, 'the client must not fetch a terrain record it cannot place');
  const litProp = parseAssetManifest(withBlock(valid, { emissiveNode: 'core' }));
  assert.equal(litProp.models.length, 1, 'a terrain prop that has a lit node may name it');
  assert.equal(isTerrainRecord(litProp.models[0]), true, 'naming a lit node must not turn a terrain record into a tower');
  assert.equal(instancedEntries(parseAssetManifest(withTower({}))).length, 1, 'a tower record is still the client\'s to load');

  expectFailure(
    () => parseAssetManifest(withoutBlock()),
    /model registry entry 0 land\.forest\.01 is a terrain model and must carry a land block, found none/,
    'terrain record without its land block',
  );
  expectFailure(
    () => parseAssetManifest(withTower({ land: { slot: 7, kind: 'rock', footprint: 1, solid: true } })),
    /model registry entry 0 pulse-spire must not carry a land block, and it claims slot 7 kind rock/,
    'land block on a record the client lights',
  );
  expectFailure(
    () => parseAssetManifest(withBlock({ ...valid, kind: 'mushroom' })),
    /models\[0\]\.land\.kind "mushroom" is not one of tree, bush, rock, debris, ruin, bone/,
    'terrain kind outside the list',
  );
  for (const slot of [0, 41, 2.5, '7']) {
    expectFailure(
      () => parseAssetManifest(withBlock({ ...valid, slot })),
      new RegExp(`models\\[0\\]\\.land\\.slot .* must be a whole number in 1\\.\\.${TERRAIN_SLOT_COUNT}`),
      `terrain slot ${String(slot)} outside 1..${TERRAIN_SLOT_COUNT}`,
    );
  }
  expectFailure(
    () => parseAssetManifest(withBlock({ ...valid, footprint: 3 })),
    /models\[0\]\.land\.footprint 3 is neither 1 nor 2/,
    'terrain footprint of 3',
  );
  expectFailure(
    () => parseAssetManifest(withBlock({ ...valid, kind: 'bush', solid: true })),
    /models\[0\]\.land\.solid true is not a bush: it is low/,
    'a bush that claims to be solid',
  );
  expectFailure(
    () => parseAssetManifest(withBlock({ ...valid, solid: false })),
    /models\[0\]\.land\.solid false is not a rock: it stops both/,
    'a rock that claims not to be solid',
  );
  expectFailure(
    () => parseAssetManifest(withBlock({ ...valid, solid: 'yes' })),
    /models\[0\]\.land\.solid "yes" must be true or false/,
    'solid that arrived as text',
  );
  expectFailure(
    () => parseAssetManifest(withBlock(7)),
    /models\[0\]\.land must be an object with slot, kind, footprint and solid, found 7/,
    'land block that is not an object',
  );

  // The colour check, driven from a file this project actually ships. The probe is a real prop with a
  // real colour buffer tripled: the container, the views, the accessors, the triangle count and the
  // manifest are all made to agree with the stretched file, so the only thing wrong with it is the one
  // thing the check is for.
  const stretched = stretchColorBuffer(readFileSync(join(LAND_DIR, 'land-forest-37.glb')), 3);
  const stretchedEntry: ManifestEntry = {
    id: 'land.forest.37',
    file: 'land-forest-37.glb',
    bytes: stretched.length,
    contentHash: sha256(stretched),
    triangles: 158,
    land: { slot: 37, kind: 'bone', footprint: 1, solid: false },
  };
  // And the same file untouched has to pass, or the probe proves only that something refuses everything.
  verifyGlb(readFileSync(join(LAND_DIR, 'land-forest-37.glb')), {
    ...stretchedEntry,
    bytes: 21052,
    contentHash: 'sha256:4d863c3e72d539da27193e0965baf8a1800577796d09a3c336b4c074a5084a06',
  });
  const measured = readVertexCounts(stretched);
  expectRejection(
    stretched,
    stretchedEntry,
    /COLOR_0 count \d+ does not match POSITION count \d+/,
    'a colour buffer three times the length of the positions',
  );
  // The same file through the client-side check, which is the one the browser runs. Two gates and two
  // red runs, because they are two gates: the build refuses the file before it is ever served, and the
  // client refuses it again if something serves it anyway.
  expectFailure(
    () => {
      const failures = checkModelContract({ ...stretchedEntry, ...measured }, TERRAIN_MODEL_BUDGET);
      if (failures.length === 0) {
        fail(`a COLOR_0 of ${String(measured.colorVertices)} vertices beside ${measured.positionVertices} positions was accepted, so this check proves nothing`);
      }
      throw new Error(describeFailures(failures));
    },
    /COLOR_0 carries 1422 vertices but POSITION carries 474/,
    'the client-side colour check refusing the same file',
  );
  expectFailure(
    () => parseAssetManifest(withBlock(valid, { triangles: TERRAIN_TRIANGLE_LIMIT + 1 })),
    new RegExp(`claims ${TERRAIN_TRIANGLE_LIMIT + 1} triangles, a terrain model allows ${TERRAIN_TRIANGLE_LIMIT}`),
    'terrain record over the triangle cap',
  );
  expectFailure(
    () => parseAssetManifest({ version: 1, models: [dropEmissiveNode(lit)] }),
    /model registry entry 0 pulse-spire must name an emissiveNode, found none: only terrain models may go without one/,
    'tower record without a lit node',
  );
};

// The published manifest is read back through the client's own parser, not through a second reader of
// our own. That reader existed because the generator had no other one; it was a duplicate contract, and
// the duplicate is exactly what refused the first terrain record over the one field a terrain record is
// allowed not to carry. One contract means the file this build writes is checked by the same code the
// browser will parse it with, and a disagreement between the two cannot survive a build.
const parseManifest = (raw: string): { version: number; models: ManifestEntry[] } => {
  let parsed: AssetManifest;
  try {
    parsed = parseAssetManifest(JSON.parse(raw));
  } catch (error) {
    return fail(`published manifest: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { version: parsed.version, models: parsed.models as ManifestEntry[] };
};

// Everything that has to be true before a byte reaches the disk, in one place: build, verify and
// gate every model, and only then let the caller write. The self-test drives this same function,
// so a gate that is not wired in here cannot stay invisible.
const assemble = (models: readonly ModelDefinition[]): { entries: ManifestEntry[]; built: Map<string, ModelBuild> } => {
  const entries: ManifestEntry[] = [];
  const built = new Map<string, ModelBuild>();
  const totals: RegistryModelReading[] = [];
  for (const model of models) {
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
    totals.push(entry);
    gateModel(result.measurement, result.nodeTypes, result.clipTargets, totals);
    built.set(model.id, result);
    entries.push(entry);
  }
  return { entries, built };
};

// The second source of `public/models`, read through the client's own registry contract rather than
// the generator's own parser. The exporter is another project, but the manifest it wrote is the same
// file the browser parses, so it is held to that parser and to the same structural check and byte
// count every generated artifact passes. A hand-pasted copy that skipped either of those would
// otherwise reach the game as a file nobody had looked at.
const readAccepted = (): ManifestEntry[] => {
  let parsed: AssetManifest;
  try {
    parsed = parseAssetManifest(JSON.parse(readFileSync(ACCEPTED_MANIFEST_PATH, 'utf8')));
  } catch (error) {
    return fail(`accepted export: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries: ManifestEntry[] = [];
  for (const entry of parsed.models) {
    // The registry contract takes a terrain record and this generator does not publish one yet.
    // `verifyGlb` looks a lit node up by name, so it would refuse the file over the one node the
    // contract lets a terrain record omit — a reason nobody could act on. Refused here by name
    // instead, and the refusal goes away with the task that puts terrain on the map.
    if (isTerrainRecord(entry)) {
      fail(`accepted export: ${entry.id} is a terrain record, and this generator publishes towers and creatures only`);
    }
    const bytes = readFileSync(join(ACCEPTED_DIR, entry.file));
    verifyGlb(bytes, entry);
    // Only the counts are gated here. The geometry bounds stay the client's job, because the generator
    // measures its own arrays and a file it did not write has to be measured where it is loaded.
    const failures = checkModelContract({ id: entry.id, bytes: entry.bytes, triangles: entry.triangles });
    if (failures.length > 0) {
      fail(`accepted export: budget check refused: ${describeFailures(failures)}`);
    }
    entries.push({ ...(entry as ModelManifestEntry) });
  }
  return entries;
};

// The forty terrain records, read through the same client parser and verified against the same file
// rules. `verifyGlb` is shared on purpose — the terrain files carry no material and no lit node, and the
// two things that made them unpublishable a moment ago (a missing `emissiveNode`, which `verifyGlb`
// looks up by name) have to be optional in it rather than worked around in a second verifier. So the
// check asks for a lit node only of a record that claims one, and a terrain record passes without it.
const readTerrain = (): TerrainModelEntry[] => {
  let parsed: AssetManifest;
  try {
    parsed = parseAssetManifest(JSON.parse(readFileSync(LAND_MANIFEST_PATH, 'utf8')));
  } catch (error) {
    return fail(`terrain export: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entries: TerrainModelEntry[] = [];
  for (const entry of parsed.models) {
    // The other half of the rule the prefix enforces: a record this directory publishes has to be a
    // terrain record. A tower here would be a file the plate never places and a slot nothing fills,
    // and the towers and creatures have a directory of their own to come from.
    if (!isTerrainRecord(entry)) {
      fail(`terrain export: ${entry.id} is not a terrain record, and only ids starting with land. belong to the plate`);
    }
    const bytes = readFileSync(join(LAND_DIR, entry.file));
    verifyGlb(bytes, entry);
    const failures = checkModelContract(
      { id: entry.id, bytes: entry.bytes, triangles: entry.triangles, ...readVertexCounts(bytes) },
      TERRAIN_MODEL_BUDGET,
    );
    if (failures.length > 0) {
      fail(`terrain export: budget check refused: ${describeFailures(failures)}`);
    }
    entries.push(entry);
  }
  const slots = new Set(entries.map((entry) => entry.land.slot));
  if (entries.length !== TERRAIN_SLOT_COUNT || slots.size !== TERRAIN_SLOT_COUNT) {
    return fail(
      `terrain export: ${entries.length} records covering ${slots.size} slots · the plate expects ${TERRAIN_SLOT_COUNT}`,
    );
  }
  return entries;
};

const build = (): { entries: ManifestEntry[]; own: ManifestEntry[]; terrain: TerrainModelEntry[]; built: Map<string, ModelBuild> } => {
  const { entries: own, built } = assemble(MODELS);
  const accepted = readAccepted();
  const terrain = readTerrain();
  // One id, one file. The generator and the accepted export both claim `pulse-spire`, and a registry
  // that listed both would leave the client to choose, so the accepted artifact takes the id: the
  // models the game shows are the ones that were exported for it. The generated one is still built,
  // hashed and self-tested, because it is the only model here that carries a skeleton, and the
  // determinism and clip checks hang on it. A terrain id can collide with neither — the plate owns the
  // whole `land.` namespace — so all forty go in as they are.
  const claimed = new Set(accepted.map((entry) => entry.id));
  const entries = [...own.filter((entry) => !claimed.has(entry.id)), ...accepted, ...terrain];
  const registryFailures = checkRegistryBudgets(entries);
  if (registryFailures.length > 0) {
    fail(`registry budget refused: ${describeFailures(registryFailures)}`);
  }
  for (const entry of own) {
    if (claimed.has(entry.id)) {
      continue;
    }
    writeFileSync(join(OUTPUT_DIR, entry.file), (built.get(entry.id) as ModelBuild).bytes);
  }
  for (const entry of accepted) {
    writeFileSync(join(OUTPUT_DIR, entry.file), readFileSync(join(ACCEPTED_DIR, entry.file)));
  }
  // Copied, not linked and not generated: the plate has to show the file the producer accepted, and
  // the copy is what the client's content hash is compared against.
  for (const entry of terrain) {
    writeFileSync(join(OUTPUT_DIR, entry.file), readFileSync(join(LAND_DIR, entry.file)));
  }
  // Last, because it is the description of what the three sources above put on disk.
  writeFileSync(MANIFEST_PATH, `${JSON.stringify({ version: 1, models: entries }, null, 2)}\n`);
  return { entries, own, terrain, built };
};

const check = (): ManifestEntry[] => {
  const { models } = parseManifest(readFileSync(MANIFEST_PATH, 'utf8'));
  for (const entry of models) {
    verifyGlb(readFileSync(join(OUTPUT_DIR, entry.file)), entry);
  }
  return models;
};

// The rig in one line, so the shape of a model can be read off a build run instead of off the file.
// Everything in it comes from the definition that was just written, not from a separate count.
const describeSkeleton = (model: ModelDefinition): string => {
  if (model.skeleton === undefined) {
    return 'skeleton none';
  }
  const skeleton = model.skeleton;
  const roots = skeleton.bones.filter((bone) => bone.parent === null).map((bone) => bone.name);
  const skinned = model.parts.find((part) => part.name === skeleton.skinnedPart);
  const vertices = (skinned?.geometry.positions.length ?? 0) / 3;
  const lastKey = skeleton.clip.times[skeleton.clip.times.length - 1] ?? 0;
  return (
    `skeleton ${skeleton.bones.length} bones (root ${roots.join(', ')} > ${skeleton.bones.length - roots.length} below), ` +
    `${vertices} vertices of ${skeleton.skinnedPart} bound to ${skeleton.clip.bone} at 1 influence, ` +
    `clip ${skeleton.clip.name} ${skeleton.clip.path ?? 'rotation'} ${lastKey}s in ${skeleton.clip.times.length} keys`
  );
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
  const { entries, own, built } = build();
  check();
  const published = new Set(entries.map((entry) => entry.contentHash));
  for (const entry of own) {
    const note = published.has(entry.contentHash) ? '' : ' · not published, the accepted export claims this id';
    console.log(`generated ${entry.id}: ${entry.bytes} bytes, ${entry.triangles} triangles, ${entry.contentHash}${note}`);
  }
  if (mode === '--test') {
    // The self-test runs against the generated model and its own entry, not against the published
    // list: an accepted artifact that took the id would otherwise be verified with bytes it never
    // had, and the eleven red checks would stop meaning what they mean.
    runSelfTest(MODELS[0], own[0], built.get(own[0].id) as ModelBuild, entries);
    runContractRedChecks(entries);
  }
  for (const entry of entries) {
    console.log(`published ${entry.id}: ${entry.file} ${entry.bytes} bytes, ${entry.triangles} triangles, ${entry.contentHash}`);
  }
  for (const model of MODELS) {
    console.log(`${model.id}: ${describeSkeleton(model)}`);
  }
  const reading = sumRegistry(entries);
  console.log(
    `registry: ${reading.models} model(s), ${reading.bytes} bytes, ${reading.triangles} triangles · ` +
      `budget ${REGISTRY_BUDGET.models} / ${REGISTRY_BUDGET.bytes} / ${REGISTRY_BUDGET.triangles}`,
  );
  console.log(`assets: ok (${mode})`);
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
