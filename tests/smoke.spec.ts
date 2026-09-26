import { test, expect, type Page } from '@playwright/test';
import { createTrainingScenario } from '../src/game-core/index.ts';
import type { SimulationEvent } from '../src/game-core/index.ts';

const scenario = createTrainingScenario();
const padById = new Map(scenario.map.buildPads.map((pad) => [pad.id, pad]));
const routeSegmentCount = scenario.map.routes.reduce((total, route) => total + route.points.length - 1, 0);
const firstWavePrepTicks = scenario.waves[0].prepTicks;
const placements = [
  { padId: 'pad-east', towerId: 'pulse-spire' },
  { padId: 'pad-north', towerId: 'grove-lens' },
  { padId: 'pad-south', towerId: 'frost-relay' },
] as const;
const placementCost = placements.reduce((total, placement) => {
  return total + (scenario.towers.find((tower) => tower.id === placement.towerId)?.cost ?? 0);
}, 0);
const startingGold = scenario.rules.startingGold;
const placedGold = startingGold - placementCost;
const waveEnemyCount = scenario.waves[0].groups.reduce((total, group) => total + group.count, 0);
const killRewards = scenario.waves[0].groups.reduce((total, group) => {
  const enemy = scenario.enemies.find((entry) => entry.id === group.enemyId);
  return total + (enemy?.reward ?? 0) * group.count;
}, 0);
const victoryGold = placedGold + killRewards + scenario.rules.waveBounty;
const costOf = (towerId: string) => scenario.towers.find((tower) => tower.id === towerId)?.cost ?? 0;

type MatchReport = NonNullable<typeof window.__ECHOES_DEBUG__>['matchReports'][number];

type DebugReading = {
  ready: boolean;
  objectCount: number;
  seed: number;
  tickRate: number;
  mapId: string;
  routeIds: string[];
  padIds: string[];
  waveCount: number;
  eventsDrained: number;
  selectedTowerId: string;
  feedback: { state: string; message: string; reason: string | null };
  rendered: { pads: number; towers: number; enemies: number; routeSegments: number };
  towerPositions: Array<{ x: number; z: number }>;
  enemyPositions: Array<{ x: number; z: number }>;
  padScreenPositions: Array<{ padId: string; x: number; y: number }>;
  eventCounts: Record<SimulationEvent['type'], number>;
  recentEvents: SimulationEvent[];
  paused: boolean;
  reducedMotion: boolean;
  replaying: boolean;
  replayIndex: number;
  commandCount: number;
  matchReports: MatchReport[];
  motion: { reducedMotion: boolean; combatBursts: number; enemyBob: number };
  snapshot: NonNullable<typeof window.__ECHOES_DEBUG__>['snapshot'];
};

type HudReading = {
  gold: string | null;
  integrity: string | null;
  waveStatus: string | null;
  phase: string | null;
  phaseLabel: string | null;
  phaseTimer: string | null;
  phaseTimerKind: string | null;
  enemyCount: string | null;
  objectiveDetail: string | null;
  resultHidden: boolean | null;
  result: string | null;
  feedTypes: string[];
  startWaveDisabled: boolean;
  pauseLabel: string | null;
  pausePressed: string | null;
  pauseDisabled: boolean;
  restartDisabled: boolean;
  stateState: string | null;
  stateHidden: boolean | null;
  viewportPaused: string | null;
  viewportReplay: string | null;
  status: DebugReading['snapshot']['status'];
  snapshotGold: number;
  snapshotEnemyCount: number;
  snapshotIntegrity: string;
  preparationTicksLeft: number;
};

const readDebug = (page: Page) =>
  page.evaluate((): DebugReading | null => {
    const debug = window.__ECHOES_DEBUG__;
    if (!debug) {
      return null;
    }
    return {
      ready: debug.ready,
      objectCount: debug.objectCount,
      seed: debug.seed,
      tickRate: debug.tickRate,
      mapId: debug.mapId,
      routeIds: debug.routeIds,
      padIds: debug.padIds,
      waveCount: debug.waveCount,
      eventsDrained: debug.eventsDrained,
      selectedTowerId: debug.selectedTowerId,
      feedback: debug.feedback,
      rendered: debug.rendered,
      towerPositions: debug.towerPositions,
      enemyPositions: debug.enemyPositions,
      padScreenPositions: debug.padScreenPositions,
      eventCounts: debug.eventCounts,
      recentEvents: debug.recentEvents,
      paused: debug.paused,
      reducedMotion: debug.reducedMotion,
      replaying: debug.replaying,
      replayIndex: debug.replayIndex,
      commandCount: debug.commandCount,
      matchReports: debug.matchReports,
      motion: debug.motion,
      snapshot: debug.snapshot,
    };
  });

