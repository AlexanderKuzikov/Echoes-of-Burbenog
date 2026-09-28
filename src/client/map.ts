import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { trainingCorridor } from '../game-core/scenario.ts';
import type { BayDefinition } from '../game-core/scenario.ts';
import type { MatchConfig, MatchSnapshot } from '../game-core/index.ts';
import { withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The contour, the core chamber and the build pads.
//
// The road is one closed ring plus four approaches, and the massif is everything the road and the
// niches do not occupy. Both come out of a single raster, so a wall cannot land on the road and a
// niche cannot end up walled in — one cut, one truth, and the geometry the player looks at is the
// geometry the map is. The old plane and its grid are gone with it: on an open field every spot was
// worth the same, and the channel is what makes a spot worth something.
// ---------------------------------------------------------------------------------------------

export type PadView = {
  id: string;
  base: THREE.Mesh;
  ring: THREE.Mesh;
  occupied: boolean;
  errorUntil: number;
};

// Height classes by distance into the rock, and nothing else. An earlier version also asked which
// side of the channel a cell was on relative to the viewer and kept the near bank low, which is a
// nice picture from exactly one angle and a wall across the road from every other. Terraces keyed to
// depth alone are symmetric, so the map can be turned all the way round and the road stays readable
// — and the ramp is steep enough that a terrace never stands tall enough to hide the road it borders.
export const WALL_HEIGHTS = [0.34, 0.68, 1.4, 1.95] as const;

type RoadSegment = { ax: number; az: number; bx: number; bz: number; length: number };

type WallRect = { minX: number; minZ: number; width: number; depth: number; heightClass: number };

// What the map answers about itself. The camera, the renderer and the debug seam live in the page, so
// everything they need from here arrives through this one surface instead of a variable they had to
// reach into. `elapsed` is passed in rather than kept: it is one presentation clock for the whole
// page, and a second copy of it inside two modules is how a pad flash and a shot trace end up
// disagreeing about when they started.
export type MapPresentation = {
  roadHalfWidth: number;
  routeLength: number;
  routeSegmentCount: number;
  wallBlockCount: number;
  openCells: Uint8Array;
  bayCount: number;
  chamberRadius: number;
  corridorSamplePoints: Array<[number, number]>;
  distanceToRoad: (x: number, z: number) => number;
  corridorCoverage: (x: number, z: number, range: number) => number;
  pickTargets: THREE.Object3D[];
  padCount: () => number;
  applySnapshot: (next: MatchSnapshot, elapsed: number) => void;
  animate: (elapsed: number, ambientDelta: number) => void;
  flashPadError: (padId: string, elapsed: number) => void;
  flashCoreDamage: (elapsed: number) => void;
  resetCoreDamage: () => void;
  setReducedMotion: (reduced: boolean) => void;
};

export const createMap = (scene: THREE.Scene, config: MatchConfig): MapPresentation => {
  const ROAD_HALF_WIDTH = trainingCorridor.roadHalfWidth;
  // Declared before anything that draws: the lit edge of the road and the frame around a niche both have
  // to know where a niche is, and a helper used above the line it is written on is a runtime error, not
  // a compile error.
  const insideBay = (bay: BayDefinition, x: number, z: number): boolean =>
    x >= bay.minX && x <= bay.maxX && z >= bay.minZ && z <= bay.maxZ;

  // Four routes over one road. The contour is walked by all four and each approach by exactly one, and
  // that difference is what is drawn: taken route by route, the same road gets built four times over,
  // and a road built twice is a road two copies of which will eventually disagree at a corner. So a
  // segment is keyed by its two endpoints, drawn once, and told apart by how many routes contain it.
  // What the raster and the coverage measure is the same set — the road, not the four ways onto it.
  type Point = { x: number; z: number };
  const pointKey = (x: number, z: number): string => `${x},${z}`;
  const segmentKey = (from: Point, to: Point): string => {
    const head = pointKey(from.x, from.z);
    const tail = pointKey(to.x, to.z);
    return head < tail ? `${head}>${tail}` : `${tail}>${head}`;
  };
  // Routes, not passes. A circuit walks its own approach out and back, so it passes that approach twice
  // inside the one route that owns it, and a count of passes called it shared with the ring: the ring
  // then drew as a broken line reaching past the map's edge, and no approach drew at all. A route is one
  // owner however many times it walks over a segment, so each route contributes a set, not a tally.
  const routeCount = new Map<string, number>();
  for (const route of config.map.routes) {
    const ownSegments = new Set<string>();
    for (let index = 1; index < route.points.length; index += 1) {
      ownSegments.add(segmentKey(route.points[index - 1], route.points[index]));
    }
    for (const own of ownSegments) {
      routeCount.set(own, (routeCount.get(own) ?? 0) + 1);
    }
  }

  const roadSegments: RoadSegment[] = [];
  const contourSegments: RoadSegment[] = [];
  const counted = new Set<string>();
  for (const route of config.map.routes) {
    for (let index = 1; index < route.points.length; index += 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      const key = segmentKey(start, end);
      if (counted.has(key)) {
        continue;
      }
      counted.add(key);
      const segment: RoadSegment = {
        ax: start.x,
        az: start.z,
        bx: end.x,
        bz: end.z,
        length: Math.hypot(end.x - start.x, end.z - start.z),
      };
      roadSegments.push(segment);
      if ((routeCount.get(key) ?? 0) > 1) {
        contourSegments.push(segment);
      }
    }
  }
  const routeSegmentCount = roadSegments.length;
  const routeLength = roadSegments.reduce((total, segment) => total + segment.length, 0);

  // The contour arrives as a graph, not as a list: the four routes hand it over starting at four
  // different corners, so the loop is recovered by following endpoints instead of by trusting one
  // route's order. An approach is already in travel order and is simply cut where the shared part
  // starts. Both halves come out of the route lists and nothing else, so the picture cannot say a
  // road the core does not have.
  const roadDraws: Array<{ name: string; points: Point[] }> = [];
  if (contourSegments.length > 1) {
    const contourPoints: Point[] = [{ x: contourSegments[0].ax, z: contourSegments[0].az }];
    const walked = new Set<number>();
    let current = contourPoints[0];
    for (;;) {
      const next = contourSegments.findIndex((segment, index) => {
        if (walked.has(index)) {
          return false;
        }
        return (segment.ax === current.x && segment.az === current.z)
          || (segment.bx === current.x && segment.bz === current.z);
      });
      if (next < 0) {
        break;
      }
      const segment = contourSegments[next];
      walked.add(next);
      current = segment.ax === current.x && segment.az === current.z
        ? { x: segment.bx, z: segment.bz }
        : { x: segment.ax, z: segment.az };
      contourPoints.push(current);
      if (current.x === contourPoints[0].x && current.z === contourPoints[0].z) {
        break;
      }
    }
    roadDraws.push({ name: 'contour:burrow-cross', points: contourPoints });
  }
  for (const route of config.map.routes) {
    const points: Point[] = [route.points[0]];
    for (let index = 1; index < route.points.length; index += 1) {
      if ((routeCount.get(segmentKey(route.points[index - 1], route.points[index])) ?? 0) !== 1) {
        break;
      }
      points.push(route.points[index]);
    }
    if (points.length > 1) {
      roadDraws.push({ name: `route:${route.id}`, points });
    }
  }

  const distanceToSegment = (px: number, pz: number, segment: RoadSegment): number => {
    const deltaX = segment.bx - segment.ax;
    const deltaZ = segment.bz - segment.az;
    const lengthSquared = deltaX * deltaX + deltaZ * deltaZ;
    const along =
      lengthSquared <= 0
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

  // How much road a spot sees at a given tower range. This is the currency the map is designed in, so
  // it is measured the way a tower shoots: against the ribbon, not against the niche it stands in.
  // Sampling the polyline keeps it honest for any range without a closed-form circle/segment clip.
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

  // The road as a closed ribbon: each leg offset sideways, the corners mitred, left side forward and
  // right side back. A box per leg would leave a notch at every turn and overlap at every other one —
  // a road that has to be read as a road cannot be built out of pieces that do not meet.
  const toShapePoint = (x: number, z: number): THREE.Vector2 => new THREE.Vector2(x, -z);

  type EdgePoint = readonly [x: number, z: number];

  // Both borders of the ribbon in world coordinates and in travel order. The road bed and the lit band
  // that outlines it are two reads of one offset, so the offset is computed once: a second copy of this
  // mitre would eventually disagree with the first at a corner, and a corner is the one place the player
  // reads a turn from.
  const offsetEdges = (
    points: readonly { x: number; z: number }[],
    offset: number,
  ): { left: EdgePoint[]; right: EdgePoint[] } => {
    const left: EdgePoint[] = [];
    const right: EdgePoint[] = [];
    for (let index = 0; index < points.length; index += 1) {
      const point = points[index];
      const isFirst = index === 0;
      const isLast = index === points.length - 1;
      const previous = points[Math.max(0, index - 1)];
      const next = points[Math.min(points.length - 1, index + 1)];
      const inX = point.x - previous.x;
      const inZ = point.z - previous.z;
      const inLength = Math.hypot(inX, inZ) || 1;
      const outX = next.x - point.x;
      const outZ = next.z - point.z;
      const outLength = Math.hypot(outX, outZ) || 1;
      const normalX = -inZ / inLength;
      const normalZ = inX / inLength;
      const outNormalX = -outZ / outLength;
      const outNormalZ = outX / outLength;
      // An end has one leg, not two, so it gets that leg's normal and nothing to mitre against: the
      // spawn end uses the leg leaving it, the core end the leg arriving at it. Averaging a leg with a
      // zero-length one is how a gate ends up a unit and a half past the spawn, or a NaN in the shape.
      const miterX = isFirst ? outNormalX : isLast ? normalX : normalX + outNormalX;
      const miterZ = isFirst ? outNormalZ : isLast ? normalZ : normalZ + outNormalZ;
      const miterLength = Math.hypot(miterX, miterZ);
      const reach = isFirst || isLast
        ? offset
        : offset / Math.max(0.4, (miterX * normalX + miterZ * normalZ) / miterLength);
      // Clamped, because a hairpin would otherwise send the corner to infinity and a spike is not a
      // turn. Two and a half widths is past any turn a corridor map has.
      const clamped = Math.max(-Math.abs(offset) * 2.5, Math.min(Math.abs(offset) * 2.5, reach));
      left.push([point.x + (miterX / miterLength) * clamped, point.z + (miterZ / miterLength) * clamped]);
      right.push([point.x - (miterX / miterLength) * clamped, point.z - (miterZ / miterLength) * clamped]);
    }
    return { left, right };
  };

  const offsetRibbon = (points: readonly { x: number; z: number }[], offset: number): THREE.Vector2[] => {
    const { left, right } = offsetEdges(points, offset);
    return [
      ...left.map(([x, z]) => toShapePoint(x, z)),
      ...right.map(([x, z]) => toShapePoint(x, z)).reverse(),
    ];
  };

  // Flat bands as raw quads, in the shape space the road and the floors are already drawn in: local x is
  // world x, local y is world -z, and local z is the height above the plane the mesh is laid on. A
  // shape with a hole is the other way to draw a frame, and a frame that has to break where a niche
  // opens onto the road is not a hole in anything. Every attribute a merged `ShapeGeometry` carries is
  // declared here too, because `mergeGeometries` refuses a set that differs.
  type FlatQuad = readonly [a: EdgePoint, b: EdgePoint, c: EdgePoint, d: EdgePoint];

  const flatQuads = (height: number, quads: readonly FlatQuad[]): THREE.BufferGeometry => {
    const positions = new Float32Array(quads.length * 6 * 3);
    const normals = new Float32Array(quads.length * 6 * 3);
    const uvs = new Float32Array(quads.length * 6 * 2);
    let cursor = 0;
    const put = ([x, z]: EdgePoint): void => {
      positions[cursor * 3] = x;
      positions[cursor * 3 + 1] = -z;
      positions[cursor * 3 + 2] = height;
      normals[cursor * 3 + 2] = 1;
      uvs[cursor * 2] = x;
      uvs[cursor * 2 + 1] = z;
      cursor += 1;
    };
    for (const [a, b, c, d] of quads) {
      put(a);
      put(b);
      put(c);
      put(a);
      put(c);
      put(d);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    // Indexed even though the index says nothing: `ShapeGeometry` next to it is indexed, and a merge
    // that mixes the two forms refuses the whole set rather than the one geometry that differs.
    geometry.setIndex(Array.from({ length: quads.length * 6 }, (_, vertex) => vertex));
    return geometry;
  };

  // Merges parts that each need their own slot in a material list, and returns the geometry. The list
  // is a mesh property and the assignment is a geometry one, so the two are tied together here once:
  // `mergeGeometries` numbers its groups by input geometry, and a mesh with two materials wants them
  // numbered by slot. Left as it comes, the fortieth block asks a two-entry array for material number
  // thirty-nine, and both the renderer and the pick ray read `undefined` out of it.
  const mergeBySlot = (parts: THREE.BufferGeometry[], slots: number[]): THREE.BufferGeometry | null => {
    if (parts.length === 0) {
      return null;
    }
    const merged = mergeGeometries(parts, true);
    for (const part of parts) {
      part.dispose();
    }
    if (!merged) {
      return null;
    }
    merged.groups.forEach((group, index) => {
      group.materialIndex = slots[index];
    });
    return merged;
  };

  // The bed of the channel and the lip that outlines it are two values of one idea, and the picture is
  // built on the difference between them: a dark floor with a lit edge reads as a trench that turns,
  // where one flat bright slab reads as a stripe until the player has to guess where it goes.
  const pathMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({
      color: 0x214b56,
      emissive: 0x0c2b31,
      emissiveIntensity: 0.7,
      roughness: 0.88,
      side: THREE.DoubleSide,
    }),
    'path',
  );
  const pathEdgeMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({
      color: 0x2f9d92,
      emissive: 0x1a6d67,
      emissiveIntensity: 0.8,
      roughness: 0.5,
      metalness: 0.1,
      side: THREE.DoubleSide,
    }),
    'path',
  );
  const PATH_Y = 0.08;
  const PATH_EDGE_WIDTH = 0.17;
  const PATH_EDGE_Y = PATH_Y + 0.012;
  for (const walk of roadDraws) {
    const ribbon = new THREE.Shape(offsetRibbon(walk.points, ROAD_HALF_WIDTH));
    // The lit band runs inside the border, so it can never be swallowed by a terrace it did not measure.
    // It breaks where a niche opens onto the road, because a lit line across a niche mouth would seal
    // the one opening the player is looking for, and where the road enters the core chamber, because
    // the channel is supposed to end in the well rather than run into its wall.
    const outer = offsetEdges(walk.points, ROAD_HALF_WIDTH);
    const inner = offsetEdges(walk.points, ROAD_HALF_WIDTH - PATH_EDGE_WIDTH);
    const edgeQuads: FlatQuad[] = [];
    for (const side of ['left', 'right'] as const) {
      const border = outer[side];
      const inboard = inner[side];
      for (let index = 0; index + 1 < border.length; index += 1) {
        const quad: FlatQuad = [border[index], border[index + 1], inboard[index + 1], inboard[index]];
        const middleX = (quad[0][0] + quad[2][0]) / 2;
        const middleZ = (quad[0][1] + quad[2][1]) / 2;
        if (trainingCorridor.bays.some((bay) => insideBay(bay, middleX, middleZ))) {
          continue;
        }
        if (Math.hypot(middleX - trainingCorridor.coreChamber.x, middleZ - trainingCorridor.coreChamber.z)
          <= trainingCorridor.coreChamber.radius) {
          continue;
        }
        edgeQuads.push(quad);
      }
    }
    const road = new THREE.Mesh(
      mergeBySlot(
        [new THREE.ShapeGeometry(ribbon), flatQuads(PATH_EDGE_Y - PATH_Y, edgeQuads)],
        [0, 1],
      ) as THREE.BufferGeometry,
      [pathMaterial, pathEdgeMaterial],
    );
    road.rotation.x = -Math.PI / 2;
    road.position.y = PATH_Y;
    road.receiveShadow = true;
    road.name = walk.name;
    scene.add(road);
  }

  // The raster. Cells whose centre is within half a road of the polyline, inside a niche, or inside
  // the core chamber are open; everything else is rock. Both the road and the niche rectangles are
  // authored on the same 0.4 lattice, so "a niche one cell away from the road" and "a niche opening
  // onto it" are two states this code can actually tell apart instead of two intentions.
  const CELL_SIZE = 0.4;
  const rasterColumns = Math.round(config.map.width / CELL_SIZE);
  const rasterRows = Math.round(config.map.depth / CELL_SIZE);
  const cellCenterX = (column: number): number => -config.map.width / 2 + (column + 0.5) * CELL_SIZE;
  const cellCenterZ = (row: number): number => -config.map.depth / 2 + (row + 0.5) * CELL_SIZE;
  const cellIndex = (column: number, row: number): number => row * rasterColumns + column;

  const openCells = new Uint8Array(rasterColumns * rasterRows);
  // Every open cell, as a point to frame. The fit used to measure the rectangle around the corridor,
  // which is mostly rock: fitting that meant either cropping the road or pushing the camera so far back
  // that the road became a stamp. The channel itself is what has to be on screen, and the rock behind
  // it is allowed to run off the edges.
  const corridorSamplePoints: Array<[number, number]> = [];
  for (const point of config.map.routes.flatMap((route) => route.points)) {
    corridorSamplePoints.push([point.x, point.z]);
  }

  for (let row = 0; row < rasterRows; row += 1) {
    for (let column = 0; column < rasterColumns; column += 1) {
      const x = cellCenterX(column);
      const z = cellCenterZ(row);
      let open = distanceToRoad(x, z) <= ROAD_HALF_WIDTH + 1e-6;
      if (!open && trainingCorridor.bays.some((bay) => insideBay(bay, x, z))) {
        open = true;
      }
      if (!open) {
        const chamber = trainingCorridor.coreChamber;
        open = Math.hypot(x - chamber.x, z - chamber.z) <= chamber.radius;
      }
      openCells[cellIndex(column, row)] = open ? 1 : 0;
      if (open) {
        corridorSamplePoints.push([x, z]);
      }
    }
  }

  // Distance to the open area, by breadth-first search from every open cell at once. The queue is
  // walked with a moving index and not with `pop()`: a stack gives a depth-first order, and a
  // depth-first distance field is not a distance field — the cells near the far end of the first seed
  // get the depth of the detour that reached them, which turns "how deep into the rock is this" into
  // "which seed did the walker start from".
  const openDistance = new Int32Array(rasterColumns * rasterRows).fill(-1);
  const frontier: number[] = [];
  for (let index = 0; index < openCells.length; index += 1) {
    if (openCells[index] === 1) {
      openDistance[index] = 0;
      frontier.push(index);
    }
  }
  for (let cursor = 0; cursor < frontier.length; cursor += 1) {
    const index = frontier[cursor];
    const column = index % rasterColumns;
    const row = (index - column) / rasterColumns;
    const neighbours: Array<[number, number]> = [
      [column - 1, row],
      [column + 1, row],
      [column, row - 1],
      [column, row + 1],
    ];
    for (const [nextColumn, nextRow] of neighbours) {
      if (nextColumn < 0 || nextColumn >= rasterColumns || nextRow < 0 || nextRow >= rasterRows) {
        continue;
      }
      const next = cellIndex(nextColumn, nextRow);
      if (openCells[next] === 1 || openDistance[next] >= 0) {
        continue;
      }
      openDistance[next] = openDistance[index] + 1;
      frontier.push(next);
    }
  }

  const wallHeightClass = (index: number): number => {
    const distance = openDistance[index];
    if (distance <= 1) {
      return 0;
    }
    if (distance <= 3) {
      return 1;
    }
    return distance <= 6 ? 2 : 3;
  };

  const wallRects: WallRect[] = [];
  const claimedCells = new Uint8Array(rasterColumns * rasterRows);
  for (let row = 0; row < rasterRows; row += 1) {
    for (let column = 0; column < rasterColumns; column += 1) {
      const index = cellIndex(column, row);
      if (openCells[index] === 1 || claimedCells[index] === 1) {
        continue;
      }
      const heightClass = wallHeightClass(index);
      const sameCell = (checkColumn: number, checkRow: number): boolean => {
        const check = cellIndex(checkColumn, checkRow);
        return openCells[check] === 0 && claimedCells[check] === 0 && wallHeightClass(check) === heightClass;
      };
      let width = 1;
      while (column + width < rasterColumns && sameCell(column + width, row)) {
        width += 1;
      }
      let depth = 1;
      let grow = true;
      while (grow && row + depth < rasterRows) {
        for (let step = 0; step < width; step += 1) {
          if (!sameCell(column + step, row + depth)) {
            grow = false;
            break;
          }
        }
        if (grow) {
          depth += 1;
        }
      }
      for (let stepRow = 0; stepRow < depth; stepRow += 1) {
        for (let stepColumn = 0; stepColumn < width; stepColumn += 1) {
          claimedCells[cellIndex(column + stepColumn, row + stepRow)] = 1;
        }
      }
      wallRects.push({
        minX: cellCenterX(column) - CELL_SIZE / 2,
        minZ: cellCenterZ(row) - CELL_SIZE / 2,
        width: width * CELL_SIZE,
        depth: depth * CELL_SIZE,
        heightClass,
      });
    }
  }

  // Stone says three things at once: how deep into the rock a terrace stands, how much of the light
  // that falls in the channel reaches it, and which face is turned to the sky. The height class owns
  // the first two — a value ramp that goes out from the lit lip into the dark mass, which is the reason
  // a player can follow the channel with their eye instead of counting steps — and the per-vertex shade
  // owns the third. All of it rides in the colour attribute, so four terraces that do not look alike are
  // three materials between them rather than four, and the frame costs 7 programs against 6.
  //
  // The lip is the only part of the rock that glows on its own: it is the edge the player reads the
  // corridor by. The bank above it and the mass behind that do not, or there would be no ramp to read.
  const stoneTone: ReadonlyArray<readonly [number, number, number]> = [
    [1.16, 1.08, 0.96],
    [0.9, 0.93, 0.99],
    [0.72, 0.77, 0.87],
    [0.55, 0.61, 0.75],
  ];
  const FACE_TOP = 1;
  const FACE_EDGE = 1.34;
  const FACE_FOOT = 0.44;
  const FACE_UNDER = 0.28;
  const stoneBase = { color: 0x2a4450, vertexColors: true, roughness: 0.88, metalness: 0.1 };
  const wallLipMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ ...stoneBase, emissive: 0x0d272c, emissiveIntensity: 0.55 }),
    'ground',
  );
  const wallBankMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ ...stoneBase, roughness: 0.9 }),
    'ground',
  );
  const wallMassMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ ...stoneBase, roughness: 0.94, metalness: 0.06 }),
    'ground',
  );

  // One terrace block, shaded by hand. A box has two rows of side vertices, so the foot of every face and
  // its top edge are two values and the quad between them is the gradient: dark where the wall meets the
  // ground, bright along the edge it presents to the sky. That edge line is the one cue that separates two
  // terraces of the same colour, and unlike a chamfer it holds from every angle, because the key light is
  // fixed while the stand turns.
  const stoneBlock = (rect: WallRect): THREE.BufferGeometry => {
    const height = WALL_HEIGHTS[rect.heightClass];
    const box = new THREE.BoxGeometry(rect.width, height, rect.depth);
    box.translate(rect.minX + rect.width / 2, height / 2, rect.minZ + rect.depth / 2);
    const [toneR, toneG, toneB] = stoneTone[rect.heightClass];
    const position = box.getAttribute('position');
    const normal = box.getAttribute('normal');
    const shade = new Float32Array(position.count * 3);
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const normalY = normal.getY(vertex);
      const scale = normalY > 0.5
        ? FACE_TOP
        : normalY < -0.5
          ? FACE_UNDER
          : position.getY(vertex) > height * 0.5
            ? FACE_EDGE
            : FACE_FOOT;
      shade[vertex * 3] = toneR * scale;
      shade[vertex * 3 + 1] = toneG * scale;
      shade[vertex * 3 + 2] = toneB * scale;
    }
    box.setAttribute('color', new THREE.BufferAttribute(shade, 3));
    return box;
  };

  // Every rect of a height class becomes one box, the boxes of a class become one geometry, and the
  // classes of a mesh are merged again in the order the mesh was given so each lands in its own slot of
  // the material list. The meshes also go into the pick list, because rock in front of a niche is rock
  // in the way of a click.
  //
  // The class-then-mesh order is the whole trick: in three a group is a draw call, so a massif merged
  // with one group per box pays for itself in calls to carry a colour that already rides in the vertex
  // attribute — measured on the same frame, 367 calls against 33, before the classes were merged first.
  const wallPickTargets: THREE.Mesh[] = [];

  const buildWallGroup = (
    name: string,
    materials: THREE.Material[],
    classes: readonly number[],
  ): number => {
    const perClass: THREE.BufferGeometry[] = [];
    let blocks = 0;
    for (const heightClass of classes) {
      const parts: THREE.BufferGeometry[] = [];
      for (const rect of wallRects) {
        if (rect.heightClass === heightClass) {
          parts.push(stoneBlock(rect));
        }
      }
      if (parts.length === 0) {
        continue;
      }
      blocks += parts.length;
      const classGeometry = mergeGeometries(parts);
      for (const part of parts) {
        part.dispose();
      }
      if (classGeometry) {
        perClass.push(classGeometry);
      }
    }
    const merged = materials.length === 1
      ? mergeGeometries(perClass)
      : mergeBySlot(perClass, perClass.map((_, index) => index));
    for (const geometry of perClass) {
      geometry.dispose();
    }
    if (!merged) {
      return 0;
    }
    const mesh = new THREE.Mesh(merged, materials.length === 1 ? materials[0] : materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    wallPickTargets.push(mesh);
    return blocks;
  };

  const wallBlockCount = buildWallGroup('massif:low', [wallLipMaterial, wallBankMaterial], [0, 1]);
  buildWallGroup('massif:high', [wallMassMaterial], [2, 3]);

  // Niche floors, the frame marked into each of them, and the core chamber. The floor is darker than
  // the road on purpose: a recess in shadow with a lit slot inside it is a room, while a recess in the
  // same value as the road is a widening the road happens to have. The frame is the part that carries
  // the promise — this ground is for a tower, and it is the only marking on the map that says so.
  const NICHE_FLOOR_Y = 0.05;
  const NICHE_FRAME_Y = 0.075;
  const bayFloorMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x0d2129, emissive: 0x06171c, emissiveIntensity: 0.6, roughness: 0.9 }),
    'ground',
  );
  const bayFrameMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x3aa39d, emissive: 0x1a6b68, emissiveIntensity: 1, roughness: 0.55 }),
    'ground',
  );
  const chamberFloorMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x173a44, emissive: 0x0a262e, emissiveIntensity: 0.8, roughness: 0.86 }),
    'ground',
  );
  // The base mark is the only marking on the map that is not teal, and that is the whole of its job:
  // the teal family says "this ground is yours", and the road's mouth is the one piece of ground that
  // is not. Ember rather than red on purpose — red is the refusal colour, and nothing here is a refusal.
  const baseMarkMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x8a4a2e, emissive: 0x53200f, emissiveIntensity: 0.95, roughness: 0.72 }),
    'ground',
  );
  const bayFloorParts: THREE.BufferGeometry[] = [];
  const frameQuads: FlatQuad[] = [];
  for (const bay of trainingCorridor.bays) {
    const shape = new THREE.Shape([
      toShapePoint(bay.minX, bay.minZ),
      toShapePoint(bay.maxX, bay.minZ),
      toShapePoint(bay.maxX, bay.maxZ),
      toShapePoint(bay.minX, bay.maxZ),
    ]);
    bayFloorParts.push(new THREE.ShapeGeometry(shape));
    // As wide as the niche can spare: a bay is cut to hold a pad, so anything narrower than the frame
    // would put the marking under the pad it is marking. A two-unit court has a quarter of a unit of
    // floor outside the pad in it, and that is what the frame is drawn on.
    const frameWidth = Math.min(0.12, Math.max(0.06, (Math.min(bay.maxX - bay.minX, bay.maxZ - bay.minZ) - 1.5) / 4));
    const inset = 0.05;
    const lowX = bay.minX + inset;
    const highX = bay.maxX - inset;
    const lowZ = bay.minZ + inset;
    const highZ = bay.maxZ - inset;
    frameQuads.push(
      [[lowX, lowZ], [highX, lowZ], [highX, lowZ + frameWidth], [lowX, lowZ + frameWidth]],
      [[lowX, highZ - frameWidth], [highX, highZ - frameWidth], [highX, highZ], [lowX, highZ]],
      [[lowX, lowZ], [lowX + frameWidth, lowZ], [lowX + frameWidth, highZ], [lowX, highZ]],
      [[highX - frameWidth, lowZ], [highX, lowZ], [highX, highZ], [highX - frameWidth, highZ]],
    );
  }
  // The chamber wears two rings instead of a frame: it is the end of the channel, and a circle says
  // "well" where a rectangle says "slot". Both are fractions of the chamber's own radius, so a wider
  // well is a different number in `trainingCorridor` and not four numbers here to re-derive. The outer
  // ring is the rim of the well and the inner one stops at the foot of the plinth, so the crystal
  // stands in a marked circle instead of on bare floor.
  const chamberRings: FlatQuad[] = [];
  for (const [inner, outer] of [[0.775, 0.925], [0.6125, 0.675]] as const) {
    const innerRadius = inner * trainingCorridor.coreChamber.radius;
    const outerRadius = outer * trainingCorridor.coreChamber.radius;
    const steps = 28;
    for (let step = 0; step < steps; step += 1) {
      const from = (step / steps) * Math.PI * 2;
      const to = ((step + 1) / steps) * Math.PI * 2;
      const at = (radius: number, angle: number): EdgePoint => [
        trainingCorridor.coreChamber.x + Math.cos(angle) * radius,
        trainingCorridor.coreChamber.z + Math.sin(angle) * radius,
      ];
      chamberRings.push([at(innerRadius, from), at(outerRadius, from), at(outerRadius, to), at(innerRadius, to)]);
    }
  }
  // Each base gets a mark of its own, and it is the one thing this map needs that the corridor did
  // not: four quarters that the player can point at. Twelve identical pads around one ring read as
  // one plate with twelve sockets, and nothing on the ground says where any of the four comes in. A
  // bracket either side of the road's mouth and one tick pointing out of the map say it without a
  // word — and it is drawn in a colder stone than the teal that means "build here", because a mark in
  // the build colour at a spot with no pad on it sends the player looking for something that is not
  // there. The brackets are set outside the road's half width, so the road never covers them.
  const baseMarkQuads: FlatQuad[] = [];
  const BASE_MARK_INNER = 1;
  const BASE_MARK_OUTER = 1.14;
  const BASE_MARK_ARC = (100 * Math.PI) / 180;
  const BASE_MARK_STEPS = 12;
  for (const route of config.map.routes) {
    const base = route.points[0];
    const next = route.points[1];
    if (!base || !next) {
      continue;
    }
    const roadLength = Math.hypot(next.x - base.x, next.z - base.z) || 1;
    const alongX = (next.x - base.x) / roadLength;
    const alongZ = (next.z - base.z) / roadLength;
    const outwardLength = Math.hypot(base.x, base.z) || 1;
    const outwardX = base.x / outwardLength;
    const outwardZ = base.z / outwardLength;
    // Angles measured from the direction the road leaves in: the brackets sit across it, and the tick
    // sits on the far side, so the three marks read as one arrow pointing into the map.
    const heading = Math.atan2(alongZ, alongX);
    const tick = Math.atan2(outwardZ, outwardX);
    const at = (radius: number, angle: number): EdgePoint => [
      base.x + Math.cos(angle) * radius,
      base.z + Math.sin(angle) * radius,
    ];
    for (const side of [Math.PI / 2, -Math.PI / 2]) {
      const middle = heading + side;
      for (let step = 0; step < BASE_MARK_STEPS; step += 1) {
        const from = middle - BASE_MARK_ARC / 2 + (step / BASE_MARK_STEPS) * BASE_MARK_ARC;
        const to = middle - BASE_MARK_ARC / 2 + ((step + 1) / BASE_MARK_STEPS) * BASE_MARK_ARC;
        baseMarkQuads.push([
          at(BASE_MARK_INNER, from), at(BASE_MARK_OUTER, from),
          at(BASE_MARK_OUTER, to), at(BASE_MARK_INNER, to),
        ]);
      }
    }
    const tickWidth = 0.16;
    const tickFrom = 1.42;
    const tickTo = 1.86;
    baseMarkQuads.push([
      at(tickFrom, tick - tickWidth), at(tickTo, tick - tickWidth),
      at(tickTo, tick + tickWidth), at(tickFrom, tick + tickWidth),
    ]);
  }
  // One geometry per material, merged again per slot: four draw calls for every marking on the ground,
  // and a group per bay would have cost one per bay plus one per ring segment.
  const bayFloors = new THREE.Mesh(
    mergeBySlot(
      [
        mergeGeometries(bayFloorParts) as THREE.BufferGeometry,
        flatQuads(NICHE_FRAME_Y - NICHE_FLOOR_Y, [...frameQuads, ...chamberRings]),
        new THREE.CircleGeometry(trainingCorridor.coreChamber.radius, 24),
        flatQuads(NICHE_FRAME_Y - NICHE_FLOOR_Y, baseMarkQuads),
      ],
      [0, 1, 2, 3],
    ) as THREE.BufferGeometry,
    [bayFloorMaterial, bayFrameMaterial, chamberFloorMaterial, baseMarkMaterial],
  );
  for (const part of bayFloorParts) {
    part.dispose();
  }
  bayFloors.rotation.x = -Math.PI / 2;
  bayFloors.position.y = NICHE_FLOOR_Y;
  bayFloors.receiveShadow = true;
  bayFloors.name = 'niche-floors';
  scene.add(bayFloors);

  // The pad is the one place on the map that is lit on purpose, and it is lit from above by hand: a
  // bright cap with the sides falling away reads as a socket waiting for something, where a uniformly
  // glowing hexagon reads as a puddle of the same colour as the road it stands off.
  const padGeometry = new THREE.CylinderGeometry(0.62, 0.72, 0.14, 6);
  const padShade = new Float32Array(padGeometry.getAttribute('position').count * 3);
  {
    const position = padGeometry.getAttribute('position');
    const normal = padGeometry.getAttribute('normal');
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      const normalY = normal.getY(vertex);
      const scale = normalY > 0.5 ? 1 : normalY < -0.5 ? 0.4 : position.getY(vertex) > 0 ? 1.18 : 0.5;
      padShade[vertex * 3] = scale;
      padShade[vertex * 3 + 1] = scale;
      padShade[vertex * 3 + 2] = scale;
    }
    padGeometry.setAttribute('color', new THREE.BufferAttribute(padShade, 3));
  }
  const padViews = new Map<string, PadView>();
  const padPickTargets: THREE.Mesh[] = [];
  for (const pad of config.map.buildPads) {
    const group = new THREE.Group();
    group.position.set(pad.position.x, 0, pad.position.z);
    group.name = `pad:${pad.id}`;

    const base = new THREE.Mesh(
      padGeometry,
      withProbeWeight(
        new THREE.MeshStandardMaterial({
          color: 0x2a8a82,
          emissive: 0x0c3f3c,
          emissiveIntensity: 0.78,
          roughness: 0.48,
          metalness: 0.18,
          vertexColors: true,
        }),
        'padBase',
      ),
    );
    base.position.y = 0.12;
    base.castShadow = true;
    base.receiveShadow = true;
    base.name = `pad-base:${pad.id}`;
    group.add(base);

    // The ring opens in the free state, because the free state is what the first frame has to say: a pad
    // that starts in a colour no state owns is a pad whose first change is a jump.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.8, 6),
      new THREE.MeshBasicMaterial({ color: 0x7cf0dc, transparent: true, opacity: 0.6, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.205;
    ring.name = `pad-ring:${pad.id}`;
    group.add(ring);

    base.userData.padId = pad.id;
    ring.userData.padId = pad.id;
    padPickTargets.push(base, ring);

    scene.add(group);
    padViews.set(pad.id, { id: pad.id, base, ring, occupied: false, errorUntil: 0 });
  }

  const core = new THREE.Group();
  core.position.set(config.map.corePosition.x, 0.3, config.map.corePosition.z);
  core.name = 'core';
  const coreBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.8, 0.95, 0.32, 8),
    withProbeWeight(
      // Dark on purpose: the crystal is the only thing in the chamber that is allowed to be bright, and a
      // pale plinth beside it competes with the one thing the player is defending.
      new THREE.MeshStandardMaterial({ color: 0x1c3b44, roughness: 0.34, metalness: 0.45 }),
      'coreBase',
    ),
  );
  coreBase.castShadow = true;
  core.add(coreBase);
  const coreCrystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.7, 1),
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: 0x7ce7d2,
        emissive: 0x2ac7b5,
        emissiveIntensity: 1.8,
        roughness: 0.16,
        metalness: 0.22,
      }),
      'coreCrystal',
    ),
  );
  coreCrystal.position.y = 1.05;
  coreCrystal.castShadow = true;
  core.add(coreCrystal);
  const coreRing = new THREE.Mesh(
    new THREE.TorusGeometry(1.05, 0.035, 8, 36),
    new THREE.MeshBasicMaterial({ color: 0x6ee2cf, transparent: true, opacity: 0.62 }),
  );
  coreRing.rotation.x = Math.PI / 2;
  coreRing.position.y = 0.24;
  core.add(coreRing);
  scene.add(core);

  // Motes, sampled along the road instead of spread over a rectangle: what drifts across the frame is
  // then the channel itself, and the last leg of it — the one that carries the eye to the core — carries
  // motes too. Their phase is accumulated from the frame delta rather than read off the clock, so
  // reduced motion freezes them where they are and the same tick always draws the same picture.
  const MOTE_COUNT = 54;
  const moteBase = new Float32Array(MOTE_COUNT * 3);
  const moteSeeds: Array<{ sway: number; lift: number; speed: number; phase: number }> = [];
  {
    const cumulative: number[] = [0];
    for (const segment of roadSegments) {
      cumulative.push(cumulative[cumulative.length - 1] + segment.length);
    }
    for (let index = 0; index < MOTE_COUNT; index += 1) {
      const wanted = ((index + 0.5) / MOTE_COUNT) * routeLength;
      let leg = 0;
      while (leg < roadSegments.length - 1 && cumulative[leg + 1] < wanted) {
        leg += 1;
      }
      const segment = roadSegments[leg];
      const span = cumulative[leg + 1] - cumulative[leg];
      const along = span <= 0 ? 0 : (wanted - cumulative[leg]) / span;
      const across = (((index * 37) % 11) / 10 - 0.5) * ROAD_HALF_WIDTH * 1.7;
      const tangentX = segment.length <= 0 ? 1 : (segment.bx - segment.ax) / segment.length;
      const tangentZ = segment.length <= 0 ? 0 : (segment.bz - segment.az) / segment.length;
      moteBase[index * 3] = segment.ax + (segment.bx - segment.ax) * along - tangentZ * across;
      moteBase[index * 3 + 1] = 0.3 + ((index * 7) % 11) * 0.075;
      moteBase[index * 3 + 2] = segment.az + (segment.bz - segment.az) * along + tangentX * across;
      moteSeeds.push({
        sway: 0.12 + ((index * 5) % 7) * 0.03,
        lift: 0.1 + ((index * 3) % 5) * 0.04,
        speed: 0.24 + ((index * 11) % 9) * 0.06,
        phase: (index * 1.7) % (Math.PI * 2),
      });
    }
  }
  const particles = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x7cf0dc, size: 0.05, transparent: true, opacity: 0.5, depthWrite: false }),
  );
  const particlePositions = new Float32Array(MOTE_COUNT * 3);
  particlePositions.set(moteBase);
  const particleAttribute = new THREE.BufferAttribute(particlePositions, 3);
  particles.geometry.setAttribute('position', particleAttribute);
  scene.add(particles);

  const padFreeColor = new THREE.Color(0x2a8a82);
  const padFreeEmissive = new THREE.Color(0x0c3f3c);
  const padOccupiedColor = new THREE.Color(0x2c3a42);
  const padOccupiedEmissive = new THREE.Color(0x0a171b);
  const padFreeRing = new THREE.Color(0x7cf0dc);
  const padOccupiedRing = new THREE.Color(0xffc56b);
  const padErrorEmissive = new THREE.Color(0x6e1a12);
  const padErrorRing = new THREE.Color(0xff6f61);
  const padErrorColor = new THREE.Color(0x8a2a20);
  const coreHealthy = new THREE.Color(0x2ac7b5);
  const coreHealthyRing = new THREE.Color(0x6ee2cf);
  const coreFailing = new THREE.Color(0xe46c62);
  const coreWarningRing = new THREE.Color(0xffc56b);
  const padErrorFlashSeconds = 0.7;
  const coreDamageFlashSeconds = 0.6;

  let coreDefeated = false;
  let coreDamagedUntil = 0;
  let reducedMotion = false;
  let motePhase = 0;

  // Three states, and the picture has to answer "may I build here" before the player reads a word of the
  // dock. Free is the only lit thing in the niche, taken is a dark socket with a tired ring, and a
  // refusal is the only red on the map — the one colour nothing else in the scene is allowed to wear.
  const refreshPadStyle = (padView: PadView, elapsed: number) => {
    const flashing = elapsed < padView.errorUntil;
    const baseMaterial = padView.base.material as THREE.MeshStandardMaterial;
    const ringMaterial = padView.ring.material as THREE.MeshBasicMaterial;
    baseMaterial.color.copy(flashing ? padErrorColor : padView.occupied ? padOccupiedColor : padFreeColor);
    baseMaterial.emissive.copy(flashing ? padErrorEmissive : padView.occupied ? padOccupiedEmissive : padFreeEmissive);
    baseMaterial.emissiveIntensity = flashing ? 1.45 : padView.occupied ? 0.35 : 0.78;
    ringMaterial.color.copy(flashing ? padErrorRing : padView.occupied ? padOccupiedRing : padFreeRing);
    ringMaterial.opacity = flashing ? 1 : padView.occupied ? 0.5 : 0.6;
  };

  return {
    roadHalfWidth: ROAD_HALF_WIDTH,
    routeLength,
    routeSegmentCount,
    wallBlockCount,
    openCells,
    bayCount: trainingCorridor.bays.length,
    chamberRadius: trainingCorridor.coreChamber.radius,
    corridorSamplePoints,
    distanceToRoad,
    corridorCoverage,
    pickTargets: [...padPickTargets, ...wallPickTargets],
    padCount: () => padViews.size,
    applySnapshot: (next: MatchSnapshot, elapsed: number) => {
      for (const padView of padViews.values()) {
        const occupant = next.pads[padView.id];
        const occupied = occupant !== null && occupant !== undefined;
        if (occupied === padView.occupied) {
          continue;
        }
        padView.occupied = occupied;
        refreshPadStyle(padView, elapsed);
      }

      const integrity = next.maxCoreHealth > 0 ? next.coreHealth / next.maxCoreHealth : 0;
      coreCrystal.material.emissiveIntensity = 0.6 + 1.5 * integrity;
      const defeated = next.status === 'defeat';
      if (defeated !== coreDefeated) {
        coreDefeated = defeated;
        coreCrystal.material.emissive.copy(defeated ? coreFailing : coreHealthy);
      }
    },
    animate: (elapsed: number, ambientDelta: number) => {
      for (const padView of padViews.values()) {
        if (padView.errorUntil > 0 && elapsed >= padView.errorUntil) {
          padView.errorUntil = 0;
          refreshPadStyle(padView, elapsed);
        }
      }
      // The terminal state wins over the transient damage pulse, and reduced motion keeps
      // the readable colour change without the scale pulse.
      const coreFlashing = elapsed < coreDamagedUntil && !coreDefeated;
      coreRing.material.color.copy(coreFlashing ? coreWarningRing : coreDefeated ? coreFailing : coreHealthyRing);
      const corePulse = coreFlashing && !reducedMotion ? 1 + 0.18 * (1 - (coreDamagedUntil - elapsed) / coreDamageFlashSeconds) : 1;
      coreRing.scale.setScalar(corePulse);
      coreCrystal.rotation.y += ambientDelta * 0.6;
      coreRing.rotation.z += ambientDelta * 0.25;
      motePhase += ambientDelta;
      for (let index = 0; index < MOTE_COUNT; index += 1) {
        const seed = moteSeeds[index];
        const wave = Math.sin(motePhase * seed.speed + seed.phase);
        const drift = Math.cos(motePhase * seed.speed * 0.7 + seed.phase);
        particlePositions[index * 3] = moteBase[index * 3] + drift * seed.sway;
        particlePositions[index * 3 + 1] = moteBase[index * 3 + 1] + wave * seed.lift;
        particlePositions[index * 3 + 2] = moteBase[index * 3 + 2] + wave * seed.sway * 0.5;
      }
      particleAttribute.needsUpdate = true;
    },
    flashPadError: (padId: string, elapsed: number) => {
      const padView = padViews.get(padId);
      if (padView) {
        padView.errorUntil = elapsed + padErrorFlashSeconds;
        refreshPadStyle(padView, elapsed);
      }
    },
    flashCoreDamage: (elapsed: number) => {
      coreDamagedUntil = elapsed + coreDamageFlashSeconds;
    },
    resetCoreDamage: () => {
      coreDamagedUntil = 0;
    },
    setReducedMotion: (reduced: boolean) => {
      reducedMotion = reduced;
    },
  };
};
