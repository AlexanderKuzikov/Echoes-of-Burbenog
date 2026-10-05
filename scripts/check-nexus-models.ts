// The check for the accepted export: the ten GLB that arrived from `NexusDefense`, the manifest that
// describes them, and the world gate that has to hold them inside a niche.
//
// Two readers on purpose, and neither is trusted over the other. The pipeline knows how to read a GLB
// — `build-assets.ts` verifies every artifact it writes with its own structural walk — and this
// script brings its own, because a check that borrows the code under it only proves that the code
// agrees with itself. The registry contract is not duplicated: the manifest is parsed by the client's
// own parser, because that is the parser the file meets in the browser, and a second parser would be a
// second contract.
//
// The run is green when every model matches its manifest entry, every node type is one the client can
// instantiate, and the world footprint gate accepts the file in the seat the client will put it in.
// The red runs are the other half: a `hoverY` that arrived as text, and a GLB repacked on the spot
// with doubled geometry, which has to be refused with the numbers in the message.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REGISTRY_BUDGET,
  SUPPORTED_NODE_TYPES,
  WORLD_FOOTPRINT_BUDGET,
  checkModelContract,
  checkRegistryBudgets,
  checkWorldFootprint,
  describeFailures,
  sumRegistry,
} from '../src/asset-budgets.ts';
import { isTerrainRecord, parseAssetManifest } from '../src/asset-registry.ts';
import type { AssetManifest, ModelManifestEntry } from '../src/asset-registry.ts';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCE_DIR = join(PROJECT_ROOT, 'assets', 'accepted');
const PUBLISHED_DIR = join(PROJECT_ROOT, 'public', 'models');
const WORK_DIR = join(PUBLISHED_DIR, '.nexus-check');

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;
// The length of a face normal below which a triangle covers no ground: the cross product of two edges
// lying on top of each other. Models here are a few world units tall, so nothing under this is a face.
const DEGENERATE_FACE_NORMAL = 1e-9;

type Json = Record<string, unknown>;
type Vec3 = [number, number, number];

// Annotated rather than inferred, so the compiler treats a call to it as ending the path: a refusal
// has to narrow the value it refused, or every use after it has to carry a cast.
const fail: (message: string) => never = (message) => {
  console.error(`nexus models: ${message}`);
  process.exit(1);
};

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const round5 = (value: number): number => Number(value.toFixed(5));

const asArray = (value: unknown, where: string): Json[] => {
  if (!Array.isArray(value)) {
    return fail(`${where} is not an array`);
  }
  return value as Json[];
};

// A GLB reader written for this script alone. Every accessor is resolved through its own buffer view and
// its own offset, and a view that runs past the chunk is a refusal rather than a silent zero, because a
// reader that guesses produces a radius that looks measured and is not.
type Glb = { json: Json; bin: Buffer; binStart: number };

const readGlb = (bytes: Buffer, label: string): Glb => {
  if (bytes.length < 12) {
    fail(`${label}: shorter than a GLB header`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) {
    fail(`${label}: bad magic`);
  }
  let json: Json | null = null;
  let bin: Buffer | null = null;
  let binStart = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    if (offset + 8 + length > bytes.length) {
      fail(`${label}: the chunk at ${offset} runs past the end of the file`);
    }
    if (type === CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(bytes.subarray(offset + 8, offset + 8 + length))) as Json;
    }
    if (type === CHUNK_BIN) {
      bin = bytes.subarray(offset + 8, offset + 8 + length);
      binStart = offset + 8;
    }
    offset += 8 + length + (length % 4 === 0 ? 0 : 4 - (length % 4));
  }
  if (json === null || bin === null) {
    fail(`${label}: a GLB needs a JSON chunk and a BIN chunk`);
  }
  return { json, bin, binStart };
};

