import type {
  BuildPadDefinition,
  MapDefinition,
  MatchConfig,
  MatchRules,
  RouteDefinition,
  TowerDefinition,
  Vec2,
} from './types.ts';
import { trainingEnemies, trainingWaves } from './contact.ts';

const trainingTowers: TowerDefinition[] = [
  {
    id: 'pulse-spire',
    name: 'Pulse Spire',
    cost: 50,
    range: 2.8,
    damage: 18,
    attackIntervalTicks: 8,
    targets: ['ground'],
  },
  {
    id: 'grove-lens',
    name: 'Grove Lens',
    cost: 70,
    range: 2.4,
    damage: 10,
    attackIntervalTicks: 12,
    targets: ['ground', 'air'],
    slowFactor: 0.65,
    slowDurationTicks: 12,
    splashRadius: 1.1,
  },
  {
    id: 'frost-relay',
    name: 'Frost Relay',
    cost: 60,
    range: 3.1,
    damage: 7,
    attackIntervalTicks: 10,
    targets: ['ground'],
    slowFactor: 0.5,
    slowDurationTicks: 16,
  },
];

// ---------------------------------------------------------------------------------------------
// burrow-cross: four bases in the four corners, one closed contour, a well in the middle.
//
// The old map was a single corridor of twenty-six units ending in a dead end. It had one honest
// question to ask — which of five niches sees the most road — and this one asks the same question
// twelve times: a base is a corner, the enemy leaves it along the map's edge, joins the contour and
// then laps it forever, so nothing is ever "behind" the wave and a leak is a lap paid for, not the
// end of the run.
//
// Three numbers carry the whole layout, and all three are chosen so that every road line, every niche
// centre and every niche edge lands on a cell centre or a cell boundary of the 0.4 raster. A road line
// through cell centres carves exactly three cells across, which is exactly the 1.2-wide ribbon drawn
// over it, and a niche edge on a boundary is carved by exactly the cells it is drawn over. That is the
// whole of what "a niche one cell away from the road" means, and it is the reason the two are states
// this code can tell apart instead of two intentions.
// ---------------------------------------------------------------------------------------------

const MAP_SIZE = 40;

// The contour: a square ring of half-size 9.4, and the four corners it is entered from. The bases sit
// at 16.6 on the diagonals, which is where each of them turns once off the map's edge and runs
// *along* the ring's own side into its corner. An approach that met the ring across its side would be
// a cross of two coplanar ribbons in the same spot; an approach that arrives along the side is one
// road with a corner in it, and the corner it enters at is where the lap is paid for.
const RING_HALF = 9.4;
const BASE_CORNER = 16.6;
const CORE_CHAMBER_RADIUS = 2.4;

// One quarter turn. Every quarter of the map — the route, the three niches and the ring segment they
// sit on — is this one operation applied to the north-east corner, so the four of them cannot drift
// apart by a rounding step.
const turn = (point: Vec2): Vec2 => ({ x: -point.z, z: point.x });
const turned = (point: Vec2, times: number): Vec2 => {
  let out = point;
  for (let step = 0; step < times; step += 1) {
    out = turn(out);
  }
  return out;
};

// The base route, walked from the north-east corner: in along the map's east edge, a turn onto the
// ring, once round it, and back down the same approach to the gate it came in by. The last point
// repeats the first, and that repeat is what closes the loop: a circuit whose end is not its start
// does not end, it leaps. With the approach walked in both directions the lap is 104.0 — 75.2 of ring,
// 14.4 of approach each way — and the enemy arrives at the gate on its feet, pays a leak for the lap
// and starts again from the mouth. An earlier version of this list stopped at the ring corner, which
// left a 10.2 gap to the gate: the route was 89.6 long, looked closed, and moved the enemy across ten
// units of open ground in a single tick, once per lap, per enemy.
const gateRoute: Vec2[] = [
  { x: BASE_CORNER, z: BASE_CORNER },
  { x: BASE_CORNER, z: RING_HALF },
  { x: RING_HALF, z: RING_HALF },
  { x: RING_HALF, z: -RING_HALF },
  { x: -RING_HALF, z: -RING_HALF },
  { x: -RING_HALF, z: RING_HALF },
  { x: RING_HALF, z: RING_HALF },
  { x: BASE_CORNER, z: RING_HALF },
  { x: BASE_CORNER, z: BASE_CORNER },
];

// Each base is named for the side of the map its approach runs along, so the four ids are four
// entrances rather than four labels: the north-east base comes in along the east edge, the south-west
// one along the north edge, and so on round. `turns` is how many quarter turns from the route above.
const trainingRoutes: RouteDefinition[] = [
  { id: 'burrow-east', turns: 0 },
  { id: 'burrow-north', turns: 1 },
  { id: 'burrow-west', turns: 2 },
  { id: 'burrow-south', turns: 3 },
].map((entry) => ({
  id: entry.id,
  circuit: true,
  points: gateRoute.map((point) => turned(point, entry.turns)),
}));

