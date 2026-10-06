import * as THREE from 'three';
import type { CellKind, MapCell, MapGrid } from '../game-core/index.ts';
import { cellBounds } from '../game-core/index.ts';
import type { SkinDefinition, SkinRule } from './skin.ts';
import { splitRules } from './skin.ts';
import { cellNoise, withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The ground, painted from the skin.
//
// Three surfaces and the small shapes that cover them are the whole of what this module owns. The
// props are a separate module: they arrive after forty files load and they are models rather than
// shapes this one builds.
//
// ## The palette is per vertex, not per material
//
// The file gives two colours per kind of cell, and that is a ramp rather than a pair of
// alternatives — a forest floor is not "green or darker green", it is every shade between them with
// the shade decided by where on the plate the cell is. So the ground carries a `color` attribute and
// the material is white. The three materials that used to hold the three flat tones still exist and
// still mean the same three things; what now differs between them is how much of the environment
// probe they take, which was the only difference that ever mattered.
//
// ## The height of a cell is a fact of its kind, and the seam between kinds is drawn
//
// `blockedLift` and `roadSink` are the file's numbers, and `readSkin` has already divided them into
// world units, so a cell stands at its kind's height and nowhere else. That leaves the one thing the
// file does not say and a picture cannot do without: a plate with three heights has vertical faces
// between them, and a face that is not drawn is a hole straight through the terrain to the sky. So
// every boundary between two different heights gets one quad, facing the lower cell, which is the
// only side anything can ever see it from.
//
// ## The shapes on open ground are built here, and the file's builder name is not read
//
// A rule says how many objects to expect in a block, how big, how scattered, how tilted and what
// colour each part is. It does not say what shape any of them is, because the format does not carry
// geometry. So this module builds its own shapes, and the one hint the file does carry is the part
// names: a part this module has no shape for is drawn as a generic clump rather than refused,
// because the next set will bring a part nobody has seen and a refusal would make the file unopenable
// rather than the picture wrong. `builder` is not consulted at all — the contract calls it a name for
// a reader, and a game that switched on it would be reimplementing the exporter's own object table,
// which is the thing the file was written to stop.
// ---------------------------------------------------------------------------------------------

/** Where each kind of cell stands. The free ground is the reference and the other two move off it. */
export type SurfaceHeights = Record<CellKind, number>;

export type GroundReading = {
  /** Cells painted per kind, counted from the quads built rather than from the grid read. */
  cells: Record<CellKind, number>;
  /** One quad per cell, plus one vertical face per boundary between two heights. */
  deckQuads: number;
  skirtQuads: number;
  triangles: number;
  /** The height each kind stands at, so the division can be read rather than trusted. */
  heights: SurfaceHeights;
  /** The exporter's cell size, and the relief numbers as they were written before the division. */
  cellSize: number;
  reliefAsWritten: { blockedLift: number; roadSink: number };
};

export type ScatterReading = {
  id: string;
  cellType: CellKind;
  layer: string;
  instances: number;
  triangles: number;
};

export type TerrainReadings = {
  ground: GroundReading;
  scatter: ScatterReading[];
  /** Instances per kind of ground, by origin. The count the acceptance reads a scene walk by. */
  instancesByKind: Record<CellKind, number>;
};

export type TerrainPresentation = {
  heights: SurfaceHeights;
  readings: TerrainReadings;
  dispose: () => void;
};

// ---------------------------------------------------------------------------------------------
// Colour.
//
// The file writes `#rrggbb`, which is a display value. A vertex colour attribute is read as already
// being in the working space, so each end of each ramp is converted once here and everything after
// this is linear arithmetic. Skipping the conversion is what makes a palette read two and a half
// times too dark, and it is the kind of mistake that survives a green test.
// ---------------------------------------------------------------------------------------------

const srgb = (hex: string): THREE.Color => new THREE.Color().setStyle(hex, THREE.SRGBColorSpace);

type Ramp = { low: THREE.Color; high: THREE.Color };

const rampOf = (palette: readonly [string, string]): Ramp => ({ low: srgb(palette[0]), high: srgb(palette[1]) });

// A patch of eight cells decides the broad tone and the cell itself decides the grain, because a
// per-cell hash alone is gravel and a broad tone alone is a gradient. Bilinear over that lattice is
// what makes the middle: neighbouring cells land near each other, so the change from one shade to
// the next is a patch rather than a step.
const PATCH = 8;

const patchNoise = (x: number, y: number): number => {
  const lx = x / PATCH;
  const ly = y / PATCH;
  const x0 = Math.floor(lx);
  const y0 = Math.floor(ly);
  const tx = lx - x0;
  const ty = ly - y0;
  const corner = (cx: number, cy: number): number => cellNoise(cx, cy, 91);
  const along = corner(x0, y0) * (1 - tx) + corner(x0 + 1, y0) * tx;
  const other = corner(x0, y0 + 1) * (1 - tx) + corner(x0 + 1, y0 + 1) * tx;
  return along * (1 - ty) + other * ty;
};

const rampPosition = (x: number, y: number): number => {
  const broad = patchNoise(x, y);
  const grain = cellNoise(x, y, 17);
  return Math.min(1, Math.max(0, 0.15 + 0.6 * broad + 0.25 * grain));
};

// ---------------------------------------------------------------------------------------------
// The deck.
//
// Flat quads in the plane the map is drawn in: local x is world x, local y is world -z, and local z
// is the height above the base the mesh stands on. Wound so the face turned towards the camera is
// the front face, which is why nothing here is drawn double-sided.
// ---------------------------------------------------------------------------------------------

type DeckQuad = {
  corners: ReadonlyArray<readonly [number, number]>;
  lift: number;
  /**
   * Colours for the four corners, not one for the quad. A quad that carries a single colour shows its
   * own edges, which is exactly what a carriageway must not do — the road is a continuous surface and
   * per-cell blocks read as a tiled floor. Interpolating across the corners lets one quad span a whole
   * run of cells and still carry the ramp across its whole length.
   */
  cornerColours: ReadonlyArray<readonly [number, number, number]>;
};

const DECK_ROLE = { free: 'ground', road: 'path', occupied: 'ground' } as const;

/** One quad per cell, at the height of its kind, coloured from that kind's ramp. */
const deckQuadsOf = (
  grid: MapGrid,
  heights: SurfaceHeights,
  ramps: Record<CellKind, Ramp>,
): Record<CellKind, DeckQuad[]> => {
  const out: Record<CellKind, DeckQuad[]> = { free: [], road: [], occupied: [] };
  const scratch = new THREE.Color();
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      const kind = grid.kindAt({ x, y });
      if (kind === null) {
        continue;
      }
      const [minX, minZ, maxX, maxZ] = cellBounds(grid, { x, y });
      const ramp = ramps[kind];
      const at = rampPosition(x, y);
      scratch.copy(ramp.low).lerp(ramp.high, at);
      const colour: readonly [number, number, number] = [scratch.r, scratch.g, scratch.b];
      out[kind].push({
        corners: [
          [minX, minZ],
          [maxX, minZ],
          [maxX, maxZ],
          [minX, maxZ],
        ],
        lift: heights[kind],
        cornerColours: [colour, colour, colour, colour],
      });
    }
  }
  return out;
};

