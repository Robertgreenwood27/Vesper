import {
  StrandTraversal,
  createVec3,
  type MutableVec3,
  type Vec3Like,
} from "../../traversal/index";
import { DEFAULT_TRAVERSAL_POLICY_CONFIG } from "./TraversalConfig";
import type {
  BodyEnvelope,
  BodyOrientationConfig,
  BodyOrientationContact,
  BodyOrientationPlan,
  BodyOrientationPlanRequest,
  PredictedLegReach,
} from "./TraversalTypes";

const EPSILON = 1e-9;

interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

interface MutableFrame {
  position: MutableVec3;
  forward: MutableVec3;
  up: MutableVec3;
  right: MutableVec3;
}

interface ConstraintEvaluation {
  reachSafe: boolean;
  clearanceSafe: boolean;
  minimumClearance: number;
  maximumReachRatio: number;
  limitingLegId: BodyOrientationContact["legId"] | null;
}

/**
 * Proposes one gradual body-frame change while every planted contact remains
 * fixed. It owns no transform and applies no motion; callers ease the accepted
 * frame and continue to run IK/reach checks during that ease.
 */
export class BodyOrientationPlanner {
  readonly config: BodyOrientationConfig;
  readonly envelope: BodyEnvelope;

  private readonly currentFrame = mutableFrame();
  private readonly targetFrame = mutableFrame();
  private readonly limitedFrame = mutableFrame();
  private readonly candidateFrame = mutableFrame();
  private readonly currentQuaternion = quaternion();
  private readonly targetQuaternion = quaternion();
  private readonly limitedQuaternion = quaternion();
  private readonly candidateQuaternion = quaternion();
  private readonly inverseCurrentQuaternion = quaternion();
  private readonly deltaQuaternion = quaternion();
  private readonly vectorA = createVec3();
  private readonly vectorB = createVec3();
  private readonly vectorC = createVec3();
  private readonly vectorD = createVec3();
  private readonly envelopeSample = createVec3();

  constructor(
    readonly traversal: StrandTraversal,
    config: BodyOrientationConfig = DEFAULT_TRAVERSAL_POLICY_CONFIG.orientation,
  ) {
    this.config = { ...config };
    this.envelope = {
      forwardRadius: config.bodyEnvelopeRadiusForward,
      rightRadius: config.bodyEnvelopeRadiusRight,
      upRadius: config.bodyEnvelopeRadiusUp,
    };
  }

