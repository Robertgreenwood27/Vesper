import type { ContactFrame, MutableVec3, Vec3Like } from "../../traversal/index";

const EPSILON = 1e-10;

export interface MutableQuaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface FootOrientationAxes {
  /** Local foot axis that should lie along the strand. */
  readonly localAlongAxis: Vec3Like;
  /** Local foot axis that should follow the selected contact-frame reference. */
  readonly localReferenceAxis: Vec3Like;
}

export interface FootOrientationPolicyConfig {
  readonly referenceDirection?: "normal" | "binormal";
  readonly tangentSign?: 1 | -1;
  readonly referenceSign?: 1 | -1;
  /** Per resolve call; defaults to PI/2 so a single bad frame cannot flip a foot. */
  readonly maximumAngularStepRadians?: number;
}

export type FootOrientationFailureReason =
  | "none"
  | "non-finite-frame"
  | "degenerate-tangent"
  | "degenerate-reference"
  | "non-finite-quaternion";

export interface FootOrientationResult {
  valid: boolean;
  failureReason: FootOrientationFailureReason;
  readonly quaternion: MutableQuaternion;
  readonly targetQuaternion: MutableQuaternion;
  readonly resolvedAlong: MutableVec3;
  readonly resolvedReference: MutableVec3;
  readonly resolvedSide: MutableVec3;
  tangentSignFlippedForContinuity: boolean;
  referenceSignFlippedForContinuity: boolean;
  targetAngularDeltaRadians: number;
  appliedAngularDeltaRadians: number;
}

function vector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function quaternion(): MutableQuaternion {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteQuaternion(value: MutableQuaternion): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w)
  );
}

function copyVector(target: MutableVec3, source: Vec3Like): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function copyQuaternion(target: MutableQuaternion, source: MutableQuaternion): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
  target.w = source.w;
}

function dotVector(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalizeVector(target: MutableVec3): boolean {
  const length = Math.hypot(target.x, target.y, target.z);
  if (!Number.isFinite(length) || length <= EPSILON) {
    target.x = 0;
    target.y = 0;
    target.z = 0;
    return false;
  }
  target.x /= length;
  target.y /= length;
  target.z /= length;
  return true;
}

function projectPerpendicular(target: MutableVec3, normal: Vec3Like): boolean {
  const projection = dotVector(target, normal);
  target.x -= normal.x * projection;
  target.y -= normal.y * projection;
  target.z -= normal.z * projection;
  return normalizeVector(target);
}

function cross(target: MutableVec3, a: Vec3Like, b: Vec3Like): void {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  target.x = x;
  target.y = y;
  target.z = z;
}

function normalizeQuaternion(target: MutableQuaternion): boolean {
  const length = Math.hypot(target.x, target.y, target.z, target.w);
  if (!Number.isFinite(length) || length <= EPSILON) {
    target.x = 0;
    target.y = 0;
    target.z = 0;
    target.w = 1;
    return false;
  }
  target.x /= length;
  target.y /= length;
  target.z /= length;
  target.w /= length;
  return true;
}

function multiplyQuaternion(
  target: MutableQuaternion,
  left: MutableQuaternion,
  right: MutableQuaternion,
): void {
  const x =
    left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y;
  const y =
    left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x;
  const z =
    left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w;
  const w =
    left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z;
  target.x = x;
  target.y = y;
  target.z = z;
  target.w = w;
}

function applyQuaternion(
  target: MutableVec3,
  value: Vec3Like,
  rotation: MutableQuaternion,
): void {
  const ix = rotation.w * value.x + rotation.y * value.z - rotation.z * value.y;
  const iy = rotation.w * value.y + rotation.z * value.x - rotation.x * value.z;
  const iz = rotation.w * value.z + rotation.x * value.y - rotation.y * value.x;
  const iw = -rotation.x * value.x - rotation.y * value.y - rotation.z * value.z;
  target.x =
    ix * rotation.w + iw * -rotation.x + iy * -rotation.z - iz * -rotation.y;
  target.y =
    iy * rotation.w + iw * -rotation.y + iz * -rotation.x - ix * -rotation.z;
  target.z =
    iz * rotation.w + iw * -rotation.z + ix * -rotation.y - iy * -rotation.x;
}

function perpendicular(target: MutableVec3, direction: Vec3Like): void {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax <= ay && ax <= az) {
    target.x = 0;
    target.y = -direction.z;
    target.z = direction.y;
  } else if (ay <= az) {
    target.x = -direction.z;
    target.y = 0;
    target.z = direction.x;
  } else {
    target.x = -direction.y;
    target.y = direction.x;
    target.z = 0;
  }
  normalizeVector(target);
}

