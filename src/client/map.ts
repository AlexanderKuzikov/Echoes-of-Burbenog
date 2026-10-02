import * as THREE from 'three';
import { trainingRoadNetwork } from '../game-core/scenario.ts';
import type { MatchConfig, MatchSnapshot, Vec2 } from '../game-core/index.ts';
import { withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The road and the base on a flat plate.
//
// The plate is one plane in `main.ts` and nothing else about the ground is drawn. There is no raster
// here, no massif, no terraces keyed to depth into rock, no niches with floors and frames, no pads and
// no chamber: the drawing the geometry was taken from has none of those, and a flat plate leaves
// nothing to shade by depth and no spot worth marking. What is left is twenty rectangles of one width
// and one square in the middle, which is two meshes.
//
// A lane is a rectangle from its first point to its last with the width across it, not a mitred ribbon
// around a polyline: every lane in the table is axis-aligned and every junction is a crossing, so there
// is no corner to mitre and a ribbon would round the corners the drawing has square. Where two lanes
// cross they overlap, because they overlap in the drawing too, and a thousandth of a unit of height
// separates the two orientations so the crossing is a crossing and not two surfaces arguing over the
// same depth. At the scale the player sees that step is a hundredth of a pixel.
// ---------------------------------------------------------------------------------------------

/**
 * What the map answers about itself. The camera, the renderer and the debug seam live in the page, so
 * everything they need from here arrives through this one surface instead of a variable they had to
 * reach into.
 */
export type MapPresentation = {
  roadHalfWidth: number;
  /** Half the side of the base square, which is all a square has to be described by. */
  baseHalf: number;
  /**
   * The drawn length of the whole network, every junction counted once per lane that reaches it. It is
   * the sum of the twenty segments and not the length of the union they make, because the union of
   * twenty rectangles is a different sum to compute and this number is a reading, not a rule.
   */
  routeLength: number;
  routeSegmentCount: number;
  // The road as it is actually drawn, world units, one polyline per lane. The minimap reads this and
  // nothing else about the map: a second description of the road in the page is a second one to fall
  // out of step with the first, and the minimap is exactly the surface that would show it.
  roadPolylines: Array<Array<[number, number]>>;
  /**
   * The four corners of the plate, which is what the frame reading in the page measures against. It was
   * the open cells of a cut raster before, and the plate is the whole of the ground now.
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

// The road stands a couple of centimetres off the plate, and the base a thousandth above the road, so
// that nothing the map draws is coplanar with the ground it lies on.
const ROAD_Y = 0.02;
const LIFT = 0.001;

// Flat quads in the plane the road is drawn in: local x is world x, local y is world -z, and local z is
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

// The rectangle a lane covers, from its first point to its last and half a road to either side.
const laneQuad = (minX: number, minZ: number, maxX: number, maxZ: number): FlatQuad => [
  [minX, minZ],
  [maxX, minZ],
  [maxX, maxZ],
  [minX, maxZ],
];

type RoadSegment = { ax: number; az: number; bx: number; bz: number; length: number };

const NO_PICK_TARGETS: THREE.Object3D[] = [];

export const createMap = (scene: THREE.Scene, config: MatchConfig): MapPresentation => {
  const network = trainingRoadNetwork;
  const half = network.roadHalfWidth;

  // The road and the base are two rough near-dielectric surfaces on a plate of the same kind, so they
  // take the same dim share of the environment probe and differ only in what colour they are.
  const roadMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x9a9a9a, roughness: 0.9, metalness: 0.04 }),
    'path',
  );
  const baseMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x606165, roughness: 0.94, metalness: 0.02 }),
    'ground',
  );

  const roadQuads: PlacedQuad[] = [
    ...network.horizontal.map((lane) => ({
      corners: laneQuad(lane.x0, lane.z - half, lane.x1, lane.z + half),
      lift: 0,
    })),
    ...network.vertical.map((lane) => ({
      corners: laneQuad(lane.x - half, lane.z0, lane.x + half, lane.z1),
      lift: LIFT,
    })),
  ];
  const road = new THREE.Mesh(flatGeometry(roadQuads), roadMaterial);
  road.rotation.x = -Math.PI / 2;
  road.position.y = ROAD_Y;
  road.receiveShadow = true;
  road.name = 'road';
  scene.add(road);

  // The base is a flat square over the middle of the plate, and the road crosses under it: two of the
  // twenty lanes run into it, one along each axis, so it is entered from all four sides.
  const baseHalf = network.baseHalf;
  const base = new THREE.Mesh(
    flatGeometry([
      { corners: laneQuad(-baseHalf, -baseHalf, baseHalf, baseHalf), lift: 2 * LIFT },
    ]),
    baseMaterial,
  );
  base.rotation.x = -Math.PI / 2;
  base.position.y = ROAD_Y;
  base.receiveShadow = true;
  base.name = 'base';
  scene.add(base);

  const roadSegments: RoadSegment[] = [
    ...network.horizontal.map((lane) => ({
      ax: lane.x0, az: lane.z, bx: lane.x1, bz: lane.z, length: Math.abs(lane.x1 - lane.x0),
    })),
    ...network.vertical.map((lane) => ({
      ax: lane.x, az: lane.z0, bx: lane.x, bz: lane.z1, length: Math.abs(lane.z1 - lane.z0),
    })),
  ];
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

  // The plate is the whole of the ground, so its four corners are the whole of what the frame has to
  // hold: what the reading in the page was measuring before was the open cells of a cut raster, and the
  // cut is gone with the rock it was cut from.
  const plateHalfX = config.map.width / 2;
  const plateHalfZ = config.map.depth / 2;

  return {
    roadHalfWidth: half,
    baseHalf,
    routeLength,
    routeSegmentCount: roadSegments.length,
    roadPolylines: roadSegments.map((segment) => [[segment.ax, segment.az], [segment.bx, segment.bz]]),
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
// already fifty-seven thousand cells; this draws about ninety strokes and reads the same snapshot
// the frame it sits inside is reading. It holds no state of its own: every mark on it is either a
// fact about the map, which comes from `config` and from the road polylines above, or a fact about
// this instant, which comes out of the snapshot handed in. A minimap with its own copy of the wave is
// a minimap that is wrong a frame after the board is right.
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
  roadPolylines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): MinimapPresentation => {
  const context = canvas.getContext('2d');
  const half = Math.max(config.map.width, config.map.depth) / 2;
  const baseHalf = trainingRoadNetwork.baseHalf;
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

  const polyline = (points: ReadonlyArray<readonly [number, number]>): void => {
    if (points.length === 0) {
      return;
    }
    context!.beginPath();
    context!.moveTo(toX(points[0][0]), toY(points[0][1]));
    for (let index = 1; index < points.length; index += 1) {
      context!.lineTo(toX(points[index][0]), toY(points[index][1]));
    }
    context!.stroke();
  };

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

      // The road is drawn twice: a wide dark pass for the channel and a narrow lit pass down its
      // middle, which is the same read the board gives — a lit line in a dark trench — at two pixels
      // wide. One pass at one width reads as a hairline, and a hairline on a map is a wire.
      context.lineCap = 'round';
      context.lineJoin = 'round';
      for (const [width, color] of [[Math.max(3, size * 1.6), MINIMAP_ROAD], [Math.max(1, size * 0.5), MINIMAP_ROAD_CORE]] as const) {
        context.strokeStyle = color;
        context.lineWidth = width;
        for (const points of roadPolylines) {
          polyline(points);
        }
      }

      // The base is the one thing on the plate the road leads to, and it is a square here for the same
      // reason it is a square there.
      context.strokeStyle = MINIMAP_BASE;
      context.lineWidth = Math.max(1, size * 0.35);
      context.strokeRect(
        toX(-baseHalf),
        toY(-baseHalf),
        baseHalf * 2 * unit(),
        baseHalf * 2 * unit(),
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