const readComponent = (bin: Buffer, at: number, componentType: number): number => {
  switch (componentType) {
    case 5120:
      return bin.readInt8(at);
    case 5121:
      return bin.readUInt8(at);
    case 5122:
      return bin.readInt16LE(at);
    case 5123:
      return bin.readUInt16LE(at);
    case 5125:
      return bin.readUInt32LE(at);
    default:
      return bin.readFloatLE(at);
  }
};

// `where` is the human path of the value being read, because the refusal has to name which accessor of
// which mesh ran out of the file.
const readFloats = (gltf: Glb, accessorIndex: unknown, where: string): number[] => {
  const accessor = asArray(gltf.json.accessors, `${where} accessors`)[accessorIndex as number];
  if (!accessor) {
    fail(`${where} points at a missing accessor`);
  }
  const componentType = accessor.componentType as number;
  const size = COMPONENT_BYTES[componentType];
  const components = COMPONENTS[accessor.type as string];
  if (size === undefined || components === undefined) {
    fail(`${where} uses an accessor shape this reader does not know`);
  }
  const view = asArray(gltf.json.bufferViews, `${where} bufferViews`)[accessor.bufferView as number];
  if (!view) {
    fail(`${where} points at a missing buffer view`);
  }
  const start = ((view.byteOffset as number) ?? 0) + ((accessor.byteOffset as number) ?? 0);
  const count = (accessor.count as number) * components;
  if (start + count * size > gltf.bin.length) {
    fail(`${where} runs past the end of the BIN chunk`);
  }
  const out = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    out[i] = readComponent(gltf.bin, start + i * size, componentType);
  }
  return out;
};

const identity = (): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

const multiply = (a: readonly number[], b: readonly number[]): number[] => {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) {
        sum += (a[k * 4 + row] as number) * (b[column * 4 + k] as number);
      }
      out[column * 4 + row] = sum;
    }
  }
  return out;
};

// A node's own transform, from the matrix if it declared one and from translation, rotation and scale
// otherwise, which is the form every exporter in this pipeline writes.
const nodeMatrix = (node: Json): number[] => {
  if (Array.isArray(node.matrix)) {
    return node.matrix as number[];
  }
  const [x, y, z] = [
    (node.translation as number[])?.[0] ?? 0,
    (node.translation as number[])?.[1] ?? 0,
    (node.translation as number[])?.[2] ?? 0,
  ];
  const [qx, qy, qz, qw] = [
    (node.rotation as number[])?.[0] ?? 0,
    (node.rotation as number[])?.[1] ?? 0,
    (node.rotation as number[])?.[2] ?? 0,
    (node.rotation as number[])?.[3] ?? 1,
  ];
  const [sx, sy, sz] = [
    (node.scale as number[])?.[0] ?? 1,
    (node.scale as number[])?.[1] ?? 1,
    (node.scale as number[])?.[2] ?? 1,
  ];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return [
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    x, y, z, 1,
  ];
};

type ModelReading = {
  id: string;
  bytes: number;
  triangles: number;
  nodeTypes: string[];
  nodeNames: string[];
  fileRadius: number;
  minY: number;
  height: number;
  emissiveTriangles: number;
  skins: number;
  animationClips: number;
  materials: number;
  textures: number;
  // The count of what is not a defect and is worth naming: a triangle with no area draws nothing in
  // either winding, and an exporter that simplifies a mesh leaves a few of them behind.
  degenerateTriangles: number;
};