  plan(
    request: BodyOrientationPlanRequest,
    out: BodyOrientationPlan = createBodyOrientationPlan(),
  ): BodyOrientationPlan {
    resetPlan(out);
    if (
      !copyAndOrthonormalizeFrame(this.currentFrame, request.currentFrame) ||
      !finiteVector(request.routeDirection)
    ) {
      return fail(out, "invalid-current-frame", "The current support frame is invalid.");
    }
    if (!this.buildTargetFrame(request)) {
      return fail(out, "non-finite-input", "A finite route-aligned frame could not be built.");
    }

    copyFrame(out.proposedFrame, this.targetFrame);
    frameToQuaternion(this.currentFrame, this.currentQuaternion);
    frameToQuaternion(this.targetFrame, this.targetQuaternion);
    if (quaternionDot(this.currentQuaternion, this.targetQuaternion) < 0) {
      negateQuaternion(this.targetQuaternion);
    }
    out.requestedRotationRadians = quaternionAngle(
      this.currentQuaternion,
      this.targetQuaternion,
    );
    out.requestedTranslation = distance(
      this.currentFrame.position,
      this.targetFrame.position,
    );
    out.frameSignContinuous =
      dot(this.currentFrame.up, this.targetFrame.up) > -0.999 &&
      Number.isFinite(out.requestedRotationRadians);
    if (!out.frameSignContinuous) {
      return fail(out, "continuity-blocked", "The proposed frame has an ambiguous sign flip.");
    }

    const translationLimitFraction = out.requestedTranslation > EPSILON
      ? Math.min(1, this.config.maximumTranslationPerStep / out.requestedTranslation)
      : 1;
    const rotationLimitFraction = out.requestedRotationRadians > EPSILON
      ? Math.min(
          1,
          this.config.maximumRotationRadiansPerStep / out.requestedRotationRadians,
        )
      : 1;
    out.clampedByTranslationLimit = translationLimitFraction < 1 - EPSILON;
    out.clampedByRotationLimit = rotationLimitFraction < 1 - EPSILON;

    lerpVector(
      this.limitedFrame.position,
      this.currentFrame.position,
      this.targetFrame.position,
      translationLimitFraction,
    );
    slerpQuaternion(
      this.limitedQuaternion,
      this.currentQuaternion,
      this.targetQuaternion,
      rotationLimitFraction,
    );
    quaternionToFrameAxes(this.limitedQuaternion, this.limitedFrame);

    const heldCount = countValidHeldContacts(request.contacts);
    if (heldCount === 0) {
      copyFrame(out.acceptedFrame, this.currentFrame);
      return fail(out, "no-valid-support", "No valid loaded contacts can constrain body motion.");
    }

    let acceptedFraction = 1;
    let evaluation = this.evaluateConstraints(request, acceptedFraction, false, out);
    out.minimumClearance = evaluation.minimumClearance;
    out.maximumPredictedReachRatio = evaluation.maximumReachRatio;
    out.limitingLegId = evaluation.limitingLegId;
    if (!evaluation.reachSafe || !evaluation.clearanceSafe) {
      out.clampedByReach = !evaluation.reachSafe;
      out.clampedByClearance = !evaluation.clearanceSafe;
      const currentEvaluation = this.evaluateConstraints(request, 0, false, out);
      if (!currentEvaluation.reachSafe) {
        copyFrame(out.acceptedFrame, this.currentFrame);
        out.minimumClearance = currentEvaluation.minimumClearance;
        out.maximumPredictedReachRatio = currentEvaluation.maximumReachRatio;
        out.limitingLegId = currentEvaluation.limitingLegId;
        this.evaluateConstraints(request, 0, true, out);
        return fail(out, "reach-blocked", "The current held-contact pose is already outside reach limits.");
      }
      if (!currentEvaluation.clearanceSafe) {
        copyFrame(out.acceptedFrame, this.currentFrame);
        out.minimumClearance = currentEvaluation.minimumClearance;
        out.maximumPredictedReachRatio = currentEvaluation.maximumReachRatio;
        out.limitingLegId = currentEvaluation.limitingLegId;
        this.evaluateConstraints(request, 0, true, out);
        return fail(
          out,
          "clearance-blocked",
          "The current body envelope is already inside the requested silk clearance.",
        );
      }

      let low = 0;
      let high = 1;
      for (let iteration = 0; iteration < this.config.clampIterations; iteration += 1) {
        const middle = (low + high) * 0.5;
        const middleEvaluation = this.evaluateConstraints(request, middle, false, out);
        if (middleEvaluation.reachSafe && middleEvaluation.clearanceSafe) low = middle;
        else high = middle;
      }
      acceptedFraction = low;
      if (acceptedFraction < this.config.minimumAcceptedFraction) {
        copyFrame(out.acceptedFrame, this.currentFrame);
        this.evaluateConstraints(request, 0, true, out);
        return fail(
          out,
          out.clampedByReach ? "reach-blocked" : "clearance-blocked",
          "Reach or clearance constraints leave no meaningful body-frame progress.",
        );
      }
      evaluation = this.evaluateConstraints(request, acceptedFraction, false, out);
    }

    this.interpolateCandidateFrame(acceptedFraction);
    copyFrame(out.acceptedFrame, this.candidateFrame);
    out.acceptedFraction = acceptedFraction;
    out.plannedTranslation = distance(
      this.currentFrame.position,
      this.candidateFrame.position,
    );
    out.plannedRotationRadians =
      quaternionAngle(this.currentQuaternion, this.limitedQuaternion) * acceptedFraction;
    out.minimumClearance = evaluation.minimumClearance;
    out.maximumPredictedReachRatio = evaluation.maximumReachRatio;
    out.limitingLegId = evaluation.limitingLegId;
    this.evaluateConstraints(request, acceptedFraction, true, out);
    out.success = true;
    out.failureReason = "none";
    out.message = acceptedFraction < 1 - EPSILON
      ? "Body frame accepted after bounded reach/clearance clamping."
      : "Body frame accepted within reach and clearance limits.";
    return out;
  }

