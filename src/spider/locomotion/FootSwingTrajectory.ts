import type { MutableVec3, Vec3Like } from "../../traversal/index";

const EPSILON = 1e-10;

export interface FootSwingSupportFrame {
  /** Local support-up. Lift follows this axis even when the spider is inverted. */
  readonly up: Vec3Like;
  /** Local travel reference, projected onto the support plane before use. */
  readonly forward: Vec3Like;
}

export interface FootSwingTrajectoryConfig {
  readonly durationSeconds: number;
  /** Clearance above the straight start/end chord along support-frame up. */
  readonly liftDistance: number;
  /** Extra departure bias toward the destination in the support plane. */
  readonly forwardDistance: number;
  /** Pulls the second control point back for a deliberate final approach. */
  readonly approachDistance: number;
  /** Relative lift retained by the approach control point. Defaults to 0.55. */
  readonly descentLiftRatio?: number;
}

export interface FootSwingSample {
  readonly position: MutableVec3;
  readonly velocity: MutableVec3;
  normalizedTime: number;
  curveParameter: number;
  complete: boolean;
}

function vector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function copy(target: MutableVec3, source: Vec3Like): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function normalize(target: MutableVec3): boolean {
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

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/** Quintic time warp gives zero velocity and acceleration at both endpoints. */
function smootherStep(value: number): number {
  return value * value * value * (value * (value * 6 - 15) + 10);
}

function smootherStepDerivative(value: number): number {
  const oneMinus = 1 - value;
  return 30 * value * value * oneMinus * oneMinus;
}

export function createFootSwingSample(): FootSwingSample {
  return {
    position: vector(),
    velocity: vector(),
    normalizedTime: 0,
    curveParameter: 0,
    complete: false,
  };
}

/**
 * Reusable cubic Bezier swing in an explicit local support frame.
 *
 * Geometry is cubic; time is eased independently so a stationary planted foot
 * enters and leaves the swing with zero endpoint velocity/acceleration. No
 * world-up assumption appears in the construction.
 */
export class FootSwingTrajectory {
  readonly start = vector();
  readonly departureControl = vector();
  readonly approachControl = vector();
  readonly end = vector();
  readonly supportUp = vector();
  readonly travelForward = vector();

  durationSeconds = 0;
  configured = false;

  private readonly travelScratch = vector();
  private readonly frameForwardScratch = vector();

  plan(
    start: Vec3Like,
    end: Vec3Like,
    supportFrame: FootSwingSupportFrame,
    config: FootSwingTrajectoryConfig,
  ): this {
    if (!finiteVector(start) || !finiteVector(end)) {
      throw new Error("Foot swing endpoints must be finite.");
    }
    if (!finiteVector(supportFrame.up) || !finiteVector(supportFrame.forward)) {
      throw new Error("Foot swing support-frame axes must be finite.");
    }
    if (!Number.isFinite(config.durationSeconds) || config.durationSeconds <= 0) {
      throw new Error("Foot swing duration must be finite and positive.");
    }
    for (const [label, value] of [
      ["lift", config.liftDistance],
      ["forward", config.forwardDistance],
      ["approach", config.approachDistance],
    ] as const) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(`Foot swing ${label} distance must be finite and non-negative.`);
      }
    }
    const descentLiftRatio = config.descentLiftRatio ?? 0.55;
    if (
      !Number.isFinite(descentLiftRatio) ||
      descentLiftRatio < 0 ||
      descentLiftRatio > 1
    ) {
      throw new Error("Foot swing descent lift ratio must be between zero and one.");
    }

    copy(this.start, start);
    copy(this.end, end);
    copy(this.supportUp, supportFrame.up);
    if (!normalize(this.supportUp)) {
      throw new Error("Foot swing support up cannot be zero.");
    }

    copy(this.frameForwardScratch, supportFrame.forward);
    const frameForwardUp =
      this.frameForwardScratch.x * this.supportUp.x +
      this.frameForwardScratch.y * this.supportUp.y +
      this.frameForwardScratch.z * this.supportUp.z;
    this.frameForwardScratch.x -= this.supportUp.x * frameForwardUp;
    this.frameForwardScratch.y -= this.supportUp.y * frameForwardUp;
    this.frameForwardScratch.z -= this.supportUp.z * frameForwardUp;
    if (!normalize(this.frameForwardScratch)) {
      throw new Error("Foot swing support forward cannot be parallel to support up.");
    }

    this.travelScratch.x = end.x - start.x;
    this.travelScratch.y = end.y - start.y;
    this.travelScratch.z = end.z - start.z;
    const verticalTravel =
      this.travelScratch.x * this.supportUp.x +
      this.travelScratch.y * this.supportUp.y +
      this.travelScratch.z * this.supportUp.z;
    this.travelForward.x = this.travelScratch.x - this.supportUp.x * verticalTravel;
    this.travelForward.y = this.travelScratch.y - this.supportUp.y * verticalTravel;
    this.travelForward.z = this.travelScratch.z - this.supportUp.z * verticalTravel;

    if (!normalize(this.travelForward)) {
      copy(this.travelForward, this.frameForwardScratch);
    }

    // The two lift offsets are chosen so their cubic weights produce exactly
    // liftDistance above the straight chord at u=0.5.
    const departureLift = config.liftDistance / (0.375 * (1 + descentLiftRatio));
    const approachLift = departureLift * descentLiftRatio;
    this.departureControl.x =
      start.x + (end.x - start.x) / 3 +
      this.travelForward.x * config.forwardDistance +
      this.supportUp.x * departureLift;
    this.departureControl.y =
      start.y + (end.y - start.y) / 3 +
      this.travelForward.y * config.forwardDistance +
      this.supportUp.y * departureLift;
    this.departureControl.z =
      start.z + (end.z - start.z) / 3 +
      this.travelForward.z * config.forwardDistance +
      this.supportUp.z * departureLift;
    this.approachControl.x =
      start.x + ((end.x - start.x) * 2) / 3 -
      this.travelForward.x * config.approachDistance +
      this.supportUp.x * approachLift;
    this.approachControl.y =
      start.y + ((end.y - start.y) * 2) / 3 -
      this.travelForward.y * config.approachDistance +
      this.supportUp.y * approachLift;
    this.approachControl.z =
      start.z + ((end.z - start.z) * 2) / 3 -
      this.travelForward.z * config.approachDistance +
      this.supportUp.z * approachLift;

    this.durationSeconds = config.durationSeconds;
    this.configured = true;
    return this;
  }

  sampleAtTime(
    elapsedSeconds: number,
    out: FootSwingSample = createFootSwingSample(),
  ): FootSwingSample {
    if (!Number.isFinite(elapsedSeconds)) {
      throw new Error("Foot swing elapsed time must be finite.");
    }
    this.requirePlan();
    return this.sampleNormalized(elapsedSeconds / this.durationSeconds, out);
  }

  sampleNormalized(
    normalizedTime: number,
    out: FootSwingSample = createFootSwingSample(),
  ): FootSwingSample {
    if (!Number.isFinite(normalizedTime)) {
      throw new Error("Foot swing normalized time must be finite.");
    }
    this.requirePlan();
    const time = clamp01(normalizedTime);
    const curve = smootherStep(time);
    const inverse = 1 - curve;
    const inverseSquared = inverse * inverse;
    const curveSquared = curve * curve;
    const b0 = inverseSquared * inverse;
    const b1 = 3 * inverseSquared * curve;
    const b2 = 3 * inverse * curveSquared;
    const b3 = curveSquared * curve;
    out.position.x =
      this.start.x * b0 +
      this.departureControl.x * b1 +
      this.approachControl.x * b2 +
      this.end.x * b3;
    out.position.y =
      this.start.y * b0 +
      this.departureControl.y * b1 +
      this.approachControl.y * b2 +
      this.end.y * b3;
    out.position.z =
      this.start.z * b0 +
      this.departureControl.z * b1 +
      this.approachControl.z * b2 +
      this.end.z * b3;

    const derivativeScale = smootherStepDerivative(time) / this.durationSeconds;
    const d0 = 3 * inverseSquared;
    const d1 = 6 * inverse * curve;
    const d2 = 3 * curveSquared;
    out.velocity.x =
      ((this.departureControl.x - this.start.x) * d0 +
        (this.approachControl.x - this.departureControl.x) * d1 +
        (this.end.x - this.approachControl.x) * d2) *
      derivativeScale;
    out.velocity.y =
      ((this.departureControl.y - this.start.y) * d0 +
        (this.approachControl.y - this.departureControl.y) * d1 +
        (this.end.y - this.approachControl.y) * d2) *
      derivativeScale;
    out.velocity.z =
      ((this.departureControl.z - this.start.z) * d0 +
        (this.approachControl.z - this.departureControl.z) * d1 +
        (this.end.z - this.approachControl.z) * d2) *
      derivativeScale;
    out.normalizedTime = time;
    out.curveParameter = curve;
    out.complete = normalizedTime >= 1;
    return out;
  }

  /** Allocating planning/debug helper; frame-loop code should reuse FootSwingSample. */
  sampleDebugCurve(sampleCount = 24): readonly MutableVec3[] {
    if (!Number.isInteger(sampleCount) || sampleCount < 2 || sampleCount > 4096) {
      throw new Error("Foot swing debug sample count must be an integer from 2 to 4096.");
    }
    this.requirePlan();
    const points: MutableVec3[] = [];
    const sample = createFootSwingSample();
    for (let index = 0; index < sampleCount; index += 1) {
      this.sampleNormalized(index / (sampleCount - 1), sample);
      points.push({ x: sample.position.x, y: sample.position.y, z: sample.position.z });
    }
    return points;
  }

  private requirePlan(): void {
    if (!this.configured) {
      throw new Error("Foot swing trajectory has not been planned.");
    }
  }
}
