import type {
  BuildPadDefinition,
  EnemyDefinition,
  MapDefinition,
  MatchConfig,
  MatchRules,
  RouteDefinition,
  TowerDefinition,
  WaveDefinition,
} from './types.ts';

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

const trainingEnemies: EnemyDefinition[] = [
  {
    id: 'husk',
    name: 'Husk',
    maxHealth: 90,
    speed: 0.72,
    reward: 10,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'runner',
    name: 'Runner',
    maxHealth: 52,
    speed: 1.05,
    reward: 8,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'wisp',
    name: 'Wisp',
    maxHealth: 44,
    speed: 0.86,
    reward: 12,
    coreDamage: 1,
    tags: ['ground', 'air'],
  },
];

// One road, five turns, core at the dead end. Every leg runs along a grid multiple of 0.4 and the
// raster that carves the massif works in the same 0.4 cells, so the road band lands on whole cells
// and the ribbon drawn from these points covers exactly what the wall leaves open. Two roads would
// be two independent problems; this one is a single problem with a single solution.
const trainingRoutes: RouteDefinition[] = [
  {
    id: 'burrow-spine',
    points: [
      { x: 10.4, z: -3.6 },
      { x: 3.2, z: -3.6 },
      { x: 3.2, z: -0.4 },
      { x: -2.8, z: -0.4 },
      { x: -2.8, z: 3.6 },
      { x: -8.4, z: 3.6 },
    ],
  },
];

// The five build niches. Each is a recess carved out of the massif next to the road, never on it, and
// the pad sits in the middle of the recess. What separates them is distance to the corridor: the
// mouth pad stands 1.4 from the road and sees one leg, the corner pad stands 1.4 from two and sees
// the most, the deep pad stands 2.2 and only a 3.1-range tower reaches it usefully. Placement is
// therefore a decision, which five equal spots on a plane never were.
const trainingPads: BuildPadDefinition[] = [
  { id: 'niche-mouth', position: { x: 6.2, z: -2.2 } },
  { id: 'niche-corner', position: { x: 1.8, z: -1.8 } },
  { id: 'niche-deep', position: { x: -0.6, z: -2.6 } },
  { id: 'niche-bend', position: { x: -4.2, z: 1.8 } },
  { id: 'niche-heart', position: { x: -6.2, z: 1.8 } },
];

const trainingWaves: WaveDefinition[] = [
  {
    id: 'first-contact',
    prepTicks: 30,
    groups: [
      { enemyId: 'husk', count: 7, startTick: 0, intervalTicks: 14, routeId: 'burrow-spine' },
      { enemyId: 'runner', count: 6, startTick: 8, intervalTicks: 18, routeId: 'burrow-spine' },
      { enemyId: 'wisp', count: 3, startTick: 36, intervalTicks: 24, routeId: 'burrow-spine' },
    ],
  },
];

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

export const trainingCorridor: CorridorDefinition = {
  roadHalfWidth: 0.6,
  coreChamber: { x: -8.4, z: 3.6, radius: 1.6 },
  bays: [
    { id: 'bay-mouth', padId: 'niche-mouth', minX: 5.4, maxX: 7, minZ: -3, maxZ: -1.4 },
    { id: 'bay-corner', padId: 'niche-corner', minX: 1, maxX: 2.6, minZ: -2.6, maxZ: -1 },
    { id: 'bay-deep', padId: 'niche-deep', minX: -1.8, maxX: 0.6, minZ: -3.8, maxZ: -1.4 },
    { id: 'bay-bend', padId: 'niche-bend', minX: -5, maxX: -3.4, minZ: 1, maxZ: 2.6 },
    { id: 'bay-heart', padId: 'niche-heart', minX: -7, maxX: -5.4, minZ: 1, maxZ: 2.6 },
  ],
};

export function createTrainingScenario(): MatchConfig {
  const map: MapDefinition = {
    id: 'burrow-hollow',
    width: 22,
    depth: 14,
    corePosition: { x: -8.4, z: 3.6 },
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
