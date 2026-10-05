import * as THREE from 'three';
import { cellBounds, trainingCoreCell, trainingPlan } from '../game-core/index.ts';
import type { CellKind, MapGrid } from '../game-core/index.ts';
import type { MatchConfig, MatchSnapshot, Vec2 } from '../game-core/index.ts';
import { withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The map as the owner's file describes it: a grid of cells, and three kinds of surface built from
// it. Nothing here is a second description of the road. The previous map drew twenty rectangles from
// a table of hand-entered segments; this one reads the grid and paints what it finds, so the picture
// and the walk cannot disagree — a creature on the road and the road under it are the same cells.
//
// **One quad per run of cells, not per cell.** Painting 9 216 separate quads would draw a grid of
// squares with gaps between them, which reads as graph paper rather than as ground with a road across
// it. Consecutive cells of the same kind in a row are therefore one quad, and the runs are counted so
// the cost is a number and not a hope: 440 quads of free ground, 288 of road, 160 of occupied. The
// road then reads as a carriageway because it is a continuous surface, and it is not "a grid of
// cells" anywhere on the frame.
//
// The three surfaces are three materials and not one material with three colours, because they mean
// three different things: road is walkable and nothing may be built on it, free is buildable and not
// walkable, occupied is neither. A tile that looked different would say the same thing with a picture
// instead of with a material, and a picture does not survive the next tone pass.
// ---------------------------------------------------------------------------------------------

/**
 * What the map answers about itself. The camera, the renderer and the debug seam live in the page, so
 * everything they need from here arrives through this one surface instead of a variable they had to
 * reach into.
 */
export type MapPresentation = {
  /**
   * Half the width of the carriageway, in world units. It is half a cell because a road cell is one
   * unit wide, and it is published because a spot's distance to the road is only meaningful against it
   * — a pad four units from the road and a pad four cells from it are the same statement here, which is
   * the first time in this project that has been true.
   */
  roadHalfWidth: number;
  /**
   * The three cell counts as the scene painted them, counted from the quads it built rather than from
   * the grid it read. This is the half of the "grid matches the file" check that does not trust the
   * file: the scene proves it drew what the file said.
   */
  paintedCells: { free: number; road: number; occupied: number };
  /** The same three numbers as the grid holds them, so the two can be compared in one place. */
  gridCells: { free: number; road: number; occupied: number };
  /** The cell the core stands on, in the owner's cell coordinates. */
  coreCell: { x: number; y: number };
  /**
   * Every route read back off the finished config, with its length in cells and in units and whether
   * it ends on the core cell. Read from the polylines rather than from the builder that produced them,
   * so what a reader checks is what the creatures will actually walk.
   */
  routeReadings: Array<{
    routeId: string;
    cells: number;
    points: number;
    lengthInCells: number;
    lengthInUnits: number;
    endsAtCoreCell: boolean;
  }>;
  /**
   * The drawn length of the whole road, in world units, every junction counted once per quad. One
   * cell is one unit, so this is the number of road cells.
   */
  routeLength: number;
  routeSegmentCount: number;
  /**
   * The road as the scene painted it: world units, one rectangle per run of road cells. The minimap
   * reads this and nothing else about the map. A second description of the road in the page is a
   * second one to fall out of step with the first, and an earlier version of this file had one already:
   * polylines along the run centres, which drew the horizontal half of every road on the minimap and
   * dropped the vertical half without anyone noticing. Rectangles are what the board is made of, so
   * the panel and the board cannot disagree about which cells are road.
   */
  roadRects: Array<[minX: number, minZ: number, maxX: number, maxZ: number]>;
  /**
   * The four corners of the plate, which is what the frame reading in the page measures against.
   */
  corridorSamplePoints: Array<[number, number]>;
  distanceToRoad: (x: number, z: number) => number;
  corridorCoverage: (x: number, z: number, range: number) => number;
  /**
   * Empty, and empty on purpose. Placement on open ground is the work after this one, so there is no
   * marked spot on the plate to hit and the ray the page casts finds nothing. The page keeps the whole
   * placement path around it; this is the part that says there is nothing to click.
   */
  pickTargets: THREE.Object3D[];
  padCount: () => number;
};

type EdgePoint = readonly [x: number, z: number];
type FlatQuad = readonly [a: EdgePoint, b: EdgePoint, c: EdgePoint, d: EdgePoint];
type PlacedQuad = { corners: FlatQuad; lift: number };

// The road stands a couple of centimetres off the plate and the occupied ground a thousandth below it,
// so that nothing the map draws is coplanar with the ground it lies on.
const ROAD_Y = 0.02;
const LIFT = 0.001;

// Flat quads in the plane the map is drawn in: local x is world x, local y is world -z, and local z is
// how far the quad stands off the height of the mesh carrying it. The corners are given in world order
// — low x, low z first — and wound here so that the face turned towards the camera is the front face,
// which is why the material does not have to be drawn double-sided to be seen from above.
const flatGeometry = (quads: readonly PlacedQuad[]): THREE.BufferGeometry => {
  const positions = new Float32Array(quads.length * 6 * 3);
  const normals = new Float32Array(quads.length * 6 * 3);
  const uvs = new Float32Array(quads.length * 6 * 2);
  let cursor = 0;
  const put = ([x, z]: EdgePoint, lift: number): void => {
    positions[cursor * 3] = x;
    positions[cursor * 3 + 1] = -z;
    positions[cursor * 3 + 2] = lift;
    normals[cursor * 3 + 2] = 1;
    uvs[cursor * 2] = x;
    uvs[cursor * 2 + 1] = z;
    cursor += 1;
  };
  for (const { corners, lift } of quads) {
    const [a, b, c, d] = corners;
    put(a, lift);
    put(c, lift);
    put(b, lift);
    put(a, lift);
    put(d, lift);
    put(c, lift);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  return geometry;
};

const cellQuad = (minX: number, minZ: number, maxX: number, maxZ: number): FlatQuad => [
  [minX, minZ],
  [maxX, minZ],
  [maxX, maxZ],
  [minX, maxZ],
];

type RoadSegment = { ax: number; az: number; bx: number; bz: number; length: number };

const NO_PICK_TARGETS: THREE.Object3D[] = [];

/**
 * The runs of one kind of cell, each row read left to right. This is the whole of how a grid becomes a
 * surface: a run of cells is one quad, and the run's extent comes from the cell bounds in
 * `map-grid.ts` rather than from arithmetic done here, so the picture cannot sit half a cell off the
 * walk.
 */
const cellRuns = (
  grid: MapGrid,
  kind: CellKind,
): Array<{ minX: number; minZ: number; maxX: number; maxZ: number; cells: number }> => {
  const runs: Array<{ minX: number; minZ: number; maxX: number; maxZ: number; cells: number }> = [];
  for (let y = 0; y < grid.height; y += 1) {
    let x = 0;
    while (x < grid.width) {
      if (grid.kindAt({ x, y }) !== kind) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (end < grid.width && grid.kindAt({ x: end, y }) === kind) {
        end += 1;
      }
      // Both ends of the quad are read off cell bounds: the far edge of the last cell of the run is
      // the near edge of the cell after it, which is the same number.
      const start = cellBounds(grid, { x, y });
      const stop = cellBounds(grid, { x: end - 1, y });
      runs.push({ minX: start[0], minZ: start[1], maxX: stop[2], maxZ: stop[3], cells: end - x });
      x = end;
    }
  }
  return runs;
};

export const createMap = (scene: THREE.Scene, config: MatchConfig): MapPresentation => {
  // The grid the plan was built from, not a read of the file: one answer, and the scene cannot be
  // showing a different map from the one the creatures walk.
  const grid = trainingPlan().grid;

  // Three surfaces on a plate of the same kind, so they take the same dim share of the environment
  // probe and differ only in what colour they are. Free ground is the tone the plate already had: a
  // field, not bare rock. Road is grey and stands a shade above it. Occupied is darker and lower —
  // it reads as ground you cannot have, which is exactly what it is.
  const freeMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x97ff29, roughness: 0.95, metalness: 0.02 }),
    'ground',
  );
  const roadMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9, metalness: 0.04 }),
    'path',
  );
  const occupiedMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x606165, roughness: 0.94, metalness: 0.02 }),
    'ground',
  );

  const freeRuns = cellRuns(grid, 'free');
  const roadRuns = cellRuns(grid, 'road');
  const occupiedRuns = cellRuns(grid, 'occupied');

  const addSurface = (name: string, runs: typeof freeRuns, material: THREE.Material, lift: number): number => {
    const mesh = new THREE.Mesh(
      flatGeometry(
        runs.map((run) => ({
          corners: cellQuad(run.minX, run.minZ, run.maxX, run.maxZ),
          lift,
        })),
      ),
      material,
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = ROAD_Y;
    mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    return runs.reduce((total, run) => total + run.cells, 0);
  };

  const freeCells = addSurface('free-ground', freeRuns, freeMaterial, 0);
  const roadCells = addSurface('road', roadRuns, roadMaterial, LIFT);
  const occupiedCells = addSurface('occupied-ground', occupiedRuns, occupiedMaterial, 0);

  // Counted from the quads that were built, not from the grid that was read. The two numbers are
  // published side by side so a reader can see they agree, and the free plate behind them is not what
  // makes them agree — it is underneath, and these are the quads on top of it.
  const paintedCells = { free: freeCells, road: roadCells, occupied: occupiedCells };

  const roadSegments: RoadSegment[] = roadRuns.map((run) => ({
    ax: run.minX,
    az: (run.minZ + run.maxZ) / 2,
    bx: run.maxX,
    bz: (run.minZ + run.maxZ) / 2,
    length: run.maxX - run.minX,
  }));
  const routeLength = roadSegments.reduce((total, segment) => total + segment.length, 0);

  const distanceToSegment = (px: number, pz: number, segment: RoadSegment): number => {
    const deltaX = segment.bx - segment.ax;
    const deltaZ = segment.bz - segment.az;
    const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
    const along = lengthSquared <= 0
      ? 0
      : Math.max(0, Math.min(1, ((px - segment.ax) * deltaX + (pz - segment.az) * deltaZ) / lengthSquared));
    return Math.hypot(px - (segment.ax + deltaX * along), pz - (segment.az + deltaZ * along));
  };

  const distanceToRoad = (px: number, pz: number): number => {
    let nearest = Number.POSITIVE_INFINITY;
    for (const segment of roadSegments) {
      nearest = Math.min(nearest, distanceToSegment(px, pz, segment));
    }
    return nearest;
  };

  // How much road a spot sees at a given tower range, measured the way a tower shoots: against the
  // lane, sampled along it, which keeps it honest for any range without a closed-form segment clip.
  const COVERAGE_SAMPLE = 0.05;
  const corridorCoverage = (px: number, pz: number, range: number): number => {
    let covered = 0;
    for (const segment of roadSegments) {
      const samples = Math.max(1, Math.ceil(segment.length / COVERAGE_SAMPLE));
      const step = segment.length / samples;
      for (let sample = 0; sample <= samples; sample += 1) {
        const along = Math.min(segment.length, sample * step);
        const t = segment.length <= 0 ? 0 : along / segment.length;
        if (Math.hypot(px - (segment.ax + (segment.bx - segment.ax) * t), pz - (segment.az + (segment.bz - segment.az) * t)) <= range) {
          covered += step;
        }
      }
    }
    return Math.round(covered * 100) / 100;
  };

  const plateHalfX = config.map.width / 2;
  const plateHalfZ = config.map.depth / 2;
  // The core's cell, taken from the content rather than derived from the core's position. Deriving it
  // here would be a second copy of the cell arithmetic, and the task that put `cellCenter` in one place
  // would be undone by inverting it somewhere else; the content already holds the cell, so it is read.
  const coreCell = { x: trainingCoreCell.x, y: trainingCoreCell.y };

  // The routes as the finished config holds them, measured along their own polylines. The step count is
  // read from the points rather than remembered from the builder, so a route that lost its end on the
  // way from the grid to the config would be reported short instead of reported correct.
  const core = config.map.corePosition;
  const routeReadings = config.map.routes.map((route) => {
    let length = 0;
    for (let index = 1; index < route.points.length; index += 1) {
      const from = route.points[index - 1];
      const to = route.points[index];
      length += Math.hypot(to.x - from.x, to.z - from.z);
    }
    const last = route.points[route.points.length - 1];
    // One cell is one world unit, so the polyline length is the number of cells it crosses. Rounded
    // because a straight run of whole cells adds up to a whole number and a reader should not be asked
    // to compare 79.00000000000001 with 79.
    const steps = Math.round(length);
    return {
      routeId: route.id,
      cells: steps + 1,
      points: route.points.length,
      lengthInCells: steps,
      lengthInUnits: Math.round(length * 100) / 100,
      endsAtCoreCell: last !== undefined && last.x === core.x && last.z === core.z,
    };
  });

  return {
    roadHalfWidth: 0.5,
    paintedCells,
    gridCells: { free: grid.counts.free, road: grid.counts.road, occupied: grid.counts.occupied },
    coreCell,
    routeReadings,
    routeLength,
    routeSegmentCount: roadSegments.length,
    roadRects: roadRuns.map((run) => [run.minX, run.minZ, run.maxX, run.maxZ]),
    corridorSamplePoints: [
      [-plateHalfX, -plateHalfZ],
      [plateHalfX, -plateHalfZ],
      [plateHalfX, plateHalfZ],
      [-plateHalfX, plateHalfZ],
    ],
    distanceToRoad,
    corridorCoverage,
    pickTargets: NO_PICK_TARGETS,
    padCount: () => 0,
  };
};