// Reads the HUD and the snapshot inside a single task, so the assertion cannot race
// the fixed-step loop that keeps updating both between evaluations.
const readHud = (page: Page) =>
  page.evaluate((): HudReading | null => {
    const debug = window.__ECHOES_DEBUG__;
    if (!debug) {
      return null;
    }
    const text = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    const attribute = (testId: string, name: string) =>
      document.querySelector(`[data-testid="${testId}"]`)?.getAttribute(name) ?? null;
    const banner = document.querySelector<HTMLElement>('[data-testid="match-result"]');
    const badge = document.querySelector<HTMLElement>('[data-testid="state-badge"]');
    const startWave = document.querySelector<HTMLButtonElement>('[data-testid="start-wave"]');
    const pause = document.querySelector<HTMLButtonElement>('[data-testid="pause-toggle"]');
    const restart = document.querySelector<HTMLButtonElement>('[data-testid="restart-match"]');
    const viewport = document.querySelector<HTMLElement>('[data-testid="viewport"]');
    const snapshot = debug.snapshot;
    const integrity = snapshot.maxCoreHealth > 0 ? Math.round((snapshot.coreHealth / snapshot.maxCoreHealth) * 100) : 0;
    return {
      gold: text('gold-value'),
      integrity: text('core-integrity'),
      waveStatus: text('wave-status'),
      phase: attribute('match-phase', 'data-phase'),
      phaseLabel: text('match-phase'),
      phaseTimer: text('phase-timer'),
      phaseTimerKind: attribute('phase-timer', 'data-kind'),
      enemyCount: text('enemy-count'),
      objectiveDetail: text('objective-detail'),
      resultHidden: banner ? banner.hasAttribute('hidden') : null,
      result: banner?.dataset.result ?? null,
      feedTypes: Array.from(document.querySelectorAll('[data-testid="event-feed"] li'), (item) =>
        (item as HTMLElement).dataset.eventType ?? '',
      ),
      startWaveDisabled: startWave?.disabled ?? false,
      pauseLabel: text('pause-toggle'),
      pausePressed: attribute('pause-toggle', 'aria-pressed'),
      pauseDisabled: pause?.disabled ?? false,
      restartDisabled: restart?.disabled ?? false,
      stateState: badge?.dataset.state ?? null,
      stateHidden: badge ? badge.hasAttribute('hidden') : null,
      viewportPaused: viewport?.dataset.paused ?? null,
      viewportReplay: viewport?.dataset.replay ?? null,
      status: snapshot.status,
      snapshotGold: snapshot.gold,
      snapshotEnemyCount: snapshot.enemies.length,
      snapshotIntegrity: `${integrity}%`,
      preparationTicksLeft: snapshot.preparationTicksLeft,
    };
  });

const readDebugOrThrow = async (page: Page): Promise<DebugReading> => {
  const reading = await readDebug(page);
  if (!reading) {
    throw new Error('debug contract missing');
  }
  return reading;
};

const clickPad = async (page: Page, padId: string) => {
  const canvas = page.getByTestId('scene-canvas');
  const box = await canvas.boundingBox();
  if (!box) {
    throw new Error('scene canvas has no layout box');
  }
  const point = await page.evaluate(
    (id) => window.__ECHOES_DEBUG__?.padScreenPositions.find((entry) => entry.padId === id) ?? null,
    padId,
  );
  if (!point) {
    throw new Error(`pad ${padId} has no screen position`);
  }
  await page.mouse.click(box.x + point.x, box.y + point.y);
};

const armDefendedWave = async (page: Page) => {
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-north');
  await page.getByRole('button', { name: 'Frost Relay' }).click();
  await clickPad(page, 'pad-south');
};

const emptyEventCounts = (): Record<SimulationEvent['type'], number> => ({
  towerPlaced: 0,
  preparationEnded: 0,
  waveStarted: 0,
  enemySpawned: 0,
  towerFired: 0,
  enemyKilled: 0,
  coreDamaged: 0,
  waveCleared: 0,
  victory: 0,
  defeat: 0,
});

const expectProjectionMatchesSnapshot = (debug: DebugReading) => {
  expect(debug.rendered.pads).toBe(Object.keys(debug.snapshot.pads).length);
  expect(debug.rendered.towers).toBe(debug.snapshot.towers.length);
  expect(debug.rendered.enemies).toBe(debug.snapshot.enemies.length);
  debug.snapshot.enemies.forEach((enemy, index) => {
    expect(debug.enemyPositions[index]?.x).toBeCloseTo(enemy.x, 3);
    expect(debug.enemyPositions[index]?.z).toBeCloseTo(enemy.z, 3);
  });
  debug.snapshot.towers.forEach((tower, index) => {
    const pad = padById.get(tower.padId);
    expect(pad).toBeDefined();
    expect(debug.towerPositions[index]?.x).toBeCloseTo(pad?.position.x ?? 0, 3);
    expect(debug.towerPositions[index]?.z).toBeCloseTo(pad?.position.z ?? 0, 3);
  });
};

test('renders the first 3D-ready scene and accepts build selection', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByTestId('game-title')).toHaveText('First Contact');
  await expect(page.getByTestId('scene-status')).toHaveText('Scene online');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const debugState = await readDebug(page);

  expect(debugState?.ready).toBe(true);
  expect(debugState?.objectCount).toBeGreaterThan(0);

  const webglAvailable = await page.getByTestId('scene-canvas').evaluate((element) => {
    return Boolean((element as HTMLCanvasElement).getContext('webgl2'));
  });

  expect(webglAvailable).toBe(true);

  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await expect(page.getByTestId('selection-status')).toHaveText('Grove Lens ready');
  await expect(page.getByRole('button', { name: 'Grove Lens' })).toHaveAttribute('aria-pressed', 'true');

  await page.screenshot({ path: 'test-results/bootstrap.png', fullPage: true });
});

