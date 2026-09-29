import { nextRandom, normalizeSeed } from './rng.ts';
import type {
  BuildPadDefinition,
  Command,
  CommandResult,
  EnemyDefinition,
  EnemySnapshot,
  EnemyTag,
  MatchConfig,
  MatchRules,
  MatchSnapshot,
  MatchStatus,
  RouteDefinition,
  SimulationEvent,
  SpawnGroup,
  TowerDefinition,
  TowerSnapshot,
  Vec2,
  WaveDefinition,
} from './types.ts';

export const TICK_RATE = 20;
export const TICK_SECONDS = 1 / TICK_RATE;

type RouteSegment = {
  start: Vec2;
  end: Vec2;
  startDistance: number;
  length: number;
};

type NormalizedRoute = RouteDefinition & {
  segments: RouteSegment[];
  totalLength: number;
};

type NormalizedMap = Omit<MatchConfig['map'], 'routes'> & {
  routes: NormalizedRoute[];
};

type NormalizedConfig = {
  seed: number;
  map: NormalizedMap;
  pads: Map<string, BuildPadDefinition>;
  routes: Map<string, NormalizedRoute>;
  towers: Map<string, TowerDefinition>;
  enemies: Map<string, EnemyDefinition>;
  waves: NormalizedWave[];
  rules: MatchRules;
};

type TowerState = {
  entityId: number;
  padId: string;
  towerId: string;
  cooldownTicks: number;
};

type EnemyState = {
  entityId: number;
  enemyId: string;
  routeId: string;
  /**
   * The wave that spawned it. A leak is charged to the wave that owns the enemy, not to whichever
   * wave happens to be on the map, so two overlapping waves keep two honest leak counts and the
   * second one is not credited with the first one's debt.
   */
  waveIndex: number;
  distance: number;
  x: number;
  z: number;
  health: number;
  maxHealth: number;
  speed: number;
  reward: number;
  coreDamage: number;
  tags: EnemyTag[];
  slowTicks: number;
  slowFactor: number;
};

type ActiveGroup = {
  group: SpawnGroup;
  spawned: number;
};

type ActiveWave = {
  index: number;
  groups: ActiveGroup[];
  /** What this wave paid when it launched, so `waveCleared` can report it instead of guessing. */
  bounty: number;
  /** Leaks since this wave launched, counted on the wave that owns the enemy that walked in. */
  leaks: number;
};

/** A wave with the one number the schedule needs made explicit: when its whole force is on the map. */
type NormalizedWave = WaveDefinition & { waveIntervalTicks: number };

type InternalState = {
  status: MatchStatus;
  tick: number;
  /** The wave that is on the map, zero based. Stays where it was when the next one launches. */
  waveIndex: number;
  /** The wave the schedule will launch next, zero based. Equals `waves.length` once all are out. */
  nextWaveIndex: number;
  /** Absolute tick the next wave launches on, whatever is still walking when it gets there. */
  nextWaveTick: number;
  gold: number;
  coreHealth: number;
  maxCoreHealth: number;
  /** Ticks until the next wave lands, capped at that wave's prep window. Zero once all are out. */
  preparationTicksLeft: number;
  waveTick: number;
  rngState: number;
  lastWaveRoll: number | null;
  leaksThisWave: number;
  pads: Record<string, string | null>;
  towers: TowerState[];
  enemies: EnemyState[];
};

const distanceBetween = (a: Vec2, b: Vec2): number => Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);

const requireFinite = (value: number, name: string): void => {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be finite`);
  }
};

const requireNonNegative = (value: number, name: string): void => {
  requireFinite(value, name);
  if (value < 0) {
    throw new Error(`${name} must be non-negative`);
  }
};

const requirePositive = (value: number, name: string): void => {
  requireFinite(value, name);
  if (value <= 0) {
    throw new Error(`${name} must be positive`);
  }
};

const requireNonNegativeInteger = (value: number, name: string): void => {
  requireNonNegative(value, name);
  if (!Number.isInteger(value)) {
    throw new Error(`${name} must be an integer`);
  }
};

const requirePositiveInteger = (value: number, name: string): void => {
  requireNonNegativeInteger(value, name);
  if (value === 0) {
    throw new Error(`${name} must be positive`);
  }
};

const requireUniqueIds = (ids: string[], label: string): void => {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${label} id: ${id}`);
    }
    seen.add(id);
  }
};