// ---------------------------------------------------------------------------------------------
// The minimap: the whole plate, every frame, from the snapshot the scene is already drawing.
//
// It is a 2D canvas and not a second Three.js view, and that is the decision. A second camera would
// have to be fitted, kept in step with the first and would cost a second full render of a map that is
// already nine thousand cells; this draws about a hundred strokes and reads the same snapshot the
// frame it sits inside is reading. It holds no state of its own: every mark on it is either a fact
// about the map, which comes from `config` and from the road polylines above, or a fact about this
// instant, which comes out of the snapshot handed in. A minimap with its own copy of the wave is a
// minimap that is wrong a frame after the board is right.
//
// The one thing it adds that the board does not have is the frame rectangle — where the camera is
// looking, at what scale. Without it a click moves the view somewhere the player cannot see, and on a
// map this size that is the difference between a map and a teleport.
// ---------------------------------------------------------------------------------------------

export type MinimapPresentation = {
  // Redraws from the snapshot. `view` is the camera's own rectangle in world units, or null before
  // the first frame has placed the camera.
  draw: (next: MatchSnapshot, view: MinimapView | null) => void;
  // A click in window coordinates to a point on the map, or null for a click off the canvas. The
  // canvas is the same surface the player sees, so the mapping is the box and not the backing store.
  worldAt: (clientX: number, clientY: number) => Vec2 | null;
  readonly scale: () => number;
};

