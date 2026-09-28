import type { EnemyDefinition, SpawnGroup, WaveDefinition } from './types.ts';

// Enemy roster and wave content, split out of `scenario.ts` on 2026-09-28 so that map work and wave
// work can run in parallel without both reaching for the same file. Enemy ids and route ids are frozen
// in `docs/PLAN.md` before the next work is issued, because a wave that references a kind nobody draws
// is a wave the client cannot show.
//
// Ten waves on `burrow-cross`, and four measured facts about that map decide all of them:
//
//   * A lap of the contour is 104.0 units and 28.8 of those are the four approaches, which no pad
//     sees — 14.4 walking out of the base and 14.4 walking back in. So no wave can be shorter than the
//     time it takes its last enemy to cross 14.4 units of open ground: 18 seconds for a Husk, 29 for a
//     Carapace. Add the spawn window and that pair is a bigger term in the length of a wave than its
//     health is, which is why the speeds below are a tuning knob and the counts are not: an enemy
//     costs gold, and gold is the one number the match length cannot be bought with.
//   * The twelve pads cover 49.63 units of road at Pulse's reach, 21.31 at Grove's and 57.15 at
//     Frost's. Against one enemy walking a whole lap a full board of four Pulse and eight Grove
//     sustains about 13.3 damage a second, which is roughly 1800 damage per lap. (Measured on the
//     committed map; 0032's pending move of the gate niche raises it to 17.1 and 2300, and moves
//     none of the numbers below — wave length here is set by the window and the approach, not by the
//     kill queue.)
//   * Nothing on this roster but the boss exceeds that per-lap budget, and a tower shoots whichever
//     enemy is furthest along its route, so enemies die roughly in the order they were spawned. A leak
//     is therefore not a matter of tuning: it needs an enemy that outlasts the whole board for a full
//     lap, and the next heaviest thing here is a Carapace at 253. That is why nine of the ten waves
//     end with the core untouched and the tenth costs four — see `maw`.
//   * Pulse fires 18 every 8 ticks, Grove 10 every 12 with a 1.1 splash, Frost 7 every 10 with a
//     0.5 slow. At 20 ticks a second those are 45, 16.7 and 14 damage a second each, so a board of
//     four Pulse and eight Grove can put out 313 — and spends about a sixth of it, because a tower
//     idles until something walks under it.
//
// Rewards are on the same scale: 220 starting gold and 35 for a clean wave are `scenario.ts`, and
// this file adds 540 in kill rewards over ten waves, which makes twelve pads at 50–70 a piece a board
// the player is still paying for during the ninth wave. Trash pays a coin, the shell pays ten, the
// boss pays forty: the schedule can only be about 450 units of enemy in total before the match stops
// being eight to eleven minutes, so the money has to sit in the tanks.

const trainingEnemies: EnemyDefinition[] = [
  {
    id: 'husk',
    name: 'Husk',
    maxHealth: 80,
    speed: 0.78,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'runner',
    name: 'Runner',
    maxHealth: 46,
    speed: 1.1,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'wisp',
    name: 'Wisp',
    maxHealth: 41,
    speed: 0.9,
    reward: 1,
    coreDamage: 1,
    // Carried over from the three-enemy roster unchanged, and it matters: because a Wisp answers to
    // `ground` as well as `air`, every ground tower shoots it and it is not what forces the grove
    // coverage. `mote` below is the only thing on this map that nothing but `grove-lens` can touch.
    tags: ['ground', 'air'],
  },
  {
    id: 'swarmling',
    name: 'Swarmling',
    maxHealth: 21,
    speed: 1.45,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'carapace',
    name: 'Carapace',
    maxHealth: 253,
    speed: 0.5,
    reward: 10,
    coreDamage: 2,
    tags: ['ground'],
  },
  {
    id: 'mote',
    name: 'Mote',
    maxHealth: 30,
    speed: 1,
    reward: 1,
    coreDamage: 1,
    tags: ['air'],
  },
  {
    // The boss, and the only enemy in the game that can leak. Its 3000 hit points are not decoration:
    // see the four facts at the top of this file for why nothing else on the roster can come round a
    // second time. Measured, not argued — the maw walks its 104 units in 153 seconds, of which 42 are
    // the approach nothing can reach, so it is under fire for 111 seconds before it returns to the
    // gate it started from and has absorbed about 1500 of its 3000. It pays one lap, four core damage
    // against a core of ten, and is still standing; two of them would be eight and one more would end
    // the run, so there is one, and it comes from one base.
    id: 'maw',
    name: 'Maw',
    maxHealth: 3000,
    speed: 0.68,
    reward: 40,
    coreDamage: 4,
    tags: ['ground'],
  },
];

// The four bases, in the order the map lists them. A group written against one of these is aimed at
// all four by `fromEveryBase`, so "it arrives from four corners at once" is a property of the shape of
// the file and not something four near-identical lines have to be kept in agreement about by hand.
const ROUTE_IDS = ['burrow-north', 'burrow-east', 'burrow-south', 'burrow-west'] as const;

