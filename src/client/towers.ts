import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AssetContractError } from '../asset-registry.ts';
import type { ModelManifestEntry } from '../asset-registry.ts';
import type { BuildPadDefinition, MatchSnapshot } from '../game-core/index.ts';
import { disposeInstance, withProbeWeight } from './shared.ts';
import type { ProbeRole } from './shared.ts';

export type LoadedModel = {
  entry: ModelManifestEntry;
  scene: THREE.Group;
  emissiveNode: string;
  clips: THREE.AnimationClip[];
};

export type TowerModelReading = {
  entityId: number;
  towerId: string;
  source: 'procedural' | 'model';
  modelId: string | null;
  meshCount: number;
  crystalNode: string | null;
  crystalBaseY: number;
  crystalY: number;
  crystalScale: number;
  crystalEmissive: number;
  // Null on a tower without a skeleton. `time` and `pose` are the facts the determinism claim rests
  // on: the same tick has to give the same two numbers in a run and in the replay of that run.
  clip: TowerClipReading | null;
};

export type TowerClipReading = {
  clipName: string;
  duration: number;
  // Slot-derived offset the clip starts at, in seconds. Two spires never stand in the same pose,
  // and the offset comes from the order the towers were built, so it replays with them.
  phase: number;
  time: number;
  playing: boolean;
  boneName: string;
  pose: [number, number, number, number];
};

// The animated part of a tower view. It is presentation state and lives with the view: the
// snapshot does not know it exists, and nothing in the simulation reads it. `applied` is the
// presentation time the clip has been brought up to, so the update is a difference between two
// readings of one clock and never a function of where in the frame the view was created.
export type TowerClip = {
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  clipName: string;
  duration: number;
  phase: number;
  bone: THREE.Bone;
  applied: number;
};

export type TowerView = {
  towerId: string;
  group: THREE.Group;
  crystal: THREE.Mesh;
  crystalMaterial: THREE.MeshStandardMaterial;
  // The idle bob is measured from wherever the emissive node starts, so a loaded model and
  // the procedural placeholder cannot drift apart on a hardcoded height.
  crystalBaseY: number;
  source: 'procedural' | 'model';
  modelId: string | null;
  clip: TowerClip | null;
  firedUntil: number;
  aimAngle: number;
  // Releases exactly what this view owns: the geometry and the source materials of a loaded
  // model stay with the registry, or the next view of the same model would get a disposed one.
  release: () => void;
};

// A shot the tower drew, as the two points it runs between. Both vectors are scratch the module
// reuses on the next event, so the caller draws from them before the next event arrives and does
// not keep them.
export type ShotEndpoints = {
  from: THREE.Vector3;
  to: THREE.Vector3;
};

// The tower domain: procedural and model views, the clip each one plays, the aim and flash a shot
// produces, and the readings the debug seam publishes. `presentationTime` is the match clock the
// clips follow, passed in as a number because the page owns that clock and a second copy of it in
// two places is how a pose ends up a function of frame order.
export type TowerPresentation = {
  applySnapshot: (next: MatchSnapshot, presentationTime: number) => void;
  animate: (elapsed: number, ambientDelta: number, presentationTime: number) => void;
  onFired: (entityId: number, target: THREE.Vector3 | null, elapsed: number) => ShotEndpoints | null;
  upgradeWithModels: (presentationTime: number) => void;
  resetFired: () => void;
  setReducedMotion: (reduced: boolean) => void;
  viewCount: () => number;
  positions: () => Array<{ x: number; z: number }>;
  modelReadings: () => TowerModelReading[];
  poseReadings: () => Array<{ entityId: number; towerId: string; clip: TowerClipReading | null }>;
  clipMotion: () => { clips: number; clipsPlaying: number };
};