// Three niches per quarter, and the quarter itself is mirror-symmetric about its own diagonal: the
// gate niche sits on the diagonal, the two flanks are each other's reflection. That is what makes the
// twelve read as four identical districts instead of twelve unrelated spots, and it is why there is
// one niche on the diagonal rather than a pair straddling it — the road is already on that line.
//
// What separates the niches is coverage, and it is not equal. It is also not the ranking this comment
// used to claim. Coverage is measured the way a tower shoots — against the ribbon, over the whole road
// at once, because the player does not know which side the wave comes from — and under that measure a
// niche covering its own approach is worth barely more than one covering none of it: a spot that sees
// only the leg it stands on pays for the same tower as a spot that sees the whole ring.
//
// The gate used to stand at (11, 11), outside the ring's corner, where it saw 3.90 of its own approach
// and 1.39 of each of the two ring sides leaving that corner, and nothing else. The flanks stand 2.0
// out and see one ring side each and nothing else — 3.95 at Pulse's reach against the gate's 5.30 then,
// and worth twice as much summed over the four routes, 15.80 against 9.50. So the flanks were the
// stronger pair and this comment was wrong, not merely badly argued.
//
// The gate then stood at (7, 7): the same diagonal, inside the corner, where it sees both ring sides
// leaving that corner and none of the approach at all. It bought the rank the design wanted — 5.70
// against 3.95 at Pulse's reach — with coverage instead of position, and it kept the mirror symmetry,
// because (7, 7) reflects to itself under the quarter's own diagonal exactly as (11, 11) did. But the
// ring is 2.4 from (7, 7) and Grove Lens reaches 2.4, so the gate saw *nothing* at Grove's range, and
// Grove Lens is the one tower here that shoots at the air. A spot that is the best money on the map
// and is blind to a third of what comes is not a strong spot, it is a promise the geometry does not
// keep, and the player has no way to see the difference before paying for it.
//
// It stands at (7.4, 7.4) now, and four tenths along the diagonal is the whole of the fix: 2.0 to the
// road instead of 2.4, so Grove Lens sees 5.30, Pulse 7.90 and Frost 9.20 — the best place on the map
// at all three reaches, not only at the long ones, and exactly twice what the flank is worth at
// Grove's. The lattice is what makes that move legal and the half-step illegal: 7.4 is a cell centre
// and 6.4..8.4 are cell boundaries, so the court is still exactly the five cells it is drawn over. At
// 7.2 the court's own edge lands on a cell centre, and the rock is then cut by cells the floor is not
// drawn on; at 7.6 the same court comes out thirty-six cells wide in one quarter and thirty in two
// others, and four identical districts stop being identical.
//
// What the move costs is the lip, and it is named here rather than left for the player to find. Two
// cells of rock stood between (7, 7) and the road; one stands now — the same single cell and the same
// 2.0 of road distance the eight flanks have carried all along. That is the argument for it: the map
// ends up with one rule for a niche near the road instead of two, and the flanks are eight courts that
// already read correctly at exactly that distance. The position that would have merged the court into
// the road outright is 7.6, and 7.6 is not on the lattice either.
//
// The corner spot this map could otherwise have had — the bend of the approach sees both of its legs
// at once and is the best place on the map — still has no mirror image anywhere, so it remains the one
// thing a three-niche quarter cannot hold while its four quarters stay reflections of each other.
const northQuarterPads: Array<{ role: string; position: Vec2 }> = [
  { role: 'gate', position: { x: 7.4, z: 7.4 } },
  { role: 'flank-a', position: { x: 11.4, z: 4.2 } },
  { role: 'flank-b', position: { x: 4.2, z: 11.4 } },
];

// In turn order, so a niche and its name cannot be separated from the rotation that produced it.
const QUARTERS = ['ne', 'sw', 'nw', 'se'] as const;

const trainingPads: BuildPadDefinition[] = QUARTERS.flatMap((quarter, turns) =>
  northQuarterPads.map((pad) => ({
    id: `niche-${quarter}-${pad.role}`,
    position: turned(pad.position, turns),
  })),
);

// Carving geometry for the presentation layer. It is deliberately not part of `MapDefinition`: the
// simulation never asks where a wall is, and a field it ignores is a field the core would have to
// validate for nothing. Bays are given in world coordinates on the same 0.4 grid the road uses, so
// a bay that touches the road band opens onto it and a bay a cell away keeps a lip of rock between.
export type BayDefinition = {
  id: string;
  padId: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};

export type CorridorDefinition = {
  roadHalfWidth: number;
  coreChamber: { x: number; z: number; radius: number };
  bays: BayDefinition[];
};

// Every niche is the same size, and it is the size that keeps two promises at once: five cells across
// is the smallest court that still leaves the marking on its floor clear of the pad standing in it,
// and a court whose edges land on cell boundaries is carved by exactly the cells it is drawn over —
// a bay edge through the middle of a cell leaves a sliver of open ground with nothing on it.
const NICHE_HALF = 1;

export const trainingCorridor: CorridorDefinition = {
  roadHalfWidth: 0.6,
  coreChamber: { x: 0, z: 0, radius: CORE_CHAMBER_RADIUS },
  bays: trainingPads.map((pad) => ({
    id: `bay-${pad.id.slice('niche-'.length)}`,
    padId: pad.id,
    minX: pad.position.x - NICHE_HALF,
    maxX: pad.position.x + NICHE_HALF,
    minZ: pad.position.z - NICHE_HALF,
    maxZ: pad.position.z + NICHE_HALF,
  })),
};

export function createTrainingScenario(): MatchConfig {
  const map: MapDefinition = {
    id: 'burrow-cross',
    width: MAP_SIZE,
    depth: MAP_SIZE,
    corePosition: { x: 0, z: 0 },
    coreHealth: 10,
    routes: trainingRoutes,
    buildPads: trainingPads,
  };
  const rules: MatchRules = {
    startingGold: 220,
    waveBounty: 35,
    repairAmount: 2,
  };

  return {
    seed: 1337,
    map,
    towers: trainingTowers,
    enemies: trainingEnemies,
    waves: trainingWaves,
    rules,
  };
}
