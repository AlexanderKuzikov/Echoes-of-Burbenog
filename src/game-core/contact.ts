import type { EnemyDefinition, WaveDefinition } from './types.ts';

// Enemy roster and wave content, split out of `scenario.ts` on 2026-09-28 so that map work and wave
// work can run in parallel without both reaching for the same file. Nothing changed: the definitions
// are exactly the ones that were in `scenario.ts`, and the wave still spawns along `burrow-spine`.
//
// This file owns what comes down the road; `scenario.ts` owns the map, the pads and the towers. Enemy
// ids and route ids are frozen in `docs/PLAN.md` before the next work is issued, because a wave that
// references a kind nobody draws is a wave the client cannot show.

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

export { trainingEnemies, trainingWaves };