export type MinimapView = { halfWidth: number; halfHeight: number; targetX: number; targetZ: number };

const MINIMAP_PLATE = '#0b2029';
const MINIMAP_ROAD = '#2f9d92';
const MINIMAP_ROAD_CORE = '#7cf0dc';
const MINIMAP_ENEMY = '#ff8f6b';
const MINIMAP_BASE = '#7ce7d2';
const MINIMAP_FRAME = 'rgba(233, 245, 242, 0.7)';

export const createMinimap = (
  canvas: HTMLCanvasElement,
  config: MatchConfig,
  roadRects: ReadonlyArray<readonly [minX: number, minZ: number, maxX: number, maxZ: number]>,
): MinimapPresentation => {
  const context = canvas.getContext('2d');
  const half = Math.max(config.map.width, config.map.depth) / 2;
  let backing = 0;
  let plate = 0;

  // The backing store follows the box the browser laid out, at the device's own density. A fixed
  // attribute size would be sharp on a desktop and soft on the same panel at a narrower breakpoint,
  // and the click mapping would be off by the ratio between them.
  const syncSurface = (): boolean => {
    if (!context) {
      return false;
    }
    const box = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(box.width));
    const height = Math.max(1, Math.round(box.height));
    const density = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const wanted = Math.round(width * density);
    if (wanted === backing && width === plate) {
      return true;
    }
    backing = wanted;
    plate = width;
    canvas.width = wanted;
    canvas.height = Math.max(1, Math.round(height * density));
    return true;
  };

  const unit = (): number => (plate > 0 ? plate / (half * 2) : 0);
  const toX = (x: number): number => (x + half) * unit();
  const toY = (z: number): number => (z + half) * unit();

  

  const dot = (x: number, z: number, radius: number, fill: string): void => {
    context!.beginPath();
    context!.arc(toX(x), toY(z), radius, 0, Math.PI * 2);
    context!.fillStyle = fill;
    context!.fill();
  };

  return {
    draw: (next: MatchSnapshot, view: MinimapView | null): void => {
      if (!syncSurface() || !context) {
        return;
      }
      const size = unit();
      context.setTransform(backing / plate, 0, 0, backing / plate, 0, 0);
      context.clearRect(0, 0, plate, plate);
      context.fillStyle = MINIMAP_PLATE;
      context.fillRect(0, 0, plate, plate);

      // The road is drawn as the rectangles the board is made of: a wide dark pass for the channel and
      // a narrow lit pass down its middle, which is the same read the board gives — a lit line in a dark
      // trench — at two pixels wide. One pass at one width reads as a hairline, and a hairline on a map is
      // a wire. The passes are drawn as strokes along each rectangle's own edges rather than its centre
      // line, so a run that is one cell wide reads as a road and not as the wire it used to be.
      context.lineCap = 'butt';
      context.lineJoin = 'miter';
      for (const [grow, color] of [[Math.max(3, size * 1.6), MINIMAP_ROAD], [Math.max(1, size * 0.5), MINIMAP_ROAD_CORE]] as const) {
        context.strokeStyle = color;
        context.lineWidth = grow;
        for (const [minX, minZ, maxX, maxZ] of roadRects) {
          context.strokeRect(toX(minX), toY(minZ), (maxX - minX) * unit(), (maxZ - minZ) * unit());
        }
      }

      // The core is the one thing on the plate the road leads to. It was a square read from a base
      // half-side that this map no longer has; it is a point now, because that is what it is — one cell
      // with a world position, drawn at the size a cell is on this panel.
      context.fillStyle = MINIMAP_BASE;
      context.fillRect(
        toX(config.map.corePosition.x) - Math.max(1.5, size * 0.8),
        toY(config.map.corePosition.z) - Math.max(1.5, size * 0.8),
        Math.max(3, size * 1.6),
        Math.max(3, size * 1.6),
      );

      // Hostiles last and in the only warm colour on the plate, because they are the one thing on it
      // that is moving toward something the player owns. They are also the smallest thing drawn: at
      // 2.3 pixels to a unit an eight-tenths husk is under two, and the wave — the one fact the
      // panel exists to carry — has to be the first thing a glance finds.
      const enemyRadius = Math.max(1.6, size * 0.8);
      for (const enemy of next.enemies) {
        dot(enemy.x, enemy.z, enemyRadius, MINIMAP_ENEMY);
      }

      if (view) {
        // The frame is a rectangle in world units drawn in the map's own axes rather than the
        // camera's, so it stays a rectangle on a tilted stand. It is a footprint, not a projection,
        // and the two agree well enough at this scale to be read at a glance.
        const top = view.targetZ - view.halfHeight;
        const bottom = view.targetZ + view.halfHeight;
        const left = view.targetX - view.halfWidth;
        const right = view.targetX + view.halfWidth;
        context.strokeStyle = MINIMAP_FRAME;
        context.lineWidth = 1;
        context.strokeRect(toX(left), toY(top), (right - left) * unit(), (bottom - top) * unit());
      }
    },
    worldAt: (clientX: number, clientY: number): Vec2 | null => {
      const box = canvas.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) {
        return null;
      }
      if (clientX < box.left || clientX > box.left + box.width || clientY < box.top || clientY > box.top + box.height) {
        return null;
      }
      const scale = unit() > 0 ? unit() : box.width / (half * 2);
      return {
        x: (clientX - box.left) / scale - half,
        z: (clientY - box.top) / scale - half,
      };
    },
    scale: unit,
  };
};