// The idle intensity of a lit crystal. It is a number the suite reads, not a taste: "lit" means
// brighter than this, everywhere in the project, so a breath that rose above it would be
// indistinguishable from a shot that has not finished.
const towerCrystalIdleIntensity = 2.4;
const towerCrystalFireIntensity = 6.6;
// How much the crystal swells at the peak of a shot. It has to be a scale above one: the reading is
// what tells a lit tower from a tower that is merely standing there.
const towerCrystalFireScale = 0.55;
const towerFireFlashSeconds = 0.22;
// The share of the flash window held at the peak before it dies. A flash that decayed from the first
// frame would spend most of its life in the range where it looks like a tower that is merely glowing.
const towerFlashHoldShare = 0.75;
// Where a shot leaves a tower and where it lands on a body. `onFired` no longer starts the beam at
// `towerMuzzleHeight` — it starts it at the crystal, the one part of a tower that is lit — and the
// constant is what a shot falls back to if that world position ever comes back degenerate. A beam
// from the pad floor is a wrong picture, and no picture at all is the better failure.
const towerMuzzleHeight = 0.92;
const enemyImpactHeight = 0.3;
// The pad floor is at 0.19, so a tower seated at 0.14 is socketed a little way into its own pad
// rather than balanced on top of it. All three stands come from here, and none of them lifts itself.
const towerSeatHeight = 0.14;

// One clip per view, started at a slot-derived offset instead of at a random moment. The offset
// comes from the order the towers were built in, which the replay reproduces, so two spires never
// stand in the same pose and a restart still lands on the same one.
const TOWER_CLIP_PHASE_SECONDS = 0.37;

// The read of one tower at a glance. Three of these and an enemy have to be told apart from an
// orbiting orthographic camera, so the silhouette and the proportions do the work and the colour only
// confirms it: a tall solid spindle, a wide leaning lens on a short post, an open frame with a gem
// hung in it. None of these numbers is a gameplay value.
type TowerLook = {
  accent: number;
  base: number;
  stem: number;
  roof: number;
  // How the tower stands in its niche. The scale and the lean live on a seat below the group, not on
  // the group itself, because the group carries the aim yaw and a rotation that has to be both a
  // posture and a bearing is a rotation that will be wrong half of the time.
  scale: number;
  tiltX: number;
  tiltZ: number;
  // How far the seat travels out of that rest lean while the match runs.
  nod: number;
  // The idle yaw drift of a tower that is not shooting, in radians per second.
  spin: number;
  // The breath of the crystal: how far it bobs, how far it rolls, and how far its light dips below
  // the idle intensity.
  bob: number;
  roll: number;
  breath: number;
  build: (seat: THREE.Object3D, look: TowerLook) => THREE.Mesh;
};

type TowerPart = {
  geometry: THREE.BufferGeometry;
  color: number;
  role: ProbeRole;
  y: number;
  x?: number;
  roughness: number;
  metalness: number;
};

// Every structural part is a Three.js primitive with a declared probe weight. The scene walks its own
// materials, so a standard material that arrives without a role turns up as undeclared, and a new
// role is not an option here: three parallel sessions edit one table of them.
const structurePart = (seat: THREE.Object3D, part: TowerPart): THREE.Mesh => {
  const mesh = new THREE.Mesh(
    part.geometry,
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: part.color,
        roughness: part.roughness,
        metalness: part.metalness,
      }),
      part.role,
    ),
  );
  mesh.position.set(part.x ?? 0, part.y, 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  seat.add(mesh);
  return mesh;
};

// The lit part of a tower and the only node the client animates. It is deliberately left without a
// name: `crystalNode` reads `null` exactly when a view has no model behind it, and a name here would
// make the placeholder claim the same node as the artifact it stands in for.
const crystalPart = (
  seat: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  accent: number,
  y: number,
  roughness: number,
  metalness: number,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(
    geometry,
    withProbeWeight(
      new THREE.MeshStandardMaterial({
        color: accent,
        emissive: accent,
        emissiveIntensity: towerCrystalIdleIntensity,
        roughness,
        metalness,
      }),
      'towerCrystal',
    ),
  );
  mesh.position.y = y;
  mesh.castShadow = true;
  seat.add(mesh);
  return mesh;
};

// Pulse Spire: tall, narrow, closed, one vertical axis with a cone on it. Its procedural form
// reproduces the generated artifact part for part, down to the crystal at 1.43, because the
// two-phase swap puts the GLB into this exact seat and any difference would be a jump in the picture.
// The artifact owns this tower's shape, so its life has to come out of posture and light.
const spireBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
    color: look.base,
    role: 'towerBase',
    y: 0.15,
    roughness: 0.46,
    metalness: 0.34,
  });
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.2, 0.28, 0.78, 6),
    color: look.stem,
    role: 'towerStem',
    y: 0.5,
    roughness: 0.34,
    metalness: 0.5,
  });
  structurePart(seat, {
    geometry: new THREE.ConeGeometry(0.45, 0.42, 6),
    color: look.roof,
    role: 'towerRoof',
    y: 1.08,
    roughness: 0.3,
    metalness: 0.3,
  });
  const crystal = crystalPart(seat, new THREE.OctahedronGeometry(0.18, 0), look.accent, 1.43, 0.18, 0.15);
  const aura = new THREE.Mesh(
    new THREE.TorusGeometry(0.57, 0.025, 8, 32),
    new THREE.MeshBasicMaterial({ color: look.accent, transparent: true, opacity: 0.7 }),
  );
  aura.rotation.x = Math.PI / 2;
  aura.position.y = 0.18;
  seat.add(aura);
  return crystal;
};

