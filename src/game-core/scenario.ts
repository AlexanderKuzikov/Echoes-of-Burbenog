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

// Reaches are 2.8, 2.4 and 3.1 on the forty-unit map, which is 2.9% and 2.5% of its width. On a
// ninety-six unit map those are a torch, not a tower, so all three move out. Pulse Spire is the reach
// the whole layout is pinned to and 4.05 is not a round number: a niche's coverage is
// `2 * sqrt(range^2 - setback^2)`, the deepest niches stand 4.0 off the road and the closest 1.2, and
// the factor of five this map was built for solves to `range <= 4.09` with `range > 4.0`. There is
// exactly one reachable reach in that window.
//
// The other two are placed either side of it and the asymmetry is the point. Frost Relay is longer,
// so it is the tower for the deep niches — and the tower that can still barely reach the worst niche
// is always the one with the *smallest* spread, because `sqrt(range^2 - setback^2)` flattens as range
// grows, so the factor of five belongs to Pulse Spire and not to Frost Relay, and no arrangement of
// reaches gives all three of them a factor of five at once. Grove Lens is shorter and is the tower
// for the ring; it sees nothing at all on the niches from 3.6 out, which is nine of the forty-four and
// is named here rather than left for a player to pay for.
const trainingTowers: TowerDefinition[] = [
  {
    id: 'pulse-spire',
    name: 'Pulse Spire',
    cost: 50,
    range: 4.05,
    damage: 18,
    attackIntervalTicks: 8,
    targets: ['ground'],
  },
  {
    id: 'grove-lens',
    name: 'Grove Lens',
    cost: 70,
    range: 3.6,
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
    range: 4.8,
    damage: 7,
    attackIntervalTicks: 10,
    targets: ['ground'],
    slowFactor: 0.5,
    slowDurationTicks: 16,
  },
];

// The lap grew from 104 to 360, and at the old 0.78 units a second a husk needed seven and a half
// minutes to walk it — which is not a wave, it is a queue. Speeds are multiplied by eighteen so the
// slowest thing on the map crosses it in twenty-five and a half seconds and the fastest in thirteen
// and a half.
//
// This is one constant in this file and it is the only honest place to put it: the numbers it scales
// live in `contact.ts`, which is frozen for this task. It also happens to be safe on its own, because
// spawn spacing in that file is `speed * interval / 20` — scaling speed widens the gap between two
// enemies from 0.5 units to 9.0 rather than closing it, and a wave spread over 360 units of road
// should not be packed. The next task owns the economy and the waves and should move the numbers
// themselves; leaving this line in place after that is the only thing to check.
const ENEMY_ROUTE_SPEED_SCALE = 18;

// ---------------------------------------------------------------------------------------------
// burrow-vault: a square road along the perimeter of a ninety-six unit map, a throat down each axis
// to a well in the middle, and forty-four niches that are not copies of each other.
//
// The map before this one was forty by forty with one ring of half-size 9.4 inside it. Measured, it
// said four things at once: the four quarters were identical, the sum of every niche's coverage was
// 49.63 units of road against a lap of 104, a third of the lap was walk no niche could see at all,
// and the best spot was worth twice the worst. Twelve copies of one decision is not a decision, and
// the player was choosing between four identical districts.
//
// Four numbers carry the whole layout, and all four are chosen so that every road line, every niche
// centre and every niche edge lands on a cell centre or a cell boundary of the 0.4 raster. A road line
// through cell centres carves exactly three cells across, which is exactly the 1.2-wide ribbon drawn
// over it, and a niche edge on a boundary is carved by exactly the cells it is drawn over. That is the
// whole of what "a niche one cell away from the road" means, and it is the reason the two are states
// this code can tell apart instead of two intentions.
//
// The route is given, not searched. A wave leaves its own corner, walks the perimeter past the other
// three, turns in on the far half of the fourth side without reaching the corner it started from, and
// goes straight down the axis to the well. Every wave therefore covers three quarters of the ring and
// one throat, and a wave from one corner never sees the side that corner sits on — which is the
// property the four identical quarters used to destroy. The route is a lap and not a path to the
// core: the last point is the well, and `circuit` walks it again from the mouth.
// ---------------------------------------------------------------------------------------------

const MAP_SIZE = 96;

// The ring is the perimeter, as near to the edge of the map as the raster allows: a road line through
// cell centres sits on a cell centre, and 45.0 is the largest such value that still leaves three cells
// carved on the inside and six cells of rock outside. Everything the four routes share is this square.
const RING_HALF = 45;
const CORE_CHAMBER_RADIUS = 4;

// One quarter turn. Every quarter of the map — the route, the eleven niches and the road they sit on
// — is this one operation applied to the north-east corner, so the four of them cannot drift apart by
// a rounding step.
const turn = (point: Vec2): Vec2 => ({ x: -point.z, z: point.x });
const turned = (point: Vec2, times: number): Vec2 => {
  let out = point;
  for (let step = 0; step < times; step += 1) {
    out = turn(out);
  }
  return out;
};

// The base route, walked from the north-east corner: the whole east side, the whole south side, the
// whole west side, the near half of the north side, and then straight down the middle to the well.
// Seven and a half sides of ring at ninety units each is 315, and the throat is 45, so a lap is 360 —
// 3.46 times the 104 it replaces, and inside the 330..420 the layout was asked for.
//
// The turn-inward point is the midpoint of the fourth side rather than any point on it, and that one
// choice is what makes the map readable: it puts each throat exactly on an axis, so the four throats
// run in a cross into the well and each route is a quarter turn from the next. A throat off the axis
// would give the same length and a picture with nothing to say where the waves are.
const baseRoute: Vec2[] = [
  { x: RING_HALF, z: RING_HALF },
  { x: RING_HALF, z: -RING_HALF },
  { x: -RING_HALF, z: -RING_HALF },
  { x: -RING_HALF, z: RING_HALF },
  { x: 0, z: RING_HALF },
  { x: 0, z: 0 },
];