test('drives presentation from MatchSnapshot without duplicated state', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > 0);

  const initial = await readDebug(page);
  if (!initial) {
    throw new Error('debug contract missing');
  }

  expect(initial.seed).toBe(scenario.seed);
  expect(initial.tickRate).toBe(20);
  expect(initial.mapId).toBe(scenario.map.id);
  expect(initial.routeIds).toEqual(scenario.map.routes.map((route) => route.id));
  expect(initial.padIds).toEqual(scenario.map.buildPads.map((pad) => pad.id));
  expect(initial.waveCount).toBe(scenario.waves.length);

  expect(initial.snapshot.version).toBe(1);
  expect(initial.snapshot.status).toBe('preparation');
  expect(initial.snapshot.gold).toBe(startingGold);
  expect(initial.snapshot.rngState).toBe(scenario.seed);
  expect(initial.snapshot.coreHealth).toBe(initial.snapshot.maxCoreHealth);
  expect(initial.snapshot.towers).toEqual([]);
  expect(initial.snapshot.enemies).toEqual([]);
  expect(Object.keys(initial.snapshot.pads).sort()).toEqual([...initial.padIds].sort());
  expect(initial.snapshot.preparationTicksLeft).toBe(Math.max(0, firstWavePrepTicks - initial.snapshot.tick));

  expect(initial.rendered.routeSegments).toBe(routeSegmentCount);
  expectProjectionMatchesSnapshot(initial);

  await expect(page.getByTestId('gold-value')).toHaveText(String(startingGold));
  await expect(page.getByTestId('core-integrity')).toHaveText('100%');
  await expect(page.getByTestId('wave-status')).toHaveText('01 / 01');

  for (const placement of placements) {
    const result = await page.evaluate(
      (command) => window.__ECHOES_DEBUG__?.dispatch(command),
      { type: 'placeTower' as const, padId: placement.padId, towerId: placement.towerId },
    );
    expect(result).toEqual({ accepted: true });
  }

  const placed = await readDebug(page);
  if (!placed) {
    throw new Error('debug contract missing');
  }
  expect(placed.snapshot.towers).toHaveLength(placements.length);
  expect(placed.snapshot.gold).toBe(placedGold);
  placements.forEach((placement) => {
    expect(placed.snapshot.pads[placement.padId]).toBe(placement.towerId);
  });
  expectProjectionMatchesSnapshot(placed);
  await expect(page.getByTestId('gold-value')).toHaveText(String(placedGold));

  const waveStart = await page.evaluate(() => window.__ECHOES_DEBUG__?.dispatch({ type: 'startWave' }));
  expect(waveStart).toEqual({ accepted: true });

  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) >= 3);
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventsDrained ?? 0) > 0);

  const active = await readDebug(page);
  if (!active) {
    throw new Error('debug contract missing');
  }
  expect(active.snapshot.status).toBe('wave');
  expect(active.snapshot.waveIndex).toBe(0);
  expect(active.snapshot.waveTick).toBeGreaterThan(0);
  expect(active.snapshot.lastWaveRoll).not.toBeNull();
  expect(active.snapshot.enemies.length).toBeGreaterThan(0);
  expect(active.snapshot.enemies[0]?.x).toBeLessThanOrEqual(6.5);
  expectProjectionMatchesSnapshot(active);

  await page.waitForFunction(
    (tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick,
    active.snapshot.tick,
  );

  const advanced = await readDebug(page);
  if (!advanced) {
    throw new Error('debug contract missing');
  }
  expect(advanced.snapshot.tick).toBeGreaterThan(active.snapshot.tick);
  expectProjectionMatchesSnapshot(advanced);

  await page.screenshot({ path: 'test-results/snapshot-binding.png', fullPage: true });

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 60_000,
  });

  const finished = await readDebug(page);
  if (!finished) {
    throw new Error('debug contract missing');
  }
  expect(finished.snapshot.status).toBe('victory');
  expect(finished.snapshot.enemies).toEqual([]);
  expect(finished.snapshot.towers).toHaveLength(placements.length);
  expect(finished.snapshot.gold).toBe(victoryGold);
  expect(finished.snapshot.leaksThisWave).toBe(0);
  expect(finished.snapshot.coreHealth).toBe(finished.snapshot.maxCoreHealth);
  expect(finished.rendered.enemies).toBe(0);
  expect(finished.rendered.towers).toBe(placements.length);
  expectProjectionMatchesSnapshot(finished);
  await expect(page.getByTestId('core-integrity')).toHaveText('100%');
  await expect(page.getByTestId('gold-value')).toHaveText(String(victoryGold));
});