function fromUnitVectors(
  target: MutableQuaternion,
  from: Vec3Like,
  to: Vec3Like,
  axisScratch: MutableVec3,
): void {
  const cosinePlusOne = dotVector(from, to) + 1;
  if (cosinePlusOne < 1e-8) {
    perpendicular(axisScratch, from);
    target.x = axisScratch.x;
    target.y = axisScratch.y;
    target.z = axisScratch.z;
    target.w = 0;
  } else {
    cross(axisScratch, from, to);
    target.x = axisScratch.x;
    target.y = axisScratch.y;
    target.z = axisScratch.z;
    target.w = cosinePlusOne;
    normalizeQuaternion(target);
  }
}

function setAxisAngle(
  target: MutableQuaternion,
  unitAxis: Vec3Like,
  angle: number,
): void {
  const half = angle * 0.5;
  const sine = Math.sin(half);
  target.x = unitAxis.x * sine;
  target.y = unitAxis.y * sine;
  target.z = unitAxis.z * sine;
  target.w = Math.cos(half);
}

function quaternionDot(a: MutableQuaternion, b: MutableQuaternion): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function quaternionAngle(a: MutableQuaternion, b: MutableQuaternion): number {
  return 2 * Math.acos(Math.max(-1, Math.min(1, Math.abs(quaternionDot(a, b)))));
}

