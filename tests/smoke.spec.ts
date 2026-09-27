import { test, expect, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTrainingScenario } from '../src/game-core/index.ts';
import type { SimulationEvent } from '../src/game-core/index.ts';
import { CONTENT_VERSION, DEFAULT_SESSION_PORT, MAP_VERSION, PROTOCOL_VERSION } from '../src/protocol/index.ts';
import { MODEL_BUDGET, SCENE_BUDGET } from '../src/asset-budgets.ts';

const GLB_MODEL_PATH = 'public/models/pulse-spire.glb';
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const align4 = (length: number) => length + ((4 - (length % 4)) % 4);

// Rewrites the generated model with `extra` more bones: the skin names them, the inverse bind
// matrices follow, and they are reachable from the scene so the loader builds them as Bones. This is
// the only honest way to reach a runtime refusal on the skeleton budget — the client measures the
// tree it loaded, so the file itself has to carry the rig that breaks the limit. The result is a
// plain glTF file, so nothing about the refusal depends on how it was produced.
const withExtraBones = (source: Buffer, extra: number): Buffer => {
  const jsonLength = source.readUInt32LE(12);
  const gltf = JSON.parse(source.subarray(20, 20 + jsonLength).toString('utf8').trim()) as {
    nodes: Array<Record<string, unknown>>;
    scenes: Array<{ nodes: number[] }>;
    skins: Array<{ joints: number[]; inverseBindMatrices: number }>;
    bufferViews: Array<Record<string, unknown>>;
    accessors: Array<Record<string, unknown>>;
    buffers: Array<{ byteLength: number }>;
  };
  const binHeader = 20 + jsonLength;
  const bin = source.subarray(binHeader + 8, binHeader + 8 + source.readUInt32LE(binHeader));

  // The inverse bind matrices have to keep up with the joints: the array is rewritten with the
  // matrices that are already in the buffer followed by one identity per new bone, so the bind pose
  // of the two bones the model shipped with is untouched.
  const bindAccessor = gltf.accessors[gltf.skins[0]!.inverseBindMatrices] as { bufferView: number; count: number };
  const bindView = gltf.bufferViews[bindAccessor.bufferView] as { byteOffset: number; byteLength: number };
  const existing = bin.subarray(bindView.byteOffset, bindView.byteOffset + bindView.byteLength);
  const added = new Float32Array(extra * 16);
  for (let bone = 0; bone < extra; bone += 1) {
    added.set(IDENTITY_MATRIX, bone * 16);
  }
  const matrices = Buffer.concat([existing, Buffer.from(added.buffer)]);
  const offset = align4(gltf.buffers[0]!.byteLength);
  const nextBin = Buffer.concat([bin.subarray(0, offset), matrices]);
  gltf.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: matrices.length });
  gltf.accessors.push({
    bufferView: gltf.bufferViews.length - 1,
    byteOffset: 0,
    componentType: 5126,
    count: bindAccessor.count + extra,
    type: 'MAT4',
  });
  gltf.skins[0]!.inverseBindMatrices = gltf.accessors.length - 1;
  for (let bone = 0; bone < extra; bone += 1) {
    const index = gltf.nodes.length;
    gltf.nodes.push({ name: `pad-bone-${bone}`, translation: [0, 0.1 * (bone + 1), 0] });
    gltf.scenes[0]!.nodes.push(index);
    gltf.skins[0]!.joints.push(index);
  }
  gltf.buffers[0]!.byteLength = nextBin.length;

  const json = Buffer.from(JSON.stringify(gltf), 'utf8');
  const jsonChunk = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const binChunk = nextBin;
  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const glb = Buffer.alloc(total);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(total, 8);
  glb.writeUInt32LE(jsonChunk.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(glb, 20);
  const patchedBinHeader = 20 + jsonChunk.length;
  glb.writeUInt32LE(binChunk.length, patchedBinHeader);
  glb.writeUInt32LE(0x004e4942, patchedBinHeader + 4);
  binChunk.copy(glb, patchedBinHeader + 8);
  return glb;
};

const sha256 = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const scenario = createTrainingScenario();
const padById = new Map(scenario.map.buildPads.map((pad) => [pad.id, pad]));
const routeSegmentCount = scenario.map.routes.reduce((total, route) => total + route.points.length - 1, 0);
const padCount = scenario.map.buildPads.length;
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

// A rebuilt run as the page read it on the tick the rebuild stopped on. It exists because a loaded
// match is live again by the time anything outside the page could ask, so the state it arrived at
// is captured where it happened — the same reason `matchReports` is captured in the page.
type RebuildReading = {
  requestedTick: number;
  tick: number;
  snapshot: NonNullable<typeof window.__ECHOES_DEBUG__>['snapshot'];
  eventCounts: Record<SimulationEvent['type'], number>;
  commandCount: number;
  replayIndex: number;
  replaying: boolean;
  matchReports: MatchReport[];
  poses: Array<{ entityId: number; towerId: string; clip: ClipReading | null }>;
};

type AssetBudgetsReading = NonNullable<typeof window.__ECHOES_DEBUG__>['assetBudgets'];

// A rebuild with no tick to stop on — Restart in solo, New match — is the same reading without the tick
// a slot asked for, and it is read for the same reason: the fresh preparation is running again before
// anything outside the page could ask about it, so where it started is only readable where it was built.
type FreshRunReading = Omit<RebuildReading, 'requestedTick'>;

// What the page says about the session it is in. In solo it is `local` and there is nothing to join; in
// a room it names the room, the connection and the versions both sides agreed on, and it carries the
// room's own sentence about anything it refused.
type SessionReading = NonNullable<typeof window.__ECHOES_DEBUG__>['session'];

// One stream frame as this client applied it. Two clients of one room can only be compared at a
// sequence number both of them saw, so the comparison is made on this log and never on "where each of
// them happens to be right now".
type FrameLogReading = {
  seq: number;
  kind: string;
  tick: number;
  gold: number;
  status: string;
  players: number;
  commandCount: number;
  eventCounts: Record<SimulationEvent['type'], number>;
  pads: Record<string, string | null>;
  at: number;
  deliveryMs: number;
};

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
  lastRebuild: RebuildReading | null;
  lastFreshRun: FreshRunReading | null;
  entry: { open: boolean; mode: string; armed: boolean; continuing: 'slot' | 'match' | null };
  session: SessionReading;
  frameLog: FrameLogReading[];
  frames: number;
  motion: { reducedMotion: boolean; combatBursts: number; enemyBob: number; clips: number; clipsPlaying: number };
  assets: { status: string; models: string[]; error: string | null };
  probe: {
    environment: boolean;
    materials: Array<{
      path: string;
      className: string;
      role: string | null;
      envMapIntensity: number;
      ownsProbe: boolean;
      materialId: string;
      explicit: boolean;
    }>;
    undeclared: number;
  };
  assetBudgets: AssetBudgetsReading;
  towerModels: Array<{
    entityId: number;
    towerId: string;
    source: string;
    modelId: string | null;
    meshCount: number;
    crystalNode: string | null;
    crystalBaseY: number;
    crystalY: number;
    crystalScale: number;
    crystalEmissive: number;
    clip: {
      clipName: string;
      duration: number;
      phase: number;
      time: number;
      playing: boolean;
      boneName: string;
      pose: [number, number, number, number];
    } | null;
  }>;
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
      lastRebuild: debug.lastRebuild,
      lastFreshRun: debug.lastFreshRun,
      entry: debug.entry,
      session: debug.session,
      frameLog: debug.frameLog,
      frames: debug.frames,
      motion: debug.motion,
      assets: debug.assets,
      probe: debug.probe,
      assetBudgets: debug.assetBudgets,
      towerModels: debug.towerModels,
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

// The tick a recorded command was applied on only exists in the page, so it is read there and
// together with the tick it was issued on. A command that arrives late shows up as a pair of
// different numbers rather than as a different terminal tick three hundred ticks later.
type CommandPlanEntry = { tick: number; appliedTick: number | null; type: string };

const readCommandPlan = (page: Page) =>
  page.evaluate(
    (): CommandPlanEntry[] | null =>
      window.__ECHOES_DEBUG__?.commandPlan.map((entry) => ({
        tick: entry.tick,
        appliedTick: entry.appliedTick,
        type: entry.command.type,
      })) ?? null,
  );

type ClockMarkReading = {
  label: string;
  tick: number;
  waveTick: number;
  at: number;
  accumulator: number;
  paused: boolean;
};

// Clock marks are taken inside the page at the moment the page handled the click, so a duration
// measured from two of them contains no round-trip between the test process and the page.
const readClockMarks = (page: Page) =>
  page.evaluate((): ClockMarkReading[] | null => window.__ECHOES_DEBUG__?.clockMarks.map((mark) => ({ ...mark })) ?? null);

const markClock = (page: Page, label: string) =>
  page.evaluate((name) => {
    window.__ECHOES_DEBUG__?.markClock(name);
  }, label);

const findMark = (marks: ClockMarkReading[] | null, label: string): ClockMarkReading => {
  const mark = marks?.find((entry) => entry.label === label);
  if (!mark) {
    throw new Error(`clock mark ${label} missing`);
  }
  return mark;
};

// The QA frame clock. `0.1` s is two ticks per frame and `0.25` s is the product's own frame clamp,
// five ticks per frame. Both divide the tick exactly, so each run walks a fixed tick lattice and
// two runs with different values walk different ones over the same recorded commands. The value is
// clamped again inside the page, so a test cannot ask for a frame the product would never produce.
const QA_FIRST_RUN_FRAME_SECONDS = 0.1;
const QA_FRAME_CANDIDATE_SECONDS = [0.25, 0.2, 0.15, 0.1];

const setFrameDelta = (page: Page, seconds: number | null) =>
  page.evaluate((value) => {
    window.__ECHOES_DEBUG__?.forceFrameDelta(value);
  }, seconds);

const describePlan = (plan: CommandPlanEntry[]): string =>
  plan.map((entry) => `${entry.type}@${entry.tick}->${entry.appliedTick}`).join(' ');

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

// Every screenshot scenario waits for the model registry first, so a shot can never be taken
// against a scene that is still swapping placeholders for loaded models.
const waitForAssetsReady = (page: Page) =>
  expect(page.getByTestId('viewport')).toHaveAttribute('data-assets', 'ready');

// "The page has booted" is not a statement about how fast an assertion resolves. The default 5 s expect
// timeout is a claim about the assertion, and it was measured on a suite that ran alone; a full run now
// puts six workers, two browser contexts and a session server on one machine, and a cold boot has been
// observed past 5 s — once in `drops transient canvas effects under prefers-reduced-motion`, which is
// about canvas effects and has nothing to say about boot time. This is the same patience `EOB-019` gave
// the negative asset scenarios, applied to boot. No assertion changes: only how long a test waits for the
// canvas to exist, and the tests that already wait for the registry afterwards are unaffected.
const BOOT_TIMEOUT = 30_000;

const expectBooted = (page: Page) =>
  expect(page.getByTestId('scene-canvas')).toBeVisible({ timeout: BOOT_TIMEOUT });

// The page opens on the entry screen, so a scenario starts the way a player does: the entry offers
// Continue only when there is something to continue, and New match asks a second time before it
// erases a save. This helper is the whole of that, and it presses the same two buttons a player
// presses — the scenarios that check the entry itself do not use it.
const enterAsNewMatch = async (page: Page) => {
  const screen = page.getByTestId('entry-screen');
  await expect(screen).toBeVisible();
  await page.getByTestId('entry-new-match').click();
  // A save is the one irreversible thing in the game, so it is confirmed by a second press. With
  // nothing to destroy the first press is the whole action.
  if ((await screen.getAttribute('data-entry')) === 'confirm') {
    await page.getByTestId('entry-new-match').click();
  }
  await expect(screen).toBeHidden();
};

// The entry as the page sees it, next to the shell's own state: `inert` is the attribute that makes
// "nothing happened behind the overlay" a property of the document instead of a claim about it.
const readEntry = (page: Page) =>
  page.evaluate(() => {
    const debug = window.__ECHOES_DEBUG__;
    const shell = document.querySelector('.game-shell');
    const inertHost = shell as HTMLElement | null;
    const text = (testId: string) => document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
    const screen = document.querySelector<HTMLElement>('[data-testid="entry-screen"]');
    return {
      ...(debug?.entry ?? { open: false, mode: 'empty', armed: false, continuing: null }),
      inert: inertHost?.inert ?? null,
      hidden: screen?.hidden ?? null,
      dialog: screen?.getAttribute('role') ?? null,
      modal: screen?.getAttribute('aria-modal') ?? null,
      slotState: document.querySelector('[data-testid="entry-slot"]')?.getAttribute('data-slot-state') ?? null,
      feedbackResult: document.querySelector('[data-testid="entry-feedback"]')?.getAttribute('data-result') ?? null,
      focused: document.activeElement?.getAttribute('data-testid') ?? null,
      slot: text('entry-slot'),
      hint: text('entry-hint'),
      feedback: text('entry-feedback'),
      continueVisible: document.querySelector<HTMLElement>('[data-testid="entry-continue"]')?.hidden === false,
      newMatchLabel: text('entry-new-match'),
      confirm: document.querySelector('[data-testid="entry-new-match"]')?.getAttribute('data-confirm') ?? null,
    };
  });

type ClipReading = {
  clipName: string;
  duration: number;
  phase: number;
  time: number;
  playing: boolean;
  boneName: string;
  pose: [number, number, number, number];
};

type ClipSample = ClipReading & { tick: number };

const round4 = (value: number): number => Number(value.toFixed(4));

const logClip = (label: string, tick: number, clip: ClipReading | null): void => {
  console.log(
    `${label}: tick ${tick}, time ${(clip?.time ?? 0).toFixed(3)}s, ` +
      `playing ${String(clip?.playing ?? false)}, pose [${(clip?.pose ?? []).map(round4)}]`,
  );
};

// The clip clock only moves while the match clock does, so the condition is sampled from the page
// and not from a poll in the test process: the reading and the number it is judged against have to
// come from the same frame. `awayFrom` is the pose the clip has to have left behind, which is what
// tells "the clip is running" apart from "the clip is somewhere new".
const waitForClip = async (page: Page, pastTime: number, awayFrom?: readonly number[], timeout = 30_000) => {
  const handle = await page.waitForFunction(
    ({ time, pose }) => {
      const debug = window.__ECHOES_DEBUG__;
      const view = debug?.towerModels.find((entry) => entry.modelId === 'pulse-spire');
      if (!view?.clip || view.clip.time <= time) {
        return null;
      }
      if (pose.length > 0 && view.clip.pose.join() === pose.join()) {
        return null;
      }
      return { ...view.clip, tick: debug?.snapshot.tick ?? 0 };
    },
    { time: pastTime, pose: [...(awayFrom ?? [])] },
    { timeout },
  );
  return (await handle.jsonValue()) as ClipSample;
};

// `EOB-019`: the default 5 s expect timeout is a statement about how fast an assertion resolves, not
// a statement about how long a boot may take. A negative asset scenario fetches the manifest,
// downloads the model, compiles shaders, and then shares the machine with the other workers of the
// suite, so the wait has to fit that. Only the patience changes here — the assertion is the same
// one every negative scenario has always made.
const ASSET_TERMINAL_TIMEOUT = 30_000;

const expectAssetRefused = async (page: Page) => {
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-assets', 'error', {
    timeout: ASSET_TERMINAL_TIMEOUT,
  });
};

// The sector caption and the rest of the viewport chrome share one strip of screen, so "the sector
// label is still readable" is measurable as "no other chrome box covers any of its glyphs". The
// comparison is over the glyph rects of every caption line, because the caption is a grid and its
// boxes are stretched wider than the words in them; the boxes on the other side are the chrome that
// is actually on screen, so a hidden or unplaced block cannot fail the check by accident.
const VIEWPORT_CHROME = '.wave-chip, .scene-report, .scene-diagnostics, .result-banner, .state-badge, .combat-log, .map-legend, .selection-card';

const expectNoChromeOverlap = async (page: Page) => {
  const measured = await page.evaluate((selector) => {
    const caption = document.querySelector('.scene-caption');
    if (!caption) {
      throw new Error('scene caption has no layout box');
    }
    const glyphs = Array.from(caption.children).flatMap((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()].map((rect) => ({
        text: node.textContent ?? '',
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      }));
    });
    const boxes = Array.from(document.querySelectorAll(selector))
      .filter((node) => !(node instanceof HTMLElement) || !node.hidden)
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return { name: node.getAttribute('data-testid') ?? node.className, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      })
      .filter((box) => box.width > 0 && box.height > 0);
    return { glyphs, boxes };
  }, VIEWPORT_CHROME);

  if (measured.glyphs.length === 0 || measured.boxes.length === 0) {
    throw new Error('viewport chrome produced no measurable rectangles');
  }
  const covered = measured.glyphs.flatMap((line) =>
    measured.boxes
      .filter(
        (box) =>
          line.x < box.x + box.width &&
          box.x < line.x + line.width &&
          line.y < box.y + box.height &&
          box.y < line.y + line.height,
      )
      .map((box) => `${box.name} over ${line.text}`),
  );
  expect(covered).toEqual([]);
};

// "The reason is readable" is measured, not looked at: every glyph rect of the reason has to sit
// inside the padding box of the block that is meant to show it. A shortened digest, an ellipsis or a
// clipped overflow all keep the block the same size and shrink the text inside it, so the box alone
// proves nothing — the glyph rects are what carry the evidence.
const expectRefusalFullyReadable = async (page: Page) => {
  const measured = await page.getByTestId('scene-report-reason').evaluate((node) => {
    const block = node.closest<HTMLElement>('[data-testid="scene-report"]');
    if (!block) {
      throw new Error('refusal reason is not inside a refusal block');
    }
    const blockStyle = getComputedStyle(block);
    const textStyle = getComputedStyle(node);
    const blockBox = block.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(node);
    return {
      text: node.textContent ?? '',
      reason: node.getAttribute('data-reason') ?? '',
      textOverflow: textStyle.textOverflow,
      overflow: `${blockStyle.overflowX} ${blockStyle.overflowY}`,
      clipped:
        block.scrollHeight > block.clientHeight + 1 || block.scrollWidth > block.clientWidth + 1,
      block: { x: blockBox.x, y: blockBox.y, width: blockBox.width, height: blockBox.height },
      padding: {
        top: parseFloat(blockStyle.paddingTop),
        right: parseFloat(blockStyle.paddingRight),
        bottom: parseFloat(blockStyle.paddingBottom),
        left: parseFloat(blockStyle.paddingLeft),
      },
      rects: [...range.getClientRects()].map((rect) => ({
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })),
    };
  });

  expect(measured.rects.length).toBeGreaterThan(0);
  expect(measured.block.height).toBeGreaterThan(0);
  expect(measured.clipped).toBe(false);
  // Neither an ellipsis nor a scroll container: a reason that needs either is a reason that was not
  // given a place of its own.
  expect(measured.textOverflow).not.toBe('ellipsis');
  expect(measured.overflow).not.toMatch(/hidden|scroll|auto/);
  const inside = measured.rects.every(
    (rect) =>
      rect.x >= measured.block.x + measured.padding.left - 1 &&
      rect.x + rect.width <= measured.block.x + measured.block.width - measured.padding.right + 1 &&
      rect.y >= measured.block.y + measured.padding.top - 1 &&
      rect.y + rect.height <= measured.block.y + measured.block.height - measured.padding.bottom + 1,
  );
  expect(inside).toBe(true);
  return measured;
};

// The measure behind every "this text is readable" claim in the suite: the glyph rects of a label
// against the padding box of the box that shows it. An ellipsis, a shortened string and a clipped
// overflow all leave the box exactly the size it was, so the box alone proves nothing — the glyphs
// are what carry the evidence. Selectors come from the caller because the surfaces differ (the
// dock's cards, the entry's lines) while the claim stays the same.
const measureLabels = (page: Page, labelSelector: string, containerSelector: string) =>
  page.evaluate(
    ({ labelSelector, containerSelector }) =>
      Array.from(document.querySelectorAll(labelSelector)).map((label) => {
        const container = label.closest<HTMLElement>(containerSelector);
        if (!container) {
          throw new Error(`${labelSelector} has no ${containerSelector} around it`);
        }
        const containerStyle = getComputedStyle(container);
        const labelStyle = getComputedStyle(label);
        const containerBox = container.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(label);
        return {
          text: label.textContent ?? '',
          textOverflow: labelStyle.textOverflow,
          clipped: label.scrollWidth > label.clientWidth + 1,
          box: {
            left: containerBox.left,
            right: containerBox.right,
            top: containerBox.top,
            bottom: containerBox.bottom,
          },
          padding: {
            top: parseFloat(containerStyle.paddingTop),
            right: parseFloat(containerStyle.paddingRight),
            bottom: parseFloat(containerStyle.paddingBottom),
            left: parseFloat(containerStyle.paddingLeft),
          },
          glyphs: [...range.getClientRects()].map((rect) => ({
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          })),
        };
      }),
    { labelSelector, containerSelector },
  );

const expectLabelsVisible = async (page: Page, labelSelector: string, containerSelector: string) => {
  const measured = await measureLabels(page, labelSelector, containerSelector);
  expect(measured.length, `${labelSelector} matched nothing`).toBeGreaterThan(0);
  for (const label of measured) {
    expect(label.glyphs.length, `${label.text} produced no measurable glyphs`).toBeGreaterThan(0);
    expect(label.textOverflow, `${label.text} is shortened with an ellipsis`).not.toBe('ellipsis');
    expect(label.clipped, `${label.text} does not fit the box that shows it`).toBe(false);
    const inside = label.glyphs.every(
      (glyph) =>
        glyph.x >= label.box.left + label.padding.left - 1 &&
        glyph.x + glyph.width <= label.box.right - label.padding.right + 1 &&
        glyph.y >= label.box.top + label.padding.top - 1 &&
        glyph.y + glyph.height <= label.box.bottom - label.padding.bottom + 1,
    );
    expect(inside, `${label.text} has a glyph outside the box that shows it`).toBe(true);
  }
  return measured;
};

// The dock has to show the whole label, not a shortened one: a tower name and the slot state are the
// two pieces of text in it that carry information the player cannot guess. Both are measured by
// glyph rects against the padding box of the box that shows them, because an ellipsis, a shortened
// string and a clipped overflow all leave the box exactly the size it was.
const expectDockLabelsVisible = async (page: Page) => {
  const names = await expectLabelsVisible(page, '.build-card strong', '.build-card');
  const slot = await expectLabelsVisible(page, '[data-testid="save-slot"]', '.save-heading');
  if (!slot[0]) {
    throw new Error('the save slot line is missing');
  }
  return { names, slot: slot[0] };
};

// The entry screen is held to the same rules: its lines and its buttons carry a tick, a command count,
// a room name and the price of erasing a save, and none of that may be cut. Hidden lines and hidden
// buttons are left out of the measurement — Continue is legitimately absent when there is no save, and
// the slot line is legitimately absent in a room — and their absence is asserted as a state, not as a
// label that produced no glyphs.
const expectEntryLabelsVisible = async (page: Page) => {
  const lines = await expectLabelsVisible(
    page,
    '.entry-kicker, .entry-title, .entry-slot:not([hidden]), .entry-room-line, .entry-hint, .entry-feedback',
    '.entry-panel',
  );
  const buttons = await expectLabelsVisible(page, '.entry-button:not([hidden])', '.entry-button');
  return { lines, buttons };
};

// --- Authoritative session ---------------------------------------------------------------------
// The room is a server on its own port, started by the Playwright config next to Vite, and a client
// reaches it by address: `?room=<name>`. Nothing about it is a test hook — the handshake, the stream and
// the command POST are the product's own transport, and a second browser *context* is used rather than a
// second tab because two tabs of one context share a storage and would prove nothing about two clients.
// The port is the one the protocol module declares, so a test cannot be pointed at a room the product
// would not look for.
const SESSION_ORIGIN = `http://127.0.0.1:${DEFAULT_SESSION_PORT}`;
const SESSION_VIEWPORT = { width: 1280, height: 720 };

// A room name is an address, and an address that is reused meets the match the last run left there.
// The room server outlives a run when a developer keeps one open, so every room in this suite carries a
// suffix from this process: a run gets rooms of its own, and a scenario that needs an untouched room
// really has one instead of a match that started before the test file was read.
const ROOM_RUN = `${process.pid.toString(36)}${Date.now().toString(36).slice(-4)}`;
const roomName = (name: string): string => `${name}-${ROOM_RUN}`;

const readSession = (page: Page) => page.evaluate((): SessionReading | null => window.__ECHOES_DEBUG__?.session ?? null);

const readFrameLog = (page: Page) =>
  page.evaluate((): FrameLogReading[] | null =>
    (window.__ECHOES_DEBUG__?.frameLog ?? null)?.map((entry) => ({
      seq: entry.seq,
      kind: entry.kind,
      tick: entry.tick,
      gold: entry.gold,
      status: entry.status,
      players: entry.players,
      commandCount: entry.commandCount,
      eventCounts: { ...entry.eventCounts },
      pads: { ...entry.pads },
      at: entry.at,
      deliveryMs: entry.deliveryMs,
    })) ?? null,
  );

const waitForSessionState = (page: Page, state: string, timeout = 30_000) =>
  expect(page.getByTestId('session-strip')).toHaveAttribute('data-state', state, { timeout });