const distanceSquared = (a: Vec2, b: Vec2): number => {
  const deltaX = a.x - b.x;
  const deltaZ = a.z - b.z;
  return deltaX * deltaX + deltaZ * deltaZ;
};

// The tick the last enemy of a wave is spawned on, and with it how long a wave stays "arriving".
// Two waves overlap exactly when the second one launches before the first has finished arriving, so
// this number is the one the schedule has to be read against.
const spawnWindowTicks = (groups: readonly SpawnGroup[]): number => {
  let last = 0;
  for (const group of groups) {
    last = Math.max(last, group.startTick + Math.max(0, group.count - 1) * Math.max(1, group.intervalTicks));
  }
  return last;
};

const normalizeRoute = (route: RouteDefinition): NormalizedRoute => {
  if (route.points.length < 2) {
    throw new Error(`Route ${route.id} needs at least two points`);
  }

  const segments: RouteSegment[] = [];
  for (const point of route.points) {
    requireFinite(point.x, `Route ${route.id} point x`);
    requireFinite(point.z, `Route ${route.id} point z`);
  }
  let totalLength = 0;
  for (let index = 1; index < route.points.length; index += 1) {
    const start = route.points[index - 1];
    const end = route.points[index];
    const length = distanceBetween(start, end);
    if (length <= 0) {
      throw new Error(`Route ${route.id} contains a zero-length segment`);
    }
    segments.push({ start, end, startDistance: totalLength, length });
    totalLength += length;
  }

  return { ...route, segments, totalLength };
};

