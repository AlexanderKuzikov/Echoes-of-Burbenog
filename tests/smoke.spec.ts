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
  status: DebugReading['snapshot']['status'];
  snapshotGold: number;
  snapshotEnemyCount: number;
  snapshotIntegrity: string;
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
    const startWave = document.querySelector<HTMLButtonElement>('[data-testid="start-wave"]');
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
      status: snapshot.status,
      snapshotGold: snapshot.gold,
      snapshotEnemyCount: snapshot.enemies.length,
      snapshotIntegrity: `${integrity}%`,
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
  expect(armedHud.phaseTimer).toMatch(/^T-\d{2}:\d{2}$/);
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

  await page.screenshot({ path: 'test-results/wave-combat-defeat.png', fullPage: true });
});
