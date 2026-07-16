import type {
  MutableVec3,
  PlannedRoute,
  RouteDestination,
  StrandAddress,
  Vec3Like,
} from "../../traversal/index";
import type { SpiderLegId, SpiderReachSpec } from "../SpiderRigSpec";

/** The player-facing input remains a semantic web destination. */
export type SpiderIntentDestination = RouteDestination;

export interface SpiderIntentRequest {
  /** A planted semantic address used as the route origin. */
  readonly currentAddress: StrandAddress;
  readonly destination: SpiderIntentDestination;
  /** Optional body/support origin. Defaults to the current strand position. */
  readonly worldOrigin?: Vec3Like;
}

export interface SpiderIntentOptions {
  /** Distance sampled along the semantic route to form the local steering target. */
  readonly lookaheadDistance?: number;
  /** Hard cap on route data handed to the one-step policy. */
  readonly maximumLocalRouteDistance?: number;
  /** Reject a destination whose resolved route begins farther away than this. */
  readonly maximumAcceptedRouteDistance?: number;
}

export interface LocalIntentRouteSegment {
  readonly strandId: string;
  readonly fromT: number;
  readonly toT: number;
  readonly materialDistance: number;
  readonly entryNodeId?: string;
  readonly exitNodeId?: string;
}

export interface ResolvedSpiderIntent {
  readonly request: SpiderIntentRequest;
  readonly route: PlannedRoute;
  /** A clipped semantic prefix; it never contains simulation-particle identities. */
  readonly localRoute: readonly LocalIntentRouteSegment[];
  readonly originPosition: MutableVec3;
  readonly destinationPosition: MutableVec3;
  readonly localTargetPosition: MutableVec3;
  readonly localTargetAddress?: StrandAddress;
  /** Unit world-space direction toward the short local route target. */
  readonly desiredDirection: MutableVec3;
  readonly routeDistance: number;
  readonly localRouteDistance: number;
  readonly directDistance: number;
  readonly requiresAdditionalSteps: boolean;
}

export type SpiderIntentFailureReason =
  | "invalid-origin"
  | "destination-unreachable"
  | "route-too-distant"
  | "non-finite-route"
  | "no-travel-direction";

export type SpiderIntentResolution =
  | { readonly ok: true; readonly intent: ResolvedSpiderIntent }
  | {
      readonly ok: false;
      readonly reason: SpiderIntentFailureReason;
      readonly message: string;
    };

export interface LocomotionSupportFrame {
  readonly center: Vec3Like;
  readonly forward: Vec3Like;
  readonly up: Vec3Like;
  readonly right: Vec3Like;
}

export interface FootholdLegContext {
  readonly legId: SpiderLegId;
  readonly footHomeWorldPosition: Vec3Like;
  readonly reachOriginWorldPosition: Vec3Like;
  /** Model-space reach from the rig specification. */
  readonly reach: SpiderReachSpec;
  readonly reachScale?: number;
  readonly currentAddress: StrandAddress;
  readonly currentWorldPosition?: Vec3Like;
  /** Lets a controller omit a leg before doing any strand search. */
  readonly eligible?: boolean;
}

export interface LocomotionSupportContact {
  readonly legId: SpiderLegId;
  readonly address: StrandAddress;
  readonly position: Vec3Like;
  readonly planted: boolean;
  readonly loaded: boolean;
  readonly valid: boolean;
  readonly loadNewtons?: number;
}

export interface JointFeasibilityResult {
  readonly feasible: boolean;
  /** Normalized diagnostic magnitude; zero is within the intended limits. */
  readonly violation?: number;
  readonly reason?: string;
}

export type JointFeasibilityTest = (
  leg: FootholdLegContext,
  address: StrandAddress,
  worldPosition: Vec3Like,
) => JointFeasibilityResult;

export interface FootholdRiskEstimate {
  /** Normalized [0, 1] estimate of body reorientation demanded by this contact. */
  readonly bodyRotation?: number;
  /** Normalized [0, 1] estimate of crossing another leg's working region. */
  readonly legCrossing?: number;
}

export type FootholdRiskEstimator = (
  leg: FootholdLegContext,
  address: StrandAddress,
  worldPosition: Vec3Like,
) => FootholdRiskEstimate;

export interface FootholdCandidateValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Optional scenario/coordinator gate; current planted baselines are never gated. */
export type FootholdCandidateValidator = (
  leg: FootholdLegContext,
  address: StrandAddress,
  worldPosition: Vec3Like,
) => FootholdCandidateValidation;

/**
 * Optional higher-level seed labels. They identify why an additional semantic
 * neighborhood was inspected; they do not bypass any normal candidate gate.
 */
export type FootholdCandidateSeedSource =
  | "target-frame-foot-home"
  | "predicted-body-advance-foot-home"
  | "destination-contact-frame"
  | "connected-support"
  | "reach-recovery";

