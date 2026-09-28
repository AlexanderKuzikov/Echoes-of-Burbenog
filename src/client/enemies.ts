import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { MatchSnapshot } from '../game-core/index.ts';
import { disposeInstance, withProbeWeight } from './shared.ts';

export type EnemyView = {
  group: THREE.Group;
  body: THREE.Mesh;
  healthFill: THREE.Mesh;
};

// The ground line: the surface of the road ribbon the enemy stands on, in the same world the route
// and the massif are built in. It is published rather than copied because two modules with their own
// copy of a ground height is how a burst ends up floating. Both readers add their own height on top
// — the kill ring 0.08 above it, a shot impact 0.3 up a body — so this one number means one thing:
// where the feet are. A creature is modelled with its feet on y = 0 and reads this as its floor.
export const ENEMY_BASE_Y = 0.08;

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

// The fill is drawn from the middle of the bar, so half of it hangs out of the back plate while it
// shrinks and the bar grows a stub on the empty side. The left edge is the only number the fill
// needs, and it is derived from the bar's own width instead of written out twice: a bar whose
// numbers were tuned by hand starts sliding damage the wrong way the moment the width is touched.
// The width is per kind, because a bar as long as the widest creature would lie across its neighbours
// on the road, and one as short as the runner's own would be lost under its own blade.
const healthBackOverhang = 0.08;
const healthBackHeight = 0.075;
const healthFillHeight = 0.045;

const baseBodyEmissive = 0.45;
const slowedBodyEmissive = 1.15;

// Every creature is modelled in a canonical space — feet on y = 0, forward on +Z, the tallest point
// somewhere near y = 1 — and the rig is then scaled by the look's `scale`. One number therefore
// decides how big a kind walks into a corridor 1.2 wide, and every part of it moves with that number
// instead of carrying its own idea of size.
//
// All three are built from faceted primitives, the way the rock, the pads and the towers are: flat
// planes catch the key light in steps, and a creature made of them reads as carved rather than
// inflated. The floater's orb is the one smooth form in the module, on purpose — it is the only light
// in the scene that is not a solid.

type EnemyForm = {
  shell: THREE.BufferGeometry;
  accent: THREE.BufferGeometry;
};

type EnemyLook = {
  // World size of the canonical form, how high its bar floats above the tallest point of it, and how
  // long that bar is: the health marker belongs to its own creature and not to the world, so it is
  // sized against the thing it measures.
  scale: number;
  barY: number;
  barWidth: number;
  shell: { color: number; emissive: number; roughness: number; metalness: number };
  accent: { color: number; emissive: number; emissiveIntensity: number; roughness: number; metalness: number };
  // The idle language of a kind, and the reason a still frame shows three different creatures even
  // before their shape is read: a tank shifts its weight, a sprinter fidgets, a floater drifts.
  motion: { bob: number; bobRate: number; sway: number; swayRate: number; yaw: number; yawRate: number };
  form: () => EnemyForm;
};

// `mergeGeometries` needs every input to agree about indexing, and it warns when it is handed one
// that has no index at all — and the primitives disagree here, because the polyhedra arrive
// unindexed while the boxes, cones, cylinders and tori do not. The conversion happens on the way in
// and the source is released with it, so a creature costs its own vertices and no more.
const part = (bucket: THREE.BufferGeometry[], geometry: THREE.BufferGeometry): void => {
  const mergeable = geometry.index === null ? geometry : geometry.toNonIndexed();
  if (mergeable !== geometry) {
    geometry.dispose();
  }
  bucket.push(mergeable);
};

const mergeParts = (bucket: THREE.BufferGeometry[]): THREE.BufferGeometry => {
  const merged = mergeGeometries(bucket);
  for (const entry of bucket) {
    entry.dispose();
  }
  if (!merged) {
    // Every list in this file is a fixed set of primitives that all carry position, normal and uv,
    // so a null merge is a mistake here rather than a condition to survive — and surviving it would
    // be the worse outcome: a creature with no shell takes the `enemyBody` probe role off the scene,
    // and nothing in the picture would say why.
    throw new Error('enemy form: primitives could not be merged');
  }
  return merged;
};