// Each base is named for the side of the map it leaves by, so the four ids are four entrances rather
// than four labels: the north-east base leaves along the east side, the south-west one along the north
// side, and so on round. `turns` is how many quarter turns from the route above.
const trainingRoutes: RouteDefinition[] = [
  { id: 'burrow-east', turns: 0 },
  { id: 'burrow-north', turns: 1 },
  { id: 'burrow-west', turns: 2 },
  { id: 'burrow-south', turns: 3 },
].map((entry) => ({
  id: entry.id,
  circuit: true,
  points: baseRoute.map((point) => turned(point, entry.turns)),
}));

// Forty-four niches, and the only thing that separates them is how much road they can see.
//
// Coverage is the currency this map is designed in, and it is measured the way a tower shoots:
// against the road, over the whole road at once, because the player does not know which side the wave
// will come from. A niche's coverage is a chord of the reach — `2 * sqrt(range^2 - setback^2)` — and
// that single fact decides how spread out the niches have to be. The layout before this one had
// twelve niches at two distinct values, 5.28 and 2.64, a factor of two, and the player picked one of
// twelve copies. A factor of five is a different map: it means the worst niche is worth a fifth of
// the best, which on this raster is only reachable if the deepest niches sit at almost exactly the
// long tower's reach — four units out — and the closest sit one and a fifth units out. The setback
// ladder below runs 1.2 to 4.0 in steps of 0.4 because those are the only values a niche centre can
// take: the ring line sits on 45.0, a niche centre has to sit on a cell centre, and the two together
// leave 1.2, 1.6, 2.0 and so on and nothing between.
//
// The ladder is not decoration, and two of its ends are load-bearing. The best niches are the four
// where a throat meets the ring: they are 1.2 from two legs at once instead of one, so they see
// roughly double anything else on the map, and they are the only spots a player can find twice the
// value for. The worst are the ones at 4.0, deep enough that Frost Relay — the longest reach here —
// still sees only a sliver of road and Grove Lens, the only tower that shoots at the air, sees none
// at all. That is a real cost and it is named rather than smoothed over: a player who builds Grove
// Lens on one of the deep niches has bought a tower that does nothing to the air that arrives from
// the seventh wave. It is the same trade the previous map had in reverse, and it is a decision
// instead of a copy.
//
// Everything between the ends is filled by walking the road, not by drawing a grid. Twenty-four
// niches sit along the ring, six per side, spaced 13.2 apart and held clear of the corner and of the
// axis so that neither the throat-corner niches nor the throat niches collide with them. Sixteen more
// sit along the throats, four per throat, alternating sides, and the four throat corners close the set
// at forty-four.
const NICHE_SETBACKS = [1.2, 1.6, 2, 2, 2.4, 2.4, 2.8, 3.2, 3.6, 4] as const;
const NICHE_HALF = 1;

// Along the east side of the base quarter, the six ring niches. The bays are two units wide, so two of
// them need four units between their centres: the 5.6 left at the corner and the 11.8 left at the axis
// are what keeps this list from colliding with the throat corner and with the first throat niche.
const RING_SLOTS = [39.4, 26.2, 13, -13, -26.2, -39.4] as const;
// Down the throat of the base quarter, the four. Eight and a half units apart, and the side alternates
// so that no two bays ever share a column.
const THROAT_SLOTS = [38.6, 30.2, 21.8, 13.4] as const;
// The setback each successive niche takes off the road, in ladder order and starting at `offset`, so
// that the forty-four walk the whole ladder instead of the first six rungs of it. A quarter that used
// only its own six would leave 3.2 and 3.6 unused, and the two rungs in the middle are the ones that
// decide whether Grove Lens still sees the wave it is sold against.
const setbackFor = (index: number): number =>
  NICHE_SETBACKS[(index + Math.floor(index / NICHE_SETBACKS.length)) % NICHE_SETBACKS.length];

const baseQuarterPads = (turns: number): Array<{ role: string; position: Vec2 }> => {
  const pads: Array<{ role: string; position: Vec2 }> = [];
  RING_SLOTS.forEach((along, index) => {
    pads.push({
      role: `ring-${index + 1}`,
      position: { x: RING_HALF - setbackFor(turns * 7 + index), z: along },
    });
  });
  // The throat corner, one step and a fifth from both the ring side and the throat. The best money on
  // the map, and the only spot that is close to two legs at once.
  pads.push({ role: 'gate', position: { x: -NICHE_SETBACKS[0], z: RING_HALF - NICHE_SETBACKS[0] } });
  THROAT_SLOTS.forEach((down, index) => {
    const step = setbackFor(turns * 7 + index);
    pads.push({
      role: `throat-${index + 1}`,
      position: { x: (index % 2 === 0 ? -1 : 1) * step, z: down },
    });
  });
  return pads;
};

// In turn order, so a niche and its name cannot be separated from the rotation that produced it.
const QUARTERS = ['ne', 'sw', 'nw', 'se'] as const;

const trainingPads: BuildPadDefinition[] = QUARTERS.flatMap((quarter, turns) =>
  baseQuarterPads(turns).map((pad) => ({
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
// `NICHE_HALF` is declared with the ladder above, because the ladder is what places the centres and a
// court size that lived apart from them would be one more number to re-derive by hand.

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
    id: 'burrow-vault',
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
    enemies: trainingEnemies.map((enemy) => ({
      ...enemy,
      speed: Math.round(enemy.speed * ENEMY_ROUTE_SPEED_SCALE * 100) / 100,
    })),
    waves: trainingWaves,
    rules,
  };
}