const measure = (entry: ModelManifestEntry, bytes: Buffer): ModelReading => {
  const label = entry.file;
  const gltf = readGlb(bytes, label);
  const nodes = asArray(gltf.json.nodes, `${label} nodes`);
  const meshes = asArray(gltf.json.meshes, `${label} meshes`);
  const skins = asArray(gltf.json.skins ?? [], `${label} skins`);
  const joints = new Set(skins.flatMap((skin) => (skin.joints as number[] | undefined) ?? []));
  const world = new Map<number, number[]>();
  const visit = (index: number, parent: number[]): void => {
    const node = nodes[index];
    if (!node) {
      fail(`${label}: the scene names a node ${index} that does not exist`);
    }
    const matrix = multiply(parent, nodeMatrix(node));
    world.set(index, matrix);
    for (const child of (node.children as number[] | undefined) ?? []) {
      visit(child, matrix);
    }
  };
  const scenes = asArray(gltf.json.scenes, `${label} scenes`);
  const roots = (scenes[0]?.nodes as number[] | undefined) ?? nodes.map((_, index) => index);
  for (const root of roots) {
    visit(root, identity());
  }

  const primitivesOf = (node: Json, where: string): Json[] =>
    asArray(meshes[node.mesh as number]?.primitives, where);

  let fileRadius = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let triangles = 0;
  let degenerate = 0;
  let emissiveTriangles = 0;
  const nodeTypes: string[] = [];
  const nodeNames: string[] = [];
  for (const [index, node] of nodes.entries()) {
    const name = typeof node.name === 'string' ? node.name : `node-${index}`;
    nodeNames.push(name);
    if (node.mesh === undefined) {
      nodeTypes.push(joints.has(index) ? 'Bone' : 'Group');
      continue;
    }
    nodeTypes.push('Mesh');
    const matrix = world.get(index) ?? identity();
    for (const primitive of primitivesOf(node, `${label} ${name} primitives`)) {
      const attributes = primitive.attributes as Json;
      const positions = readFloats(gltf, attributes.POSITION, `${label} ${name} POSITION`);
      const normals = readFloats(gltf, attributes.NORMAL, `${label} ${name} NORMAL`);
      const indices = readFloats(gltf, primitive.indices, `${label} ${name} indices`);
      if (positions.length % 3 !== 0) {
        fail(`${label} ${name}: POSITION is not a whole number of vertices`);
      }
      if (indices.length % 3 !== 0) {
        fail(`${label} ${name}: ${indices.length} indices is not a whole number of triangles`);
      }
      const vertexCount = positions.length / 3;
      triangles += indices.length / 3;
      if (name === entry.emissiveNode) {
        emissiveTriangles += indices.length / 3;
      }
      // The vertex is read through the node's world matrix, because a model is measured in the space it
      // will be placed in and a node may carry its own offset.
      const point = (element: number): Vec3 => {
        const x = positions[element * 3] as number;
        const y = positions[element * 3 + 1] as number;
        const z = positions[element * 3 + 2] as number;
        return [
          (matrix[0] as number) * x + (matrix[4] as number) * y + (matrix[8] as number) * z + (matrix[12] as number),
          (matrix[1] as number) * x + (matrix[5] as number) * y + (matrix[9] as number) * z + (matrix[13] as number),
          (matrix[2] as number) * x + (matrix[6] as number) * y + (matrix[10] as number) * z + (matrix[14] as number),
        ];
      };
      for (let triangle = 0; triangle < indices.length; triangle += 3) {
        const [a, b, c] = [
          indices[triangle] as number,
          indices[triangle + 1] as number,
          indices[triangle + 2] as number,
        ];
        if (a >= vertexCount || b >= vertexCount || c >= vertexCount) {
          fail(`${label} ${name}: triangle ${triangle / 3} references a vertex outside the position accessor`);
        }
        const [first, second, third] = [point(a), point(b), point(c)];
        const edgeA: Vec3 = [second[0] - first[0], second[1] - first[1], second[2] - first[2]];
        const edgeB: Vec3 = [third[0] - first[0], third[1] - first[1], third[2] - first[2]];
        const face: Vec3 = [
          edgeA[1] * edgeB[2] - edgeA[2] * edgeB[1],
          edgeA[2] * edgeB[0] - edgeA[0] * edgeB[2],
          edgeA[0] * edgeB[1] - edgeA[1] * edgeB[0],
        ];
        const length = Math.hypot(face[0], face[1], face[2]);
        if (length <= DEGENERATE_FACE_NORMAL) {
          degenerate += 1;
          continue;
        }
        const stored: Vec3 = [
          (normals[a * 3] as number) + (normals[b * 3] as number) + (normals[c * 3] as number),
          (normals[a * 3 + 1] as number) + (normals[b * 3 + 1] as number) + (normals[c * 3 + 1] as number),
          (normals[a * 3 + 2] as number) + (normals[b * 3 + 2] as number) + (normals[c * 3 + 2] as number),
        ];
        if (face[0] * stored[0] + face[1] * stored[1] + face[2] * stored[2] <= 0) {
          fail(`${label} ${name}: triangle ${triangle / 3} winds against its vertex normals`);
        }
      }
      for (let vertex = 0; vertex < vertexCount; vertex += 1) {
        const [x, y, z] = point(vertex);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
        fileRadius = Math.max(fileRadius, Math.hypot(x, z));
      }
    }
  }
  const floor = Number.isFinite(minY) ? minY : 0;
  return {
    id: entry.id,
    bytes: bytes.length,
    triangles,
    nodeTypes: [...new Set(nodeTypes)],
    nodeNames,
    fileRadius: round5(fileRadius),
    minY: round5(floor),
    height: round5(maxY - floor),
    emissiveTriangles,
    skins: skins.length,
    animationClips: asArray(gltf.json.animations ?? [], `${label} animations`).length,
    materials: asArray(gltf.json.materials ?? [], `${label} materials`).length,
    textures: asArray(gltf.json.textures ?? [], `${label} textures`).length,
    degenerateTriangles: degenerate,
  };
};

