import type { EnemyDefinition, SpawnGroup, WaveDefinition } from './types.ts';

// Enemy roster and wave content, split out of `scenario.ts` on 2026-09-28 so that map work and wave
// work can run in parallel without both reaching for the same file.
//
// Twelve waves on `burrow-vault`, and five measured facts about that map decide all of them:
//
//   * A lap is 360 units and the four routes own 540 of road between them. Every enemy below crosses
//     the map in 13.8 to 40 seconds, so a wave is over in about half a minute and what decides
//     whether one arrives is where the board is, not how long the walk takes. Speeds were carried
//     here from a scale of eighteen that used to live in `scenario.ts` while this file was frozen;
//     they are the content's own numbers now, and a wave is a schedule instead of a queue.
//   * Forty-four niches, 540 units of road, a full board covering just over half of it, and the best
//     niche worth 12.9 units of road against 1.25 for the worst — a factor of 10.3. So where a tower
//     goes is worth ten to one, and which of three towers goes there is worth three to one on top.
//   * The schedule is the pressure. `waveIntervalTicks` is measured from a wave's launch to the next
//     one's and is never re-based on the state of the map, so a wave that is still walking when the
//     next one lands is the normal case and not a bug. `prepTicks` is the warning the player gets,
//     counted from the end of the previous wave's arrivals rather than from its start.
//   * The economy is not a spiral. `scenario.ts` pays 70 for every wave whatever the player did, and
//     the rewards below are on top of that floor: 1 a piece of trash, 10 for a shell, 40 for the
//     boss, about 1100 in a full sweep against 840 that arrives either way. A player who kills
//     nothing still buys a board of fifteen towers by the last wave; a player who kills everything
//     buys thirty-five.
//   * Nothing but the boss outlasts a lap on its own, but with waves overlapping the leak count is
//     the number that matters: the road a board does not cover is walked free, and every lap a
//     survivor makes is another lap the player did not kill it. `maw` at 3000 health and 4 core
//     damage is the only enemy that can end a match by itself, and that is on purpose — it is the
//     one that has to be killed, not outlasted.