/**
 * The road as whole runs of cells rather than as cells.
 *
 * This is the one surface of the three that is a strip, and it is drawn like one. The free ground and
 * the ground under the forest want per-cell grain — a floor has a texture — while a carriageway read
 * as a tiled floor is a different surface entirely. So the road's runs are taken from the grid here
 * rather than asked of the map, and each run is one quad whose ramp is interpolated from its first cell
 * to its last, which is both how a road looks and 2 128 triangles cheaper than painting it cell by
 * cell.
 */
const roadRunQuadsOf = (
  grid: MapGrid,
  height: number,
  ramp: Ramp,
): { quads: DeckQuad[]; cells: number } => {
  const quads: DeckQuad[] = [];
  let cells = 0;
  const scratch = new THREE.Color();
  const at = (x: number, y: number): readonly [number, number, number] => {
    scratch.copy(ramp.low).lerp(ramp.high, rampPosition(x, y));
    return [scratch.r, scratch.g, scratch.b];
  };
  for (let y = 0; y < grid.height; y += 1) {
    let x = 0;
    while (x < grid.width) {
      if (grid.kindAt({ x, y }) !== 'road') {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < grid.width && grid.kindAt({ x: end, y }) === 'road') {
        end += 1;
      }
      const [minX, minZ] = cellBounds(grid, { x, y });
      const [stopX, , stopZ] = cellBounds(grid, { x: end - 1, y });
      const head = at(x, y);
      const tail = at(end - 1, y);
      quads.push({
        corners: [
          [minX, minZ],
          [stopX, minZ],
          [stopX, stopZ],
          [minX, stopZ],
        ],
        lift: height,
        cornerColours: [head, tail, tail, head],
      });
      cells += end - x;
      x = end;
    }
  }
  return { quads, cells };
};