const normalizeConfig = (config: MatchConfig): NormalizedConfig => {
  requireNonNegativeInteger(config.seed, 'seed');
  if (config.waves.length === 0) {
    throw new Error('A match needs at least one wave');
  }
  requirePositive(config.map.width, 'Map width');
  requirePositive(config.map.depth, 'Map depth');
  requirePositive(config.map.coreHealth, 'Core health');
  requireFinite(config.map.corePosition.x, 'Core position x');
  requireFinite(config.map.corePosition.z, 'Core position z');

  requireUniqueIds(config.map.routes.map((route) => route.id), 'route');
  requireUniqueIds(config.map.buildPads.map((pad) => pad.id), 'build pad');
  requireUniqueIds(config.towers.map((tower) => tower.id), 'tower');
  requireUniqueIds(config.enemies.map((enemy) => enemy.id), 'enemy');
  requireUniqueIds(config.waves.map((wave) => wave.id), 'wave');

  const routes = config.map.routes.map(normalizeRoute);
  const routeMap = new Map(routes.map((route) => [route.id, route]));
  const pads = config.map.buildPads.map((pad) => {
    requireFinite(pad.position.x, `Build pad ${pad.id} position x`);
    requireFinite(pad.position.z, `Build pad ${pad.id} position z`);
    return { ...pad, position: { ...pad.position } };
  });
  const padMap = new Map(pads.map((pad) => [pad.id, pad]));

  const towers = config.towers.map((tower) => {
    requireNonNegative(tower.cost, `Tower ${tower.id} cost`);
    requirePositive(tower.range, `Tower ${tower.id} range`);
    requireNonNegative(tower.damage, `Tower ${tower.id} damage`);
    requirePositiveInteger(tower.attackIntervalTicks, `Tower ${tower.id} attack interval`);
    if (tower.slowFactor !== undefined) {
      requireFinite(tower.slowFactor, `Tower ${tower.id} slow factor`);
      if (tower.slowFactor <= 0 || tower.slowFactor > 1) {
        throw new Error(`Tower ${tower.id} slow factor must be between 0 and 1`);
      }
    }
    if (tower.slowDurationTicks !== undefined) {
      requireNonNegativeInteger(tower.slowDurationTicks, `Tower ${tower.id} slow duration`);
    }
    if ((tower.slowFactor === undefined) !== (tower.slowDurationTicks === undefined)) {
      throw new Error(`Tower ${tower.id} must define slow factor and duration together`);
    }
    if (tower.splashRadius !== undefined) {
      requireNonNegative(tower.splashRadius, `Tower ${tower.id} splash radius`);
    }
    return { ...tower, targets: [...tower.targets] };
  });
  const towerMap = new Map(towers.map((tower) => [tower.id, tower]));

  const enemies = config.enemies.map((enemy) => {
    requirePositive(enemy.maxHealth, `Enemy ${enemy.id} health`);
    requirePositive(enemy.speed, `Enemy ${enemy.id} speed`);
    requireNonNegative(enemy.reward, `Enemy ${enemy.id} reward`);
    requireNonNegative(enemy.coreDamage, `Enemy ${enemy.id} core damage`);
    if (enemy.tags.length === 0) {
      throw new Error(`Enemy ${enemy.id} needs at least one tag`);
    }
    return { ...enemy, tags: [...enemy.tags] };
  });
  const enemyMap = new Map(enemies.map((enemy) => [enemy.id, enemy]));

  requireNonNegative(config.rules.startingGold, 'Starting gold');
  requireNonNegative(config.rules.waveBounty, 'Wave bounty');
  requireNonNegative(config.rules.repairAmount, 'Repair amount');

  const waves = config.waves.map((wave) => {
    requireNonNegativeInteger(wave.prepTicks, `Wave ${wave.id} preparation ticks`);
    if (wave.groups.length === 0) {
      throw new Error(`Wave ${wave.id} needs at least one spawn group`);
    }
    const groups = wave.groups.map((group) => {
      requirePositiveInteger(group.count, `Wave ${wave.id} group count`);
      requireNonNegativeInteger(group.startTick, `Wave ${wave.id} group start tick`);
      requirePositiveInteger(group.intervalTicks, `Wave ${wave.id} group interval`);
      if (!enemyMap.has(group.enemyId)) {
        throw new Error(`Wave ${wave.id} references unknown enemy ${group.enemyId}`);
      }
      if (!routeMap.has(group.routeId)) {
        throw new Error(`Wave ${wave.id} references unknown route ${group.routeId}`);
      }
      return { ...group };
    });
    // A wave without an interval of its own still has one: the next wave follows as soon as this one's
    // whole force is on the map and its prep window has passed. Every wave is on a schedule, there is
    // simply no gap written into this one.
    const interval = wave.waveIntervalTicks ?? spawnWindowTicks(groups) + wave.prepTicks;
    requirePositiveInteger(interval, `Wave ${wave.id} interval ticks`);
    return { ...wave, groups, waveIntervalTicks: interval };
  });

  return {
    seed: normalizeSeed(config.seed),
    map: {
      ...config.map,
      routes,
      buildPads: pads,
    },
    pads: padMap,
    routes: routeMap,
    towers: towerMap,
    enemies: enemyMap,
    waves,
    rules: { ...config.rules },
  };
};

const pointAtDistance = (route: NormalizedRoute, distance: number): Vec2 => {
  if (distance <= 0) {
    return { ...route.points[0] };
  }
  for (const segment of route.segments) {
    const segmentEnd = segment.startDistance + segment.length;
    if (distance <= segmentEnd) {
      const ratio = (distance - segment.startDistance) / segment.length;
      return {
        x: segment.start.x + (segment.end.x - segment.start.x) * ratio,
        z: segment.start.z + (segment.end.z - segment.start.z) * ratio,
      };
    }
  }
  return { ...route.points[route.points.length - 1] };
};

export class Simulation {
  private readonly config: NormalizedConfig;
  private readonly state: InternalState;
  /**
   * Every wave that has launched and has not finished arriving. It is a list and not a single slot
   * because two waves are meant to be on the map at once: a wave that is still walking when the next
   * one lands is exactly the pressure the schedule is for, and a single slot would either drop the
   * overlap or refuse the launch.
   */
  private activeWaves: ActiveWave[] = [];
  private events: SimulationEvent[] = [];
  private nextEntityId = 1;

