import * as THREE from 'three';

const EPSILON = 1e-8;

export interface SpiderBodyVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SpiderSupportSample {
  readonly worldPosition: SpiderBodyVector;
  /** A contact-frame normal or other stable support-up reference. */
  readonly referenceUp?: SpiderBodyVector;
  readonly weight?: number;
  readonly valid?: boolean;
}

export interface SpiderSupportHints {
  readonly forward?: SpiderBodyVector;
  readonly up?: SpiderBodyVector;
  /** Explicitly choose the opposite side of the support surface. */
  readonly flipUp?: boolean;
}

export interface SpiderSupportFrame {
  readonly center: THREE.Vector3;
  readonly forward: THREE.Vector3;
  readonly up: THREE.Vector3;
  readonly right: THREE.Vector3;
  supportCount: number;
  totalWeight: number;
  valid: boolean;
  held: boolean;
  usedContactNormals: boolean;
  usedGeometryNormal: boolean;
}

export interface SpiderBodyPoseDefinition {
  /** Object whose world transform represents the whole spider placement. */
  readonly root: THREE.Object3D;
  /** Optional descendant placed at support-center + clearance. */
  readonly anchor?: THREE.Object3D;
  /** Read from the rig spec; for the supplied GLB this is (-1, 0, 0). */
  readonly modelForward: SpiderBodyVector;
  /** Read from the rig spec; for the supplied GLB this is (0, 1, 0). */
  readonly modelUp: SpiderBodyVector;
}

export interface SpiderBodyPoseControls {
  readonly thoraxHeight?: number;
  /** World-space translation applied after support placement. */
  readonly worldOffset?: SpiderBodyVector;
  /** x=right, y=up, z=forward in the held support frame. */
  readonly supportOffset?: SpiderBodyVector;
  /** Intrinsic rotations in radians around body right/up/forward. */
  readonly pitch?: number;
  readonly yaw?: number;
  readonly roll?: number;
  /**
   * Optional reach-checked world frame from the Phase 8 orientation planner.
   * Translation still comes from the held semantic support frame.
   */
  readonly worldFrame?: {
    readonly forward: SpiderBodyVector;
    readonly up: SpiderBodyVector;
    readonly right?: SpiderBodyVector;
  };
  /** Convenience equivalent to adding PI to roll. */
  readonly upsideDown?: boolean;
}

/** Mutable, allocation-stable diagnostics owned by SpiderBodyPose. */
export interface SpiderBodyPoseResult {
  applied: boolean;
  frameValid: boolean;
  heldFrame: boolean;
  supportCount: number;
  nonUniformParentScale: boolean;
  message: string;
  readonly rootWorldPosition: THREE.Vector3;
  readonly anchorWorldPosition: THREE.Vector3;
  readonly bodyForward: THREE.Vector3;
  readonly bodyUp: THREE.Vector3;
  readonly bodyRight: THREE.Vector3;
}

/**
 * Stable support-frame and global body-placement helper.
 *
 * It never owns gait policy. Call updateSupport with planted contacts, then apply
 * with the desired debug/body offsets. If contacts temporarily disappear, the
 * last valid support frame is held instead of snapping to a world axis.
 */
export class SpiderBodyPose {
  readonly root: THREE.Object3D;
  readonly anchor: THREE.Object3D;
  readonly frame: SpiderSupportFrame;
  readonly result: SpiderBodyPoseResult;

  private readonly modelForward = new THREE.Vector3();
  private readonly modelUp = new THREE.Vector3();
  private readonly modelRight = new THREE.Vector3();
  private readonly modelBasisInverse = new THREE.Quaternion();

  private readonly vectorA = new THREE.Vector3();
  private readonly vectorB = new THREE.Vector3();
  private readonly vectorC = new THREE.Vector3();
  private readonly vectorD = new THREE.Vector3();
  private readonly vectorE = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();
  private readonly matrixA = new THREE.Matrix4();
  private readonly quaternionA = new THREE.Quaternion();
  private readonly quaternionB = new THREE.Quaternion();
  private readonly quaternionC = new THREE.Quaternion();
  private readonly quaternionD = new THREE.Quaternion();

