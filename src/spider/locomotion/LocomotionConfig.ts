import type { FootholdScoreWeights } from "./LocomotionTypes";
import { DEFAULT_FOOTHOLD_SCORE_WEIGHTS } from "./FootholdScorer";

export interface LocomotionDebugToggles {
  showDestination: boolean;
  showTravelDirection: boolean;
  showEligibleLegs: boolean;
  showRejectedLegs: boolean;
  showCandidates: boolean;
  showCandidateScores: boolean;
  showWinner: boolean;
  showStepState: boolean;
  showSwingCurve: boolean;
  showMovingFoot: boolean;
  showSupportSet: boolean;
  showSupportPolygon: boolean;
  showProbeForce: boolean;
  showLoadTransfer: boolean;
  showBodyAdvance: boolean;
  showFailure: boolean;
}

export interface LocomotionConfig {
  minimumSupportFootCount: number;
  candidateSearchRadius: number;
  candidateSamplingDensity: number;
  /** Multiplier applied to minimum reach for new candidates, not current baselines. */
  minimumCandidateReachSafetyFactor: number;
  minimumCandidateImprovement: number;
  minimumProgressImprovement: number;
  maximumRemainingReachRatio: number;
  minimumFootSpacing: number;
  swingDuration: number;
  liftHeight: number;
  /** Minimum semantic distance from the mid-swing curve to other active silk. */
  minimumSwingClearance: number;
  approachAngleDegrees: number;
  testingDuration: number;
  probeForce: number;
  plantingDuration: number;
  loadTransferDuration: number;
  bodyAdvanceDuration: number;
  bodyAdvanceDistance: number;
  maximumLocalRouteDistance: number;
  lookaheadDistance: number;
  freezeAfterPlanning: boolean;
  scoreWeights: FootholdScoreWeights;
  debug: LocomotionDebugToggles;
}

export const locomotionConfig: LocomotionConfig = {
  minimumSupportFootCount: 5,
  candidateSearchRadius: 0.78,
  candidateSamplingDensity: 11,
  minimumCandidateReachSafetyFactor: 1,
  minimumCandidateImprovement: 0.08,
  minimumProgressImprovement: 0.08,
  maximumRemainingReachRatio: 0.97,
  minimumFootSpacing: 0.13,
  swingDuration: 0.82,
  liftHeight: 0.18,
  minimumSwingClearance: 0.035,
  approachAngleDegrees: 34,
  testingDuration: 0.3,
  probeForce: 0.18,
  plantingDuration: 0.14,
  loadTransferDuration: 0.48,
  bodyAdvanceDuration: 0.55,
  bodyAdvanceDistance: 0.1,
  maximumLocalRouteDistance: 1.45,
  lookaheadDistance: 0.52,
  freezeAfterPlanning: false,
  scoreWeights: { ...DEFAULT_FOOTHOLD_SCORE_WEIGHTS },
  debug: {
    showDestination: true,
    showTravelDirection: true,
    showEligibleLegs: true,
    showRejectedLegs: false,
    showCandidates: true,
    showCandidateScores: false,
    showWinner: true,
    showStepState: true,
    showSwingCurve: true,
    showMovingFoot: true,
    showSupportSet: true,
    showSupportPolygon: true,
    showProbeForce: true,
    showLoadTransfer: true,
    showBodyAdvance: true,
    showFailure: true,
  },
};