  private buildTargetFrame(request: BodyOrientationPlanRequest): boolean {
    const current = this.currentFrame;
    const target = this.targetFrame;
    const routeLength = length(request.routeDirection);
    if (routeLength <= EPSILON || !Number.isFinite(routeLength)) return false;
    setScaled(this.vectorA, request.routeDirection, 1 / routeLength);

    if (request.targetOrientationFrame) {
      if (
        !finiteVector(request.targetOrientationFrame.forward) ||
        !finiteVector(request.targetOrientationFrame.up)
      ) return false;
      copy(this.vectorC, request.targetOrientationFrame.forward);
      if (!normalize(this.vectorC, this.vectorC)) return false;
      projectNormal(this.vectorB, request.targetOrientationFrame.up, this.vectorC);
      if (!normalize(this.vectorB, this.vectorB)) return false;
      cross(this.vectorD, this.vectorC, this.vectorB);
      if (!normalize(this.vectorD, this.vectorD)) return false;
      cross(this.vectorB, this.vectorD, this.vectorC);
      if (!normalize(this.vectorB, this.vectorB)) return false;
    } else {
      set(this.vectorB, 0, 0, 0);
      let normalWeight = 0;
      for (const contact of request.contacts) {
        if (!contact.loaded || !contact.valid || !finiteVector(contact.referenceUp)) continue;
        const normalLength = length(contact.referenceUp);
        if (normalLength <= EPSILON) continue;
        setScaled(this.vectorC, contact.referenceUp, 1 / normalLength);
        if (dot(this.vectorC, current.up) < 0) scale(this.vectorC, -1);
        const weight = contact.destinationSide
          ? this.config.destinationSupportNormalWeight
          : 1;
        addScaled(this.vectorB, this.vectorC, weight);
        normalWeight += weight;
      }
      if (normalWeight <= EPSILON || !normalize(this.vectorB, this.vectorB)) {
        if (!this.supportGeometryNormal(request.contacts, this.vectorB)) {
          copy(this.vectorB, current.up);
        }
      }
      if (dot(this.vectorB, current.up) < 0) scale(this.vectorB, -1);

      // Geometry-normal estimation uses the shared scratch vectors; restore the
      // route direction before projecting it into the selected support plane.
      setScaled(this.vectorA, request.routeDirection, 1 / routeLength);
      projectNormal(this.vectorC, this.vectorA, this.vectorB);
      if (!normalize(this.vectorC, this.vectorC)) {
        projectNormal(this.vectorC, current.forward, this.vectorB);
        if (!normalize(this.vectorC, this.vectorC)) return false;
      }
      cross(this.vectorD, this.vectorC, this.vectorB);
      if (!normalize(this.vectorD, this.vectorD)) return false;
      cross(this.vectorB, this.vectorD, this.vectorC);
      if (!normalize(this.vectorB, this.vectorB)) return false;
    }
    copy(target.forward, this.vectorC);
    copy(target.up, this.vectorB);
    copy(target.right, this.vectorD);

    if (request.desiredBodyPosition) {
      if (!finiteVector(request.desiredBodyPosition)) return false;
      copy(target.position, request.desiredBodyPosition);
    } else {
      copy(target.position, current.position);
      addScaled(
        target.position,
        this.vectorA,
        this.config.maximumTranslationPerStep,
      );
    }
    return finiteFrame(target);
  }