// Entering a room the way a player does: the address names it, the entry offers it, one press sends
// the handshake and opens the stream. Nothing is injected and nothing is armed, so the fact that the
// two contexts below see one match is a fact about the transport and not about the test.
const enterRoom = async (page: Page, roomId: string) => {
  await page.goto(`/?room=${roomId}`);
  await expect(page.getByTestId('session-strip')).toHaveAttribute('data-mode', 'remote');
  await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'room');
  await expect(page.getByTestId('entry-room-input')).toHaveValue(roomId);
  await page.getByTestId('entry-join-room').click();
  await waitForSessionState(page, 'live');
  await expect(page.getByTestId('entry-screen')).toBeHidden();
};

type RoomSummary = {
  roomId: string;
  players: number;
  tick: number;
  status: string;
  commands: number;
  versions: { protocolVersion: number; contentVersion: number; mapVersion: number; seed: number };
};

// The room as the server itself reports it. It is a third reading of the same match, and it is the one
// that can prove the room kept ticking while a client did not.
const readRoom = async (request: APIRequestContext, roomId: string): Promise<RoomSummary> => {
  const response = await request.get(`${SESSION_ORIGIN}/api/health`);
  expect(response.ok(), 'the session server is not answering its own health route').toBe(true);
  const body = (await response.json()) as { rooms: RoomSummary[] };
  const room = body.rooms.find((entry) => entry.roomId === roomId);
  if (!room) {
    throw new Error(`the server does not know a room called ${roomId}`);
  }
  return room;
};

// The frame two clients of one room can be compared at: the highest sequence number both of them
// applied. A client that joined later has no log before its own first frame, so the overlap starts there
// — which is exactly the window in which "one match" is a claim with two witnesses.
const commonFrame = (first: FrameLogReading[], second: FrameLogReading[]): { a: FrameLogReading; b: FrameLogReading } => {
  const bySeq = new Map(second.map((entry) => [entry.seq, entry]));
  const shared = first.filter((entry) => bySeq.has(entry.seq)).sort((left, right) => left.seq - right.seq);
  const latest = shared[shared.length - 1];
  const partner = latest === undefined ? undefined : bySeq.get(latest.seq);
  if (!latest || !partner) {
    throw new Error(`the two clients share no frame (${first.length} and ${second.length} frames seen)`);
  }
  return { a: latest, b: partner };
};

const armHandshake = (page: Page, overrides: Record<string, unknown> | null) =>
  page.evaluate((value) => {
    window.__ECHOES_DEBUG__?.forceHandshake(value);
  }, overrides);

// A dropped update stream, the way a network drops it: the seam runs the same path `EventSource.onerror`
// runs, so what is being tested is the product's reconnect policy and not a patched transport.
const breakStream = (page: Page) =>
  page.evaluate(() => {
    window.__ECHOES_DEBUG__?.breakStream();
  });

// A seat is handed to a second context through the only durable place a browser has. The payload is the
// product's own slot shape — a preparation with nothing recorded plus the optional seat field — so
// nothing about the second client depends on a test-only storage key or a patched reader.
const seatSlotPayload = (roomToken: string | null): string =>
  JSON.stringify({
    schemaVersion: 1,
    contentVersion: CONTENT_VERSION,
    seed: scenario.seed,
    tick: 0,
    log: [],
    ...(roomToken === null ? {} : { roomToken }),
  });

const seedSeat = (context: BrowserContext, roomToken: string | null): Promise<void> =>
  context
    .addInitScript(
      ([key, payload]) => {
        window.localStorage.setItem(key as string, payload as string);
      },
      [MATCH_SAVE_KEY, seatSlotPayload(roomToken)] as const,
    )
    .then(() => undefined);


// The room's own answer to a room verb, asked over the product's route with the product's body. It is
// how a guest's permission is proved: a disabled control only says the page would not press it, and the
// claim that needs proving is that the room refuses the request when one arrives anyway.
const askRoomVerb = async (request: APIRequestContext, roomId: string, clientId: string, verb: string) => {
  const response = await request.post(`${SESSION_ORIGIN}/api/rooms/${roomId}/lifecycle`, {
    data: { clientId, verb },
  });
  expect(response.ok(), `the room did not answer ${verb} with a status`).toBe(true);
  return (await response.json()) as {
    verb: string;
    accepted: boolean;
    reason?: string;
    role: string;
    tick: number;
    seq: number;
    players: number;
  };
};

const readRooms = async (request: APIRequestContext): Promise<RoomSummary[]> => {
  const response = await request.get(`${SESSION_ORIGIN}/api/health`);
  expect(response.ok(), 'the session server is not answering its own health route').toBe(true);
  return ((await response.json()) as { rooms: RoomSummary[] }).rooms;
};

// The delay of a frame is stamped in the page, and only the summary is worked out here, so no round
// trip between the test process and the browser is inside any of these numbers. The caller passes the
// frames it decided were inside the window, which is what keeps the warm-up of a browser out of them.
const deliveryPercentiles = (delays: number[]) => {
  const sorted = [...delays].sort((left, right) => left - right);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))] ?? 0;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1] ?? 0 };
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
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  await expect(page.getByTestId('game-title')).toHaveText('First Contact');
  await expect(page.getByTestId('scene-status')).toContainText('Scene online');
  await expect(page.getByTestId('scene-status')).toContainText('models ready (pulse-spire)');
  await expectBooted(page);

  const debugState = await readDebug(page);

  expect(debugState?.ready).toBe(true);
  expect(debugState?.objectCount).toBeGreaterThan(0);
  expect(debugState?.assets).toEqual({ status: 'ready', models: ['pulse-spire'], error: null });

  const webglAvailable = await page.getByTestId('scene-canvas').evaluate((element) => {
    return Boolean((element as HTMLCanvasElement).getContext('webgl2'));
  });

  expect(webglAvailable).toBe(true);

  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await expect(page.getByTestId('selection-status')).toHaveText('Grove Lens ready');
  await expect(page.getByRole('button', { name: 'Grove Lens' })).toHaveAttribute('aria-pressed', 'true');

  // The dock is a fixed QA viewport, and at it the palette has to show the whole tower name and the
  // save panel the whole slot state: a panel added to the dock may not be able to take either away.
  const dock = await expectDockLabelsVisible(page);

  await page.screenshot({ path: 'test-results/bootstrap.png', fullPage: true });

  // The same claim on the narrow layout, where the palette takes a row of its own and the save panel
  // gets one too. Both are measured, not looked at, so the responsive path is held to the same
  // standard as the QA viewport.
  await page.setViewportSize({ width: 560, height: 900 });
  const narrow = await expectDockLabelsVisible(page);

  console.log(
    `dock: ${dock.names.map((entry) => entry.text).join(' / ')} at ` +
      `${dock.names.map((entry) => entry.glyphs[0]!.width.toFixed(1)).join(', ')}px of glyphs, ` +
      `slot "${dock.slot.text}" at ${dock.slot.glyphs[0]!.width.toFixed(1)}px; ` +
      `narrow: ${narrow.names.map((entry) => entry.glyphs[0]!.width.toFixed(1)).join(', ')}px, ` +
      `slot ${narrow.slot.glyphs.map((glyph) => glyph.width.toFixed(1)).join('+')}px over ${narrow.slot.glyphs.length} line(s)`,
  );
});

test('drives presentation from MatchSnapshot without duplicated state', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);
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
  await expectBooted(page);
  await enterAsNewMatch(page);

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
  await waitForAssetsReady(page);
  // By now the short prep window is over, so the phase clock reports the neutral state.
  await expect(page.getByTestId('phase-timer')).toHaveText('Awaiting start');
  await page.screenshot({ path: 'test-results/build-pad-placement.png', fullPage: true });
});

test('plays a defended wave from real clicks and reports victory from the snapshot', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

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

  await waitForAssetsReady(page);
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
  // The registry answered long before the wave ended, so the spire on the pad is the generated
  // model and the same victory numbers are reached with it in the scene.
  expect(finished.assets).toEqual({ status: 'ready', models: ['pulse-spire'], error: null });
  expect(finished.towerModels.map((view) => view.source)).toEqual(['model', 'procedural', 'procedural']);
  expect(finished.towerModels[0]?.meshCount).toBe(5);

  await waitForAssetsReady(page);
  await page.screenshot({ path: 'test-results/wave-combat-victory.png', fullPage: true });
});

test('reports defeat when an undefended wave reaches the core', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

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

  await waitForAssetsReady(page);
  await page.screenshot({ path: 'test-results/wave-combat-defeat.png', fullPage: true });
});

test('freezes and resumes the fixed-step clock without drift', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

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

  await waitForAssetsReady(page);
  await page.screenshot({ path: 'test-results/vertical-slice-paused.png', fullPage: true });

  await page.getByTestId('pause-toggle').click();
  const resumed = await readDebugOrThrow(page);
  expect(resumed.paused).toBe(false);
  await expect(page.getByTestId('state-badge')).toBeHidden();
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-paused', 'false');
  await expect(page.getByTestId('pause-toggle')).toHaveText('Pause');

  // What a resume actually costs is measured inside the page, at the tick the click was handled:
  // the accumulator keeps its sub-tick remainder, so resuming must not fast-forward. A reading
  // taken after the round-trip also counts the frames the tool took to come back, and on a loaded
  // machine that is more than the 300 ms this boundary allows — which is why the measurement lives
  // in the page and the boundary below is the one the test has always used.
  const marks = await readClockMarks(page);
  const pauseMark = findMark(marks, 'pause');
  const resumeMark = findMark(marks, 'resume');
  expect(pauseMark.paused).toBe(true);
  expect(resumeMark.paused).toBe(false);
  expect(pauseMark.tick).toBe(frozen.snapshot.tick);
  expect(resumeMark.tick - pauseMark.tick).toBeLessThanOrEqual(6);
  expect(resumeMark.waveTick - pauseMark.waveTick).toBeLessThanOrEqual(6);
  // The remainder of the tick the pause interrupted is still there, so the accumulator is never
  // negative and never holds a whole tick of product clock after the loop has spent what it can.
  expect(pauseMark.accumulator).toBeGreaterThanOrEqual(0);
  expect(pauseMark.accumulator).toBeLessThan(1 / frozen.tickRate);

  // The same for the rate: the window is a second of the page's own clock, so the tick bounds below
  // keep the meaning they always had instead of absorbing the round-trips around the wait.
  await page.waitForFunction((from) => performance.now() - from >= 1000, resumeMark.at);
  await markClock(page, 'after-1s');
  const afterMark = findMark(await readClockMarks(page), 'after-1s');
  const windowSeconds = (afterMark.at - resumeMark.at) / 1000;
  // 20 ticks per second: the clock has to run on, but not faster than real time.
  expect(afterMark.tick - resumeMark.tick).toBeGreaterThanOrEqual(12);
  expect(afterMark.tick - resumeMark.tick).toBeLessThanOrEqual(30);
  expect(windowSeconds).toBeLessThanOrEqual(1.5);

  const running = await readDebugOrThrow(page);
  expect(running.snapshot.waveTick).toBeGreaterThan(frozen.snapshot.waveTick);
  expect(running.enemyPositions).not.toEqual(frozen.enemyPositions);
  expectProjectionMatchesSnapshot(running);
});

test('restarts from the same seed and replays the recorded command log', async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

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
  await waitForAssetsReady(page);
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
  await waitForAssetsReady(page);
  await page.screenshot({ path: 'test-results/vertical-slice-replay-victory.png', fullPage: true });
});

test('rejects commands injected during replay and keeps the recorded run identical', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

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
  await expectBooted(page);
  await enterAsNewMatch(page);

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

  // The skeletal clip is in the same list: it does not play slowly, it does not play at all. The
  // bones stay in the rest pose the model was authored in, and the tower keeps its materials.
  const reducedView = fighting.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(reducedView?.clip).not.toBeNull();
  expect(reducedView?.clip?.playing).toBe(false);
  expect(reducedView?.clip?.time).toBe(0);
  expect(reducedView?.clip?.pose).toEqual([0, 0, 0, 1]);
  expect(fighting.motion.clips).toBe(1);
  expect(fighting.motion.clipsPlaying).toBe(0);
  expect(reducedView?.crystalEmissive).toBeCloseTo(2.4, 5);
  logClip('clip under reduced motion', fighting.snapshot.tick, reducedView?.clip ?? null);

  await page.waitForTimeout(500);

  const settled = await readDebugOrThrow(page);
  expect(settled.motion.combatBursts).toBe(0);
  expect(settled.motion.enemyBob).toBe(0);
  expect(settled.eventCounts.enemyKilled).toBeGreaterThan(0);
  const held = settled.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(held?.clip?.time).toBe(0);
  expect(held?.clip?.pose).toEqual(reducedView?.clip?.pose);
  expect(held?.meshCount).toBe(5);
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

  await waitForAssetsReady(page);
  await page.screenshot({ path: 'test-results/vertical-slice-reduced-motion.png', fullPage: true });
});

test('swaps a placed placeholder for the generated GLB without touching the snapshot', async ({ page }) => {
  test.setTimeout(120_000);
  // The model request is held open so the tower is guaranteed to be built while the registry
  // is still loading. That makes the two-phase swap deterministic instead of a race.
  let releaseModel: () => void = () => {};
  const modelGate = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  await page.route('**/models/*.glb', async (route) => {
    await modelGate;
    await route.continue();
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-assets', 'loading');

  // Only pulse-spire has a model in this task, so the scene holds one model and two procedural
  // placeholders at the same time and the mixed state has to stay readable and playable.
  await armDefendedWave(page);

  const procedural = await readDebugOrThrow(page);
  expect(procedural.assets.status).toBe('loading');
  expect(procedural.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(procedural.towerModels).toHaveLength(placements.length);
  expect(procedural.towerModels.map((view) => view.source)).toEqual(['procedural', 'procedural', 'procedural']);
  const before = procedural.towerModels[0];
  expect(before?.source).toBe('procedural');
  expect(before?.modelId).toBeNull();
  expect(before?.crystalNode).toBeNull();
  expect(before?.crystalBaseY).toBeCloseTo(1.43, 5);
  const padEast = padById.get('pad-east');
  expect(procedural.towerPositions[0]?.x).toBeCloseTo(padEast?.position.x ?? 0, 5);
  expect(procedural.towerPositions[0]?.z).toBeCloseTo(padEast?.position.z ?? 0, 5);

  releaseModel();
  await waitForAssetsReady(page);
  await expect(page.getByTestId('scene-status')).toContainText('models ready (pulse-spire)');

  const swapped = await readDebugOrThrow(page);
  expect(swapped.assets).toEqual({ status: 'ready', models: ['pulse-spire'], error: null });
  // Same entity, same pad, same money: the swap is a view change, not a gameplay change.
  expect(swapped.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(swapped.snapshot.gold).toBe(procedural.snapshot.gold);
  expect(swapped.snapshot.tick).toBeGreaterThanOrEqual(procedural.snapshot.tick);
  expect(swapped.rendered.towers).toBe(placements.length);
  expect(swapped.towerPositions).toEqual(procedural.towerPositions);
  expect(swapped.towerModels.map((view) => view.source)).toEqual(['model', 'procedural', 'procedural']);
  const after = swapped.towerModels[0];
  expect(after?.entityId).toBe(before?.entityId);
  expect(after?.towerId).toBe('pulse-spire');
  expect(after?.source).toBe('model');
  expect(after?.modelId).toBe('pulse-spire');
  expect(after?.crystalNode).toBe('crystal');
  // base, stem, roof, crystal and aura: the procedural placeholder had no mesh count to report.
  expect(after?.meshCount).toBe(5);
  expect(after?.crystalBaseY).toBeCloseTo(1.43, 5);

  // Idle bob is measured from the node the model shipped with, so it may never move the crystal
  // to another height, and it has to keep moving while the match is not paused.
  const firstBob = await readDebugOrThrow(page);
  await page.waitForTimeout(320);
  const secondBob = await readDebugOrThrow(page);
  for (const sample of [firstBob, secondBob]) {
    const view = sample.towerModels[0];
    expect(Math.abs((view?.crystalY ?? 0) - (view?.crystalBaseY ?? 0))).toBeLessThanOrEqual(0.08);
    expect(view?.crystalScale).toBeCloseTo(1, 5);
    expect(view?.crystalEmissive).toBeCloseTo(2.4, 5);
  }
  expect(secondBob.towerModels[0]?.crystalY).not.toBe(firstBob.towerModels[0]?.crystalY);

  // The upgrade hands the tower its skeleton once and only once: a second mixer on the same view
  // would double every pose change, and a leftover one would keep animating a released view.
  const upgraded = await readDebugOrThrow(page);
  expect(upgraded.motion.clips).toBe(1);
  expect(upgraded.motion.clipsPlaying).toBe(1);
  expect(upgraded.towerModels[0]?.clip?.clipName).toBe('pulse');
  expect(upgraded.towerModels[0]?.clip?.boneName).toBe('crystal-sway');
  expect(upgraded.towerModels[0]?.clip?.playing).toBe(true);
  const swappedPose = await waitForClip(page, (upgraded.towerModels[0]?.clip?.time ?? 0) + 0.2);
  expect(swappedPose.time).toBeGreaterThan((upgraded.towerModels[0]?.clip?.time ?? 0) + 0.2);

  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.towerFired ?? 0) > 0, undefined, {
    timeout: 60_000,
  });

  // The loaded crystal keeps the combat presentation of the procedural one. The sample is taken
  // in the page on the frame the flash is visible, because the flash only lasts 0.22s.
  const flash = await page
    .waitForFunction(() => {
      const view = window.__ECHOES_DEBUG__?.towerModels[0];
      if (!view || view.crystalEmissive <= 2.4) {
        return null;
      }
      return {
        emissive: view.crystalEmissive,
        scale: view.crystalScale,
        crystalY: view.crystalY,
        crystalBaseY: view.crystalBaseY,
      };
    }, undefined, { timeout: 60_000 })
    .then((handle) => handle.jsonValue() as Promise<{ emissive: number; scale: number; crystalY: number; crystalBaseY: number } | null>);
  if (!flash) {
    throw new Error('crystal flash sample missing');
  }
  expect(flash.emissive).toBeGreaterThan(2.4);
  expect(flash.scale).toBeGreaterThan(1);
  expect(Math.abs(flash.crystalY - flash.crystalBaseY)).toBeLessThanOrEqual(0.08);
  // And the presentation has to settle back, so the flash is a transient and not a latch.
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.towerModels[0]?.crystalEmissive ?? 0) <= 2.4, undefined, {
    timeout: 60_000,
  });
  const fighting = await readDebugOrThrow(page);
  // The swap never became a gameplay change: the snapshot keeps driving everything, and the
  // towers without a model in the registry are still procedural next to the loaded one.
  expect(fighting.rendered.towers).toBe(placements.length);
  expect(fighting.towerModels.map((view) => view.source)).toEqual(['model', 'procedural', 'procedural']);
  expect(fighting.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(fighting.towerPositions[0]?.x).toBeCloseTo(padEast?.position.x ?? 0, 5);
  expect(fighting.towerPositions[0]?.z).toBeCloseTo(padEast?.position.z ?? 0, 5);
  expectProjectionMatchesSnapshot(fighting);
  expect(pageErrors).toEqual([]);

  await page.screenshot({ path: 'test-results/vertical-slice-asset-swap.png', fullPage: true });
});

test('weights the environment probe per material and keeps the generated model at full probe', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);

  // Two spires of the one model that has a registry entry. The second view is the proof that the
  // weight reaches per-view material copies instead of only the loaded source scene, and that two
  // views of one model are still two sets of materials rather than one shared set.
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-south');
  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-north');
  await waitForAssetsReady(page);

  const armed = await readDebugOrThrow(page);
  expect(armed.snapshot.towers).toHaveLength(3);
  // Towers keep the order they were built in, and both spires were placed after the registry
  // answered, so neither view went through the procedural placeholder phase.
  expect(armed.towerModels.map((view) => [view.towerId, view.source])).toEqual([
    ['pulse-spire', 'model'],
    ['pulse-spire', 'model'],
    ['grove-lens', 'procedural'],
  ]);
  expect(armed.probe.environment).toBe(true);

  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0);
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.towerFired ?? 0) > 0);

  // One read, so the material map and the snapshot it is judged against come from the same frame.
  const { probe, snapshot, towerModels } = await readDebugOrThrow(page);
  expect(snapshot.status).toBe('wave');
  expect(snapshot.enemies.length).toBeGreaterThan(0);

  // The scene-wide dimmer is gone: nothing multiplies the probe for materials that were never
  // authored to receive it, so every standard material has to carry a weight of its own. `1` is
  // the Three.js default, which is exactly why "not declared" has to be a visible state.
  expect(probe.materials.length).toBeGreaterThan(0);
  expect(probe.undeclared).toBe(0);
  expect(probe.materials.filter((entry) => !entry.explicit)).toEqual([]);
  // Three.js reads `envMapIntensity` only when the material owns the probe. A material riding
  // `scene.environment` has that uniform overwritten, so a declared weight nobody renders would
  // pass every check above while the picture ignored it.
  expect(probe.materials.filter((entry) => !entry.ownsProbe)).toEqual([]);

  // The declared list is exhaustive, not "found by eye": with a wave running, enemies alive and
  // both a loaded and a procedural tower on screen, every role has to be present in the live scene.
  expect([...new Set(probe.materials.map((entry) => entry.role))].sort()).toEqual([
    'coreBase',
    'coreCrystal',
    'enemyBody',
    'enemyCrest',
    'ground',
    'model',
    'padBase',
    'path',
    'towerBase',
    'towerCrystal',
    'towerRoof',
    'towerStem',
  ]);
  expect(probe.materials.every((entry) => entry.className === 'MeshStandardMaterial')).toBe(true);

  const byRole = (role: string) => probe.materials.filter((entry) => entry.role === role);
  // The ground and the routes are the surfaces the scene-wide cap was hiding: they get a small,
  // explicit share instead of whatever the default would have given them.
  expect(byRole('ground')).toHaveLength(1);
  expect(byRole('ground')[0]?.envMapIntensity).toBeLessThanOrEqual(0.2);
  expect(byRole('path')).toHaveLength(routeSegmentCount);
  for (const segment of byRole('path')) {
    expect(segment.envMapIntensity).toBeLessThanOrEqual(0.2);
  }
  expect(byRole('padBase')).toHaveLength(padCount);
  for (const pad of byRole('padBase')) {
    expect(pad.envMapIntensity).toBeLessThanOrEqual(0.2);
  }

  // The generated model is the reason the probe exists, so it keeps all of it.
  const modelMaterials = byRole('model');
  for (const material of modelMaterials) {
    expect(material.envMapIntensity).toBeGreaterThanOrEqual(0.9);
  }
  // Five part meshes on each of the two spire views, and no two of them the same material: the
  // weight was stamped once on the loaded scene and every per-view copy inherited it.
  expect(modelMaterials).toHaveLength(10);
  expect(new Set(modelMaterials.map((entry) => entry.materialId)).size).toBe(10);
  const crystalMaterials = modelMaterials.filter((entry) => entry.path.endsWith('/crystal'));
  expect(crystalMaterials).toHaveLength(2);
  expect(crystalMaterials[0]?.materialId).not.toBe(crystalMaterials[1]?.materialId);
  expect(towerModels.filter((view) => view.source === 'model')).toHaveLength(2);

  console.log(
    `probe weights: ${probe.materials.length} standard materials, ${probe.undeclared} undeclared, ` +
      `${[...new Set(probe.materials.map((entry) => `${entry.role}=${entry.envMapIntensity}`))].sort().join(', ')}`,
  );

  // The crystal flash has to stay local to the tower that fired, and that holds only while the two
  // spire views keep separate materials. Sampled over a stretch of combat instead of on one frame:
  // the flash lasts 0.22s and both spires may legitimately fire close together, so the claim worth
  // checking is that a frame exists where one spire is lit and the other is not.
  await page.evaluate(() => {
    const samples = { spireFrames: 0, loneSpireFrames: 0 };
    const timer = window.setInterval(() => {
      const spires = (window.__ECHOES_DEBUG__?.towerModels ?? []).filter((view) => view.source === 'model');
      if (spires.length < 2 || !spires.some((view) => view.crystalEmissive > 2.4)) {
        return;
      }
      samples.spireFrames += 1;
      if (spires.filter((view) => view.crystalEmissive > 2.4).length === 1) {
        samples.loneSpireFrames += 1;
      }
    }, 16);
    const host = window as unknown as {
      __ECHOES_FLASH__?: { samples: typeof samples; stop: () => void };
    };
    host.__ECHOES_FLASH__ = { samples, stop: () => window.clearInterval(timer) };
  });

  await page.waitForFunction(
    () => {
      const host = window as unknown as { __ECHOES_FLASH__?: { samples: { loneSpireFrames: number } } };
      return (host.__ECHOES_FLASH__?.samples.loneSpireFrames ?? 0) > 0;
    },
    undefined,
    { timeout: 60_000 },
  );

  const flashSamples = await page.evaluate(() => {
    const host = window as unknown as {
      __ECHOES_FLASH__?: { samples: { spireFrames: number; loneSpireFrames: number }; stop: () => void };
    };
    const reading = host.__ECHOES_FLASH__?.samples ?? { spireFrames: 0, loneSpireFrames: 0 };
    host.__ECHOES_FLASH__?.stop();
    return reading;
  });

  // Both spires were caught mid-combat, and at least one frame had exactly one of them lit. A
  // shared crystal material would light both on every shot and `loneSpireFrames` would stay at zero.
  expect(flashSamples.spireFrames).toBeGreaterThan(0);
  expect(flashSamples.loneSpireFrames).toBeGreaterThan(0);
  expect(flashSamples.loneSpireFrames).toBeLessThanOrEqual(flashSamples.spireFrames);
});

