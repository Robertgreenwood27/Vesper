import { compareFootholdCandidates } from "./FootholdScorer";
import type {
  FootholdCandidate,
  LegEligibilityDiagnostic,
  LegIneligibilityReason,
  LegSelectionOptions,
  LegSelectionRequest,
  LegSelectionResult,
  LocomotionLegPolicyState,
  SelectedLegPlan,
} from "./LocomotionTypes";

const DEFAULT_MINIMUM_SUPPORT_COUNT = 5;
const DEFAULT_MINIMUM_SCORE_IMPROVEMENT = 0.05;
const DEFAULT_MINIMUM_PROGRESS_IMPROVEMENT = 0.02;
const DEFAULT_MAXIMUM_REMAINING_REACH_RATIO = 0.97;
const DEFAULT_BODY_ADVANCE_DISTANCE = 0.12;
const DEFAULT_MINIMUM_SUPPORT_SPACING = 0.12;
const DEFAULT_MAXIMUM_SUPPORT_SPACING_LOSS = 0.15;
const DEFAULT_SUPPORT_SPACING_PREFERENCE = 0.75;
const DEFAULT_REPEAT_LEG_PENALTY = 0.4;

interface NormalizedSelectionOptions {
  readonly minimumSupportFootCount: number;
  readonly minimumScoreImprovement: number;
  readonly minimumProgressImprovement: number;
  readonly maximumRemainingReachRatio: number;
  readonly expectedBodyAdvanceDistance: number;
  readonly minimumSupportSpacing: number;
  readonly maximumSupportSpacingLoss: number;
  readonly supportSpacingPreference: number;
  readonly repeatLegPenalty: number;
  readonly historyScoreAdjustments: Readonly<Partial<Record<LocomotionLegPolicyState["legId"], number>>>;
  readonly candidateObjective: LegSelectionOptions["candidateObjective"];
  readonly allowGenericCandidateFallback: boolean;
  readonly previousMovingLegId: LegSelectionOptions["previousMovingLegId"];
  readonly activeMovingLegId: LegSelectionOptions["activeMovingLegId"];
}

