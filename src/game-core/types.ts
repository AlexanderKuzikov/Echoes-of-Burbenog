export type Vec2 = {
  x: number;
  z: number;
};

export type MatchStatus = 'preparation' | 'wave' | 'victory' | 'defeat';

export type EnemyTag =
  | 'ground'
  | 'air'
  | 'siege'
  | 'invisible'
  | 'armored'
  | 'mechanical'
  | 'summoned';

export type Command =
  | { type: 'placeTower'; padId: string; towerId: string }
  | { type: 'startWave' };

export type CommandResult = {
  accepted: boolean;
  reason?: string;
};

export type TowerDefinition = {
  id: string;
  name: string;
  cost: number;
  range: number;
  damage: number;
  attackIntervalTicks: number;
  targets: EnemyTag[];
  slowFactor?: number;
  slowDurationTicks?: number;
  splashRadius?: number;
};

export type EnemyDefinition = {
  id: string;
  name: string;
  maxHealth: number;
  speed: number;
  reward: number;
  coreDamage: number;
  tags: EnemyTag[];
};

export type SpawnGroup = {
  enemyId: string;
  count: number;
  startTick: number;
  intervalTicks: number;
  routeId: string;
};

export type WaveDefinition = {
  id: string;
  /**
   * Ticks from this wave's launch to the next wave's launch. It is a clock, not a consequence: the
   * next wave starts on the tick whatever is still walking the map, which is what makes an unfinished
   * wave stack up behind the one that follows it instead of waiting to be cleaned up.
   *
   * Optional because a wave with no interval keeps the old promise — the next one follows as soon as
   * this one's whole force is on the map, plus its own prep window — and every wave still has a
   * schedule, there is simply no gap built into it.
   */
  waveIntervalTicks?: number;
  /**
   * Ticks of warning before this wave lands, counted from the end of the previous wave's spawn window
   * rather than from its start. The launch is on the schedule either way, so a fast previous wave
   * cannot eat the delay the player was given to spend gold.
   */
  prepTicks: number;
  groups: SpawnGroup[];
};

export type BuildPadDefinition = {
  id: string;
  position: Vec2;
};

export type RouteDefinition = {
  id: string;
  points: Vec2[];
  /**
   * A circuit is walked over and over. An ordinary route ends at the core: the enemy arrives, deals
   * its damage and is gone, so every leak is final. A circuit deals the same damage and starts the
   * lap again, which is what makes an early wave survivable by letting things past and killing them
   * on a later pass — and it is the only reason a match can hold more waves than the core has health.
   */
  circuit?: boolean;
};

export type MapDefinition = {
  id: string;
  width: number;
  depth: number;
  corePosition: Vec2;
  coreHealth: number;
  routes: RouteDefinition[];
  buildPads: BuildPadDefinition[];
};

export type MatchRules = {
  startingGold: number;
  /**
   * Gold paid for every wave, the moment that wave launches, and the reason a match cannot spiral.
   * Kill rewards and the reward for surviving without a leak used to pay this, which is exactly the
   * two conditions a player who is behind fails, so the wave pays it instead: falling behind costs
   * the bounty on kills, never the bounty itself.
   */
  waveBounty: number;
  /** Core points restored when a wave's whole force is on the map, leaks or no leaks. */
  repairAmount: number;
};

export type MatchConfig = {
  seed: number;
  map: MapDefinition;
  towers: TowerDefinition[];
  enemies: EnemyDefinition[];
  waves: WaveDefinition[];
  rules: MatchRules;
};

export type TowerSnapshot = {
  entityId: number;
  padId: string;
  towerId: string;
  cooldownTicks: number;
  /**
   * Kills this tower has been credited with. It is the whole of what a tower remembers between one
   * kill and the next: growth is read off this number and off nothing else, so there is no second
   * copy of "how big is this tower" anywhere in the state.
   */
  kills: number;
  /**
   * Growth level, 1 to 10. Derived from `kills` by the curve in `scenario.ts` and not stored: a
   * stored level would be a second truth that could disagree with the counter it came from, and the
   * presentation reads this so the view and the damage come from one function.
   */
  level: number;
};

/**
 * One tower's claim on one kill, as the split worked it out. `damage` is what the tower put into that
 * body and `share` is the fraction of the body's total damage that earns, so a reader can check the
 * split against the damage instead of taking it on trust. `kills` is the whole kills this tower was
 * credited with for the kill.
 */
export type GrowthCredit = {
  towerEntityId: number;
  damage: number;
  share: number;
  kills: number;
};

export type EnemySnapshot = {
  entityId: number;
  enemyId: string;
  routeId: string;
  distance: number;
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  slowTicks: number;
  slowFactor: number;
  tags: EnemyTag[];
};

export type MatchSnapshot = {
  version: 1;
  status: MatchStatus;
  tick: number;
  waveIndex: number;
  gold: number;
  coreHealth: number;
  maxCoreHealth: number;
  preparationTicksLeft: number;
  waveTick: number;
  rngState: number;
  lastWaveRoll: number | null;
  leaksThisWave: number;
  pads: Record<string, string | null>;
  towers: TowerSnapshot[];
  enemies: EnemySnapshot[];
};

export type SimulationEvent =
  | { type: 'towerPlaced'; padId: string; towerId: string; gold: number }
  | { type: 'preparationEnded'; waveIndex: number }
  // `bounty` is the guaranteed income this wave paid, and it is the only gold in the match that does
  // not depend on the player having done something right first.
  | { type: 'waveStarted'; waveIndex: number; roll: number; bounty: number }
  | { type: 'enemySpawned'; entityId: number; enemyId: string; routeId: string }
  | { type: 'towerFired'; entityId: number; targetId: number; damage: number }
  // `growth` is who the kill was credited to and on what evidence, and `rounded` is what the whole
  // kill counter could not represent. A kill is one point split by damage share, a share below one
  // point is rounded away, and the fraction that falls between the shares is handed to the largest of
  // them — so `rounded` is the part of the ideal split that did not survive that choice, reported
  // rather than swallowed. A point that quietly evaporates is a point the player cannot see the game
  // take, and a claim on a kill that cannot be checked against the damage is a claim the game asks to
  // be believed.
  | { type: 'enemyKilled'; entityId: number; reward: number; growth: GrowthCredit[]; rounded: number }
  | { type: 'coreDamaged'; amount: number; coreHealth: number }
  // Fires when a wave's whole force is on the map, which is the only "this wave is over" an
  // overlapping schedule has. `bounty` is what that wave paid when it launched, reported here so the
  // feed can say so where the player reads it; the gold itself is granted at `waveStarted`.
  | { type: 'waveCleared'; waveIndex: number; bounty: number; leaks: number }
  | { type: 'victory'; waveIndex: number }
  | { type: 'defeat'; waveIndex: number };
