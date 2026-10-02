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
// The map as the owner drew it: `docs/Map-and-Router.png`, kept in the repository as the source of
// truth for this geometry. Flat plate, one road network, one base in the middle, and nothing else.
// The plateau is gone: no raster, no massif, no terraces, no niches, no marked building spots. The
// whole of the previous map was rock cut away from a channel, and what is left of that idea here is
// the channel.
//
// **Where the numbers come from, so they can be checked instead of believed.** The drawing is 1241
// pixels square and holds four colours: green plate, grey road, dark base, white outside. The plate
// is the green rectangle at pixels 30..1209 by 31..1210, that is 1180 by 1180 of it, and its centre is
// (619.5, 620.5) — which is also the centre of the base square, measured the same way. Taking the
// plate as the ninety-six units the game already has puts one unit at 1180 / 96 = 12.2917 pixels, and
// every number below is `(pixel - centre) / 12.2917`. The twenty segments were read off the drawing by
// scanning it for runs of the road colour in both directions, and the road was measured at 58 pixels
// (4.72 units) and the base at 117 (9.52); the widths in this table are the owner's own — 4.8 and 9 —
// which is within two pixels of the drawing at this scale and is the design value rather than the
// measurement of a drawn rectangle.
//
// The one thing done to the table beyond the conversion is clamping four ends to the edge of the
// plate. The drawing runs its four entrances past the green into the white margin, because a road that
// stops inside the map is a road that goes nowhere; here the plate is 96 by 96 and there is nothing
// outside it to run over, so the same four ends sit on ±48 and the entrances leave the map exactly at
// its border. They are marked in the table.
//
// Axis `z` grows downwards, the same way it grows down the drawing.
// ---------------------------------------------------------------------------------------------

const MAP_SIZE = 96;

export type RoadNetworkDefinition = {
  roadHalfWidth: number;
  baseHalf: number;
  /** Lanes running along x, in the order they were read off the drawing. */
  horizontal: ReadonlyArray<{ z: number; x0: number; x1: number }>;
  /** Lanes running along z, likewise. */
  vertical: ReadonlyArray<{ x: number; z0: number; z1: number }>;
};

export const trainingRoadNetwork: RoadNetworkDefinition = {
  // 4.8 wide, so 2.4 to a side. It was 0.6 — the road grew fourfold and every coverage number the
  // old map was designed in moves with it.
  roadHalfWidth: 2.4,
  // The base is a 9 by 9 square on the origin, which is also where two lanes cross: one along z = 0
  // and one along x = 0, so the road comes into it from all four sides.
  baseHalf: 4.5,
  horizontal: [
    { z: -40.84, x0: -43.16, x1: -24.04 },
    { z: -40.84, x0: 24.12, x1: 43.24 },
    { z: -26.44, x0: -48, x1: 43.24 },        // west entrance, on the edge of the plate
    { z: -14.4, x0: -23.96, x1: 2.4 },
    { z: -0.08, x0: -16.72, x1: -4.76 },        // into the base from the west
    { z: -0.08, x0: 4.84, x1: 16.8 },           // out of the base to the east
    { z: 14.4, x0: -2.32, x1: 24.04 },
    { z: 26.4, x0: -43.16, x1: 48 },           // east entrance, on the edge of the plate
    { z: 40.84, x0: -43.16, x1: -23.96 },
    { z: 40.84, x0: 24.12, x1: 43.24 },
  ],
  vertical: [
    { x: -40.84, z0: -43.16, z1: -24.04 },
    { x: -40.84, z0: 24.12, z1: 43.24 },
    { x: -26.4, z0: -43.16, z1: 48 },           // south entrance, on the edge of the plate
    { x: -14.4, z0: -2.4, z1: 24.04 },
    { x: 0, z0: -16.72, z1: -4.76 },            // into the base from the north
    { x: 0, z0: 4.84, z1: 16.8 },               // out of the base to the south
    { x: 14.4, z0: -28.76, z1: 2.4 },
    { x: 26.44, z0: -48, z1: 43.24 },           // north entrance, on the edge of the plate
    { x: 40.84, z0: -43.16, z1: -24.04 },
    { x: 40.84, z0: 24.04, z1: 43.24 },
  ],
};

// ---------------------------------------------------------------------------------------------
// Routes and building spots: both of them belong to the next piece of work, and neither is invented
// here.
//
// **The routes are a stub and they are the old ones.** A wave names a route, `normalizeConfig` refuses
// a wave whose `routeId` is not in the map, and the match therefore cannot start without the four ids
// `burrow-east`, `burrow-north`, `burrow-west` and `burrow-south`. They are left exactly as they were
// — the ring around the old plateau, which no longer exists on this plate — because the honest version
// of "a wave walks the drawn network from its entrance to the base" is the routes task, and a guess
// here would be a route nobody asked for. The consequence is visible and is named in the report: until
// the routes land, a wave that starts walks a perimeter that is not on the plate.
//
// **There are no building spots.** The plate is flat and open, the drawing marks nothing on it, and the
// forty-four niches of the previous map are gone with the rock they were cut into. Placement on open
// ground is the work after this one, so an empty list is the state that matches the picture: with pads
// declared and nothing drawn, the debug seam would report forty-four places a tower can go and none of
// them would exist to click.
// ---------------------------------------------------------------------------------------------

// One quarter turn, so the stub's four routes stay the same shape of thing they were.
const turn = (point: Vec2): Vec2 => ({ x: -point.z, z: point.x });
const turned = (point: Vec2, times: number): Vec2 => {
  let out = point;
  for (let step = 0; step < times; step += 1) {
    out = turn(out);
  }
  return out;
};

// The stub's route: the ring around the old plateau, four quarter turns of it. See the note above.
const STUB_ROUTE_HALF = 45;
const stubRoute: Vec2[] = [
  { x: STUB_ROUTE_HALF, z: STUB_ROUTE_HALF },
  { x: STUB_ROUTE_HALF, z: -STUB_ROUTE_HALF },
  { x: -STUB_ROUTE_HALF, z: -STUB_ROUTE_HALF },
  { x: -STUB_ROUTE_HALF, z: STUB_ROUTE_HALF },
  { x: 0, z: STUB_ROUTE_HALF },
  { x: 0, z: 0 },
];

const trainingRoutes: RouteDefinition[] = [
  { id: 'burrow-east', turns: 0 },
  { id: 'burrow-north', turns: 1 },
  { id: 'burrow-west', turns: 2 },
  { id: 'burrow-south', turns: 3 },
].map((entry) => ({
  id: entry.id,
  circuit: true,
  points: stubRoute.map((point) => turned(point, entry.turns)),
}));

const trainingPads: BuildPadDefinition[] = [];

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
