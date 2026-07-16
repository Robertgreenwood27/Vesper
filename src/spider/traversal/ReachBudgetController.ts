import type { MutableVec3, Vec3Like } from "../../traversal";
import type { SpiderLegId } from "../SpiderRigSpec";
import type { TraversalBodyFrame } from "./TraversalTypes";

const EPSILON = 1e-9;
const DEFAULT_FRACTIONS = Object.freeze([0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1]);

export interface ReachBudgetContact {
  readonly legId: SpiderLegId;
  readonly planted: boolean;
  readonly contactWorldPosition: Vec3Like;
  /** Current coxa/reach origin in world space. */
  readonly reachOriginWorldPosition: Vec3Like;
  readonly minimumReach?: number;
  readonly comfortableReach: number;
  readonly maximumReach: number;
  readonly loadFactor?: number;
  readonly trailing?: boolean;
}

export type ReachBudgetLegConstraint =
  | "none"
  | "non-finite-contact"
  | "minimum-reach"
  | "hard-maximum-reach";

export interface ReachBudgetLegEvaluation {
  readonly legId: SpiderLegId;
  readonly predictedReachOrigin: MutableVec3;
  currentDistance: number;
  predictedDistance: number;
  currentReachRatio: number;
  predictedReachRatio: number;
  currentComfortableReserve: number;
  predictedComfortableReserve: number;
  currentMaximumReserve: number;
  predictedMaximumReserve: number;
  currentComfortableReserveRatio: number;
  predictedComfortableReserveRatio: number;
  currentMaximumReserveRatio: number;
  predictedMaximumReserveRatio: number;
  improves: boolean;
  worsens: boolean;
  hardValid: boolean;
  trailing: boolean;
  loadFactor: number;
  urgencyToMoveNext: number;
  limitingConstraint: ReachBudgetLegConstraint;
}

export interface ReachBudgetEvaluation {
  readonly legs: ReachBudgetLegEvaluation[];
  hardValid: boolean;
  plantedContactCount: number;
  worstCurrentReachRatio: number;
  worstPredictedReachRatio: number;
  worstTrailingCurrentReachRatio: number;
  worstTrailingPredictedReachRatio: number;
  comfortableOverageBefore: number;
  comfortableOverageAfter: number;
  distributionCostBefore: number;
  distributionCostAfter: number;
  reachBudgetImprovement: number;
  trailingReachImprovement: number;
  limitingLegId: SpiderLegId | null;
  limitingConstraint: ReachBudgetLegConstraint | "no-planted-contacts";
}

export interface ReachBudgetEvaluationRequest {
  readonly currentFrame: TraversalBodyFrame;
  readonly proposedFrame: TraversalBodyFrame;
  readonly contacts: readonly ReachBudgetContact[];
}

export interface ReachBudgetExternalConstraint {
  readonly valid: boolean;
  readonly reason?: string;
  readonly classification?: string;
  readonly score?: number;
}

export interface ReachBudgetUsefulness {
  readonly useful: boolean;
  readonly score?: number;
  readonly reason?: string;
}

export interface ReachBudgetMotionContext {
  readonly frame: TraversalBodyFrame;
  readonly translationFraction: number;
  readonly rotationFraction: number;
  readonly translationDistance: number;
  readonly rotationRadians: number;
  readonly budget: ReachBudgetEvaluation;
}

export type ReachBudgetConstraintCallback = (
  context: ReachBudgetMotionContext,
) => boolean | ReachBudgetExternalConstraint;

export type ReachBudgetUsefulnessCallback = (
  context: ReachBudgetMotionContext,
) => boolean | ReachBudgetUsefulness;

export type ReachBudgetMotionConstraint =
  | ReachBudgetLegConstraint
  | "none"
  | "no-positive-motion"
  | "worst-reach-worsened"
  | "support-invalid"
  | "clearance-invalid"
  | "no-useful-progress";

export interface ReachBudgetMotionCandidate {
  readonly frame: TraversalBodyFrame;
  readonly translationFraction: number;
  readonly rotationFraction: number;
  readonly translationDistance: number;
  readonly rotationRadians: number;
  readonly budget: ReachBudgetEvaluation;
  readonly support: ReachBudgetExternalConstraint;
  readonly clearance: ReachBudgetExternalConstraint;
  readonly usefulness: ReachBudgetUsefulness;
  accepted: boolean;
  score: number;
  limitingLegId: SpiderLegId | null;
  limitingConstraint: ReachBudgetMotionConstraint | "no-planted-contacts";
}