function slerpShortest(
  target: MutableQuaternion,
  from: MutableQuaternion,
  to: MutableQuaternion,
  amount: number,
): void {
  let toX = to.x;
  let toY = to.y;
  let toZ = to.z;
  let toW = to.w;
  let cosine = quaternionDot(from, to);
  if (cosine < 0) {
    cosine = -cosine;
    toX = -toX;
    toY = -toY;
    toZ = -toZ;
    toW = -toW;
  }
  if (cosine > 0.9995) {
    target.x = from.x + (toX - from.x) * amount;
    target.y = from.y + (toY - from.y) * amount;
    target.z = from.z + (toZ - from.z) * amount;
    target.w = from.w + (toW - from.w) * amount;
    normalizeQuaternion(target);
    return;
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const inverseSine = 1 / Math.sin(angle);
  const fromWeight = Math.sin((1 - amount) * angle) * inverseSine;
  const toWeight = Math.sin(amount * angle) * inverseSine;
  target.x = from.x * fromWeight + toX * toWeight;
  target.y = from.y * fromWeight + toY * toWeight;
  target.z = from.z * fromWeight + toZ * toWeight;
  target.w = from.w * fromWeight + toW * toWeight;
  normalizeQuaternion(target);
}

/**
 * Orientation-only contact policy. It never changes the IK target position.
 * One instance should be retained per foot to preserve tangent/reference signs.
 */
export class FootOrientationPolicy {
  readonly result: FootOrientationResult = {
    valid: false,
    failureReason: "none",
    quaternion: quaternion(),
    targetQuaternion: quaternion(),
    resolvedAlong: vector(),
    resolvedReference: vector(),
    resolvedSide: vector(),
    tangentSignFlippedForContinuity: false,
    referenceSignFlippedForContinuity: false,
    targetAngularDeltaRadians: 0,
    appliedAngularDeltaRadians: 0,
  };

  private readonly localAlong = vector();
  private readonly localReference = vector();
  private readonly desiredAlong = vector();
  private readonly desiredReference = vector();
  private readonly rotatedReference = vector();
  private readonly scratchVector = vector();
  private readonly alignQuaternion = quaternion();
  private readonly twistQuaternion = quaternion();
  private readonly previousQuaternion = quaternion();
  private readonly previousAlong = vector();
  private readonly previousReference = vector();
  private initialized = false;
  private readonly referenceDirection: "normal" | "binormal";
  private readonly tangentSign: 1 | -1;
  private readonly referenceSign: 1 | -1;
  private readonly maximumAngularStepRadians: number;

  constructor(axes: FootOrientationAxes, config: FootOrientationPolicyConfig = {}) {
    if (!finiteVector(axes.localAlongAxis) || !finiteVector(axes.localReferenceAxis)) {
      throw new Error("Foot orientation local axes must be finite.");
    }
    copyVector(this.localAlong, axes.localAlongAxis);
    if (!normalizeVector(this.localAlong)) {
      throw new Error("Foot orientation local along axis cannot be zero.");
    }
    copyVector(this.localReference, axes.localReferenceAxis);
    if (!projectPerpendicular(this.localReference, this.localAlong)) {
      throw new Error("Foot orientation local reference axis must differ from along axis.");
    }
    this.referenceDirection = config.referenceDirection ?? "normal";
    this.tangentSign = config.tangentSign ?? 1;
    this.referenceSign = config.referenceSign ?? 1;
    const maximumStep = config.maximumAngularStepRadians ?? Math.PI / 2;
    if (!Number.isFinite(maximumStep) || maximumStep <= 0 || maximumStep >= Math.PI) {
      throw new Error("Foot orientation maximum angular step must be in (0, PI).");
    }
    this.maximumAngularStepRadians = maximumStep;
  }

  reset(): void {
    this.initialized = false;
    this.result.valid = false;
    this.result.failureReason = "none";
    this.result.quaternion.x = 0;
    this.result.quaternion.y = 0;
    this.result.quaternion.z = 0;
    this.result.quaternion.w = 1;
    copyQuaternion(this.result.targetQuaternion, this.result.quaternion);
  }

  /**
   * Seeds continuity from the foot tip's current world orientation.
   *
   * Call this when a foot starts moving, before the first `resolve`. The seeded
   * orientation is treated as the previous result, so the first contact-frame
   * target is subject to `maximumAngularStepRadians` instead of snapping to it.
   * `reset` restores the original unseeded behavior for fixture/rig resets.
   */
  seedWorldOrientation(worldOrientation: Readonly<MutableQuaternion>): boolean {
    if (!finiteQuaternion(worldOrientation)) {
      this.reset();
      return false;
    }

    copyQuaternion(this.previousQuaternion, worldOrientation);
    if (!normalizeQuaternion(this.previousQuaternion)) {
      this.reset();
      return false;
    }

    applyQuaternion(this.previousAlong, this.localAlong, this.previousQuaternion);
    applyQuaternion(
      this.previousReference,
      this.localReference,
      this.previousQuaternion,
    );
    if (
      !normalizeVector(this.previousAlong) ||
      !projectPerpendicular(this.previousReference, this.previousAlong)
    ) {
      this.reset();
      return false;
    }

    copyQuaternion(this.result.quaternion, this.previousQuaternion);
    copyQuaternion(this.result.targetQuaternion, this.previousQuaternion);
    copyVector(this.result.resolvedAlong, this.previousAlong);
    copyVector(this.result.resolvedReference, this.previousReference);
    cross(
      this.result.resolvedSide,
      this.result.resolvedAlong,
      this.result.resolvedReference,
    );
    normalizeVector(this.result.resolvedSide);
    this.result.valid = false;
    this.result.failureReason = "none";
    this.result.tangentSignFlippedForContinuity = false;
    this.result.referenceSignFlippedForContinuity = false;
    this.result.targetAngularDeltaRadians = 0;
    this.result.appliedAngularDeltaRadians = 0;
    this.initialized = true;
    return true;
  }

  resolve(frame: ContactFrame): FootOrientationResult {
    const result = this.result;
    result.tangentSignFlippedForContinuity = false;
    result.referenceSignFlippedForContinuity = false;
    result.targetAngularDeltaRadians = 0;
    result.appliedAngularDeltaRadians = 0;
    if (!finiteVector(frame.tangent) || !finiteVector(frame.normal) || !finiteVector(frame.binormal)) {
      return this.fail("non-finite-frame");
    }

    copyVector(this.desiredAlong, frame.tangent);
    this.desiredAlong.x *= this.tangentSign;
    this.desiredAlong.y *= this.tangentSign;
    this.desiredAlong.z *= this.tangentSign;
    if (!normalizeVector(this.desiredAlong)) {
      return this.fail("degenerate-tangent");
    }

    copyVector(
      this.desiredReference,
      this.referenceDirection === "normal" ? frame.normal : frame.binormal,
    );
    this.desiredReference.x *= this.referenceSign;
    this.desiredReference.y *= this.referenceSign;
    this.desiredReference.z *= this.referenceSign;
    if (!projectPerpendicular(this.desiredReference, this.desiredAlong)) {
      copyVector(
        this.desiredReference,
        this.referenceDirection === "normal" ? frame.binormal : frame.normal,
      );
      if (!projectPerpendicular(this.desiredReference, this.desiredAlong)) {
        return this.fail("degenerate-reference");
      }
    }

    if (this.initialized && dotVector(this.desiredAlong, this.previousAlong) < 0) {
      this.desiredAlong.x *= -1;
      this.desiredAlong.y *= -1;
      this.desiredAlong.z *= -1;
      result.tangentSignFlippedForContinuity = true;
    }
    if (this.initialized && dotVector(this.desiredReference, this.previousReference) < 0) {
      this.desiredReference.x *= -1;
      this.desiredReference.y *= -1;
      this.desiredReference.z *= -1;
      result.referenceSignFlippedForContinuity = true;
    }

    cross(result.resolvedSide, this.desiredAlong, this.desiredReference);
    if (!normalizeVector(result.resolvedSide)) {
      return this.fail("degenerate-reference");
    }
    cross(this.desiredReference, result.resolvedSide, this.desiredAlong);
    normalizeVector(this.desiredReference);

    fromUnitVectors(
      this.alignQuaternion,
      this.localAlong,
      this.desiredAlong,
      this.scratchVector,
    );
    applyQuaternion(this.rotatedReference, this.localReference, this.alignQuaternion);
    projectPerpendicular(this.rotatedReference, this.desiredAlong);
    cross(this.scratchVector, this.rotatedReference, this.desiredReference);
    const sine = dotVector(this.scratchVector, this.desiredAlong);
    const cosine = Math.max(-1, Math.min(1, dotVector(this.rotatedReference, this.desiredReference)));
    setAxisAngle(this.twistQuaternion, this.desiredAlong, Math.atan2(sine, cosine));
    multiplyQuaternion(
      result.targetQuaternion,
      this.twistQuaternion,
      this.alignQuaternion,
    );
    if (!normalizeQuaternion(result.targetQuaternion) || !finiteQuaternion(result.targetQuaternion)) {
      return this.fail("non-finite-quaternion");
    }

    if (!this.initialized) {
      copyQuaternion(result.quaternion, result.targetQuaternion);
    } else {
      if (quaternionDot(result.targetQuaternion, this.previousQuaternion) < 0) {
        result.targetQuaternion.x *= -1;
        result.targetQuaternion.y *= -1;
        result.targetQuaternion.z *= -1;
        result.targetQuaternion.w *= -1;
      }
      result.targetAngularDeltaRadians = quaternionAngle(
        this.previousQuaternion,
        result.targetQuaternion,
      );
      if (result.targetAngularDeltaRadians > this.maximumAngularStepRadians) {
        slerpShortest(
          result.quaternion,
          this.previousQuaternion,
          result.targetQuaternion,
          this.maximumAngularStepRadians / result.targetAngularDeltaRadians,
        );
      } else {
        copyQuaternion(result.quaternion, result.targetQuaternion);
      }
      result.appliedAngularDeltaRadians = quaternionAngle(
        this.previousQuaternion,
        result.quaternion,
      );
    }

    if (!finiteQuaternion(result.quaternion)) {
      return this.fail("non-finite-quaternion");
    }
    applyQuaternion(result.resolvedAlong, this.localAlong, result.quaternion);
    applyQuaternion(result.resolvedReference, this.localReference, result.quaternion);
    normalizeVector(result.resolvedAlong);
    projectPerpendicular(result.resolvedReference, result.resolvedAlong);
    cross(result.resolvedSide, result.resolvedAlong, result.resolvedReference);
    normalizeVector(result.resolvedSide);

    copyQuaternion(this.previousQuaternion, result.quaternion);
    copyVector(this.previousAlong, result.resolvedAlong);
    copyVector(this.previousReference, result.resolvedReference);
    this.initialized = true;
    result.valid = true;
    result.failureReason = "none";
    return result;
  }

  private fail(reason: FootOrientationFailureReason): FootOrientationResult {
    this.result.valid = false;
    this.result.failureReason = reason;
    return this.result;
  }
}
