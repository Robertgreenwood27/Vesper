import type {
  MutableVec3,
  PlannedRoute,
  RouteTransition,
  StrandAddress,
  Vec3Like,
} from "../../traversal/index";
import type {
  FootholdLegContext,
  JointFeasibilityTest,
  LocomotionLegPolicyState,
  LocomotionSupportContact,
} from "../locomotion/index";
import type { SpiderLegId } from "../SpiderRigSpec";

/** Coordinator states deliberately remain above the Phase 7 atomic-step states. */
export const TRAVERSAL_STATES = [
  "idle",
  "resolving-route",
  "planning-step",
  "executing-step",
  "settling",
  "testing-junction",
  "establishing-branch-support",
  "committing-body",
  "clearing-trailing-legs",
  "arrived",
  "failed",
  "cancelled",
] as const;

export type TraversalState = (typeof TRAVERSAL_STATES)[number];

export type TraversalStopReason =
  | "none"
  | "destination-reached"
  | "maximum-step-count"
  | "repeated-planning-failure"
  | "support-instability"
  | "route-invalid"
  | "atomic-step-failure"
  | "local-recovery-exhausted"
  | "user-cancelled";

export type TraversalStepOutcome = "complete" | "failed" | "cancelled";

export interface TraversalSchedulerConfig {
  readonly maximumStepCount: number;
  readonly settleDurationSeconds: number;
  readonly maximumConsecutivePlanningFailures: number;
  readonly routeLookaheadDistance: number;
  readonly arrivalMaterialTolerance: number;
  readonly arrivalWorldTolerance: number;
}

export interface LegHistoryConfig {
  readonly recentStepWindow: number;
  readonly leadingTrailingDeadZone: number;
  readonly recentLegPenalty: number;
  readonly immediateRepeatPenalty: number;
  readonly trailingLegUrgency: number;
  readonly trailingReachThreshold: number;
  readonly foldedLegUrgency: number;
  readonly foldedReachThreshold: number;
  readonly destinationBreadthReward: number;
  readonly alternationReward: number;
  readonly destinationFrontCrowdingPenalty: number;
  readonly sideImbalancePenalty: number;
  readonly futureFlexibilityReward: number;
}

export interface JunctionCommitmentConfig {
  readonly destinationSideSupportThreshold: number;
  readonly minimumDestinationSideMaterialDistance: number;
  readonly minimumDestinationSideWorldSpread: number;
  readonly requireBilateralDestinationSupport: boolean;
  readonly trailingReachLimit: number;
  readonly bodyCrossingDistance: number;
  readonly clearBodyDistance: number;
  readonly stableLoadedSupportThreshold: number;
}

export interface BodyOrientationConfig {
  readonly maximumTranslationPerStep: number;
  readonly maximumRotationRadiansPerStep: number;
  readonly maximumReachSafetyFactor: number;
  readonly minimumReachSafetyFactor: number;
  readonly bodyEnvelopeRadiusForward: number;
  readonly bodyEnvelopeRadiusRight: number;
  readonly bodyEnvelopeRadiusUp: number;
  readonly minimumSilkClearance: number;
  readonly clampIterations: number;
  readonly minimumAcceptedFraction: number;
  readonly destinationSupportNormalWeight: number;
}

export interface LocalRecoveryConfig {
  readonly searchRadius: number;
  readonly maximumAttempts: number;
  readonly sameStrandSampleCount: number;
  readonly connectedStrandSampleCount: number;
  readonly maximumJunctionDistance: number;
  readonly minimumFootSpacing: number;
}

export interface TraversalPolicyConfig {
  readonly scheduler: TraversalSchedulerConfig;
  readonly history: LegHistoryConfig;
  readonly junction: JunctionCommitmentConfig;
  readonly orientation: BodyOrientationConfig;
  readonly recovery: LocalRecoveryConfig;
}

export interface LegHistoryObservation {
  readonly legId: SpiderLegId;
  readonly stepIndex: number;
  readonly currentReachRatio: number;
  /** Normalized [0, 1] estimate of how important this foot is to current support. */
  readonly supportUsefulness: number;
  readonly contactWorldPosition: Vec3Like;
  readonly bodyCenter: Vec3Like;
  readonly routeDirection: Vec3Like;
  readonly destinationSide: boolean;
}

export interface LegStepOutcomeRecord {
  readonly legId: SpiderLegId;
  readonly stepIndex: number;
  readonly outcome: TraversalStepOutcome;
  readonly destinationSideAfter?: boolean;
  readonly reachRatioAfter?: number;
}

export interface LegHistorySnapshot {
  readonly legId: SpiderLegId;
  lastMovedStepIndex: number;
  recentMovementCount: number;
  totalMovementCount: number;
  currentReachRatio: number;
  currentSupportUsefulness: number;
  leading: boolean;
  trailing: boolean;
  routeOffset: number;
  destinationSide: boolean;
  lastOutcome: TraversalStepOutcome | "none";
}