interface FootholdCandidateSeedBase {
  readonly legId: SpiderLegId;
  readonly source: FootholdCandidateSeedSource;
  /**
   * Material-space radius used for the two deterministic neighboring samples.
   * The generator always clamps this to its configured world search radius.
   */
  readonly neighborMaterialRadius?: number;
}

/** A seed that is already a continuous semantic strand address. */
export interface FootholdContinuousCandidateSeed extends FootholdCandidateSeedBase {
  readonly kind: "continuous-address";
  readonly address: StrandAddress;
}

/**
 * A world-space seed projected only onto the explicitly authorized strands.
 * Projection produces continuous `{ strandId, t }` addresses; particle indices
 * never leave StrandTraversal.
 */
export interface FootholdWorldCandidateSeed extends FootholdCandidateSeedBase {
  readonly kind: "world-position";
  readonly worldPosition: Vec3Like;
  readonly authorizedStrandIds: readonly string[];
}

export type FootholdCandidateSeed =
  | FootholdContinuousCandidateSeed
  | FootholdWorldCandidateSeed;

export interface FootholdGenerationOptions {
  readonly searchRadius?: number;
  /** Number of local, evenly spaced material samples per inspected strand. */
  readonly samplesPerStrand?: number;
  readonly retainRejected?: boolean;
  readonly referenceUp?: Vec3Like;
  readonly tensionReference?: number;
  readonly velocityReference?: number;
  readonly minimumFootSpacing?: number;
  readonly minimumReachSafetyFactor?: number;
  readonly connectivityDegreeReference?: number;
}

export interface FootholdGenerationRequest {
  readonly intent: ResolvedSpiderIntent;
  readonly legs: readonly FootholdLegContext[];
  readonly supports: readonly LocomotionSupportContact[];
  readonly supportFrame: LocomotionSupportFrame;
  /** Optional semantic neighborhoods supplied by a repeated-step policy. */
  readonly candidateSeeds?: readonly FootholdCandidateSeed[];
  readonly options?: FootholdGenerationOptions;
  readonly jointFeasibility?: JointFeasibilityTest;
  readonly riskEstimator?: FootholdRiskEstimator;
  readonly candidateValidator?: FootholdCandidateValidator;
}

export type FootholdCandidateSource =
  | "current-contact"
  | "nearest-home"
  | "local-sample"
  | "route-target"
  | FootholdCandidateSeedSource;

export type FootholdRejectionReason =
  | "inactive-strand"
  | "broken-strand"
  | "outside-search-radius"
  | "inside-minimum-reach"
  | "outside-maximum-reach"
  | "impossible-joint-configuration"
  | "custom-candidate-rejection"
  | "non-finite-query";

/** Raw normalized policy signals. Positive and negative terms remain separate. */
export interface FootholdScoreSignals {
  progress: number;
  comfortableReach: number;
  homePreference: number;
  strandStability: number;
  futureConnectivity: number;
  supportSpacing: number;
  reachBoundary: number;
  jointLimitViolation: number;
  bodyRotation: number;
  footCrowding: number;
  legCrossing: number;
  weakOrMovingStrand: number;
  reducedSupportStability: number;
}

export type FootholdScoreComponentName = keyof FootholdScoreSignals;

export interface FootholdScoreComponent {
  value: number;
  weight: number;
  contribution: number;
}

export interface FootholdScoreComponents {
  progress: FootholdScoreComponent;
  comfortableReach: FootholdScoreComponent;
  homePreference: FootholdScoreComponent;
  strandStability: FootholdScoreComponent;
  futureConnectivity: FootholdScoreComponent;
  supportSpacing: FootholdScoreComponent;
  reachBoundary: FootholdScoreComponent;
  jointLimitViolation: FootholdScoreComponent;
  bodyRotation: FootholdScoreComponent;
  footCrowding: FootholdScoreComponent;
  legCrossing: FootholdScoreComponent;
  weakOrMovingStrand: FootholdScoreComponent;
  reducedSupportStability: FootholdScoreComponent;
}

export interface FootholdScore {
  total: number;
  positive: number;
  negative: number;
  scored: boolean;
  valid: boolean;
  components: FootholdScoreComponents;
}

export interface FootholdCandidate {
  readonly legId: SpiderLegId;
  readonly address: StrandAddress;
  readonly strandId: string;
  readonly t: number;
  readonly source: FootholdCandidateSource;
  readonly isCurrentContact: boolean;
  readonly worldPosition: MutableVec3;
  readonly tangent: MutableVec3;
  readonly normal: MutableVec3;
  readonly binormal: MutableVec3;
  readonly strandVelocity: MutableVec3;
  localTension: number;
  reachDistance: number;
  reachRatio: number;
  progressTowardDestination: number;
  distanceFromFootHome: number;
  approximateSupportContribution: number;
  nearestSupportDistance: number;
  signals: FootholdScoreSignals;
  rejectionReasons: FootholdRejectionReason[];
  readonly rejectionDetails: string[];
  score: FootholdScore;
}