test('plays the tower clip on presentation time and freezes it while paused', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  // The model is in place before the tower is built, so the view is a model view from the start and
  // the clip belongs to that tower rather than to a swap that happened at an unknown moment.
  await waitForAssetsReady(page);
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');

  const armed = await readDebugOrThrow(page);
  const clip = armed.towerModels[0]?.clip;
  expect(armed.towerModels[0]?.source).toBe('model');
  expect(armed.towerModels[0]?.meshCount).toBe(5);
  expect(clip?.clipName).toBe('pulse');
  expect(clip?.duration).toBe(2);
  expect(clip?.boneName).toBe('crystal-sway');
  // One mixer for one animated view, and the phase is a property of the tower: the first spire in
  // the match starts at the beginning of the loop, the second one does not.
  expect(armed.motion.clips).toBe(1);
  expect(armed.motion.clipsPlaying).toBe(1);
  expect(clip?.phase).toBe(0);
  expect(clip?.playing).toBe(true);

  const played = await waitForClip(page, (clip?.time ?? 0) + 0.3);
  expect(played.time).toBeGreaterThan((clip?.time ?? 0) + 0.3);
  logClip('clip armed', armed.snapshot.tick, clip ?? null);
  logClip('clip playing', played.tick, played);

  // Pause is a clock control, and the clip is on that clock: the pose has to hold for as long as the
  // player looks at it, or a paused snapshot and a paused screenshot would show different towers.
  await page.getByTestId('pause-toggle').click();
  const frozen = await readDebugOrThrow(page);
  const frozenClip = frozen.towerModels[0]?.clip;
  expect(frozen.paused).toBe(true);
  expect(frozenClip?.playing).toBe(true);
  await page.waitForTimeout(1_200);
  const held = await readDebugOrThrow(page);
  expect(held.snapshot.tick).toBe(frozen.snapshot.tick);
  expect(held.towerModels[0]?.clip?.time).toBe(frozenClip?.time);
  expect(held.towerModels[0]?.clip?.pose).toEqual(frozenClip?.pose);
  logClip('clip paused at freeze', frozen.snapshot.tick, frozenClip ?? null);
  logClip('clip paused after 1.2s', held.snapshot.tick, held.towerModels[0]?.clip ?? null);
  await page.screenshot({ path: 'test-results/asset-animation-paused.png', fullPage: true });

  await page.getByTestId('pause-toggle').click();
  const moved = await waitForClip(page, (frozenClip?.time ?? 0) + 0.2, frozenClip?.pose);
  expect(moved.playing).toBe(true);
  logClip('clip resumed', moved.tick, moved);
});

test('reproduces the same clip pose on the same tick after a restart', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);
  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  // Victory stops the match clock, so the terminal tick is a tick the pose can be read on and read
  // again: the skeleton holds the pose the last tick implies, and both runs end on the same one.
  const first = await readDebugOrThrow(page);
  const firstView = first.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(first.snapshot.tick).toBeGreaterThan(0);
  expect(firstView?.clip?.time).toBeGreaterThan(0);
  const firstTime = firstView?.clip?.time ?? -1;
  const firstPose = firstView?.clip?.pose ?? [];
  const firstEntity = firstView?.entityId;

  await page.waitForTimeout(600);
  const stillHeld = await readDebugOrThrow(page);
  expect(stillHeld.towerModels.find((view) => view.modelId === 'pulse-spire')?.clip?.time).toBe(firstTime);

  // Restart replays the recorded placements on their original ticks, so the run reaches the same
  // terminal tick. The clip clock starts over with the match, which is the whole claim: the pose of
  // a tick is a function of that tick and not of when the browser got around to drawing it.
  await page.getByTestId('restart-match').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const second = await readDebugOrThrow(page);
  const secondView = second.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(second.snapshot.tick).toBe(first.snapshot.tick);
  expect(second.snapshot.gold).toBe(first.snapshot.gold);
  expect(secondView?.entityId).toBe(firstEntity);
  expect(secondView?.clip?.phase).toBe(firstView?.clip?.phase);
  // The accumulation of tick-sized steps is summed per frame, so the two runs may differ in the
  // last bits and nowhere else.
  expect(secondView?.clip?.time).toBeCloseTo(firstTime, 6);
  secondView?.clip?.pose.forEach((component, index) => {
    expect(component).toBeCloseTo(firstPose[index] ?? Number.NaN, 6);
  });
  logClip('clip at terminal tick, first run', first.snapshot.tick, firstView?.clip ?? null);
  logClip('clip at terminal tick, replay', second.snapshot.tick, secondView?.clip ?? null);
  console.log(
    `terminal reports: ${JSON.stringify(first.matchReports)} vs ${JSON.stringify(second.matchReports)}`,
  );
});

test('applies a recorded command on its own tick when a frame steps several ticks', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  // The claim under test: replay reproduces the match whatever number of ticks a frame steps. The
  // two runs therefore walk different tick lattices over the same recorded commands — two ticks per
  // frame in the run that records them, and the product's five-tick clamp in the replay — and the
  // terminal tick, the report and the pose may not move.
  await setFrameDelta(page, QA_FIRST_RUN_FRAME_SECONDS);
  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const first = await readDebugOrThrow(page);
  const firstPlan = await readCommandPlan(page);
  expect(firstPlan).toHaveLength(placements.length + 1);
  // In the run that recorded them, every command reached the core on the tick it was issued on.
  firstPlan?.forEach((entry) => {
    expect(entry.appliedTick, `${entry.type} recorded at ${entry.tick}`).toBe(entry.tick);
  });

  // The replay clock is chosen so that its step lattice provably skips one of the recorded ticks.
  // On a loop free to step past a pending command that frame is the one that applies the command
  // late and forks the run; on the fixed loop the same frame stops on the tick. It is verified
  // rather than assumed, because a test that stays green on the unfixed loop is the exact failure
  // this scenario exists to prevent.
  const replayFrameSeconds = QA_FRAME_CANDIDATE_SECONDS.find((seconds) =>
    firstPlan?.some((entry) => entry.tick > 0 && entry.tick % Math.round(seconds * first.tickRate) !== 0),
  );
  if (replayFrameSeconds === undefined) {
    throw new Error(
      `no multi-tick frame lattice skips a recorded tick of ${describePlan(firstPlan ?? [])}`,
    );
  }
  const replayTicksPerFrame = Math.round(replayFrameSeconds * first.tickRate);
  expect(replayTicksPerFrame).toBeGreaterThanOrEqual(2);

  await setFrameDelta(page, replayFrameSeconds);
  await page.getByTestId('restart-match').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });
  await waitForAssetsReady(page);

  const second = await readDebugOrThrow(page);
  const secondPlan = await readCommandPlan(page);
  console.log(
    `frames: ${Math.round(QA_FIRST_RUN_FRAME_SECONDS * first.tickRate)} ticks/frame in run 1, ` +
      `${replayTicksPerFrame} in the replay\n` +
      `plan run 1:  ${describePlan(firstPlan ?? [])}\n` +
      `plan replay: ${describePlan(secondPlan ?? [])}\n` +
      `terminal tick: ${first.matchReports[0]?.tick} -> ${second.matchReports[1]?.tick}`,
  );

  // The heart of it: every command reached the core on the tick it was recorded on.
  secondPlan?.forEach((entry, index) => {
    expect(entry.appliedTick, `command ${index} of the replay landed on tick ${entry.appliedTick}`).toBe(
      entry.tick,
    );
  });
  expect(second.matchReports).toHaveLength(2);
  expect(second.matchReports[1]).toEqual(first.matchReports[0]);
  expect(second.snapshot.tick).toBe(first.snapshot.tick);
  expect(second.snapshot.gold).toBe(first.snapshot.gold);
  expect(second.replaying).toBe(false);
  expect(second.replayIndex).toBe(second.commandCount);

  // The pose of the terminal tick is a function of that tick, so it is the same one.
  const firstView = first.towerModels.find((view) => view.modelId === 'pulse-spire');
  const secondView = second.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(firstView?.clip).not.toBeNull();
  expect(secondView?.entityId).toBe(firstView?.entityId);
  expect(secondView?.clip?.phase).toBe(firstView?.clip?.phase);
  expect(secondView?.clip?.time).toBeCloseTo(firstView?.clip?.time ?? Number.NaN, 6);
  secondView?.clip?.pose.forEach((component, index) => {
    expect(component).toBeCloseTo(firstView?.clip?.pose[index] ?? Number.NaN, 6);
  });
  logClip('clip at terminal tick, first run', first.snapshot.tick, firstView?.clip ?? null);
  logClip('clip at terminal tick, replay', second.snapshot.tick, secondView?.clip ?? null);
});

test('refuses a model whose skeleton carries more bones than the budget allows', async ({ page }) => {
  test.setTimeout(60_000);
  // The rig is added to the file on the way out and never on disk, and the manifest is told the
  // truth about the file being served, so the refusal cannot be a byte or hash mismatch in
  // disguise. The client measures the tree it loaded, which means the tree has to be the thing that
  // breaks the limit.
  const extraBones = MODEL_BUDGET.bones;
  const patched = withExtraBones(readFileSync(GLB_MODEL_PATH), extraBones);
  await page.route('**/models/*.glb', (route) =>
    route.fulfill({ status: 200, contentType: 'model/gltf-binary', body: patched }),
  );
  await page.route('**/models/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as { models: Array<{ bytes: number; contentHash: string }> };
    for (const model of manifest.models) {
      model.bytes = patched.length;
      model.contentHash = sha256(patched);
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(manifest) });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await enterAsNewMatch(page);
  await expectAssetRefused(page);

  // A skeleton is allowed now, so the refusal has to name the number that broke the budget rather
  // than the feature.
  const status = page.getByTestId('scene-status');
  await expect(status).toContainText('model registry failed');
  await expect(status).toContainText('pulse-spire');
  await expect(status).toContainText('bones');
  await expect(status).toContainText(`budget allows ${MODEL_BUDGET.bones}`);

  const failed = await readDebugOrThrow(page);
  expect(failed.assets.status).toBe('error');
  expect(failed.assets.models).toEqual([]);
  const refused = failed.assetBudgets.checks.models[0];
  expect(refused?.modelId).toBe('pulse-spire');
  expect(refused?.accepted).toBe(false);
  // Same node types as the accepted model: what changed is the bone count, so this scenario cannot
  // pass by refusing skeletons as such.
  expect(refused?.nodeTypes).toEqual(['Bone', 'Group', 'Mesh', 'SkinnedMesh']);
  expect(refused?.skeleton?.bones).toBeGreaterThan(MODEL_BUDGET.bones);
  expect(refused?.skeleton?.clipNames).toEqual(['pulse']);
  expect(refused?.failures.join(' ')).toContain(`budget allows ${MODEL_BUDGET.bones}`);
  expect(failed.assetBudgets.failures.join(' ')).toContain('bones is');
  // Everything ahead of the budget had to pass for the budget to be the thing that said no.
  expect(failed.assetBudgets.checks.performed.bytes).toBe(true);
  expect(failed.assetBudgets.checks.performed.contentHash).toBe(true);
  expect(failed.assetBudgets.checks.performed.nodeTypes).toBe(true);
  expect(failed.assetBudgets.checks.performed.modelBudget).toBe(true);
  expect(refused?.contentHash).toEqual({ performed: true, matches: true, skippedReason: null });
  expect(refused?.actualBytes).toBe(refused?.expectedBytes);

  // The match stays playable on procedural placeholders, and the refusal stays local.
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByTestId('start-wave').click();
  const started = await readDebugOrThrow(page);
  expect(started.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(started.towerModels[0]?.source).toBe('procedural');
  expect(started.towerModels[0]?.clip).toBeNull();
  expect(started.motion.clips).toBe(0);
  expect(started.snapshot.status).toBe('wave');
  await expectAssetRefused(page);
  await expectNoChromeOverlap(page);
  await page.screenshot({ path: 'test-results/asset-refused-bone-budget.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('keeps the match playable and names the failure when the model registry is unavailable', async ({ page }) => {
  test.setTimeout(60_000);
  await page.route('**/models/manifest.json', (route) =>
    route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }),
  );
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await enterAsNewMatch(page);
  await expectAssetRefused(page);

  // Fail-fast is visible, not silent: the reason is in the viewport, not in a console warning.
  const status = page.getByTestId('scene-status');
  await expect(status).toContainText('model registry failed');
  await expect(status).toContainText('404');

  const failed = await readDebugOrThrow(page);
  expect(failed.assets.status).toBe('error');
  expect(failed.assets.models).toEqual([]);
  expect(failed.assets.error).toContain('model registry responded 404');

  // A tower without a model entry is normal and stays procedural, and the match keeps running.
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  const placed = await readDebugOrThrow(page);
  expect(placed.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(placed.rendered.towers).toBe(1);
  expect(placed.towerModels[0]?.source).toBe('procedural');
  expect(placed.towerModels[0]?.crystalBaseY).toBeCloseTo(1.43, 5);

  await page.getByTestId('start-wave').click();
  const started = await readDebugOrThrow(page);
  expect(started.snapshot.status).toBe('wave');
  expect(started.eventCounts.waveStarted).toBe(1);
  await expectAssetRefused(page);
  // A contract failure must not surface as an unhandled rejection either.
  expect(pageErrors).toEqual([]);
});

test('keeps the current scene inside the model, registry and scene budgets', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await enterAsNewMatch(page);
  await armDefendedWave(page);
  await waitForAssetsReady(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 60_000,
  });

  // Read before any screenshot: a fullPage shot stalls the frame loop, and a stalled frame is a
  // measurement artefact rather than a property of the scene (`EOB-017`).
  const finished = await readDebugOrThrow(page);
  const { budgets, checks, failures } = finished.assetBudgets;
  const scene = checks.scene;
  if (!scene) {
    throw new Error('scene budget reading missing');
  }

  // Every declared check has to have run. A hash verification that silently did not happen would
  // make the negative scenario below pass for the wrong reason, so the seam has to prove it ran.
  expect(checks.performed).toEqual({
    bytes: true,
    contentHash: true,
    nodeTypes: true,
    modelBudget: true,
    registryBudget: true,
    sceneBudget: true,
  });
  expect(failures).toEqual([]);

  expect(checks.models).toHaveLength(1);
  const spire = checks.models[0];
  expect(spire?.modelId).toBe('pulse-spire');
  expect(spire?.accepted).toBe(true);
  expect(spire?.actualBytes).toBe(spire?.expectedBytes);
  expect(spire?.contentHash).toEqual({ performed: true, matches: true, skippedReason: null });
  // The scene root, the five part meshes, the skinned crystal and its two bones. `SkinnedMesh` and
  // `Bone` are accepted types since the pipeline can clone them, so the node type check is no longer
  // what refuses a skeleton — the bone budget below is.
  expect(spire?.nodeTypes).toEqual(['Bone', 'Group', 'Mesh', 'SkinnedMesh']);
  expect(spire?.triangles).toBeLessThanOrEqual(budgets.model.triangles);
  expect(spire?.expectedBytes).toBeLessThanOrEqual(budgets.model.bytes);
  // The skeleton numbers the client measured on the loaded tree, checked against the same budget the
  // generator enforced on the build. A clip that plays is the point of them being readable at all.
  const rig = spire?.skeleton;
  expect(rig?.skins).toBe(1);
  expect(rig?.bones).toBeGreaterThan(0);
  expect(rig?.bones).toBeLessThanOrEqual(budgets.model.bones);
  expect(rig?.animationClips).toBe(1);
  expect(rig?.animationClips).toBeLessThanOrEqual(budgets.model.animationClips);
  expect(rig?.weightSlots).toBe(budgets.model.weightSlots);
  expect(rig?.boneInfluences).toBeLessThanOrEqual(budgets.model.boneInfluences);
  expect(rig?.boneInfluences).toBeGreaterThan(0);
  expect(rig?.clipSeconds).toBeLessThanOrEqual(budgets.model.clipSeconds);
  expect(rig?.clipNames).toEqual(['pulse']);
  // Every channel of the clip names a bone the mixer drives, in the glTF wording of the contract:
  // a Three.js track says `crystal-sway.quaternion`, and the client reads that back as `rotation`.
  expect(rig?.clipTargets).toEqual([{ clip: 'pulse', node: 'crystal-sway', path: 'rotation' }]);

  expect(checks.registry).not.toBeNull();
  expect(checks.registry?.models).toBeLessThanOrEqual(budgets.registry.models);
  expect(checks.registry?.bytes).toBeLessThanOrEqual(budgets.registry.bytes);
  expect(checks.registry?.triangles).toBeLessThanOrEqual(budgets.registry.triangles);
  expect(checks.registry?.bytes).toBe(spire?.expectedBytes);
  expect(checks.registry?.triangles).toBe(spire?.triangles);

  // The scene budget is the only non-deterministic measurement, so it is asserted as a bound and
  // never as a value. The floors keep an all-zero reading from passing the bounds above.
  expect(scene.drawCalls).toBeLessThanOrEqual(budgets.scene.drawCalls);
  expect(scene.renderedTriangles).toBeLessThanOrEqual(budgets.scene.renderedTriangles);
  expect(scene.shaderPrograms).toBeLessThanOrEqual(budgets.scene.shaderPrograms);
  expect(scene.assetLoadMs).toBeLessThanOrEqual(budgets.scene.assetLoadMs);
  expect(scene.drawCalls).toBeGreaterThan(0);
  expect(scene.renderedTriangles).toBeGreaterThan(0);
  expect(scene.shaderPrograms).toBeGreaterThan(0);
  expect(scene.assetLoadMs).toBeGreaterThan(0);

  console.log(
    `scene budgets: calls ${scene.drawCalls}/${budgets.scene.drawCalls}, ` +
      `triangles ${scene.renderedTriangles}/${budgets.scene.renderedTriangles}, ` +
      `programs ${scene.shaderPrograms}/${budgets.scene.shaderPrograms}, ` +
      `load ${Math.round(scene.assetLoadMs)}ms/${budgets.scene.assetLoadMs}ms, ` +
      `registry ${checks.registry?.models}/${budgets.registry.models} models, ` +
      `${checks.registry?.bytes}/${budgets.registry.bytes} bytes, ` +
      `${checks.registry?.triangles}/${budgets.registry.triangles} triangles`,
  );

  await page.screenshot({ path: 'test-results/asset-budgets-scene.png', fullPage: true });
});