const attributeGeometry = (
  positions: Float32Array,
  colours: Float32Array,
  uvs: Float32Array,
): THREE.BufferGeometry => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
};

const deckGeometry = (quads: readonly DeckQuad[]): THREE.BufferGeometry => {
  const positions = new Float32Array(quads.length * 6 * 3);
  const colours = new Float32Array(quads.length * 6 * 3);
  const uvs = new Float32Array(quads.length * 6 * 2);
  let cursor = 0;
  for (const quad of quads) {
    const [a, b, c, d] = quad.corners;
    const [ca, cb, cc, cd] = quad.cornerColours;
    const put = (
      [x, z]: readonly [number, number],
      colour: readonly [number, number, number],
    ): void => {
      positions[cursor * 3] = x;
      positions[cursor * 3 + 1] = -z;
      positions[cursor * 3 + 2] = quad.lift;
      colours[cursor * 3] = colour[0];
      colours[cursor * 3 + 1] = colour[1];
      colours[cursor * 3 + 2] = colour[2];
      uvs[cursor * 2] = x;
      uvs[cursor * 2 + 1] = z;
      cursor += 1;
    };
    put(a as readonly [number, number], ca as readonly [number, number, number]);
    put(c as readonly [number, number], cc as readonly [number, number, number]);
    put(b as readonly [number, number], cb as readonly [number, number, number]);
    put(a as readonly [number, number], ca as readonly [number, number, number]);
    put(d as readonly [number, number], cd as readonly [number, number, number]);
    put(c as readonly [number, number], cc as readonly [number, number, number]);
  }
  return attributeGeometry(positions, colours, uvs);
};

/**
 * The walls between cells of different heights, as one geometry.
 *
 * One quad per boundary, its two base corners on the shared edge and its two top corners directly
 * above them. The winding is chosen from which side is lower, so the front face always looks out of
 * the wall towards the cell a player can see it from; only that side is drawn, because the other is
 * back-facing and would cost triangles to buy nothing.
 */
const skirtGeometry = (grid: MapGrid, heights: SurfaceHeights): { geometry: THREE.BufferGeometry; quads: number } => {
  type Edge = {
    a: readonly [number, number];
    b: readonly [number, number];
    low: number;
    high: number;
    alongX: boolean;
    hereLow: boolean;
  };
  const edges: Edge[] = [];
  const consider = (x: number, y: number, dx: number, dy: number): void => {
    const here = grid.kindAt({ x, y });
    const next = grid.kindAt({ x: x + dx, y: y + dy });
    if (here === null || next === null || heights[here] === heights[next]) {
      return;
    }
    // `hereLow` names the side the visible face has to look towards: the lower cell, because that is
    // the only side a camera above the plate can see this wall from.
    const hereLow = heights[here] < heights[next];
    const low = heights[hereLow ? here : next];
    const high = heights[hereLow ? next : here];
    const [minX, minZ, maxX, maxZ] = cellBounds(grid, { x, y });
    edges.push(
      dx !== 0
        ? { a: [hereLow ? maxX : minX, minZ], b: [hereLow ? maxX : minX, maxZ], low, high, alongX: true, hereLow }
        : { a: [minX, hereLow ? maxZ : minZ], b: [maxX, hereLow ? maxZ : minZ], low, high, alongX: false, hereLow },
    );
  };
  for (let y = 0; y < grid.height; y += 1) {
    for (let x = 0; x < grid.width; x += 1) {
      consider(x, y, 1, 0);
      consider(x, y, 0, 1);
    }
  }

  const positions = new Float32Array(edges.length * 6 * 3);
  const colours = new Float32Array(edges.length * 6 * 3);
  const uvs = new Float32Array(edges.length * 6 * 2);
  let cursor = 0;
  const put = ([x, z]: readonly [number, number], y: number): void => {
    positions[cursor * 3] = x;
    positions[cursor * 3 + 1] = -z;
    positions[cursor * 3 + 2] = y;
    uvs[cursor * 2] = x;
    uvs[cursor * 2 + 1] = z;
    cursor += 1;
  };
  for (const edge of edges) {
    // The winding is worked out here rather than left to the normals. Local x is world x and local y
    // is world -z, so a base run along world +Z emits a face looking along local -X, and a base run
    // along world +X emits a face looking along world +Z. Swapping the base run flips that, which is
    // the whole of what the flag below decides.
    const [first, second] = edge.hereLow !== edge.alongX ? [edge.b, edge.a] : [edge.a, edge.b];
    put(first, edge.low);
    put(second, edge.low);
    put(second, edge.high);
    put(first, edge.low);
    put(second, edge.high);
    put(first, edge.high);
  }
  const geometry = attributeGeometry(positions, colours, uvs);
  return { geometry, quads: edges.length };
};

