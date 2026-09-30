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
    // The only tower that shoots at the air, and it has to be able to kill a Mote in the lap it walks.
    // Measured on the previous schedule: a Mote crosses Grove's 7.2 unit chord in eight ticks, so at
    // 10 damage every 12 it collected ten of its thirty hit points per tower it passed, and no board
    // of them killed one before the wave was four laps old — the only answer to air was a tax. Fourteen
    // every eight gives a Mote between one and two shots per crossing, which is twenty-eight of its
    // thirty against a single lens, and a mote dies on the first lap or not at all.
    damage: 14,
    attackIntervalTicks: 8,
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

// ---------------------------------------------------------------------------------------------
// Growth. A tower gets stronger for the kills it was part of, and nothing else about it changes.
//
// The whole mechanic is a curve and a counter, and both live here because every number that decides
// a match lives here. `simulation.ts` asks two questions — what level is this tower and what does its
// shot do — and holds no number of its own, so the curve cannot grow a second copy in the place that
// applies it.
//
// Four properties the curve has, each of them load-bearing:
//
//   * **Monotone.** More kills never costs damage. Nothing about a tower gets worse for being useful.
//   * **Continuous.** The damage multiplier is a piecewise-linear reading of the table, not a step at
//     the level boundary: a tower crossing from level 4 to 5 does not jump its damage, it stops
//     slowing down. A step would make the moment a tower levels a felt spike, and spikes are what a
//     player tunes around.
//   * **Diminishing.** Each kill adds less than the one before, and the table says so in its own
//     increments: 0.45 at the first step down to 0.16 at the last. Per kill *inside* a step the rate
//     falls further still, from 0.090 to 0.0047, because each step covers more kills than the last.
//   * **A plateau, not a ramp.** Level 10 is 3.57 and it is reached at 166 kills, and everything after
//     that is flat. A curve with no ceiling turns a long match into a runaway: ten minutes in, a
//     tower is several times what it was and the late waves stop being waves. The ceiling is what
//     makes placement a decision instead of a race — and it is why a tower put where the crowd walks
//     into it, which is credited for a share of a lot of kills, arrives at the ceiling well before one
//     standing at the edge of its reach does.
//
// Only damage grows. Reach, rate of fire, slow and splash radius are untouched, and that is a
// deliberate refusal: reach is the currency the map is designed in — the best niche is worth ten times
// the worst — and a reach that grows with kills would quietly reprice every one of those niches, in a
// direction that rewards the towers already standing on the good ones. If growing reach is wanted it
// is its own decision with its own numbers, and the cost named on this page.
export const TOWER_GROWTH_MAX_LEVEL = 10;

/**
 * Kills at which each level begins, index 0 being level 1. The gaps are 5, 7, 10, 14, 18, 22, 26, 30
 * and 34 kills: each level takes more kills than the one before, which is the plateau seen from the
 * other side. A kill is not always a whole point — one shared between towers is one point split — so a
 * tower in a busy place counts them slower than a tower that works alone, and the numbers below are
 * placed against what a full board actually collects rather than against the wave count.
 */
export const TOWER_GROWTH_KILL_STEPS: readonly number[] = [0, 5, 12, 22, 36, 54, 76, 102, 132, 166];

/** Damage multiplier of each of the ten levels, index 0 being level 1 and a tower nobody has helped. */
export const TOWER_GROWTH_DAMAGE_MULTIPLIERS: readonly number[] = [
  1, 1.45, 1.85, 2.2, 2.51, 2.78, 3.02, 3.23, 3.41, 3.57,
];

// One kill, one point, divided between the towers that hit it. Not a number that can be tuned away:
// the counter is whole kills because a player reads a kill count, and a counter that read "0.7 of a
// kill" would be a different thing to look at and a worse one.
const towerGrowthPointsPerKill = 1;

