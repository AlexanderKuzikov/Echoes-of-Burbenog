import type {
  BuildPadDefinition,
  MapDefinition,
  MatchConfig,
  MatchRules,
  RouteDefinition,
  TowerDefinition,
} from './types.ts';
import { trainingEnemies, trainingWaves } from './contact.ts';
// The import attribute is required by Node, which runs the session server from this same file, and it
// is understood by the bundler and by `tsc`. Without it the map loads in the browser and the server
// refuses to boot, which is a worse split than one extra token.
import burrowMapFile from '../../content/maps/burrow-01.json' with { type: 'json' };
import { MapFileError, buildRouteWalk, cellCenter, readMapGrid } from './map-grid.ts';
import type { MapCell, MapGrid, RouteWalk } from './map-grid.ts';

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
// The grid, the spawns, the core, and the routes between them.
//
// **The map is the owner's file and nothing else.** `content/maps/burrow-01.json` is a byte copy of
// what came out of `NexusMap`, imported at build time rather than fetched: `config` is built
// synchronously while the page is starting, and an async load of the map would have rebuilt the
// whole page around it. The price is that a new map needs a production rebuild, which is the deal.
//
// What was here before is gone with itself: `trainingRoadNetwork` with its twenty hand-entered
// segments and their half widths, `baseHalf`, and a stub route that walked a ring at ±45 which does
// not exist on this plate. They were a second map written in code, and a second map is a map that
// can disagree with the first one. Nothing of that shape comes back.
//
// **The grid is read once and the four numbers below are cells, not world units.** Cell coordinates
// are whole, they are the ones in the owner's file, and they change on one line when the second layer
// arrives — spawns, cores and routes belong to the content layer, and the owner builds that separately.
// Until then there are five numbers to keep honest, and keeping them as cells means the file and the
// game cannot drift apart on a rounding step.
//
// **The core stands on road, and that is checked.** A core cell that is not a road cell is refused
// with its own reason rather than put in a field: a creature walking to a core that is not on the
// carriageway never touches it, and the match would end for a reason nobody could see.
//
// **The routes are the shortest walk over road, found here and never written down.** Each one starts
// at a spawn cell and ends at the core cell, and it ends there: there is no circuit, so a creature
// that arrives has arrived and a leak is spent. Straight runs of cells are collapsed into one
// segment each, so the polyline is four to seven points rather than eighty.
// ---------------------------------------------------------------------------------------------

/**
 * The grid the match is fought on, read once from the owner's file and kept.
 *
 * It is read through a function rather than at module load on purpose. A static read would throw
 * during the import of this file, which is before the page has any chance to say why — a map file this
 * build cannot read would take the page down as a blank screen with the reason in the console, and the
 * whole point of a refusal is that it is read. Here the refusal happens inside `createTrainingScenario`,
 * where the page catches it, writes it where a player can see it and keeps the field it already had.
 *
 * The answer is kept after the first read: the file is read once, and the scene reads the same grid
 * rather than reading the file a second time and getting a second answer to a question with one.
 */
let cachedGrid: MapGrid | null = null;

export const trainingGrid = (): MapGrid => {
  if (cachedGrid === null) {
    cachedGrid = readMapGrid(burrowMapFile);
  }
  return cachedGrid;
};

/**
 * The four entrances and the core, in the owner's cell coordinates. Read off the drawing rather than
 * invented: each entrance is the middle of the road where it leaves the plate, and the core is the
 * crossing in the middle. Temporary numbers, and they move to the content layer when it exists.
 */
export const trainingSpawns: ReadonlyArray<{ routeId: string; cell: MapCell }> = [
  { routeId: 'burrow-north', cell: { x: 79, y: 0 } },
  { routeId: 'burrow-south', cell: { x: 15, y: 95 } },
  { routeId: 'burrow-west', cell: { x: 0, y: 15 } },
  { routeId: 'burrow-east', cell: { x: 95, y: 79 } },
];

export const trainingCoreCell: MapCell = { x: 47, y: 47 };

export type TrainingRouteReading = {
  routeId: string;
  spawnCell: MapCell;
  lengthInCells: number;
  lengthInUnits: number;
  cells: number;
  points: number;
};

export type TrainingPlan = {
  grid: MapGrid;
  routes: ReadonlyArray<{ routeId: string; cell: MapCell; walk: RouteWalk }>;
  readings: readonly TrainingRouteReading[];
  routeDefinitions: RouteDefinition[];
};

/**
 * The map as a plan: read, checked, and turned into four routes, or a refusal.
 *
 * The check and the walk live here and not at module load, so a file this build cannot read is refused
 * where the page can catch it and say why — see `trainingGrid`. The answer is kept, because the scene
 * needs the same grid and a second read is a second answer to a question with one right one.
 */
let cachedPlan: TrainingPlan | null = null;

export const trainingPlan = (): TrainingPlan => {
  if (cachedPlan !== null) {
    return cachedPlan;
  }
  const grid = trainingGrid();

  if (grid.kindAt(trainingCoreCell) !== 'road') {
    throw new MapFileError(
      'grid-shape',
      `Core cell ${trainingCoreCell.x}, ${trainingCoreCell.y} of map ${grid.name} carries ${
        grid.kindAt(trainingCoreCell) ?? 'nothing'
      } · a core stands on road or the map is refused`,
    );
  }

  const routes = trainingSpawns.map(({ routeId, cell }) => {
    const walk = buildRouteWalk(grid, cell, trainingCoreCell);
    if (walk === null) {
      throw new MapFileError(
        'grid-shape',
        `Map ${grid.name} has no road walk from spawn ${cell.x}, ${cell.y} to the core at ${trainingCoreCell.x}, ${trainingCoreCell.y}`,
      );
    }
    return { routeId, cell, walk };
  });

  cachedPlan = {
    grid,
    routes,
    // The whole of what a reader needs to check the routes without running the game: how long each one
    // is in cells and in units, how many cells it crosses, and how many points its polyline came to.
    readings: routes.map(({ routeId, cell, walk }) => ({
      routeId,
      spawnCell: cell,
      lengthInCells: walk.lengthInCells,
      lengthInUnits: walk.lengthInUnits,
      cells: walk.cells.length,
      points: walk.points.length,
    })),
    routeDefinitions: routes.map(({ routeId, walk }) => ({ id: routeId, points: walk.points })),
  };
  return cachedPlan;
};

// **There are no building spots.** Placement on open ground is the next piece of work, and the plate
// is flat and open, so an empty list is the state that matches the picture: with pads declared and
// nothing drawn, the debug seam would report places a tower can go and none of them would exist to
// click. What the grid does give us is the permission — `free` is where a tower may stand — and that
// is read from the file rather than decided here.
const trainingPads: BuildPadDefinition[] = [];

export function createTrainingScenario(): MatchConfig {
  const plan = trainingPlan();
  const map: MapDefinition = {
    // The plate is the grid, so its width and depth are the file's own and nothing rounds them.
    id: plan.grid.name,
    width: plan.grid.width,
    depth: plan.grid.height,
    // The core is the centre of its cell, read through the one conversion in `map-grid.ts`. It is
    // therefore a half unit off the middle of the plate, because cell 47 of 96 is not cell 48.
    corePosition: cellCenter(plan.grid, trainingCoreCell),
    coreHealth: 10,
    routes: [...plan.routeDefinitions],
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