export interface ReachBudgetSearchRequest {
  readonly currentFrame: TraversalBodyFrame;
  readonly targetFrame: TraversalBodyFrame;
  readonly contacts: readonly ReachBudgetContact[];
  readonly support?: ReachBudgetConstraintCallback;
  readonly clearance?: ReachBudgetConstraintCallback;
  readonly usefulness?: ReachBudgetUsefulnessCallback;
  /**
   * Narrow corrective escape hatch for an already-stranded support pattern.
   * The candidate must still pass every per-leg hard reach limit; callers may
   * only waive the soft distribution-worsening tolerance with explicit
   * evidence that the motion repairs another safety constraint.
   */
  readonly allowCorrectiveWorstReachWorsening?: ReachBudgetUsefulnessCallback;
}

export interface ReachBudgetSearchResult {
  success: boolean;
  message: string;
  requestedTranslation: number;
  requestedRotationRadians: number;
  readonly currentBudget: ReachBudgetEvaluation;
  readonly candidates: ReachBudgetMotionCandidate[];
  accepted: ReachBudgetMotionCandidate | null;
  limitingLegId: SpiderLegId | null;
  limitingConstraint: ReachBudgetMotionConstraint | "no-planted-contacts";
}

export interface ReachBudgetControllerConfig {
  /** Positive samples in (0, 1], evaluated in deterministic small-to-large order. */
  readonly fractionSamples?: readonly number[];
  readonly worstReachWorseningTolerance?: number;
  readonly reachImprovementEpsilon?: number;
  readonly minimumUsefulTranslation?: number;
  readonly minimumUsefulRotationRadians?: number;
  readonly trailingUrgencyWeight?: number;
  readonly reachImprovementScoreWeight?: number;
}

interface NormalizedConfig {
  readonly fractionSamples: readonly number[];
  readonly worstReachWorseningTolerance: number;
  readonly reachImprovementEpsilon: number;
  readonly minimumUsefulTranslation: number;
  readonly minimumUsefulRotationRadians: number;
  readonly trailingUrgencyWeight: number;
  readonly reachImprovementScoreWeight: number;
}

interface QuaternionLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

/**
 * Pure planner for coupled translation/rotation reach budgets. It owns no body
 * transform, contact, IK, or support state; callers remain responsible for
 * applying and continuously validating the accepted frame.
 */
export class ReachBudgetController {
  readonly config: NormalizedConfig;

  constructor(config: ReachBudgetControllerConfig = {}) {
    const fractions = [...(config.fractionSamples ?? DEFAULT_FRACTIONS)]
      .filter((value, index, values) =>
        Number.isFinite(value) && value > 0 && value <= 1 && values.indexOf(value) === index)
      .sort((left, right) => left - right);
    if (fractions.length === 0) {
      throw new Error("Reach-budget search requires at least one fraction in (0, 1].");
    }
    this.config = {
      fractionSamples: fractions,
      worstReachWorseningTolerance: nonNegative(
        config.worstReachWorseningTolerance,
        0.005,
        "worst-reach worsening tolerance",
      ),
      reachImprovementEpsilon: nonNegative(
        config.reachImprovementEpsilon,
        1e-5,
        "reach improvement epsilon",
      ),
      minimumUsefulTranslation: nonNegative(
        config.minimumUsefulTranslation,
        1e-4,
        "minimum useful translation",
      ),
      minimumUsefulRotationRadians: nonNegative(
        config.minimumUsefulRotationRadians,
        1e-4,
        "minimum useful rotation",
      ),
      trailingUrgencyWeight: nonNegative(
        config.trailingUrgencyWeight,
        0.8,
        "trailing urgency weight",
      ),
      reachImprovementScoreWeight: nonNegative(
        config.reachImprovementScoreWeight,
        2,
        "reach improvement score weight",
      ),
    };
  }