// One primitive aimed many times around a point: the copies are what let a crown of five spikes cost
// one draw call after the merge instead of five. The aim is measured from `centre`, because a crown
// is a crown of something — a crown placed around the origin is a crown around the ground, and the
// orb it belongs to then swallows every spike. The source is released once the copies exist.
const repeatedPart = (
  bucket: THREE.BufferGeometry[],
  source: THREE.BufferGeometry,
  centre: THREE.Vector3,
  aims: ReadonlyArray<{ azimuth: number; elevation: number; offset: number }>,
): void => {
  for (const aim of aims) {
    // Offset first, while the primitive still stands on +Y, then aimed, then carried to its centre.
    part(
      bucket,
      source
        .clone()
        .translate(0, aim.offset, 0)
        .rotateY(aim.azimuth)
        .rotateX(aim.elevation)
        .translate(centre.x, centre.y, centre.z),
    );
  }
  source.dispose();
};

// Two bright dots on the front of a head, and the cheapest thing in this module that turns a shape
// into a creature: a player reads a face before a silhouette, at every size the game is played at,
// and no amount of carapace gets there on its own. A bare icosahedron rather than a sphere — an eye is
// a few pixels across in this game, and a sphere spends sixty triangles on those pixels. Merged into
// the accent, so they cost no draw call either.
const eyes = (bucket: THREE.BufferGeometry[], radius: number, spread: number, height: number, reach: number): void => {
  for (const side of [-1, 1]) {
    part(bucket, new THREE.IcosahedronGeometry(radius, 0).translate(side * spread, height, reach));
  }
};

// The tank. A wide low barrel for a shell, a head carried in front of it and below its deck, a pair
// of shoulder nubs, and a pale blade standing on the back. It is the widest and the flattest of the
// three, so the player tells it from the runner by outline and not by shade: on a dark rock, hue is
// the last thing to arrive. A drum and not a squashed polyhedron, because a polyhedron's corners turn
// into a star, and a star is what the floater already is.
const buildHusk = (): EnemyForm => {
  const shell: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];

  // A flat facet square ahead, so the shell has a front edge and not just a curve, and a head carried
  // low in front of it and clear of the deck above — a head that does not break the outline is not a
  // head, it is a bump.
  part(shell, new THREE.CylinderGeometry(0.52, 0.6, 0.44, 6).rotateY(Math.PI / 6).scale(1.2, 1, 1).translate(0, 0.22, -0.12));
  part(shell, new THREE.CylinderGeometry(0.3, 0.44, 0.2, 6).rotateY(Math.PI / 6).scale(1.2, 1, 1).translate(0, 0.52, -0.14));
  part(shell, new THREE.IcosahedronGeometry(0.5, 0).scale(0.44, 0.32, 0.44).translate(0, 0.26, 0.62));
  part(shell, new THREE.ConeGeometry(0.2, 0.3, 4).rotateX(Math.PI / 2).scale(1, 0.7, 1).translate(0, 0.16, 0.92));
  for (const side of [-1, 1]) {
    part(
      shell,
      new THREE.ConeGeometry(0.13, 0.24, 4).rotateZ(side * -Math.PI / 2).scale(1, 1, 0.85).translate(side * 0.68, 0.26, -0.16),
    );
  }

  // One tall blade and one short one behind it: the tall one says "front" from directly behind, the
  // short one catches the eye from every other angle, and together they are the only bright marks on
  // a dark wide body. The eyes are what make the thing in front of them a face.
  part(accent, new THREE.ConeGeometry(0.24, 0.52, 4).scale(0.45, 1, 1.7).translate(0, 0.79, -0.12));
  part(accent, new THREE.ConeGeometry(0.15, 0.28, 4).scale(0.45, 1, 1.9).translate(0, 0.61, 0.28));
  eyes(accent, 0.09, 0.2, 0.36, 0.78);

  return { shell: mergeParts(shell), accent: mergeParts(accent) };
};