  constructor(definition: SpiderBodyPoseDefinition) {
    this.root = definition.root;
    this.anchor = definition.anchor ?? definition.root;
    if (this.anchor !== this.root && !isDescendantOf(this.anchor, this.root)) {
      throw new Error('Spider body-pose anchor must be the root or one of its descendants.');
    }

    this.modelForward.copy(definition.modelForward as THREE.Vector3);
    this.modelUp.copy(definition.modelUp as THREE.Vector3);
    orthonormalizeForwardUp(this.modelForward, this.modelUp, this.modelRight);

    this.matrixA.makeBasis(
      this.modelRight,
      this.modelUp,
      this.vectorA.copy(this.modelForward).negate(),
    );
    this.modelBasisInverse.setFromRotationMatrix(this.matrixA).invert();

    this.root.updateWorldMatrix(true, true);
    this.root.getWorldQuaternion(this.quaternionA);
    const initialForward = this.modelForward.clone().applyQuaternion(this.quaternionA).normalize();
    const initialUp = this.modelUp.clone().applyQuaternion(this.quaternionA).normalize();
    const initialRight = initialForward.clone().cross(initialUp).normalize();
    initialUp.crossVectors(initialRight, initialForward).normalize();

    this.frame = {
      center: new THREE.Vector3(),
      forward: initialForward,
      up: initialUp,
      right: initialRight,
      supportCount: 0,
      totalWeight: 0,
      valid: false,
      held: false,
      usedContactNormals: false,
      usedGeometryNormal: false,
    };

    this.anchor.getWorldPosition(this.frame.center);
    this.result = {
      applied: false,
      frameValid: false,
      heldFrame: false,
      supportCount: 0,
      nonUniformParentScale: false,
      message: 'Waiting for a valid support frame.',
      rootWorldPosition: new THREE.Vector3(),
      anchorWorldPosition: new THREE.Vector3(),
      bodyForward: initialForward.clone(),
      bodyUp: initialUp.clone(),
      bodyRight: initialRight.clone(),
    };
  }

  /**
   * Discard the held semantic support frame before a fixture/contact reset.
   *
   * The next updateSupport call is then allowed to bootstrap from newly planted
   * contacts instead of requiring those contacts to validate against a body pose
   * inherited from the previous scenario.
   */
  resetSupportFrame(): void {
    this.frame.supportCount = 0;
    this.frame.totalWeight = 0;
    this.frame.valid = false;
    this.frame.held = false;
    this.frame.usedContactNormals = false;
    this.frame.usedGeometryNormal = false;
    this.anchor.getWorldPosition(this.frame.center);
    this.updateResultFrameState('Support frame reset; waiting for newly planted contacts.');
  }