test('refuses a model whose content hash the manifest does not match', async ({ page }) => {
  test.setTimeout(60_000);
  // The manifest is corrupted on the way out and never on disk: a test may not damage the
  // artifact pipeline it is supposed to check.
  await page.route('**/models/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as { models: Array<{ contentHash: string }> };
    for (const model of manifest.models) {
      model.contentHash = `sha256:${'0'.repeat(64)}`;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await enterAsNewMatch(page);
  await expectAssetRefused(page);

  // The refusal is loud and it names the model and the reason: a tampered distribution is
  // something an operator has to be able to read, not a warning in a console nobody opens.
  const status = page.getByTestId('scene-status');
  await expect(status).toContainText('model registry failed');
  await expect(status).toContainText('pulse-spire');
  await expect(status).toContainText('content hash');

  const failed = await readDebugOrThrow(page);
  expect(failed.assets.status).toBe('error');
  expect(failed.assets.models).toEqual([]);
  expect(failed.assets.error).toContain('pulse-spire');
  expect(failed.assets.error).toContain('content hash');
  // The digest is shortened for the one line of viewport chrome and kept whole where an operator
  // can act on it: the seam carries the exact value, the caption keeps its place on screen.
  const displayed = await status.textContent();
  expect(displayed).toMatch(/sha256:[0-9a-f]{8}…/i);
  expect(displayed).not.toMatch(/[0-9a-f]{32,}/i);
  expect(failed.assets.error).toContain(`sha256:${'0'.repeat(64)}`);
  expect(failed.assetBudgets.failures.join(' ')).toContain(`sha256:${'0'.repeat(64)}`);
  await expectNoChromeOverlap(page);
  // The seam separates "checked and mismatched" from "not checked at all", so a green runtime
  // can never be produced by skipping the comparison.
  const refused = failed.assetBudgets.checks.models[0];
  expect(refused?.modelId).toBe('pulse-spire');
  expect(refused?.accepted).toBe(false);
  expect(refused?.contentHash.performed).toBe(true);
  expect(refused?.contentHash.matches).toBe(false);
  expect(refused?.failures.join(' ')).toContain('content hash');
  expect(failed.assetBudgets.failures.join(' ')).toContain('content hash');
  // The artifact itself was intact, so the byte check passed and the hash check is the one that
  // refused: that ordering is what makes this the right negative scenario.
  expect(refused?.actualBytes).toBe(refused?.expectedBytes);
  expect(failed.assetBudgets.checks.performed.bytes).toBe(true);
  expect(failed.assetBudgets.checks.performed.nodeTypes).toBe(false);

  // The match stays playable on procedural placeholders.
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByTestId('start-wave').click();
  const started = await readDebugOrThrow(page);
  expect(started.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(started.towerModels[0]?.source).toBe('procedural');
  expect(started.snapshot.status).toBe('wave');
  await expectAssetRefused(page);
  await page.screenshot({ path: 'test-results/asset-refused-content-hash.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('refuses a model whose manifest claims more triangles than the model budget allows', async ({ page }) => {
  test.setTimeout(60_000);
  // Only one manifest field moves, and only on the way out. The client takes `bytes` and
  // `triangles` from the manifest, so this is the cheapest honest way to reach the runtime budget
  // refusal: the artifact on disk stays the one the build accepted.
  await page.route('**/models/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as { models: Array<{ triangles: number }> };
    for (const model of manifest.models) {
      model.triangles = MODEL_BUDGET.triangles + 1;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await enterAsNewMatch(page);
  await expectAssetRefused(page);

  // The refusal names the model, the measured value and the limit it broke, because "the registry
  // failed" is not something an operator can act on.
  const status = page.getByTestId('scene-status');
  await expect(status).toContainText('model registry failed');
  await expect(status).toContainText('pulse-spire');
  await expect(status).toContainText('triangles');
  await expect(status).toContainText(`budget allows ${MODEL_BUDGET.triangles}`);

  const failed = await readDebugOrThrow(page);
  expect(failed.assets.status).toBe('error');
  expect(failed.assets.models).toEqual([]);
  expect(failed.assets.error).toContain(`pulse-spire: triangles is ${MODEL_BUDGET.triangles + 1}`);
  // The budget refusal is the model's own reading, so it reaches both the per-model check and the
  // flat failure list the seam publishes.
  const refused = failed.assetBudgets.checks.models[0];
  expect(refused?.modelId).toBe('pulse-spire');
  expect(refused?.accepted).toBe(false);
  expect(refused?.failures.join(' ')).toContain(`budget allows ${MODEL_BUDGET.triangles}`);
  expect(failed.assetBudgets.failures.join(' ')).toContain('budget allows');
  // A run of checks has to have happened for exactly one of them to have refused: bytes and hash
  // passed, the tree was read, and the model budget is the one that said no.
  expect(failed.assetBudgets.checks.performed.bytes).toBe(true);
  expect(failed.assetBudgets.checks.performed.contentHash).toBe(true);
  expect(failed.assetBudgets.checks.performed.nodeTypes).toBe(true);
  expect(failed.assetBudgets.checks.performed.modelBudget).toBe(true);
  expect(refused?.contentHash).toEqual({ performed: true, matches: true, skippedReason: null });
  expect(refused?.nodeTypes).toEqual(['Bone', 'Group', 'Mesh', 'SkinnedMesh']);
  // A single model is far below the registry total, so the registry budgets are not what refused.
  expect(failed.assetBudgets.checks.registry?.triangles).toBeLessThanOrEqual(
    failed.assetBudgets.budgets.registry.triangles,
  );

  // The match stays playable on procedural placeholders, and the refusal stays local.
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await page.getByTestId('start-wave').click();
  const started = await readDebugOrThrow(page);
  expect(started.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(started.towerModels[0]?.source).toBe('procedural');
  expect(started.snapshot.status).toBe('wave');
  expect(started.eventCounts.waveStarted).toBe(1);
  await expectAssetRefused(page);
  await expectNoChromeOverlap(page);
  await page.screenshot({ path: 'test-results/asset-refused-model-budget.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

test('keeps the gameplay status free of dev-machine numbers and the DOM free of diagnostics', async ({ page }) => {
  test.setTimeout(60_000);
  const requested: string[] = [];
  page.on('request', (request) => requested.push(request.url()));
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  // Without the flag there is no diagnostics element to hide: it is not in the document, it is not
  // an empty one, and there is nothing a screenshot could show either.
  await expect(page.getByTestId('scene-diagnostics')).toHaveCount(0);
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-diagnostics', 'off');
  // A load that succeeded has no reason to report, so the error block stays out of the way.
  await expect(page.getByTestId('scene-report')).toBeHidden();

  const status = page.getByTestId('scene-status');
  await expect(status).toHaveText('Scene online · models ready (pulse-spire) · integrity checked');

  // The check is by key, not by eye: every scene budget value and every number this machine
  // measured has to be absent from the line a player reads. A budget is computed on the build
  // machine, so printing it here would be a false alarm on a slow connection wearing the costume
  // of a trustworthy status.
  const finished = await readDebugOrThrow(page);
  const scene = finished.assetBudgets.checks.scene;
  if (!scene) {
    throw new Error('scene budget reading missing');
  }
  const text = (await status.textContent()) ?? '';
  const forbidden: Array<[string, string]> = [
    ...Object.values(SCENE_BUDGET).map((value) => ['scene budget', String(value)] as [string, string]),
    ['measured draw calls', String(scene.drawCalls)],
    ['measured triangles', String(scene.renderedTriangles)],
    ['measured programs', String(scene.shaderPrograms)],
    ['measured load', `${Math.round(scene.assetLoadMs)} ms`],
  ];
  for (const [what, value] of forbidden) {
    expect(text, `${what} ${value} must not appear in the gameplay status`).not.toContain(value);
  }
  expect(text).not.toMatch(/over budget/i);

  // `EOB-011`: the icon is declared inline, so the browser has no file to ask for and no 404 to
  // print. A missing `/favicon.ico` reaches the console as a bare "Failed to load resource ... 404"
  // with no URL in the text, so the check that can actually see it is the silence of the boot: the
  // favicon 404 was the only error-level message a clean load produced.
  expect(consoleErrors).toEqual([]);
  const icon = await page.locator('link[rel~="icon"]').getAttribute('href');
  expect(icon).toMatch(/^data:image\/svg\+xml,/);
  expect(requested.filter((url) => /favicon/i.test(url))).toEqual([]);
  expect(pageErrors).toEqual([]);

  await expectNoChromeOverlap(page);
  await page.screenshot({ path: 'test-results/viewport-chrome-player.png', fullPage: true });
});

test('gives the refusal a block of its own and puts the budgets behind the dev flag', async ({ page }) => {
  test.setTimeout(60_000);
  // The same tampered manifest the digest scenario uses, so the reason that has to fit somewhere is
  // a full 64-character digest — the case a one-line chip could never hold.
  await page.route('**/models/manifest.json', async (route) => {
    const response = await route.fetch();
    const manifest = (await response.json()) as { models: Array<{ contentHash: string }> };
    for (const model of manifest.models) {
      model.contentHash = `sha256:${'0'.repeat(64)}`;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(manifest),
    });
  });
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?dev=1');
  await enterAsNewMatch(page);
  await expectAssetRefused(page);
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-diagnostics', 'on');

  // Both forms of the reason are true at once: short in the one line, whole in the block. The line
  // stays one line, and the value an operator has to compare is not behind an ellipsis any more.
  const status = page.getByTestId('scene-status');
  const shortLine = (await status.textContent()) ?? '';
  expect(shortLine).toMatch(/sha256:[0-9a-f]{8}…/i);
  expect(shortLine).not.toMatch(/[0-9a-f]{32,}/i);

  const digest = `sha256:${'0'.repeat(64)}`;
  const failed = await readDebugOrThrow(page);
  const reason = failed.assets.error;
  if (reason === null) {
    throw new Error('refusal reason missing');
  }
  expect(reason).toContain(digest);
  await expect(page.getByTestId('scene-report')).toBeVisible();
  await expect(page.getByTestId('scene-report-reason')).toContainText(digest);
  // The attribute carries the exact string, so the value can be compared without parsing a sentence.
  expect(await page.getByTestId('scene-report-reason').getAttribute('data-reason')).toBe(reason);

  const measured = await expectRefusalFullyReadable(page);
  expect(measured.text).toBe(reason);
  expect(measured.text).not.toContain('…');

  // The diagnostics block and the seam are read in one task, because a frame between two
  // evaluations could repaint one of them and the comparison would be of two moments.
  const dev = await page.evaluate(() => {
    const debug = window.__ECHOES_DEBUG__;
    if (!debug) {
      return null;
    }
    const rows = Object.fromEntries(
      Array.from(document.querySelectorAll('[data-testid="scene-diagnostics"] [data-diag]')).map((node) => [
        (node as HTMLElement).dataset.diag ?? '',
        node.textContent ?? '',
      ]),
    );
    return { rows, budgets: debug.assetBudgets };
  });
  if (!dev) {
    throw new Error('debug contract missing');
  }
  const reading = dev.budgets.checks.scene;
  const registry = dev.budgets.checks.registry;
  if (!reading || !registry) {
    throw new Error('dev diagnostics are missing a measurement the seam already has');
  }
  // What the block prints is what the seam measured, next to the budget it was measured against.
  expect(dev.rows.scene).toContain(`${reading.drawCalls}/${SCENE_BUDGET.drawCalls}`);
  expect(dev.rows.scene).toContain(`${reading.renderedTriangles}/${SCENE_BUDGET.renderedTriangles}`);
  expect(dev.rows.scene).toContain(`${reading.shaderPrograms}/${SCENE_BUDGET.shaderPrograms}`);
  expect(dev.rows.scene).toContain(`${Math.round(reading.assetLoadMs)}/${SCENE_BUDGET.assetLoadMs}`);
  expect(dev.rows.registry).toContain(`${registry.models}/${dev.budgets.budgets.registry.models}`);
  expect(dev.rows.model).toContain(`${registry.bytes}/${dev.budgets.budgets.model.bytes}`);
  // A check that did not run is stated as such, so a green reading cannot be produced by not looking.
  expect(dev.rows.checks).toBe(
    [
      `bytes ${dev.budgets.checks.performed.bytes ? '✓' : 'not run'}`,
      'content hash ✓',
      `node types ${dev.budgets.checks.performed.nodeTypes ? '✓' : 'not run'}`,
      `model budget ${dev.budgets.checks.performed.modelBudget ? '✓' : 'not run'}`,
      `registry budget ${dev.budgets.checks.performed.registryBudget ? '✓' : 'not run'}`,
      `scene budget ${dev.budgets.checks.performed.sceneBudget ? '✓' : 'not run'}`,
    ].join(' · '),
  );
  await expect(page.getByTestId('scene-diagnostics')).toBeVisible();

  // Neither the block nor the diagnostics may cost the caption its readability.
  await expectNoChromeOverlap(page);
  await page.screenshot({ path: 'test-results/scene-chrome-dev-refusal.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});

// --- Match persistence ----------------------------------------------------------------------

// The slot is a local artifact and the client is its only reader, so the test writes and reads it
// the same way. The key carries its schema version on purpose: a payload of a different shape
// belongs to a different key, and a payload of a different content version has to be refused by the
// validator instead of silently ignored.
const MATCH_SAVE_KEY = 'echoes-of-burbenog:match:v1';
const MATCH_SAVE_SCHEMA = 1;
const TRAINING_CONTENT_VERSION = 1;
const SAVE_COMMANDS = placements.length + 1;

const readSlot = (page: Page) => page.evaluate((key) => window.localStorage.getItem(key), MATCH_SAVE_KEY);

const writeSlot = (page: Page, value: string) =>
  page.evaluate(({ key, raw }) => window.localStorage.setItem(key, raw), { key: MATCH_SAVE_KEY, raw: value });

// The pose is the one reading of the two that is not a pure function of the input: the clip is
// advanced by whatever the frame did, so two runs of the same tick agree to floating point and not
// bit for bit. Everything else is compared exactly.
const expectSamePose = (loaded: ClipReading | null, saved: ClipReading | null) => {
  expect(loaded, 'the rebuilt run has a clip to compare').not.toBeNull();
  expect(loaded?.phase).toBeCloseTo(saved?.phase ?? Number.NaN, 6);
  expect(loaded?.time).toBeCloseTo(saved?.time ?? Number.NaN, 6);
  loaded?.pose.forEach((component, index) => {
    expect(component).toBeCloseTo(saved?.pose[index] ?? Number.NaN, 6);
  });
};

test('restores the same match from a real page reload', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('load-match')).toBeDisabled();

  // Mid-wave is where "the same match" is a real claim: gold, towers, enemies, the RNG and the pose
  // of the model all differ from anything a fresh preparation can show. The clock is frozen first,
  // so the state that is saved is a state with a known tick rather than one still moving.
  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) >= 6, undefined, {
    timeout: 60_000,
  });
  await page.getByTestId('pause-toggle').click();
  const marks = await readClockMarks(page);
  expect(findMark(marks, 'pause').tick).toBe((await readDebugOrThrow(page)).snapshot.tick);

  const saved = await readDebugOrThrow(page);
  expect(saved.paused).toBe(true);
  expect(saved.snapshot.status).toBe('wave');
  expect(saved.snapshot.enemies.length).toBeGreaterThanOrEqual(6);
  expect(saved.eventCounts.towerFired).toBeGreaterThan(0);
  expect(saved.commandCount).toBe(SAVE_COMMANDS);
  expect(saved.lastRebuild).toBeNull();
  const savedTick = saved.snapshot.tick;
  const savedSpire = saved.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(savedSpire?.clip).not.toBeNull();

  await page.getByTestId('save-match').click();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'saved');
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('save-slot')).toHaveText(`Save · tick ${savedTick} · ${SAVE_COMMANDS} commands`);

  // The payload is the input of the match and nothing else: schema version, content version, seed,
  // the tick and the tick-ordered log. No snapshot, no entity, no position.
  const raw = await readSlot(page);
  expect(raw).not.toBeNull();
  const payload = JSON.parse(raw ?? 'null') as {
    schemaVersion: number;
    contentVersion: number;
    seed: number;
    tick: number;
    log: Array<{ tick: number; command: { type: string; padId?: string; towerId?: string } }>;
  };
  expect(Object.keys(payload).sort()).toEqual(['contentVersion', 'log', 'schemaVersion', 'seed', 'tick']);
  expect(payload.schemaVersion).toBe(MATCH_SAVE_SCHEMA);
  expect(payload.contentVersion).toBe(TRAINING_CONTENT_VERSION);
  expect(payload.seed).toBe(scenario.seed);
  expect(payload.tick).toBe(savedTick);
  expect(payload.log).toHaveLength(SAVE_COMMANDS);
  expect(payload.log.map((entry) => entry.command.type)).toEqual([
    'placeTower',
    'placeTower',
    'placeTower',
    'startWave',
  ]);
  const savedPlan = await readCommandPlan(page);
  expect(payload.log.map((entry) => entry.tick)).toEqual(savedPlan?.map((entry) => entry.tick));
  // Saving reads the match and writes the slot; it does not change the match.
  const afterSave = await readDebugOrThrow(page);
  expect(afterSave.snapshot).toEqual(saved.snapshot);
  expect(afterSave.eventCounts).toEqual(saved.eventCounts);
  expect(afterSave.commandCount).toBe(saved.commandCount);

  // A real reload, not a call into the page: everything the page knew has to come back from the slot.
  await page.reload();
  await expectBooted(page);
  const reloaded = await readDebugOrThrow(page);
  expect(reloaded.commandCount).toBe(0);
  expect(reloaded.snapshot.status).toBe('preparation');
  expect(reloaded.snapshot.towers).toEqual([]);
  expect(reloaded.snapshot.tick).toBeLessThan(savedTick);
  expect(reloaded.lastRebuild).toBeNull();
  // The entry is where the page opens, and it says what it has without touching it. This is the
  // "no autoload" half of the claim: a slot that is on screen and a match that is still tick 0 of
  // its own preparation, with the clock behind the overlay not running.
  const offered = await readEntry(page);
  expect(offered.open).toBe(true);
  expect(offered.mode).toBe('slot');
  expect(offered.continuing).toBe('slot');
  expect(offered.inert).toBe(true);
  expect(offered.slot).toBe(`Save · tick ${savedTick} · ${SAVE_COMMANDS} commands`);
  expect(offered.continueVisible).toBe(true);
  expect(offered.newMatchLabel).toBe('New match');
  expect(offered.confirm).toBe('idle');
  await page.waitForTimeout(500);
  const stillOffered = await readDebugOrThrow(page);
  expect(stillOffered.snapshot.tick, 'the match ran behind the entry').toBe(reloaded.snapshot.tick);
  // The slot is visible before anything is loaded from it, and nothing was loaded by itself.
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'ready');
  await expect(page.getByTestId('save-slot')).toHaveText(`Save · tick ${savedTick} · ${SAVE_COMMANDS} commands`);
  await expect(page.getByTestId('load-match')).toBeEnabled();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'idle');
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'preparation');

  // The rebuild runs on the frame loop like any replay, so it is sped up with the same clamp a real
  // frame goes through: five ticks per frame is the product's own maximum.
  await setFrameDelta(page, 0.25);
  await waitForAssetsReady(page);
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'loaded', { timeout: 60_000 });
  await expect(page.getByTestId('save-feedback')).toHaveText(`Loaded · tick ${savedTick}`);

  const loaded = await readDebugOrThrow(page);
  const rebuild = loaded.lastRebuild;
  if (!rebuild) {
    throw new Error('the rebuild did not record the tick it arrived on');
  }
  // The claim under test, compared and not observed: the rebuild arrived on the saved tick, and the
  // state it carries there is the state the player saved. `snapshot` covers tick, gold, pads, towers,
  // enemies, the RNG and the phase; the rest is the machinery around the core.
  expect(rebuild.requestedTick).toBe(savedTick);
  expect(rebuild.tick).toBe(savedTick);
  expect(rebuild.snapshot).toEqual(saved.snapshot);
  expect(rebuild.eventCounts).toEqual(saved.eventCounts);
  expect(rebuild.commandCount).toBe(saved.commandCount);
  expect(rebuild.replayIndex).toBe(rebuild.commandCount);
  expect(rebuild.replaying).toBe(false);
  expect(rebuild.matchReports).toEqual([]);

  // Load went through the replay and not beside it: the log is the one the slot carried, every
  // command reached the core on the tick it was recorded on, and the guard is still armed.
  const loadedPlan = await readCommandPlan(page);
  expect(loadedPlan).toHaveLength(SAVE_COMMANDS);
  loadedPlan?.forEach((entry, index) => {
    expect(entry.appliedTick, `command ${index} of the rebuild landed on tick ${entry.appliedTick}`).toBe(entry.tick);
  });
  expect(loaded.commandCount).toBe(SAVE_COMMANDS);
  expect(loaded.replaying).toBe(false);
  expect(loaded.replayIndex).toBe(SAVE_COMMANDS);
  // The presentation that came out of the rebuild is the projection of its state, like any other.
  expectProjectionMatchesSnapshot(loaded);
  expectSamePose(
    rebuild.poses.find((entry) => entry.towerId === 'pulse-spire')?.clip ?? null,
    savedSpire?.clip ?? null,
  );
  // The wave is still the wave that was saved, and the match is live again: a loaded match is not a
  // frozen screenshot of one.
  expect(rebuild.snapshot.status).toBe('wave');
  expect(rebuild.snapshot.waveIndex).toBe(saved.snapshot.waveIndex);
  expect(rebuild.snapshot.waveTick).toBe(saved.snapshot.waveTick);
  expect(rebuild.snapshot.enemies.length).toBeGreaterThanOrEqual(6);
  await page.waitForFunction((tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick, rebuild.tick, {
    timeout: 30_000,
  });
  expect(await readSlot(page)).toBe(raw);

  // The phase of the rebuilt match is read from the arrival mark above, never from the live DOM
  // (`EOB-021`). This match is running again the moment the rebuild lands, and the frame clock is
  // armed at five ticks a frame, so a match saved early in the wave reaches victory within a few
  // dozen frames — a round-trip read of `match-phase` was reaching `victory` under load while the
  // product was right. What the live page may still be asked for is a property that does not move:
  // the replay guard is down and the terminal banner has nothing to say.
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-replay', 'idle');
  await expect(page.getByTestId('save-match')).toBeEnabled();
  await expect(page.getByTestId('state-badge')).toBeHidden();
  expect(rebuild.snapshot.status).toBe('wave');
  await page.screenshot({ path: 'test-results/vertical-slice-match-load.png', fullPage: true });

  // The guard the load ran behind is the guard a restart arms, and a load did not weaken it. The
  // clock is frozen first, so the restarted run can be read at its very first tick.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('restart-match').click();
  const restarted = await readDebugOrThrow(page);
  expect(restarted.paused).toBe(true);
  expect(restarted.replaying).toBe(true);
  expect(restarted.replayIndex).toBe(0);
  expect(restarted.snapshot.tick).toBe(0);
  const injected = await page.evaluate(() =>
    window.__ECHOES_DEBUG__?.dispatch({ type: 'placeTower', padId: 'pad-core', towerId: 'pulse-spire' }),
  );
  expect(injected).toEqual({ accepted: false, reason: 'replay-in-progress' });
  expect(pageErrors).toEqual([]);
  console.log(
    `reload: saved tick ${savedTick} with ${SAVE_COMMANDS} commands, rebuild arrived on ` +
      `${rebuild.tick} (requested ${rebuild.requestedTick}), status ${rebuild.snapshot.status}, ` +
      `gold ${rebuild.snapshot.gold}, ${rebuild.snapshot.enemies.length} enemies, ` +
      `plan ${describePlan(loadedPlan ?? [])}\n` +
      `pose saved   : time ${(savedSpire?.clip?.time ?? 0).toFixed(4)}s phase ${savedSpire?.clip?.phase ?? 0} ` +
      `pose [${(savedSpire?.clip?.pose ?? []).map(round4)}]\n` +
      `pose rebuilt : time ${(rebuild.poses[0]?.clip?.time ?? 0).toFixed(4)}s phase ${rebuild.poses[0]?.clip?.phase ?? 0} ` +
      `pose [${(rebuild.poses[0]?.clip?.pose ?? []).map(round4)}]`,
  );
});

test('keeps a won match won after a load and clears the slot on a new match', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const first = await readDebugOrThrow(page);
  expect(first.matchReports).toHaveLength(1);
  const firstReport = first.matchReports[0];
  expect(firstReport?.status).toBe('victory');
  expect(firstReport?.gold).toBe(victoryGold);
  const terminalTick = firstReport?.tick ?? 0;
  expect(first.snapshot.tick).toBe(terminalTick);

  await page.getByTestId('save-match').click();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'saved');
  await expect(page.getByTestId('save-slot')).toHaveText(`Save · tick ${terminalTick} · ${SAVE_COMMANDS} commands`);

  await page.reload();
  await expectBooted(page);
  const reloaded = await readDebugOrThrow(page);
  expect(reloaded.snapshot.status).toBe('preparation');
  expect(reloaded.matchReports).toEqual([]);
  expect(reloaded.lastRebuild).toBeNull();
  await expect(page.getByTestId('match-result')).toBeHidden();
  // A won match is a save like any other: the entry offers it and does not take it.
  await expect(page.getByTestId('entry-slot')).toHaveText(`Save · tick ${terminalTick} · ${SAVE_COMMANDS} commands`);
  await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'slot');

  await setFrameDelta(page, 0.25);
  await waitForAssetsReady(page);
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'loaded', { timeout: 60_000 });

  const loaded = await readDebugOrThrow(page);
  const rebuild = loaded.lastRebuild;
  if (!rebuild) {
    throw new Error('the rebuild did not record the tick it arrived on');
  }
  // A terminal state is saved as it is: the rebuild does not turn a won match into a new
  // preparation, and the report it writes is the report the run that was saved wrote.
  expect(rebuild.requestedTick).toBe(terminalTick);
  expect(rebuild.tick).toBe(terminalTick);
  expect(rebuild.snapshot.status).toBe('victory');
  expect(rebuild.snapshot).toEqual(first.snapshot);
  expect(rebuild.eventCounts).toEqual(first.eventCounts);
  expect(rebuild.matchReports).toEqual([firstReport]);
  expect(rebuild.replaying).toBe(false);
  expect(rebuild.replayIndex).toBe(rebuild.commandCount);
  await expect(page.getByTestId('match-result')).toBeVisible();
  await expect(page.getByTestId('match-result')).toHaveText('Sector secured');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'terminal');
  await expect(page.getByTestId('command-feedback')).toHaveText('Sector secured · restart repeats this run exactly');
  await expect(page.getByTestId('save-match')).toBeEnabled();
  await expect(page.getByTestId('gold-value')).toHaveText(String(victoryGold));

  // The core's own clock is stopped on a terminal state, so the loaded match holds still and can be
  // read twice without a race between the two readings.
  const settled = await readDebugOrThrow(page);
  expect(settled.snapshot).toEqual(first.snapshot);
  expect(settled.matchReports).toEqual([firstReport]);
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'ready');

  // Restart is the other action and keeps the recorded run: it repeats this match exactly. The clock
  // is frozen across the restart, so the repeated run can be read at its first tick instead of
  // wherever a sped-up replay happened to be.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('restart-match').click();
  const restarted = await readDebugOrThrow(page);
  expect(restarted.paused).toBe(true);
  expect(restarted.snapshot.tick).toBe(0);
  expect(restarted.snapshot.gold).toBe(startingGold);
  expect(restarted.commandCount).toBe(SAVE_COMMANDS);
  expect(restarted.replaying).toBe(true);
  expect(restarted.replayIndex).toBe(0);
  await page.getByTestId('pause-toggle').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });
  const rerun = await readDebugOrThrow(page);
  expect(rerun.matchReports).toHaveLength(2);
  expect(rerun.matchReports[1]).toEqual(firstReport);
  expect(rerun.snapshot.gold).toBe(victoryGold);

  // New match is not a restart: the slot goes away and the recorded run is not replayed at all.
  // The clock is frozen first so the new preparation can be read without the round-trip in it.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('new-match').click();

  const cleared = await readDebugOrThrow(page);
  expect(cleared.snapshot.status).toBe('preparation');
  expect(cleared.snapshot.tick).toBe(0);
  expect(cleared.snapshot.gold).toBe(startingGold);
  expect(cleared.snapshot.preparationTicksLeft).toBe(firstWavePrepTicks);
  expect(cleared.snapshot.pads['pad-east']).toBeNull();
  expect(cleared.snapshot.towers).toEqual([]);
  expect(cleared.snapshot.enemies).toEqual([]);
  expect(cleared.commandCount).toBe(0);
  expect(cleared.replaying).toBe(false);
  expect(cleared.rendered.towers).toBe(0);
  expect(cleared.eventCounts).toEqual(emptyEventCounts());
  expect(cleared.matchReports).toHaveLength(2);
  expect(await readSlot(page)).toBeNull();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('save-slot')).toHaveText('No save slot');
  await expect(page.getByTestId('load-match')).toBeDisabled();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'cleared');
  await expect(page.getByTestId('command-feedback')).toHaveText('New match · fresh preparation, nothing recorded');
  await expect(page.getByTestId('match-result')).toBeHidden();
  await expect(page.getByTestId('restart-match')).toBeDisabled();
  const hud = await readHud(page);
  if (!hud) {
    throw new Error('HUD contract missing');
  }
  expect(hud.restartDisabled).toBe(true);
  expect(hud.phase).toBe('preparation');
  expect(hud.status).toBe('preparation');
  expect(hud.snapshotGold).toBe(startingGold);
  expect(pageErrors).toEqual([]);
});