// Grove Lens: the opposite of the spire on both axes at once — wider than it is tall, and open in
// the middle. A short post carries a big ring that leans back, and the lens lies in the plane of
// that ring rather than sitting on top of it, so the tower reads as an eye and not as a roof with a
// gem on it. The hole is the difference from an enemy, which is a solid round body.
const lensTilt = -0.72;
const lensBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.5, 0.56, 0.18, 8),
    color: look.base,
    role: 'towerBase',
    y: 0.09,
    roughness: 0.5,
    metalness: 0.3,
  });
  const rim = structurePart(seat, {
    geometry: new THREE.TorusGeometry(0.44, 0.04, 8, 24),
    color: look.roof,
    role: 'towerRoof',
    y: 0.19,
    roughness: 0.3,
    metalness: 0.42,
  });
  rim.rotation.x = Math.PI / 2;
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.07, 0.1, 0.62, 6),
    color: look.stem,
    role: 'towerStem',
    y: 0.49,
    roughness: 0.35,
    metalness: 0.5,
  });
  const frame = structurePart(seat, {
    geometry: new THREE.TorusGeometry(0.36, 0.055, 8, 24),
    color: look.roof,
    role: 'towerRoof',
    y: 0.78,
    roughness: 0.28,
    metalness: 0.45,
  });
  frame.rotation.x = lensTilt;
  // Flattened in the geometry rather than in the node's scale, because the scale of this node belongs
  // to the shot flash: a flash that swelled the lens along one axis only would read as a squashed
  // gem instead of a bright one. The disc is narrower than the ring's aperture on purpose — a lens
  // that fills its frame reads as a ball in a hoop, and the hole is the whole difference from an enemy.
  const lensGeometry = new THREE.SphereGeometry(0.24, 14, 10);
  lensGeometry.scale(1, 0.32, 1);
  const lens = crystalPart(seat, lensGeometry, look.accent, 0.78, 0.16, 0.1);
  // A sphere is flat along its own Y, so this quarter turn is what puts the lens in the plane of the
  // ring instead of flat on the post.
  lens.rotation.x = lensTilt + Math.PI / 2;
  return lens;
};

// Frost Relay: an open frame, and the only tower here that is mostly air. Two struts lean together
// under a crossbar and the crystal hangs in the space between them, which is a shape neither the
// solid spire nor the solid lens can be mistaken for. The angled bars at mid height are the antennae
// that give the frame a purpose, and the wide stance is what keeps it from reading as a mast.
const relayBody = (seat: THREE.Object3D, look: TowerLook): THREE.Mesh => {
  structurePart(seat, {
    geometry: new THREE.CylinderGeometry(0.38, 0.46, 0.2, 6),
    color: look.base,
    role: 'towerBase',
    y: 0.1,
    roughness: 0.52,
    metalness: 0.28,
  });
  for (const side of [-1, 1]) {
    const leg = structurePart(seat, {
      geometry: new THREE.CylinderGeometry(0.075, 0.1, 1.16, 5),
      color: look.stem,
      role: 'towerStem',
      y: 0.58,
      x: side * 0.24,
      roughness: 0.34,
      metalness: 0.55,
    });
    // Signed by the side, so both struts lean inward and meet under the crossbar instead of splaying
    // away from each other.
    leg.rotation.z = side * 0.2;
    const antenna = structurePart(seat, {
      geometry: new THREE.BoxGeometry(0.3, 0.055, 0.055),
      color: look.roof,
      role: 'towerRoof',
      y: 0.62,
      x: side * 0.32,
      roughness: 0.3,
      metalness: 0.4,
    });
    antenna.rotation.z = side * 0.34;
  }
  structurePart(seat, {
    geometry: new THREE.BoxGeometry(0.46, 0.09, 0.09),
    color: look.roof,
    role: 'towerRoof',
    y: 1.14,
    roughness: 0.3,
    metalness: 0.4,
  });
  // A tetrahedron and not an octahedron, sized so that it spans about as much of the frame as the
  // spire's crystal spans of its roof: at this distance the shape of the gem is a third of the read.
  const crystal = crystalPart(seat, new THREE.TetrahedronGeometry(0.34), look.accent, 0.96, 0.16, 0.12);
  crystal.rotation.y = Math.PI / 4;
  return crystal;
};