// The table is ten entries because the ceiling is ten, and both are checked here rather than at the
// point of use: a curve that grew a fourth row would be read as a level the game does not have.
if (TOWER_GROWTH_KILL_STEPS.length !== TOWER_GROWTH_MAX_LEVEL) {
  throw new Error(`Tower growth declares ${TOWER_GROWTH_KILL_STEPS.length} kill steps for ${TOWER_GROWTH_MAX_LEVEL} levels`);
}
if (TOWER_GROWTH_DAMAGE_MULTIPLIERS.length !== TOWER_GROWTH_MAX_LEVEL) {
  throw new Error(`Tower growth declares ${TOWER_GROWTH_DAMAGE_MULTIPLIERS.length} multipliers for ${TOWER_GROWTH_MAX_LEVEL} levels`);
}

/**
 * The growth level of a tower with this many kills. Counted, not searched: a tower at 5 kills is level
 * 2 and at 4 it is level 1, so the boundary belongs to the table and to nobody's rounding.
 */
export const towerGrowthLevel = (kills: number): number => {
  const total = Number.isFinite(kills) && kills > 0 ? kills : 0;
  let level = 1;
  for (let index = 0; index < TOWER_GROWTH_KILL_STEPS.length; index += 1) {
    if (total >= (TOWER_GROWTH_KILL_STEPS[index] as number)) {
      level = index + 1;
    }
  }
  return level;
};

/**
 * The damage multiplier of a tower with this many kills: the table read between the two levels it sits
 * between, and the ceiling once it is past the last one. Linear between the steps so the function is
 * continuous, and the two numbers that make it so are the only reason the levels and the curve are
 * kept apart — a level is what a tower is called, the multiplier is what its next shot does, and they
 * are two readings of one number rather than two numbers.
 */
export const towerDamageMultiplier = (kills: number): number => {
  const total = Number.isFinite(kills) && kills > 0 ? kills : 0;
  const lastIndex = TOWER_GROWTH_KILL_STEPS.length - 1;
  const ceiling = TOWER_GROWTH_KILL_STEPS[lastIndex] as number;
  if (total >= ceiling) {
    return TOWER_GROWTH_DAMAGE_MULTIPLIERS[lastIndex] as number;
  }
  for (let index = 0; index < lastIndex; index += 1) {
    const from = TOWER_GROWTH_KILL_STEPS[index] as number;
    const to = TOWER_GROWTH_KILL_STEPS[index + 1] as number;
    if (total < to) {
      const ratio = (total - from) / (to - from);
      const low = TOWER_GROWTH_DAMAGE_MULTIPLIERS[index] as number;
      return low + (TOWER_GROWTH_DAMAGE_MULTIPLIERS[index + 1] as number - low) * ratio;
    }
  }
  return TOWER_GROWTH_DAMAGE_MULTIPLIERS[0] as number;
};

export { towerGrowthPointsPerKill };

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
  // The wallet, and the only numbers in the match that are not about a specific enemy or a specific
  // wave. Kill rewards live with the roster in `contact.ts` and the wave schedule lives there too; what
  // is here is what a player starts with, what every wave pays them whether or not they killed
  // anything, and what the core is worth.
  //
  // `startingGold` is a board, not a nudge: 400 buys eight Pulse Spires, and a player who cannot
  // answer the first wave never gets to the economy at all. `waveBounty` is the guaranteed income and
  // the reason the economy is not a spiral — twelve waves of it is 600, and a player who kills nothing
  // still walks away with a board of eighteen towers. Kill rewards are on top of that floor and worth
  // about forty per cent more than it across a full sweep, so shooting well is worth having and
  // shooting badly is a poorer match rather than a different one.
  const rules: MatchRules = {
    startingGold: 400,
    waveBounty: 90,
    repairAmount: 2,
  };

  return {
    seed: 1337,
    map,
    towers: trainingTowers,
    // Speeds are the content's own. The lap is 360 units, so these are laps of 13.8 to 40 seconds: a
    // wave crosses the map in half a minute, and what decides whether it arrives is where the board
    // is, not how long the walk takes.
    enemies: trainingEnemies.map((enemy) => ({ ...enemy, tags: [...enemy.tags] })),
    waves: trainingWaves,
    rules,
  };
}