test('refuses a save that does not match the contract and leaves the slot untouched', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  const log = [
    { tick: 0, command: { type: 'placeTower', padId: 'pad-east', towerId: 'pulse-spire' } },
    { tick: 0, command: { type: 'startWave' } },
  ];
  const savePayload = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: MATCH_SAVE_SCHEMA,
      contentVersion: TRAINING_CONTENT_VERSION,
      seed: scenario.seed,
      tick: 12,
      log,
      ...overrides,
    });

  // Every case is a local artifact this build cannot rebuild, and each one is refused by form or by
  // version — none of them is a question about the rules of a match. A slot is read on boot, on save
  // and on load, so a substituted payload reaches the validator the way a slot left behind by
  // another build does: the page looks at it.
  const cases: Array<{ name: string; raw: string; reason: string; text: string }> = [
    {
      name: 'a schema version this build does not read',
      raw: savePayload({ schemaVersion: MATCH_SAVE_SCHEMA + 1 }),
      reason: 'save-schema-version',
      text: 'Save format v2 is not the v1 this build reads',
    },
    {
      name: 'another content version',
      raw: savePayload({ contentVersion: TRAINING_CONTENT_VERSION + 6 }),
      reason: 'save-content-version',
      text: 'Save holds content v7',
    },
    {
      name: 'a seed this build does not run',
      raw: savePayload({ seed: scenario.seed + 1 }),
      reason: 'save-seed-mismatch',
      text: `Save holds seed ${scenario.seed + 1}`,
    },
    {
      name: 'no tick at all',
      raw: JSON.stringify({ schemaVersion: MATCH_SAVE_SCHEMA, contentVersion: TRAINING_CONTENT_VERSION, seed: scenario.seed, log }),
      reason: 'save-tick-invalid',
      text: 'Save tick undefined is not a whole tick count',
    },
    {
      name: 'a command past the saved tick',
      raw: savePayload({ log: [{ tick: 17, command: { type: 'startWave' } }] }),
      reason: 'save-entry-tick-out-of-range',
      text: 'claims tick 17 outside [0, 12]',
    },
    {
      name: 'a command no build knows',
      raw: savePayload({ log: [{ tick: 0, command: { type: 'placeKeep' } }] }),
      reason: 'save-command-unknown',
      text: 'is not a command this build knows',
    },
    {
      name: 'a log that walks back in time',
      raw: savePayload({
        log: [
          { tick: 4, command: { type: 'startWave' } },
          { tick: 2, command: { type: 'startWave' } },
        ],
      }),
      reason: 'save-entry-out-of-order',
      text: 'claims tick 2 after tick 4',
    },
    {
      name: 'text where a payload belongs',
      raw: 'not a payload at all',
      reason: 'save-slot-unreadable',
      text: 'Save slot is not readable JSON',
    },
  ];

  // The first refusal happens on a page that is playing: the artifact is left alone and the match in
  // front of the player does not move, which is the property the version check exists for. The save
  // is the player's own, and something else then leaves an artifact this build cannot read where it
  // is — another tab, another build — and the dock's Load is how the player finds out.
  const incompatible = cases[1];
  if (!incompatible) {
    throw new Error('the content version case is missing');
  }
  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  });
  // Frozen, so that a refusal which moved the match would be visible and not a matter of timing.
  await page.getByTestId('pause-toggle').click();
  const frozen = await readDebugOrThrow(page);
  expect(frozen.paused).toBe(true);
  expect(frozen.snapshot.status).toBe('wave');
  await page.getByTestId('save-match').click();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'ready');

  await writeSlot(page, incompatible.raw);
  await page.getByTestId('load-match').click();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'refused');
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-reason', incompatible.reason);
  await expect(page.getByTestId('save-feedback')).toContainText('slot left untouched');
  expect(await readSlot(page), 'the slot was rewritten').toBe(incompatible.raw);
  const refused = await readDebugOrThrow(page);
  expect(refused.snapshot, 'the match moved').toEqual(frozen.snapshot);
  expect(refused.eventCounts).toEqual(frozen.eventCounts);
  expect(refused.commandCount).toBe(frozen.commandCount);
  expect(refused.replaying).toBe(false);
  expect(refused.lastRebuild, 'a rebuild ran anyway').toBeNull();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'unreadable');
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'wave');
  await expect(page.getByTestId('save-match')).toBeEnabled();

  // The rest are refused where the player meets the slot: on the entry screen. Continue is the same
  // Load, and a refusal there has to be said on the surface that is open — a reason on a line behind
  // a closed overlay is a reason nobody can act on. So the entry stays open, and the run behind it is
  // still the fresh preparation nobody asked to replace.
  for (const refusal of cases) {
    await writeSlot(page, refusal.raw);
    await page.reload();
    await expectBooted(page);
    await waitForAssetsReady(page);
    await expect(page.getByTestId('save-slot'), refusal.name).toHaveAttribute('data-state', 'unreadable');
    await expect(page.getByTestId('load-match'), refusal.name).toBeEnabled();
    await expect(page.getByTestId('entry-screen'), refusal.name).toHaveAttribute('data-entry', 'unreadable');
    await expect(page.getByTestId('entry-continue'), refusal.name).toBeVisible();
    await page.getByTestId('entry-continue').click();
    // One writer, two surfaces: the same sentence reaches the entry and the dock line.
    for (const line of ['entry-feedback', 'save-feedback']) {
      await expect(page.getByTestId(line), `${refusal.name}: ${line}`).toHaveAttribute('data-result', 'refused');
      await expect(page.getByTestId(line), `${refusal.name}: ${line}`).toHaveAttribute(
        'data-reason',
        refusal.reason,
      );
      await expect(page.getByTestId(line), `${refusal.name}: ${line}`).toContainText(refusal.text);
      await expect(page.getByTestId(line), `${refusal.name}: ${line}`).toContainText('slot left untouched');
    }
    await expect(page.getByTestId('entry-screen'), `${refusal.name}: the entry closed on a refusal`).toBeVisible();
    // The refusal is the whole outcome: the artifact stays byte for byte as it was, and a page that
    // refused it has no run of its own that the slot touched.
    expect(await readSlot(page), `${refusal.name}: the slot was rewritten`).toBe(refusal.raw);
    const after = await readDebugOrThrow(page);
    expect(after.lastRebuild, `${refusal.name}: a rebuild ran anyway`).toBeNull();
    expect(after.commandCount, `${refusal.name}: the log was taken`).toBe(0);
    expect(after.snapshot.status, `${refusal.name}: the match was replaced`).toBe('preparation');
    expect(after.snapshot.towers).toEqual([]);
    expect(after.snapshot.gold).toBe(startingGold);
    // The clock behind the overlay never ran either, so nothing happened off-screen.
    expect(after.snapshot.tick, `${refusal.name}: the match ran behind the entry`).toBe(0);
  }

  // A slot nothing can read is still cleared by an explicit action, and only by that one — and from
  // the entry that means a second press, because the slot is the one thing the game cannot bring back.
  //
  // The fresh preparation is read from the mark the page left where it built the run. The entry closes
  // on the second press and the clock is free from that instant, so a reading taken from out here lands
  // on whatever tick the round trip took to arrive: one tick under six workers, with the product right.
  // The frame clock is not put on a lattice to hold that reading still any more — a lattice no tick can
  // fit into is a claim about how long this page takes to answer, and under load one frame of it is
  // wider than the lattice. This is the `EOB-021` shape: where a rebuild arrived belongs to the page
  // that arrived, which is what `lastRebuild` already does for a load a few hundred lines up.
  await page.getByTestId('entry-new-match').click();
  await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'confirm');
  expect(await readSlot(page), 'the first press erased the slot').toBe(cases[cases.length - 1]?.raw);
  await page.getByTestId('entry-new-match').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  expect(await readSlot(page)).toBeNull();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('load-match')).toBeDisabled();
  const live = await readDebugOrThrow(page);
  const cleared = live.lastFreshRun;
  if (!cleared) {
    throw new Error('the fresh preparation recorded no tick to be read on');
  }
  expect(cleared.tick, 'the fresh preparation did not start on its own first tick').toBe(0);
  expect(cleared.snapshot.status).toBe('preparation');
  expect(cleared.snapshot.preparationTicksLeft).toBe(firstWavePrepTicks);
  expect(cleared.snapshot.gold).toBe(startingGold);
  expect(cleared.snapshot.pads['pad-east']).toBeNull();
  expect(cleared.snapshot.towers).toEqual([]);
  expect(cleared.snapshot.enemies).toEqual([]);
  expect(cleared.snapshot.rngState).toBe(scenario.seed);
  expect(cleared.commandCount).toBe(0);
  expect(cleared.replaying).toBe(false);
  expect(cleared.eventCounts).toEqual(emptyEventCounts());
  // What the page is on now is the run that mark named, and clearing a slot rebuilt nothing.
  expect(live.snapshot.status).toBe('preparation');
  expect(live.commandCount).toBe(0);
  expect(live.lastRebuild, 'clearing a slot rebuilt it').toBeNull();
  expect(pageErrors).toEqual([]);
});

test('rebuilds a preparation-only save to its tick with nothing to replay', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');

  // A preparation with no command recorded is still a save: the match has a tick, and that tick is
  // all a load has to bring back, because the log that produced it is empty. The tick of a rebuild
  // is therefore not a property of the replay — there is no replay here.
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) >= 10, undefined, { timeout: 30_000 });
  await page.getByTestId('pause-toggle').click();
  const prepared = await readDebugOrThrow(page);
  expect(prepared.snapshot.status).toBe('preparation');
  expect(prepared.commandCount).toBe(0);
  expect(prepared.snapshot.towers).toEqual([]);
  const preparedTick = prepared.snapshot.tick;
  expect(prepared.snapshot.preparationTicksLeft).toBe(Math.max(0, firstWavePrepTicks - preparedTick));

  await page.getByTestId('save-match').click();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'saved');
  await expect(page.getByTestId('save-slot')).toHaveText(`Save · tick ${preparedTick} · 0 commands`);

  await page.reload();
  await expectBooted(page);
  await setFrameDelta(page, 0.25);
  await waitForAssetsReady(page);
  // A save with an empty log is still a save, and the entry still offers it: zero commands is a
  // number the player can read, not an absent save.
  await expect(page.getByTestId('entry-slot')).toHaveText(`Save · tick ${preparedTick} · 0 commands`);
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'loaded', { timeout: 30_000 });

  const loaded = await readDebugOrThrow(page);
  const rebuild = loaded.lastRebuild;
  if (!rebuild) {
    throw new Error('the rebuild did not record the tick it arrived on');
  }
  expect(rebuild.requestedTick).toBe(preparedTick);
  expect(rebuild.tick).toBe(preparedTick);
  expect(rebuild.snapshot).toEqual(prepared.snapshot);
  expect(rebuild.eventCounts).toEqual(prepared.eventCounts);
  expect(rebuild.commandCount).toBe(0);
  expect(rebuild.replayIndex).toBe(0);
  // Nothing was recorded, so nothing was locked: a rebuilt run that has no replay is not a replay.
  expect(rebuild.replaying).toBe(false);
  expect(loaded.replaying).toBe(false);
  expect(rebuild.poses).toEqual([]);
  expect(rebuild.matchReports).toEqual([]);
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'preparation');
  await expect(page.getByTestId('save-match')).toBeEnabled();
  await expect(page.getByTestId('restart-match')).toBeDisabled();
  await expect(page.getByTestId('state-badge')).toBeHidden();
  expect(pageErrors).toEqual([]);
});

// --- Entry screen ---------------------------------------------------------------------------

// Whether the middle of an element's own box belongs to a given surface. Three claims in this section
// are about stacking — the entry over the shell, and the entry over the dev diagnostics — and stacking
// is not something a screenshot has to be believed about. `elementFromPoint` skips a `pointer-events:
// none` surface, so this answers about whatever is on top of the point, not about the element itself.
const pointInside = (page: Page, testId: string, containerTestId: string) =>
  page.evaluate(
    ({ testId, containerTestId }) => {
      const node = document.querySelector(`[data-testid="${testId}"]`);
      const box = node?.getBoundingClientRect();
      if (!node || !box) {
        throw new Error(`${testId} has no box to point at`);
      }
      const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return at?.closest(`[data-testid="${containerTestId}"]`) !== null && at?.closest(`[data-testid="${containerTestId}"]`) !== undefined;
    },
    { testId, containerTestId },
  );

test('opens the entry screen on an empty slot and starts a match from it', async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await waitForAssetsReady(page);

  // The page opens on the entry and not in a preparation. With no save there is nothing to continue,
  // so Continue is not on the screen at all rather than there and disabled: the two actions that
  // exist are the two buttons, and one of them is the only way in.
  await expect(page.getByTestId('entry-screen')).toBeVisible();
  const boot = await readEntry(page);
  expect(boot.open).toBe(true);
  expect(boot.mode).toBe('empty');
  expect(boot.continuing).toBeNull();
  expect(boot.inert).toBe(true);
  expect(boot.dialog).toBe('dialog');
  expect(boot.modal).toBe('true');
  expect(boot.slotState).toBe('empty');
  expect(boot.slot).toBe('No saved match in this browser');
  expect(boot.continueVisible).toBe(false);
  expect(boot.newMatchLabel).toBe('New match');
  expect(boot.confirm).toBe('idle');
  // Focus lands on the action that exists, so a keyboard player is not left on the document root.
  expect(boot.focused).toBe('entry-new-match');
  await expect(page.getByTestId('entry-continue')).toBeHidden();
  await expect(page.getByTestId('entry-new-match')).toBeVisible();
  // The scrim is above the shell, so a click cannot reach a pad or a dock control behind it.
  expect(await pointInside(page, 'scene-canvas', 'entry-screen')).toBe(true);
  expect(await pointInside(page, 'start-wave', 'entry-screen')).toBe(true);

  // Nothing was loaded and nothing is running: an empty slot stays empty, no rebuild happened, and
  // the preparation behind the overlay is the tick 0 it was created at.
  const parked = await readDebugOrThrow(page);
  expect(parked.lastRebuild).toBeNull();
  expect(parked.commandCount).toBe(0);
  expect(parked.snapshot.status).toBe('preparation');
  expect(parked.snapshot.tick).toBe(0);
  expect(parked.snapshot.preparationTicksLeft).toBe(firstWavePrepTicks);
  expect(parked.snapshot.towers).toEqual([]);
  expect(await readSlot(page)).toBeNull();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('load-match')).toBeDisabled();
  await page.waitForTimeout(700);
  const stillParked = await readDebugOrThrow(page);
  expect(stillParked.snapshot, 'the match ran behind the entry').toEqual(parked.snapshot);

  const wide = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-screen-empty.png', fullPage: true });

  // The same measurement on the narrow layout, where the panel is the only thing on the screen and
  // the actions have to share it.
  await page.setViewportSize({ width: 560, height: 900 });
  const narrow = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-screen-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // New match with nothing to destroy is one press: there is no irreversible action to confirm.
  await page.getByTestId('entry-new-match').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  const started = await readDebugOrThrow(page);
  expect(started.entry).toEqual({ open: false, mode: 'empty', armed: false, continuing: null });
  expect(started.snapshot.status).toBe('preparation');
  expect(started.snapshot.gold).toBe(startingGold);
  expect(started.snapshot.towers).toEqual([]);
  expect(started.snapshot.pads['pad-east']).toBeNull();
  expect(started.snapshot.rngState).toBe(scenario.seed);
  expect(started.commandCount).toBe(0);
  expect(started.replaying).toBe(false);
  expect(started.eventCounts).toEqual(emptyEventCounts());
  expect(started.lastRebuild).toBeNull();
  expect(started.rendered.towers).toBe(0);
  expectProjectionMatchesSnapshot(started);
  // The shell is live again and the dock's own line agrees with what the entry said.
  const closed = await readEntry(page);
  expect(closed.inert).toBe(false);
  expect(closed.hidden).toBe(true);
  await expect(page.getByTestId('gold-value')).toHaveText(String(startingGold));
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'preparation');
  await expect(page.getByTestId('menu-button')).toBeVisible();
  expect(pageErrors).toEqual([]);

  const labelWidths = (measured: Awaited<ReturnType<typeof expectEntryLabelsVisible>>) =>
    measured.lines.map((line) => line.glyphs.map((glyph) => glyph.width.toFixed(1)).join('+')).join(' / ');
  console.log(
    `entry (empty): ${boot.slot} · wide "${labelWidths(wide)}" · narrow "${labelWidths(narrow)}"`,
  );
});

test('plays a defended wave from the entry screen to victory with real clicks', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  // The whole path a player walks and nothing else: the entry's New match, three build pads chosen in
  // the palette and clicked on the canvas, and Start Wave. Every `evaluate` in this scenario reads
  // state or a pad's screen position — no command is ever injected, and the recorded log with the
  // ticks its commands landed on then shows that on their own.
  const atEntry = await readDebugOrThrow(page);
  expect(atEntry.snapshot.towers).toEqual([]);
  expect(atEntry.commandCount).toBe(0);

  await armDefendedWave(page);
  const armed = await readDebugOrThrow(page);
  expect(armed.snapshot.status).toBe('preparation');
  expect(armed.snapshot.towers).toHaveLength(placements.length);
  expect(armed.snapshot.gold).toBe(placedGold);
  expect(armed.eventCounts.towerPlaced).toBe(placements.length);
  expect(armed.commandCount).toBe(3);
  expect(armed.entry.open).toBe(false);

  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.eventCounts.towerFired ?? 0) > 0, undefined, {
    timeout: 60_000,
  });
  const fighting = await readDebugOrThrow(page);
  expect(fighting.snapshot.status).toBe('wave');
  expect(fighting.eventCounts.waveStarted).toBe(1);
  expect(fighting.eventCounts.towerFired).toBeGreaterThan(0);
  expectProjectionMatchesSnapshot(fighting);

  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'victory', undefined, {
    timeout: 90_000,
  });

  const finished = await readDebugOrThrow(page);
  expect(finished.matchReports).toHaveLength(1);
  const report = finished.matchReports[0];
  expect(report?.status).toBe('victory');
  expect(report?.gold).toBe(victoryGold);
  expect(report?.leaksThisWave).toBe(0);
  expect(report?.eventCounts.enemySpawned).toBe(waveEnemyCount);
  expect(report?.eventCounts.enemyKilled).toBe(waveEnemyCount);
  expect(report?.eventCounts.defeat).toBe(0);
  expect(finished.snapshot.gold).toBe(victoryGold);
  expect(finished.snapshot.enemies).toEqual([]);
  expect(finished.snapshot.towers).toHaveLength(placements.length);
  expect(finished.rendered.towers).toBe(placements.length);
  expectProjectionMatchesSnapshot(finished);
  // Four player commands, and each one reached the core on the tick it was issued on.
  const plan = await readCommandPlan(page);
  expect(plan).toHaveLength(SAVE_COMMANDS);
  plan?.forEach((entry, index) => {
    expect(entry.appliedTick, `command ${index} landed on tick ${entry.appliedTick}`).toBe(entry.tick);
  });
  expect(plan?.map((entry) => entry.type)).toEqual([
    'placeTower',
    'placeTower',
    'placeTower',
    'startWave',
  ]);
  // The terminal screen is the one `0015` left behind: the banner and the actions it already had.
  await expect(page.getByTestId('match-result')).toHaveText('Sector secured');
  await expect(page.getByTestId('match-result')).toBeVisible();
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'terminal');
  await expect(page.getByTestId('restart-match')).toBeEnabled();
  await expect(page.getByTestId('new-match')).toBeEnabled();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await page.screenshot({ path: 'test-results/entry-to-victory.png', fullPage: true });
  expect(pageErrors).toEqual([]);
  console.log(
    `entry to victory: ${describePlan(plan ?? [])} · terminal tick ${report?.tick}, gold ${report?.gold}`,
  );
});

test('reaches defeat through the entry screen with a terminal report of its own', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  // The other way out of a match, through the same entry: no towers, so the wave reaches the core.
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => window.__ECHOES_DEBUG__?.snapshot.status === 'defeat', undefined, {
    timeout: 90_000,
  });

  const finished = await readDebugOrThrow(page);
  expect(finished.matchReports).toHaveLength(1);
  const report = finished.matchReports[0];
  expect(report?.status).toBe('defeat');
  expect(report?.coreHealth).toBe(0);
  expect(report?.leaksThisWave).toBe(scenario.map.coreHealth);
  expect(report?.eventCounts.coreDamaged).toBe(scenario.map.coreHealth);
  expect(report?.eventCounts.victory).toBe(0);
  expect(report?.eventCounts.waveCleared).toBe(0);
  expect(finished.snapshot.status).toBe('defeat');
  expect(finished.snapshot.enemies).toEqual([]);
  expect(finished.commandCount).toBe(1);
  expect(finished.entry.open).toBe(false);
  // The terminal screen keeps exactly the controls it had: the banner, Restart and New match, with
  // the entry only behind MENU.
  await expect(page.getByTestId('match-result')).toHaveText('Core breached');
  await expect(page.getByTestId('restart-match')).toBeEnabled();
  await expect(page.getByTestId('menu-button')).toBeEnabled();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  const hud = await readHud(page);
  if (!hud) {
    throw new Error('hud contract missing');
  }
  expect(hud.phase).toBe('defeat');
  expect(hud.objectiveDetail).toBe('Core lost on wave 1');
  expect(pageErrors).toEqual([]);
});

test('offers Continue on a saved slot and rebuilds the same match from the entry', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  // A preparation with three towers is the cheapest honest save: the towers, the money and the pose of
  // the model are all functions of the log, and the clock can be frozen so the saved tick is a number
  // rather than a moment.
  await armDefendedWave(page);
  await page.getByTestId('pause-toggle').click();
  const armed = await readDebugOrThrow(page);
  expect(armed.paused).toBe(true);
  expect(armed.snapshot.status).toBe('preparation');
  expect(armed.commandCount).toBe(3);
  const armedTick = armed.snapshot.tick;
  const armedSpire = armed.towerModels.find((view) => view.modelId === 'pulse-spire');
  expect(armedSpire?.clip).not.toBeNull();

  await page.getByTestId('save-match').click();
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'ready');
  const raw = await readSlot(page);
  expect(raw).not.toBeNull();

  await page.reload();
  await expectBooted(page);
  await waitForAssetsReady(page);

  // The entry says what it has and touches nothing: the tick and the command count of the save, both
  // actions, and a match that is still the empty preparation of a page that just booted.
  const offered = await readEntry(page);
  expect(offered.open).toBe(true);
  expect(offered.mode).toBe('slot');
  expect(offered.continuing).toBe('slot');
  expect(offered.slotState).toBe('slot');
  expect(offered.slot).toBe(`Save · tick ${armedTick} · 3 commands`);
  expect(offered.continueVisible).toBe(true);
  expect(offered.focused).toBe('entry-continue');
  const reloaded = await readDebugOrThrow(page);
  expect(reloaded.lastRebuild, 'the entry loaded the slot by itself').toBeNull();
  expect(reloaded.commandCount).toBe(0);
  expect(reloaded.snapshot.towers).toEqual([]);
  expect(reloaded.snapshot.tick).toBeLessThan(armedTick);
  expect(await readSlot(page)).toBe(raw);
  await page.screenshot({ path: 'test-results/entry-screen-slot.png', fullPage: true });

  // Continue is the restore path, so the rebuild runs on the frame loop and is sped up with the same
  // clamp a real frame goes through.
  await setFrameDelta(page, 0.25);
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'loaded', { timeout: 60_000 });
  await expect(page.getByTestId('save-feedback')).toHaveText(`Loaded · tick ${armedTick}`);

  const loaded = await readDebugOrThrow(page);
  const rebuild = loaded.lastRebuild;
  if (!rebuild) {
    throw new Error('the rebuild did not record the tick it arrived on');
  }
  // The claim, compared and not observed: the same tick, the same state, the same command count, the
  // same pose. Every one of them comes from the arrival mark, because the match is running again by
  // the time anything outside the page could ask (`EOB-021`).
  expect(rebuild.requestedTick).toBe(armedTick);
  expect(rebuild.tick).toBe(armedTick);
  expect(rebuild.snapshot).toEqual(armed.snapshot);
  expect(rebuild.eventCounts).toEqual(armed.eventCounts);
  expect(rebuild.commandCount).toBe(3);
  expect(rebuild.replayIndex).toBe(3);
  expect(rebuild.replaying).toBe(false);
  expect(rebuild.snapshot.status).toBe('preparation');
  expectSamePose(
    rebuild.poses.find((entry) => entry.towerId === 'pulse-spire')?.clip ?? null,
    armedSpire?.clip ?? null,
  );
  const plan = await readCommandPlan(page);
  expect(plan).toHaveLength(3);
  plan?.forEach((entry, index) => {
    expect(entry.appliedTick, `command ${index} of the rebuild landed on tick ${entry.appliedTick}`).toBe(
      entry.tick,
    );
  });
  expectProjectionMatchesSnapshot(loaded);
  expect(loaded.rendered.towers).toBe(placements.length);
  expect(await readSlot(page)).toBe(raw);

  // A rebuilt match is a live match again, and it is live from where it was saved, not from zero.
  await page.waitForFunction((tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick, rebuild.tick, {
    timeout: 30_000,
  });
  const resumed = await readDebugOrThrow(page);
  expect(resumed.snapshot.tick).toBeGreaterThan(rebuild.tick);
  expect(resumed.snapshot.towers).toHaveLength(placements.length);
  expect(resumed.entry.open).toBe(false);
  expect(pageErrors).toEqual([]);
  console.log(
    `entry continue: offered "${offered.slot}", rebuild arrived on ${rebuild.tick} (requested ` +
      `${rebuild.requestedTick}), status ${rebuild.snapshot.status}, gold ${rebuild.snapshot.gold}, ` +
      `plan ${describePlan(plan ?? [])}`,
  );
});