  private supportGeometryNormal(
    contacts: readonly BodyOrientationContact[],
    out: MutableVec3,
  ): boolean {
    let bestAreaSquared = 0;
    set(out, 0, 0, 0);
    for (let first = 0; first < contacts.length - 2; first += 1) {
      const a = contacts[first];
      if (!a.loaded || !a.valid || !finiteVector(a.contactWorldPosition)) continue;
      for (let second = first + 1; second < contacts.length - 1; second += 1) {
        const b = contacts[second];
        if (!b.loaded || !b.valid || !finiteVector(b.contactWorldPosition)) continue;
        subtract(this.vectorC, b.contactWorldPosition, a.contactWorldPosition);
        for (let third = second + 1; third < contacts.length; third += 1) {
          const c = contacts[third];
          if (!c.loaded || !c.valid || !finiteVector(c.contactWorldPosition)) continue;
          subtract(this.vectorD, c.contactWorldPosition, a.contactWorldPosition);
          cross(this.vectorA, this.vectorC, this.vectorD);
          const areaSquared = lengthSquared(this.vectorA);
          if (areaSquared > bestAreaSquared) {
            bestAreaSquared = areaSquared;
            copy(out, this.vectorA);
          }
        }
      }
    }
    if (bestAreaSquared <= EPSILON * EPSILON) return false;
    normalize(out, out);
    if (dot(out, this.currentFrame.up) < 0) scale(out, -1);
    return true;
  }

  private evaluateConstraints(
    request: BodyOrientationPlanRequest,
    fraction: number,
    writePredictions: boolean,
    plan: BodyOrientationPlan,
  ): ConstraintEvaluation {
    this.interpolateCandidateFrame(fraction);
    invertQuaternion(this.inverseCurrentQuaternion, this.currentQuaternion);
    multiplyQuaternion(
      this.deltaQuaternion,
      this.candidateQuaternion,
      this.inverseCurrentQuaternion,
    );

    let reachSafe = true;
    let maximumReachRatio = 0;
    let limitingLegId: BodyOrientationContact["legId"] | null = null;
    if (writePredictions) plan.predictedReaches.length = 0;
    for (const contact of request.contacts) {
      if (!contact.loaded || !contact.valid) continue;
      const prediction = this.predictReach(contact);
      if (writePredictions) plan.predictedReaches.push(prediction);
      if (prediction.ratio > maximumReachRatio) {
        maximumReachRatio = prediction.ratio;
        limitingLegId = contact.legId;
      }
      if (!prediction.withinLimits) reachSafe = false;
    }

    const minimumClearance = this.queryClearance(request);
    const clearanceSafe =
      !Number.isNaN(minimumClearance) &&
      minimumClearance + EPSILON >= this.config.minimumSilkClearance;
    return {
      reachSafe,
      clearanceSafe,
      minimumClearance,
      maximumReachRatio,
      limitingLegId,
    };
  }

  private interpolateCandidateFrame(fraction: number): void {
    lerpVector(
      this.candidateFrame.position,
      this.currentFrame.position,
      this.limitedFrame.position,
      fraction,
    );
    slerpQuaternion(
      this.candidateQuaternion,
      this.currentQuaternion,
      this.limitedQuaternion,
      fraction,
    );
    quaternionToFrameAxes(this.candidateQuaternion, this.candidateFrame);
  }

  private predictReach(contact: BodyOrientationContact): PredictedLegReach {
    if (
      !finiteVector(contact.contactWorldPosition) ||
      !finiteVector(contact.reachOriginWorldPosition) ||
      !Number.isFinite(contact.maximumReach) ||
      contact.maximumReach <= 0
    ) {
      return { legId: contact.legId, distance: Infinity, ratio: Infinity, withinLimits: false };
    }
    subtract(
      this.vectorA,
      contact.reachOriginWorldPosition,
      this.currentFrame.position,
    );
    rotateVector(this.vectorB, this.vectorA, this.deltaQuaternion);
    add(this.vectorB, this.vectorB, this.candidateFrame.position);
    const reachDistance = distance(contact.contactWorldPosition, this.vectorB);
    const maximum = contact.maximumReach * this.config.maximumReachSafetyFactor;
    const minimum = Math.max(0, contact.minimumReach ?? 0) *
      this.config.minimumReachSafetyFactor;
    return {
      legId: contact.legId,
      distance: reachDistance,
      ratio: reachDistance / contact.maximumReach,
      withinLimits:
        Number.isFinite(reachDistance) &&
        reachDistance <= maximum + EPSILON &&
        reachDistance + EPSILON >= minimum,
    };
  }