  updateSupport(
    samples: readonly SpiderSupportSample[],
    hints: SpiderSupportHints = {},
  ): SpiderSupportFrame {
    const frame = this.frame;
    this.vectorA.set(0, 0, 0);
    let totalWeight = 0;
    let supportCount = 0;

    for (let i = 0; i < samples.length; i += 1) {
      const sample = samples[i];
      if (!isValidSample(sample)) continue;
      const weight = validWeight(sample.weight);
      this.vectorA.x += sample.worldPosition.x * weight;
      this.vectorA.y += sample.worldPosition.y * weight;
      this.vectorA.z += sample.worldPosition.z * weight;
      totalWeight += weight;
      supportCount += 1;
    }

    frame.supportCount = supportCount;
    frame.totalWeight = totalWeight;
    frame.usedContactNormals = false;
    frame.usedGeometryNormal = false;

    if (supportCount === 0 || totalWeight <= EPSILON) {
      frame.held = frame.valid;
      this.updateResultFrameState('No valid supports; holding the last valid frame.');
      return frame;
    }

    this.vectorA.multiplyScalar(1 / totalWeight);

    const hadFrame = frame.valid;
    this.vectorB.set(0, 0, 0);
    let normalWeight = 0;
    if (isFiniteVector(hints.up)) {
      this.vectorB.copy(hints.up as THREE.Vector3).normalize();
      normalWeight = 1;
    } else {
      for (let i = 0; i < samples.length; i += 1) {
        const sample = samples[i];
        if (!isValidSample(sample) || !isFiniteVector(sample.referenceUp)) continue;
        this.vectorC.copy(sample.referenceUp as THREE.Vector3);
        const lengthSq = this.vectorC.lengthSq();
        if (lengthSq <= EPSILON * EPSILON) continue;
        this.vectorC.multiplyScalar(1 / Math.sqrt(lengthSq));
        if (hadFrame && this.vectorC.dot(frame.up) < 0) this.vectorC.negate();
        const weight = validWeight(sample.weight);
        this.vectorB.addScaledVector(this.vectorC, weight);
        normalWeight += weight;
      }
      frame.usedContactNormals = normalWeight > EPSILON;
    }

    if (normalWeight <= EPSILON || this.vectorB.lengthSq() <= EPSILON * EPSILON) {
      if (this.findGeometryNormal(samples, this.vectorB)) {
        frame.usedGeometryNormal = true;
      } else if (hadFrame) {
        this.vectorB.copy(frame.up);
      } else {
        this.root.getWorldQuaternion(this.quaternionA);
        this.vectorB.copy(this.modelUp).applyQuaternion(this.quaternionA);
      }
    }
    this.vectorB.normalize();

    const referenceUp = hadFrame ? frame.up : this.vectorC.copy(this.result.bodyUp);
    if (this.vectorB.dot(referenceUp) < 0) this.vectorB.negate();
    if (hints.flipUp) this.vectorB.negate();

    if (isFiniteVector(hints.forward)) {
      this.vectorC.copy(hints.forward as THREE.Vector3);
    } else if (hadFrame) {
      this.vectorC.copy(frame.forward);
    } else {
      this.root.getWorldQuaternion(this.quaternionA);
      this.vectorC.copy(this.modelForward).applyQuaternion(this.quaternionA);
    }
    this.vectorC.addScaledVector(this.vectorB, -this.vectorC.dot(this.vectorB));

    if (this.vectorC.lengthSq() <= EPSILON * EPSILON) {
      this.findLongestSupportDirection(samples, this.vectorC);
      this.vectorC.addScaledVector(this.vectorB, -this.vectorC.dot(this.vectorB));
    }
    if (this.vectorC.lengthSq() <= EPSILON * EPSILON) {
      chooseLeastAlignedAxis(this.vectorB, this.vectorC);
      this.vectorC.addScaledVector(this.vectorB, -this.vectorC.dot(this.vectorB));
    }
    this.vectorC.normalize();
    if (hadFrame && this.vectorC.dot(frame.forward) < 0) this.vectorC.negate();

    this.vectorD.crossVectors(this.vectorC, this.vectorB).normalize();
    this.vectorB.crossVectors(this.vectorD, this.vectorC).normalize();

    if (!isFiniteVector(this.vectorA) || !isFiniteVector(this.vectorB) || !isFiniteVector(this.vectorC)) {
      frame.held = frame.valid;
      this.updateResultFrameState('Support data became non-finite; holding the last valid frame.');
      return frame;
    }

    frame.center.copy(this.vectorA);
    frame.forward.copy(this.vectorC);
    frame.up.copy(this.vectorB);
    frame.right.copy(this.vectorD);
    frame.valid = true;
    frame.held = false;
    this.updateResultFrameState(`Support frame updated from ${supportCount} contact(s).`);
    return frame;
  }