// ---------------------------------------------------------------------------------------------
// The shapes on open ground.
// ---------------------------------------------------------------------------------------------

/**
 * How tall a blade and a bush stand before the rule's own scale multiplies them, in world units.
 *
 * Two numbers, and they are numbers rather than facts from the file because the file states no
 * geometry. They are set against the creature that walks between them rather than against the
 * camera: a creature is about 0.8 units tall on this map, so ground cover below half of that reads
 * as ground and cover above it reads as a wall that hides the fight. Both sit under it.
 */
const BLADE_HEIGHT = 0.22;
const BUSH_HEIGHT = 0.4;

/** Which shape each named part is drawn as. An unknown part is not an error, it is a clump. */
const shapeOfPart = (part: string): 'blade' | 'bush' | 'clump' => {
  if (part === 'blade') {
    return 'blade';
  }
  if (part === 'bush') {
    return 'bush';
  }
  return 'clump';
};

/**
 * The shape of one rule: its parts, its colours and nothing else.
 *
 * Each part darkens towards its own foot, written into the corners rather than sampled from a
 * texture, which is what makes a clump read as a mass instead of as a decal. `side` is left to the
 * material because a blade has to be visible edge-on and there are thousands of them.
 */
const scatterGeometry = (rule: SkinRule): THREE.BufferGeometry => {
  const positions: number[] = [];
  const colours: number[] = [];
  const uvs: number[] = [];
  const leaf = (palette: readonly [string, string], at: number): THREE.Color =>
    srgb(palette[0]).lerp(srgb(palette[1]), at);
  const quad = (
    a: readonly [number, number, number],
    b: readonly [number, number, number],
    c: readonly [number, number, number],
    d: readonly [number, number, number],
    colour: THREE.Color,
  ): void => {
    positions.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let index = 0; index < 6; index += 1) {
      colours.push(colour.r, colour.g, colour.b);
    }
    uvs.push(a[0], a[2], b[0], b[2], c[0], c[2], a[0], a[2], c[0], c[2], d[0], d[2]);
  };

  for (const [part, palette] of Object.entries(rule.colors)) {
    const foot = leaf(palette, 0.2);
    const tip = leaf(palette, 1);
    const shape = shapeOfPart(part);
    if (shape === 'blade') {
      // Two quads crossing at the root: one blade is a line from the side and two at a right angle
      // are a tuft. Four triangles at twelve thousand instances is the difference between a forest
      // floor and a blown scene budget.
      const lean = BLADE_HEIGHT * 0.22;
      quad([-0.035, 0, -0.01], [0.035, 0, -0.01], [lean, BLADE_HEIGHT, -0.01], [lean * 0.4, BLADE_HEIGHT, 0.02], foot);
      quad([-0.01, 0, -0.035], [0.01, 0, -0.035], [0.02, BLADE_HEIGHT, lean], [-0.02, BLADE_HEIGHT, lean * 0.4], tip);
      continue;
    }
    if (shape === 'bush') {
      const radius = BUSH_HEIGHT * 0.34;
      quad([-radius, 0, -radius * 0.2], [radius, 0, -radius * 0.2], [radius * 0.7, radius, -radius * 0.2], [-radius * 0.7, radius, -radius * 0.2], foot);
      quad([-radius * 0.2, 0, -radius], [-radius * 0.2, 0, radius], [-radius * 0.2, radius, radius * 0.7], [-radius * 0.2, radius, -radius * 0.7], tip);
      continue;
    }
    const radius = BUSH_HEIGHT * 0.4;
    quad([-radius, 0, 0], [radius, 0, 0], [radius * 0.7, radius, 0], [-radius * 0.7, radius, 0], foot);
    quad([0, 0, -radius], [0, 0, radius], [0, radius, radius * 0.7], [0, radius, -radius * 0.7], tip);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.computeVertexNormals();
  return geometry;
};

