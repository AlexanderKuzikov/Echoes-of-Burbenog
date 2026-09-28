import { strict as assert } from 'node:assert';
import { createSimulation, createTrainingScenario } from '../src/game-core/index.ts';

const placeTowers = (simulation: ReturnType<typeof createSimulation>) => {
  const placements = [
    ['niche-corner', 'grove-lens'],
    ['niche-bend', 'pulse-spire'],
    ['niche-mouth', 'frost-relay'],
  ] as const;

  for (const [padId, towerId] of placements) {
    const result = simulation.dispatch({ type: 'placeTower', padId, towerId });
    assert.equal(result.accepted, true, `expected ${towerId} to be placed`);
  }
};

const createTagScenario = () => {
  const config = createTrainingScenario();
  config.map = {
    ...config.map,
    corePosition: { x: 3, z: 0 },
    coreHealth: 100,
    routes: [
      { id: 'ground-route', points: [{ x: -1, z: 0 }, { x: 2, z: 0 }] },
      { id: 'air-route', points: [{ x: -0.75, z: 0 }, { x: 2, z: 0 }] },
    ],
    buildPads: [{ id: 'test-pad', position: { x: 0, z: 0 } }],
  };
  config.towers = [{
    id: 'ground-splash',
    name: 'Ground Splash',
    cost: 0,
    range: 4,
    damage: 10,
    attackIntervalTicks: 10,
    targets: ['ground'],
    splashRadius: 0.5,
  }];
  config.enemies = [
    { id: 'ground-target', name: 'Ground', maxHealth: 100, speed: 0.01, reward: 0, coreDamage: 1, tags: ['ground'] },
    { id: 'air-target', name: 'Air', maxHealth: 100, speed: 0.01, reward: 0, coreDamage: 1, tags: ['air'] },
  ];
  config.waves = [{
    id: 'tag-check',
    prepTicks: 0,
    groups: [
      { enemyId: 'ground-target', count: 1, startTick: 0, intervalTicks: 1, routeId: 'ground-route' },
      { enemyId: 'air-target', count: 1, startTick: 1, intervalTicks: 1, routeId: 'air-route' },
    ],
  }];
  config.rules = { startingGold: 0, waveBounty: 0, repairAmount: 0 };
  return config;
};

const createSlowScenario = () => {
  const config = createTrainingScenario();
  config.map = {
    ...config.map,
    corePosition: { x: 5, z: 0 },
    coreHealth: 100,
    routes: [{ id: 'test-route', points: [{ x: -1, z: 0 }, { x: 4, z: 0 }] }],
    buildPads: [
      { id: 'strong-pad', position: { x: 0, z: 0 } },
      { id: 'weak-pad', position: { x: 0.1, z: 0 } },
    ],
  };
  config.towers = [
    { id: 'strong-slow', name: 'Strong Slow', cost: 0, range: 4, damage: 1, attackIntervalTicks: 1, targets: ['ground'], slowFactor: 0.5, slowDurationTicks: 20 },
    { id: 'weak-slow', name: 'Weak Slow', cost: 0, range: 4, damage: 1, attackIntervalTicks: 1, targets: ['ground'], slowFactor: 0.9, slowDurationTicks: 8 },
  ];
  config.enemies = [
    { id: 'slow-target', name: 'Slow Target', maxHealth: 1000, speed: 0.1, reward: 0, coreDamage: 0, tags: ['ground'] },
  ];
  config.waves = [{
    id: 'slow-check',
    prepTicks: 0,
    groups: [{ enemyId: 'slow-target', count: 1, startTick: 0, intervalTicks: 1, routeId: 'test-route' }],
  }];
  config.rules = { startingGold: 0, waveBounty: 0, repairAmount: 0 };
  return config;
};