const towerLooks: Record<string, TowerLook> = {
  'pulse-spire': {
    accent: 0x6ee2cf,
    base: 0x1d4651,
    stem: 0x346f75,
    roof: 0xd29b62,
    // The tallest of the three and the only one scaled up: this is the tower the player reads as the
    // building, and the extra size belongs in the seat rather than in the geometry, where the model
    // pipeline and its eleven red checks own it.
    scale: 1.08,
    tiltX: 0.02,
    tiltZ: 0.03,
    nod: 0,
    spin: 0.34,
    // No breath and no nod: this tower's idle intensity is a number the suite reads, and its crystal
    // already moves every two seconds on the clip.
    bob: 0.07,
    roll: 0.05,
    breath: 0,
    build: spireBody,
  },
  'grove-lens': {
    accent: 0x8cd6ff,
    base: 0x2b2740,
    stem: 0x413a63,
    roof: 0x8d6bb5,
    scale: 0.94,
    tiltX: 0,
    tiltZ: 0.02,
    // A heavy lens on a short post does not bob, it scans. The body already carries its lean, so all
    // the seat has left to give is that slow sweep across the road.
    nod: 0.05,
    spin: 0.2,
    bob: 0.02,
    roll: 0,
    breath: 0.35,
    build: lensBody,
  },
  'frost-relay': {
    accent: 0xffc56b,
    base: 0x20323b,
    stem: 0x4a6b78,
    roof: 0x8fa3b5,
    // The frame is mostly air, so it is also the smallest thing on screen: without the extra scale and
    // the lighter steel it read as debris on the terrace rather than as a structure the player built.
    scale: 1.06,
    tiltX: 0,
    tiltZ: 0,
    nod: 0,
    // The fastest turn of the three, because a frame with nothing solid in it has to be read as
    // aimed by its motion rather than by its mass.
    spin: 0.5,
    // A gem hung in a frame is free to rock, and the air around it is what this tower is made of.
    bob: 0.04,
    roll: 0.09,
    breath: 0.28,
    build: relayBody,
  },
};
// A tower no table has an entry for still has to stand on a pad and fire, so it stands as the
// spire does, in the neutral colours the placeholder has always used.
const unknownTowerLook: TowerLook = {
  accent: 0x9fd6c8,
  base: 0x1d4651,
  stem: 0x346f75,
  roof: 0x5b7f86,
  scale: 1,
  tiltX: 0,
  tiltZ: 0,
  nod: 0,
  spin: 0.34,
  bob: 0.07,
  roll: 0.05,
  breath: 0,
  build: spireBody,
};
const lookOf = (towerId: string): TowerLook => towerLooks[towerId] ?? unknownTowerLook;

// How much of a shot is left, as 1 at the peak and 0 the moment it is over. A flash that switched off
// at a fixed time reads as a switch; this one holds and then dies, which is what a shot looks like
// when the thing that fired is still standing there afterwards.
const shotFlash = (firedUntil: number, elapsed: number): number => {
  if (elapsed >= firedUntil) {
    return 0;
  }
  const remaining = (firedUntil - elapsed) / towerFireFlashSeconds;
  return remaining > towerFlashHoldShare ? 1 : remaining / towerFlashHoldShare;
};