// The sprinter. One slim spire raked forward, a head with eyes carried low in front of it, two short
// legs, a tail, and a blade swept back over the spire. Nothing here is a mass: a wide mass is the
// tank and a round one is the floater, so the runner is the only creature on the road that is
// thinner than it is tall, and a spike reads as a spike from every angle where a flat fin would show
// the player its edge twice per lap.
const buildRunner = (): EnemyForm => {
  const shell: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];

  part(shell, new THREE.ConeGeometry(0.12, 1.15, 5).rotateX(0.26).translate(0, 0.58, 0.04));
  part(shell, new THREE.IcosahedronGeometry(0.5, 0).scale(0.26, 0.22, 0.3).translate(0, 0.2, 0.2));
  part(shell, new THREE.ConeGeometry(0.08, 0.34, 4).rotateX(Math.PI / 2 + 0.15).translate(0, 0.2, 0.36));
  part(shell, new THREE.ConeGeometry(0.06, 0.28, 4).rotateX(-Math.PI / 2 - 0.6).translate(0, 0.26, -0.18));
  for (const side of [-1, 1]) {
    part(shell, new THREE.CylinderGeometry(0.028, 0.04, 0.24, 4).rotateZ(side * 0.3).translate(side * 0.1, 0.12, side * 0.06));
  }

  part(accent, new THREE.ConeGeometry(0.09, 0.58, 4).scale(0.5, 1, 1.1).rotateX(-0.42).translate(0, 0.72, -0.16));
  part(accent, new THREE.ConeGeometry(0.15, 0.08, 5).rotateX(0.3).translate(0, 0.38, 0.02));
  eyes(accent, 0.05, 0.1, 0.24, 0.3);

  return { shell: mergeParts(shell), accent: mergeParts(accent) };
};

// The floater. A spiked orb inside a tilted halo, hung above the road on a tail that almost reaches
// it. The gap under the body is the tell: neither of the other two leaves the ground, so the player
// reads "this one does not touch" before the shape resolves at all.
const buildWisp = (): EnemyForm => {
  const shell: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];

  part(shell, new THREE.IcosahedronGeometry(0.5, 1).scale(1.06, 1, 1.06).translate(0, 0.74, 0));
  part(shell, new THREE.ConeGeometry(0.13, 0.46, 4).rotateZ(Math.PI).translate(0, 0.25, 0));
  // Five spikes fanned up and out of the orb's own centre, plus one straight up: a crown reads as a
  // crown and a ball of fuzz reads as nothing at the size this is drawn. They are long enough to cross
  // the halo, because a ring the spikes hide behind is a ring the player never sees.
  repeatedPart(
    shell,
    new THREE.ConeGeometry(0.11, 1.4, 4),
    new THREE.Vector3(0, 0.74, 0),
    [
      { azimuth: 0, elevation: 0.62, offset: 0.3 },
      { azimuth: (Math.PI * 2) / 5, elevation: 0.62, offset: 0.3 },
      { azimuth: (Math.PI * 4) / 5, elevation: 0.62, offset: 0.3 },
      { azimuth: (Math.PI * 6) / 5, elevation: 0.62, offset: 0.3 },
      { azimuth: (Math.PI * 8) / 5, elevation: 0.62, offset: 0.3 },
    ],
  );
  part(shell, new THREE.ConeGeometry(0.09, 0.6, 4).translate(0, 1.19, 0));

  part(accent, new THREE.TorusGeometry(0.68, 0.05, 6, 16).rotateX(Math.PI / 2 - 0.5).translate(0, 0.74, 0));

  return { shell: mergeParts(shell), accent: mergeParts(accent) };
};

// A kind the content grew after this table was written still has to arrive as a creature and not as
// a fallback sphere: a plain dome with a low crest, the same materials, and its own entry so it can
// be given a shape of its own later without touching the other two.
const buildUnknown = (): EnemyForm => {
  const shell: THREE.BufferGeometry[] = [];
  const accent: THREE.BufferGeometry[] = [];

  part(shell, new THREE.IcosahedronGeometry(0.5, 1).scale(0.9, 1.05, 0.9).translate(0, 0.5, 0));
  part(accent, new THREE.ConeGeometry(0.16, 0.42, 4).translate(0, 1.05, 0));

  return { shell: mergeParts(shell), accent: mergeParts(accent) };
};

