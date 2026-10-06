import * as THREE from 'three';
import type { CellKind, MapCell, MapGrid } from '../game-core/index.ts';
import { cellCenter } from '../game-core/index.ts';
import type { TerrainModelEntry } from '../asset-registry.ts';
import type { SkinDefinition, SkinTile } from './skin.ts';
import { cellNoise, withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The forty props, on the occupied cells.
//
// Forty three-dimensional models on one plate, up to about sixteen hundred of them, and the whole
// point of this module is that the count of instances is not the count of cost. An `InstancedMesh`
// per slot uploads one geometry and draws it as many times as the plate asks, so the triangles are
// charged once per model — eight thousand six hundred and fifty for the whole forest — while the
// instances are free. The same forest as ordinary meshes would be three hundred and sixty thousand
// triangles and the scene budget of two hundred and fifty thousand would be gone before the first
// tower was drawn. This is a construction decision, not a tuning one, and it is why there is exactly
// one mesh per slot here and no per-prop object anywhere.
//
// ## Occupied cells take props and nothing else
//
// A cell the map calls `occupied` is ground a creature may not walk on. So it is drawn by a prop or
// by nothing: the procedural shapes in `terrain.ts` are built for open ground only, and this module
// walks occupied cells only, so the two cannot meet on a cell even if one of them is wrong about
// where the ground is. `userData.src` is what says which of the two a reader is looking at — `prop`
// here, `rule` there — and `userData.cellType` says what kind of ground it stands on.
//
// ## A set without props refuses; it does not fall back
//
// All forty or none. If one slot is missing, mismatched or over budget, no prop is drawn at all and
// every reason is reported, because the alternative is a forest with a hole in it and a cell that
// the map says is blocked and the picture says is walkable — the exact disagreement between map and
// game that the cell model exists to prevent. There is no procedural shape kept in reserve for an
// occupied cell, here or anywhere else.
// ---------------------------------------------------------------------------------------------

export type PropModel = {
  entry: TerrainModelEntry;
  scene: THREE.Group;
};

export type SlotReading = {
  slot: number;
  kind: string;
  footprint: 1 | 2;
  file: string;
  instances: number;
  triangles: number;
};

export type PropsReadings = {
  /** Drawn, or null when the set refused and nothing was placed. */
  slots: SlotReading[];
  /** The reason each refused slot gave, by slot number. Empty when every slot is in. */
  refusals: Array<{ slot: number; file: string; reason: string }>;
  meshes: number;
  instances: number;
  triangles: number;
  /** Occupied cells the walk offered a prop to, and how many took one. */
  cellsAvailable: number;
  cellsClaimedByTwoCellProps: number;
  instancesByKind: Record<CellKind, number>;
};

export type PropsPresentation = {
  readings: PropsReadings;
  dispose: () => void;
};

/**
 * Which slot a cell takes, and the only randomness in the module.
 *
 * The file promises forty slots and says nothing about which lands where, so the choice is read out
 * of the cell: every occupied cell offers itself the same uniform pick, the same cell always takes
 * the same slot, and the whole forest is a function of the map rather than of the order the scene
 * happened to build in. `salt` is what lets the second half of a two-cell prop take a different slot
 * from the first without either of them reaching for a counter.
 */
const slotFor = (skin: SkinDefinition, cell: MapCell, salt: number): number => {
  const slots = skin.tiles.length;
  const pick = cellNoise(cell.x, cell.y, salt) * slots;
  return skin.tiles[Math.min(slots - 1, Math.floor(pick))]?.slot ?? 1;
};

/**
 * The cell a two-cell prop stands across from, or null when there is no room.
 *
 * The four neighbours are tried in a fixed order — right, then away, then left, then back — and the
 * first one that is on the plate, is an occupied cell and is not already spoken for is taken. A
 * footprint of two is a claim on two cells, so the cell it claims has to be one no other prop is
 * about to be placed on; otherwise a forest of two-cell boulders would stand half inside each other
 * and half on nothing.
 */
const partnerOf = (grid: MapGrid, claimed: Uint8Array, cell: MapCell): MapCell | null => {
  const order: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ];
  for (const [dx, dy] of order) {
    const target = { x: cell.x + dx, y: cell.y + dy };
    if (grid.kindAt(target) !== 'occupied') {
      continue;
    }
    if (claimed[target.y * grid.width + target.x] === 1) {
      continue;
    }
    return target;
  }
  return null;
};

