import { nextRandom, normalizeSeed } from './rng.ts';
import { cellForSpotId, checkSpot, spotCells } from './map-grid.ts';
import type { MapCell } from './map-grid.ts';
import {
  towerDamageMultiplier,
  towerGrowthLevel,
  towerGrowthPointsPerKill,
} from './scenario.ts';
import type {
  BuildPadDefinition,
  Command,
  CommandResult,
  EnemyDefinition,
  EnemySnapshot,
  EnemyTag,
  GrowthCredit,
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
  /**
   * Kills credited to this tower, and the only thing it remembers between one kill and the next. It
   * is read by the growth curve on every shot, so a tower's damage is a function of what it has been
   * part of killing and of nothing else — no stored level, no second copy of the same answer.
   */
  kills: number;
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
  /**
   * Who put damage into this body, and how much, keyed by tower entity id. It lives on the enemy
   * rather than on the towers because the share is only known when the enemy dies, and a tower that
   * was never in range of a body must not appear in its split — a tower that did not hit a thing gets
   * nothing for it, which is the whole reason a crowd is a decision rather than a free win.
   *
   * Damage is recorded as dealt, after the growth multiplier, so the split is proportional to what
   * actually happened and not to what a level-1 tower would have done.
   */
  damageByTower: Map<number, number>;
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
  /**
   * Only occupied spots, and no entry for an empty one — see `MatchSnapshot.pads` for why absence is
   * the empty value here. The board has thousands of spots, so a full record would cost a frame's
   * worth of bytes to carry the news that nothing stands on most of them.
   */
  pads: Record<string, string>;
  /**
   * The cells towers stand on, keyed by cell index. Not on the snapshot — nothing outside this file reads
   * it, and it is fully reconstructible from the towers — but it is the answer to "is this square clear",
   * which is a question about cells rather than about spots, and the squares overlap.
   */
  claimedCells: Set<number>;
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
    // Nothing pre-filled: a key appears here when a tower is built on that spot and stays after, so
    // the state starts as an empty record rather than as two thousand nulls.
    const pads: Record<string, string> = {};
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
      claimedCells: new Set<number>(),
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
    const towers: TowerSnapshot[] = this.state.towers.map((tower) => ({
      ...tower,
      // Counted here rather than stored, so the level a client draws and the level the damage was
      // read at are the same function of the same number. The spread puts the level back on the
      // snapshot, and a snapshot that carried a level nobody could recompute would be a second truth.
      level: towerGrowthLevel(tower.kills),
    }));
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

  /**
   * Where a tower may stand, and what stops it when it may not.
   *
   * On a map with a cell grid the answer comes off the cells and nowhere else: the spot name reads
   * back as its cell, and that cell's kind and the fifteen around it are what decide. `road` and
   * `occupied` are the anchor's own kind, and they are two different refusals because they are two
   * different facts about the ground — one is the road the wave walks, the other is ground the map
   * has already spent. A square that is free but not *all* free is a third, and it carries how many
   * of the sixteen are spoken for, because "this spot is not free" is not something a player can act
   * on and "four of its cells are taken" is.
   *
   * Without a grid the declared pads are the whole rule, and the refusal is the flat `unknown-pad` it
   * always was — that is the pure-check shape, where the pads were named by hand and there are no
   * cells to read.
   */
  private refuseSpot(padId: string): CommandResult {
    const cells = this.config.map.cells;
    if (!cells) {
      return { accepted: false, reason: 'unknown-pad' };
    }
    const anchor = cellForSpotId(padId);
    if (anchor === null) {
      return { accepted: false, reason: 'unknown-pad' };
    }
    const check = checkSpot(cells, anchor);
    if (!check.allowed) {
      return { accepted: false, reason: check.refusal, detail: check.blocked };
    }
    // Free by the map's own account, so the only thing left is this match: the player has already built
    // on this exact spot.
    return { accepted: false, reason: 'pad-occupied' };
  }

  /**
   * How many of a spot's sixteen cells this match has already given to a tower.
   *
   * The map says a square is free when nothing has ever been built on it; it cannot say anything about
   * towers, because towers are not in the file. Without this the squares would overlap freely — the board
   * has 2 192 of them over 4 760 free cells, so most of them do — and a player could stand two towers on
   * the same sixteen cells and be told nothing was wrong. It is also what makes the refusal countable: a
   * square with three of its cells under towers says three, which is the difference between "move a
   * little" and "move anywhere".
   */
  private claimedCellsOf(anchor: MapCell): number {
    const cells = this.config.map.cells;
    if (!cells) {
      return 0;
    }
    let claimed = 0;
    for (const cell of spotCells(anchor)) {
      if (this.state.claimedCells.has(cell.y * cells.width + cell.x)) {
        claimed += 1;
      }
    }
    return claimed;
  }

  private placeTower(padId: string, towerId: string): CommandResult {
    if (this.state.status === 'victory' || this.state.status === 'defeat') {
      return { accepted: false, reason: 'match-finished' };
    }
    // The spot itself, asked first: "a tower is already here" is true whatever the ground under it says.
    if (this.state.pads[padId] !== undefined) {
      return { accepted: false, reason: 'pad-occupied' };
    }

    const cells = this.config.map.cells;
    const anchor = cells === undefined ? null : cellForSpotId(padId);
    // Then the sixteen cells, counted against what this match has already built on. The two checks are
    // separate sentences on purpose: a square with a neighbour's tower across it is not the same problem
    // as a square with a tower on it, and it is the first that needs a number to act on.
    const claimed = anchor === null ? 0 : this.claimedCellsOf(anchor);
    if (claimed > 0) {
      return { accepted: false, reason: 'spot-square-blocked', detail: claimed };
    }
    if (!this.config.pads.has(padId)) {
      return this.refuseSpot(padId);
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
    // The cells are taken here, where the tower is. A spot that does not exist by the map's account
    // cannot reach this line, so nothing is claimed for it.
    if (anchor !== null) {
      for (const cell of spotCells(anchor)) {
        this.state.claimedCells.add(cell.y * (cells as NonNullable<typeof cells>).width + cell.x);
      }
    }
    this.state.towers.push({ entityId, padId, towerId, cooldownTicks: 0, kills: 0 });
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
      damageByTower: new Map(),
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
    // The multiplier is read once, off the tower's own kill count, and applied once — to the damage
    // this shot does. Not to `definition.damage`, which is a base number every other reader of a
    // tower means by the tower's damage, and not inside the loop, because a splash walks the same
    // number over several bodies and a shot that multiplied itself once per body would make the
    // growth curve and the splash radius the same lever.
    const damage = definition.damage * towerDamageMultiplier(tower.kills);
    const splashRadius = definition.splashRadius ?? 0;
    const affected = splashRadius > 0
      ? this.state.enemies.filter((enemy) => enemy.health > 0 && this.matchesTags(definition, enemy) && distanceSquared(target, enemy) <= splashRadius * splashRadius)
      : [target];
    for (const enemy of affected) {
      if (enemy.health <= 0) {
        continue;
      }
      // Read before the subtraction, so the cap is against the health that was actually there.
      const stoodBefore = enemy.health;
      enemy.health -= damage;
      // Credited as damage dealt and not as damage swung, so a tower cannot buy a share of a kill it
      // did not finish. A body with two hit points left gives two points of credit however big the
      // shot that took it was, and the multiplier still applied to the whole shot before the cap.
      const dealt = Math.min(damage, stoodBefore);
      enemy.damageByTower.set(tower.entityId, (enemy.damageByTower.get(tower.entityId) ?? 0) + dealt);
      if (definition.slowFactor !== undefined && definition.slowDurationTicks !== undefined) {
        if (enemy.slowTicks <= 0 || definition.slowFactor < enemy.slowFactor) {
          enemy.slowFactor = definition.slowFactor;
          enemy.slowTicks = definition.slowDurationTicks;
        } else if (definition.slowFactor === enemy.slowFactor) {
          enemy.slowTicks = Math.max(enemy.slowTicks, definition.slowDurationTicks);
        }
      }
    }
    this.events.push({ type: 'towerFired', entityId: tower.entityId, targetId: target.entityId, damage });
  }

  /**
   * The one place a kill is divided. A kill is `towerGrowthPointsPerKill` points; a tower gets the
   * share of that equal to the share of the body's damage it put in, floored to whole kills, and the
   * fraction no whole kill can carry goes to the largest share.
   *
   * The floor is what the game reads — a counter of whole kills — and the remainder is the part of
   * the ideal split that a whole kill cannot hold. It is not thrown away and it is not spread: the
   * largest share takes it, which is the one place the floor can be wrong and it is reported on the
   * event as `rounded` so the loss is a number somebody can see rather than a rule that quietly ate
   * a point. Dropping it instead would be worse than losing it visibly: with one point per kill and
   * two towers on the same body, a body split 70/30 floors to 0 and 0, and a shared kill would pay
   * nobody at all — the mechanic would work only where there is nothing to share with.
   *
   * A tower that is not in the map has no entry in the ledger and cannot appear here, so the rule
   * "one that never hit it gets nothing" is a consequence of the bookkeeping rather than a check that
   * could be forgotten. A body that walked into the core never reaches this function at all.
   */
  private creditGrowth(enemy: EnemyState): { growth: GrowthCredit[]; rounded: number } {
    const points = towerGrowthPointsPerKill;
    let totalDamage = 0;
    for (const damage of enemy.damageByTower.values()) {
      totalDamage += damage;
    }
    if (totalDamage <= 0) {
      return { growth: [], rounded: points };
    }
    // Largest share first, and equal shares broken by the lower entity id: the order the remainder is
    // handed out in has to be the same on every run of the same commands, or two replays of one match
    // would leave two different towers one kill apart.
    const ordered = [...enemy.damageByTower.entries()]
      .filter(([, damage]) => damage > 0)
      .sort((left, right) => right[1] - left[1] || left[0] - right[0]);
    const growth: GrowthCredit[] = [];
    let credited = 0;
    for (const [towerEntityId, damage] of ordered) {
      const share = (damage / totalDamage) * points;
      const kills = Math.floor(share);
      credited += kills;
      this.towerById(towerEntityId).kills += kills;
      growth.push({ towerEntityId, damage, share, kills });
    }
    const rounded = points - credited;
    if (rounded > 0) {
      const leader = growth[0] as GrowthCredit;
      leader.kills += rounded;
      this.towerById(leader.towerEntityId).kills += rounded;
    }
    return { growth, rounded };
  }

  private towerById(entityId: number): TowerState {
    const tower = this.state.towers.find((candidate) => candidate.entityId === entityId);
    if (!tower) {
      throw new Error(`Tower ${entityId} was credited a kill it is no longer on the board for`);
    }
    return tower;
  }

  private removeDefeatedEnemies(): void {
    const survivors: EnemyState[] = [];
    for (const enemy of this.state.enemies) {
      if (enemy.health > 0) {
        survivors.push(enemy);
        continue;
      }
      this.state.gold += enemy.reward;
      const { growth, rounded } = this.creditGrowth(enemy);
      this.events.push({ type: 'enemyKilled', entityId: enemy.entityId, reward: enemy.reward, growth, rounded });
    }
    this.state.enemies = survivors;
  }
}

export function createSimulation(config: MatchConfig): Simulation {
  return new Simulation(config);
}