type GroupSpec = Omit<SpawnGroup, 'routeId'>;

const fromEveryBase = (spec: readonly GroupSpec[]): SpawnGroup[] =>
  ROUTE_IDS.flatMap((routeId) => spec.map((group) => ({ ...group, routeId })));

// Spawn intervals are chosen for spacing, not for tempo. An enemy moves `speed` units a second and a
// tick is a twentieth of that, so the gap between two of them is `speed * interval / 20`: the ground
// groups below are spaced about two units apart, which is clear of the 0.78-wide Husk and closes the
// clump that sixteen Husks used to make. The swarm groups are the exception at about 1.1, because a
// 1.1 splash that never catches a second enemy is not a splash, and Groves are the only answer to air.
const trainingWaves: WaveDefinition[] = [
  {
    id: 'four-corners',
    prepTicks: 150,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 4, startTick: 0, intervalTicks: 44 },
    ]),
  },
  {
    id: 'long-amble',
    prepTicks: 150,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 4, startTick: 0, intervalTicks: 44 },
      { enemyId: 'runner', count: 4, startTick: 190, intervalTicks: 32 },
    ]),
  },
  {
    id: 'first-air',
    prepTicks: 140,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 3, startTick: 0, intervalTicks: 44 },
      { enemyId: 'wisp', count: 3, startTick: 150, intervalTicks: 40 },
    ]),
  },
  {
    id: 'the-swarm',
    prepTicks: 140,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 3, startTick: 0, intervalTicks: 44 },
      { enemyId: 'swarmling', count: 8, startTick: 130, intervalTicks: 15 },
    ]),
  },
  {
    id: 'the-shell',
    prepTicks: 130,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 3, startTick: 0, intervalTicks: 44 },
      { enemyId: 'carapace', count: 1, startTick: 150, intervalTicks: 50 },
    ]),
  },
  {
    id: 'four-sides',
    prepTicks: 130,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 3, startTick: 0, intervalTicks: 44 },
      { enemyId: 'runner', count: 5, startTick: 150, intervalTicks: 32 },
      { enemyId: 'swarmling', count: 5, startTick: 340, intervalTicks: 15 },
    ]),
  },
  {
    // The first air. Everything before it answers to `ground` as well, so this is the first wave where
    // a Grove Lens is not optional — and it is the whole reason the roster carries a second flying
    // kind. Measured: a full board of twelve Pulse Spires, no Grove anywhere, clears waves one to six
    // and is destroyed on this one.
    id: 'thin-air',
    prepTicks: 120,
    groups: fromEveryBase([
      { enemyId: 'husk', count: 3, startTick: 0, intervalTicks: 44 },
      { enemyId: 'mote', count: 5, startTick: 150, intervalTicks: 36 },
      { enemyId: 'runner', count: 3, startTick: 350, intervalTicks: 32 },
    ]),
  },
  {
    id: 'the-narrowing',
    prepTicks: 120,
    groups: fromEveryBase([
      { enemyId: 'carapace', count: 1, startTick: 0, intervalTicks: 50 },
      { enemyId: 'mote', count: 5, startTick: 140, intervalTicks: 36 },
      { enemyId: 'runner', count: 3, startTick: 340, intervalTicks: 32 },
    ]),
  },
  {
    id: 'last-light',
    prepTicks: 110,
    groups: fromEveryBase([
      { enemyId: 'runner', count: 5, startTick: 0, intervalTicks: 32 },
      { enemyId: 'carapace', count: 1, startTick: 180, intervalTicks: 50 },
      { enemyId: 'mote', count: 5, startTick: 250, intervalTicks: 36 },
    ]),
  },
  {
    // The boss comes from one base and the escort from all four, and the escort is spread over the
    // whole of the walk rather than delivered at the start: the maw is the leader for the entire wave,
    // so every escort group behind it is shot at only after it is dead, and the wave ends when the
    // last of them is. The player is therefore looking at the whole map for three minutes while the
    // thing that decides the match is on the far side of it, and there is no second chance to spend
    // the 70 a Grove Lens would have cost on the flank it happens to be walking down.
    id: 'the-maw',
    prepTicks: 110,
    groups: [
      { enemyId: 'maw', count: 1, startTick: 0, intervalTicks: 120, routeId: 'burrow-north' },
      ...fromEveryBase([
        { enemyId: 'runner', count: 5, startTick: 60, intervalTicks: 32 },
        { enemyId: 'mote', count: 5, startTick: 500, intervalTicks: 36 },
        { enemyId: 'husk', count: 4, startTick: 1200, intervalTicks: 44 },
        { enemyId: 'swarmling', count: 7, startTick: 2000, intervalTicks: 15 },
      ]),
    ],
  },
];

export { trainingEnemies, trainingWaves };
