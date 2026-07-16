import type {
  FootholdCandidate,
  FootholdScore,
  FootholdScoreComponent,
  FootholdScoreWeights,
} from "./LocomotionTypes";

export const DEFAULT_FOOTHOLD_SCORE_WEIGHTS: Readonly<FootholdScoreWeights> = Object.freeze({
  progress: 5,
  comfortableReach: 1.35,
  homePreference: 1,
  strandStability: 1,
  futureConnectivity: 0.65,
  supportSpacing: 1.4,
  reachBoundary: 1.6,
  jointLimitViolation: 2.5,
  bodyRotation: 0.75,
  footCrowding: 1.6,
  legCrossing: 1,
  weakOrMovingStrand: 1.4,
  reducedSupportStability: 1.8,
});

function component(): FootholdScoreComponent {
  return { value: 0, weight: 0, contribution: 0 };
}

/** Preallocates the complete inspectable score breakdown for one candidate. */
export function createFootholdScore(): FootholdScore {
  return {
    total: 0,
    positive: 0,
    negative: 0,
    scored: false,
    valid: false,
    components: {
      progress: component(),
      comfortableReach: component(),
      homePreference: component(),
      strandStability: component(),
      futureConnectivity: component(),
      supportSpacing: component(),
      reachBoundary: component(),
      jointLimitViolation: component(),
      bodyRotation: component(),
      footCrowding: component(),
      legCrossing: component(),
      weakOrMovingStrand: component(),
      reducedSupportStability: component(),
    },
  };
}

function clampSignal(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

function setComponent(
  target: FootholdScoreComponent,
  value: number,
  weight: number,
  sign: 1 | -1,
): number {
  target.value = clampSignal(value);
  target.weight = weight;
  target.contribution = sign * target.value * weight;
  return target.contribution;
}

function mergeWeights(overrides: Partial<FootholdScoreWeights>): FootholdScoreWeights {
  const weights = { ...DEFAULT_FOOTHOLD_SCORE_WEIGHTS, ...overrides };
  for (const [name, value] of Object.entries(weights)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Foothold score weight ${name} must be finite and non-negative.`);
    }
  }
  return weights;
}

/**
 * Understandable additive policy:
 *
 * `score = sum(positiveWeight * signal) - sum(penaltyWeight * signal)`.
 *
 * Every normalized signal, configured weight, and signed contribution remains
 * on `candidate.score.components` for UI/debug inspection.
 */
export class FootholdScorer {
  private weightsValue: FootholdScoreWeights;

  constructor(weights: Partial<FootholdScoreWeights> = {}) {
    this.weightsValue = mergeWeights(weights);
  }

  get weights(): Readonly<FootholdScoreWeights> {
    return this.weightsValue;
  }

  setWeights(weights: Partial<FootholdScoreWeights>): void {
    this.weightsValue = mergeWeights({ ...this.weightsValue, ...weights });
  }

  score(candidate: FootholdCandidate): FootholdScore {
    const weights = this.weightsValue;
    const values = candidate.signals;
    const components = candidate.score.components;

    let positive = 0;
    positive += setComponent(components.progress, values.progress, weights.progress, 1);
    positive += setComponent(
      components.comfortableReach,
      values.comfortableReach,
      weights.comfortableReach,
      1,
    );
    positive += setComponent(
      components.homePreference,
      values.homePreference,
      weights.homePreference,
      1,
    );
    positive += setComponent(
      components.strandStability,
      values.strandStability,
      weights.strandStability,
      1,
    );
    positive += setComponent(
      components.futureConnectivity,
      values.futureConnectivity,
      weights.futureConnectivity,
      1,
    );
    positive += setComponent(
      components.supportSpacing,
      values.supportSpacing,
      weights.supportSpacing,
      1,
    );

    let signedPenalties = 0;
    signedPenalties += setComponent(
      components.reachBoundary,
      values.reachBoundary,
      weights.reachBoundary,
      -1,
    );
    signedPenalties += setComponent(
      components.jointLimitViolation,
      values.jointLimitViolation,
      weights.jointLimitViolation,
      -1,
    );
    signedPenalties += setComponent(
      components.bodyRotation,
      values.bodyRotation,
      weights.bodyRotation,
      -1,
    );
    signedPenalties += setComponent(
      components.footCrowding,
      values.footCrowding,
      weights.footCrowding,
      -1,
    );
    signedPenalties += setComponent(
      components.legCrossing,
      values.legCrossing,
      weights.legCrossing,
      -1,
    );
    signedPenalties += setComponent(
      components.weakOrMovingStrand,
      values.weakOrMovingStrand,
      weights.weakOrMovingStrand,
      -1,
    );
    signedPenalties += setComponent(
      components.reducedSupportStability,
      values.reducedSupportStability,
      weights.reducedSupportStability,
      -1,
    );

    const valid = candidate.rejectionReasons.length === 0;
    candidate.score.positive = positive;
    candidate.score.negative = -signedPenalties;
    candidate.score.total = valid ? positive + signedPenalties : Number.NEGATIVE_INFINITY;
    candidate.score.valid = valid;
    candidate.score.scored = true;
    return candidate.score;
  }

  scoreAll(candidates: readonly FootholdCandidate[]): void {
    for (const candidate of candidates) {
      this.score(candidate);
    }
  }

  /** Returns a deterministic ranking without mutating generator order. */
  rank(candidates: readonly FootholdCandidate[], includeRejected = false): FootholdCandidate[] {
    const ranked = candidates.filter((candidate) => {
      if (!candidate.score.scored) {
        this.score(candidate);
      }
      return includeRejected || candidate.score.valid;
    });
    ranked.sort(compareFootholdCandidates);
    return ranked;
  }
}

export function compareFootholdCandidates(
  left: FootholdCandidate,
  right: FootholdCandidate,
): number {
  return (
    right.score.total - left.score.total ||
    right.progressTowardDestination - left.progressTowardDestination ||
    right.signals.supportSpacing - left.signals.supportSpacing ||
    left.legId.localeCompare(right.legId) ||
    left.strandId.localeCompare(right.strandId) ||
    left.t - right.t
  );
}