const createTwoWaveScenario = () => {
  const config = createTrainingScenario();
  config.waves = [
    {
      id: 'transition-one',
      prepTicks: 0,
      groups: [{ enemyId: 'husk', count: 1, startTick: 0, intervalTicks: 1, routeId: 'burrow-spine' }],
    },
    {
      id: 'transition-two',
      prepTicks: 5,
      groups: [{ enemyId: 'runner', count: 1, startTick: 0, intervalTicks: 1, routeId: 'burrow-spine' }],
    },
  ];
  config.rules = { startingGold: 0, waveBounty: 1, repairAmount: 0 };
  return config;
};

const runTwoWaveScenario = () => {
  const run = () => {
    const simulation = createSimulation(createTwoWaveScenario());
    simulation.dispatch({ type: 'startWave' });
    simulation.advance(1200);
    if (simulation.getSnapshot().status === 'preparation') {
      simulation.dispatch({ type: 'startWave' });
      simulation.advance(1200);
    }
    const snapshot = simulation.getSnapshot();
    assert.equal(snapshot.status, 'victory');
    assert.equal(snapshot.waveIndex, 1);
    assert.equal(snapshot.leaksThisWave, 1);
    assert.notEqual(snapshot.lastWaveRoll, null);
    return snapshot;
  };
  assert.deepEqual(run(), run());
};

const runVictoryScenario = () => {
  const simulation = createSimulation(createTrainingScenario());
  placeTowers(simulation);

  const duplicate = simulation.dispatch({ type: 'placeTower', padId: 'niche-corner', towerId: 'grove-lens' });
  assert.equal(duplicate.accepted, false);

  simulation.advance(30);
  const start = simulation.dispatch({ type: 'startWave' });
  assert.equal(start.accepted, true);
  simulation.advance(600);

  const events = simulation.drainEvents();
  const snapshot = simulation.getSnapshot();
  assert.equal(snapshot.status, 'victory');
  assert.equal(snapshot.tick, 401);
  assert.equal(snapshot.enemies.length, 0);
  assert.equal(snapshot.coreHealth, snapshot.maxCoreHealth);
  assert.equal(snapshot.leaksThisWave, 0);
  assert.equal(snapshot.gold, 229);
  assert.ok(events.some((event) => event.type === 'waveCleared' && event.bounty === 35 && event.leaks === 0));
  assert.ok(events.some((event) => event.type === 'victory'));
  return snapshot;
};

const runDefeatScenario = () => {
  const simulation = createSimulation(createTrainingScenario());
  simulation.advance(30);
  simulation.dispatch({ type: 'startWave' });
  // The corridor is 26 units long, so an undefended husk needs 36 seconds to reach the core. Two
  // minutes of ticks is what it takes for ten leaks to land; 600 is not a defeat any more, it is a
  // wave still walking.
  simulation.advance(1200);

  const snapshot = simulation.getSnapshot();
  assert.equal(snapshot.status, 'defeat');
  assert.equal(snapshot.coreHealth, 0);
  assert.equal(snapshot.enemies.length, 0);
  assert.ok(snapshot.leaksThisWave > 0);
};

const runTagScenario = () => {
  const simulation = createSimulation(createTagScenario());
  simulation.dispatch({ type: 'placeTower', padId: 'test-pad', towerId: 'ground-splash' });
  simulation.dispatch({ type: 'startWave' });
  simulation.advance(2);
  const enemies = simulation.getSnapshot().enemies;
  const ground = enemies.find((enemy) => enemy.enemyId === 'ground-target');
  const air = enemies.find((enemy) => enemy.enemyId === 'air-target');
  assert.equal(ground?.health, 90);
  assert.equal(air?.health, 100);
};

const runSlowScenario = () => {
  const simulation = createSimulation(createSlowScenario());
  simulation.dispatch({ type: 'placeTower', padId: 'strong-pad', towerId: 'strong-slow' });
  simulation.dispatch({ type: 'placeTower', padId: 'weak-pad', towerId: 'weak-slow' });
  simulation.dispatch({ type: 'startWave' });
  simulation.advance(3);
  const enemy = simulation.getSnapshot().enemies[0];
  assert.equal(enemy?.slowFactor, 0.5);
  assert.ok((enemy?.slowTicks ?? 0) > 0);
};

