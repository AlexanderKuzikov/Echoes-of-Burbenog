import * as THREE from 'three';
import { ENEMY_BASE_Y } from './enemies.ts';

type CombatBurst = {
  mesh: THREE.Mesh;
  started: number;
  duration: number;
};

type ShotTrace = {
  beam: THREE.Mesh;
  flash: THREE.Mesh;
  started: number;
  duration: number;
};

const combatBurstSeconds = 0.55;
const MAX_COMBAT_BURSTS = 14;

// A shot is the whole point of a tower: without a visible line from the muzzle to the target, a
// placement reads as nothing happening until an enemy stops existing. The trace is presentation
// state only — it is not in the snapshot, not in the command log and not in the room, so two
// clients watching the same match each draw their own from the same event.
const shotTraceSeconds = 0.2;
const shotBeamThickness = 0.07;
const MAX_SHOT_TRACES = 18;
const shotBeamColor = new THREE.Color(0xbff6e6);
const shotFlashColor = new THREE.Color(0xffffff);

// The fourth presentation domain. A kill burst is born from an enemy event and a shot trace from a
// tower event, and both need the position of a view that belongs to somebody else, so they live
// here and are handed plain positions: nothing in this file knows what a tower or an enemy is.
export type CombatFxPresentation = {
  spawnCombatBurst: (position: THREE.Vector3, elapsed: number) => void;
  spawnShotTrace: (from: THREE.Vector3, to: THREE.Vector3, elapsed: number) => void;
  animate: (elapsed: number) => void;
  clearCombatBursts: () => void;
  liveBursts: () => number;
  liveTraces: () => number;
  tracesFired: () => number;
};

// The kill ring is born on the ground the creature stood on rather than at a fixed height, and the road
// it is drawn on is handed in from the same three heights the ground was painted from. It takes the
// same clearance the creatures take, so the two cannot disagree about where the road is — and the road
// moves with the skin, so a ring drawn at a fixed height would lift off the ground the moment the plate
// was repainted.
export const createCombatFx = (scene: THREE.Scene, roadY: number): CombatFxPresentation => {
  const combatBursts: CombatBurst[] = [];
  const combatBurstGeometry = new THREE.RingGeometry(0.22, 0.34, 18);
  const combatBurstColor = new THREE.Color(0x9ff0c9);

  const removeCombatBurst = (burst: CombatBurst) => {
    scene.remove(burst.mesh);
    (burst.mesh.material as THREE.Material).dispose();
  };

  // One shared geometry for every beam and every flash; only the materials belong to a shot, and they
  // are disposed with it. A shot allocates two small meshes and gives them back within
  // `shotTraceSeconds`, so the ceiling exists to survive a burst of fire, not to grow.
  const shotBeamGeometry = new THREE.BoxGeometry(1, 1, 1);
  const shotFlashGeometry = new THREE.SphereGeometry(0.18, 10, 8);
  const shotTraces: ShotTrace[] = [];
  let shotTraceCount = 0;
  const shotForward = new THREE.Vector3(0, 0, 1);
  const shotDirection = new THREE.Vector3();

  const removeShotTrace = (trace: ShotTrace) => {
    scene.remove(trace.beam);
    scene.remove(trace.flash);
    (trace.beam.material as THREE.Material).dispose();
    (trace.flash.material as THREE.Material).dispose();
  };

  const spawnCombatBurst = (position: THREE.Vector3, elapsed: number) => {
    const mesh = new THREE.Mesh(
      combatBurstGeometry,
      new THREE.MeshBasicMaterial({
        color: combatBurstColor,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(position.x, roadY + ENEMY_BASE_Y + 0.08, position.z);
    scene.add(mesh);
    combatBursts.push({ mesh, started: elapsed, duration: combatBurstSeconds });
    while (combatBursts.length > MAX_COMBAT_BURSTS) {
      const stale = combatBursts.shift();
      if (stale) {
        removeCombatBurst(stale);
      }
    }
  };

  const spawnShotTrace = (from: THREE.Vector3, to: THREE.Vector3, elapsed: number) => {
    shotDirection.copy(to).sub(from);
    const length = shotDirection.length();
    if (!(length > 0.05)) {
      return;
    }
    shotDirection.multiplyScalar(1 / length);
    const beam = new THREE.Mesh(
      shotBeamGeometry,
      new THREE.MeshBasicMaterial({
        color: shotBeamColor,
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    beam.scale.set(shotBeamThickness, shotBeamThickness, length);
    beam.position.copy(from).addScaledVector(shotDirection, length * 0.5);
    beam.quaternion.setFromUnitVectors(shotForward, shotDirection);
    const flash = new THREE.Mesh(
      shotFlashGeometry,
      new THREE.MeshBasicMaterial({
        color: shotFlashColor,
        transparent: true,
        opacity: 0.9,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    flash.position.copy(to);
    scene.add(beam);
    scene.add(flash);
    shotTraces.push({ beam, flash, started: elapsed, duration: shotTraceSeconds });
    shotTraceCount += 1;
    while (shotTraces.length > MAX_SHOT_TRACES) {
      const stale = shotTraces.shift();
      if (stale) {
        removeShotTrace(stale);
      }
    }
  };

  return {
    spawnCombatBurst,
    spawnShotTrace,
    animate: (elapsed: number) => {
      for (let index = combatBursts.length - 1; index >= 0; index -= 1) {
        const burst = combatBursts[index];
        if (!burst) {
          continue;
        }
        const progress = (elapsed - burst.started) / burst.duration;
        if (progress >= 1) {
          removeCombatBurst(burst);
          combatBursts.splice(index, 1);
          continue;
        }
        (burst.mesh.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - progress);
        burst.mesh.scale.setScalar(1 + progress * 1.9);
      }
      for (let index = shotTraces.length - 1; index >= 0; index -= 1) {
        const trace = shotTraces[index];
        if (!trace) {
          continue;
        }
        const progress = (elapsed - trace.started) / trace.duration;
        if (progress >= 1) {
          removeShotTrace(trace);
          shotTraces.splice(index, 1);
          continue;
        }
        // The beam thins out and the impact flash collapses: a shot that stays at full width reads as
        // a solid rod, not as light crossing a distance.
        const fade = 1 - progress;
        (trace.beam.material as THREE.MeshBasicMaterial).opacity = 0.85 * fade;
        trace.beam.scale.x = shotBeamThickness * (0.35 + 0.65 * fade);
        trace.beam.scale.y = trace.beam.scale.x;
        (trace.flash.material as THREE.MeshBasicMaterial).opacity = 0.9 * fade;
        trace.flash.scale.setScalar(0.5 + progress * 0.9);
      }
    },
    clearCombatBursts: () => {
      for (const burst of combatBursts) {
        removeCombatBurst(burst);
      }
      combatBursts.length = 0;
    },
    liveBursts: () => combatBursts.length,
    liveTraces: () => shotTraces.length,
    tracesFired: () => shotTraceCount,
  };
};
