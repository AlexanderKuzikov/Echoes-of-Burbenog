import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { AssetContractError } from '../asset-registry.ts';
import type { ModelManifestEntry } from '../asset-registry.ts';
import type { BuildPadDefinition, MatchSnapshot } from '../game-core/index.ts';
import { disposeInstance, withProbeWeight } from './shared.ts';

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

const towerVisuals: Record<string, { accent: number; roof: number; scale: number }> = {
  'pulse-spire': { accent: 0x6ee2cf, roof: 0xd29b62, scale: 1 },
  'grove-lens': { accent: 0x8cd6ff, roof: 0x8d6bb5, scale: 0.95 },
  'frost-relay': { accent: 0xffc56b, roof: 0xbe6b55, scale: 1.05 },
};
const unknownTowerVisual = { accent: 0x9fd6c8, roof: 0x5b7f86, scale: 1 };

const towerCrystalIdleIntensity = 2.4;
const towerCrystalFireIntensity = 5.2;
const towerFireFlashSeconds = 0.22;
// Where a shot leaves a tower and where it lands on a body. Both are presentation constants, and
// both are read from the views at the moment of the event rather than recomputed from content.
const towerMuzzleHeight = 0.92;
const enemyImpactHeight = 0.3;

// One clip per view, started at a slot-derived offset instead of at a random moment. The offset
// comes from the order the towers were built in, which the replay reproduces, so two spires never
// stand in the same pose and a restart still lands on the same one.
const TOWER_CLIP_PHASE_SECONDS = 0.37;

export const createTowers = (
  scene: THREE.Scene,
  modelStore: Map<string, LoadedModel>,
  padDefinitions: ReadonlyMap<string, BuildPadDefinition>,
): TowerPresentation => {
  const towerViews = new Map<number, TowerView>();
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

  const createModelTowerView = (
    towerId: string,
    model: LoadedModel,
    slot: number,
    presentationTime: number,
  ): TowerView => {
    const visual = towerVisuals[towerId] ?? unknownTowerVisual;
    const owned: THREE.Material[] = [];
    const root = cloneModelNode(model.scene, owned) as THREE.Group;
    const group = new THREE.Group();
    group.name = `tower:${towerId}`;
    group.scale.setScalar(visual.scale);
    group.add(root);
    const emissive = root.getObjectByName(model.emissiveNode);
    if (!(emissive instanceof THREE.Mesh) || !(emissive.material instanceof THREE.MeshStandardMaterial)) {
      throw new AssetContractError(`model ${model.entry.id} has no ${model.emissiveNode} mesh to animate`);
    }
    const crystalMaterial = emissive.material;
    crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
    const clip = model.clips[0] === undefined
      ? null
      : startTowerClip(root, model.clips[0], slot * TOWER_CLIP_PHASE_SECONDS, presentationTime);
    return {
      towerId,
      group,
      crystal: emissive,
      crystalMaterial,
      crystalBaseY: emissive.position.y,
      source: 'model',
      modelId: model.entry.id,
      clip,
      firedUntil: 0,
      aimAngle: 0,
      release: () => {
        // A mixer keeps its bindings and its actions alive on its own, so a tower that is removed
        // has to give them back: thirty removed towers would otherwise leave thirty mixers running
        // against a skeleton nothing renders any more.
        if (clip !== null) {
          clip.mixer.stopAllAction();
          clip.mixer.uncacheRoot(root);
        }
        for (const material of owned) {
          material.dispose();
        }
      },
    };
  };

  const createProceduralTowerView = (towerId: string): TowerView => {
    const visual = towerVisuals[towerId] ?? unknownTowerVisual;
    const group = new THREE.Group();
    group.scale.setScalar(visual.scale);
    group.name = `tower:${towerId}`;

    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.46, 0.56, 0.3, 6),
      withProbeWeight(
        new THREE.MeshStandardMaterial({ color: 0x1d4651, roughness: 0.46, metalness: 0.34 }),
        'towerBase',
      ),
    );
    base.position.y = 0.15;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const stem = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.28, 0.78, 6),
      withProbeWeight(
        new THREE.MeshStandardMaterial({ color: 0x346f75, roughness: 0.34, metalness: 0.5 }),
        'towerStem',
      ),
    );
    stem.position.y = 0.5;
    stem.castShadow = true;
    group.add(stem);

    const roof = new THREE.Mesh(
      new THREE.ConeGeometry(0.45, 0.42, 6),
      withProbeWeight(
        new THREE.MeshStandardMaterial({ color: visual.roof, roughness: 0.3, metalness: 0.3 }),
        'towerRoof',
      ),
    );
    roof.position.y = 1.08;
    roof.castShadow = true;
    group.add(roof);

    const crystal = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.18, 0),
      withProbeWeight(
        new THREE.MeshStandardMaterial({
          color: visual.accent,
          emissive: visual.accent,
          emissiveIntensity: towerCrystalIdleIntensity,
          roughness: 0.18,
          metalness: 0.15,
        }),
        'towerCrystal',
      ),
    );
    crystal.position.y = 1.43;
    group.add(crystal);

    const aura = new THREE.Mesh(
      new THREE.TorusGeometry(0.57, 0.025, 8, 32),
      new THREE.MeshBasicMaterial({ color: visual.accent, transparent: true, opacity: 0.7 }),
    );
    aura.rotation.x = Math.PI / 2;
    aura.position.y = 0.18;
    group.add(aura);

    return {
      towerId,
      group,
      crystal,
      crystalMaterial: crystal.material as THREE.MeshStandardMaterial,
      crystalBaseY: crystal.position.y,
      source: 'procedural',
      modelId: null,
      // The placeholder has no rig, so there is no clip and nothing to stop when the view is released.
      clip: null,
      firedUntil: 0,
      aimAngle: 0,
      release: () => disposeInstance(group),
    };
  };

  const createTowerView = (towerId: string, slot: number, presentationTime: number): TowerView => {
    const model = modelStore.get(towerId);
    return model
      ? createModelTowerView(towerId, model, slot, presentationTime)
      : createProceduralTowerView(towerId);
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
          view = createTowerView(tower.towerId, towerViews.size, presentationTime);
          view.group.position.set(pad.position.x, 0.14, pad.position.z);
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
      let towerSlot = 0;
      for (const view of towerViews.values()) {
        if (elapsed < view.firedUntil) {
          view.group.rotation.y = view.aimAngle;
          view.crystal.scale.setScalar(1.55);
          view.crystalMaterial.emissiveIntensity = towerCrystalFireIntensity;
        } else {
          view.group.rotation.y += ambientDelta * (0.34 + towerSlot * 0.08);
          view.crystal.scale.setScalar(1);
          view.crystalMaterial.emissiveIntensity = towerCrystalIdleIntensity;
        }
        view.crystal.position.y = view.crystalBaseY + (reducedMotion ? 0 : Math.sin(elapsed * 2.1 + towerSlot) * 0.07);
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
        towerSlot += 1;
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
      // The shot itself, from the muzzle to where the target is standing on the tick the event
      // describes. Without it the only evidence of a tower working is the target's disappearance.
      shotMuzzle.set(view.group.position.x, view.group.position.y + towerMuzzleHeight, view.group.position.z);
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
        const next = createTowerView(view.towerId, slot, presentationTime);
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