const enemyLooks: Record<string, EnemyLook> = {
  husk: {
    scale: 0.5,
    barY: 0.69,
    barWidth: 0.6,
    // A matte, dusty shell that glows the same colour it is painted, so the slow tint is a hotter
    // rust rather than a brighter light: the biggest body in the scene carries the cue most clearly.
    shell: { color: 0xc25a34, emissive: 0xc25a34, roughness: 0.82, metalness: 0.1 },
    accent: { color: 0xf0dcb0, emissive: 0xf0dcb0, emissiveIntensity: 0.1, roughness: 0.55, metalness: 0.05 },
    motion: { bob: 0.016, bobRate: 1.5, sway: 0.045, swayRate: 1.5, yaw: 0.1, yawRate: 0.35 },
    form: buildHusk,
  },
  runner: {
    scale: 0.7,
    barY: 0.92,
    barWidth: 0.3,
    // A wet chitin sheen. The runner takes more of the probe than the others, so it is the kind that
    // catches the key light and shines — which is the one material difference the player gets for
    // free, on top of an outline nothing else has.
    shell: { color: 0xf2c33c, emissive: 0xf2c33c, roughness: 0.45, metalness: 0.28 },
    accent: { color: 0xfff6d8, emissive: 0xffe9a0, emissiveIntensity: 0.18, roughness: 0.28, metalness: 0.2 },
    motion: { bob: 0.028, bobRate: 5, sway: 0.075, swayRate: 2.8, yaw: 0.06, yawRate: 0.6 },
    form: buildRunner,
  },
  wisp: {
    scale: 0.58,
    barY: 0.99,
    barWidth: 0.56,
    // Cold and off the key light's warm axis on purpose: the core and the road are already teal, so a
    // violet body is the one hue in the scene that belongs to nothing else.
    shell: { color: 0x8f6bf0, emissive: 0x6a45d8, roughness: 0.55, metalness: 0.15 },
    accent: { color: 0x9fd4e8, emissive: 0x8fdcff, emissiveIntensity: 0.25, roughness: 0.2, metalness: 0.15 },
    motion: { bob: 0.045, bobRate: 1, sway: 0, swayRate: 1, yaw: 0.5, yawRate: 0.45 },
    form: buildWisp,
  },
  unknown: {
    scale: 0.68,
    barY: 0.99,
    barWidth: 0.5,
    shell: { color: 0xc9a27a, emissive: 0xa8794f, roughness: 0.7, metalness: 0.1 },
    accent: { color: 0xe8dcc4, emissive: 0xe8dcc4, emissiveIntensity: 0.1, roughness: 0.5, metalness: 0.05 },
    motion: { bob: 0.02, bobRate: 2, sway: 0.04, swayRate: 2, yaw: 0.12, yawRate: 0.4 },
    form: buildUnknown,
  },
};

// The entry the module keeps for itself. The published `EnemyView` is the three members the page
// reads; the rest is presentation state that has to travel with the view — where it came from, which
// way it is walking, and the look that was picked once at birth.
type EnemyEntry = EnemyView & {
  look: EnemyLook;
  facing: THREE.Group;
  rig: THREE.Group;
  travelX: number;
  travelZ: number;
  headed: boolean;
};