// The seat a model ends up in. Both numbers are presentation answers the client owns: a tower scales
// its seat by the multiplier in its look, and a creature's model is authored in world units and stands
// at 1. They are copied here rather than imported because the look tables are Three.js modules, and a
// Node check cannot load one. The client's own gate measures the same product from those tables and the
// seam publishes what it got, so a change on that side shows up in the readings instead of hiding
// behind this file.
const TOWER_SEAT_SCALE: Readonly<Record<string, number>> = {
  'pulse-spire': 1.42,
  'grove-lens': 1.15,
  'frost-relay': 0.98,
};
const CREATURE_IDS = ['husk', 'runner', 'wisp', 'swarmling', 'carapace', 'mote', 'maw', 'unknown'] as const;
const CREATURE_SEAT_SCALE = 1;

// The broadest the seat of a tower ever gets, as a multiplier of the width the world gate was given.
// It is 1, and it is written down rather than assumed: this is the number that used to be 1.228 and
// put all three files over the niche, so the table that prints the level-10 column and the run that
// refuses it both have to name a value instead of reading a truth that lives in another module.
const TOWER_GROWTH_WIDTH_AT_LEVEL_10 = 1;

const seatScaleFor = (id: string): number | null =>
  TOWER_SEAT_SCALE[id] ?? ((CREATURE_IDS as readonly string[]).includes(id) ? CREATURE_SEAT_SCALE : null);

const expectRefusal = (action: () => void, pattern: RegExp, label: string): void => {
  let message: string | null = null;
  try {
    action();
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === null) {
    fail(`red check: ${label} was accepted, so the check proves nothing`);
  }
  if (!pattern.test(message)) {
    fail(`red check: ${label} failed with an unexpected message: ${message}`);
  }
  console.log(`  red check ok: ${label} -> ${message}`);
};