  evaluate(request: ReachBudgetEvaluationRequest): ReachBudgetEvaluation {
    const result = emptyEvaluation();
    const currentFrame = normalizedFrame(request.currentFrame);
    const proposedFrame = normalizedFrame(request.proposedFrame);
    if (!currentFrame || !proposedFrame) {
      result.hardValid = false;
      result.limitingConstraint = "non-finite-contact";
      return result;
    }

    const currentQuaternion = frameQuaternion(currentFrame);
    const proposedQuaternion = frameQuaternion(proposedFrame);
    const inverseCurrent = invertQuaternion(currentQuaternion);
    const delta = multiplyQuaternion(proposedQuaternion, inverseCurrent);

    let currentComfortableOverage = 0;
    let proposedComfortableOverage = 0;
    let worstViolation = -Infinity;
    for (const contact of request.contacts) {
      if (!contact.planted) continue;
      result.plantedContactCount += 1;
      const leg = evaluateLeg(contact, currentFrame, proposedFrame, delta, this.config);
      result.legs.push(leg);
      result.worstCurrentReachRatio = Math.max(
        result.worstCurrentReachRatio,
        leg.currentReachRatio,
      );
      result.worstPredictedReachRatio = Math.max(
        result.worstPredictedReachRatio,
        leg.predictedReachRatio,
      );
      if (leg.trailing) {
        result.worstTrailingCurrentReachRatio = Math.max(
          result.worstTrailingCurrentReachRatio,
          leg.currentReachRatio,
        );
        result.worstTrailingPredictedReachRatio = Math.max(
          result.worstTrailingPredictedReachRatio,
          leg.predictedReachRatio,
        );
      }
      currentComfortableOverage += Math.max(0, -leg.currentComfortableReserveRatio);
      proposedComfortableOverage += Math.max(0, -leg.predictedComfortableReserveRatio);
      if (!leg.hardValid) {
        result.hardValid = false;
        const violation = legViolation(leg);
        if (violation > worstViolation) {
          worstViolation = violation;
          result.limitingLegId = leg.legId;
          result.limitingConstraint = leg.limitingConstraint;
        }
      } else if (
        result.limitingLegId === null ||
        leg.predictedReachRatio >
          (result.legs.find((entry) => entry.legId === result.limitingLegId)
            ?.predictedReachRatio ?? -Infinity)
      ) {
        result.limitingLegId = leg.legId;
      }
    }

    if (result.plantedContactCount === 0) {
      result.hardValid = false;
      result.limitingConstraint = "no-planted-contacts";
      return result;
    }
    if (result.hardValid) result.limitingConstraint = "none";
    const inverseCount = 1 / result.plantedContactCount;
    result.comfortableOverageBefore = currentComfortableOverage * inverseCount;
    result.comfortableOverageAfter = proposedComfortableOverage * inverseCount;
    result.distributionCostBefore =
      result.worstCurrentReachRatio + result.comfortableOverageBefore;
    result.distributionCostAfter =
      result.worstPredictedReachRatio + result.comfortableOverageAfter;
    result.reachBudgetImprovement = finiteDifference(
      result.distributionCostBefore,
      result.distributionCostAfter,
    );
    result.trailingReachImprovement = finiteDifference(
      result.worstTrailingCurrentReachRatio,
      result.worstTrailingPredictedReachRatio,
    );
    return result;
  }