const trainingEnemies: EnemyDefinition[] = [
  {
    id: 'husk',
    name: 'Husk',
    maxHealth: 80,
    speed: 14,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'runner',
    name: 'Runner',
    maxHealth: 46,
    speed: 19.8,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'wisp',
    name: 'Wisp',
    maxHealth: 41,
    speed: 16.2,
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
    speed: 26.1,
    reward: 1,
    coreDamage: 1,
    tags: ['ground'],
  },
  {
    id: 'carapace',
    name: 'Carapace',
    maxHealth: 253,
    speed: 9,
    reward: 10,
    coreDamage: 2,
    tags: ['ground'],
  },
  {
    id: 'mote',
    name: 'Mote',
    maxHealth: 30,
    speed: 18,
    reward: 1,
    coreDamage: 1,
    tags: ['air'],
  },
  {
    // The boss, and the only enemy in the game that can leak. Its health is set against a board, not
    // against a lap: at the end of a match the greedy build puts thirty six towers on the map, a lap
    // of 360 units carries an enemy past about twenty of their chords, and that is roughly 700 damage
    // per lap. Measured on the previous 3000, the maw needed four of those and paid four core damage
    // for each, so a player who built the whole board still lost the match to a walk. At 1400 it takes
    // two laps from a full board and five from a thin one, which is the whole of the difference the
    // match is about. It comes from one base, and it is the one thing that has to be killed rather
    // than outlasted.
    id: 'maw',
    name: 'Maw',
    maxHealth: 1400,
    speed: 12.24,
    reward: 40,
    coreDamage: 3,
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

// A group laid evenly across a window instead of a spacing picked by hand. What the schedule cares
// about is where the LAST enemy lands, because that tick is when the wave has fully arrived and the
// next one is already on its way; the spacing is derived from the window so the two cannot disagree.
const spread = (enemyId: string, count: number, startTick: number, window: number): GroupSpec => ({
  enemyId,
  count,
  startTick,
  intervalTicks: count > 1 ? Math.max(1, Math.floor(window / (count - 1))) : 1,
});

// Twelve waves, and the schedule is the difficulty curve. The two numbers on every wave are the
// interval to the next launch and the window its own force arrives over, and the table is built so
// that the second is close to the first: a wave is still arriving when the next one launches, which is
// what puts two and three of them on the map at once and makes the road a player did not cover the
// problem it is instead of a detail.
//
// The intervals tighten from 1150 to 1000 and the windows widen from 800 to 1240, so the pressure
// comes from more of the map being busy at once rather than from the same amount arriving faster.
// Ten launches at 1150..1000 put the last wave on the map at tick 11 900 — nine minutes fifty — and
// the match ends a lap later than that, which is the ten to fifteen the owner asked for without
// touching the lap, which is not a tuning knob.
const trainingWaves: WaveDefinition[] = [
  {
    id: 'four-corners',
    // The first wave's prep is the opening window rather than a warning: it is the whole of the time
    // the player gets to read the map and spend 400 on a first decision, and 400 buys eight towers.
    waveIntervalTicks: 1150,
    prepTicks: 400,
    groups: fromEveryBase([
      spread('husk', 4, 0, 950),
    ]),
  },
  {
    id: 'long-amble',
    waveIntervalTicks: 1150,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 500),
      spread('runner', 3, 560, 440),
    ]),
  },
  {
    id: 'first-air',
    waveIntervalTicks: 1150,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 500),
      spread('wisp', 3, 560, 490),
    ]),
  },
  {
    id: 'the-swarm',
    waveIntervalTicks: 1100,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 500),
      // Five across 440 ticks is one every 110, which is 143 units of road between two of them at a
      // speed of 26. The point of a swarm here is that it is a sheet the splash answers to, not a
      // clump: sixteen of them at 44 used to walk inside each other and one tower shot all of them.
      spread('swarmling', 5, 560, 440),
    ]),
  },
  {
    id: 'the-shell',
    waveIntervalTicks: 1100,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 480),
      spread('carapace', 2, 560, 200),
      spread('husk', 2, 840, 260),
    ]),
  },
  {
    id: 'four-sides',
    waveIntervalTicks: 1100,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 480),
      spread('runner', 4, 560, 500),
      spread('swarmling', 2, 1140, 60),
    ]),
  },
  {
    // The first air nothing but a Grove Lens answers to. Everything before it answers to `ground` as
    // well, so this is the first wave where one tower is not optional — and it is the whole reason
    // the roster carries a second flying kind. A board of Pulse Spires with no Grove anywhere has
    // nothing to shoot here, and the sixteen motes walk the whole ring.
    id: 'thin-air',
    waveIntervalTicks: 1050,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 3, 0, 480),
      spread('mote', 4, 560, 460),
      spread('runner', 3, 1100, 110),
    ]),
  },
  {
    id: 'the-narrowing',
    waveIntervalTicks: 1050,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('carapace', 2, 0, 200),
      spread('husk', 3, 280, 440),
      spread('mote', 4, 780, 380),
      spread('runner', 2, 1220, 100),
    ]),
  },
  {
    id: 'the-long-walk',
    waveIntervalTicks: 1050,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('runner', 4, 0, 480),
      spread('mote', 3, 560, 400),
      spread('carapace', 2, 1020, 160),
      spread('swarmling', 3, 1220, 80),
    ]),
  },
  {
    id: 'the-sheet',
    waveIntervalTicks: 1000,
    prepTicks: 300,
    groups: fromEveryBase([
      // A wave of nothing but the small one, and the only wave here that a splash tower really
      // beats: thirty-two swarmlings is 670 points of health arriving in one continuous front, and
      // it is the wave a player who spent everything on reach has to walk away from.
      spread('swarmling', 8, 0, 980),
      spread('carapace', 2, 1040, 120),
    ]),
  },
  {
    id: 'last-light',
    waveIntervalTicks: 1000,
    prepTicks: 300,
    groups: fromEveryBase([
      spread('husk', 4, 0, 560),
      spread('mote', 4, 640, 400),
      spread('carapace', 2, 1080, 140),
      spread('runner', 2, 1260, 100),
    ]),
  },
  {
    // The boss comes from one base and the escort from all four. Its interval is the one number in
    // the table nothing reads, because there is no wave thirteen: it is here so that no wave in the
    // file lacks a schedule, not because it means anything. The escort is spread across the whole of
    // the walk rather than delivered at the start, so the player is buying a Grove Lens for the air
    // while the thing that decides the match is three hundred units away on the far side of the ring.
    id: 'the-maw',
    waveIntervalTicks: 1000,
    prepTicks: 300,
    groups: [
      { enemyId: 'maw', count: 1, startTick: 0, intervalTicks: 120, routeId: 'burrow-north' },
      ...fromEveryBase([
        spread('runner', 3, 0, 400),
        spread('mote', 3, 460, 340),
        spread('husk', 3, 860, 300),
        spread('swarmling', 3, 1220, 120),
      ]),
    ],
  },
];

export { trainingEnemies, trainingWaves };
