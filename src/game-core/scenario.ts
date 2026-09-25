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

const trainingRoutes: RouteDefinition[] = [
  {
    id: 'east-gate',
    points: [
      { x: 6.5, z: -2.8 },
      { x: 4.7, z: -1.9 },
      { x: 2.4, z: 0.2 },
      { x: 0.1, z: 1.1 },
      { x: -2.4, z: 2.3 },
      { x: -5, z: 2.5 },
      { x: -6.3, z: 2.5 },
    ],
  },
  {
    id: 'north-gate',
    points: [
      { x: 6.5, z: 2.8 },
      { x: 4.2, z: 2.1 },
      { x: 2.4, z: 2.1 },
      { x: 0.1, z: 1.1 },
      { x: -2.4, z: 2.3 },
      { x: -5, z: 2.5 },
      { x: -6.3, z: 2.5 },
    ],
  },
];

const trainingPads: BuildPadDefinition[] = [
  { id: 'pad-east', position: { x: 3.4, z: -0.5 } },
  { id: 'pad-north', position: { x: 1.1, z: 2.3 } },
  { id: 'pad-south', position: { x: -0.9, z: 0.1 } },
  { id: 'pad-core', position: { x: -3.6, z: 2.5 } },
  { id: 'pad-west', position: { x: -5.4, z: 1.1 } },
];

const trainingWaves: WaveDefinition[] = [
  {
    id: 'first-contact',
    prepTicks: 30,
    groups: [
      { enemyId: 'husk', count: 7, startTick: 0, intervalTicks: 14, routeId: 'east-gate' },
      { enemyId: 'runner', count: 6, startTick: 8, intervalTicks: 18, routeId: 'north-gate' },
      { enemyId: 'wisp', count: 3, startTick: 36, intervalTicks: 24, routeId: 'east-gate' },
    ],
  },
];

export function createTrainingScenario(): MatchConfig {
  const map: MapDefinition = {
    id: 'verdant-relay',
    width: 18,
    depth: 12,
    corePosition: { x: -6.3, z: 2.5 },
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