test('clears the slot only after a confirmed New match on the entry screen', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  await armDefendedWave(page);
  await page.getByTestId('save-match').click();
  const raw = await readSlot(page);
  expect(raw).not.toBeNull();
  const savedPayload = JSON.parse(raw ?? 'null') as { tick: number; log: unknown[] };
  expect(savedPayload.log).toHaveLength(3);

  // Back to the entry the way a player goes there.
  await page.getByTestId('menu-button').click();
  expect((await readEntry(page)).mode).toBe('live');
  const parked = await readDebugOrThrow(page);

  // The first press arms and changes nothing: the slot is byte for byte what it was, no rebuild ran,
  // and the match is the match that was parked. The button and the copy say what the next press does,
  // and the slot line still names the save the second press is about to destroy.
  await page.getByTestId('entry-new-match').click();
  const armed = await readEntry(page);
  expect(armed.mode).toBe('confirm');
  expect(armed.armed).toBe(true);
  expect(armed.confirm).toBe('armed');
  expect(armed.newMatchLabel).toBe('Erase the save');
  expect(armed.slotState).toBe('slot');
  expect(armed.slot).toBe(`Save · tick ${savedPayload.tick} · 3 commands`);
  expect(armed.continueVisible).toBe(true);
  expect(armed.hint).toBe('New match erases the save in this browser. Press again to confirm.');
  expect(await readSlot(page), 'the first press erased the slot').toBe(raw);
  const duringArm = await readDebugOrThrow(page);
  expect(duringArm.lastRebuild).toBeNull();
  expect(duringArm.snapshot).toEqual(parked.snapshot);
  await page.waitForTimeout(500);
  expect((await readDebugOrThrow(page)).snapshot, 'the match ran behind the armed entry').toEqual(parked.snapshot);
  await page.screenshot({ path: 'test-results/entry-screen-confirm.png', fullPage: true });

  // The second press destroys it and starts over. The fresh preparation is read from the mark the page
  // left where it built the run, for the same reason a loaded match is read from `lastRebuild`: the entry
  // closes on the second press and the clock is free from that instant, so a reading taken from out here
  // lands on whatever tick the round trip took to arrive. The frame clock is no longer put on a lattice
  // to hold that reading still — a lattice no tick can fit into is a claim about how long this page takes
  // to answer, and under load one frame of it is wider than the lattice.
  await page.getByTestId('entry-new-match').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  expect(await readSlot(page)).toBeNull();

  const fresh = await readDebugOrThrow(page);
  const arrival = fresh.lastFreshRun;
  if (!arrival) {
    throw new Error('the fresh preparation recorded no tick to be read on');
  }
  expect(arrival.tick, 'the fresh preparation did not start on its own first tick').toBe(0);
  expect(arrival.snapshot.status).toBe('preparation');
  expect(arrival.snapshot.preparationTicksLeft).toBe(firstWavePrepTicks);
  expect(arrival.snapshot.gold).toBe(startingGold);
  expect(arrival.snapshot.pads['pad-east']).toBeNull();
  expect(arrival.snapshot.towers).toEqual([]);
  expect(arrival.snapshot.enemies).toEqual([]);
  expect(arrival.snapshot.rngState).toBe(scenario.seed);
  expect(arrival.commandCount).toBe(0);
  expect(arrival.replaying).toBe(false);
  expect(arrival.replayIndex).toBe(0);
  expect(arrival.eventCounts).toEqual(emptyEventCounts());
  // What the page is on now is the run that mark named, and clearing a slot rebuilt nothing.
  expect(fresh.snapshot.status).toBe('preparation');
  expect(fresh.commandCount).toBe(0);
  expect(fresh.rendered.towers).toBe(0);
  expect(fresh.lastRebuild, 'clearing a slot rebuilt it').toBeNull();
  expectProjectionMatchesSnapshot(fresh);
  await expect(page.getByTestId('save-slot')).toHaveAttribute('data-state', 'empty');
  await expect(page.getByTestId('save-slot')).toHaveText('No save slot');
  await expect(page.getByTestId('load-match')).toBeDisabled();
  await expect(page.getByTestId('save-feedback')).toHaveAttribute('data-result', 'cleared');
  await expect(page.getByTestId('command-feedback')).toHaveText('New match · fresh preparation, nothing recorded');
  await expect(page.getByTestId('restart-match')).toBeDisabled();
  expect(pageErrors).toEqual([]);
  console.log(
    `entry confirm: armed at tick ${parked.snapshot.tick} with "${armed.slot}", second press built ` +
      `preparation on tick ${arrival.tick} (live tick ${fresh.snapshot.tick}) and slot ${await readSlot(page)}`,
  );
});

test('returns to the entry screen from MENU without erasing the slot or the match', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/');
  await expectBooted(page);
  await enterAsNewMatch(page);
  await waitForAssetsReady(page);

  await armDefendedWave(page);
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0, undefined, {
    timeout: 60_000,
  });
  // Frozen and saved, so "MENU changed nothing" is a comparison and not an impression.
  await page.getByTestId('pause-toggle').click();
  await page.getByTestId('save-match').click();
  const saved = await readDebugOrThrow(page);
  const raw = await readSlot(page);
  expect(saved.snapshot.status).toBe('wave');
  expect(saved.snapshot.enemies.length).toBeGreaterThan(0);
  expect(raw).not.toBeNull();

  await page.getByTestId('menu-button').click();
  const entry = await readEntry(page);
  expect(entry.open).toBe(true);
  expect(entry.mode).toBe('live');
  expect(entry.continuing).toBe('match');
  expect(entry.slotState).toBe('live');
  expect(entry.slot).toBe(`In progress · tick ${saved.snapshot.tick} · ${SAVE_COMMANDS} commands`);
  expect(entry.inert).toBe(true);
  expect(entry.focused).toBe('entry-continue');
  expect(entry.hint).toBe('Menu kept the match and the save where they were. Continue goes back into the match.');
  // Nothing was erased and nothing moved: the same tick, the same gold, the same pause the player
  // left, and the slot byte for byte.
  const parked = await readDebugOrThrow(page);
  expect(parked.snapshot).toEqual(saved.snapshot);
  expect(parked.eventCounts).toEqual(saved.eventCounts);
  expect(parked.commandCount).toBe(SAVE_COMMANDS);
  expect(parked.paused).toBe(true);
  expect(parked.lastRebuild).toBeNull();
  expect(await readSlot(page)).toBe(raw);
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'wave');
  await expect(page.getByTestId('save-slot')).toHaveText(
    `Save · tick ${saved.snapshot.tick} · ${SAVE_COMMANDS} commands`,
  );
  await page.waitForTimeout(600);
  expect((await readDebugOrThrow(page)).snapshot, 'the match ran behind the entry').toEqual(parked.snapshot);
  await page.screenshot({ path: 'test-results/entry-screen-menu.png', fullPage: true });

  // Continue goes back into the match the player left. It is not a rebuild of the slot: nothing was
  // restored, the run continued from its own tick, and the player's pause is still the pause.
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  const returned = await readDebugOrThrow(page);
  expect(returned.snapshot).toEqual(parked.snapshot);
  expect(returned.paused).toBe(true);
  expect(returned.lastRebuild, 'Continue rebuilt the match instead of resuming it').toBeNull();
  expect(returned.entry.open).toBe(false);

  await page.getByTestId('pause-toggle').click();
  await page.waitForFunction((tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick, parked.snapshot.tick, {
    timeout: 30_000,
  });
  const running = await readDebugOrThrow(page);
  expect(running.snapshot.tick).toBeGreaterThan(parked.snapshot.tick);
  expect(running.snapshot.gold).toBe(parked.snapshot.gold);
  expect(running.snapshot.waveIndex).toBe(parked.snapshot.waveIndex);
  expect(running.snapshot.towers).toHaveLength(placements.length);
  expect(running.commandCount).toBe(SAVE_COMMANDS);
  expect(running.paused).toBe(false);
  await expect(page.getByTestId('match-phase')).toHaveAttribute('data-phase', 'wave');
  await expect(page.getByTestId('entry-screen')).toBeHidden();

  // MENU is a way out and back, not a one-way door: the save is still there on the second visit, and
  // both readings are taken with the entry open, so the tick they name is the tick it was parked on.
  await page.getByTestId('menu-button').click();
  const again = await readEntry(page);
  const reparked = await readDebugOrThrow(page);
  expect(again.mode).toBe('live');
  expect(again.slot).toBe(`In progress · tick ${reparked.snapshot.tick} · ${SAVE_COMMANDS} commands`);
  expect(reparked.snapshot.tick).toBeGreaterThanOrEqual(running.snapshot.tick);
  expect(await readSlot(page)).toBe(raw);
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  expect(pageErrors).toEqual([]);
  console.log(
    `entry menu: parked at tick ${parked.snapshot.tick} with "${entry.slot}", resumed to ` +
      `${running.snapshot.tick}, slot intact ${(await readSlot(page)) === raw}`,
  );
});

test('keeps the entry labels readable in every state and the dev diagnostics behind it', async ({ page }) => {
  test.setTimeout(150_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('/?dev=1');
  await expectBooted(page);
  await waitForAssetsReady(page);

  // The flag still creates the diagnostics while the entry is open, and the entry is above them
  // rather than in place of them: the dev surface is under a scrim, not gone.
  await expect(page.getByTestId('viewport')).toHaveAttribute('data-diagnostics', 'on');
  await expect(page.getByTestId('scene-diagnostics')).toHaveCount(1);
  expect((await readEntry(page)).mode).toBe('empty');
  expect(await pointInside(page, 'scene-diagnostics', 'entry-screen')).toBe(true);

  const emptyWide = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-labels-empty.png', fullPage: true });
  await page.setViewportSize({ width: 560, height: 900 });
  const emptyNarrow = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-labels-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // The panel's widest form is the one with a save: two actions, a tick and a command count.
  await enterAsNewMatch(page);
  await armDefendedWave(page);
  await page.getByTestId('save-match').click();
  await page.getByTestId('menu-button').click();
  expect((await readEntry(page)).mode).toBe('live');
  const liveWide = await expectEntryLabelsVisible(page);
  await page.setViewportSize({ width: 560, height: 900 });
  const liveNarrow = await expectEntryLabelsVisible(page);
  await page.setViewportSize({ width: 1280, height: 720 });

  // And the widest text on the panel is the confirmation, so that state is measured as well.
  await page.getByTestId('entry-new-match').click();
  expect((await readEntry(page)).mode).toBe('confirm');
  const confirmWide = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-labels-confirm.png', fullPage: true });
  await page.setViewportSize({ width: 560, height: 900 });
  const confirmNarrow = await expectEntryLabelsVisible(page);
  await page.screenshot({ path: 'test-results/entry-labels-confirm-narrow.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });

  // Every measurement above is a glyph-rect check, so each width is a fact of its own and not one
  // assertion repeated.
  const labelWidths = (measured: Awaited<ReturnType<typeof expectEntryLabelsVisible>>) =>
    measured.lines.map((line) => line.glyphs.map((glyph) => glyph.width.toFixed(1)).join('+')).join(' / ');
  expect(emptyNarrow.lines.length).toBe(emptyWide.lines.length);
  expect(liveNarrow.lines.length).toBe(liveWide.lines.length);
  expect(confirmNarrow.lines.length).toBe(confirmWide.lines.length);

  // The entry is gone, and so is the scrim: nothing of it is over the diagnostics any more, which is
  // what "the overlay did not break ?dev" has to mean.
  await page.getByTestId('entry-continue').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await expect(page.getByTestId('scene-diagnostics')).toBeVisible();
  expect(await pointInside(page, 'scene-diagnostics', 'entry-screen')).toBe(false);
  const dev = await page.evaluate(() => {
    const rows = Object.fromEntries(
      Array.from(document.querySelectorAll('[data-testid="scene-diagnostics"] [data-diag]')).map((node) => [
        (node as HTMLElement).dataset.diag ?? '',
        node.textContent ?? '',
      ]),
    );
    return { rows, budgets: window.__ECHOES_DEBUG__?.assetBudgets ?? null };
  });
  if (!dev.budgets) {
    throw new Error('debug contract missing');
  }
  const reading = dev.budgets.checks.scene;
  if (!reading) {
    throw new Error('dev diagnostics are missing a measurement the seam already has');
  }
  expect(dev.rows.scene).toContain(`${reading.drawCalls}/${SCENE_BUDGET.drawCalls}`);
  expect(dev.rows.scene).toContain(`${reading.shaderPrograms}/${SCENE_BUDGET.shaderPrograms}`);
  expect(dev.rows.checks).toContain('bytes ✓');
  expect(pageErrors).toEqual([]);
  console.log(
    `entry labels: empty "${labelWidths(emptyWide)}" → narrow "${labelWidths(emptyNarrow)}"; ` +
      `live "${labelWidths(liveWide)}" → narrow "${labelWidths(liveNarrow)}"; ` +
      `confirm "${labelWidths(confirmWide)}"`,
  );
});

// --- Authoritative session: one room, two clients -------------------------------------------------
// Everything below is measured against the room, not against a look at the screen. Two browser contexts
// meet the same room, one of them builds something with a real canvas click, and the claim "one match"
// is checked by comparing two readings of the same stream frame. Nothing about the transport is stubbed:
// the handshake, the stream and the command POST are the product's own.

test('runs one room on the session server and gives two browser contexts the same state', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('pair');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);

  // A second *context*, not a second tab. Two tabs of one context share a storage and a page object,
  // so a bug that lived in the page would pass there and fail for two real players.
  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const second = await other.newPage();
  second.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));

  try {
    await enterRoom(second, roomId);
    // The client count on each side is the room's, and it settles on two once both streams are attached.
    // Reading it straight after the second one opened would catch the frame that opened *it*.
    for (const target of [page, second]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.players ?? 0) === 2, undefined, {
        timeout: 20_000,
      });
    }
    const [first, partner] = await Promise.all([readSession(page), readSession(second)]);
    expect(first?.state).toBe('live');
    expect(partner?.state).toBe('live');
    // Different clients, one room: the names have to differ or these are not two clients at all.
    expect(first?.clientId).not.toBe(partner?.clientId);
    expect(first?.roomId).toBe(roomId);
    expect(partner?.roomId).toBe(roomId);
    expect(first?.players).toBe(2);
    expect(partner?.players).toBe(2);
    expect(first?.versions).toEqual({ protocolVersion: 1, contentVersion: 1, mapVersion: 1, seed: scenario.seed });

    const roomBefore = await readRoom(request, roomId);
    expect(roomBefore.players).toBe(2);
    expect(roomBefore.commands).toBe(0);

    // One command, from the first context, by a real click on a real pad. Nothing is dispatched through
    // the seam, so what is being compared is what a player's click produced.
    await page.getByRole('button', { name: 'Pulse Spire' }).click();
    await clickPad(page, 'pad-east');
    await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
    await expect(page.getByTestId('command-feedback')).toHaveText('Pulse Spire built on pad-east');

    // Both clients wait until the room's log has reached them, and the comparison is made at the
    // highest frame both of them holds — a "wherever each of us is now" reading would only compare two
    // different ticks and call it agreement.
    await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 1, undefined, { timeout: 20_000 });
    await second.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 1, undefined, { timeout: 20_000 });
    const [logA, logB] = await Promise.all([readFrameLog(page), readFrameLog(second)]);
    if (!logA || !logB) {
      throw new Error('a client in a room published no frame log');
    }
    const { a, b } = commonFrame(logA, logB);
    expect(a.seq).toBe(b.seq);
    expect(a.tick).toBe(b.tick);
    expect(a.gold).toBe(b.gold);
    expect(a.pads).toEqual(b.pads);
    expect(a.status).toBe(b.status);
    expect(a.commandCount).toBe(b.commandCount);
    expect(a.eventCounts).toEqual(b.eventCounts);

    // And the shared frame says what the room should say after one accepted build, which is what makes
    // "they agree" a statement about the match and not about two copies of one empty screen.
    expect(a.tick).toBeGreaterThan(0);
    expect(a.status).toBe('preparation');
    expect(a.gold).toBe(startingGold - costOf('pulse-spire'));
    expect(a.pads['pad-east']).toBe('pulse-spire');
    expect(a.eventCounts.towerPlaced).toBe(1);
    expect(a.commandCount).toBe(1);
    expect(b.deliveryMs).toBeGreaterThanOrEqual(0);

    // The two live projections agree as well, which is the claim a player would make looking at two
    // windows: same gold, same occupied pad, same one command in the room's log.
    const [liveA, liveB] = await Promise.all([readDebugOrThrow(page), readDebugOrThrow(second)]);
    expect(liveA.session.mode).toBe('remote');
    expect(liveB.session.mode).toBe('remote');
    expect(liveA.snapshot.gold).toBe(liveB.snapshot.gold);
    expect(liveA.snapshot.pads).toEqual(liveB.snapshot.pads);
    expect(liveA.commandCount).toBe(1);
    expect(liveB.commandCount).toBe(1);
    expect(liveA.rendered.towers).toBe(1);
    expect(liveB.rendered.towers).toBe(1);
    expect(liveA.eventCounts.towerPlaced).toBe(1);
    expect(liveB.eventCounts.towerPlaced).toBe(1);
    // The answer names the tick the room's core was standing on when it took the command, and that is
    // not the tick of the frame the two clients were compared at — the room kept ticking after that. What
    // has to hold is that the number is a real tick, it is not in the future, and it is the first command
    // the room was given.
    const answer = liveA.session.lastCommand;
    expect(answer?.commandId).toBe(1);
    expect(answer?.accepted).toBe(true);
    expect(answer?.reason).toBeNull();
    expect(Number.isInteger(answer?.tick)).toBe(true);
    expect(answer?.tick ?? 0).toBeGreaterThan(0);
    expect(answer?.tick ?? 0).toBeLessThanOrEqual(a.tick);
    // The second client never sent anything, so it has no answer of its own — the command is the room's
    // log, not a local echo of someone else's click.
    expect(liveB.session.lastCommand).toBeNull();
    await expect(second.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'idle');

    const roomAfter = await readRoom(request, roomId);
    expect(roomAfter.commands).toBe(1);
    expect(roomAfter.players).toBe(2);
    expect(roomAfter.tick).toBeGreaterThanOrEqual(a.tick);

    // Nothing in the dock belongs to a local core: the four controls that act on a local `Simulation`
    // are off, and the two that ask the room something follow the seat. This client opened the room, so
    // it holds the owner seat and both of those are on — Restart and End room are the room's own verbs,
    // not a rebuild of a core that is not here. The command control is on for the same reason as ever:
    // a command is a command wherever it goes.
    await expect(page.getByTestId('pause-toggle')).toBeDisabled();
    await expect(page.getByTestId('save-match')).toBeDisabled();
    await expect(page.getByTestId('load-match')).toBeDisabled();
    await expect(page.getByTestId('new-match')).toBeDisabled();
    await expect(page.getByTestId('start-wave')).toBeEnabled();
    await expect(page.getByTestId('restart-match')).toBeEnabled();
    await expect(page.getByTestId('restart-match')).toHaveAttribute('data-seat', 'owner');
    await expect(page.getByTestId('end-room')).toBeVisible();
    await expect(page.getByTestId('end-room')).toBeEnabled();
    await expect(page.getByTestId('save-slot')).toHaveText('Room match · not saved here');
    // The second client joined an existing room and is a guest, so the same two controls are off and
    // each one names the reason it is off.
    await expect(second.getByTestId('restart-match')).toBeDisabled();
    await expect(second.getByTestId('restart-match')).toHaveAttribute('data-reason', 'owner-only-restart');
    await expect(second.getByTestId('end-room')).toBeDisabled();
    await expect(second.getByTestId('end-room')).toHaveAttribute('data-reason', 'owner-only-end-room');
    await expect(second.getByTestId('start-wave')).toBeEnabled();
    expect(pageErrors).toEqual([]);

    const deliveries = logA.map((entry) => entry.deliveryMs).sort((left, right) => left - right);
    console.log(
      `room ${roomId}: both clients agreed at frame ${a.seq} — tick ${a.tick}, gold ${a.gold}, ` +
        `towerPlaced ${a.eventCounts.towerPlaced}, ${a.commandCount} command; ` +
        `delivery median ${deliveries[Math.floor(deliveries.length / 2)]}ms, max ${deliveries[deliveries.length - 1]}ms; ` +
        `room at tick ${roomAfter.tick} with ${roomAfter.commands} command(s)`,
    );
  } finally {
    await other.close();
  }
});

test('gives a client that joins late the current state of the room instead of an empty match', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('join');
  await enterRoom(page, roomId);

  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-south');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.getByTestId('start-wave').click();
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.status ?? 'preparation') === 'wave', undefined, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.enemies.length ?? 0) > 0, undefined, { timeout: 20_000 });
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > 6, undefined, { timeout: 20_000 });

  // The reading the first client is on when the second one walks in. It is taken before the second
  // context exists, so it is a fact about the room as it was and not about the two of them together.
  const before = await readDebugOrThrow(page);
  const beforePlan = await readCommandPlan(page);

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const second = await other.newPage();
  try {
    await enterRoom(second, roomId);
    const log = await readFrameLog(second);
    if (!log || log.length === 0) {
      throw new Error('a client that joined late published no frame');
    }
    // The frame that opens a connection is a whole state, not a fresh match. If it were a fresh match,
    // this would be a state frame at tick 0 with no towers and the room would be two matches.
    const opening = log[0]!;
    expect(opening.kind).toBe('state');
    expect(opening.players).toBe(2);
    expect(opening.commandCount).toBe(before.commandCount);
    expect(opening.commandCount).toBe(3);
    expect(opening.tick).toBeGreaterThan(before.snapshot.tick);
    expect(opening.status).toBe('wave');
    // Pads and the command count cannot move on their own between the two readings, so they are compared
    // outright. Gold and the event totals can — a kill lands while the second context is opening — so
    // they are held to what a fresh match could never report. A client that joined into an empty match of
    // its own would be at tick 0, at the full 220 aether, with two empty pads and no towers.
    expect(opening.pads).toEqual(before.snapshot.pads);
    expect(opening.pads['pad-east']).toBe('pulse-spire');
    expect(opening.pads['pad-south']).toBe('grove-lens');
    expect(opening.gold).toBeGreaterThanOrEqual(startingGold - costOf('pulse-spire') - costOf('grove-lens'));
    expect(opening.gold).toBeLessThan(startingGold);
    expect(opening.eventCounts.towerPlaced).toBe(2);
    expect(opening.eventCounts.waveStarted).toBe(1);
    // Enemies are counted too, and the late client has never seen one spawn. It reports the room's
    // number, which is the only way a client that was not there for a fight can still be in that fight.
    expect(opening.eventCounts.enemySpawned).toBeGreaterThan(0);

    const late = await readDebugOrThrow(second);
    expect(late.snapshot.towers).toHaveLength(2);
    expect(late.snapshot.status).toBe('wave');
    expect(late.snapshot.enemies.length).toBeGreaterThan(0);
    expect(late.commandCount).toBe(3);
    expect(late.eventCounts.towerPlaced).toBe(before.eventCounts.towerPlaced);
    expect(late.eventCounts.waveStarted).toBe(1);
    expect(late.rendered.towers).toBe(2);
    expectProjectionMatchesSnapshot(late);
    // The log of the room came across whole, and it came across with the room's own ticks: the late
    // client publishes the same three entries, on the ticks the room took them, and each one is applied
    // on the tick it was sent on. A reconstruction from the late client's own clock could not know that.
    const plan = await readCommandPlan(second);
    expect(plan).toEqual(beforePlan);
    expect(plan?.map((entry) => entry.type)).toEqual(['placeTower', 'placeTower', 'startWave']);
    expect(plan?.every((entry) => entry.appliedTick === entry.tick)).toBe(true);
    expect(plan?.map((entry) => entry.tick)).toEqual([...plan!.map((entry) => entry.tick)].sort((a, b) => a - b));

    const room = await readRoom(request, roomId);
    expect(room.players).toBe(2);
    expect(room.commands).toBe(3);
    expect(room.status).toBe('wave');
    console.log(
      `late join ${roomId}: opened at tick ${opening.tick} (first client ${before.snapshot.tick}) with ` +
        `${opening.commandCount} commands, gold ${opening.gold}, towerPlaced ${opening.eventCounts.towerPlaced}`,
    );
  } finally {
    await other.close();
  }
});

test('refuses a handshake whose versions the room does not run and never opens the stream', async ({ page, request }) => {
  test.setTimeout(120_000);
  const roomId = roomName('vers');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const streamRequests: string[] = [];
  page.on('request', (req) => {
    if (req.url().includes('/stream')) {
      streamRequests.push(req.url());
    }
  });

  await page.goto(`/?room=${roomId}`);
  await expect(page.getByTestId('session-strip')).toHaveAttribute('data-mode', 'remote');
  await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'room');

  // Each version in turn, including the seed, because a seed that differs is the same class of mistake
  // as a version that differs: the client would be drawing a match the room never simulated. The seat
  // token is in the same list because it is the same kind of trust boundary — a value this browser
  // offers and the room has to be able to read before it binds anything to it.
  const refusals: Array<{ overrides: Record<string, unknown>; reason: string; found: string }> = [
    { overrides: { protocolVersion: PROTOCOL_VERSION + 1 }, reason: 'protocol-version-mismatch', found: 'protocol v2' },
    { overrides: { contentVersion: CONTENT_VERSION + 1 }, reason: 'content-version-mismatch', found: 'content v2' },
    { overrides: { mapVersion: MAP_VERSION + 1 }, reason: 'map-version-mismatch', found: 'map v2' },
    { overrides: { seed: scenario.seed + 1 }, reason: 'seed-mismatch', found: `seed ${scenario.seed + 1}` },
    { overrides: { role: 'spectator' }, reason: 'role-not-permitted', found: 'spectator' },
    { overrides: { seatToken: 'not-a-seat-token' }, reason: 'seat-shape', found: 'not-a-seat-token' },
  ];

  for (const refusal of refusals) {
    await armHandshake(page, refusal.overrides);
    await page.getByTestId('entry-join-room').click();
    await waitForSessionState(page, 'refused');
    const reading = await readSession(page);
    expect(reading?.state, `no refusal for ${JSON.stringify(refusal.overrides)}`).toBe('refused');
    expect(reading?.roomId).toBe(roomId);
    expect(reading?.refusal?.reason).toBe(refusal.reason);
    // The refusal names the number that arrived and not only the one that was wanted: a mismatch is a
    // question, and a client that cannot say what it said cannot be helped.
    expect(reading?.refusal?.found).toContain(refusal.found);
    expect(reading?.refusal?.text.length ?? 0).toBeGreaterThan(0);
    expect(reading?.clientId).toBeNull();
    expect(reading?.frames).toBe(0);
    expect(reading?.seq).toBe(0);
    await expect(page.getByTestId('entry-feedback')).toHaveAttribute('data-result', 'refused');
    await expect(page.getByTestId('entry-feedback')).toHaveAttribute('data-reason', refusal.reason);
    await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'room');
    await expect(page.getByTestId('entry-join-room')).toBeVisible();
  }

  // Not one byte of the stream was asked for: the match cannot start from a client the room would not
  // take, and the local core was never stepped either — the picture behind the entry is still tick 0.
  expect(streamRequests).toEqual([]);
  const debug = await readDebugOrThrow(page);
  expect(debug.snapshot.tick).toBe(0);
  expect(debug.snapshot.towers).toEqual([]);
  expect(debug.commandCount).toBe(0);
  expect(debug.frames).toBeGreaterThan(0);
  expect(debug.entry.open).toBe(true);
  const room = await readRoom(request, roomId);
  expect(room.players).toBe(0);
  expect(room.tick).toBe(0);
  expect(room.commands).toBe(0);
  expect(room.status).toBe('preparation');
  expect(room.versions).toEqual({
    protocolVersion: PROTOCOL_VERSION,
    contentVersion: CONTENT_VERSION,
    mapVersion: MAP_VERSION,
    seed: scenario.seed,
  });

  // With the versions back where they belong the same page walks into the same room, which is what
  // makes the refusal a decision about the numbers and not about the client.
  await armHandshake(page, null);
  await page.getByTestId('entry-join-room').click();
  await waitForSessionState(page, 'live');
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  expect(streamRequests.length).toBe(1);
  expect(pageErrors).toEqual([]);
  console.log(
    `handshake ${roomId}: refused ${refusals.map((refusal) => refusal.reason).join(', ')}; ` +
      `the room never moved past tick ${(await readRoom(request, roomId)).tick}`,
  );
});