const runPlacementScenario = () => {
  const config = createTrainingScenario();
  const simulation = createSimulation(config);
  const costOf = (towerId: string) => config.towers.find((tower) => tower.id === towerId)?.cost ?? 0;

  const unknownPad = simulation.dispatch({ type: 'placeTower', padId: 'pad-nowhere', towerId: 'pulse-spire' });
  assert.deepEqual(unknownPad, { accepted: false, reason: 'unknown-pad' });

  const unknownTower = simulation.dispatch({ type: 'placeTower', padId: 'niche-corner', towerId: 'ghost-spire' });
  assert.deepEqual(unknownTower, { accepted: false, reason: 'unknown-tower' });

  const accepted = simulation.dispatch({ type: 'placeTower', padId: 'niche-corner', towerId: 'pulse-spire' });
  assert.deepEqual(accepted, { accepted: true });
  const afterAccepted = simulation.getSnapshot();
  assert.equal(afterAccepted.pads['niche-corner'], 'pulse-spire');
  assert.equal(afterAccepted.towers.length, 1);
  assert.equal(afterAccepted.towers[0]?.padId, 'niche-corner');
  assert.equal(afterAccepted.gold, config.rules.startingGold - costOf('pulse-spire'));

  const occupied = simulation.dispatch({ type: 'placeTower', padId: 'niche-corner', towerId: 'frost-relay' });
  assert.deepEqual(occupied, { accepted: false, reason: 'pad-occupied' });
  const afterOccupied = simulation.getSnapshot();
  assert.equal(afterOccupied.pads['niche-corner'], 'pulse-spire');
  assert.equal(afterOccupied.towers.length, 1);
  assert.equal(afterOccupied.gold, afterAccepted.gold);

  for (const padId of ['niche-mouth', 'niche-deep'] as const) {
    const result = simulation.dispatch({ type: 'placeTower', padId, towerId: 'pulse-spire' });
    assert.equal(result.accepted, true, `expected ${padId} to be filled`);
  }
  const drained = simulation.dispatch({ type: 'placeTower', padId: 'niche-bend', towerId: 'grove-lens' });
  assert.equal(drained.accepted, true);
  assert.equal(simulation.getSnapshot().gold, 0);

  const broke = simulation.dispatch({ type: 'placeTower', padId: 'niche-heart', towerId: 'pulse-spire' });
  assert.deepEqual(broke, { accepted: false, reason: 'not-enough-gold' });
  const afterBroke = simulation.getSnapshot();
  assert.equal(afterBroke.pads['niche-heart'], null);
  assert.equal(afterBroke.towers.length, 4);
  assert.equal(afterBroke.gold, 0);
  assert.equal(costOf('grove-lens'), 70);
};

const runValidationScenario = () => {
  const invalid = createTrainingScenario();
  invalid.map = { ...invalid.map, coreHealth: Number.NaN };
  assert.throws(() => createSimulation(invalid), /finite/);

  const halfSlow = createTrainingScenario();
  halfSlow.towers = [{ ...halfSlow.towers[0], slowFactor: 0.5, slowDurationTicks: undefined }];
  assert.throws(() => createSimulation(halfSlow), /together/);

  const stationary = createTrainingScenario();
  stationary.enemies = [{ ...stationary.enemies[0], speed: 0 }];
  assert.throws(() => createSimulation(stationary), /positive/);
};

const first = runVictoryScenario();
const second = runVictoryScenario();
assert.deepEqual(second, first);
runDefeatScenario();
runTwoWaveScenario();
runTagScenario();
runSlowScenario();
runPlacementScenario();
runValidationScenario();

console.log(JSON.stringify({
  status: first.status,
  tick: first.tick,
  gold: first.gold,
  towers: first.towers.length,
  enemies: first.enemies.length,
  coreHealth: first.coreHealth,
}, null, 2));
console.log('simulation check: ok');