export const createTowers = (
  scene: THREE.Scene,
  modelStore: Map<string, LoadedModel>,
  padDefinitions: ReadonlyMap<string, BuildPadDefinition>,
): TowerPresentation => {
  const towerViews = new Map<number, TowerView>();
  // The seat of every live view, by entity. It lives beside the view rather than inside it because
  // `TowerView` is a shape the page reads, and a view swapped in place has to give its seat back
  // before the replacement claims the same id.
  const viewSeats = new Map<number, THREE.Object3D>();
  const shotMuzzle = new THREE.Vector3();
  const shotImpact = new THREE.Vector3();
  let reducedMotion = false;

  // The loaded scene stays the single owner of its geometry and of its source materials. A view
  // borrows that geometry and gets its own material copies, because the crystal emissive is
  // per-tower presentation state: on a shared material one tower firing would flash every tower
  // of that type at the same time. `SkeletonUtils.clone` is what makes a skinned model clonable at
  // all — it rebuilds the skeleton and rebinds the copy to its own bones — and it hands geometry and
  // materials back by reference, so the material copies are made here, after the clone.
  const cloneModelNode = (source: THREE.Object3D, owned: THREE.Material[]): THREE.Object3D => {
    const clone = SkeletonUtils.clone(source);
    clone.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) {
        return;
      }
      // `Material.copy` carries the probe across: `envMap`, `envMapIntensity` and the `userData`
      // stamp are all part of what a copy is, so a per-view material must not arrive with a
      // declared weight of 1 and no probe of its own.
      const material = (child.material as THREE.Material).clone();
      owned.push(material);
      child.material = material;
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return clone;
  };

  const startTowerClip = (
    root: THREE.Object3D,
    clip: THREE.AnimationClip,
    phase: number,
    presentationTime: number,
  ): TowerClip | null => {
    if (clip.tracks.length === 0) {
      return null;
    }
    // Every channel of the clip has to land on a bone of this copy, not just the first one: the mixer
    // resolves a track by name inside the root it was given, and a name it cannot find is a channel
    // that silently does nothing.
    const bones: THREE.Bone[] = [];
    for (const track of clip.tracks) {
      const name = track.name.split('.')[0] ?? '';
      const bone = root.getObjectByName(name) as THREE.Bone | undefined;
      if (bone?.isBone !== true) {
        throw new AssetContractError(`clip ${clip.name} drives ${name}, which is not a bone of the model`);
      }
      bones.push(bone);
    }
    const mixer = new THREE.AnimationMixer(root);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopRepeat, Infinity);
    // Reduced motion does not slow the clip down, it stops it: without a play call the bones stay in
    // the rest pose the model was authored in.
    if (!reducedMotion) {
      action.play();
    }
    action.time = phase % clip.duration;
    return { mixer, action, clipName: clip.name, duration: clip.duration, phase, bone: bones[0] as THREE.Bone, applied: presentationTime };
  };

  const readTowerClip = (clip: TowerClip): TowerClipReading => ({
    clipName: clip.clipName,
    duration: clip.duration,
    phase: clip.phase,
    time: clip.action.time,
    playing: clip.action.isRunning(),
    boneName: clip.bone.name,
    pose: [clip.bone.quaternion.x, clip.bone.quaternion.y, clip.bone.quaternion.z, clip.bone.quaternion.w],
  });

  // One seat and one body, whichever source they come from. A loaded model is not special here: a
  // skinned mesh keeps its bind inverse in step with its own world matrix, so the seat's scale and
  // lean reach a model exactly once and land on a procedural tower exactly once, which is what makes
  // the swap in place invisible.
  const createTowerView = (entityId: number, towerId: string, slot: number, presentationTime: number): TowerView => {
    const look = lookOf(towerId);
    const seat = new THREE.Group();
    seat.name = 'seat';
    seat.scale.setScalar(look.scale);
    const model = modelStore.get(towerId);
    const owned: THREE.Material[] = [];
    let crystal: THREE.Mesh;
    let crystalMaterial: THREE.MeshStandardMaterial;
    let modelRoot: THREE.Object3D | null = null;
    let clip: TowerClip | null = null;
    if (model === undefined) {
      crystal = look.build(seat, look);
      crystalMaterial = crystal.material as THREE.MeshStandardMaterial;
    } else {
      const root = cloneModelNode(model.scene, owned) as THREE.Group;
      const emissive = root.getObjectByName(model.emissiveNode);
      if (!(emissive instanceof THREE.Mesh) || !(emissive.material instanceof THREE.MeshStandardMaterial)) {
        throw new AssetContractError(`model ${model.entry.id} has no ${model.emissiveNode} mesh to animate`);
      }
      seat.add(root);
      crystal = emissive;
      crystalMaterial = emissive.material;
      modelRoot = root;
      clip = model.clips[0] === undefined
        ? null
        : startTowerClip(root, model.clips[0], slot * TOWER_CLIP_PHASE_SECONDS, presentationTime);
    }
    crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
    const group = new THREE.Group();
    group.name = `tower:${towerId}`;
    group.add(seat);
    viewSeats.set(entityId, seat);
    return {
      towerId,
      group,
      crystal,
      crystalMaterial,
      crystalBaseY: crystal.position.y,
      source: model === undefined ? 'procedural' : 'model',
      modelId: model?.entry.id ?? null,
      clip,
      firedUntil: 0,
      aimAngle: 0,
      release: () => {
        // A mixer keeps its bindings and its actions alive on its own, so a tower that is removed
        // has to give them back: thirty removed towers would otherwise leave thirty mixers running
        // against a skeleton nothing renders any more.
        if (clip !== null && modelRoot !== null) {
          clip.mixer.stopAllAction();
          clip.mixer.uncacheRoot(modelRoot);
        }
        for (const material of owned) {
          material.dispose();
        }
        // A procedural tower owns its geometry; a loaded model's geometry and source materials stay
        // with the registry, or the next view of that model would get a disposed one.
        if (model === undefined) {
          disposeInstance(seat);
        }
        // A view that has already been replaced in place has given the id to its successor, and the
        // seat it is releasing is no longer the one on record.
        if (viewSeats.get(entityId) === seat) {
          viewSeats.delete(entityId);
        }
      },
    };
  };

  const countMeshes = (object: THREE.Object3D): number => {
    let total = 0;
    object.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        total += 1;
      }
    });
    return total;
  };

  return {
    applySnapshot: (next: MatchSnapshot, presentationTime: number) => {
      const aliveTowers = new Set<number>();
      for (const tower of next.towers) {
        aliveTowers.add(tower.entityId);
        let view = towerViews.get(tower.entityId);
        if (!view) {
          const pad = padDefinitions.get(tower.padId);
          if (!pad) {
            continue;
          }
          view = createTowerView(tower.entityId, tower.towerId, towerViews.size, presentationTime);
          view.group.position.set(pad.position.x, towerSeatHeight, pad.position.z);
          scene.add(view.group);
          towerViews.set(tower.entityId, view);
        }
      }
      for (const [entityId, view] of towerViews) {
        if (aliveTowers.has(entityId)) {
          continue;
        }
        scene.remove(view.group);
        view.release();
        towerViews.delete(entityId);
      }
    },
    animate: (elapsed: number, ambientDelta: number, presentationTime: number) => {
      for (const [entityId, view] of towerViews) {
        const look = lookOf(view.towerId);
        const flash = shotFlash(view.firedUntil, elapsed);
        if (flash > 0) {
          view.group.rotation.y = view.aimAngle;
        } else {
          view.group.rotation.y += ambientDelta * look.spin;
        }
        view.crystal.scale.setScalar(1 + towerCrystalFireScale * flash);
        // The light breathes downward out of the idle intensity and only a shot crosses it, so that
        // "brighter than idle" keeps meaning the same thing here as it does in the rest of the
        // project.
        view.crystalMaterial.emissiveIntensity =
          towerCrystalIdleIntensity -
          look.breath * (0.5 + 0.5 * Math.sin(elapsed * 1.7 + entityId)) +
          (towerCrystalFireIntensity - towerCrystalIdleIntensity) * flash;
        view.crystal.position.y = view.crystalBaseY + (reducedMotion ? 0 : Math.sin(elapsed * 2.1 + entityId) * look.bob);
        // A roll is the one idle channel the artifact's crystal can take on top of its own sway, and
        // it is what stops an idle spire from looking like a gem parked on a roof.
        view.crystal.rotation.z = reducedMotion ? 0 : Math.sin(elapsed * 1.6 + entityId) * look.roll;
        const seat = viewSeats.get(entityId);
        if (seat !== undefined) {
          seat.rotation.x = look.tiltX + (reducedMotion ? 0 : Math.sin(elapsed * 0.9 + entityId) * look.nod);
          seat.rotation.z = look.tiltZ;
        }
        // The clip and the bob share one reduced-motion guard and two clocks. The skeleton is brought
        // up to the match clock rather than advanced by the frame, so the pose of a tick is a function
        // of that tick: a tower built by a pad click and the same tower rebuilt by a replay both start
        // at zero on the tick they were placed, and the terminal tick holds its pose in both runs.
        if (view.clip !== null && !reducedMotion) {
          const due = presentationTime - view.clip.applied;
          if (due > 0) {
            view.clip.mixer.update(due);
            view.clip.applied = presentationTime;
          }
        }
      }
    },
    onFired: (entityId: number, target: THREE.Vector3 | null, elapsed: number): ShotEndpoints | null => {
      const view = towerViews.get(entityId);
      if (!view || reducedMotion) {
        return null;
      }
      view.firedUntil = elapsed + towerFireFlashSeconds;
      if (target === null) {
        return null;
      }
      // Three.js rotates local +X toward -Z, so the Y angle is negated.
      view.aimAngle = Math.atan2(
        -(target.z - view.group.position.z),
        target.x - view.group.position.x,
      );
      // The shot itself, from the crystal to where the target is standing on the tick the event
      // describes. Without it the only evidence of a tower working is the target's disappearance, and
      // a beam that left a fixed height above the pad left the tower somewhere the player cannot see
      // the light. `getWorldPosition` updates the chain it reads, so the point belongs to this frame
      // rather than to the one before it, and it is the same node whether the crystal is a primitive
      // or the skinned mesh the artifact shipped.
      view.crystal.getWorldPosition(shotMuzzle);
      if (!Number.isFinite(shotMuzzle.y)) {
        shotMuzzle.set(view.group.position.x, view.group.position.y + towerMuzzleHeight, view.group.position.z);
      }
      shotImpact.set(target.x, target.y + enemyImpactHeight, target.z);
      return { from: shotMuzzle, to: shotImpact };
    },
    // Two-phase swap. A view built before the registry answered keeps rendering, and once the model
    // is in it is replaced in place: no entity is recreated, no position changes and the snapshot is
    // not touched, so a late model cannot make two replays of the same run look different.
    upgradeWithModels: (presentationTime: number) => {
      for (const [entityId, view] of [...towerViews]) {
        if (view.source === 'model' || !modelStore.has(view.towerId)) {
          continue;
        }
        // The slot is the order the towers were built in, so a tower that is upgraded in place keeps
        // the clip phase it would have had if the model had arrived on time.
        const slot = [...towerViews.keys()].indexOf(entityId);
        const next = createTowerView(entityId, view.towerId, slot, presentationTime);
        next.group.position.copy(view.group.position);
        next.group.rotation.y = view.group.rotation.y;
        next.firedUntil = view.firedUntil;
        next.aimAngle = view.aimAngle;
        scene.remove(view.group);
        view.release();
        scene.add(next.group);
        towerViews.set(entityId, next);
      }
    },
    resetFired: () => {
      for (const view of towerViews.values()) {
        view.firedUntil = 0;
      }
    },
    setReducedMotion: (reduced: boolean) => {
      reducedMotion = reduced;
      if (!reducedMotion) {
        return;
      }
      // Turning reduced motion on mid-match has to do the same thing it does from the start: the clip
      // stops, and the bones go back to the rest pose instead of freezing wherever the last frame left
      // them. Reading the pose from `setTime(0)` before the action stops is what applies it.
      for (const view of towerViews.values()) {
        if (view.clip === null) {
          continue;
        }
        view.clip.mixer.setTime(0);
        view.clip.action.stop();
      }
    },
    viewCount: () => towerViews.size,
    positions: () => Array.from(towerViews.values(), (view) => ({ x: view.group.position.x, z: view.group.position.z })),
    modelReadings: () =>
      Array.from(towerViews, ([entityId, view]): TowerModelReading => ({
        entityId,
        towerId: view.towerId,
        source: view.source,
        modelId: view.modelId,
        meshCount: countMeshes(view.group),
        // The procedural placeholder has no name on its emissive mesh, so this is also the
        // cheapest way to see which node of the model the client ended up animating.
        crystalNode: view.crystal.name || null,
        crystalBaseY: view.crystalBaseY,
        crystalY: view.crystal.position.y,
        crystalScale: view.crystal.scale.x,
        crystalEmissive: view.crystalMaterial.emissiveIntensity,
        clip: view.clip === null ? null : readTowerClip(view.clip),
      })),
    poseReadings: () =>
      Array.from(towerViews, ([entityId, view]) => ({
        entityId,
        towerId: view.towerId,
        clip: view.clip === null ? null : readTowerClip(view.clip),
      })),
    clipMotion: () => {
      const clips = Array.from(towerViews.values(), (view) => view.clip);
      return {
        // One mixer per animated view and no more: a tower that was removed or upgraded in place must
        // not leave a second animation running against the same skeleton.
        clips: clips.filter((clip) => clip !== null).length,
        clipsPlaying: clips.filter((clip) => clip?.action.isRunning() === true).length,
      };
    },
  };
};