test('does not tick locally in a room: a client without the room stream stands still', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('tick');
  await enterRoom(page, roomId);
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) >= 5, undefined, { timeout: 20_000 });
  const connected = await readDebugOrThrow(page);
  const connectedSession = await readSession(page);
  expect(connectedSession?.seq ?? 0).toBeGreaterThan(0);
  expect(connectedSession?.frames ?? 0).toBeGreaterThan(0);

  // A second client whose stream request never leaves the browser. The room admits it — the handshake is
  // its own exchange and it succeeds — and then never gets to send it a single frame, so this client is
  // in a room, connected by the room's own accounting, with no state at all.
  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const stranded = await other.newPage();
  try {
    await stranded.route('**/api/rooms/*/stream**', (route) => route.abort());
    await stranded.goto(`/?room=${roomId}`);
    await stranded.getByTestId('entry-join-room').click();
    await waitForSessionState(stranded, 'offline');
    const first = await readDebugOrThrow(stranded);
    const firstSession = await readSession(stranded);
    expect(firstSession?.state).toBe('offline');
    expect(firstSession?.refusal?.reason).toBe('stream-refused');
    expect(firstSession?.frames).toBe(0);
    expect(firstSession?.seq).toBe(0);
    expect(first.entry.open).toBe(true);

    // Nothing arrived, so nothing moved — and the page is not dead: the frame counter only ever goes up,
    // and it went up while the room's tick ran on ahead. The count is a witness that the page is alive,
    // not a claim about how fast it draws: two WebGL contexts on one machine draw at whatever rate they
    // draw at, and the assertion is about the number moving at all.
    const roomBefore = await readRoom(request, roomId);
    await page.waitForFunction((tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick + 15, connected.snapshot.tick, {
      timeout: 30_000,
    });
    const later = await readDebugOrThrow(stranded);
    const laterSession = await readSession(stranded);
    expect(later.frames, 'the page stopped drawing instead of stopping the match').toBeGreaterThan(first.frames);
    expect(laterSession?.frames).toBe(0);
    expect(laterSession?.seq).toBe(0);
    expect(later.snapshot.tick).toBe(first.snapshot.tick);
    expect(later.snapshot).toEqual(first.snapshot);
    expect(later.eventCounts).toEqual(first.eventCounts);
    expect(later.commandCount).toBe(0);
    expect(later.replaying).toBe(false);
    expect(later.lastRebuild).toBeNull();

    // The room, meanwhile, went on: the connected client moved and the server says so twice. That gap is
    // the whole claim — a page that had quietly taken the clock back would be one that moved too.
    const live = await readDebugOrThrow(page);
    const room = await readRoom(request, roomId);
    expect(live.snapshot.tick).toBeGreaterThan(later.snapshot.tick);
    expect(room.tick).toBeGreaterThan(roomBefore.tick);
    expect(room.tick).toBeGreaterThan(later.snapshot.tick);
    expect(room.players).toBe(1);
    console.log(
      `no local tick ${roomId}: the stranded client held tick ${later.snapshot.tick} while drawing ` +
        `${later.frames - first.frames} more frames and applying ${laterSession?.frames}; the room went ` +
        `${roomBefore.tick} -> ${room.tick} and the connected client reached ${live.snapshot.tick}`,
    );
  } finally {
    await other.close();
  }
});

test('shows the reason the room gave for a rejected command and does not apply it on the client', async ({ page, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('refuse');
  await enterRoom(page, roomId);
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await expect(page.getByTestId('command-feedback')).toHaveText('Pulse Spire built on pad-east');
  const built = await readDebugOrThrow(page);
  expect(built.snapshot.gold).toBe(startingGold - costOf('pulse-spire'));

  // The same pad, the same module, from a client that has not heard anything yet. The client cannot know
  // the pad is taken — it has no rules — so the reason has to come from the room, and it has to be the
  // room's reason rather than one the page made up for itself.
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'rejected');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-reason', 'pad-occupied');
  await expect(page.getByTestId('command-feedback')).toHaveText('Pad already occupied');

  const refused = await readDebugOrThrow(page);
  expect(refused.session.lastCommand).toEqual({
    commandId: 2,
    accepted: false,
    reason: 'pad-occupied',
    tick: refused.session.lastCommand?.tick,
  });
  // Nothing about the match moved: the room refused, so the room's state is the same state. A client that
  // applied the command to its own core would have dropped the gold a second time.
  expect(refused.snapshot.gold).toBe(startingGold - costOf('pulse-spire'));
  expect(refused.snapshot.pads['pad-east']).toBe('pulse-spire');
  expect(refused.snapshot.towers).toHaveLength(1);
  expect(refused.eventCounts.towerPlaced).toBe(1);
  expect(refused.rendered.towers).toBe(1);
  // The client's own log is the room's log, entry for entry. A command the client wrote down itself is a
  // command that exists nowhere but in its picture, and a rejected command is not a command at all.
  expect(refused.commandCount).toBe(1);
  expect(await readCommandPlan(page)).toHaveLength(1);
  expect((await readCommandPlan(page))?.[0]?.type).toBe('placeTower');
  // And the room's own log agrees: a rejected command is not recorded as one.
  const room = await readRoom(request, roomId);
  expect(room.commands).toBe(1);

  // A second module, the same way round: accepted once, refused on the same pad, with the gold that is
  // left being the room's arithmetic and not the client's.
  await page.getByRole('button', { name: 'Grove Lens' }).click();
  await clickPad(page, 'pad-north');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await expect(page.getByTestId('command-feedback')).toHaveText('Grove Lens built on pad-north');
  const second = await readDebugOrThrow(page);
  expect(second.snapshot.gold).toBe(startingGold - costOf('pulse-spire') - costOf('grove-lens'));
  expect(second.session.lastCommand?.commandId).toBe(3);

  await clickPad(page, 'pad-north');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'rejected');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-reason', 'pad-occupied');
  const twice = await readDebugOrThrow(page);
  expect(twice.snapshot.gold).toBe(startingGold - costOf('pulse-spire') - costOf('grove-lens'));
  expect(twice.snapshot.towers).toHaveLength(2);
  expect(twice.eventCounts.towerPlaced).toBe(2);
  expect(twice.session.lastCommand).toEqual({
    commandId: 4,
    accepted: false,
    reason: 'pad-occupied',
    tick: twice.session.lastCommand?.tick,
  });
  // And the room's own log agrees: a rejected command is not recorded as one.
  expect((await readRoom(request, roomId)).commands).toBe(2);
  console.log(
    `room refusal ${roomId}: "Pad already occupied" came from the room twice, gold held at ` +
      `${twice.snapshot.gold} across both refusals, room log ${(await readRoom(request, roomId)).commands} command(s)`,
  );
});

test('names the session in solo and in a room, and keeps solo the default', async ({ page }) => {
  test.setTimeout(120_000);
  const strip = page.getByTestId('session-strip');

  // Solo is what the address means by default: no `room` parameter, one `Simulation`, one clock.
  await page.goto('/');
  await expect(strip).toHaveAttribute('data-mode', 'solo');
  await expect(strip).toHaveAttribute('data-state', 'local');
  await expect(strip).toHaveAttribute('data-room', '');
  await expect(page.getByTestId('session-name')).toHaveText('Solo');
  await expect(page.getByTestId('session-detail')).toHaveText('Local match · this browser');
  await expect(page.getByTestId('entry-room-line')).toHaveText('Solo · local match in this browser');
  await expect(page.getByTestId('entry-join-room')).toBeDisabled();
  const solo = await readDebugOrThrow(page);
  expect(solo.session.mode).toBe('solo');
  expect(solo.session.state).toBe('local');
  expect(solo.session.roomId).toBeNull();
  expect(solo.session.players).toBe(0);
  // The local clock is still the product's: solo ticks, and nothing about a room took it away.
  await page.getByTestId('entry-new-match').click();
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > 0, undefined, { timeout: 20_000 });

  // A name that is not a room name does not put the page into a mode it cannot get out of: the address
  // chooses the room, and an address that does not name one is a solo match.
  await page.goto('/?room=Not%20A%20Room');
  await expect(strip).toHaveAttribute('data-mode', 'solo');
  expect((await readDebugOrThrow(page)).session.state).toBe('local');

  // A room by address: the strip says which one, the entry says the same, and the number of clients is
  // the room's count rather than a claim about this window.
  const roomId = roomName('strip');
  await page.goto(`/?room=${roomId}`);
  await expect(strip).toHaveAttribute('data-mode', 'remote');
  await expect(strip).toHaveAttribute('data-state', 'idle');
  await expect(strip).toHaveAttribute('data-room', roomId);
  await expect(strip).toHaveAttribute('data-clients', '0');
  await expect(page.getByTestId('session-name')).toHaveText(`Room ${roomId}`);
  await expect(page.getByTestId('session-detail')).toHaveText('Not entered');
  await expect(page.getByTestId('entry-room-line')).toHaveText(`Room ${roomId} · Not entered`);
  await expect(page.getByTestId('entry-join-room').first()).toBeEnabled();
  await expect(page.getByTestId('entry-join-room')).toHaveText('Enter room');
  // In a room the local slot is not what Continue acts on, so the line that describes it is not shown.
  await expect(page.getByTestId('entry-slot')).toBeHidden();
  await expect(page.getByTestId('entry-continue')).toBeHidden();
  await expect(page.getByTestId('entry-new-match')).toBeHidden();

  await page.getByTestId('entry-join-room').click();
  await waitForSessionState(page, 'live');
  await expect(strip).toHaveAttribute('data-clients', '1');
  // The aether statement is on the strip rather than behind the entry, because the player who has to
  // read it is the one already playing: a late joiner arrives through the entry, but the next person to
  // spend a shared purse is a client that has been in the room for a while.
  await expect(page.getByTestId('session-detail')).toHaveText(`1 client · the room's clock · shared aether`);
  // The entry is gone in a room, which is what lets the viewport be the match; `MENU` brings the room
  // panel back and that is where the room state is read.
  await expect(page.getByTestId('entry-screen')).toBeHidden();
  await page.getByTestId('menu-button').click();
  await expect(page.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'room');
  await expect(page.getByTestId('entry-room-line')).toHaveText(`Room ${roomId} · 1 client · the room's clock · shared aether`);
  await expect(page.getByTestId('entry-hint')).toContainText('Aether is shared');
  await expect(page.getByTestId('entry-join-room')).toHaveText('Leave room');
  await expect(page.getByTestId('entry-join-room')).toHaveAttribute('data-action', 'leave');

  // Leaving is a navigation, and it is the only way out of a room from inside it. The room keeps its
  // match; the page that comes back to the same address walks in through the handshake again, which is
  // why the address is the single source of truth about which match this page is in.
  await page.getByTestId('entry-join-room').click();
  await page.waitForURL((url) => !url.searchParams.has('room'), { timeout: 20_000 });
  await expect(strip).toHaveAttribute('data-mode', 'solo');
  await expect(strip).toHaveAttribute('data-state', 'local');
  expect((await readDebugOrThrow(page)).session.roomId).toBeNull();
  console.log(`session strip: solo reads "Solo · Local match · this browser", a room reads "Room ${roomId} · 1 client · the room's clock"`);
});

test('keeps the room panel and the session strip readable at both widths', async ({ page }) => {
  test.setTimeout(120_000);
  const roomId = roomName('panel');
  await page.goto(`/?room=${roomId}`);
  await expect(page.getByTestId('entry-screen')).toBeVisible();
  await expect(page.getByTestId('entry-room-line')).toHaveText(`Room ${roomId} · Not entered`);

  // The same measure as the dock and the rest of the entry: glyph rects inside the padding box of the
  // box that shows them, at the QA viewport and at the narrow one where the panel is the whole screen.
  const wide = await expectEntryLabelsVisible(page);
  const stripWide = await expectLabelsVisible(page, '[data-testid="session-name"], [data-testid="session-detail"]', '.session-strip');
  await page.screenshot({ path: 'test-results/session-room-entry.png', fullPage: true });
  await page.setViewportSize({ width: 560, height: 900 });
  const narrow = await expectEntryLabelsVisible(page);
  const stripNarrow = await expectLabelsVisible(page, '[data-testid="session-name"], [data-testid="session-detail"]', '.session-strip');
  await page.screenshot({ path: 'test-results/session-room-narrow.png', fullPage: true });
  await page.setViewportSize(SESSION_VIEWPORT);
  expect(narrow.lines.length).toBe(wide.lines.length);
  expect(narrow.buttons.length).toBe(wide.buttons.length);
  expect(stripNarrow.length).toBe(stripWide.length);

  // And the panel in the state that matters: connected, with a room name, a client count and a clock the
  // page does not own.
  await page.getByTestId('entry-join-room').click();
  await waitForSessionState(page, 'live');
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.status ?? '') === 'wave', undefined, { timeout: 20_000 });
  await expectLabelsVisible(page, '[data-testid="session-name"], [data-testid="session-detail"]', '.session-strip');
  await page.screenshot({ path: 'test-results/session-room-live.png', fullPage: true });

  await page.getByTestId('menu-button').click();
  const open = await expectEntryLabelsVisible(page);
  await expect(page.getByTestId('entry-room-line')).toHaveText(
    `Room ${roomId} · 1 client · the room's clock · shared aether`,
  );
  await page.screenshot({ path: 'test-results/session-room-menu.png', fullPage: true });
  const labelWidths = (measured: Awaited<ReturnType<typeof expectEntryLabelsVisible>>) =>
    measured.lines.map((line) => `${line.text.slice(0, 18)} ${line.glyphs.map((glyph) => glyph.width.toFixed(1)).join('+')}`).join(' | ');
  console.log(
    `room panel ${roomId}: wide "${labelWidths(wide)}" | narrow "${labelWidths(narrow)}" | ` +
      `menu "${labelWidths(open)}"; strip ${stripWide.map((line) => line.glyphs[0]?.width.toFixed(1)).join('/')}px wide, ` +
      `${stripNarrow.map((line) => line.glyphs[0]?.width.toFixed(1)).join('/')}px narrow`,
  );
});

// --- Room permissions, reconnect and late join -------------------------------------------------
// Everything below is measured against the room and against a second real browser context, because
// none of it is a claim one window can make: a permission is about two seats, a reconnect is about
// what a client does after the frames stop, and a shared purse is about two clients spending one
// number. Nothing here is stubbed — the handshake, the stream, the command POST and the room-verb POST
// are the product's own transport.

test('refuses a guest both room verbs by name and changes nothing at all', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('perm');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const guest = await other.newPage();
  guest.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));

  try {
    await enterRoom(guest, roomId);
    for (const target of [page, guest]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.players ?? 0) === 2, undefined, {
        timeout: 20_000,
      });
    }
    // The room decided the seats, and it decided them the way the protocol says: the client whose
    // handshake opened the room owns it, the one that arrived after is a guest. Neither was asked.
    const owner = await readSession(page);
    const joined = await readSession(guest);
    expect(owner?.seatRole).toBe('owner');
    expect(joined?.seatRole).toBe('guest');
    expect(owner?.seatToken).toMatch(/^[a-z0-9]{22}$/);
    expect(joined?.seatToken).toMatch(/^[a-z0-9]{22}$/);
    expect(joined?.seatToken).not.toBe(owner?.seatToken);

    await page.getByRole('button', { name: 'Pulse Spire' }).click();
    await clickPad(page, 'pad-east');
    await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
    // The flag and the log are two different facts arriving on two different connections: the flag is
    // written from the room's answer to the POST, the log reaches this page in a frame. The room happens to
    // send that frame before its answer, so on a quiet machine a read right behind the flag usually sees the
    // log already there — but that is the room's ordering, not this test's right to assume it. So the log
    // is waited for, and what follows is the log as it arrived.
    await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 1, undefined, {
      timeout: 20_000,
    });
    const settled = await readDebugOrThrow(page);
    const roomBefore = await readRoom(request, roomId);
    expect(settled.commandCount).toBe(1);
    expect(roomBefore.commands).toBe(1);

    // The guest's controls are off, and each one names the room's reason on it: a disabled button that
    // says nothing is indistinguishable from a bug, and one that said "rejected" would be the page
    // inventing a rule it is not allowed to have.
    await expect(guest.getByTestId('restart-match')).toBeDisabled();
    await expect(guest.getByTestId('restart-match')).toHaveAttribute('data-reason', 'owner-only-restart');
    await expect(guest.getByTestId('restart-match')).toHaveAttribute('data-seat', 'guest');
    expect(await guest.getByTestId('restart-match').getAttribute('title')).toBe(
      'Only the room owner restarts the run',
    );
    await expect(guest.getByTestId('end-room')).toBeDisabled();
    await expect(guest.getByTestId('end-room')).toHaveAttribute('data-reason', 'owner-only-end-room');
    expect(await guest.getByTestId('end-room').getAttribute('title')).toBe('Only the room owner closes the room');

    // The owner's own pair is open, which is what makes the difference between the two windows a
    // difference of seat and not of build.
    await expect(page.getByTestId('restart-match')).toBeEnabled();
    expect(await page.getByTestId('restart-match').getAttribute('data-reason')).toBeNull();
    await expect(page.getByTestId('end-room')).toBeEnabled();
    await guest.screenshot({ path: 'test-results/session-room-guest.png', fullPage: true });

    // And the room refuses the request when one is made anyway, over its own route with the guest's own
    // client id. This is the half a disabled control cannot prove: the gate is the room's, and the
    // control is only the room's answer made visible.
    const refusedRestart = await askRoomVerb(request, roomId, joined?.clientId ?? '', 'restartRun');
    expect(refusedRestart.accepted).toBe(false);
    expect(refusedRestart.reason).toBe('owner-only-restart');
    expect(refusedRestart.role).toBe('guest');
    expect(refusedRestart.verb).toBe('restartRun');
    const refusedClose = await askRoomVerb(request, roomId, joined?.clientId ?? '', 'endRoom');
    expect(refusedClose.accepted).toBe(false);
    expect(refusedClose.reason).toBe('owner-only-end-room');
    expect(refusedClose.role).toBe('guest');
    expect(refusedClose.verb).toBe('endRoom');

    // A refused verb is not an event in the match. The tick moved on, the gold is the gold the build
    // left, the log still holds one command and both clients are still in the room: a permission that
    // changed any of those would not be a permission.
    const roomAfter = await readRoom(request, roomId);
    expect(roomAfter.tick).toBeGreaterThan(roomBefore.tick);
    expect(roomAfter.commands).toBe(1);
    expect(roomAfter.players).toBe(2);
    expect(roomAfter.status).toBe(roomBefore.status);
    const [afterOwner, afterGuest] = await Promise.all([readDebugOrThrow(page), readDebugOrThrow(guest)]);
    expect(afterOwner.snapshot.gold).toBe(startingGold - costOf('pulse-spire'));
    expect(afterGuest.snapshot.gold).toBe(afterOwner.snapshot.gold);
    expect(afterOwner.snapshot.pads['pad-east']).toBe('pulse-spire');
    expect(afterGuest.rendered.towers).toBe(1);
    expect(afterOwner.commandCount).toBe(1);
    expect(afterGuest.commandCount).toBe(1);
    expect(afterOwner.eventCounts.towerPlaced).toBe(1);
    expect(afterGuest.session.state).toBe('live');
    expect(afterOwner.session.state).toBe('live');
    // The guest's client was never told anything about the two requests the test made on its behalf: it
    // was not the one that sent them, and the room's answer to them is not a frame.
    expect(afterGuest.session.lastVerb).toBeNull();
    expect(pageErrors).toEqual([]);
    console.log(
      `permissions ${roomId}: guest ${joined?.seatRole} refused restartRun(${refusedRestart.reason}) and ` +
        `endRoom(${refusedClose.reason}) while the room went ${roomBefore.tick} -> ${roomAfter.tick} with ` +
        `${roomAfter.commands} command and ${roomAfter.players} clients`,
    );
  } finally {
    await other.close();
  }
});

test('restarts the run for every client at the owner request and keeps the seat', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('restart');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const guest = await other.newPage();
  guest.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));

  try {
    await enterRoom(guest, roomId);
    for (const target of [page, guest]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.players ?? 0) === 2, undefined, {
        timeout: 20_000,
      });
    }
    // A match with something in it, so that "restarted" is a claim about a run that was replaced rather
    // than about two empty preparations looking alike.
    await page.getByRole('button', { name: 'Pulse Spire' }).click();
    await clickPad(page, 'pad-east');
    await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
    await page.getByRole('button', { name: 'Grove Lens' }).click();
    await clickPad(page, 'pad-north');
    await page.getByTestId('start-wave').click();
    await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.status ?? '') === 'wave', undefined, {
      timeout: 20_000,
    });
    for (const target of [page, guest]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 3, undefined, {
        timeout: 20_000,
      });
    }
    const before = await readDebugOrThrow(page);
    expect(before.commandCount).toBe(3);
    expect(before.snapshot.towers).toHaveLength(2);
    expect((await readRoom(request, roomId)).commands).toBe(3);

    // One press, one verb, one room. The result both clients get is the room's, not a rebuild one of them
    // performed: there is no local core in here to rebuild, and the frame is what puts two windows back
    // into the same match.
    await page.getByTestId('restart-match').click();
    await expect(page.getByTestId('command-feedback')).toHaveText(
      'Room run restarted · every client got the new preparation',
    );
    for (const target of [page, guest]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.status ?? '') === 'preparation', undefined, {
        timeout: 20_000,
      });
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 1) === 0, undefined, {
        timeout: 20_000,
      });
    }
    const [afterOwner, afterGuest] = await Promise.all([readDebugOrThrow(page), readDebugOrThrow(guest)]);
    for (const [after, target] of [
      [afterOwner, page],
      [afterGuest, guest],
    ] as const) {
      expect(after.snapshot.status).toBe('preparation');
      // The run was replaced, and "replaced" is measured against the run that was there: an exact tick
      // would be a bound on how long a reading took to come back, not on the rule.
      expect(after.snapshot.tick).toBeLessThan(before.snapshot.tick);
      expect(after.snapshot.gold).toBe(startingGold);
      expect(after.snapshot.pads).toEqual(Object.fromEntries(after.padIds.map((padId) => [padId, null])));
      expect(after.snapshot.towers).toEqual([]);
      expect(after.snapshot.enemies).toEqual([]);
      expect(after.rendered.towers).toBe(0);
      expect(after.commandCount).toBe(0);
      expect(await readCommandPlan(target)).toEqual([]);
      expect(after.eventCounts).toEqual(emptyEventCounts());
      expect(after.replaying).toBe(false);
      expect(after.matchReports).toEqual([]);
    }
    // The answer to the verb belongs to the client that asked, and it names what the room did with it.
    // The guest's client has none, because the guest sent nothing: the frame it is looking at is the
    // same frame the owner caused, and it did not need a sentence of its own to learn about it.
    expect(afterOwner.session.lastVerb).toEqual({
      verb: 'restartRun',
      accepted: true,
      reason: null,
      tick: afterOwner.session.lastVerb?.tick,
      role: 'owner',
    });
    expect(afterGuest.session.lastVerb).toBeNull();

    // A run is not a room: the guest is still a guest, so a restart did not quietly hand anybody a door.
    expect(afterOwner.session.seatRole).toBe('owner');
    expect(afterGuest.session.seatRole).toBe('guest');
    await expect(guest.getByTestId('restart-match')).toBeDisabled();
    await expect(guest.getByTestId('restart-match')).toHaveAttribute('data-reason', 'owner-only-restart');
    await expect(guest.getByTestId('end-room')).toBeDisabled();
    const room = await readRoom(request, roomId);
    expect(room.commands).toBe(0);
    expect(room.status).toBe('preparation');
    expect(room.players).toBe(2);
    await guest.screenshot({ path: 'test-results/session-room-restart.png', fullPage: true });
    expect(pageErrors).toEqual([]);
    console.log(
      `restart ${roomId}: owner restarted at tick ${before.snapshot.tick} and both clients came back to ` +
        `preparation ${afterOwner.snapshot.tick} with 0 commands and 0 towers; room tick now ${room.tick}`,
    );
  } finally {
    await other.close();
  }
});