export interface LegHistoryCandidateContext {
  readonly destinationSide?: boolean;
  readonly predictedReachRatio?: number;
  readonly predictedSupportUsefulness?: number;
}

export type LegHistoryScoreComponentName =
  | "recency-penalty"
  | "immediate-repeat-penalty"
  | "trailing-urgency"
  | "folded-leg-urgency"
  | "destination-breadth"
  | "alternation"
  | "front-crowding-penalty"
  | "side-imbalance-penalty"
  | "future-flexibility";

export interface LegHistoryScoreComponent {
  readonly name: LegHistoryScoreComponentName;
  value: number;
  weight: number;
  contribution: number;
}

export interface LegHistoryScoreInfluence {
  readonly legId: SpiderLegId;
  total: number;
  readonly components: Record<LegHistoryScoreComponentName, LegHistoryScoreComponent>;
}

export interface LegHistoryScoreInput {
  readonly legId: SpiderLegId;
  readonly stepIndex: number;
  readonly candidate?: LegHistoryCandidateContext;
  /** Set when another currently eligible leg has comparable base policy value. */
  readonly alternateUsefulLegAvailable?: boolean;
}

export type LegSelectionScoreAdjustments = Partial<Record<SpiderLegId, number>>;

export type JunctionContactInput = Pick<
  LocomotionLegPolicyState,
  | "legId"
  | "planted"
  | "loaded"
  | "valid"
  | "address"
  | "contactPosition"
  | "currentReachRatio"
>;

export type JunctionContactSide =
  | "approach"
  | "junction"
  | "destination"
  | "off-route";

export interface JunctionContactClassification {
  readonly legId: SpiderLegId;
  readonly address: StrandAddress | null;
  side: JunctionContactSide;
  routeDistance: number;
  distancePastJunction: number;
  loadedAndValid: boolean;
  currentReachRatio: number;
}

export type JunctionTransitionPhase =
  | "approaching"
  | "exploring"
  | "establishing-support"
  | "ready-to-commit"
  | "committed"
  | "clearing-trailing-legs"
  | "cleared";

export interface JunctionProgressRequest {
  readonly route: PlannedRoute;
  readonly junctionNodeId: string;
  readonly approachStrandId: string;
  readonly destinationBranchStrandId: string;
  /** Explicit semantic support regions may include parallel, non-route silk. */
  readonly approachSupportStrandIds?: ReadonlySet<string>;
  readonly destinationSupportStrandIds?: ReadonlySet<string>;
  readonly bodyCenter: Vec3Like;
  readonly contacts: readonly JunctionContactInput[];
  readonly currentAddress?: StrandAddress;
  readonly predictedOrientationReachSafe?: boolean;
  readonly supportStable?: boolean;
}

export interface JunctionProgressEstimate {
  valid: boolean;
  message: string;
  phase: JunctionTransitionPhase;
  readonly junctionNodeId: string;
  readonly approachStrandId: string;
  readonly destinationBranchStrandId: string;
  nextTransition: RouteTransition | null;
  currentRouteStrandId: string | null;
  junctionRouteDistance: number;
  bodyCenterDistancePastJunction: number;
  bodyCenterCrossed: boolean;
  destinationSideLoadedCount: number;
  approachSideLoadedCount: number;
  destinationLeftCount: number;
  destinationRightCount: number;
  destinationSideSpread: number;
  criticalTrailingReachCount: number;
  stableLoadedSupportCount: number;
  commitmentRatio: number;
  mayCommitBody: boolean;
  junctionCleared: boolean;
  readonly contacts: JunctionContactClassification[];
}

export interface TraversalBodyFrame {
  readonly position: Vec3Like;
  readonly forward: Vec3Like;
  readonly up: Vec3Like;
  readonly right: Vec3Like;
}

/** Semantic position of a planted foot while support migrates around a turn. */
export type CircumferentialContactRegion =
  | "above-current-plane"
  | "beside-current-plane"
  | "below-current-plane"
  | "destination-plane"
  | "trailing-old-plane";

export interface CircumferentialContactClassification {
  readonly legId: SpiderLegId;
  readonly region: CircumferentialContactRegion;
  /** Signed angle around the current thorax forward axis, in radians. */
  readonly angleRadians: number;
  readonly loadedAndValid: boolean;
}

/** Multi-axis posture state used by non-coplanar junction transitions. */
export type JunctionPosturePhase =
  | "approach"
  | "entering-rotation"
  | "building-destination-support"
  | "rotating-body"
  | "clearing-upper-trailing-legs"
  | "aligned-with-branch"
  | "final-approach"
  | "arrived";