  private queryClearance(request: BodyOrientationPlanRequest): number {
    if (request.clearanceQuery) {
      return request.clearanceQuery(
        this.candidateFrame.position,
        this.candidateFrame,
        this.envelope,
      );
    }

    let minimum = Infinity;
    minimum = Math.min(minimum, this.queryPointClearance(request, this.candidateFrame.position));
    minimum = Math.min(
      minimum,
      this.queryEnvelopeAxis(request, this.candidateFrame.forward, this.envelope.forwardRadius),
      this.queryEnvelopeAxis(request, this.candidateFrame.right, this.envelope.rightRadius),
      this.queryEnvelopeAxis(request, this.candidateFrame.up, this.envelope.upRadius),
    );
    return minimum;
  }

  private queryEnvelopeAxis(
    request: BodyOrientationPlanRequest,
    axis: Vec3Like,
    radius: number,
  ): number {
    copy(this.envelopeSample, this.candidateFrame.position);
    addScaled(this.envelopeSample, axis, radius);
    let minimum = this.queryPointClearance(request, this.envelopeSample);
    copy(this.envelopeSample, this.candidateFrame.position);
    addScaled(this.envelopeSample, axis, -radius);
    minimum = Math.min(minimum, this.queryPointClearance(request, this.envelopeSample));
    return minimum;
  }

  private queryPointClearance(
    request: BodyOrientationPlanRequest,
    point: Vec3Like,
  ): number {
    const closest = this.traversal.findClosestPoint(point, {
      traversableOnly: true,
      strandIds: request.clearanceStrandIds,
    });
    return closest?.distance ?? Infinity;
  }
}

export function createBodyOrientationPlan(): BodyOrientationPlan {
  return {
    success: false,
    failureReason: "none",
    message: "Not planned.",
    proposedFrame: mutableFrame(),
    acceptedFrame: mutableFrame(),
    requestedTranslation: 0,
    plannedTranslation: 0,
    requestedRotationRadians: 0,
    plannedRotationRadians: 0,
    acceptedFraction: 0,
    clampedByTranslationLimit: false,
    clampedByRotationLimit: false,
    clampedByReach: false,
    clampedByClearance: false,
    frameSignContinuous: true,
    minimumClearance: Infinity,
    maximumPredictedReachRatio: 0,
    limitingLegId: null,
    predictedReaches: [],
  };
}

function resetPlan(plan: BodyOrientationPlan): void {
  plan.success = false;
  plan.failureReason = "none";
  plan.message = "Not planned.";
  plan.requestedTranslation = 0;
  plan.plannedTranslation = 0;
  plan.requestedRotationRadians = 0;
  plan.plannedRotationRadians = 0;
  plan.acceptedFraction = 0;
  plan.clampedByTranslationLimit = false;
  plan.clampedByRotationLimit = false;
  plan.clampedByReach = false;
  plan.clampedByClearance = false;
  plan.frameSignContinuous = true;
  plan.minimumClearance = Infinity;
  plan.maximumPredictedReachRatio = 0;
  plan.limitingLegId = null;
  plan.predictedReaches.length = 0;
}

function fail(
  plan: BodyOrientationPlan,
  reason: BodyOrientationPlan["failureReason"],
  message: string,
): BodyOrientationPlan {
  plan.success = false;
  plan.failureReason = reason;
  plan.message = message;
  return plan;
}

function mutableFrame(): MutableFrame {
  return {
    position: createVec3(),
    forward: createVec3(1, 0, 0),
    up: createVec3(0, 1, 0),
    right: createVec3(0, 0, 1),
  };
}

function quaternion(): QuaternionLike {
  return { x: 0, y: 0, z: 0, w: 1 };
}