  public constructor(config: MatchConfig) {
    this.config = normalizeConfig(config);
    const pads: Record<string, string | null> = {};
    for (const pad of this.config.map.buildPads) {
      pads[pad.id] = null;
    }
    this.state = {
      status: 'preparation',
      tick: 0,
      waveIndex: 0,
      nextWaveIndex: 0,
      // The opening window is the first wave's own prep: the match is preparation, and the first wave
      // lands when that window runs out whether or not anybody pressed anything.
      nextWaveTick: this.config.waves[0].prepTicks,
      gold: this.config.rules.startingGold,
      coreHealth: this.config.map.coreHealth,
      maxCoreHealth: this.config.map.coreHealth,
      preparationTicksLeft: this.config.waves[0].prepTicks,
      waveTick: 0,
      rngState: this.config.seed,
      lastWaveRoll: null,
      leaksThisWave: 0,
      pads,
      towers: [],
      enemies: [],
    };
  }

  public dispatch(command: Command): CommandResult {
    if (command.type === 'placeTower') {
      return this.placeTower(command.padId, command.towerId);
    }
    return this.startWave();
  }

  public step(): void {
    if (this.state.status === 'victory' || this.state.status === 'defeat') {
      return;
    }

    this.state.tick += 1;
    this.countDownToTheNextWave();
    if (this.state.nextWaveIndex < this.config.waves.length && this.state.tick >= this.state.nextWaveTick) {
      this.launchWave();
    }
    if (this.state.status === 'preparation') {
      return;
    }

    this.state.waveTick += 1;
    this.spawnDueEnemies();
    this.updateEnemies();
    if (this.isDefeated()) {
      return;
    }
    this.updateTowers();
    this.removeDefeatedEnemies();
    if (this.isDefeated()) {
      return;
    }
    this.closeArrivedWaves();
    this.checkVictory();
  }