test('places the selected tower on a clicked build pad through the command contract', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const initial = await readDebugOrThrow(page);
  expect(initial.selectedTowerId).toBe('pulse-spire');
  expect(initial.feedback.state).toBe('idle');
  expect(initial.snapshot.towers).toEqual([]);
  expect(initial.snapshot.pads['pad-east']).toBeNull();
  expect(initial.padScreenPositions.map((entry) => entry.padId).sort()).toEqual([...initial.padIds].sort());
  await expect(page.getByTestId('gold-value')).toHaveText(String(startingGold));

  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await expect(page.getByRole('button', { name: 'Grove Lens' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Pulse Spire' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('selection-status')).toHaveText('Grove Lens ready');
  await expect(page.getByTestId('selection-card-name')).toHaveText('Grove Lens');

  const groveLensGold = startingGold - costOf('grove-lens');
  await clickPad(page, 'pad-east');

  const placed = await readDebugOrThrow(page);
  expect(placed.snapshot.pads['pad-east']).toBe('grove-lens');
  expect(placed.snapshot.towers).toHaveLength(1);
  expect(placed.snapshot.towers[0]?.towerId).toBe('grove-lens');
  expect(placed.snapshot.towers[0]?.padId).toBe('pad-east');
  expect(placed.snapshot.gold).toBe(groveLensGold);
  expect(placed.rendered.towers).toBe(1);
  expect(placed.towerPositions[0]?.x).toBeCloseTo(padById.get('pad-east')?.position.x ?? 0, 3);
  expect(placed.towerPositions[0]?.z).toBeCloseTo(padById.get('pad-east')?.position.z ?? 0, 3);
  expect(placed.feedback).toEqual({
    state: 'accepted',
    message: 'Grove Lens built on pad-east',
    reason: null,
  });
  await expect(page.getByTestId('gold-value')).toHaveText(String(groveLensGold));
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');

  await clickPad(page, 'pad-east');

  const occupied = await readDebugOrThrow(page);
  expect(occupied.snapshot.pads['pad-east']).toBe('grove-lens');
  expect(occupied.snapshot.towers).toHaveLength(1);
  expect(occupied.snapshot.gold).toBe(groveLensGold);
  expect(occupied.rendered.towers).toBe(1);
  expect(occupied.feedback.state).toBe('rejected');
  expect(occupied.feedback.reason).toBe('pad-occupied');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-reason', 'pad-occupied');
  await expect(page.getByTestId('command-feedback')).toHaveText('Pad already occupied');
  await expect(page.getByTestId('gold-value')).toHaveText(String(groveLensGold));

  await page.getByRole('button', { name: 'Frost Relay' }).click();
  await clickPad(page, 'pad-north');
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-south');

  const filled = await readDebugOrThrow(page);
  const affordableGold = groveLensGold - costOf('frost-relay') - costOf('pulse-spire');
  expect(filled.snapshot.pads['pad-north']).toBe('frost-relay');
  expect(filled.snapshot.pads['pad-south']).toBe('pulse-spire');
  expect(filled.snapshot.pads['pad-core']).toBeNull();
  expect(filled.snapshot.towers).toHaveLength(3);
  expect(filled.snapshot.gold).toBe(affordableGold);
  expect(filled.rendered.towers).toBe(3);
  expect(costOf('grove-lens')).toBeGreaterThan(affordableGold);
  await expect(page.getByTestId('gold-value')).toHaveText(String(affordableGold));

  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-core');

  const broke = await readDebugOrThrow(page);
  expect(broke.snapshot.pads['pad-core']).toBeNull();
  expect(broke.snapshot.towers).toHaveLength(3);
  expect(broke.snapshot.gold).toBe(affordableGold);
  expect(broke.rendered.towers).toBe(3);
  expect(broke.feedback.state).toBe('rejected');
  expect(broke.feedback.reason).toBe('not-enough-gold');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-reason', 'not-enough-gold');
  await expect(page.getByTestId('command-feedback')).toHaveText('Not enough aether');
  await expect(page.getByTestId('gold-value')).toHaveText(String(affordableGold));

  // The pad rejection flash is a short cosmetic pulse; let the earlier one expire
  // so the screenshot only shows the flash of the final rejected pad.
  await page.waitForTimeout(900);
  // By now the short prep window is over, so the phase clock reports the neutral state.
  await expect(page.getByTestId('phase-timer')).toHaveText('Awaiting start');
  await page.screenshot({ path: 'test-results/build-pad-placement.png', fullPage: true });
});

test('plays a defended wave from real clicks and reports victory from the snapshot', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-north');
  await page.getByRole('button', { name: 'Frost Relay' }).click();
  await clickPad(page, 'pad-south');

  const armed = await readDebugOrThrow(page);
  expect(armed.snapshot.status).toBe('preparation');
  expect(armed.snapshot.towers).toHaveLength(placements.length);
  expect(armed.snapshot.gold).toBe(placedGold);
  expect(armed.rendered.towers).toBe(placements.length);
  expect(armed.eventCounts.towerPlaced).toBe(placements.length);
  expect(armed.eventCounts.waveStarted).toBe(0);

  const armedHud = await readHud(page);
  if (!armedHud) {
    throw new Error('hud contract missing');
  }
  expect(armedHud.phase).toBe('preparation');
  expect(armedHud.phaseLabel).toBe('Preparation');
  expect(armedHud.phaseTimerKind).toBe('preparation');
  // The content prep window is short: once it elapses the clock must read as a neutral
  // awaiting-start label instead of a frozen `T-00:00` that looks like a live timer.
  expect(armedHud.phaseTimer).toMatch(/^(T-\d{2}:\d{2}|Awaiting start)$/);
  expect(armedHud.phaseTimer === 'Awaiting start').toBe(armedHud.preparationTicksLeft === 0);
  expect(armedHud.enemyCount).toBe('0');
  expect(armedHud.gold).toBe(String(placedGold));
  expect(armedHud.resultHidden).toBe(true);
  expect(armedHud.startWaveDisabled).toBe(false);
  await expect(page.getByTestId('match-result')).toBeHidden();

  await page.getByTestId('start-wave').click();

  const started = await readDebugOrThrow(page);
  expect(started.snapshot.status).toBe('wave');
  expect(started.snapshot.waveIndex).toBe(0);
  // The wave clock is read after the click round-trip, so only assert the wave is
  // young: a long clock would mean something other than this click started it.
  expect(started.snapshot.waveTick).toBeLessThan(40);
  expect(started.snapshot.lastWaveRoll).not.toBeNull();
  expect(started.snapshot.leaksThisWave).toBe(0);
  expect(started.eventCounts.waveStarted).toBe(1);
  expect(started.feedback).toEqual({
    state: 'accepted',
    message: 'Wave 1 started',
    reason: null,
  });
  const startedHud = await readHud(page);
  expect(startedHud?.phase).toBe('wave');
  expect(startedHud?.phaseLabel).toBe('Wave active');
  expect(startedHud?.phaseTimerKind).toBe('wave');
  expect(startedHud?.phaseTimer).toMatch(/^W\+\d{2}:\d{2}$/);
  expect(startedHud?.startWaveDisabled).toBe(true);
  expect(startedHud?.feedTypes).toContain('waveStarted');
  await expect(page.getByTestId('start-wave')).toBeDisabled();

  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0);
  const active = await readDebugOrThrow(page);
  const tracked = active.snapshot.enemies[0];
  if (!tracked) {
    throw new Error('expected a spawned enemy in the snapshot');
  }
  expect(active.snapshot.status).toBe('wave');
  expect(active.snapshot.waveTick).toBeGreaterThan(0);
  expect(active.eventCounts.enemySpawned).toBeGreaterThan(0);
  expect(active.recentEvents.some((event) => event.type === 'enemySpawned')).toBe(true);
  expectProjectionMatchesSnapshot(active);

  const activeHud = await readHud(page);
  if (!activeHud) {
    throw new Error('hud contract missing');
  }
  expect(activeHud.enemyCount).toBe(String(activeHud.snapshotEnemyCount));
  expect(activeHud.gold).toBe(String(activeHud.snapshotGold));
  expect(activeHud.integrity).toBe(activeHud.snapshotIntegrity);
  expect(activeHud.objectiveDetail).toBe('Leaks 0');
  expect(activeHud.feedTypes).toContain('enemySpawned');

  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.towerFired ?? 0) > 0);
  await page.waitForFunction(
    (tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick + 4,
    active.snapshot.tick,
  );

  const fighting = await readDebugOrThrow(page);
  const advanced = fighting.snapshot.enemies.find((enemy) => enemy.entityId === tracked.entityId);
  expect(advanced?.distance).toBeGreaterThan(tracked.distance);
  expect(advanced?.x).toBeLessThan(tracked.x);
  expect(fighting.snapshot.enemies.some((enemy) => enemy.health < enemy.maxHealth)).toBe(true);
  expect(fighting.eventCounts.towerFired).toBeGreaterThan(0);
  expect(fighting.snapshot.towers).toHaveLength(placements.length);
  expectProjectionMatchesSnapshot(fighting);

  await page.screenshot({ path: 'test-results/wave-combat-midwave.png', fullPage: true });

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 60_000,
  });

  const finished = await readDebugOrThrow(page);
  expect(finished.eventCounts.enemySpawned).toBe(waveEnemyCount);
  expect(finished.eventCounts.enemyKilled).toBe(waveEnemyCount);
  expect(finished.eventCounts.waveCleared).toBe(1);
  expect(finished.eventCounts.victory).toBe(1);
  expect(finished.eventCounts.coreDamaged).toBe(0);
  expect(finished.eventCounts.defeat).toBe(0);
  expect(finished.recentEvents.some((event) => event.type === 'victory')).toBe(true);
  expect(finished.snapshot.gold).toBe(victoryGold);
  expect(finished.snapshot.leaksThisWave).toBe(0);
  expect(finished.snapshot.enemies).toEqual([]);
  expect(finished.snapshot.towers).toHaveLength(placements.length);
  expect(finished.rendered.enemies).toBe(0);
  expect(finished.rendered.towers).toBe(placements.length);
  expectProjectionMatchesSnapshot(finished);

  const finishedHud = await readHud(page);
  if (!finishedHud) {
    throw new Error('hud contract missing');
  }
  expect(finishedHud.phase).toBe('victory');
  expect(finishedHud.phaseLabel).toBe('Victory');
  expect(finishedHud.phaseTimer).toBe('Cleared');
  expect(finishedHud.enemyCount).toBe('0');
  expect(finishedHud.objectiveDetail).toBe('Objective complete');
  expect(finishedHud.gold).toBe(String(victoryGold));
  expect(finishedHud.integrity).toBe('100%');
  expect(finishedHud.resultHidden).toBe(false);
  expect(finishedHud.result).toBe('victory');
  expect(finishedHud.feedTypes).toContain('victory');
  expect(finishedHud.startWaveDisabled).toBe(true);
  await expect(page.getByTestId('match-result')).toBeVisible();
  await expect(page.getByTestId('match-result')).toHaveText('Sector secured');
  await expect(page.getByTestId('event-feed')).toContainText('Sector secured');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-phase', 'victory');

  await page.screenshot({ path: 'test-results/wave-combat-victory.png', fullPage: true });
});