function copyAndOrthonormalizeFrame(
  out: MutableFrame,
  source: BodyOrientationPlanRequest["currentFrame"],
): boolean {
  if (
    !finiteVector(source.position) ||
    !finiteVector(source.forward) ||
    !finiteVector(source.up)
  ) return false;
  copy(out.position, source.position);
  if (!normalize(out.forward, source.forward)) return false;
  projectNormal(out.up, source.up, out.forward);
  if (!normalize(out.up, out.up)) return false;
  cross(out.right, out.forward, out.up);
  if (!normalize(out.right, out.right)) return false;
  cross(out.up, out.right, out.forward);
  return normalize(out.up, out.up) && finiteFrame(out);
}

function frameToQuaternion(frame: MutableFrame, out: QuaternionLike): void {
  // Rotation matrix columns are right, up, and back (-forward).
  const m00 = frame.right.x;
  const m01 = frame.up.x;
  const m02 = -frame.forward.x;
  const m10 = frame.right.y;
  const m11 = frame.up.y;
  const m12 = -frame.forward.y;
  const m20 = frame.right.z;
  const m21 = frame.up.z;
  const m22 = -frame.forward.z;
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    out.w = 0.25 * s;
    out.x = (m21 - m12) / s;
    out.y = (m02 - m20) / s;
    out.z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    out.w = (m21 - m12) / s;
    out.x = 0.25 * s;
    out.y = (m01 + m10) / s;
    out.z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    out.w = (m02 - m20) / s;
    out.x = (m01 + m10) / s;
    out.y = 0.25 * s;
    out.z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    out.w = (m10 - m01) / s;
    out.x = (m02 + m20) / s;
    out.y = (m12 + m21) / s;
    out.z = 0.25 * s;
  }
  normalizeQuaternion(out);
}

function quaternionToFrameAxes(quaternionValue: QuaternionLike, frame: MutableFrame): void {
  rotateVector(frame.right, { x: 1, y: 0, z: 0 }, quaternionValue);
  rotateVector(frame.up, { x: 0, y: 1, z: 0 }, quaternionValue);
  rotateVector(frame.forward, { x: 0, y: 0, z: -1 }, quaternionValue);
  normalize(frame.right, frame.right);
  normalize(frame.up, frame.up);
  normalize(frame.forward, frame.forward);
}

function quaternionAngle(a: QuaternionLike, b: QuaternionLike): number {
  return 2 * Math.acos(Math.min(1, Math.abs(quaternionDot(a, b))));
}