test('closes the room for everyone, names the reason and gives the name back', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('close');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const guest = await other.newPage();
  guest.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));

  try {
    await enterRoom(guest, roomId);
    for (const target of [page, guest]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.players ?? 0) === 2, undefined, {
        timeout: 20_000,
      });
    }
    await page.getByRole('button', { name: 'Pulse Spire' }).click();
    await clickPad(page, 'pad-east');
    await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
    const playedTo = await readRoom(request, roomId);
    expect(playedTo.commands).toBe(1);


    await page.getByTestId('end-room').click();
    await expect(page.getByTestId('command-feedback')).toHaveText('Room closed · nobody can sit in it again');

    // Both clients are sent back to the entry and both are told why. Nobody is left looking at a room
    // that has simply stopped answering, which is the failure mode a closed room has to avoid: an empty
    // screen and no sentence is indistinguishable from a bug, and the sentence costs one frame.
    for (const [target, label] of [
      [page, 'owner'],
      [guest, 'guest'],
    ] as const) {
      await waitForSessionState(target, 'refused');
      await expect(target.getByTestId('entry-screen')).toBeVisible();
      await expect(target.getByTestId('entry-screen')).toHaveAttribute('data-entry', 'room');
      await expect(target.getByTestId('entry-feedback')).toHaveAttribute('data-reason', 'room-closed');
      await expect(target.getByTestId('entry-feedback')).toHaveText('The room owner closed this room');
      await expect(target.getByTestId('session-detail')).toHaveText('The room owner closed this room');
      await expect(target.getByTestId('entry-hint')).toContainText('The owner closed this room');
      const reading = await readSession(target);
      expect(reading?.closure?.reason, `${label} was not told why`).toBe('room-closed');
      expect(reading?.closure?.by).toBe('owner');
      expect(reading?.seatRole, `${label} kept a seat in a room that ended`).toBeNull();
      // The controls that asked the room for something are off with the reason on them, because there
      // is no room left to ask.
      await expect(target.getByTestId('restart-match')).toBeDisabled();
      await expect(target.getByTestId('restart-match')).toHaveAttribute('data-reason', 'session-not-live');
      await expect(target.getByTestId('end-room')).toBeDisabled();
    }
    await page.screenshot({ path: 'test-results/session-room-closed.png', fullPage: true });

    // The name is free. The room is not a tombstone, it is gone: the next client under that name opens a
    // new match, and it owns it, because opening it is what owning it means.
    expect((await readRooms(request)).map((entry) => entry.roomId)).not.toContain(roomId);

    const third: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
    const fresh = await third.newPage();
    fresh.on('pageerror', (error) => pageErrors.push(`c: ${error.message}`));
    let freshTick = 0;
    try {
      await enterRoom(fresh, roomId);
      const reading = await readSession(fresh);
      expect(reading?.state).toBe('live');
      expect(reading?.roomId).toBe(roomId);
      expect(reading?.players).toBe(1);
      expect(reading?.seatRole).toBe('owner');
      expect(reading?.commandCount).toBe(0);
      const freshRoom = await readRoom(request, roomId);
      freshTick = freshRoom.tick;
      expect(freshRoom.commands).toBe(0);
      expect(freshRoom.status).toBe('preparation');
      // A new match, not the old one on another name: it starts below the tick the closed room had
      // reached. An exact bound here would be about how long a reading took to arrive.
      expect(freshRoom.tick).toBeLessThan(playedTo.tick);

      await expect(fresh.getByTestId('end-room')).toBeEnabled();
      const debug = await readDebugOrThrow(fresh);
      expect(debug.snapshot.towers).toEqual([]);
      expect(debug.snapshot.pads['pad-east']).toBeNull();
    } finally {
      await third.close();
    }
    expect(pageErrors).toEqual([]);
    console.log(
      `close ${roomId}: both clients sent back to the entry with room-closed, the name answered again as a ` +
        `new match at tick ${freshTick} with its owner seat`,
    );
  } finally {
    await other.close();
  }
});

test('hands the same seat back after a dropped stream, whole, from the tick the room stood still on', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const roomId = roomName('rejoin');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await enterRoom(page, roomId);
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 1, undefined, {
    timeout: 20_000,
  });

  const before = await readDebugOrThrow(page);
  const beforeLog = await readFrameLog(page);
  const seat = before.session.seatToken;
  const plan = await readCommandPlan(page);
  expect(before.session.seatRole).toBe('owner');
  expect(before.session.connect.handshakes).toBe(1);
  expect(before.session.connect.reconnects).toBe(0);
  expect(before.commandCount).toBe(1);

  // The stream goes. Nothing is guessed and nothing is asked for: the client says it is offline, and the
  // entry comes back with the one action that exists for it.
  await breakStream(page);
  await waitForSessionState(page, 'offline');
  const lost = await readSession(page);
  expect(lost?.refusal?.reason).toBe('stream-refused');
  expect(lost?.seatRole).toBe('owner');
  // The last frame this client held, read after the stream is gone so that it is the last frame that
  // existed and not the last one a reading happened to catch. This and the frame the returning client is
  // given are the two ends the comparison below is made on: a page read taken before the break and a page
  // read taken after the return are two live readings of a room that ran on between them, and the totals it
  // keeps move while nobody is watching — `preparationEnded` changes from 0 to 1 across that interval, and
  // comparing the two is how a correct product goes red.
  const heldLog = await readFrameLog(page);
  const lastSeen = heldLog?.[heldLog.length - 1];
  if (!lastSeen) {
    throw new Error('the client published no frame before the stream was dropped');
  }
  await expect(page.getByTestId('entry-screen')).toBeVisible();
  await expect(page.getByTestId('entry-hint')).toContainText('Continue goes back in as the same seat');
  // The action the entry offers is the one that carries the seat, and it says so.
  await expect(page.getByTestId('entry-join-room')).toHaveText('Continue');
  await expect(page.getByTestId('entry-join-room')).toHaveAttribute('data-action', 'continue');
  expect(beforeLog?.length ?? 0).toBeGreaterThan(0);

  // A room with no clients does not go on playing a match nobody is in. It stands still, and this is the
  // half of the rule that matters: a client that came back to a room which had caught up on the wall
  // clock would be looking at a match it was not there for. The detach is waited for rather than
  // assumed, because the room learns about a closed connection when the request ends, and the first
  // reading taken after that instant would otherwise be a reading of a room that had not noticed yet.
  await expect
    .poll(async () => (await readRoom(request, roomId)).players, { timeout: 20_000 })
    .toBe(0);
  const frozen = await readRoom(request, roomId);
  const atBreak = await readDebugOrThrow(page);
  await page.waitForTimeout(1_500);
  const stillThere = await readRoom(request, roomId);
  const held = await readDebugOrThrow(page);
  expect(stillThere.tick, 'the room went on without a client in it').toBe(frozen.tick);
  // The client stood still as well, and it stood still by being alive: the frame counter is the witness
  // that the page is drawing and the match is the thing that is not moving.
  expect(held.snapshot.tick).toBe(atBreak.snapshot.tick);
  expect(held.snapshot).toEqual(atBreak.snapshot);
  expect(held.frames, 'the page stopped drawing instead of stopping the match').toBeGreaterThan(atBreak.frames);
  expect(beforeLog?.length ?? 0).toBeGreaterThan(0);
  const standing = frozen.tick;


  // Back in, the same way as the first time: one handshake, the seat token, and the whole room in the
  // frame that opens the stream. No delta, no catch-up, no second path of state.
  await page.getByTestId('entry-join-room').click();
  await waitForSessionState(page, 'live');
  await expect(page.getByTestId('entry-screen')).toBeHidden();

  const after = await readDebugOrThrow(page);
  const afterLog = await readFrameLog(page);
  if (!afterLog || afterLog.length === 0) {
    throw new Error('a reconnecting client published no frame');
  }
  // The frame that opened the stream is a whole state, and it is the first thing this client saw again.
  const opening = afterLog[0]!;
  expect(opening.kind).toBe('state');
  expect(after.session.connect.handshakes).toBe(2);
  expect(after.session.connect.reconnects).toBe(1);
  expect(after.session.seatToken).toBe(seat);
  expect(after.session.seatRole).toBe('owner');
  expect(Number.isFinite(after.session.connect.handshakeMs)).toBe(true);
  expect(Number.isFinite(after.session.connect.firstFrameMs)).toBe(true);
  // Same match: the log, the pads and the purse are the room's, whole and unchanged, which a delta could
  // not have carried. They are compared on the two frames — the last one this client held and the one
  // that opened the stream on its return — because the room went on between them, and a command is the
  // only thing that can change any of the three.
  expect(after.commandCount).toBe(1);
  expect(afterLog.every((entry) => entry.commandCount === 1)).toBe(true);
  expect(await readCommandPlan(page)).toEqual(plan);
  expect(opening.commandCount).toBe(lastSeen.commandCount);
  expect(opening.pads).toEqual(lastSeen.pads);
  expect(opening.gold).toBe(startingGold - costOf('pulse-spire'));
  expect(after.rendered.towers).toBe(1);
  // The event totals are the one thing that legitimately grew: the room ran the ticks the client was not
  // there for, and its totals are cumulative. So they are checked as what they are — the same run carried
  // forward and never rewound. A room rebuilt underneath the returning client would hand back zeroed
  // totals, which is the failure this catches and not a comparison of two moving readings.
  const grew = (Object.keys(opening.eventCounts) as Array<keyof typeof opening.eventCounts>).filter(
    (type) => opening.eventCounts[type] !== lastSeen.eventCounts[type],
  );
  for (const type of Object.keys(opening.eventCounts) as Array<keyof typeof opening.eventCounts>) {
    expect(opening.eventCounts[type], `${type} went backwards across the reconnect`).toBeGreaterThanOrEqual(
      lastSeen.eventCounts[type],
    );
  }
  // Same place in time: the room stood still, so the client comes back where the room is, not where the
  // frames it missed would have put it and not at the end of a catch-up. The client left on a tick the
  // room had already passed, because the room keeps going for the moment it takes to notice a closed
  // connection — that interval is the whole reason the two ends of the comparison are frames.
  expect(lastSeen.tick).toBeLessThanOrEqual(standing);
  expect(opening.tick).toBeGreaterThanOrEqual(standing);
  expect(opening.tick).toBeLessThanOrEqual(standing + 2);
  // The owner came back as the owner, which is the whole point of a token instead of a fresh seat.
  await expect(page.getByTestId('end-room')).toBeEnabled();
  await expect(page.getByTestId('end-room')).toHaveAttribute('data-seat', 'owner');
  // The cost of coming back is reported rather than hidden behind a median: the handshake the client had
  // to wait for is inside `firstFrameMs`, and the worst single delivery in the whole reconnected stream
  // is named next to it. No threshold is applied to either — the limit on delay is a budget on a
  // reference machine, and there is no reference machine yet (`EOB-002`).
  const worst = afterLog.reduce((highest, entry) => Math.max(highest, entry.deliveryMs), 0);
  expect(Number.isFinite(worst)).toBe(true);
  expect(after.session.connect.firstFrameMs ?? 0).toBeGreaterThanOrEqual(opening.deliveryMs);

  const resumed = await readRoom(request, roomId);
  expect(resumed.players).toBe(1);
  expect(resumed.tick).toBeGreaterThan(standing);
  expect(resumed.commands).toBe(1);
  await page.waitForFunction((tick) => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > tick, opening.tick, {
    timeout: 20_000,
  });
  await page.screenshot({ path: 'test-results/session-room-reconnect.png', fullPage: true });
  expect(pageErrors).toEqual([]);
  console.log(
    `reconnect ${roomId}: the room stood at tick ${standing} with 0 players for 1.5 s, the returning client ` +
      `handshaked again (${after.session.connect.handshakeMs?.toFixed(1)}ms) and got a whole ${opening.kind} ` +
      `frame of ${opening.tick} — first frame ${after.session.connect.firstFrameMs?.toFixed(1)}ms, its delivery ` +
      `${opening.deliveryMs}ms, worst in the reconnected stream ${worst}ms, seat back as ${after.session.seatRole}; ` +
      `the frame before the break was ${lastSeen.tick} with the same ${opening.commandCount} command and the same ` +
      `board, totals moved by ${grew.length === 0 ? 'nothing' : grew.join(', ')}`,
  );

});

test('gives the loser of a seat the reason by name and frees the seat when the holder leaves', async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(180_000);
  const roomId = roomName('seat');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);
  const owner = await readSession(page);
  const seat = owner?.seatToken ?? '';
  expect(owner?.seatRole).toBe('owner');

  // A second context is handed the same seat token, which is what a browser that already held it would do
  // on a second tab. Nothing is patched: the token travels in the slot, through the same reader the
  // product uses, and the room is asked exactly the question a returning player is asked.
  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  await seedSeat(other, seat);
  const second = await other.newPage();
  second.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));

  try {
    await enterRoom(second, roomId);
    // The last connection to present a seat holds it. The earlier one is not left reading a stream it has
    // no right to: it is told, on that stream, that the seat is gone and who has it now.
    await waitForSessionState(page, 'refused');
    const lost = await readSession(page);
    const taken = await readSession(second);
    expect(lost?.refusal?.reason).toBe('seat-taken');
    expect(lost?.closure?.reason).toBe('seat-taken');
    expect(lost?.closure?.found).toBe(taken?.clientId);
    await expect(page.getByTestId('entry-screen')).toBeVisible();
    await expect(page.getByTestId('entry-feedback')).toHaveAttribute('data-reason', 'seat-taken');
    await expect(page.getByTestId('entry-feedback')).toHaveText('A later connection took this seat');
    await expect(page.getByTestId('session-detail')).toHaveText('A later connection took this seat');
    await expect(page.getByTestId('entry-hint')).toContainText('only an owner restarts the run or closes the room');
    expect(taken?.seatToken).toBe(seat);
    expect(taken?.seatRole).toBe('owner');
    expect(taken?.state).toBe('live');
    expect((await readRoom(request, roomId)).players).toBe(1);
    await expect(second.getByTestId('end-room')).toBeEnabled();
  } finally {
    // Closing the connection frees the seat without destroying it: the token still means the same place,
    // and the role it carries is what the next holder gets back.
    await other.close();
  }

  const third: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  await seedSeat(third, seat);
  const again = await third.newPage();
  again.on('pageerror', (error) => pageErrors.push(`c: ${error.message}`));
  let backAs: string | null = null;
  try {
    await enterRoom(again, roomId);
    const reading = await readSession(again);
    backAs = reading?.seatRole ?? null;
    expect(reading?.state).toBe('live');
    expect(reading?.seatToken).toBe(seat);
    expect(reading?.seatRole).toBe('owner');
    expect((await readRoom(request, roomId)).players).toBe(1);
    await expect(again.getByTestId('end-room')).toBeEnabled();
  } finally {
    await third.close();
  }
  expect(pageErrors).toEqual([]);
  console.log(
    `seat ${roomId}: seat …${seat.slice(-4)} moved to a second context, the first was told seat-taken and ` +
      `left the room, and the same seat came back to a third as ${backAs}`,
  );
});

test('lets a late client build at once and says the aether is shared', async ({ page, browser, request }) => {
  test.setTimeout(180_000);
  const roomId = roomName('share');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(`a: ${error.message}`));
  await enterRoom(page, roomId);
  await page.getByRole('button', { name: 'Pulse Spire' }).click();
  await clickPad(page, 'pad-east');
  await expect(page.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
  await page.getByTestId('start-wave').click();
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.status ?? '') === 'wave', undefined, {
    timeout: 20_000,
  });
  await page.waitForFunction(() => (window.__ECHOES_DEBUG__?.snapshot.tick ?? 0) > 8, undefined, { timeout: 20_000 });

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const late = await other.newPage();
  late.on('pageerror', (error) => pageErrors.push(`b: ${error.message}`));
  try {
    await enterRoom(late, roomId);
    const joined = await readSession(late);
    const openingLog = await readFrameLog(late);
    expect(joined?.seatRole).toBe('guest');
    expect(joined?.state).toBe('live');
    // The statement about the purse is on the strip, where the player who is about to spend it is
    // looking, and on the entry for the one that arrived through it. Without it a newcomer reads the
    // number as a purse of their own and spends what is not there.
    await expect(late.getByTestId('session-detail')).toHaveText(`2 clients · the room's clock · shared aether`);
    await late.getByTestId('menu-button').click();
    await expect(late.getByTestId('entry-hint')).toContainText('Aether is shared');
    await late.getByTestId('entry-continue').click();
    await expect(late.getByTestId('entry-screen')).toBeHidden();

    // A guest may build the moment it arrives: the board and the aether are the room's, and a permission
    // that hid the second player from the board would be the separate-economy decision this task
    // explicitly does not take.
    await late.getByRole('button', { name: 'Frost Relay' }).click();
    await clickPad(late, 'pad-south');
    await expect(late.getByTestId('command-feedback')).toHaveAttribute('data-feedback', 'accepted');
    await expect(late.getByTestId('command-feedback')).toHaveText('Frost Relay built on pad-south');
    for (const target of [page, late]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.commandCount ?? 0) >= 3, undefined, {
        timeout: 20_000,
      });
    }

    // One purse, one log, one board — said at one moment, on a frame both clients applied. Two live
    // readings would compare two instants of a room that is running a wave and paying out in between, so
    // what they agreed about would be the round trip, not the match. The shared frame is one moment with
    // two witnesses, and the room's own log sits behind it as a third.
    const [logA, logB] = await Promise.all([readFrameLog(page), readFrameLog(late)]);
    if (!logA || !logB) {
      throw new Error('a client in a room published no frame log');
    }
    const { a, b } = commonFrame(logA, logB);
    expect(a.seq).toBe(b.seq);
    expect(a.tick).toBe(b.tick);
    expect(a.gold).toBe(b.gold);
    expect(a.pads).toEqual(b.pads);
    expect(a.commandCount).toBe(b.commandCount);
    expect(a.eventCounts).toEqual(b.eventCounts);
    expect(a.status).toBe(b.status);
    // And the frame they agree on is the match both of them are in, not two copies of an empty screen: a
    // build from each seat, the wave they started, gold already spent. The exact gold is deliberately
    // still not asserted — the wave pays bounty and rewards while this runs, so a number computed here
    // would be a bound on the wall clock rather than on the rule. The rule is the agreement, and it now
    // holds at a single instant.
    expect(a.status).toBe('wave');
    expect(a.commandCount).toBe(3);
    expect(a.pads['pad-east']).toBe('pulse-spire');
    expect(a.pads['pad-south']).toBe('frost-relay');
    expect(a.gold).toBeLessThan(startingGold);
    // Each window has the frame applied, so the second tower is on both boards: that is a claim about the
    // projection of one frame, not a comparison of two readings of a moving room.
    const [owner, guest] = await Promise.all([readDebugOrThrow(page), readDebugOrThrow(late)]);
    expect(owner.rendered.towers).toBe(2);
    expect(guest.rendered.towers).toBe(2);
    expect(owner.commandCount).toBe(3);
    expect(guest.commandCount).toBe(3);
    const room = await readRoom(request, roomId);
    expect(room.commands).toBe(3);
    expect(room.players).toBe(2);
    expect(room.status).toBe('wave');
    expect(room.tick).toBeGreaterThanOrEqual(a.tick);

    await late.screenshot({ path: 'test-results/session-room-shared.png', fullPage: true });
    expect(pageErrors).toEqual([]);
    console.log(
      `shared aether ${roomId}: a guest joined at tick ${openingLog?.[0]?.tick} built on pad-south at once, ` +
        `and both clients applied frame ${a.seq} at tick ${a.tick} with gold ${a.gold}, ` +
        `${room.commands} commands in one log and ${room.players} clients`,
    );
  } finally {
    await other.close();
  }
});

// The window the steady-state delay is read over. It is a number in one place because the sample's shape
// is now asserted against it: the frames in the window have to cover the window, and a floor on the sample
// is derived from it and the room's own declared rate.
const DELAY_WINDOW_SECONDS = 10;

test('measures the steady-state frame delay on two warm clients', async ({ page, browser }) => {
  test.setTimeout(180_000);
  const roomId = roomName('delay');
  await enterRoom(page, roomId);

  const other: BrowserContext = await browser.newContext({ viewport: SESSION_VIEWPORT });
  const second = await other.newPage();
  try {
    await enterRoom(second, roomId);
    for (const target of [page, second]) {
      await target.waitForFunction(() => (window.__ECHOES_DEBUG__?.session.players ?? 0) === 2, undefined, {
        timeout: 20_000,
      });
    }
    // The window opens only after both clients are up and the room is going. The delay while a second
    // browser was starting is the cost of starting a browser, not the cost of the room, and a strategy
    // for interpolation chosen on it would be a strategy about the wrong number.
    const [logA, logB] = await Promise.all([readFrameLog(page), readFrameLog(second)]);
    const shared = commonFrame(logA ?? [], logB ?? []);
    const from = shared.a.seq;
    const step = (await readDebugOrThrow(page)).tickRate;
    await page.waitForTimeout(DELAY_WINDOW_SECONDS * 1000);

    const [warmA, warmB] = await Promise.all([readFrameLog(page), readFrameLog(second)]);
    // Nothing from before the window is in the numbers, and both sides are measured the same way.
    const a = (warmA ?? []).filter((entry) => entry.seq > from);
    const b = (warmB ?? []).filter((entry) => entry.seq > from);
    expect(a.every((entry) => entry.seq > shared.a.seq)).toBe(true);
    expect(b.every((entry) => entry.seq > shared.b.seq)).toBe(true);
    // What the sample has to be able to carry is a tail, and that is a property of the window rather
    // than of the machine. `expect(a.length).toBeGreaterThan(120)` said it as a count, which is a claim
    // about how many ticks the room held in ten seconds on this host: it holds 16/s idle and was measured
    // at 11/s under six workers (`EOB-026`), so the same number passed and failed depending on the load
    // and never said anything about a tail. So the rate is reported and not asserted, and the sample is
    // required to cover the window it was taken in — a room running slowly still fills ten seconds of
    // page clock, it just delivers fewer frames into them.
    const measured = (sample: FrameLogReading[], label: string) => {
      const stats = deliveryPercentiles(sample.map((entry) => entry.deliveryMs));
      const spanSeconds = (sample[sample.length - 1]!.at - sample[0]!.at) / 1000;
      return { label, stats, spanSeconds, framesPerSecond: spanSeconds > 0 ? stats.count / spanSeconds : 0 };
    };
    // A floor rather than a target: a quarter of what the room declares for this window. It says the
    // sample is not degenerate and it admits a room well below its declared rate, which is a number the
    // room is measured at rather than one this test may hold it to.
    const minimum = Math.floor((step * DELAY_WINDOW_SECONDS) / 4);
    const first = measured(a, 'a');
    const secondStats = measured(b, 'b');
    for (const [reading, sample] of [
      [first, a],
      [secondStats, b],
    ] as const) {
      const { label, stats, spanSeconds } = reading;
      expect(spanSeconds, `client ${label} covered ${spanSeconds.toFixed(2)}s of the ${DELAY_WINDOW_SECONDS}s window`).toBeGreaterThanOrEqual(
        DELAY_WINDOW_SECONDS * 0.9,
      );
      expect(stats.count, `client ${label} holds ${stats.count} frames, below the ${minimum} the declared rate puts in this window`).toBeGreaterThanOrEqual(
        minimum,
      );
      // Every number in the ladder is a delivery this client actually received, in order.
      expect(sample.every((entry) => Number.isFinite(entry.deliveryMs) && entry.deliveryMs >= 0)).toBe(true);
      expect(stats.p50).toBeLessThanOrEqual(stats.p95);
      expect(stats.p95).toBeLessThanOrEqual(stats.p99);
      expect(stats.p99).toBeLessThanOrEqual(stats.max);
    }
    // Each client's delays are its own: two windows do not render on the same schedule, and a single
    // shared figure would be a number about neither of them.
    console.log(
      `frame delay ${roomId}: window opens at seq ${from} with both clients attached, room step ${step} ticks/s — ` +
        `client a ${first.stats.count} frames over ${first.spanSeconds.toFixed(2)}s (${first.framesPerSecond.toFixed(1)}/s) ` +
        `p50 ${first.stats.p50}ms p95 ${first.stats.p95}ms p99 ${first.stats.p99}ms max ${first.stats.max}ms; ` +
        `client b ${secondStats.stats.count} frames over ${secondStats.spanSeconds.toFixed(2)}s ` +
        `(${secondStats.framesPerSecond.toFixed(1)}/s) p50 ${secondStats.stats.p50}ms p95 ${secondStats.stats.p95}ms ` +
        `p99 ${secondStats.stats.p99}ms max ${secondStats.stats.max}ms; floor for a non-degenerate sample ${minimum} frames`,
    );
  } finally {
    await other.close();
  }
});