export const createEnemies = (scene: THREE.Scene): EnemyPresentation => {
  const enemyViews = new Map<number, EnemyEntry>();
  let enemyBobOffset = 0;
  let reducedMotion = false;

  const createEnemyView = (enemyId: string, x: number, z: number): EnemyEntry => {
    const look = enemyLooks[enemyId] ?? enemyLooks.unknown;
    const form = look.form();
    const group = new THREE.Group();
    group.name = `enemy:${enemyId}`;

    // Three levels, and the middle one exists so the creature can turn inside a bar that does not:
    // `group` carries the position from the snapshot, `facing` the heading, `rig` the kind's size and
    // its idle. Anything else couples the heading to a piece of the frame the player reads.
    const facing = new THREE.Group();
    facing.name = 'facing';
    const rig = new THREE.Group();
    rig.name = 'rig';
    rig.scale.setScalar(look.scale);
    facing.add(rig);
    group.add(facing);

    const body = new THREE.Mesh(
      form.shell,
      withProbeWeight(
        new THREE.MeshStandardMaterial({
          color: look.shell.color,
          emissive: look.shell.emissive,
          emissiveIntensity: baseBodyEmissive,
          roughness: look.shell.roughness,
          metalness: look.shell.metalness,
        }),
        'enemyBody',
      ),
    );
    body.name = 'shell';
    body.castShadow = true;
    rig.add(body);

    const accent = new THREE.Mesh(
      form.accent,
      withProbeWeight(
        new THREE.MeshStandardMaterial({
          color: look.accent.color,
          emissive: look.accent.emissive,
          emissiveIntensity: look.accent.emissiveIntensity,
          roughness: look.accent.roughness,
          metalness: look.accent.metalness,
        }),
        'enemyCrest',
      ),
    );
    accent.name = 'crest';
    accent.castShadow = true;
    rig.add(accent);

    // The bar is the one part that is not scaled by the kind, and it is squared to the world instead
    // of to the creature: it must stay the same shape whatever the heading does, or the player reads
    // a bar edge-on twice per lap and a bar's angle says nothing about the enemy under it.
    const healthBack = new THREE.Mesh(
      new THREE.BoxGeometry(look.barWidth + healthBackOverhang, healthBackHeight, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x152229 }),
    );
    healthBack.name = 'health-back';
    healthBack.position.y = look.barY;
    group.add(healthBack);

    const healthFill = new THREE.Mesh(
      new THREE.BoxGeometry(look.barWidth, healthFillHeight, 0.055),
      new THREE.MeshBasicMaterial({ color: 0x74e0b4 }),
    );
    healthFill.name = 'health-fill';
    healthFill.position.set(0, look.barY, 0.01);
    group.add(healthFill);

    return { group, body, healthFill, look, facing, rig, travelX: x, travelZ: z, headed: false };
  };

  return {
    applySnapshot: (next: MatchSnapshot) => {
      const aliveEnemies = new Set<number>();
      for (const enemy of next.enemies) {
        aliveEnemies.add(enemy.entityId);
        let entry = enemyViews.get(enemy.entityId);
        if (!entry) {
          entry = createEnemyView(enemy.enemyId, enemy.x, enemy.z);
          scene.add(entry.group);
          enemyViews.set(enemy.entityId, entry);
        }
        // Facing is a pose taken from the snapshot, not an animation: the creature turns the way it
        // walks, and a dead or arrived enemy keeps the heading it last had rather than spinning on
        // the spot. A view that has not moved yet has nothing to compare against, so it waits.
        const movedX = enemy.x - entry.travelX;
        const movedZ = enemy.z - entry.travelZ;
        if (Math.abs(movedX) + Math.abs(movedZ) > 1e-4) {
          entry.facing.rotation.y = Math.atan2(movedX, movedZ);
          entry.headed = true;
        }
        entry.travelX = enemy.x;
        entry.travelZ = enemy.z;
        entry.group.position.set(enemy.x, ENEMY_BASE_Y, enemy.z);
        const healthRatio = enemy.maxHealth > 0 ? Math.max(0, Math.min(1, enemy.health / enemy.maxHealth)) : 0;
        entry.healthFill.scale.x = Math.max(healthRatio, 0.001);
        entry.healthFill.position.x = (-entry.look.barWidth / 2) * (1 - healthRatio);
        const bodyMaterial = entry.body.material as THREE.MeshStandardMaterial;
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
    // The frame clock is taken and not used: every piece of idle motion here is a pose on the
    // presentation clock, so a late frame shows the same creature as a timely one on the same tick.
    // An accumulating rotation cannot make that promise, and it would keep turning a creature whose
    // heading the snapshot has already decided.
    animate: (elapsed: number, _frameDelta: number) => {
      let enemySlot = 0;
      enemyBobOffset = 0;
      for (const view of enemyViews.values()) {
        // Idle motion lives here and nowhere else, and all of it is off under reduced motion: a bob
        // on the group, a weight shift about the feet, and a slow look around. Each kind runs its own
        // rates, and the per-slot offset keeps a crowd out of lockstep.
        const phase = elapsed * view.look.motion.bobRate + enemySlot * 0.7;
        const bob = reducedMotion ? 0 : Math.sin(phase) * view.look.motion.bob;
        view.group.position.y = ENEMY_BASE_Y + bob;
        view.rig.rotation.z = reducedMotion ? 0 : Math.sin(elapsed * view.look.motion.swayRate + enemySlot * 1.1) * view.look.motion.sway;
        view.rig.rotation.y = reducedMotion
          ? 0
          : Math.sin(elapsed * view.look.motion.yawRate + enemySlot * 1.9) * view.look.motion.yaw;
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