  search(request: ReachBudgetSearchRequest): ReachBudgetSearchResult {
    const current = normalizedFrame(request.currentFrame);
    const target = normalizedFrame(request.targetFrame);
    const currentBudget = this.evaluate({
      currentFrame: request.currentFrame,
      proposedFrame: request.currentFrame,
      contacts: request.contacts,
    });
    const result: ReachBudgetSearchResult = {
      success: false,
      message: "No positive useful body-motion increment was evaluated.",
      requestedTranslation: current && target ? distance(current.position, target.position) : Infinity,
      requestedRotationRadians: current && target
        ? quaternionAngle(frameQuaternion(current), frameQuaternion(target))
        : Infinity,
      currentBudget,
      candidates: [],
      accepted: null,
      limitingLegId: currentBudget.limitingLegId,
      limitingConstraint: currentBudget.limitingConstraint,
    };
    if (!current || !target) {
      result.message = "Current or target body frame is non-finite.";
      result.limitingConstraint = "non-finite-contact";
      return result;
    }

    const currentQuaternion = frameQuaternion(current);
    const targetQuaternion = frameQuaternion(target);
    const translationFractions = result.requestedTranslation > EPSILON
      ? [0, ...this.config.fractionSamples]
      : [0];
    const rotationFractions = result.requestedRotationRadians > EPSILON
      ? [0, ...this.config.fractionSamples]
      : [0];
    const pairs: Array<readonly [number, number]> = [];
    for (const translationFraction of translationFractions) {
      for (const rotationFraction of rotationFractions) {
        if (translationFraction <= 0 && rotationFraction <= 0) continue;
        pairs.push([translationFraction, rotationFraction]);
      }
    }
    pairs.sort((left, right) =>
      Math.max(left[0], left[1]) - Math.max(right[0], right[1]) ||
      left[0] + left[1] - right[0] - right[1] ||
      left[0] - right[0] || left[1] - right[1]);

    for (const [translationFraction, rotationFraction] of pairs) {
      const frame = interpolateFrame(
        current,
        target,
        currentQuaternion,
        targetQuaternion,
        translationFraction,
        rotationFraction,
      );
      const budget = this.evaluate({
        currentFrame: current,
        proposedFrame: frame,
        contacts: request.contacts,
      });
      const context: ReachBudgetMotionContext = {
        frame,
        translationFraction,
        rotationFraction,
        translationDistance: result.requestedTranslation * translationFraction,
        rotationRadians: result.requestedRotationRadians * rotationFraction,
        budget,
      };
      const support = evaluateConstraint(request.support, context, "Support callback rejected motion.");
      const clearance = evaluateConstraint(
        request.clearance,
        context,
        "Clearance callback rejected motion.",
      );
      const positiveMotion =
        context.translationDistance + EPSILON >= this.config.minimumUsefulTranslation ||
        context.rotationRadians + EPSILON >= this.config.minimumUsefulRotationRadians;
      const usefulness = evaluateUsefulness(request.usefulness, context, positiveMotion);
      const correctiveWorstReachWorseningAllowed =
        request.allowCorrectiveWorstReachWorsening !== undefined &&
        evaluateUsefulness(
          request.allowCorrectiveWorstReachWorsening,
          context,
          positiveMotion,
        ).useful;
      const worstPreserved =
        budget.worstPredictedReachRatio <=
          currentBudget.worstCurrentReachRatio +
            this.config.worstReachWorseningTolerance ||
        correctiveWorstReachWorseningAllowed;
      const candidate: ReachBudgetMotionCandidate = {
        ...context,
        support,
        clearance,
        usefulness,
        accepted: false,
        score:
          finiteOr(usefulness.score, 0) +
          finiteOr(support.score, 0) +
          finiteOr(clearance.score, 0) +
          finiteOr(budget.reachBudgetImprovement, 0) *
            this.config.reachImprovementScoreWeight,
        limitingLegId: budget.limitingLegId,
        limitingConstraint: "none",
      };
      if (!positiveMotion) candidate.limitingConstraint = "no-positive-motion";
      else if (!budget.hardValid) candidate.limitingConstraint = budget.limitingConstraint;
      else if (!worstPreserved) candidate.limitingConstraint = "worst-reach-worsened";
      else if (!support.valid) candidate.limitingConstraint = "support-invalid";
      else if (!clearance.valid) candidate.limitingConstraint = "clearance-invalid";
      else if (!usefulness.useful) candidate.limitingConstraint = "no-useful-progress";
      else candidate.accepted = true;
      result.candidates.push(candidate);
      if (candidate.accepted && betterCandidate(candidate, result.accepted)) {
        result.accepted = candidate;
      }
    }

    if (result.accepted) {
      result.success = true;
      result.message = "A hard-reach-safe useful body-motion increment was found.";
      result.limitingLegId = result.accepted.limitingLegId;
      result.limitingConstraint = "none";
      return result;
    }
    const diagnostic = result.candidates.reduce<ReachBudgetMotionCandidate | null>(
      (best, candidate) => betterCandidate(candidate, best) ? candidate : best,
      null,
    );
    result.limitingLegId = diagnostic?.limitingLegId ?? currentBudget.limitingLegId;
    result.limitingConstraint =
      diagnostic?.limitingConstraint ?? currentBudget.limitingConstraint;
    result.message = diagnostic
      ? `No safe useful body increment; limiting constraint: ${diagnostic.limitingConstraint}.`
      : result.message;
    return result;
  }
}

