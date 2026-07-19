import * as THREE from "three";
import type { SpiderIKSolver } from "../spider/SpiderIKSolver";
import type { SpiderRig } from "../spider/SpiderRig";
import type { SpiderLegId } from "../spider/SpiderRigSpec";

export type GroomingPhase =
  | "idle"
  | "settling"
  | "lifting"
  | "threading"
  | "drawing"
  | "releasing"
  | "returning";

export interface SpiderGroomingSnapshot {
  readonly active: boolean;
  readonly legId: SpiderLegId | null;
  readonly phase: GroomingPhase;
  readonly progress: number;
  readonly stroke: number;
  readonly footToMouth: number | null;
  readonly mouthToLeg: number | null;
}

const LIFT_DURATION = 1.3;
const THREAD_DURATION = 0.25;
const DRAW_STROKES = 1;
const DRAW_STROKE_DURATION = 1.2;
const RELEASE_DURATION = 0.25;
const RETURN_DURATION = 1.3;
const MAX_JOINT_SPEED = THREE.MathUtils.degToRad(300);
const MAX_JOINT_STEP = THREE.MathUtils.degToRad(8);
const RETURN_POSE_EPSILON = THREE.MathUtils.degToRad(0.25);
// These four chains can cross the actual fang midpoint while retaining the
// rig's anatomical joint limits. Pair I cannot reach it without over-folding;
// pair IV remains the posterior silk-handling anchor until it has an authored
// body-clearance pose.
const GROOMING_LEG_IDS: readonly SpiderLegId[] = ["L2", "R2", "L3", "R3"];

export function isGroomableLegId(
  value: string | null | undefined,
): value is SpiderLegId {
  return typeof value === "string"
    && GROOMING_LEG_IDS.includes(value as SpiderLegId);
}
const ACTION_DURATION =
  LIFT_DURATION
  + THREAD_DURATION
  + DRAW_STROKES * DRAW_STROKE_DURATION
  + RELEASE_DURATION
  + RETURN_DURATION;

function smoothstep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function quadraticBezier(
  target: THREE.Vector3,
  from: THREE.Vector3,
  control: THREE.Vector3,
  to: THREE.Vector3,
  t: number,
): THREE.Vector3 {
  const inverse = 1 - t;
  return target
    .copy(from)
    .multiplyScalar(inverse * inverse)
    .addScaledVector(control, 2 * inverse * t)
    .addScaledVector(to, t * t);
}

/**
 * Presentation-only post-feeding grooming.
 *
 * Locomotion continues to own the semantic silk contacts. This pass is applied
 * after it and restored before the next fixed step, just like the prey-handling
 * pose. Seven legs therefore keep their exact resting transforms while one
 * tarsus is folded to the chelicerae, drawn through them, and returned.
 */
export class SpiderGroomingSystem {
  private readonly savedRotations = new Map<THREE.Bone, THREE.Quaternion>();
  /** Last displayed grooming pose; locomotion's base pose remains untouched. */
  private readonly previousJointRotations = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly homeTarget = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly preMouthTarget = new THREE.Vector3();
  private readonly entryTarget = new THREE.Vector3();
  private readonly exitTarget = new THREE.Vector3();
  private readonly postMouthTarget = new THREE.Vector3();
  private readonly liftControl = new THREE.Vector3();
  private readonly returnControl = new THREE.Vector3();
  private readonly mouth = new THREE.Vector3();
  private readonly leftFang = new THREE.Vector3();
  private readonly rightFang = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly headReference = new THREE.Vector3();
  private readonly bodyCenter = new THREE.Vector3();
  private readonly dorsalReference = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly dorsal = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly rootScale = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly solvedRotation = new THREE.Quaternion();
  private readonly footPosition = new THREE.Vector3();
  private readonly segmentA = new THREE.Vector3();
  private readonly segmentB = new THREE.Vector3();
  private readonly segmentDelta = new THREE.Vector3();
  private readonly mouthOffset = new THREE.Vector3();
  private readonly closestPoint = new THREE.Vector3();

  private active = false;
  private initialized = false;
  private legId: SpiderLegId | null = null;
  private lastLegId: SpiderLegId | null = null;
  private phase: GroomingPhase = "idle";
  private elapsed = 0;
  private stroke = 0;
  private footToMouth: number | null = null;
  private mouthToLeg: number | null = null;