/**
 * Where each prop stands.
 *
 * The walk is row-major over the occupied cells, so the slot a cell draws is decided before the walk
 * reaches it and the outcome does not depend on how the cells were reached. A cell whose drawn slot
 * wants two cells and has no room for the second falls back to the next single-cell slot rather than
 * standing a two-cell prop across a cell that is already taken.
 */
const placementsOf = (
  grid: MapGrid,
  skin: SkinDefinition,
): { bySlot: Map<number, Array<{ x: number; z: number; yaw: number }>>; available: number; claimedByPairs: number } => {
  const bySlot = new Map<number, Array<{ x: number; z: number; yaw: number }>>();
  const claimed = new Uint8Array(grid.width * grid.height);
  const single = skin.tiles.filter((tile) => tile.footprint === 1);
  let available = 0;
  let claimedByPairs = 0;

  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const cell = { x, y };
      if (grid.kindAt(cell) !== 'occupied' || claimed[y * grid.width + x] === 1) {
        continue;
      }
      available += 1;
      let tile: SkinTile | undefined = skin.tiles.find((candidate) => candidate.slot === slotFor(skin, cell, 1));
      let partner: MapCell | null = tile?.footprint === 2 ? partnerOf(grid, claimed, cell) : null;
      if (tile === undefined || (tile.footprint === 2 && partner === null)) {
        // No room for a second cell, or a slot the file did not describe. A single-cell slot is the
        // honest fallback and it is the only fallback: it claims the cell it stands on and nothing
        // else, so nothing is left claimed and unoccupied.
        tile = single[Math.floor(cellNoise(cell.x, cell.y, 2) * single.length)];
        partner = null;
      }
      if (tile === undefined) {
        continue;
      }
      const anchor = cellCenter(grid, cell);
      const centre = partner === null
        ? anchor
        : { x: anchor.x + 0.5, z: anchor.z + 0.5 };
      claimed[y * grid.width + x] = 1;
      if (partner !== null) {
        claimed[partner.y * grid.width + partner.x] = 1;
        claimedByPairs += 1;
      }
      const bucket = bySlot.get(tile.slot) ?? [];
      // Yaw is the only thing that varies between two props of the same slot. The models are authored
      // in the game's own units with the cell equal to the unit, so nothing about them is scaled, and
      // the file states no offset for a prop either — one prop stands on the middle of the cells it
      // takes, which is the convention the set was written under.
      bucket.push({ x: centre.x, z: centre.z, yaw: cellNoise(cell.x + 13, cell.y + 29, PROP_SALT) * Math.PI * 2 });
      bySlot.set(tile.slot, bucket);
    }
  }
  return { bySlot, available, claimedByPairs };
};

const PROP_SALT = 3;