// Doubles every position the model declares, in place, so the file keeps its length and every offset in
// its JSON chunk stays true. The copy is written into a work directory: the artifact in
// `assets/accepted` is not touched, because a check that edits the thing it checks is not a check.
const repackDoubled = (entry: ModelManifestEntry, bytes: Buffer, target: string): Buffer => {
  const label = entry.file;
  const gltf = readGlb(bytes, label);
  const nodes = asArray(gltf.json.nodes, `${label} nodes`);
  const meshes = asArray(gltf.json.meshes, `${label} meshes`);
  const out = Buffer.from(bytes);
  for (const node of nodes) {
    if (node.mesh === undefined) {
      continue;
    }
    for (const primitive of asArray(meshes[node.mesh as number]?.primitives, `${label} primitives`)) {
      const accessor = asArray(gltf.json.accessors, `${label} accessors`)[
        (primitive.attributes as Json).POSITION as number
      ];
      if (!accessor || accessor.componentType !== 5126) {
        fail(`${label}: POSITION is not a float accessor, this reader cannot repack it`);
      }
      const view = asArray(gltf.json.bufferViews, `${label} bufferViews`)[accessor.bufferView as number];
      const at = gltf.binStart + ((view.byteOffset as number) ?? 0) + ((accessor.byteOffset as number) ?? 0);
      for (let i = 0; i < (accessor.count as number) * 3; i += 1) {
        out.writeFloatLE(out.readFloatLE(at + i * 4) * 2, at + i * 4);
      }
    }
  }
  writeFileSync(target, out);
  return out;
};