export interface BodyOrientationContact {
  readonly legId: SpiderLegId;
  readonly contactWorldPosition: Vec3Like;
  readonly reachOriginWorldPosition: Vec3Like;
  readonly maximumReach: number;
  readonly minimumReach?: number;
  readonly referenceUp?: Vec3Like;
  readonly loaded: boolean;
  readonly valid: boolean;
  readonly destinationSide?: boolean;
  readonly strandId?: string;
}

export interface BodyEnvelope {
  readonly forwardRadius: number;
  readonly rightRadius: number;
  readonly upRadius: number;
}

export type BodyClearanceQuery = (
  position: Vec3Like,
  frame: Omit<TraversalBodyFrame, "position">,
  envelope: BodyEnvelope,
) => number;

export interface BodyOrientationPlanRequest {
  readonly currentFrame: TraversalBodyFrame;
  readonly routeDirection: Vec3Like;
  /**
   * Stable semantic orientation of the destination support geometry. When
   * supplied, it replaces contact normals derived from the current body pose.
   */
  readonly targetOrientationFrame?: Pick<
    TraversalBodyFrame,
    "forward" | "up" | "right"
  >;
  readonly contacts: readonly BodyOrientationContact[];
  readonly desiredBodyPosition?: Vec3Like;
  readonly clearanceQuery?: BodyClearanceQuery;
  readonly clearanceStrandIds?: ReadonlySet<string>;
}

export interface PredictedLegReach {
  readonly legId: SpiderLegId;
  distance: number;
  ratio: number;
  withinLimits: boolean;
}

export type BodyOrientationFailureReason =
  | "none"
  | "non-finite-input"
  | "invalid-current-frame"
  | "no-valid-support"
  | "reach-blocked"
  | "clearance-blocked"
  | "continuity-blocked";

export interface BodyOrientationPlan {
  success: boolean;
  failureReason: BodyOrientationFailureReason;
  message: string;
  readonly proposedFrame: {
    position: MutableVec3;
    forward: MutableVec3;
    up: MutableVec3;
    right: MutableVec3;
  };
  readonly acceptedFrame: {
    position: MutableVec3;
    forward: MutableVec3;
    up: MutableVec3;
    right: MutableVec3;
  };
  requestedTranslation: number;
  plannedTranslation: number;
  requestedRotationRadians: number;
  plannedRotationRadians: number;
  acceptedFraction: number;
  clampedByTranslationLimit: boolean;
  clampedByRotationLimit: boolean;
  clampedByReach: boolean;
  clampedByClearance: boolean;
  frameSignContinuous: boolean;
  minimumClearance: number;
  maximumPredictedReachRatio: number;
  limitingLegId: SpiderLegId | null;
  readonly predictedReaches: PredictedLegReach[];
}

export type LocalRecoveryCandidateSource = "same-strand" | "connected-strand";

export type LocalRecoveryRejectionReason =
  | "inactive-strand"
  | "broken-strand"
  | "outside-search-radius"
  | "outside-reach"
  | "inside-minimum-reach"
  | "support-crowding"
  | "joint-infeasible"
  | "custom-rejection"
  | "non-finite-query";

export interface LocalRecoveryCandidateValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

export type LocalRecoveryCandidateValidator = (
  address: StrandAddress,
  worldPosition: Vec3Like,
) => LocalRecoveryCandidateValidation;

export interface LocalRecoveryCandidate {
  readonly source: LocalRecoveryCandidateSource;
  readonly address: StrandAddress;
  readonly worldPosition: MutableVec3;
  readonly connectedViaNodeId: string | null;
  accepted: boolean;
  score: number;
  materialDistanceFromExpected: number;
  reachRatio: number;
  routeAlignment: number;
  localTension: number;
  localVelocityMagnitude: number;
  readonly rejectionReasons: LocalRecoveryRejectionReason[];
  readonly rejectionDetails: string[];
}

export interface LocalRecoveryRequest {
  readonly leg: FootholdLegContext;
  readonly expectedAddress: StrandAddress;
  readonly supports: readonly LocomotionSupportContact[];
  readonly routeDirection: Vec3Like;
  readonly junctionNodeId?: string;
  readonly jointFeasibility?: JointFeasibilityTest;
  readonly validateCandidate?: LocalRecoveryCandidateValidator;
}

export interface LocalRecoveryResult {
  readonly legId: SpiderLegId;
  readonly expectedAddress: StrandAddress;
  readonly candidates: LocalRecoveryCandidate[];
  readonly accepted: LocalRecoveryCandidate[];
  readonly rejected: LocalRecoveryCandidate[];
  attemptedCount: number;
  exhausted: boolean;
  selected: LocalRecoveryCandidate | null;
}