  constructor(
    private readonly rig: SpiderRig,
    private readonly ik: SpiderIKSolver,
    private readonly random: () => number = Math.random,
  ) {}

  get snapshot(): SpiderGroomingSnapshot {
    return {
      active: this.active,
      legId: this.legId,
      phase: this.phase,
      progress: this.active && this.initialized
        ? THREE.MathUtils.clamp(this.elapsed / ACTION_DURATION, 0, 1)
        : 0,
      stroke: this.stroke,
      footToMouth: this.footToMouth,
      mouthToLeg: this.mouthToLeg,
    };
  }

  start(preferredLeg?: SpiderLegId): SpiderLegId {
    this.cancel();
    if (preferredLeg !== undefined && !isGroomableLegId(preferredLeg)) {
      throw new Error(`Leg ${preferredLeg} does not have a safe grooming pose.`);
    }
    const candidates = GROOMING_LEG_IDS.filter((candidate) => candidate !== this.lastLegId);
    const chosen = preferredLeg ?? candidates[
      Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))
    ];
    this.legId = chosen;
    this.lastLegId = chosen;
    this.active = true;
    this.initialized = false;
    this.phase = "settling";
    this.elapsed = 0;
    this.stroke = 0;
    this.footToMouth = null;
    this.mouthToLeg = null;
    this.previousJointRotations.clear();
    return chosen;
  }

  cancel(): void {
    this.restoreBasePose();
    this.active = false;
    this.initialized = false;
    this.legId = null;
    this.phase = "idle";
    this.elapsed = 0;
    this.stroke = 0;
    this.footToMouth = null;
    this.mouthToLeg = null;
    this.previousJointRotations.clear();
  }

  /** Restores the locomotion pose before physics/choreography runs again. */
  restoreBasePose(): void {
    if (this.savedRotations.size === 0) return;
    for (const [bone, rotation] of this.savedRotations) {
      bone.quaternion.copy(rotation);
    }
    this.savedRotations.clear();
    this.rig.rootObject.updateMatrixWorld(true);
  }

  /**
   * Applies one visual grooming frame. Returns true exactly when the bout ends.
   */
  update(dt: number, stationaryPoseSettled: boolean): boolean {
    if (!this.active || !this.legId || !(dt > 0)) return false;
    if (!stationaryPoseSettled) {
      // A new movement intent invalidates the old foothold-relative home pose.
      // Restart only after the choreographer owns a fresh stationary snapshot.
      this.restoreBasePose();
      this.initialized = false;
      this.elapsed = 0;
      this.previousJointRotations.clear();
      this.phase = "settling";
      return false;
    }

    const leg = this.rig.legs[this.legId];
    if (!this.initialized) {
      this.rig.rootObject.updateMatrixWorld(true);
      leg.footTip.getWorldPosition(this.homeTarget);
      this.previousJointRotations.clear();
      for (const bone of leg.joints) {
        this.previousJointRotations.set(bone, bone.quaternion.clone());
      }
      this.initialized = true;
      this.elapsed = 0;
    }

    this.captureBasePose();
    this.buildMouthTargets();
    this.elapsed = Math.min(ACTION_DURATION, this.elapsed + dt);
    this.buildFootTarget();
    this.seedPreviousJointPose();

    // The target is the FootTip itself: during the draw it moves monotonically
    // from just behind to just beyond the fang midpoint. Keeping the ordinary
    // joint limits prevents the spectacular but impossible limb flips produced
    // by an unconstrained whole-chain solve.
    this.ik.solve(this.legId, this.target, {
      bendBias: 0.2,
      enforceJointLimits: true,
      maxIterations: 24,
    });
    if (this.elapsed >= ACTION_DURATION) this.aimSolvedPoseAtBase();
    this.limitJointMotion(dt);
    this.applyMouthpartPose();
    this.rig.rootObject.updateMatrixWorld(true);
    leg.footTip.getWorldPosition(this.footPosition);
    this.footToMouth = this.footPosition.distanceTo(this.mouth);
    this.mouthToLeg = this.measureMouthToLeg();

    if (this.elapsed < ACTION_DURATION || !this.jointPoseAtBase()) return false;
    this.restoreBasePose();
    this.active = false;
    this.initialized = false;
    this.phase = "idle";
    this.stroke = 0;
    this.previousJointRotations.clear();
    return true;
  }

  /** Starts each visual solve from its last displayed branch, not the walk pose. */
  private seedPreviousJointPose(): void {
    if (!this.legId) return;
    for (const bone of this.rig.legs[this.legId].joints) {
      const previous = this.previousJointRotations.get(bone);
      if (previous) bone.quaternion.copy(previous);
    }
    this.rig.rootObject.updateMatrixWorld(true);
  }

  /** Prevents a legal-but-abrupt FABRIK branch switch from reading as a leg pop. */
  private limitJointMotion(dt: number): void {
    if (!this.legId) return;
    const maximumStep = Math.min(MAX_JOINT_STEP, MAX_JOINT_SPEED * dt);
    for (const bone of this.rig.legs[this.legId].joints) {
      const previous = this.previousJointRotations.get(bone);
      if (!previous) continue;
      this.solvedRotation.copy(bone.quaternion);
      bone.quaternion
        .copy(previous)
        .rotateTowards(this.solvedRotation, maximumStep);
      previous.copy(bone.quaternion);
    }
  }

  /** At the end, converge explicitly to the captured base instead of snapping. */
  private aimSolvedPoseAtBase(): void {
    if (!this.legId) return;
    for (const bone of this.rig.legs[this.legId].joints) {
      const base = this.savedRotations.get(bone);
      if (base) bone.quaternion.copy(base);
    }
  }

  private jointPoseAtBase(): boolean {
    if (!this.legId) return true;
    for (const bone of this.rig.legs[this.legId].joints) {
      const base = this.savedRotations.get(bone);
      if (base && bone.quaternion.angleTo(base) > RETURN_POSE_EPSILON) return false;
    }
    return true;
  }

  private captureBasePose(): void {
    if (!this.legId) return;
    for (const bone of this.rig.legs[this.legId].joints) this.saveRotation(bone);
    for (const bone of [this.rig.fangs.left[0], this.rig.fangs.right[0]]) {
      if (bone) this.saveRotation(bone);
    }
    const palp = this.legId[0] === "L" ? this.rig.pedipalps.left : this.rig.pedipalps.right;
    for (const bone of palp.slice(0, 2)) this.saveRotation(bone);
  }

  private saveRotation(bone: THREE.Bone): void {
    if (!this.savedRotations.has(bone)) {
      this.savedRotations.set(bone, bone.quaternion.clone());
    }
  }

  private buildMouthTargets(): void {
    if (!this.legId) return;
    this.rig.fangs.left[0].getWorldPosition(this.leftFang);
    this.rig.fangs.right[0].getWorldPosition(this.rightFang);
    this.mouth.copy(this.leftFang).add(this.rightFang).multiplyScalar(0.5);

    this.rig.head.getWorldPosition(this.head);
    this.rig.references.head.getWorldPosition(this.headReference);
    this.forward.subVectors(this.headReference, this.head).normalize();
    this.rig.references.bodyCenter.getWorldPosition(this.bodyCenter);
    this.rig.references.dorsal.getWorldPosition(this.dorsalReference);
    this.dorsal.subVectors(this.dorsalReference, this.bodyCenter).normalize();
    this.side.crossVectors(this.forward, this.dorsal).normalize();
    if (this.legId[0] === "L") this.side.negate();

    this.rig.rootObject.getWorldScale(this.rootScale);
    const worldScale = (this.rootScale.x + this.rootScale.y + this.rootScale.z) / 3;
    this.entryTarget
      .copy(this.mouth)
      .addScaledVector(this.forward, -0.05 * worldScale)
      .addScaledVector(this.side, 0.004 * worldScale);
    this.exitTarget
      .copy(this.mouth)
      .addScaledVector(this.forward, 0.025 * worldScale)
      .addScaledVector(this.side, 0.004 * worldScale);
    this.preMouthTarget
      .copy(this.entryTarget)
      .addScaledVector(this.side, 0.035 * worldScale)
      .addScaledVector(this.dorsal, -0.04 * worldScale);
    this.postMouthTarget
      .copy(this.exitTarget)
      .addScaledVector(this.side, 0.035 * worldScale)
      .addScaledVector(this.dorsal, -0.04 * worldScale);
    this.liftControl
      .copy(this.homeTarget)
      .lerp(this.preMouthTarget, 0.52)
      .addScaledVector(this.side, 0.055 * worldScale)
      .addScaledVector(this.dorsal, -0.08 * worldScale);
    this.returnControl
      .copy(this.postMouthTarget)
      .lerp(this.homeTarget, 0.48)
      .addScaledVector(this.side, 0.05 * worldScale)
      .addScaledVector(this.dorsal, -0.075 * worldScale);
  }

  private buildFootTarget(): void {
    let cursor = this.elapsed;
    if (cursor < LIFT_DURATION) {
      this.phase = "lifting";
      quadraticBezier(
        this.target,
        this.homeTarget,
        this.liftControl,
        this.preMouthTarget,
        smoothstep(cursor / LIFT_DURATION),
      );
      return;
    }
    cursor -= LIFT_DURATION;

    if (cursor < THREAD_DURATION) {
      this.phase = "threading";
      this.target.lerpVectors(
        this.preMouthTarget,
        this.entryTarget,
        smoothstep(cursor / THREAD_DURATION),
      );
      return;
    }
    cursor -= THREAD_DURATION;

    if (cursor < DRAW_STROKE_DURATION) {
      this.phase = "drawing";
      this.stroke = 0;
      this.target.lerpVectors(
        this.entryTarget,
        this.exitTarget,
        smoothstep(cursor / DRAW_STROKE_DURATION),
      );
      return;
    }
    cursor -= DRAW_STROKE_DURATION;

    if (cursor < RELEASE_DURATION) {
      this.phase = "releasing";
      this.target.lerpVectors(
        this.exitTarget,
        this.postMouthTarget,
        smoothstep(cursor / RELEASE_DURATION),
      );
      return;
    }
    cursor -= RELEASE_DURATION;

    this.phase = "returning";
    quadraticBezier(
      this.target,
      this.postMouthTarget,
      this.returnControl,
      this.homeTarget,
      smoothstep(cursor / RETURN_DURATION),
    );
  }

  private applyMouthpartPose(): void {
    if (!this.legId || this.phase === "returning") return;
    const cleaning = this.phase === "drawing";
    const pulse = cleaning ? 0.045 + Math.sin(this.elapsed * 12.5) * 0.025 : 0.025;
    this.rotation.setFromAxisAngle(this.rig.axes.boneBend, pulse);
    this.rig.fangs.left[0]?.quaternion.multiply(this.rotation);
    this.rig.fangs.right[0]?.quaternion.multiply(this.rotation);

    // The ipsilateral palp braces the leg beside the chelicerae instead of
    // flailing with it. Equal local rotations mirror correctly in the rig.
    const palp = this.legId[0] === "L" ? this.rig.pedipalps.left : this.rig.pedipalps.right;
    const brace = cleaning ? 0.045 : 0.025;
    for (let index = 0; index < Math.min(2, palp.length); index += 1) {
      this.rotation.setFromAxisAngle(this.rig.axes.boneBend, brace * (1 - index * 0.35));
      palp[index].quaternion.multiply(this.rotation);
    }
  }

  private measureMouthToLeg(): number | null {
    if (!this.legId) return null;
    const chain = this.rig.legs[this.legId].chain;
    let closest = Infinity;
    // Only the terminal tarsus/metatarsus counts. A femur passing near the head
    // is not grooming, even if a whole-chain distance metric says otherwise.
    for (let index = Math.max(0, chain.length - 2); index < chain.length - 1; index += 1) {
      chain[index].getWorldPosition(this.segmentA);
      chain[index + 1].getWorldPosition(this.segmentB);
      this.segmentDelta.subVectors(this.segmentB, this.segmentA);
      const lengthSquared = this.segmentDelta.lengthSq();
      const along = lengthSquared > 1e-8
        ? THREE.MathUtils.clamp(
            this.mouthOffset.subVectors(this.mouth, this.segmentA).dot(this.segmentDelta)
              / lengthSquared,
            0,
            1,
          )
        : 0;
      this.closestPoint.copy(this.segmentA).addScaledVector(this.segmentDelta, along);
      const distance = this.closestPoint.distanceTo(this.mouth);
      if (distance < closest) {
        closest = distance;
      }
    }
    return Number.isFinite(closest) ? closest : null;
  }
}