function evaluateLeg(
  contact: ReachBudgetContact,
  currentFrame: TraversalBodyFrame,
  proposedFrame: TraversalBodyFrame,
  delta: QuaternionLike,
  config: NormalizedConfig,
): ReachBudgetLegEvaluation {
  const predictedOrigin = vector();
  const minimum = contact.minimumReach ?? 0;
  const loadFactor = contact.loadFactor ?? 1;
  const finite =
    finiteVector(contact.contactWorldPosition) &&
    finiteVector(contact.reachOriginWorldPosition) &&
    Number.isFinite(minimum) && minimum >= 0 &&
    Number.isFinite(contact.comfortableReach) &&
    Number.isFinite(contact.maximumReach) &&
    contact.comfortableReach >= minimum &&
    contact.maximumReach >= contact.comfortableReach &&
    contact.maximumReach > EPSILON &&
    Number.isFinite(loadFactor) && loadFactor >= 0 && loadFactor <= 1;
  if (!finite) {
    return {
      legId: contact.legId,
      predictedReachOrigin: predictedOrigin,
      currentDistance: Infinity,
      predictedDistance: Infinity,
      currentReachRatio: Infinity,
      predictedReachRatio: Infinity,
      currentComfortableReserve: -Infinity,
      predictedComfortableReserve: -Infinity,
      currentMaximumReserve: -Infinity,
      predictedMaximumReserve: -Infinity,
      currentComfortableReserveRatio: -Infinity,
      predictedComfortableReserveRatio: -Infinity,
      currentMaximumReserveRatio: -Infinity,
      predictedMaximumReserveRatio: -Infinity,
      improves: false,
      worsens: false,
      hardValid: false,
      trailing: contact.trailing === true,
      loadFactor: Number.isFinite(loadFactor) ? loadFactor : 0,
      urgencyToMoveNext: Infinity,
      limitingConstraint: "non-finite-contact",
    };
  }

  const localOrigin = {
    x: contact.reachOriginWorldPosition.x - currentFrame.position.x,
    y: contact.reachOriginWorldPosition.y - currentFrame.position.y,
    z: contact.reachOriginWorldPosition.z - currentFrame.position.z,
  };
  rotateVector(predictedOrigin, localOrigin, delta);
  predictedOrigin.x += proposedFrame.position.x;
  predictedOrigin.y += proposedFrame.position.y;
  predictedOrigin.z += proposedFrame.position.z;
  const currentDistance = distance(contact.contactWorldPosition, contact.reachOriginWorldPosition);
  const predictedDistance = distance(contact.contactWorldPosition, predictedOrigin);
  const comfortableSpan = Math.max(EPSILON, contact.comfortableReach);
  const maximumSpan = Math.max(EPSILON, contact.maximumReach);
  const pressureSpan = Math.max(EPSILON, contact.maximumReach - contact.comfortableReach);
  const predictedPressure = Math.max(
    0,
    (predictedDistance - contact.comfortableReach) / pressureSpan,
  );
  const trailing = contact.trailing === true;
  const maximumViolation = Math.max(0, predictedDistance - contact.maximumReach) / maximumSpan;
  const minimumViolation = Math.max(0, minimum - predictedDistance) / maximumSpan;
  const hardValid =
    Number.isFinite(predictedDistance) &&
    predictedDistance <= contact.maximumReach + EPSILON &&
    predictedDistance + EPSILON >= minimum;
  return {
    legId: contact.legId,
    predictedReachOrigin: predictedOrigin,
    currentDistance,
    predictedDistance,
    currentReachRatio: currentDistance / maximumSpan,
    predictedReachRatio: predictedDistance / maximumSpan,
    currentComfortableReserve: contact.comfortableReach - currentDistance,
    predictedComfortableReserve: contact.comfortableReach - predictedDistance,
    currentMaximumReserve: contact.maximumReach - currentDistance,
    predictedMaximumReserve: contact.maximumReach - predictedDistance,
    currentComfortableReserveRatio:
      (contact.comfortableReach - currentDistance) / comfortableSpan,
    predictedComfortableReserveRatio:
      (contact.comfortableReach - predictedDistance) / comfortableSpan,
    currentMaximumReserveRatio: (contact.maximumReach - currentDistance) / maximumSpan,
    predictedMaximumReserveRatio: (contact.maximumReach - predictedDistance) / maximumSpan,
    improves: predictedDistance + config.reachImprovementEpsilon < currentDistance,
    worsens: predictedDistance > currentDistance + config.reachImprovementEpsilon,
    hardValid,
    trailing,
    loadFactor,
    urgencyToMoveNext:
      predictedPressure * (1 + (trailing ? config.trailingUrgencyWeight : 0)) +
      maximumViolation * 10 + minimumViolation * 5 + (1 - loadFactor) * 0.1,
    limitingConstraint: !hardValid
      ? predictedDistance > contact.maximumReach
        ? "hard-maximum-reach"
        : "minimum-reach"
      : "none",
  };
}