export interface FootholdGenerationResult {
  readonly candidates: readonly FootholdCandidate[];
  readonly accepted: readonly FootholdCandidate[];
  readonly rejected: readonly FootholdCandidate[];
  readonly inspectedLegCount: number;
  readonly inspectedStrandCount: number;
}

export interface FootholdScoreWeights extends FootholdScoreSignals {}

export interface LocomotionLegPolicyState {
  readonly legId: SpiderLegId;
  readonly planted: boolean;
  readonly loaded: boolean;
  readonly valid: boolean;
  readonly address: StrandAddress | null;
  readonly contactPosition: Vec3Like;
  readonly reachOriginWorldPosition: Vec3Like;
  /** Maximum reach in world units, after model scale. */
  readonly maximumReach: number;
  readonly currentReachRatio: number;
}

/**
 * Required higher-level contact objective for one atomic selection. When
 * supplied, this callback replaces only the selector's generic local
 * score/progress-improvement test. Candidate validity, support, reach, and
 * spacing gates remain authoritative.
 */
export type FootholdCandidateObjective = (
  leg: LocomotionLegPolicyState,
  currentContact: FootholdCandidate,
  candidate: FootholdCandidate,
) => boolean;

export type LegIneligibilityReason =
  | "another-leg-is-moving"
  | "not-planted"
  | "not-loaded"
  | "invalid-current-contact"
  | "insufficient-remaining-support"
  | "remaining-reach-unsafe"
  | "no-valid-candidate"
  | "no-current-contact-baseline"
  | "no-current-contact-improvement"
  | "candidate-objective-unsatisfied"
  | "support-spacing-too-narrow"
  | "support-spacing-reduced";

export interface LegSelectionOptions {
  readonly minimumSupportFootCount?: number;
  readonly minimumScoreImprovement?: number;
  readonly minimumProgressImprovement?: number;
  readonly maximumRemainingReachRatio?: number;
  readonly expectedBodyAdvanceDistance?: number;
  readonly minimumSupportSpacing?: number;
  readonly maximumSupportSpacingLoss?: number;
  readonly supportSpacingPreference?: number;
  readonly repeatLegPenalty?: number;
  /**
   * Additive short-term policy influence supplied by a higher-level
   * coordinator. The atomic selector still owns every geometric and support
   * eligibility decision; history can only rank otherwise-valid choices.
   */
  readonly historyScoreAdjustments?: Readonly<Partial<Record<SpiderLegId, number>>>;
  /**
   * Required procedural contact objective. Matching candidates may trade away
   * generic local score/progress improvement, but bypass no hard selector gate.
   */
  readonly candidateObjective?: FootholdCandidateObjective;
  /**
   * If no hard-valid candidate satisfies the procedural objective, allow the
   * ordinary score/progress rule to rebalance support. The owning strategy must
   * provide the outer transaction/stagnation bound.
   */
  readonly allowGenericCandidateFallback?: boolean;
  readonly previousMovingLegId?: SpiderLegId;
  /** Non-null means a step is already moving a foot; selection is refused. */
  readonly activeMovingLegId?: SpiderLegId;
}

export interface LegSelectionRequest {
  readonly intent: ResolvedSpiderIntent;
  readonly candidates: readonly FootholdCandidate[];
  readonly legs: readonly LocomotionLegPolicyState[];
  readonly options?: LegSelectionOptions;
}

export interface LegEligibilityDiagnostic {
  readonly legId: SpiderLegId;
  readonly eligible: boolean;
  readonly reasons: readonly LegIneligibilityReason[];
  readonly validCandidateCount: number;
  readonly currentContactScore: number;
  readonly bestCandidateScore: number;
  readonly scoreImprovement: number;
  readonly remainingLoadedSupportCount: number;
  readonly predictedMaximumReachRatio: number;
  readonly currentSupportSpacing: number;
  readonly candidateSupportSpacing: number;
  readonly historyScoreAdjustment: number;
}

export interface SelectedLegPlan {
  readonly legId: SpiderLegId;
  readonly candidate: FootholdCandidate;
  readonly currentContact: FootholdCandidate;
  readonly selectionScore: number;
  readonly scoreImprovement: number;
  readonly remainingLoadedSupportCount: number;
  readonly predictedMaximumReachRatio: number;
  readonly historyScoreAdjustment: number;
}

export interface LegSelectionResult {
  readonly selection: SelectedLegPlan | null;
  readonly diagnostics: readonly LegEligibilityDiagnostic[];
  readonly failureReason: "none" | "another-leg-is-moving" | "no-eligible-leg";
}