  apply(controls: SpiderBodyPoseControls = {}): SpiderBodyPoseResult {
    const frame = this.frame;
    const result = this.result;
    if (!frame.valid) {
      result.applied = false;
      result.frameValid = false;
      result.message = 'Cannot apply body pose before a valid support frame exists.';
      return result;
    }

    const pitch = finiteOr(controls.pitch, 0);
    const yaw = finiteOr(controls.yaw, 0);
    const roll = finiteOr(controls.roll, 0) + (controls.upsideDown ? Math.PI : 0);
    const height = finiteOr(controls.thoraxHeight, 0);

    const worldFrame = controls.worldFrame;
    if (worldFrame && isFiniteVector(worldFrame.forward) && isFiniteVector(worldFrame.up)) {
      this.vectorB.copy(worldFrame.forward as THREE.Vector3);
      this.vectorC.copy(worldFrame.up as THREE.Vector3);
      orthonormalizeForwardUp(this.vectorB, this.vectorC, this.vectorD);
      this.matrixA.makeBasis(
        this.vectorD,
        this.vectorC,
        this.vectorA.copy(this.vectorB).negate(),
      );
    } else {
      this.matrixA.makeBasis(
        frame.right,
        frame.up,
        this.vectorA.copy(frame.forward).negate(),
      );
    }
    this.quaternionA.setFromRotationMatrix(this.matrixA).multiply(this.modelBasisInverse);

    this.quaternionB.setFromAxisAngle(this.modelUp, yaw);
    this.quaternionC.setFromAxisAngle(this.modelRight, pitch);
    this.quaternionD.setFromAxisAngle(this.modelForward, roll);
    this.quaternionB.multiply(this.quaternionC).multiply(this.quaternionD);
    this.quaternionA.multiply(this.quaternionB).normalize();

    if (!isFiniteQuaternion(this.quaternionA)) {
      result.applied = false;
      result.message = 'Body orientation was non-finite; the previous transform was retained.';
      return result;
    }

    this.vectorA.copy(frame.center).addScaledVector(frame.up, height);
    if (isFiniteVector(controls.supportOffset)) {
      const offset = controls.supportOffset as SpiderBodyVector;
      this.vectorA.addScaledVector(frame.right, offset.x);
      this.vectorA.addScaledVector(frame.up, offset.y);
      this.vectorA.addScaledVector(frame.forward, offset.z);
    }
    if (isFiniteVector(controls.worldOffset)) {
      this.vectorA.add(controls.worldOffset as THREE.Vector3);
    }
    if (!isFiniteVector(this.vectorA)) {
      result.applied = false;
      result.message = 'Body position was non-finite; the previous transform was retained.';
      return result;
    }

    this.setRootWorldQuaternion(this.quaternionA);
    this.setRootWorldPosition(this.vectorA);
    this.root.updateWorldMatrix(true, true);

    if (this.anchor !== this.root) {
      this.anchor.getWorldPosition(this.vectorB);
      this.root.getWorldPosition(this.vectorC);
      this.vectorC.add(this.vectorA).sub(this.vectorB);
      this.setRootWorldPosition(this.vectorC);
      this.root.updateWorldMatrix(true, true);
    }

    this.root.getWorldPosition(result.rootWorldPosition);
    this.anchor.getWorldPosition(result.anchorWorldPosition);
    result.bodyForward.copy(this.modelForward).applyQuaternion(this.quaternionA).normalize();
    result.bodyUp.copy(this.modelUp).applyQuaternion(this.quaternionA).normalize();
    result.bodyRight.crossVectors(result.bodyForward, result.bodyUp).normalize();
    result.bodyUp.crossVectors(result.bodyRight, result.bodyForward).normalize();

    const parent = this.root.parent;
    if (parent) parent.getWorldScale(this.worldScale);
    else this.worldScale.set(1, 1, 1);
    const minimumScale = Math.min(
      Math.abs(this.worldScale.x),
      Math.abs(this.worldScale.y),
      Math.abs(this.worldScale.z),
    );
    const maximumScale = Math.max(
      Math.abs(this.worldScale.x),
      Math.abs(this.worldScale.y),
      Math.abs(this.worldScale.z),
    );
    result.nonUniformParentScale =
      minimumScale <= EPSILON || maximumScale / minimumScale > 1.001;
    result.applied = true;
    result.frameValid = true;
    result.heldFrame = frame.held;
    result.supportCount = frame.supportCount;
    result.message = result.nonUniformParentScale
      ? 'Pose applied; non-uniform parent scale may skew the rig.'
      : `Pose applied from ${frame.supportCount} support(s).`;
    return result;
  }

  private updateResultFrameState(message: string): void {
    this.result.frameValid = this.frame.valid;
    this.result.heldFrame = this.frame.held;
    this.result.supportCount = this.frame.supportCount;
    this.result.message = message;
  }

