import * as THREE from 'three';
import type { MatchSnapshot } from '../game-core/index.ts';
import { disposeInstance, withProbeWeight } from './shared.ts';

export type EnemyView = {
  group: THREE.Group;
  body: THREE.Mesh;
  healthFill: THREE.Mesh;
};

// The height an enemy body is read at. The kill burst is drawn relative to it, so it is published
// rather than copied: two modules with their own copy of a ground height is how a burst ends up
// floating.
export const ENEMY_BASE_Y = 0.28;

// The enemy domain: one view per live enemy, its health bar, its slow tint, the idle bob, and the
// readings the debug seam publishes. `bobOffset` is the largest bob on screen this frame, which is
// what a reduced-motion test reads to say the drift is actually off.
export type EnemyPresentation = {
  applySnapshot: (next: MatchSnapshot) => void;
  animate: (elapsed: number, ambientDelta: number) => void;
  positionOf: (entityId: number) => THREE.Vector3 | null;
  viewCount: () => number;
  positions: () => Array<{ x: number; z: number }>;
  bobOffset: () => number;
  setReducedMotion: (reduced: boolean) => void;
};

const enemyVisuals: Record<string, { color: number; scale: number }> = {
  husk: { color: 0xe46c62, scale: 0.84 },
  runner: { color: 0xf0a85d, scale: 0.68 },
  wisp: { color: 0xd85c8b, scale: 0.76 },
};
const unknownEnemyVisual = { color: 0xc9a27a, scale: 0.74 };

const baseBodyEmissive = 0.45;
const slowedBodyEmissive = 1.15;

export const createEnemies = (scene: THREE.Scene): EnemyPresentation => {
  const enemyViews = new Map<number, EnemyView>();
  let enemyBobOffset = 0;
  let reducedMotion = false;

  const createEnemyView = (enemyId: string): EnemyView => {
    const visual = enemyVisuals[enemyId] ?? unknownEnemyVisual;
    const group = new THREE.Group();
    group.scale.setScalar(visual.scale);
    group.name = `enemy:${enemyId}`;

    const body = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.32, 1),
      withProbeWeight(
        new THREE.MeshStandardMaterial({ color: visual.color, emissive: visual.color, emissiveIntensity: 0.45, roughness: 0.62 }),
        'enemyBody',
      ),
    );
    body.castShadow = true;
    group.add(body);

    const crest = new THREE.Mesh(
      new THREE.ConeGeometry(0.18, 0.42, 5),
      withProbeWeight(new THREE.MeshStandardMaterial({ color: 0xf3b77b, roughness: 0.5 }), 'enemyCrest'),
    );
    crest.position.y = 0.34;
    crest.rotation.z = Math.PI;
    group.add(crest);

    const healthBack = new THREE.Mesh(
      new THREE.BoxGeometry(0.88, 0.08, 0.04),
      new THREE.MeshBasicMaterial({ color: 0x152229 }),
    );
    healthBack.position.y = 0.78;
    group.add(healthBack);

    const healthFill = new THREE.Mesh(
      new THREE.BoxGeometry(0.76, 0.045, 0.045),
      new THREE.MeshBasicMaterial({ color: 0x74e0b4 }),
    );
    healthFill.position.set(0, 0.78, 0.025);
    group.add(healthFill);

    return { group, body, healthFill };
  };

  return {
    applySnapshot: (next: MatchSnapshot) => {
      const aliveEnemies = new Set<number>();
      for (const enemy of next.enemies) {
        aliveEnemies.add(enemy.entityId);
        let view = enemyViews.get(enemy.entityId);
        if (!view) {
          view = createEnemyView(enemy.enemyId);
          scene.add(view.group);
          enemyViews.set(enemy.entityId, view);
        }
        view.group.position.set(enemy.x, ENEMY_BASE_Y, enemy.z);
        const healthRatio = enemy.maxHealth > 0 ? Math.max(0, Math.min(1, enemy.health / enemy.maxHealth)) : 0;
        view.healthFill.scale.x = Math.max(healthRatio, 0.001);
        view.healthFill.position.x = -0.38 + 0.38 * healthRatio;
        const bodyMaterial = view.body.material as THREE.MeshStandardMaterial;
        bodyMaterial.emissiveIntensity = enemy.slowTicks > 0 ? slowedBodyEmissive : baseBodyEmissive;
      }
      for (const [entityId, view] of enemyViews) {
        if (aliveEnemies.has(entityId)) {
          continue;
        }
        scene.remove(view.group);
        disposeInstance(view.group);
        enemyViews.delete(entityId);
      }
    },
    animate: (elapsed: number, ambientDelta: number) => {
      let enemySlot = 0;
      enemyBobOffset = 0;
      for (const view of enemyViews.values()) {
        view.group.rotation.y += ambientDelta * (0.7 + enemySlot * 0.12);
        const bob = reducedMotion ? 0 : Math.sin(elapsed * 2.8 + enemySlot * 0.7) * 0.045;
        view.group.position.y = ENEMY_BASE_Y + bob;
        enemyBobOffset = Math.max(enemyBobOffset, Math.abs(bob));
        enemySlot += 1;
      }
    },
    // The live position of an enemy body, handed to the tower that shot it and to the burst that
    // marks its death. The vector is the view's own, so the caller reads it before the next snapshot.
    positionOf: (entityId: number) => enemyViews.get(entityId)?.group.position ?? null,
    viewCount: () => enemyViews.size,
    positions: () => Array.from(enemyViews.values(), (view) => ({ x: view.group.position.x, z: view.group.position.z })),
    bobOffset: () => enemyBobOffset,
    setReducedMotion: (reduced: boolean) => {
      reducedMotion = reduced;
    },
  };
};