function emptyEvaluation(): ReachBudgetEvaluation {
  return {
    legs: [],
    hardValid: true,
    plantedContactCount: 0,
    worstCurrentReachRatio: 0,
    worstPredictedReachRatio: 0,
    worstTrailingCurrentReachRatio: 0,
    worstTrailingPredictedReachRatio: 0,
    comfortableOverageBefore: 0,
    comfortableOverageAfter: 0,
    distributionCostBefore: Infinity,
    distributionCostAfter: Infinity,
    reachBudgetImprovement: 0,
    trailingReachImprovement: 0,
    limitingLegId: null,
    limitingConstraint: "none",
  };
}

function evaluateConstraint(
  callback: ReachBudgetConstraintCallback | undefined,
  context: ReachBudgetMotionContext,
  fallbackReason: string,
): ReachBudgetExternalConstraint {
  if (!callback) return { valid: true, score: 0 };
  try {
    const value = callback(context);
    return typeof value === "boolean"
      ? { valid: value, reason: value ? undefined : fallbackReason, score: 0 }
      : {
          valid: value.valid,
          reason: value.reason,
          classification: value.classification,
          score: finiteOr(value.score, 0),
        };
  } catch (error) {
    return {
      valid: false,
      reason: error instanceof Error ? error.message : String(error),
      score: 0,
    };
  }
}