  public advance(ticks: number): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new Error('Ticks must be a non-negative integer');
    }
    for (let tick = 0; tick < ticks; tick += 1) {
      this.step();
    }
  }

  public getSnapshot(): MatchSnapshot {
    const towers: TowerSnapshot[] = this.state.towers.map((tower) => ({ ...tower }));
    const enemies: EnemySnapshot[] = this.state.enemies.map((enemy) => ({
      entityId: enemy.entityId,
      enemyId: enemy.enemyId,
      routeId: enemy.routeId,
      distance: enemy.distance,
      x: enemy.x,
      z: enemy.z,
      health: enemy.health,
      maxHealth: enemy.maxHealth,
      slowTicks: enemy.slowTicks,
      slowFactor: enemy.slowTicks > 0 ? enemy.slowFactor : 1,
      tags: [...enemy.tags],
    }));

    return {
      version: 1,
      status: this.state.status,
      tick: this.state.tick,
      waveIndex: this.state.waveIndex,
      gold: this.state.gold,
      coreHealth: this.state.coreHealth,
      maxCoreHealth: this.state.maxCoreHealth,
      preparationTicksLeft: this.state.preparationTicksLeft,
      waveTick: this.state.waveTick,
      rngState: this.state.rngState,
      lastWaveRoll: this.state.lastWaveRoll,
      leaksThisWave: this.state.leaksThisWave,
      pads: { ...this.state.pads },
      towers,
      enemies,
    };
  }

  public drainEvents(): SimulationEvent[] {
    const drained = this.events;
    this.events = [];
    return drained;
  }

  private isDefeated(): boolean {
    return this.state.status === 'defeat';
  }

  /**
   * The countdown the player reads as "the next wave lands in this long". It is measured from the
   * schedule and not from the state of the map, so nothing that is still walking can shorten it, and
   * it stops at the next wave's own prep window rather than running the whole gap — a gap the player
   * was not promised and would read as a stall.
   */
  private countDownToTheNextWave(): void {
    const next = this.config.waves[this.state.nextWaveIndex];
    if (!next) {
      this.state.preparationTicksLeft = 0;
      return;
    }
    const untilLaunch = this.state.nextWaveTick - this.state.tick;
    const left = untilLaunch <= 0 ? 0 : Math.min(untilLaunch, next.prepTicks);
    if (left === 0 && this.state.preparationTicksLeft > 0) {
      this.events.push({ type: 'preparationEnded', waveIndex: this.state.nextWaveIndex });
    }
    this.state.preparationTicksLeft = left;
  }

  /**
   * The wave schedule is a clock and not a consequence of the field: the next wave launches on its
   * tick with whatever is still walking. `waveIndex` names the wave on the map and `nextWaveIndex` is
   * the cursor, because the player reads the first and the schedule needs the second.
   */
  private launchWave(): void {
    const wave = this.config.waves[this.state.nextWaveIndex];
    if (!wave) {
      return;
    }
    const roll = nextRandom(this.state.rngState);
    this.state.rngState = roll.state;
    this.state.lastWaveRoll = roll.value;
    this.state.status = 'wave';
    this.state.waveIndex = this.state.nextWaveIndex;
    this.state.nextWaveIndex += 1;
    this.state.nextWaveTick = this.state.tick + wave.waveIntervalTicks;
    this.state.waveTick = 0;
    this.state.leaksThisWave = 0;
    this.state.preparationTicksLeft = 0;
    this.activeWaves.push({
      index: this.state.waveIndex,
      groups: wave.groups.map((group) => ({ group, spawned: 0 })),
      bounty: this.config.rules.waveBounty,
      leaks: 0,
    });
    // Paid on launch, not on a clean sweep. A wave that overlaps the next one is never "cleared", so
    // a payment gated on clearing is a payment the player who is already losing waits longest for —
    // which is the spiral this replaces. The bounty is the floor; kill rewards are what a player earns
    // on top of it, and only a player who is ahead collects them.
    this.state.gold += this.config.rules.waveBounty;
    this.events.push({
      type: 'waveStarted',
      waveIndex: this.state.waveIndex,
      roll: roll.value,
      bounty: this.config.rules.waveBounty,
    });
  }

  /** Everything still in its spawn window. A wave with none left has fully arrived on the map. */
  private closeArrivedWaves(): void {
    const arrived = this.activeWaves.filter((active) => active.groups.every((group) => group.spawned >= group.group.count));
    if (arrived.length === 0) {
      return;
    }
    this.activeWaves = this.activeWaves.filter((active) => !arrived.includes(active));
    const repair = this.config.rules.repairAmount;
    this.state.coreHealth = Math.min(this.state.maxCoreHealth, this.state.coreHealth + repair);
    for (const active of arrived) {
      this.events.push({
        type: 'waveCleared',
        waveIndex: active.index,
        bounty: active.bounty,
        leaks: active.leaks,
      });
    }
  }

  /** The match is won when the last wave has arrived and nothing of it is left walking. */
  private checkVictory(): void {
    if (this.state.nextWaveIndex < this.config.waves.length) {
      return;
    }
    if (this.activeWaves.length > 0 || this.state.enemies.length > 0) {
      return;
    }
    this.state.status = 'victory';
    this.activeWaves = [];
    this.events.push({ type: 'victory', waveIndex: this.state.waveIndex });
  }

  private placeTower(padId: string, towerId: string): CommandResult {
    if (this.state.status === 'victory' || this.state.status === 'defeat') {
      return { accepted: false, reason: 'match-finished' };
    }
    if (!this.config.pads.has(padId)) {
      return { accepted: false, reason: 'unknown-pad' };
    }
    if (this.state.pads[padId] !== null) {
      return { accepted: false, reason: 'pad-occupied' };
    }
    const definition = this.config.towers.get(towerId);
    if (!definition) {
      return { accepted: false, reason: 'unknown-tower' };
    }
    if (this.state.gold < definition.cost) {
      return { accepted: false, reason: 'not-enough-gold' };
    }

    const entityId = this.nextEntityId;
    this.nextEntityId += 1;
    this.state.gold -= definition.cost;
    this.state.pads[padId] = towerId;
    this.state.towers.push({ entityId, padId, towerId, cooldownTicks: 0 });
    this.events.push({ type: 'towerPlaced', padId, towerId, gold: this.state.gold });
    return { accepted: true };
  }

  /**
   * The manual start is gone from the rules, and the command says so rather than quietly doing
   * nothing. It stays in `Command` because the session protocol and the room dispatch it, and both
   * are outside this file's reach; what a normal match does with it is refuse it by name, so an old
   * save replaying itself, a room, or a script that still sends it all get the same answer.
   */
  private startWave(): CommandResult {
    if (this.state.status === 'victory' || this.state.status === 'defeat') {
      return { accepted: false, reason: 'match-finished' };
    }
    return { accepted: false, reason: 'waves-run-on-their-own' };
  }

  private spawnDueEnemies(): void {
    for (const activeWave of this.activeWaves) {
      for (const activeGroup of activeWave.groups) {
        const { group } = activeGroup;
        const interval = Math.max(1, group.intervalTicks);
        while (activeGroup.spawned < group.count) {
          const spawnTick = group.startTick + activeGroup.spawned * interval;
          if (spawnTick > this.state.waveTick) {
            break;
          }
          this.spawnEnemy(group, activeWave.index);
          activeGroup.spawned += 1;
        }
      }
    }
  }

  private spawnEnemy(group: SpawnGroup, waveIndex: number): void {
    const definition = this.config.enemies.get(group.enemyId);
    const route = this.config.routes.get(group.routeId);
    if (!definition || !route) {
      return;
    }
    const start = route.points[0];
    const entityId = this.nextEntityId;
    this.nextEntityId += 1;
    this.state.enemies.push({
      entityId,
      enemyId: definition.id,
      routeId: route.id,
      waveIndex,
      distance: 0,
      x: start.x,
      z: start.z,
      health: definition.maxHealth,
      maxHealth: definition.maxHealth,
      speed: definition.speed,
      reward: definition.reward,
      coreDamage: definition.coreDamage,
      tags: [...definition.tags],
      slowTicks: 0,
      slowFactor: 1,
    });
    this.events.push({ type: 'enemySpawned', entityId, enemyId: definition.id, routeId: route.id });
  }

  private updateEnemies(): void {
    const survivors: EnemyState[] = [];
    for (const enemy of this.state.enemies) {
      const route = this.config.routes.get(enemy.routeId);
      if (!route) {
        continue;
      }
      const slowFactor = enemy.slowTicks > 0 ? enemy.slowFactor : 1;
      if (enemy.slowTicks > 0) {
        enemy.slowTicks -= 1;
      }
      const nextDistance = enemy.distance + enemy.speed * slowFactor * TICK_SECONDS;
      if (nextDistance >= route.totalLength) {
        this.damageCore(enemy.coreDamage, enemy.waveIndex);
        if (this.isDefeated()) {
          this.state.enemies = [];
          return;
        }
        if (route.circuit !== true) {
          // An ordinary route ends here: the enemy has arrived and leaves, so the leak is spent.
          continue;
        }
        // A circuit does not end the walk. The lap is paid for and the enemy comes round again,
        // which is what lets a wave be survived by letting it past and killing it on a later pass.
        // Position is taken from the remainder of the lap rather than from the route start, so a
        // fast enemy keeps its place instead of snapping to the entry on every circuit.
        const wrapped = nextDistance - route.totalLength;
        enemy.distance = wrapped;
        const position = pointAtDistance(route, wrapped);
        enemy.x = position.x;
        enemy.z = position.z;
        survivors.push(enemy);
        continue;
      }
      enemy.distance = nextDistance;
      const position = pointAtDistance(route, nextDistance);
      enemy.x = position.x;
      enemy.z = position.z;
      survivors.push(enemy);
    }
    this.state.enemies = survivors;
  }

  private damageCore(amount: number, waveIndex: number): void {
    const applied = Math.min(amount, this.state.coreHealth);
    this.state.coreHealth = Math.max(0, this.state.coreHealth - amount);
    this.state.leaksThisWave += 1;
    for (const active of this.activeWaves) {
      if (active.index === waveIndex) {
        active.leaks += 1;
      }
    }
    this.events.push({ type: 'coreDamaged', amount: applied, coreHealth: this.state.coreHealth });
    if (this.state.coreHealth === 0) {
      this.state.status = 'defeat';
      this.activeWaves = [];
      this.events.push({ type: 'defeat', waveIndex: this.state.waveIndex });
    }
  }

  private updateTowers(): void {
    for (const tower of this.state.towers) {
      tower.cooldownTicks = Math.max(0, tower.cooldownTicks - 1);
      if (tower.cooldownTicks > 0) {
        continue;
      }
      const definition = this.config.towers.get(tower.towerId);
      if (!definition) {
        continue;
      }
      const target = this.selectTarget(tower, definition);
      if (!target) {
        continue;
      }
      tower.cooldownTicks = definition.attackIntervalTicks;
      this.applyAttack(tower, definition, target);
    }
  }

  private selectTarget(tower: TowerState, definition: TowerDefinition): EnemyState | null {
    const towerPad = this.config.pads.get(tower.padId);
    if (!towerPad) {
      return null;
    }
    const candidates = this.state.enemies.filter((enemy) => {
      if (enemy.health <= 0 || !this.matchesTags(definition, enemy)) {
        return false;
      }
      return distanceSquared(towerPad.position, enemy) <= definition.range * definition.range;
    });
    if (candidates.length === 0) {
      return null;
    }

    let bestDistance = -Infinity;
    for (const candidate of candidates) {
      bestDistance = Math.max(bestDistance, candidate.distance);
    }
    const tied = candidates.filter((candidate) => Math.abs(candidate.distance - bestDistance) < 0.0001);
    if (tied.length === 1) {
      return tied[0];
    }
    const roll = nextRandom(this.state.rngState);
    this.state.rngState = roll.state;
    return tied[Math.floor(roll.value * tied.length)] ?? tied[0];
  }

  private matchesTags(definition: TowerDefinition, enemy: EnemyState): boolean {
    return definition.targets.length === 0 || definition.targets.some((tag) => enemy.tags.includes(tag));
  }

  private applyAttack(tower: TowerState, definition: TowerDefinition, target: EnemyState): void {
    const splashRadius = definition.splashRadius ?? 0;
    const affected = splashRadius > 0
      ? this.state.enemies.filter((enemy) => enemy.health > 0 && this.matchesTags(definition, enemy) && distanceSquared(target, enemy) <= splashRadius * splashRadius)
      : [target];
    for (const enemy of affected) {
      if (enemy.health <= 0) {
        continue;
      }
      enemy.health -= definition.damage;
      if (definition.slowFactor !== undefined && definition.slowDurationTicks !== undefined) {
        if (enemy.slowTicks <= 0 || definition.slowFactor < enemy.slowFactor) {
          enemy.slowFactor = definition.slowFactor;
          enemy.slowTicks = definition.slowDurationTicks;
        } else if (definition.slowFactor === enemy.slowFactor) {
          enemy.slowTicks = Math.max(enemy.slowTicks, definition.slowDurationTicks);
        }
      }
    }
    this.events.push({ type: 'towerFired', entityId: tower.entityId, targetId: target.entityId, damage: definition.damage });
  }

  private removeDefeatedEnemies(): void {
    const survivors: EnemyState[] = [];
    for (const enemy of this.state.enemies) {
      if (enemy.health > 0) {
        survivors.push(enemy);
        continue;
      }
      this.state.gold += enemy.reward;
      this.events.push({ type: 'enemyKilled', entityId: enemy.entityId, reward: enemy.reward });
    }
    this.state.enemies = survivors;
  }
}

export function createSimulation(config: MatchConfig): Simulation {
  return new Simulation(config);
}
