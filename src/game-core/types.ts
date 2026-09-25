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
  waveBounty: number;
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
  | { type: 'waveStarted'; waveIndex: number; roll: number }
  | { type: 'enemySpawned'; entityId: number; enemyId: string; routeId: string }
  | { type: 'towerFired'; entityId: number; targetId: number; damage: number }
  | { type: 'enemyKilled'; entityId: number; reward: number }
  | { type: 'coreDamaged'; amount: number; coreHealth: number }
  | { type: 'waveCleared'; waveIndex: number; bounty: number; leaks: number }
  | { type: 'victory'; waveIndex: number }
  | { type: 'defeat'; waveIndex: number };