function evaluateUsefulness(
  callback: ReachBudgetUsefulnessCallback | undefined,
  context: ReachBudgetMotionContext,
  positiveMotion: boolean,
): ReachBudgetUsefulness {
  if (!callback) {
    return {
      useful: positiveMotion,
      score:
        context.translationFraction + context.rotationFraction +
        Math.max(0, finiteOr(context.budget.reachBudgetImprovement, 0)),
      reason: positiveMotion ? undefined : "Candidate has no positive motion.",
    };
  }
  try {
    const value = callback(context);
    return typeof value === "boolean"
      ? { useful: value && positiveMotion, score: 0 }
      : {
          useful: value.useful && positiveMotion,
          score: finiteOr(value.score, 0),
          reason: value.reason,
        };
  } catch (error) {
    return {
      useful: false,
      score: 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function betterCandidate(
  candidate: ReachBudgetMotionCandidate,
  current: ReachBudgetMotionCandidate | null,
): boolean {
  if (!current) return true;
  if (candidate.accepted !== current.accepted) return candidate.accepted;
  if (candidate.score !== current.score) return candidate.score > current.score;
  const candidateExtent = Math.max(candidate.translationFraction, candidate.rotationFraction);
  const currentExtent = Math.max(current.translationFraction, current.rotationFraction);
  if (candidateExtent !== currentExtent) return candidateExtent > currentExtent;
  const candidateTotal = candidate.translationFraction + candidate.rotationFraction;
  const currentTotal = current.translationFraction + current.rotationFraction;
  if (candidateTotal !== currentTotal) return candidateTotal > currentTotal;
  return candidate.translationFraction > current.translationFraction;
}

function legViolation(leg: ReachBudgetLegEvaluation): number {
  if (!Number.isFinite(leg.predictedReachRatio)) return Infinity;
  if (leg.limitingConstraint === "hard-maximum-reach") {
    return Math.max(0, leg.predictedReachRatio - 1);
  }
  if (leg.limitingConstraint === "minimum-reach") {
    return Math.max(0, -leg.predictedMaximumReserveRatio);
  }
  return 0;
}

function normalizedFrame(frame: TraversalBodyFrame): TraversalBodyFrame | null {
  if (!finiteVector(frame.position) || !finiteVector(frame.forward) || !finiteVector(frame.up)) {
    return null;
  }
  const forward = normalized(frame.forward);
  if (!forward) return null;
  const upProjection = dot(frame.up, forward);
  const up = normalized({
    x: frame.up.x - forward.x * upProjection,
    y: frame.up.y - forward.y * upProjection,
    z: frame.up.z - forward.z * upProjection,
  });
  if (!up) return null;
  const right = normalized(cross(forward, up));
  if (!right) return null;
  return {
    position: { ...frame.position },
    forward,
    up: normalized(cross(right, forward)) ?? up,
    right,
  };
}

function interpolateFrame(
  current: TraversalBodyFrame,
  target: TraversalBodyFrame,
  currentQuaternion: QuaternionLike,
  targetQuaternion: QuaternionLike,
  translationFraction: number,
  rotationFraction: number,
): TraversalBodyFrame {
  const quaternion = slerpQuaternion(currentQuaternion, targetQuaternion, rotationFraction);
  const axes = quaternionAxes(quaternion);
  return {
    position: {
      x: current.position.x + (target.position.x - current.position.x) * translationFraction,
      y: current.position.y + (target.position.y - current.position.y) * translationFraction,
      z: current.position.z + (target.position.z - current.position.z) * translationFraction,
    },
    ...axes,
  };
}

function frameQuaternion(frame: TraversalBodyFrame): QuaternionLike {
  const m00 = frame.right.x;
  const m01 = frame.up.x;
  const m02 = -frame.forward.x;
  const m10 = frame.right.y;
  const m11 = frame.up.y;
  const m12 = -frame.forward.y;
  const m20 = frame.right.z;
  const m21 = frame.up.z;
  const m22 = -frame.forward.z;
  const out = quaternion();
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
  return normalizeQuaternion(out);
}

function quaternionAxes(value: QuaternionLike): Pick<TraversalBodyFrame, "forward" | "up" | "right"> {
  const right = vector();
  const up = vector();
  const forward = vector();
  rotateVector(right, { x: 1, y: 0, z: 0 }, value);
  rotateVector(up, { x: 0, y: 1, z: 0 }, value);
  rotateVector(forward, { x: 0, y: 0, z: -1 }, value);
  return { right, up, forward };
}

function slerpQuaternion(a: QuaternionLike, b: QuaternionLike, alpha: number): QuaternionLike {
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
    return normalizeQuaternion({
      x: a.x + (bx - a.x) * alpha,
      y: a.y + (by - a.y) * alpha,
      z: a.z + (bz - a.z) * alpha,
      w: a.w + (bw - a.w) * alpha,
    });
  }
  const angle = Math.acos(clamp(cosine, -1, 1));
  const sine = Math.sin(angle);
  const aWeight = Math.sin((1 - alpha) * angle) / sine;
  const bWeight = Math.sin(alpha * angle) / sine;
  return normalizeQuaternion({
    x: a.x * aWeight + bx * bWeight,
    y: a.y * aWeight + by * bWeight,
    z: a.z * aWeight + bz * bWeight,
    w: a.w * aWeight + bw * bWeight,
  });
}

function quaternionAngle(a: QuaternionLike, b: QuaternionLike): number {
  return 2 * Math.acos(clamp(Math.abs(quaternionDot(a, b)), -1, 1));
}

function multiplyQuaternion(a: QuaternionLike, b: QuaternionLike): QuaternionLike {
  return normalizeQuaternion({
    x: a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y,
    y: a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z,
    z: a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  });
}

function invertQuaternion(value: QuaternionLike): QuaternionLike {
  return { x: -value.x, y: -value.y, z: -value.z, w: value.w };
}

function normalizeQuaternion(value: QuaternionLike): QuaternionLike {
  const magnitude = Math.hypot(value.x, value.y, value.z, value.w);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) return quaternion();
  const inverse = 1 / magnitude;
  value.x *= inverse;
  value.y *= inverse;
  value.z *= inverse;
  value.w *= inverse;
  return value;
}

function quaternionDot(a: QuaternionLike, b: QuaternionLike): number {
  return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
}

function quaternion(): QuaternionLike {
  return { x: 0, y: 0, z: 0, w: 1 };
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

function vector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function normalized(value: Vec3Like): MutableVec3 | null {
  const magnitude = Math.hypot(value.x, value.y, value.z);
  if (!Number.isFinite(magnitude) || magnitude <= EPSILON) return null;
  return { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude };
}

function cross(a: Vec3Like, b: Vec3Like): MutableVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function distance(a: Vec3Like, b: Vec3Like): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function finiteDifference(before: number, after: number): number {
  if (Number.isFinite(before) && Number.isFinite(after)) return before - after;
  if (!Number.isFinite(before) && Number.isFinite(after)) return Infinity;
  if (Number.isFinite(before) && !Number.isFinite(after)) return -Infinity;
  return 0;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value as number : fallback;
}

function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`Reach-budget ${name} must be finite and non-negative.`);
  }
  return resolved;
}