export const createProps = (
  scene: THREE.Scene,
  grid: MapGrid,
  skin: SkinDefinition,
  models: ReadonlyMap<string, PropModel>,
  surfaceY: number,
): PropsPresentation => {
  const meshes: THREE.InstancedMesh[] = [];
  const { bySlot, available, claimedByPairs } = placementsOf(grid, skin);

  // One material for all forty slots, and the reason is that none of them has a material of its own:
  // the accepted files carry their colour in `COLOR_0` and declare nothing, so the only question is
  // what the vertex colours get lit by. Forty copies of the same answer would be forty shader
  // uniforms and forty disposals for one look.
  const material = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0.02 }),
    'prop',
  );

  const slots: SlotReading[] = [];
  const refusals: PropsReadings['refusals'] = [];
  const instancesByKind: Record<CellKind, number> = { free: 0, road: 0, occupied: 0 };
  let instances = 0;
  let triangles = 0;

  for (const tile of skin.tiles) {
    const placement = bySlot.get(tile.slot) ?? [];
    if (placement.length === 0) {
      continue;
    }
    const model = models.get(tile.file) ?? null;
    if (model === null) {
      refusals.push({
        slot: tile.slot,
        file: tile.file,
        reason: `slot ${tile.slot} wants ${tile.file} and the plate has no copy of it`,
      });
      continue;
    }
    const source = instancedGeometryFor(model.scene);
    if (source === null) {
      refusals.push({
        slot: tile.slot,
        file: tile.file,
        reason: `slot ${tile.slot} loaded ${tile.file} but the tree carries no geometry to instance`,
      });
      continue;
    }
    const slotTriangles = source.getAttribute('position').count / 3;
    const mesh = new THREE.InstancedMesh(source, material, placement.length);
    mesh.name = `prop-${tile.file}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.src = 'prop';
    mesh.userData.cellType = 'occupied';
    mesh.userData.slot = tile.slot;
    mesh.userData.kind = tile.kind;
    mesh.userData.file = tile.file;
    const transform = new THREE.Object3D();
    for (const [index, at] of placement.entries()) {
      transform.position.set(at.x, surfaceY, at.z);
      transform.rotation.set(0, at.yaw, 0);
      transform.scale.setScalar(1);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
    scene.add(mesh);
    meshes.push(mesh);
    instances += placement.length;
    triangles += slotTriangles;
    instancesByKind.occupied += placement.length;
    slots.push({
      slot: tile.slot,
      kind: tile.kind,
      footprint: tile.footprint,
      file: tile.file,
      instances: placement.length,
      triangles: slotTriangles,
    });
  }

  // All forty or none. A slot that could not be placed takes the whole set with it, and the meshes
  // already added are taken back down rather than left standing as a forest with a hole in it.
  if (refusals.length > 0) {
    for (const mesh of meshes) {
      scene.remove(mesh);
      mesh.dispose();
    }
    meshes.length = 0;
    slots.length = 0;
    instances = 0;
    triangles = 0;
    instancesByKind.occupied = 0;
  }

  return {
    readings: {
      slots,
      refusals,
      meshes: meshes.length,
      instances,
      triangles,
      cellsAvailable: available,
      cellsClaimedByTwoCellProps: claimedByPairs,
      instancesByKind,
    },
    dispose: () => {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.dispose();
      }
      meshes.length = 0;
      material.dispose();
    },
  };
};

/**
 * The one geometry an instanced prop is built from.
 *
 * A prop file is a single node with a single mesh, but "single" is a claim about the file rather than
 * an instruction to the loader, so the tree is walked and every mesh's geometry is merged into one
 * buffer. Merging rather than picking the first is deliberate: taking the first would draw a stump
 * and call it a tree, and nothing would say so. The walk order is the file's own, so the merge is a
 * function of the file.
 */
const instancedGeometryFor = (root: THREE.Object3D): THREE.BufferGeometry | null => {
  const geometries: THREE.BufferGeometry[] = [];
  root.updateMatrixWorld(true);
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry === undefined || geometries.includes(mesh.geometry)) {
      return;
    }
    // `applyMatrix4` carries the node's own transform into the positions and the normals with it, so
    // the merged buffer is in the file's own frame — the same frame the footprint was measured in, and
    // the same one a prop's pivot is defined against.
    const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    geometries.push(geometry);
  });
  if (geometries.length === 0) {
    return null;
  }
  if (geometries.length === 1) {
    return geometries[0] as THREE.BufferGeometry;
  }
  // One geometry, many parts: the instancing API takes a single buffer per mesh, so the parts are
  // concatenated here. This is the only place a merge happens, and it happens once per slot at load.
  const merged = new THREE.BufferGeometry();
  const names = ['position', 'normal', 'color', 'uv'] as const;
  for (const name of names) {
    const present = geometries.filter((geometry) => geometry.getAttribute(name) !== undefined);
    if (present.length !== geometries.length) {
      continue;
    }
    const itemSize = (present[0] as THREE.BufferGeometry).getAttribute(name).itemSize;
    let total = 0;
    for (const geometry of present) {
      total += geometry.getAttribute(name).count * itemSize;
    }
    const array = new Float32Array(total);
    let cursor = 0;
    for (const geometry of present) {
      const attribute = geometry.getAttribute(name);
      array.set(attribute.array as Float32Array, cursor);
      cursor += attribute.array.length;
    }
    merged.setAttribute(name, new THREE.BufferAttribute(array, itemSize));
  }
  if (merged.getAttribute('position') === undefined) {
    merged.setAttribute('position', geometries[0]?.getAttribute('position')?.clone() ?? new THREE.BufferAttribute(new Float32Array(0), 3));
  }
  if (merged.getAttribute('normal') === undefined) {
    merged.computeVertexNormals();
  }
  merged.computeBoundingSphere();
  for (const geometry of geometries) {
    geometry.dispose();
  }
  return merged;
};