type Placement = { cell: MapCell; x: number; z: number; scale: number };

/**
 * Where a rule's objects go, read out of the block counts the file states.
 *
 * The count is an expected number for the whole `cell`-sided block rather than a density, so the
 * objects are dealt out across the block's own cells in order: every cell of the block gets some,
 * and the number the file promised is the number that appears. `jitter` then says how far inside
 * its cell an object may sit, and the same draw decides the size, so a clump never stands squarely
 * in the middle of a square of ground.
 */
const scatterPlacements = (rule: SkinRule, grid: MapGrid, skin: SkinDefinition): Placement[] => {
  const out: Placement[] = [];
  const block = skin.scatter.cell;
  for (let by = 0; by < skin.scatter.blocksY; by += 1) {
    for (let bx = 0; bx < skin.scatter.blocksX; bx += 1) {
      const wanted = Math.round(rule.count[by * skin.scatter.blocksX + bx] ?? 0);
      if (wanted <= 0) {
        continue;
      }
      const cells: MapCell[] = [];
      for (let dy = 0; dy < block; dy += 1) {
        for (let dx = 0; dx < block; dx += 1) {
          const target = { x: bx * block + dx, y: by * block + dy };
          if (grid.kindAt(target) === rule.cellType) {
            cells.push(target);
          }
        }
      }
      if (cells.length === 0) {
        continue;
      }
      for (let index = 0; index < wanted; index += 1) {
        const at = cells[index % cells.length] as MapCell;
        const [minX, minZ] = cellBounds(grid, at);
        const [low, high] = rule.scale;
        out.push({
          cell: at,
          x: minX + 0.5 + (cellNoise(at.x, at.y, index * 7 + 3) - 0.5) * rule.jitter,
          z: minZ + 0.5 + (cellNoise(at.y, at.x, index * 7 + 5) - 0.5) * rule.jitter,
          scale: low + (high - low) * cellNoise(at.x + 31, at.y + 17, index * 7 + 11),
        });
      }
    }
  }
  return out;
};

/**
 * Paints the ground and the open-ground cover, and nothing else.
 *
 * `baseY` is the height the free ground stands at, and it is a parameter rather than a constant so
 * that the map module keeps owning where the plate is: this module answers "how high is each kind
 * relative to the ground", not "where is the ground".
 */