test('reports defeat when an undefended wave reaches the core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const initial = await readDebugOrThrow(page);
  expect(initial.snapshot.towers).toEqual([]);
  expect(initial.snapshot.status).toBe('preparation');

  await page.getByTestId('start-wave').click();

  const started = await readDebugOrThrow(page);
  expect(started.snapshot.status).toBe('wave');
  expect(started.eventCounts.waveStarted).toBe(1);
  expect(started.eventCounts.towerFired).toBe(0);

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'defeat', undefined, {
    timeout: 90_000,
  });

  const finished = await readDebugOrThrow(page);
  expect(finished.snapshot.coreHealth).toBe(0);
  expect(finished.snapshot.enemies).toEqual([]);
  expect(finished.snapshot.leaksThisWave).toBe(scenario.map.coreHealth);
  expect(finished.rendered.enemies).toBe(0);
  expect(finished.rendered.towers).toBe(0);
  expect(finished.eventCounts.coreDamaged).toBe(scenario.map.coreHealth);
  expect(finished.eventCounts.enemyKilled).toBe(0);
  expect(finished.eventCounts.waveCleared).toBe(0);
  expect(finished.eventCounts.defeat).toBe(1);
  expect(finished.eventCounts.victory).toBe(0);
  expect(finished.recentEvents.some((event) => event.type === 'defeat')).toBe(true);

  const finishedHud = await readHud(page);
  if (!finishedHud) {
    throw new Error('hud contract missing');
  }
  expect(finishedHud.phase).toBe('defeat');
  expect(finishedHud.phaseLabel).toBe('Defeat');
  expect(finishedHud.phaseTimer).toBe('Breached');
  expect(finishedHud.integrity).toBe('0%');
  expect(finishedHud.objectiveDetail).toBe('Core lost on wave 1');
  expect(finishedHud.result).toBe('defeat');
  expect(finishedHud.feedTypes).toContain('defeat');
  expect(finishedHud.startWaveDisabled).toBe(true);
  await expect(page.getByTestId('match-result')).toBeVisible();
  await expect(page.getByTestId('match-result')).toHaveText('Core breached');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-phase', 'defeat');

  // The result outranks the stale `Wave 1 started` command feedback, and the copy does
  // not promise a different outcome than the deterministic restart can give.
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'terminal');
  await expect(page.getByTestId('command-feedback')).toHaveText('Core breached · restart repeats this run exactly');

  await page.screenshot({ path: 'test-results/wave-combat-defeat.png', fullPage: true });
});