  private findGeometryNormal(
    samples: readonly SpiderSupportSample[],
    target: THREE.Vector3,
  ): boolean {
    let bestAreaSq = 0;
    target.set(0, 0, 0);

    for (let i = 0; i < samples.length - 2; i += 1) {
      const a = samples[i];
      if (!isValidSample(a)) continue;
      for (let j = i + 1; j < samples.length - 1; j += 1) {
        const b = samples[j];
        if (!isValidSample(b)) continue;
        this.vectorC.set(
          b.worldPosition.x - a.worldPosition.x,
          b.worldPosition.y - a.worldPosition.y,
          b.worldPosition.z - a.worldPosition.z,
        );
        for (let k = j + 1; k < samples.length; k += 1) {
          const c = samples[k];
          if (!isValidSample(c)) continue;
          this.vectorD.set(
            c.worldPosition.x - a.worldPosition.x,
            c.worldPosition.y - a.worldPosition.y,
            c.worldPosition.z - a.worldPosition.z,
          );
          this.vectorE.crossVectors(this.vectorC, this.vectorD);
          const areaSq = this.vectorE.lengthSq();
          if (areaSq > bestAreaSq) {
            bestAreaSq = areaSq;
            target.copy(this.vectorE);
          }
        }
      }
    }
    return bestAreaSq > EPSILON * EPSILON;
  }

  private findLongestSupportDirection(
    samples: readonly SpiderSupportSample[],
    target: THREE.Vector3,
  ): void {
    let bestDistanceSq = 0;
    target.set(0, 0, 0);
    for (let i = 0; i < samples.length - 1; i += 1) {
      const a = samples[i];
      if (!isValidSample(a)) continue;
      for (let j = i + 1; j < samples.length; j += 1) {
        const b = samples[j];
        if (!isValidSample(b)) continue;
        this.vectorD.set(
          b.worldPosition.x - a.worldPosition.x,
          b.worldPosition.y - a.worldPosition.y,
          b.worldPosition.z - a.worldPosition.z,
        );
        const distanceSq = this.vectorD.lengthSq();
        if (distanceSq > bestDistanceSq) {
          bestDistanceSq = distanceSq;
          target.copy(this.vectorD);
        }
      }
    }
  }

  private setRootWorldQuaternion(worldQuaternion: THREE.Quaternion): void {
    const parent = this.root.parent;
    if (!parent) {
      this.root.quaternion.copy(worldQuaternion);
      return;
    }
    parent.getWorldQuaternion(this.quaternionB).invert();
    this.root.quaternion.copy(this.quaternionB.multiply(worldQuaternion)).normalize();
  }

  private setRootWorldPosition(worldPosition: THREE.Vector3): void {
    const parent = this.root.parent;
    if (!parent) {
      this.root.position.copy(worldPosition);
      return;
    }
    parent.updateWorldMatrix(true, false);
    this.vectorE.copy(worldPosition);
    parent.worldToLocal(this.vectorE);
    this.root.position.copy(this.vectorE);
  }
}

function isDescendantOf(candidate: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = candidate;
  while (current) {
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function orthonormalizeForwardUp(
  forward: THREE.Vector3,
  up: THREE.Vector3,
  right: THREE.Vector3,
): void {
  if (!isFiniteVector(forward) || forward.lengthSq() <= EPSILON * EPSILON) {
    throw new Error('Spider model forward axis must be finite and non-zero.');
  }
  if (!isFiniteVector(up) || up.lengthSq() <= EPSILON * EPSILON) {
    throw new Error('Spider model up axis must be finite and non-zero.');
  }
  forward.normalize();
  up.addScaledVector(forward, -up.dot(forward));
  if (up.lengthSq() <= EPSILON * EPSILON) {
    throw new Error('Spider model forward and up axes must not be parallel.');
  }
  up.normalize();
  right.crossVectors(forward, up).normalize();
  up.crossVectors(right, forward).normalize();
}

function isValidSample(sample: SpiderSupportSample): boolean {
  return sample.valid !== false && isFiniteVector(sample.worldPosition);
}

function validWeight(weight: number | undefined): number {
  return Number.isFinite(weight) && (weight as number) > 0 ? (weight as number) : 1;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? (value as number) : fallback;
}

function isFiniteVector(vector: SpiderBodyVector | undefined): vector is SpiderBodyVector {
  return Boolean(
    vector &&
      Number.isFinite(vector.x) &&
      Number.isFinite(vector.y) &&
      Number.isFinite(vector.z),
  );
}

function isFiniteQuaternion(quaternion: THREE.Quaternion): boolean {
  return (
    Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)
  );
}

function chooseLeastAlignedAxis(direction: THREE.Vector3, target: THREE.Vector3): void {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax <= ay && ax <= az) target.set(1, 0, 0);
  else if (ay <= az) target.set(0, 1, 0);
  else target.set(0, 0, 1);
}