export const createTerrain = (
  scene: THREE.Scene,
  grid: MapGrid,
  skin: SkinDefinition,
  baseY: number,
): TerrainPresentation => {
  const heights: SurfaceHeights = {
    free: baseY,
    road: baseY - skin.relief.roadSink,
    occupied: baseY + skin.relief.blockedLift,
  };
  const ramps: Record<CellKind, Ramp> = {
    free: rampOf(skin.ground.free),
    road: rampOf(skin.ground.road),
    occupied: rampOf(skin.ground.occupied),
  };

  const meshes: THREE.Mesh[] = [];
  let deckQuads = 0;
  let skirtQuads = 0;
  let deckTriangles = 0;
  let scatterTriangles = 0;

  const surface = (name: string, role: 'ground' | 'path', geometry: THREE.BufferGeometry, quads: number): void => {
    if (quads === 0) {
      geometry.dispose();
      return;
    }
    const material = withProbeWeight(
      new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.95, metalness: 0.02 }),
      role,
    );
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.y = baseY;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = name;
    scene.add(mesh);
    meshes.push(mesh);
  };

  const deck = deckQuadsOf(grid, heights, ramps);
  const road = roadRunQuadsOf(grid, heights.road, ramps.road);
  const cells: Record<CellKind, number> = {
    free: deck.free.length,
    road: road.cells,
    occupied: deck.occupied.length,
  };
  deckQuads = deck.free.length + road.quads.length + deck.occupied.length;
  deckTriangles = deckQuads * 2;
  surface('free-ground', DECK_ROLE.free, deckGeometry(deck.free), deck.free.length);
  surface('road', DECK_ROLE.road, deckGeometry(road.quads), road.quads.length);
  surface('occupied-ground', DECK_ROLE.occupied, deckGeometry(deck.occupied), deck.occupied.length);

  // The wall takes the occupied palette's low end, a share down from the high end: a wall reads as
  // the side of the thing standing above it, and a fourth palette would be a thing no file described.
  const wall = ramps.occupied.low.clone().lerp(ramps.occupied.high, 0.25).multiplyScalar(0.8);
  const skirt = skirtGeometry(grid, heights);
  if (skirt.quads > 0) {
    const painted = skirt.geometry.getAttribute('color');
    for (let index = 0; index < painted.count; index += 1) {
      painted.setXYZ(index, wall.r, wall.g, wall.b);
    }
    surface('terrain-skirt', 'ground', skirt.geometry, skirt.quads);
    skirtQuads = skirt.quads;
  }

  // Ground cover on open ground only. The rules that draw occupied ground are left out on purpose:
  // a cell the map calls blocked is drawn by a prop or by nothing, and the alternative is a picture
  // that disagrees with the walk.
  const scatter: ScatterReading[] = [];
  const instancesByKind: Record<CellKind, number> = { free: 0, road: 0, occupied: 0 };
  const transform = new THREE.Object3D();
  for (const rule of splitRules(skin).open) {
    const placements = scatterPlacements(rule, grid, skin);
    if (placements.length === 0) {
      continue;
    }
    const geometry = scatterGeometry(rule);
    const triangles = (geometry.getAttribute('position').count / 3) * placements.length;
    const material = withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        vertexColors: true,
        roughness: 0.88,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
      'ground',
    );
    const mesh = new THREE.InstancedMesh(geometry, material, placements.length);
    mesh.name = `scatter-${rule.id}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // The two fields a scene walk counts by. `src` says which of the two kinds of thing this is and
    // `cellType` says what kind of ground it stands on, and neither is derived: the loop below runs
    // over open ground only, so a rule cannot reach an occupied cell even by a mistake in its own
    // numbers.
    mesh.userData.src = 'rule';
    mesh.userData.cellType = rule.cellType;
    mesh.userData.skinRule = rule.id;
    for (const [index, placement] of placements.entries()) {
      transform.position.set(placement.x, heights[rule.cellType] - baseY, placement.z);
      transform.rotation.set(
        rule.tilt * (cellNoise(placement.cell.x, index, 41) - 0.5),
        cellNoise(placement.cell.x + 5, placement.cell.y + 9, 43) * Math.PI * 2,
        rule.tilt * (cellNoise(index, placement.cell.y, 47) - 0.5),
      );
      transform.scale.setScalar(placement.scale);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    scene.add(mesh);
    meshes.push(mesh);
    instancesByKind[rule.cellType] += placements.length;
    deckTriangles += triangles;
    scatterTriangles += triangles;
    scatter.push({
      id: rule.id,
      cellType: rule.cellType,
      layer: rule.layer,
      instances: placements.length,
      triangles,
    });
  }

  return {
    heights,
    readings: {
      ground: {
        cells,
        deckQuads,
        skirtQuads,
        // The deck's own triangles and nothing else. What stands on it is counted by the two arrays
        // below it, so a reader can add the three and get the whole ground rather than being handed a
        // number that already includes the cover.
        triangles: deckTriangles - scatterTriangles,
        heights,
        cellSize: skin.cellSize,
        reliefAsWritten: skin.reliefAsWritten,
      },
      scatter,
      instancesByKind,
    },
    dispose: () => {
      for (const mesh of meshes) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        const material = mesh.material;
        if (Array.isArray(material)) {
          for (const entry of material) {
            entry.dispose();
          }
        } else {
          material.dispose();
        }
      }
      meshes.length = 0;
    },
  };
};