test('freezes and resumes the fixed-step clock without drift', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0);
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.towerFired ?? 0) > 0);

  await expect(page.getByTestId('pause-toggle')).toHaveText('Pause');
  await expect(page.getByTestId('state-badge')).toBeHidden();
  await page.getByTestId('pause-toggle').click();

  const frozen = await readDebugOrThrow(page);
  expect(frozen.paused).toBe(true);
  expect(frozen.snapshot.status).toBe('wave');
  expect(frozen.snapshot.waveTick).toBeGreaterThan(0);
  expect(frozen.snapshot.enemies.length).toBeGreaterThan(0);
  await expect(page.getByTestId('pause-toggle')).toHaveText('Resume');
  await expect(page.getByTestId('pause-toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-paused', 'true');
  await expect(page.getByTestId('state-badge')).toBeVisible();
  await expect(page.getByTestId('state-badge')).toHaveText('Paused');
  const frozenHud = await readHud(page);
  if (!frozenHud) {
    throw new Error('hud contract missing');
  }
  expect(frozenHud.pauseDisabled).toBe(false);
  expect(frozenHud?.pausePressed).toBe('true');
  expect(frozenHud?.stateState).toBe('paused');
  expect(frozenHud?.stateHidden).toBe(false);
  expect(frozenHud?.viewportPaused).toBe('true');
  expect(frozenHud?.viewportReplay).toBe('idle');
  expect(frozenHud?.enemyCount).toBe(String(frozenHud.snapshotEnemyCount));
  expectProjectionMatchesSnapshot(frozen);

  await page.waitForTimeout(1200);

  const held = await readDebugOrThrow(page);
  expect(held.snapshot.tick).toBe(frozen.snapshot.tick);
  expect(held.snapshot.waveTick).toBe(frozen.snapshot.waveTick);
  expect(held.snapshot.rngState).toBe(frozen.snapshot.rngState);
  expect(held.snapshot.enemies).toEqual(frozen.snapshot.enemies);
  expect(held.enemyPositions).toEqual(frozen.enemyPositions);
  expect(held.towerPositions).toEqual(frozen.towerPositions);
  expect(held.rendered).toEqual(frozen.rendered);
  expect(held.eventCounts).toEqual(frozen.eventCounts);
  expect(held.recentEvents).toEqual(frozen.recentEvents);
  expectProjectionMatchesSnapshot(held);

  await page.screenshot({ path: 'test-results/vertical-slice-paused.png', fullPage: true });

  await page.getByTestId('pause-toggle').click();
  const resumed = await readDebugOrThrow(page);
  expect(resumed.paused).toBe(false);
  // The accumulator keeps its sub-tick remainder, so resuming must not fast-forward.
  expect(resumed.snapshot.tick).toBeLessThanOrEqual(frozen.snapshot.tick + 6);
  expect(resumed.snapshot.waveTick).toBeLessThanOrEqual(frozen.snapshot.waveTick + 6);
  await expect(page.getByTestId('state-badge')).toBeHidden();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-paused', 'false');
  await expect(page.getByTestId('pause-toggle')).toHaveText('Pause');

  await page.waitForTimeout(1000);

  const running = await readDebugOrThrow(page);
  const advanced = running.snapshot.tick - resumed.snapshot.tick;
  // 20 ticks per second: the clock has to run on, but not faster than real time.
  expect(advanced).toBeGreaterThanOrEqual(12);
  expect(advanced).toBeLessThanOrEqual(30);
  expect(running.snapshot.waveTick).toBeGreaterThan(frozen.snapshot.waveTick);
  expect(running.enemyPositions).not.toEqual(frozen.enemyPositions);
  expectProjectionMatchesSnapshot(running);
});