function slerpQuaternion(
  out: QuaternionLike,
  a: QuaternionLike,
  b: QuaternionLike,
  alpha: number,
): void {
  let cosine = quaternionDot(a, b);
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  if (cosine < 0) {
    cosine = -cosine;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (cosine > 0.9995) {
    out.x = a.x + (bx - a.x) * alpha;
    out.y = a.y + (by - a.y) * alpha;
    out.z = a.z + (bz - a.z) * alpha;
    out.w = a.w + (bw - a.w) * alpha;
    normalizeQuaternion(out);
    return;
  }
  const angle = Math.acos(Math.max(-1, Math.min(1, cosine)));
  const sine = Math.sin(angle);
  const aWeight = Math.sin((1 - alpha) * angle) / sine;
  const bWeight = Math.sin(alpha * angle) / sine;
  out.x = a.x * aWeight + bx * bWeight;
  out.y = a.y * aWeight + by * bWeight;
  out.z = a.z * aWeight + bz * bWeight;
  out.w = a.w * aWeight + bw * bWeight;
}

function multiplyQuaternion(
  out: QuaternionLike,
  a: QuaternionLike,
  b: QuaternionLike,
): void {
  const ax = a.x;
  const ay = a.y;
  const az = a.z;
  const aw = a.w;
  const bx = b.x;
  const by = b.y;
  const bz = b.z;
  const bw = b.w;
  out.x = ax * bw + aw * bx + ay * bz - az * by;
  out.y = ay * bw + aw * by + az * bx - ax * bz;
  out.z = az * bw + aw * bz + ax * by - ay * bx;
  out.w = aw * bw - ax * bx - ay * by - az * bz;
}

function invertQuaternion(out: QuaternionLike, value: QuaternionLike): void {
  out.x = -value.x;
  out.y = -value.y;
  out.z = -value.z;
  out.w = value.w;
}

function rotateVector(out: MutableVec3, value: Vec3Like, q: QuaternionLike): void {
  const ix = q.w * value.x + q.y * value.z - q.z * value.y;
  const iy = q.w * value.y + q.z * value.x - q.x * value.z;
  const iz = q.w * value.z + q.x * value.y - q.y * value.x;
  const iw = -q.x * value.x - q.y * value.y - q.z * value.z;
  out.x = ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y;
  out.y = iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z;
  out.z = iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x;
}

function normalizeQuaternion(value: QuaternionLike): void {
  const inverse = 1 / Math.hypot(value.x, value.y, value.z, value.w);
  value.x *= inverse;
  value.y *= inverse;
  value.z *= inverse;
  value.w *= inverse;
}

function quaternionDot(a: QuaternionLike, b: QuaternionLike): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function negateQuaternion(value: QuaternionLike): void {
  value.x = -value.x;
  value.y = -value.y;
  value.z = -value.z;
  value.w = -value.w;
}

function countValidHeldContacts(contacts: readonly BodyOrientationContact[]): number {
  let count = 0;
  for (const contact of contacts) if (contact.loaded && contact.valid) count += 1;
  return count;
}

function copyFrame(target: MutableFrame, source: MutableFrame): void {
  copy(target.position, source.position);
  copy(target.forward, source.forward);
  copy(target.up, source.up);
  copy(target.right, source.right);
}

function finiteFrame(frame: MutableFrame): boolean {
  return finiteVector(frame.position) && finiteVector(frame.forward) &&
    finiteVector(frame.up) && finiteVector(frame.right);
}

function finiteVector(value: Vec3Like | undefined): value is Vec3Like {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z));
}

function set(out: MutableVec3, x: number, y: number, z: number): void {
  out.x = x;
  out.y = y;
  out.z = z;
}

function copy(out: MutableVec3, value: Vec3Like): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

function setScaled(out: MutableVec3, value: Vec3Like, scalar: number): void {
  out.x = value.x * scalar;
  out.y = value.y * scalar;
  out.z = value.z * scalar;
}

function scale(out: MutableVec3, scalar: number): void {
  out.x *= scalar;
  out.y *= scalar;
  out.z *= scalar;
}

function add(out: MutableVec3, a: Vec3Like, b: Vec3Like): void {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  out.z = a.z + b.z;
}

function addScaled(out: MutableVec3, value: Vec3Like, scalar: number): void {
  out.x += value.x * scalar;
  out.y += value.y * scalar;
  out.z += value.z * scalar;
}

function subtract(out: MutableVec3, a: Vec3Like, b: Vec3Like): void {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  out.z = a.z - b.z;
}

function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function cross(out: MutableVec3, a: Vec3Like, b: Vec3Like): void {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
}

function length(value: Vec3Like): number {
  return Math.hypot(value.x, value.y, value.z);
}

function lengthSquared(value: Vec3Like): number {
  return value.x * value.x + value.y * value.y + value.z * value.z;
}

function normalize(out: MutableVec3, value: Vec3Like): boolean {
  const magnitude = length(value);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) return false;
  setScaled(out, value, 1 / magnitude);
  return true;
}

function projectNormal(out: MutableVec3, value: Vec3Like, normal: Vec3Like): void {
  const projection = dot(value, normal);
  out.x = value.x - normal.x * projection;
  out.y = value.y - normal.y * projection;
  out.z = value.z - normal.z * projection;
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function lerpVector(out: MutableVec3, a: Vec3Like, b: Vec3Like, alpha: number): void {
  out.x = a.x + (b.x - a.x) * alpha;
  out.y = a.y + (b.y - a.y) * alpha;
  out.z = a.z + (b.z - a.z) * alpha;
}
