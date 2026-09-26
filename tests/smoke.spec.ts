import { test, expect, type Page } from '@playwright/test';
import { createTrainingScenario } from '../src/game-core/index.ts';

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
const killRewards = scenario.waves[0].groups.reduce((total, group) => {
  const enemy = scenario.enemies.find((entry) => entry.id === group.enemyId);
  return total + (enemy?.reward ?? 0) * group.count;
}, 0);
const victoryGold = placedGold + killRewards + scenario.rules.waveBounty;

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
  rendered: { pads: number; towers: number; enemies: number; routeSegments: number };
  towerPositions: Array<{ x: number; z: number }>;
  enemyPositions: Array<{ x: number; z: number }>;
  snapshot: NonNullable<typeof window.__ECHOES_DEBUG__>['snapshot'];
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
      rendered: debug.rendered,
      towerPositions: debug.towerPositions,
      enemyPositions: debug.enemyPositions,
      snapshot: debug.snapshot,
    };
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