test('restarts from the same seed and replays the recorded command log', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  await expect(page.getByTestId('restart-match')).toBeDisabled();
  await armDefendedWave(page);
  await expect(page.getByTestId('restart-match')).toBeEnabled();
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const first = await readDebugOrThrow(page);
  expect(first.matchReports).toHaveLength(1);
  const firstReport = first.matchReports[0];
  expect(firstReport?.status).toBe('victory');
  expect(firstReport?.gold).toBe(victoryGold);
  expect(firstReport?.leaksThisWave).toBe(0);
  expect(firstReport?.coreHealth).toBe(scenario.map.coreHealth);
  expect(firstReport?.eventCounts.waveStarted).toBe(1);
  expect(firstReport?.eventCounts.victory).toBe(1);
  expect(firstReport?.eventCounts.towerPlaced).toBe(placements.length);
  expect(firstReport?.eventCounts.enemySpawned).toBe(waveEnemyCount);
  expect(firstReport?.eventCounts.enemyKilled).toBe(waveEnemyCount);
  expect(firstReport?.eventCounts.coreDamaged).toBe(0);
  expect(first.commandCount).toBe(placements.length + 1);
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'terminal');
  await expect(page.getByTestId('command-feedback')).toHaveText('Sector secured · restart repeats this run exactly');

  // Freeze the clock first so the restarted match can be inspected before the recorded
  // commands start landing on their original ticks.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('restart-match').click();

  const restarted = await readDebugOrThrow(page);
  expect(restarted.paused).toBe(true);
  expect(restarted.replaying).toBe(true);
  expect(restarted.replayIndex).toBe(0);
  expect(restarted.commandCount).toBe(placements.length + 1);
  expect(restarted.snapshot.status).toBe('preparation');
  expect(restarted.snapshot.tick).toBe(0);
  expect(restarted.snapshot.gold).toBe(startingGold);
  expect(restarted.snapshot.rngState).toBe(scenario.seed);
  expect(restarted.snapshot.towers).toEqual([]);
  expect(restarted.snapshot.enemies).toEqual([]);
  expect(restarted.rendered.towers).toBe(0);
  expect(restarted.rendered.enemies).toBe(0);
  expect(restarted.eventCounts).toEqual(emptyEventCounts());
  expect(restarted.matchReports).toHaveLength(1);
  expect(restarted.motion.combatBursts).toBe(0);
  expectProjectionMatchesSnapshot(restarted);
  await expect(page.getByTestId('match-result')).toBeHidden();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-replay', 'running');
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-paused', 'true');
  // A replay that is also paused has to say so instead of showing one of the two states.
  await expect(page.getByTestId('state-badge')).toBeVisible();
  await expect(page.getByTestId('state-badge')).toHaveAttribute('data-state', 'paused-replay');
  await expect(page.getByTestId('state-badge')).toHaveText('Replay paused · 0 / 4 commands');
  await expect(page.getByTestId('start-wave')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Grove Lens' })).toBeDisabled();
  await expect(page.getByTestId('command-feedback')).toHaveText('Replaying recorded commands');
  await expect(page.getByTestId('gold-value')).toHaveText(String(startingGold));
  await page.screenshot({ path: 'test-results/vertical-slice-replay-reset.png', fullPage: true });

  await page.getByTestId('pause-toggle').click();
  await page.waitForFunction(
    (count) => (window.__ECHOES_DEBUG__?.snapshot.towers.length ?? 0) === count,
    placements.length,
    { timeout: 30_000 },
  );

  const replaying = await readDebugOrThrow(page);
  expect(replaying.replaying).toBe(true);
  expect(replaying.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(replaying.snapshot.pads['pad-north']).toBe('grove-lens');
  expect(replaying.snapshot.pads['pad-south']).toBe('frost-relay');
  expect(replaying.eventCounts.towerPlaced).toBe(placements.length);
  expectProjectionMatchesSnapshot(replaying);

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const second = await readDebugOrThrow(page);
  expect(second.matchReports).toHaveLength(2);
  expect(second.matchReports[1]).toEqual(firstReport);
  expect(second.snapshot.gold).toBe(victoryGold);
  expect(second.snapshot.status).toBe('victory');
  expect(second.replaying).toBe(false);
  expect(second.replayIndex).toBe(second.commandCount);
  expect(second.paused).toBe(false);
  expect(second.rendered.towers).toBe(placements.length);
  expect(second.rendered.enemies).toBe(0);
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-replay', 'idle');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'terminal');
  await expect(page.getByTestId('match-result')).toHaveText('Sector secured');
  await page.screenshot({ path: 'test-results/vertical-slice-replay-victory.png', fullPage: true });
});