const readAccepted = (path: string, where: string): AssetManifest => {
  try {
    return parseAssetManifest(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return fail(`${where}: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const main = (): void => {
  const manifest = readAccepted(join(SOURCE_DIR, 'manifest.json'), 'accepted manifest');
  const published = readAccepted(join(PUBLISHED_DIR, 'manifest.json'), 'published manifest');
  // The registry the client reads has to be the merge of both sources, and the accepted half of it has
  // to be the accepted half on disk: a copy that drifted from its source would be a model nobody has
  // looked at, in the one place where nobody is watching.
  const publishedById = new Map(published.models.map((entry) => [entry.id, entry]));
  for (const entry of manifest.models) {
    const out = publishedById.get(entry.id);
    if (!out) {
      fail(`${entry.id} is in the accepted source and not in the published registry`);
    }
    if (out.file !== entry.file || out.bytes !== entry.bytes || out.contentHash !== entry.contentHash) {
      fail(`${entry.id} is published as a different file than the accepted source holds`);
    }
  }

  const readings: ModelReading[] = [];
  for (const entry of manifest.models) {
    // This run accepts the export of towers and creatures, and a measurement here is a measurement
    // of a lit node: the terrain sets arrive from another producer and are checked by the pipeline
    // that publishes them. A record this script does not measure must not be measured as one.
    if (isTerrainRecord(entry)) {
      continue;
    }
    const bytes = readFileSync(join(SOURCE_DIR, entry.file));
    if (bytes.length !== entry.bytes) {
      fail(`${entry.file}: ${bytes.length} bytes on disk but the manifest claims ${entry.bytes}`);
    }
    const hash = sha256(bytes);
    if (hash !== entry.contentHash) {
      fail(`${entry.file}: content hash ${hash} does not match the manifest claim ${entry.contentHash}`);
    }
    if (!readFileSync(join(PUBLISHED_DIR, entry.file)).equals(bytes)) {
      fail(`${entry.file}: the published copy differs from the accepted source`);
    }
    const reading = measure(entry, bytes);
    if (reading.triangles !== entry.triangles) {
      fail(`${entry.file}: ${reading.triangles} triangles in the file but the manifest claims ${entry.triangles}`);
    }
    const refused = reading.nodeTypes.filter((type) => !SUPPORTED_NODE_TYPES.includes(type));
    if (refused.length > 0) {
      fail(`${entry.file}: node types ${refused.join(', ')} are not one the client can instantiate`);
    }
    if (reading.textures > 0) {
      fail(`${entry.file}: ${reading.textures} textures are not allowed in this pipeline`);
    }
    const budget = checkModelContract({ id: entry.id, bytes: entry.bytes, triangles: entry.triangles });
    if (budget.length > 0) {
      fail(`${entry.file}: budget check refused: ${describeFailures(budget)}`);
    }
    if (!reading.nodeNames.includes(entry.emissiveNode)) {
      fail(`${entry.file}: no node named ${entry.emissiveNode}`);
    }
    if (entry.hoverY !== undefined && Math.abs(entry.hoverY - reading.minY) > 1e-5) {
      // The manifest declares a gap above the ground and the file has to agree with it: the client puts
      // the health bar over the body from both numbers, and a declared gap the geometry does not have
      // is a bar either inside the creature or floating above it.
      fail(`${entry.file}: hoverY ${entry.hoverY} but the file's body starts at ${reading.minY}`);
    }
    readings.push(reading);
  }
  const registry = checkRegistryBudgets(manifest.models);
  if (registry.length > 0) {
    fail(`registry check refused: ${describeFailures(registry)}`);
  }

  // Every model has to pass the world gate in the seat the client will put it in, through the same
  // predicate `loadModel` calls. The run fails here if any of the ten would be refused in the browser,
  // which is the whole point of moving the gate off the build: the build only sees its own primitives.
  //
  // A tower is measured twice, and the second column is the one that used to be missing. The gate
  // compares the seat as it stands on load, where the level is 1, and a level-10 seat is the same
  // width by decision — so the two numbers have to be printed side by side for the invariant to be
  // visible rather than asserted. A creature has no levels and carries its own file radius across.
  const table = readings.map((reading) => {
    const entry = manifest.models.find((candidate) => candidate.id === reading.id) as ModelManifestEntry;
    const seat = seatScaleFor(reading.id);
    if (seat === null) {
      fail(`${reading.id} has no seat, so nothing will ever instantiate it and the registry is carrying a file for nothing`);
    }
    const isTower = TOWER_SEAT_SCALE[reading.id] !== undefined;
    const grownSeat = isTower ? seat * TOWER_GROWTH_WIDTH_AT_LEVEL_10 : seat;
    const world = round5(reading.fileRadius * seat);
    const worldGrown = round5(reading.fileRadius * grownSeat);
    const gated = checkWorldFootprint(reading.id, reading.fileRadius, seat);
    if (gated.length > 0) {
      fail(`${reading.id} would be refused by the world gate: ${describeFailures(gated)}`);
    }
    // The gate is one predicate, and the level-10 seat goes through the same one: a tower that is
    // inside a niche on level 1 and outside it on level 10 is exactly the defect this column exists
    // for, and a run that only compared the load-time number would call that tree green.
    const grownGated = checkWorldFootprint(reading.id, reading.fileRadius, grownSeat);
    if (grownGated.length > 0) {
      fail(`${reading.id} would be refused by the world gate at level 10: ${describeFailures(grownGated)}`);
    }
    const hover = entry.hoverY === undefined ? 'on the ground' : `hover ${entry.hoverY}`;
    return (
      `${reading.id.padEnd(12)} file radius ${String(reading.fileRadius).padStart(7)} x seat ${String(seat).padStart(4)} ` +
      `= world ${String(world).padStart(6)} / ${WORLD_FOOTPRINT_BUDGET.radius} · ` +
      `world at L10 ${String(worldGrown).padStart(6)} / ${WORLD_FOOTPRINT_BUDGET.radius} · ` +
      `height ${String(reading.height).padStart(6)} · ` +
      `${hover.padEnd(13)} · ${String(reading.triangles).padStart(4)} tris, ${entry.emissiveNode} ${reading.emissiveTriangles} · ` +
      `degenerate ${reading.degenerateTriangles}`
    );
  });

  // Red runs. Both go through the code the browser uses, and both have to be refused for the reason
  // they are here to prove: a gap that arrived as text is a broken contract, and a model twice as wide
  // as the niche it is about to stand in is a broken artifact.
  const raw = JSON.parse(readFileSync(join(SOURCE_DIR, 'manifest.json'), 'utf8')) as Json;
  for (const [value, label] of [
    ['0.16', 'hoverY that arrived as text'],
    [null, 'hoverY that is not a number at all'],
  ] as const) {
    const broken = JSON.parse(JSON.stringify(raw)) as Json;
    (broken.models as Json[])[0].hoverY = value;
    expectRefusal(
      () => parseAssetManifest(broken),
      /model registry field models\[0\]\.hoverY must be a number when present/,
      `${label}, refused by the registry contract`,
    );
  }

  // The growth seat, refused. This is the red run the whole level-10 column rests on, and it does not
  // invent a model: it takes a tower that is inside its niche today and multiplies the seat by the
  // width growth that used to be in the table. `pulse-spire` is the worst of the three at 0.99464 —
  // 0.5 per cent of headroom — so it crosses first, and the refusal has to come back with the same
  // three numbers the gate names. If this run were ever to pass, the column above would be printing
  // a number no check looks at.
  {
    const id = 'pulse-spire';
    const reading = readings.find((candidate) => candidate.id === id) as ModelReading;
    const seat = seatScaleFor(id) as number;
    const widened = round5(seat * 1.228);
    const worldGrown = round5(reading.fileRadius * widened);
    const gated = checkWorldFootprint(id, reading.fileRadius, widened);
    if (gated.length === 0) {
      fail(
        `red check: a ${id} seat grown to ${widened} in width stands at world radius ${worldGrown}, ` +
          `which the gate of ${WORLD_FOOTPRINT_BUDGET.radius} accepted`,
      );
    }
    console.log(`  level-10 seat: ${id} x ${widened} = world ${worldGrown}, over the gate`);
    expectRefusal(
      () => {
        throw new Error(describeFailures(gated));
      },
      new RegExp(`${id}: world footprint radius is ${String(worldGrown).replace('.', '\\.')}[^;]*the world allows ${WORLD_FOOTPRINT_BUDGET.radius}`),
      `${id} at a width-grown level-10 seat, refused with its numbers`,
    );
  }

  mkdirSync(WORK_DIR, { recursive: true });
  try {
    // One tower on each seat multiplier and one creature, whose world radius is its file radius: the
    // gate is one predicate, and a red run that only exercised the towers would leave the second seat
    // unproven. `mote` is not in the list on purpose — doubled it is still 0.5 wide, which is inside the
    // gate, and a red run that has to be true to be a red run is not one.
    for (const id of ['pulse-spire', 'frost-relay', 'carapace']) {
      const entry = manifest.models.find((candidate) => candidate.id === id) as ModelManifestEntry;
      const repacked = repackDoubled(entry, readFileSync(join(SOURCE_DIR, entry.file)), join(WORK_DIR, entry.file));
      assert.notEqual(sha256(repacked), entry.contentHash, 'the repacked file must differ from the artifact');
      const reading = measure(entry, repacked);
      const seat = seatScaleFor(id) as number;
      const world = round5(reading.fileRadius * seat);
      const gated = checkWorldFootprint(id, reading.fileRadius, seat);
      if (gated.length === 0) {
        fail(`${id}: a model doubled in place came out at world radius ${world}, which is inside the gate`);
      }
      console.log(
        `  repacked ${entry.file}: ${entry.triangles} -> ${reading.triangles} triangles, ` +
          `file radius ${reading.fileRadius} x seat ${seat} = world ${world}`,
      );
      expectRefusal(
        () => {
          throw new Error(describeFailures(checkWorldFootprint(id, reading.fileRadius, seat)));
        },
        new RegExp(`${id}: world footprint radius is ${String(world).replace('.', '\\.')}[^;]*the world allows ${WORLD_FOOTPRINT_BUDGET.radius}`),
        `${id} repacked with doubled geometry, refused with its numbers`,
      );
    }
  } finally {
    rmSync(WORK_DIR, { recursive: true, force: true });
  }

  const totals = sumRegistry(manifest.models);
  console.log(table.join('\n'));
  console.log(
    `registry: ${totals.models}/${REGISTRY_BUDGET.models} models · ${totals.bytes}/${REGISTRY_BUDGET.bytes} bytes · ` +
      `${totals.triangles}/${REGISTRY_BUDGET.triangles} triangles · world gate ${WORLD_FOOTPRINT_BUDGET.radius}`,
  );
  console.log(`nexus models: ok (${manifest.models.length} accepted artifacts, ${readings.length} measured)`);
};

try {
  main();
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
