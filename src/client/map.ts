import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { trainingCorridor } from '../game-core/scenario.ts';
import type { BayDefinition } from '../game-core/scenario.ts';
import type { MatchConfig, MatchSnapshot } from '../game-core/index.ts';
import { withProbeWeight } from './shared.ts';

// ---------------------------------------------------------------------------------------------
// The corridor, the core chamber and the build pads.
//
// The road is one polyline and the massif is everything the road and the niches do not occupy.
// Both come out of a single raster, so a wall cannot land on the road and a niche cannot end up
// walled in — one cut, one truth, and the geometry the player looks at is the geometry the map is.
// The old plane and its grid are gone with it: on an open field every spot was worth the same, and
// the channel is what makes a spot worth something.
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

  const roadSegments: RoadSegment[] = [];
  for (const route of config.map.routes) {
    for (let index = 1; index < route.points.length; index += 1) {
      const start = route.points[index - 1];
      const end = route.points[index];
      roadSegments.push({
        ax: start.x,
        az: start.z,
        bx: end.x,
        bz: end.z,
        length: Math.hypot(end.x - start.x, end.z - start.z),
      });
    }
  }
  const routeSegmentCount = roadSegments.length;
  const routeLength = roadSegments.reduce((total, segment) => total + segment.length, 0);

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

  const offsetRibbon = (points: readonly { x: number; z: number }[], offset: number): THREE.Vector2[] => {
    const left: THREE.Vector2[] = [];
    const right: THREE.Vector2[] = [];
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
      left.push(toShapePoint(point.x + (miterX / miterLength) * clamped, point.z + (miterZ / miterLength) * clamped));
      right.push(toShapePoint(point.x - (miterX / miterLength) * clamped, point.z - (miterZ / miterLength) * clamped));
    }
    return [...left, ...right.reverse()];
  };

  const pathMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({
      color: 0x2e5c5c,
      emissive: 0x0c2425,
      emissiveIntensity: 0.65,
      roughness: 0.82,
      side: THREE.DoubleSide,
    }),
    'path',
  );
  const PATH_Y = 0.08;
  for (const route of config.map.routes) {
    const ribbon = new THREE.Shape(offsetRibbon(route.points, ROAD_HALF_WIDTH));
    const road = new THREE.Mesh(new THREE.ShapeGeometry(ribbon), pathMaterial);
    road.rotation.x = -Math.PI / 2;
    road.position.y = PATH_Y;
    road.receiveShadow = true;
    road.name = `route:${route.id}`;
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
  const insideBay = (bay: BayDefinition, x: number, z: number): boolean =>
    x >= bay.minX && x <= bay.maxX && z >= bay.minZ && z <= bay.maxZ;

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

  // The rim gets a faint self-glow because it is the edge the player reads the corridor by: a lip of
  // lit rock between the road and the mass behind it. The mass behind the rim does not, or the whole
  // map would glow.
  const wallLowMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({
      color: 0x24454f,
      emissive: 0x0a2126,
      emissiveIntensity: 0.55,
      roughness: 0.84,
      metalness: 0.12,
    }),
    'ground',
  );
  const wallHighMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x1a323a, roughness: 0.9, metalness: 0.08 }),
    'ground',
  );

  // Every rect of a height class becomes one box, and the boxes of a material become one mesh. A
  // carved massif of a few hundred cells costs two draw calls, not three hundred. The meshes also go
  // into the pick list, because rock in front of a niche is rock in the way of a click.
  const wallPickTargets: THREE.Mesh[] = [];

  const buildWallGroup = (name: string, material: THREE.Material, classes: readonly number[]): number => {
    const parts: THREE.BufferGeometry[] = [];
    for (const rect of wallRects) {
      if (!classes.includes(rect.heightClass)) {
        continue;
      }
      const height = WALL_HEIGHTS[rect.heightClass];
      const box = new THREE.BoxGeometry(rect.width, height, rect.depth);
      box.translate(rect.minX + rect.width / 2, height / 2, rect.minZ + rect.depth / 2);
      parts.push(box);
    }
    if (parts.length === 0) {
      return 0;
    }
    const merged = mergeGeometries(parts);
    for (const part of parts) {
      part.dispose();
    }
    if (!merged) {
      return 0;
    }
    const mesh = new THREE.Mesh(merged, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = name;
    scene.add(mesh);
    wallPickTargets.push(mesh);
    return parts.length;
  };

  const wallBlockCount = buildWallGroup('massif:low', wallLowMaterial, [0, 1]);
  buildWallGroup('massif:high', wallHighMaterial, [2, 3]);

  // Niche floors and the core chamber: the open ground a tower stands on, kept a shade apart from the
  // road so a recess reads as a recess and not as a widening the road happens to have.
  const bayFloorMaterial = withProbeWeight(
    new THREE.MeshStandardMaterial({ color: 0x11303a, emissive: 0x082024, emissiveIntensity: 0.7, roughness: 0.88 }),
    'ground',
  );
  const bayFloorParts: THREE.BufferGeometry[] = [];
  for (const bay of trainingCorridor.bays) {
    const shape = new THREE.Shape([
      toShapePoint(bay.minX, bay.minZ),
      toShapePoint(bay.maxX, bay.minZ),
      toShapePoint(bay.maxX, bay.maxZ),
      toShapePoint(bay.minX, bay.maxZ),
    ]);
    bayFloorParts.push(new THREE.ShapeGeometry(shape));
  }
  const chamberFloor = new THREE.CircleGeometry(trainingCorridor.coreChamber.radius, 24);
  bayFloorParts.push(chamberFloor);
  const bayFloors = new THREE.Mesh(mergeGeometries(bayFloorParts) as THREE.BufferGeometry, bayFloorMaterial);
  for (const part of bayFloorParts) {
    part.dispose();
  }
  bayFloors.rotation.x = -Math.PI / 2;
  bayFloors.position.y = 0.05;
  bayFloors.receiveShadow = true;
  bayFloors.name = 'niche-floors';
  scene.add(bayFloors);

  const padGeometry = new THREE.CylinderGeometry(0.62, 0.72, 0.14, 6);
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
          color: 0x2b7073,
          emissive: 0x0b3135,
          emissiveIntensity: 0.9,
          roughness: 0.48,
          metalness: 0.18,
        }),
        'padBase',
      ),
    );
    base.position.y = 0.12;
    base.castShadow = true;
    base.receiveShadow = true;
    base.name = `pad-base:${pad.id}`;
    group.add(base);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.8, 6),
      new THREE.MeshBasicMaterial({ color: 0x6ee2cf, transparent: true, opacity: 0.48, side: THREE.DoubleSide }),
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
      new THREE.MeshStandardMaterial({ color: 0x285a62, roughness: 0.38, metalness: 0.42 }),
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

  const particles = new THREE.Points(
    new THREE.BufferGeometry(),
    new THREE.PointsMaterial({ color: 0x6ee2cf, size: 0.045, transparent: true, opacity: 0.62 }),
  );
  const particlePositions = new Float32Array(54 * 3);
  for (let index = 0; index < 54; index += 1) {
    particlePositions[index * 3] = -5.4 + (index % 9) * 1.35;
    particlePositions[index * 3 + 1] = 0.35 + ((index * 7) % 11) * 0.08;
    particlePositions[index * 3 + 2] = -3.2 + ((index * 5) % 8) * 0.72;
  }
  particles.geometry.setAttribute('position', new THREE.BufferAttribute(particlePositions, 3));
  scene.add(particles);

  const padFreeColor = new THREE.Color(0x2b7073);
  const padFreeEmissive = new THREE.Color(0x0b3135);
  const padOccupiedColor = new THREE.Color(0x3a4b55);
  const padOccupiedEmissive = new THREE.Color(0x0a1a1e);
  const padFreeRing = new THREE.Color(0x6ee2cf);
  const padOccupiedRing = new THREE.Color(0xffc56b);
  const padErrorEmissive = new THREE.Color(0x5a1410);
  const padErrorRing = new THREE.Color(0xff6f61);
  const coreHealthy = new THREE.Color(0x2ac7b5);
  const coreHealthyRing = new THREE.Color(0x6ee2cf);
  const coreFailing = new THREE.Color(0xe46c62);
  const coreWarningRing = new THREE.Color(0xffc56b);
  const padErrorFlashSeconds = 0.7;
  const coreDamageFlashSeconds = 0.6;

  let coreDefeated = false;
  let coreDamagedUntil = 0;
  let reducedMotion = false;

  const refreshPadStyle = (padView: PadView, elapsed: number) => {
    const flashing = elapsed < padView.errorUntil;
    const baseMaterial = padView.base.material as THREE.MeshStandardMaterial;
    const ringMaterial = padView.ring.material as THREE.MeshBasicMaterial;
    baseMaterial.color.copy(padView.occupied ? padOccupiedColor : padFreeColor);
    baseMaterial.emissive.copy(flashing ? padErrorEmissive : padView.occupied ? padOccupiedEmissive : padFreeEmissive);
    baseMaterial.emissiveIntensity = flashing ? 1.3 : padView.occupied ? 0.4 : 0.9;
    ringMaterial.color.copy(flashing ? padErrorRing : padView.occupied ? padOccupiedRing : padFreeRing);
    ringMaterial.opacity = flashing ? 0.95 : padView.occupied ? 0.72 : 0.48;
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
      particles.rotation.y += ambientDelta * 0.08;
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