test('rejects commands injected during replay and keeps the recorded run identical', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const recordedCommands = placements.length + 1;
  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const first = await readDebugOrThrow(page);
  expect(first.matchReports).toHaveLength(1);
  const firstReport = first.matchReports[0];
  expect(first.commandCount).toBe(recordedCommands);

  // Freeze the clock so the replay is inspected at replayIndex 0, where a command that
  // slipped past the guard would land on tick 0 and fork the run before it even starts.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('restart-match').click();

  const restarted = await readDebugOrThrow(page);
  expect(restarted.paused).toBe(true);
  expect(restarted.replaying).toBe(true);
  expect(restarted.replayIndex).toBe(0);
  expect(restarted.commandCount).toBe(recordedCommands);

  const injectedPlacement = await page.evaluate(() =>
    window.__ECHOES_DEBUG__?.dispatch({ type: 'placeTower', padId: 'pad-core', towerId: 'pulse-spire' }),
  );
  expect(injectedPlacement).toEqual({ accepted: false, reason: 'replay-in-progress' });
  const injectedWave = await page.evaluate(() => window.__ECHOES_DEBUG__?.dispatch({ type: 'startWave' }));
  expect(injectedWave).toEqual({ accepted: false, reason: 'replay-in-progress' });
  // The real input path goes through the same choke point and is refused the same way.
  await clickPad(page, 'pad-core');
  await expect(page.getByTestId('start-wave')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pulse Spire' })).toBeDisabled();
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-reason', 'replay-in-progress');

  const afterInjection = await readDebugOrThrow(page);
  expect(afterInjection.commandCount).toBe(recordedCommands);
  expect(afterInjection.replayIndex).toBe(0);
  expect(afterInjection.snapshot.tick).toBe(0);
  expect(afterInjection.snapshot.status).toBe('preparation');
  expect(afterInjection.snapshot.gold).toBe(startingGold);
  expect(afterInjection.snapshot.pads['pad-core']).toBeNull();
  expect(afterInjection.snapshot.pads['pad-east']).toBeNull();
  expect(afterInjection.snapshot.towers).toEqual([]);
  expect(afterInjection.rendered.towers).toBe(0);
  expect(afterInjection.eventCounts).toEqual(emptyEventCounts());
  expect(afterInjection.feedback).toEqual({
    state: 'rejected',
    message: 'Recorded run is replaying · commands are locked until it finishes',
    reason: 'replay-in-progress',
  });
  expectProjectionMatchesSnapshot(afterInjection);

  // Same guard once the replay is actually applying commands, where an extra entry would
  // be re-applied out of tick order and shift every later command.
  await page.getByTestId('pause-toggle').click();
  await page.waitForFunction(() => {
    const debug = window.__ECHOES_DEBUG__;
    return (debug?.replayIndex ?? 0) > 0 && debug?.replaying === true;
  });

  const midResult = await page.evaluate(() =>
    window.__ECHOES_DEBUG__?.dispatch({ type: 'placeTower', padId: 'pad-core', towerId: 'pulse-spire' }),
  );
  expect(midResult).toEqual({ accepted: false, reason: 'replay-in-progress' });
  const midReplay = await readDebugOrThrow(page);
  expect(midReplay.paused).toBe(false);
  expect(midReplay.commandCount).toBe(recordedCommands);
  expect(midReplay.replayIndex).toBeGreaterThan(0);
  expect(midReplay.replayIndex).toBeLessThan(recordedCommands);
  expect(midReplay.snapshot.pads['pad-core']).toBeNull();
  expect(midReplay.snapshot.towers.some((tower) => tower.padId === 'pad-core')).toBe(false);

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const second = await readDebugOrThrow(page);
  expect(second.commandCount).toBe(recordedCommands);
  expect(second.matchReports).toHaveLength(2);
  // The replayed match is bit-for-bit the run it reproduced, injections included not.
  expect(second.matchReports[1]).toEqual(firstReport);
  expect(second.snapshot.status).toBe('victory');
  expect(second.snapshot.gold).toBe(victoryGold);
  expect(second.snapshot.towers.every((tower) => tower.padId !== 'pad-core')).toBe(true);
  expect(second.replaying).toBe(false);
  expect(second.replayIndex).toBe(recordedCommands);
});

test('drops transient canvas effects under prefers-reduced-motion', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();

  const initial = await readDebugOrThrow(page);
  expect(initial.reducedMotion).toBe(true);
  expect(initial.motion.reducedMotion).toBe(true);

  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.enemyKilled ?? 0) > 0, undefined, {
    timeout: 60_000,
  });

  const fighting = await readDebugOrThrow(page);
  expect(fighting.snapshot.status).toBe('wave');
  expect(fighting.snapshot.enemies.length).toBeGreaterThan(0);
  expect(fighting.eventCounts.towerFired).toBeGreaterThan(0);
  // Kills happened, yet no burst rings, no aim snap and no idle drift are rendered.
  expect(fighting.motion.combatBursts).toBe(0);
  expect(fighting.motion.enemyBob).toBe(0);
  expect(fighting.reducedMotion).toBe(true);
  expectProjectionMatchesSnapshot(fighting);

  await page.waitForTimeout(500);

  const settled = await readDebugOrThrow(page);
  expect(settled.motion.combatBursts).toBe(0);
  expect(settled.motion.enemyBob).toBe(0);
  expect(settled.eventCounts.enemyKilled).toBeGreaterThan(0);
  // Static state stays readable: health bars and HUD still track the snapshot.
  const hud = await readHud(page);
  if (!hud) {
    throw new Error('hud contract missing');
  }
  expect(hud.phase).toBe('wave');
  expect(hud.enemyCount).toBe(String(hud.snapshotEnemyCount));
  expect(hud.gold).toBe(String(hud.snapshotGold));
  expect(hud.integrity).toBe(hud.snapshotIntegrity);
  expect(hud.feedTypes).toContain('enemySpawned');


  await page.screenshot({ path: 'test-results/vertical-slice-reduced-motion.png', fullPage: true });
});