interface MutableSelection {
  readonly plan: SelectedLegPlan;
  readonly candidate: FootholdCandidate;
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value as number : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizeOptions(options: LegSelectionOptions | undefined): NormalizedSelectionOptions {
  return {
    minimumSupportFootCount: Math.max(
      1,
      Math.floor(finiteOr(options?.minimumSupportFootCount, DEFAULT_MINIMUM_SUPPORT_COUNT)),
    ),
    // Higher-level deliberate traversal may accept a small local score tradeoff
    // for positive semantic progress. Keep that concession tightly bounded;
    // the Phase 7 default remains a positive improvement requirement.
    minimumScoreImprovement: Math.max(
      -3,
      finiteOr(options?.minimumScoreImprovement, DEFAULT_MINIMUM_SCORE_IMPROVEMENT),
    ),
    // Phase 8R may opt into a bounded corrective back-step. A value of -1
    // permits one normalized local-search radius of regression; topology,
    // reach, joints, spacing, and support still gate it.
    // The Phase 7 default remains strictly positive.
    minimumProgressImprovement: Math.max(
      -1,
      finiteOr(options?.minimumProgressImprovement, DEFAULT_MINIMUM_PROGRESS_IMPROVEMENT),
    ),
    maximumRemainingReachRatio: clamp(
      finiteOr(
        options?.maximumRemainingReachRatio,
        DEFAULT_MAXIMUM_REMAINING_REACH_RATIO,
      ),
      0.01,
      1,
    ),
    expectedBodyAdvanceDistance: Math.max(
      0,
      finiteOr(options?.expectedBodyAdvanceDistance, DEFAULT_BODY_ADVANCE_DISTANCE),
    ),
    minimumSupportSpacing: Math.max(
      0,
      finiteOr(options?.minimumSupportSpacing, DEFAULT_MINIMUM_SUPPORT_SPACING),
    ),
    maximumSupportSpacingLoss: clamp(
      finiteOr(options?.maximumSupportSpacingLoss, DEFAULT_MAXIMUM_SUPPORT_SPACING_LOSS),
      0,
      1,
    ),
    supportSpacingPreference: Math.max(
      0,
      finiteOr(options?.supportSpacingPreference, DEFAULT_SUPPORT_SPACING_PREFERENCE),
    ),
    repeatLegPenalty: Math.max(
      0,
      finiteOr(options?.repeatLegPenalty, DEFAULT_REPEAT_LEG_PENALTY),
    ),
    historyScoreAdjustments: options?.historyScoreAdjustments ?? {},
    candidateObjective: options?.candidateObjective,
    allowGenericCandidateFallback: options?.allowGenericCandidateFallback === true,
    previousMovingLegId: options?.previousMovingLegId,
    activeMovingLegId: options?.activeMovingLegId,
  };
}

function pushReason(
  reasons: LegIneligibilityReason[],
  reason: LegIneligibilityReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

function stateIsLoadedSupport(state: LocomotionLegPolicyState): boolean {
  return state.planted && state.loaded && state.valid;
}

/**
 * Selects at most one already-planted foot. There is no anatomical sequence:
 * geometry, score improvement, support spread, and optional recent-leg history
 * determine the winner; stable semantic IDs are used only for exact tie breaks.
 */
export class LegSelector {
  select(request: LegSelectionRequest): LegSelectionResult {
    const options = normalizeOptions(request.options);
    const orderedLegs = request.legs
      .slice()
      .sort((left, right) => left.legId.localeCompare(right.legId));
    const loadedSupportCount = orderedLegs.filter(stateIsLoadedSupport).length;
    const diagnostics: LegEligibilityDiagnostic[] = [];
    const selections: MutableSelection[] = [];

    for (const leg of orderedLegs) {
      const reasons: LegIneligibilityReason[] = [];
      if (options.activeMovingLegId) {
        pushReason(reasons, "another-leg-is-moving");
      }
      if (!leg.planted) {
        pushReason(reasons, "not-planted");
      }
      if (!leg.loaded) {
        pushReason(reasons, "not-loaded");
      }
      if (!leg.valid || !leg.address) {
        pushReason(reasons, "invalid-current-contact");
      }

      const remainingLoadedSupportCount = loadedSupportCount - (stateIsLoadedSupport(leg) ? 1 : 0);
      if (remainingLoadedSupportCount < options.minimumSupportFootCount) {
        pushReason(reasons, "insufficient-remaining-support");
      }

      const predictedMaximumReachRatio = this.predictRemainingReachRatio(
        leg.legId,
        orderedLegs,
        request.intent.desiredDirection,
        options.expectedBodyAdvanceDistance,
      );
      if (
        !Number.isFinite(predictedMaximumReachRatio) ||
        predictedMaximumReachRatio > options.maximumRemainingReachRatio
      ) {
        pushReason(reasons, "remaining-reach-unsafe");
      }

      const legCandidates = request.candidates.filter((candidate) =>
        candidate.legId === leg.legId &&
        candidate.score.scored &&
        candidate.score.valid &&
        candidate.rejectionReasons.length === 0);
      const currentContact = legCandidates.find((candidate) => candidate.isCurrentContact);
      const alternatives = legCandidates
        .filter((candidate) => !candidate.isCurrentContact)
        .sort(compareFootholdCandidates);
      if (alternatives.length === 0) {
        pushReason(reasons, "no-valid-candidate");
      }
      if (!currentContact) {
        pushReason(reasons, "no-current-contact-baseline");
      }

      const currentSupportSpacing = currentContact?.signals.supportSpacing ?? 0;
      const sufficientlySpaced = alternatives.filter(
        (candidate) => candidate.nearestSupportDistance >= options.minimumSupportSpacing,
      );
      if (alternatives.length > 0 && sufficientlySpaced.length === 0) {
        pushReason(reasons, "support-spacing-too-narrow");
      }
      const broadlySupported = sufficientlySpaced.filter(
        (candidate) =>
          candidate.signals.supportSpacing >=
          currentSupportSpacing - options.maximumSupportSpacingLoss,
      );
      if (sufficientlySpaced.length > 0 && broadlySupported.length === 0) {
        pushReason(reasons, "support-spacing-reduced");
      }

      let bestCandidate: FootholdCandidate | undefined;
      if (currentContact) {
        const genericCandidate = broadlySupported.find((candidate) =>
          candidate.progressTowardDestination >= options.minimumProgressImprovement &&
          candidate.score.total - currentContact.score.total >=
            options.minimumScoreImprovement);
        if (options.candidateObjective) {
          bestCandidate = broadlySupported.find((candidate) =>
            options.candidateObjective?.(leg, currentContact, candidate) === true);
          if (!bestCandidate && options.allowGenericCandidateFallback) {
            bestCandidate = genericCandidate;
          }
          if (broadlySupported.length > 0 && !bestCandidate) {
            pushReason(reasons, "candidate-objective-unsatisfied");
          }
        } else {
          bestCandidate = genericCandidate;
          if (alternatives.length > 0 && !bestCandidate) {
            pushReason(reasons, "no-current-contact-improvement");
          }
        }
      }

      const bestScore = bestCandidate?.score.total ?? Number.NEGATIVE_INFINITY;
      const currentScore = currentContact?.score.total ?? Number.NEGATIVE_INFINITY;
      const scoreImprovement =
        Number.isFinite(bestScore) && Number.isFinite(currentScore)
          ? bestScore - currentScore
          : Number.NEGATIVE_INFINITY;
      const historyScoreAdjustment = finiteOr(
        options.historyScoreAdjustments[leg.legId],
        0,
      );
      diagnostics.push({
        legId: leg.legId,
        eligible: reasons.length === 0,
        reasons,
        validCandidateCount: alternatives.length,
        currentContactScore: currentScore,
        bestCandidateScore: bestScore,
        scoreImprovement,
        remainingLoadedSupportCount,
        predictedMaximumReachRatio,
        currentSupportSpacing,
        candidateSupportSpacing: bestCandidate?.signals.supportSpacing ?? 0,
        historyScoreAdjustment,
      });

      if (reasons.length === 0 && bestCandidate && currentContact) {
        const repeatPenalty = options.previousMovingLegId === leg.legId
          ? options.repeatLegPenalty
          : 0;
        const selectionScore =
          bestCandidate.score.total +
          bestCandidate.signals.supportSpacing * options.supportSpacingPreference -
          repeatPenalty +
          historyScoreAdjustment;
        selections.push({
          candidate: bestCandidate,
          plan: {
            legId: leg.legId,
            candidate: bestCandidate,
            currentContact,
            selectionScore,
            scoreImprovement,
            remainingLoadedSupportCount,
            predictedMaximumReachRatio,
            historyScoreAdjustment,
          },
        });
      }
    }

    selections.sort((left, right) =>
      right.plan.selectionScore - left.plan.selectionScore ||
      right.plan.scoreImprovement - left.plan.scoreImprovement ||
      compareFootholdCandidates(left.candidate, right.candidate));
    const selection = selections[0]?.plan ?? null;
    return {
      selection,
      diagnostics,
      failureReason: options.activeMovingLegId
        ? "another-leg-is-moving"
        : selection
          ? "none"
          : "no-eligible-leg",
    };
  }

  private predictRemainingReachRatio(
    movingLegId: LocomotionLegPolicyState["legId"],
    legs: readonly LocomotionLegPolicyState[],
    direction: { readonly x: number; readonly y: number; readonly z: number },
    bodyAdvanceDistance: number,
  ): number {
    let maximumRatio = 0;
    for (const leg of legs) {
      if (leg.legId === movingLegId || !stateIsLoadedSupport(leg)) {
        continue;
      }
      if (!Number.isFinite(leg.maximumReach) || leg.maximumReach <= 0) {
        return Infinity;
      }
      const originX = leg.reachOriginWorldPosition.x + direction.x * bodyAdvanceDistance;
      const originY = leg.reachOriginWorldPosition.y + direction.y * bodyAdvanceDistance;
      const originZ = leg.reachOriginWorldPosition.z + direction.z * bodyAdvanceDistance;
      const distance = Math.hypot(
        leg.contactPosition.x - originX,
        leg.contactPosition.y - originY,
        leg.contactPosition.z - originZ,
      );
      maximumRatio = Math.max(maximumRatio, distance / leg.maximumReach);
    }
    return maximumRatio;
  }
}
