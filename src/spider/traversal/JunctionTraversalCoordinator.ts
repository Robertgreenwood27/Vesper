import type {
  PlannedRoute,
  RouteDestination,
  RouteTransition,
  StrandAddress,
} from "../../traversal";
import type { SpiderStepDiagnostics } from "../locomotion/LocomotionDiagnostics";
import type { SpiderStepFailureReason, SpiderStepState } from "../locomotion/SpiderStepState";
import type { SpiderLegId } from "../SpiderRigSpec";
import type { TransitionStrategyDirective } from "./TransitionStrategyController";
import {
  TRAVERSAL_STATES,
  type CircumferentialContactClassification,
  type JunctionProgressEstimate,
  type JunctionPosturePhase,
  type TraversalPolicyConfig,
  type TraversalState,
} from "./TraversalTypes";

export const JUNCTION_TRAVERSAL_STATES = TRAVERSAL_STATES;

export type JunctionTraversalState = TraversalState;

export type JunctionTraversalRunMode = "pause-after-step" | "run-until-arrival";

export type JunctionTraversalStopReason =
  | "none"
  | "destination-reached"
  | "maximum-step-count"
  | "planning-failure-limit"
  | "atomic-step-failed"
  | "support-instability"
  | "route-invalid"
  | "ik-failure"
  | "junction-test-failed"
  | "coupled-transfer-deadlock"
  | "angled-transition-stagnation"
  | "strategy-failed"
  | "recovery-exhausted"
  | "user-cancelled";

/**
 * Structural Phase 7 boundary. SpiderStepController satisfies this port, but
 * the coordinator deliberately knows no foot-contact or web-particle API.
 */
export interface AtomicSpiderStepPort {
  readonly state: SpiderStepState;
  readonly isExecuting: boolean;
  readonly restorationPending?: boolean;
  /** Structural pass-through used by the coupled transfer; the coordinator ignores it. */
  readonly failureRecoveryMode?: "reach-reserve";
  readonly diagnostics: Readonly<SpiderStepDiagnostics>;
  requestDestination(destination: RouteDestination, mode: "plan-only"): boolean;
  executePlannedStep(): boolean;
  update(fixedDeltaSeconds: number): void;
  cancel(): void;
}

export interface JunctionTraversalConfig {
  readonly maximumStepCount: number;
  readonly settleDurationSeconds: number;
  readonly maximumConsecutiveFailures: number;
  readonly maximumRecoveryAttempts: number;
  readonly maximumRestorationDurationSeconds: number;
  readonly maximumJunctionTestDurationSeconds: number;
  readonly minimumDestinationSideSupports: number;
  readonly minimumDestinationSideSpread: number;
  readonly maximumCriticalTrailingReachRatio: number;
  readonly maximumZeroProgressTransactions: number;
  readonly minimumUsefulBodyProgress: number;
  readonly minimumUsefulReachImprovement: number;
  readonly minimumUsefulAngularImprovement: number;
  readonly defaultRunMode: JunctionTraversalRunMode;
}

export const DEFAULT_JUNCTION_TRAVERSAL_CONFIG: JunctionTraversalConfig = {
  maximumStepCount: 14,
  settleDurationSeconds: 0.32,
  maximumConsecutiveFailures: 2,
  maximumRecoveryAttempts: 2,
  // Phase 7 permits a moving semantic contact up to 2 seconds to re-resolve.
  // The coordinator must not time out before that atomic recovery authority.
  maximumRestorationDurationSeconds: 2.25,
  maximumJunctionTestDurationSeconds: 1.5,
  minimumDestinationSideSupports: 3,
  minimumDestinationSideSpread: 0.08,
  maximumCriticalTrailingReachRatio: 0.92,
  maximumZeroProgressTransactions: 4,
  minimumUsefulBodyProgress: 0.001,
  minimumUsefulReachImprovement: 0.004,
  minimumUsefulAngularImprovement: Math.PI / 360,
  defaultRunMode: "pause-after-step",
};

export interface JunctionTraversalSafetySnapshot {
  readonly supportValid: boolean;
  readonly loadedSupportCount: number;
  readonly requiredSupportCount: number;
  readonly ikFailureActive: boolean;
  readonly footFailureActive: boolean;
  /** Omit until a route has been resolved. */
  readonly routeValid?: boolean;
  readonly message?: string;
}

/**
 * Semantic junction progress supplied by a policy/estimator. All values are
 * based on main web nodes, strands, held addresses, and the body frame rather
 * than simulation particles.
 */
export interface JunctionTraversalProgressSnapshot {
  readonly currentRouteStrandId: string | null;
  readonly currentJunctionNodeId: string | null;
  readonly nextRouteTransition: RouteTransition | null;
  readonly selectedDestinationBranchStrandId: string | null;
  readonly junctionEncountered: boolean;
  readonly bodyCenterBeyondJunction: boolean;
  readonly destinationSideLoadedContactCount: number;
  readonly destinationSideSpread: number;
  readonly trailingContactCount: number;
  readonly criticalTrailingReachRatio: number;
  /** Worst current reach ratio across every planted support, trailing or not. */
  readonly maximumReachRatio: number;
  readonly canCommitBody: boolean;
  readonly needsExploratoryTest: boolean;
  readonly routeComplete: boolean;
  readonly bodyNearDestination: boolean;
  readonly stableSupportNearDestination: boolean;
  readonly destinationReached: boolean;
  /** Continuous signed route distance; unlike the UI ratio this is not clamped before crossing. */
  readonly bodyCenterDistancePastJunction: number;
  /** Number of planted legs whose removal leaves a hard-valid support set. */
  readonly removableSupportCount: number;
  /** Worst finite body-edge margin across one-leg removal tests. */
  readonly worstRemovalBodyMargin: number;
  readonly bodyCenterProgress: number;
  /** Unclamped monotonic material progress along the selected branch. */
  readonly semanticRouteProgress: number;
  readonly nonCoplanarTransition: boolean;
  readonly posturePhase: JunctionPosturePhase;
  readonly branchFrameAngularError: number;
  readonly branchFrameForwardError: number;
  readonly branchFramePitchError: number;
  readonly branchFrameRollError: number;
  readonly destinationPlaneSupportCount: number;
  readonly circumferentialCoverage: number;
  readonly circumferentialContacts: readonly CircumferentialContactClassification[];
  /** Quantized semantic contacts/body posture for bounded cycle detection. */
  readonly contactStateFingerprint: string;
}

export interface JunctionTraversalArrivalEvidence {
  readonly routeComplete: boolean;
  readonly bodyNearDestination: boolean;
  readonly stableSupportNearDestination: boolean;
  readonly destinationReached: boolean;
}

/** Thin adapter from the shared Phase 8 junction estimator into scheduler gates. */
export function createCoordinatorProgressSnapshot(
  estimate: JunctionProgressEstimate,
  arrival: JunctionTraversalArrivalEvidence,
): JunctionTraversalProgressSnapshot {
  const trailingContacts = estimate.contacts.filter(
    (contact) => contact.side === "approach" && contact.loadedAndValid,
  );
  const criticalTrailingReachRatio = trailingContacts.reduce(
    (maximum, contact) => Math.max(maximum, contact.currentReachRatio),
    0,
  );
  const maximumReachRatio = estimate.contacts
    .filter((contact) => contact.loadedAndValid)
    .reduce(
      (maximum, contact) => Math.max(maximum, contact.currentReachRatio),
      0,
    );
  return {
    currentRouteStrandId: estimate.currentRouteStrandId,
    currentJunctionNodeId: estimate.junctionNodeId,
    nextRouteTransition: estimate.nextTransition,
    selectedDestinationBranchStrandId: estimate.destinationBranchStrandId,
    junctionEncountered: estimate.phase !== "approaching",
    bodyCenterBeyondJunction: estimate.bodyCenterCrossed,
    destinationSideLoadedContactCount: estimate.destinationSideLoadedCount,
    destinationSideSpread: estimate.destinationSideSpread,
    trailingContactCount: estimate.approachSideLoadedCount,
    criticalTrailingReachRatio,
    maximumReachRatio,
    canCommitBody: estimate.mayCommitBody,
    needsExploratoryTest: estimate.phase === "exploring",
    routeComplete: arrival.routeComplete,
    bodyNearDestination: arrival.bodyNearDestination,
    stableSupportNearDestination: arrival.stableSupportNearDestination,
    destinationReached: arrival.destinationReached,
    bodyCenterDistancePastJunction: estimate.bodyCenterDistancePastJunction,
    removableSupportCount: 0,
    worstRemovalBodyMargin: 0,
    bodyCenterProgress: estimate.commitmentRatio,
    semanticRouteProgress: estimate.commitmentRatio,
    nonCoplanarTransition: false,
    posturePhase: arrival.destinationReached ? "arrived" : "approach",
    branchFrameAngularError: 0,
    branchFrameForwardError: 0,
    branchFramePitchError: 0,
    branchFrameRollError: 0,
    destinationPlaneSupportCount: estimate.destinationSideLoadedCount,
    circumferentialCoverage: 0,
    circumferentialContacts: [],
    contactStateFingerprint: "unavailable",
  };
}

export interface JunctionTraversalRouteRequest {
  readonly destination: RouteDestination;
  readonly previousRoute: PlannedRoute | null;
  readonly completedStepCount: number;
  readonly planningAttemptCount: number;
  readonly recoveryStepDestination: RouteDestination | null;
}

export interface JunctionTraversalRouteResolution {
  readonly ok: boolean;
  readonly route: PlannedRoute | null;
  /** Usually the final destination; may be a bounded semantic look-ahead. */
  readonly stepDestination?: RouteDestination;
  readonly topologyRevision?: string | number;
  readonly reason?: string;
}

export interface JunctionTraversalPolicyContext {
  readonly destination: RouteDestination;
  readonly route: PlannedRoute;
  readonly progress: JunctionTraversalProgressSnapshot;
  readonly completedStepCount: number;
  readonly nextStepIndex: number;
  /** Current high-level strategy instruction; exact legs/addresses remain dynamic. */
  readonly strategyDirective?: TransitionStrategyDirective | null;
}

export interface JunctionTraversalOperationResult {
  readonly status: "running" | "complete" | "failed";
  readonly message?: string;
  /** A bounded branch-test/recovery target for the next normal atomic step. */
  readonly stepDestination?: RouteDestination;
  readonly selectedBranchStrandId?: string;
}

/** Semantic-only exploratory policy; it must not move a foot directly. */
export interface JunctionTestPort {
  begin(context: JunctionTraversalPolicyContext): JunctionTraversalOperationResult;
  update?(
    fixedDeltaSeconds: number,
    context: JunctionTraversalPolicyContext,
  ): JunctionTraversalOperationResult;
  cancel?(): void;
}

export type JunctionRecoveryTrigger = "planning" | "execution";

export interface JunctionRecoveryRequest extends JunctionTraversalPolicyContext {
  readonly trigger: JunctionRecoveryTrigger;
  readonly atomicFailureReason: SpiderStepFailureReason;
  readonly atomicFailureMessage: string;
  readonly attempt: number;
}

export interface JunctionRecoveryDecision {
  readonly retry: boolean;
  readonly stepDestination?: RouteDestination;
  readonly message: string;
}

export interface AtomicStepHistoryEvent extends JunctionTraversalPolicyContext {
  readonly movedLegId: SpiderLegId | null;
  readonly fromAddress: StrandAddress | null;
  readonly toAddress: StrandAddress | null;
  readonly atomicCompletedStepCount: number;
  readonly secureBeforeRelease: boolean;
  readonly localFrameSwing: boolean;
}

export interface JunctionTraversalDependencies {
  readonly atomicStep: AtomicSpiderStepPort;
  readonly resolveRoute: (
    request: JunctionTraversalRouteRequest,
  ) => JunctionTraversalRouteResolution;
  readonly readProgress: (
    route: PlannedRoute,
    destination: RouteDestination,
  ) => JunctionTraversalProgressSnapshot;
  readonly readSafety: () => JunctionTraversalSafetySnapshot;
  readonly isRouteStillValid?: (
    route: PlannedRoute,
    topologyRevision: string | number | undefined,
  ) => boolean;
  /** History/scoring adapters may update Phase 7 policy inputs here. */
  readonly prepareAtomicPlan?: (context: JunctionTraversalPolicyContext) => void;
  readonly recordCompletedAtomicStep?: (event: AtomicStepHistoryEvent) => void;
  /**
   * Replaces the former utility/corrective-mode policy for high-level transfer
   * ordering. The callback may observe the settled transaction sequence and
   * return the directive that should constrain the next ordinary atomic plan.
   */
  readonly readStrategyDirective?: (
    context: JunctionTraversalPolicyContext,
  ) => TransitionStrategyDirective | null;
  readonly attemptRecovery?: (
    request: JunctionRecoveryRequest,
  ) => JunctionRecoveryDecision;
  readonly junctionTest?: JunctionTestPort;
  readonly restoreLastStablePose?: () => boolean;
  readonly onTransition?: (transition: JunctionTraversalTransition) => void;
}

export interface JunctionTraversalTransition {
  readonly sequence: number;
  readonly from: JunctionTraversalState;
  readonly to: JunctionTraversalState;
  readonly totalElapsedSeconds: number;
  readonly stateElapsedSeconds: number;
  readonly completedStepCount: number;
  readonly reason: string;
}

export interface JunctionTraversalStepRecord {
  readonly stepIndex: number;
  readonly movedLegId: SpiderLegId | null;
  readonly fromAddress: StrandAddress | null;
  readonly toAddress: StrandAddress | null;
  readonly routeStrandIds: readonly string[];
  readonly destinationBranchStrandId: string | null;
  readonly secureBeforeRelease: boolean;
  readonly localFrameSwing: boolean;
  readonly atomicStepElapsedSeconds: number;
}

export interface JunctionTraversalDiagnostics {
  state: JunctionTraversalState;
  runMode: JunctionTraversalRunMode;
  pausedAfterStep: boolean;
  totalElapsedSeconds: number;
  stateElapsedSeconds: number;
  settleElapsedSeconds: number;
  destination: RouteDestination | null;
  currentRoute: PlannedRoute | null;
  currentStepDestination: RouteDestination | null;
  topologyRevision: string | number | undefined;
  routeResolutionCount: number;
  planningAttemptCount: number;
  completedStepCount: number;
  planningFailureCount: number;
  atomicExecutionFailureCount: number;
  consecutiveFailureCount: number;
  recoveryAttemptCount: number;
  zeroProgressTransactionCount: number;
  lastBodyProgressDelta: number;
  lastBranchFrameAlignmentImprovement: number;
  lastDestinationPlaneSupportGain: number;
  lastTrailingSupportReduction: number;
  lastWorstReachImprovement: number;
  deadlockReason: string;
  strategyDirective: TransitionStrategyDirective | null;
  junctionTestCount: number;
  progress: JunctionTraversalProgressSnapshot | null;
  /** Monotonic maximum across every progress snapshot observed in this run. */
  maximumObservedReachRatio: number;
  safety: JunctionTraversalSafetySnapshot | null;
  atomicState: SpiderStepState;
  atomicFailureReason: SpiderStepFailureReason;
  atomicFailureMessage: string;
  stopReason: JunctionTraversalStopReason;
  stopMessage: string;
  restorationRequested: boolean;
  restorationSucceeded: boolean | null;
  selectedBranchStrandId: string | null;
  nextRouteTransition: RouteTransition | null;
  transitions: JunctionTraversalTransition[];
  steps: JunctionTraversalStepRecord[];
}

export interface JunctionTraversalCoordinatorOptions
  extends JunctionTraversalDependencies {
  /** Shared policy config; explicit coordinator values below take precedence. */
  readonly policyConfig?: TraversalPolicyConfig;
  readonly config?: Partial<JunctionTraversalConfig>;
}

type SettledAction = "none" | "atomic-step" | "recovery";

function positiveFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? value as number : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function resolveConfig(
  config: Partial<JunctionTraversalConfig> = {},
  policyConfig?: TraversalPolicyConfig,
): JunctionTraversalConfig {
  const scheduler = policyConfig?.scheduler;
  const junction = policyConfig?.junction;
  const recovery = policyConfig?.recovery;
  return {
    maximumStepCount: positiveInteger(
      config.maximumStepCount,
      scheduler?.maximumStepCount ?? DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumStepCount,
    ),
    settleDurationSeconds: nonNegativeFinite(
      config.settleDurationSeconds,
      scheduler?.settleDurationSeconds ??
        DEFAULT_JUNCTION_TRAVERSAL_CONFIG.settleDurationSeconds,
    ),
    maximumConsecutiveFailures: positiveInteger(
      config.maximumConsecutiveFailures,
      scheduler?.maximumConsecutivePlanningFailures ??
        DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumConsecutiveFailures,
    ),
    maximumRecoveryAttempts: positiveInteger(
      config.maximumRecoveryAttempts,
      recovery?.maximumAttempts ?? DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumRecoveryAttempts,
    ),
    maximumRestorationDurationSeconds: positiveFinite(
      config.maximumRestorationDurationSeconds,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumRestorationDurationSeconds,
    ),
    maximumJunctionTestDurationSeconds: positiveFinite(
      config.maximumJunctionTestDurationSeconds,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumJunctionTestDurationSeconds,
    ),
    minimumDestinationSideSupports: positiveInteger(
      config.minimumDestinationSideSupports,
      junction?.destinationSideSupportThreshold ??
        DEFAULT_JUNCTION_TRAVERSAL_CONFIG.minimumDestinationSideSupports,
    ),
    minimumDestinationSideSpread: nonNegativeFinite(
      config.minimumDestinationSideSpread,
      junction?.minimumDestinationSideWorldSpread ??
        DEFAULT_JUNCTION_TRAVERSAL_CONFIG.minimumDestinationSideSpread,
    ),
    maximumCriticalTrailingReachRatio: clamp(
      positiveFinite(
        config.maximumCriticalTrailingReachRatio,
        junction?.trailingReachLimit ??
          DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumCriticalTrailingReachRatio,
      ),
      0.05,
      1.5,
    ),
    maximumZeroProgressTransactions: positiveInteger(
      config.maximumZeroProgressTransactions,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.maximumZeroProgressTransactions,
    ),
    minimumUsefulBodyProgress: nonNegativeFinite(
      config.minimumUsefulBodyProgress,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.minimumUsefulBodyProgress,
    ),
    minimumUsefulReachImprovement: nonNegativeFinite(
      config.minimumUsefulReachImprovement,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.minimumUsefulReachImprovement,
    ),
    minimumUsefulAngularImprovement: nonNegativeFinite(
      config.minimumUsefulAngularImprovement,
      DEFAULT_JUNCTION_TRAVERSAL_CONFIG.minimumUsefulAngularImprovement,
    ),
    defaultRunMode: config.defaultRunMode === "run-until-arrival"
      ? "run-until-arrival"
      : "pause-after-step",
  };
}

function createDiagnostics(
  atomicStep: AtomicSpiderStepPort,
  runMode: JunctionTraversalRunMode,
): JunctionTraversalDiagnostics {
  return {
    state: "idle",
    runMode,
    pausedAfterStep: false,
    totalElapsedSeconds: 0,
    stateElapsedSeconds: 0,
    settleElapsedSeconds: 0,
    destination: null,
    currentRoute: null,
    currentStepDestination: null,
    topologyRevision: undefined,
    routeResolutionCount: 0,
    planningAttemptCount: 0,
    completedStepCount: 0,
    planningFailureCount: 0,
    atomicExecutionFailureCount: 0,
    consecutiveFailureCount: 0,
    recoveryAttemptCount: 0,
    zeroProgressTransactionCount: 0,
    lastBodyProgressDelta: 0,
    lastBranchFrameAlignmentImprovement: 0,
    lastDestinationPlaneSupportGain: 0,
    lastTrailingSupportReduction: 0,
    lastWorstReachImprovement: 0,
    deadlockReason: "",
    strategyDirective: null,
    junctionTestCount: 0,
    progress: null,
    maximumObservedReachRatio: 0,
    safety: null,
    atomicState: atomicStep.state,
    atomicFailureReason: atomicStep.diagnostics.failureReason,
    atomicFailureMessage: atomicStep.diagnostics.failureMessage,
    stopReason: "none",
    stopMessage: "",
    restorationRequested: false,
    restorationSucceeded: null,
    selectedBranchStrandId: null,
    nextRouteTransition: null,
    transitions: [],
    steps: [],
  };
}

function addressCopy(address: StrandAddress | undefined): StrandAddress | null {
  return address ? { strandId: address.strandId, t: address.t } : null;
}

/**
 * Repeated-step scheduler above Phase 7. It only requests and observes one
 * normal SpiderStepController transaction at a time; it never moves feet,
 * edits semantic addresses, or changes web particles itself.
 */
export class JunctionTraversalCoordinator {
  readonly config: JunctionTraversalConfig;
  readonly diagnostics: JunctionTraversalDiagnostics;

  private atomicPlanReady = false;
  private recoveryStepDestination: RouteDestination | null = null;
  private settledAction: SettledAction = "none";
  private junctionTestStarted = false;
  private lastTestedJunctionKey: string | null = null;
  private recoveryAttemptsSinceLastSuccess = 0;
  private progressBeforeTransaction: JunctionTraversalProgressSnapshot | null = null;

  constructor(private readonly options: JunctionTraversalCoordinatorOptions) {
    this.config = resolveConfig(options.config, options.policyConfig);
    this.diagnostics = createDiagnostics(options.atomicStep, this.config.defaultRunMode);
  }

  get state(): JunctionTraversalState {
    return this.diagnostics.state;
  }

  get isActive(): boolean {
    return !["idle", "arrived", "failed", "cancelled"].includes(this.state);
  }

  start(
    destination: RouteDestination,
    runMode: JunctionTraversalRunMode = this.config.defaultRunMode,
  ): boolean {
    if (
      this.isActive ||
      this.options.atomicStep.isExecuting ||
      this.options.atomicStep.state === "planning"
    ) {
      return false;
    }

    Object.assign(this.diagnostics, createDiagnostics(this.options.atomicStep, runMode));
    this.diagnostics.destination = destination;
    this.atomicPlanReady = false;
    this.recoveryStepDestination = null;
    this.settledAction = "none";
    this.junctionTestStarted = false;
    this.lastTestedJunctionKey = null;
    this.recoveryAttemptsSinceLastSuccess = 0;
    this.progressBeforeTransaction = null;
    this.transition("resolving-route", "A deliberate junction destination was issued.");
    return true;
  }

  update(fixedDeltaSeconds: number): void {
    if (!Number.isFinite(fixedDeltaSeconds) || fixedDeltaSeconds < 0) return;

    // Phase 7 remains the atomic execution authority. Calling update even in a
    // terminal coordinator state lets its bounded cancellation restoration
    // finish without ever scheduling another step.
    this.options.atomicStep.update(fixedDeltaSeconds);
    this.diagnostics.totalElapsedSeconds += fixedDeltaSeconds;
    this.diagnostics.stateElapsedSeconds += fixedDeltaSeconds;
    this.captureAtomicStatus();

    if (!this.isActive) {
      // Keep post-cancel/failure QA evidence current while Phase 7 finishes a
      // bounded asynchronous foot restoration. Terminal states never use this
      // observation to schedule more work.
      if (this.state === "cancelled" || this.state === "failed") {
        try {
          this.diagnostics.safety = this.options.readSafety();
        } catch {
          // Preserve the last finite safety snapshot; the stop reason is
          // already deterministic and no recovery is attempted here.
        }
      }
      return;
    }
    if (!this.checkSafety()) return;

    switch (this.state) {
      case "resolving-route":
        this.resolveRouteForNextStep();
        break;
      case "planning-step":
        this.updatePlanningStep();
        break;
      case "executing-step":
        this.updateExecutingStep();
        break;
      case "settling":
        this.updateSettling(fixedDeltaSeconds);
        break;
      case "testing-junction":
        this.updateJunctionTest(fixedDeltaSeconds);
        break;
      case "establishing-branch-support":
        this.transition(
          "resolving-route",
          "Destination-side support is incomplete; re-resolve before one more atomic step.",
        );
        break;
      case "committing-body":
        this.failStrategy(
          "The obsolete body-only recovery state was entered; body motion must remain inside a secure strategy-guided transfer.",
        );
        break;
      case "clearing-trailing-legs":
        this.transition(
          "resolving-route",
          "A trailing leg still needs transfer; re-resolve before one more atomic step.",
        );
        break;
      case "idle":
      case "arrived":
      case "failed":
      case "cancelled":
        break;
    }
  }

  pauseAfterCurrentStep(): void {
    this.diagnostics.runMode = "pause-after-step";
    if (
      this.state === "settling" &&
      this.diagnostics.settleElapsedSeconds >= this.config.settleDurationSeconds
    ) {
      this.diagnostics.pausedAfterStep = true;
    }
  }

  continueOneStep(): boolean {
    if (this.state !== "settling" || !this.diagnostics.pausedAfterStep) return false;
    this.diagnostics.runMode = "pause-after-step";
    this.diagnostics.pausedAfterStep = false;
    this.advanceAfterSettlement();
    return true;
  }

  runUntilArrival(): boolean {
    if (!this.isActive) return false;
    this.diagnostics.runMode = "run-until-arrival";
    const wasPaused = this.diagnostics.pausedAfterStep;
    this.diagnostics.pausedAfterStep = false;
    if (wasPaused && this.state === "settling") {
      this.advanceAfterSettlement();
    }
    return true;
  }

  cancelAndRestore(): boolean {
    if (!this.isActive) return false;

    if (
      this.options.atomicStep.isExecuting ||
      this.options.atomicStep.state === "planning"
    ) {
      this.options.atomicStep.cancel();
      this.diagnostics.restorationRequested = true;
    }
    this.options.junctionTest?.cancel?.();
    this.diagnostics.stopReason = "user-cancelled";
    this.diagnostics.stopMessage =
      "Traversal cancelled; no further atomic step will be scheduled.";
    this.transition("cancelled", this.diagnostics.stopMessage);
    this.captureAtomicStatus();
    return true;
  }

  private captureAtomicStatus(): void {
    const atomic = this.options.atomicStep;
    this.diagnostics.atomicState = atomic.state;
    this.diagnostics.atomicFailureReason = atomic.diagnostics.failureReason;
    this.diagnostics.atomicFailureMessage = atomic.diagnostics.failureMessage;
  }

  private checkSafety(): boolean {
    let safety: JunctionTraversalSafetySnapshot;
    try {
      safety = this.options.readSafety();
    } catch (error) {
      this.fail(
        "support-instability",
        `Safety query failed: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      return false;
    }
    this.diagnostics.safety = safety;

    const restorationPending = this.options.atomicStep.restorationPending === true;
    const recoveryPoseStillSettling =
      this.state === "settling" && this.settledAction === "recovery";
    if (
      safety.loadedSupportCount < safety.requiredSupportCount ||
      (!safety.supportValid && !restorationPending && !recoveryPoseStillSettling)
    ) {
      this.fail(
        "support-instability",
        safety.message ??
          `Only ${safety.loadedSupportCount}/${safety.requiredSupportCount} required supports are valid.`,
        true,
      );
      return false;
    }
    if (safety.ikFailureActive) {
      this.fail("ik-failure", safety.message ?? "A planted-leg IK failure is active.", true);
      return false;
    }
    const completedContactMaySettle =
      this.options.atomicStep.state === "complete" &&
      (this.state === "executing-step" ||
        (this.state === "settling" && this.settledAction === "atomic-step"));
    const atomicTransactionOwnsContactValidity = this.options.atomicStep.isExecuting;
    if (
      safety.footFailureActive &&
      this.options.atomicStep.state !== "failed" &&
      !completedContactMaySettle &&
      !atomicTransactionOwnsContactValidity &&
      !restorationPending
    ) {
      this.fail(
        "support-instability",
        safety.message ?? "A persistent semantic foot contact is invalid.",
        true,
      );
      return false;
    }

    const route = this.diagnostics.currentRoute;
    let routeValid = route ? safety.routeValid !== false : true;
    if (route && routeValid && this.options.isRouteStillValid) {
      try {
        routeValid = this.options.isRouteStillValid(
          route,
          this.diagnostics.topologyRevision,
        );
      } catch (error) {
        this.fail(
          "route-invalid",
          `Route validation failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        return false;
      }
    }
    if (!routeValid) {
      this.fail(
        "route-invalid",
        safety.message ?? "The current semantic route became invalid.",
        true,
      );
      return false;
    }
    return true;
  }

  private resolveRouteForNextStep(): void {
    const destination = this.diagnostics.destination;
    if (!destination) {
      this.fail("route-invalid", "Traversal destination is missing.", false);
      return;
    }

    let resolution: JunctionTraversalRouteResolution;
    try {
      resolution = this.options.resolveRoute({
        destination,
        previousRoute: this.diagnostics.currentRoute,
        completedStepCount: this.diagnostics.completedStepCount,
        planningAttemptCount: this.diagnostics.planningAttemptCount,
        recoveryStepDestination: this.recoveryStepDestination,
      });
    } catch (error) {
      this.fail(
        "route-invalid",
        `Route resolver failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return;
    }
    this.diagnostics.routeResolutionCount += 1;
    if (!resolution.ok || !resolution.route) {
      this.fail(
        "route-invalid",
        resolution.reason ?? "No explicit semantic route reaches the destination.",
        false,
      );
      return;
    }

    this.diagnostics.currentRoute = resolution.route;
    this.diagnostics.topologyRevision = resolution.topologyRevision;
    this.diagnostics.currentStepDestination =
      this.recoveryStepDestination ?? resolution.stepDestination ?? destination;
    this.recoveryStepDestination = null;
    if (!this.refreshProgress()) return;
    if (this.hasArrived()) {
      this.arrive("Stable semantic arrival was already satisfied after route resolution.");
      return;
    }
    if (!this.refreshStrategyDirective()) return;
    if (this.diagnostics.completedStepCount >= this.config.maximumStepCount) {
      this.fail(
        "maximum-step-count",
        `Maximum step count ${this.config.maximumStepCount} reached before arrival.`,
        false,
      );
      return;
    }

    this.progressBeforeTransaction = this.diagnostics.progress
      ? { ...this.diagnostics.progress }
      : null;
    this.atomicPlanReady = false;
    this.transition(
      "planning-step",
      `Route re-resolved for step ${this.diagnostics.completedStepCount + 1}; generate a fresh local plan.`,
    );
  }

  private updatePlanningStep(): void {
    const route = this.diagnostics.currentRoute;
    const destination = this.diagnostics.destination;
    const stepDestination = this.diagnostics.currentStepDestination;
    const progress = this.diagnostics.progress;
    if (!route || !destination || !stepDestination || !progress) {
      this.fail("route-invalid", "Planning inputs are incomplete.", false);
      return;
    }

    const context = this.policyContext(route, destination, progress);
    if (!this.atomicPlanReady) {
      this.options.prepareAtomicPlan?.(context);
      this.diagnostics.planningAttemptCount += 1;
      const accepted = this.options.atomicStep.requestDestination(
        stepDestination,
        "plan-only",
      );
      this.captureAtomicStatus();
      if (this.options.atomicStep.state === "complete") {
        this.handleAtomicCompletion();
        return;
      }
      if (this.options.atomicStep.isExecuting) {
        this.transition(
          "executing-step",
          "The atomic adapter entered execution synchronously after planning.",
        );
        return;
      }
      if (!accepted || this.options.atomicStep.state === "failed") {
        this.handleAtomicFailure("planning");
        return;
      }
      if (this.options.atomicStep.state !== "planning") {
        this.handleCoordinatorAtomicMismatch(
          `Atomic plan returned in unexpected state ${this.options.atomicStep.state}.`,
        );
        return;
      }
      this.atomicPlanReady = true;
      return;
    }

    const started = this.options.atomicStep.executePlannedStep();
    this.captureAtomicStatus();
    if (this.options.atomicStep.state === "complete") {
      this.handleAtomicCompletion();
      return;
    }
    if (this.options.atomicStep.state === "failed") {
      this.handleAtomicFailure("execution");
      return;
    }
    if (!started && !this.options.atomicStep.isExecuting) {
      this.handleCoordinatorAtomicMismatch("The planned atomic step refused execution.");
      return;
    }
    const selected = this.options.atomicStep.diagnostics.selectedPlan;
    const target = selected?.candidate.address;
    this.transition(
      "executing-step",
      selected && target
        ? `${selected.legId} began one secure transaction toward ${target.strandId}@${target.t.toFixed(3)}.`
        : "One secure atomic step began.",
    );
  }

  private updateExecutingStep(): void {
    const atomic = this.options.atomicStep;
    if (atomic.state === "complete") {
      this.handleAtomicCompletion();
      return;
    }
    if (atomic.state === "failed") {
      this.handleAtomicFailure("execution");
      return;
    }
    if (!atomic.isExecuting) {
      this.handleCoordinatorAtomicMismatch(
        `Atomic execution stopped in unexpected state ${atomic.state}.`,
      );
    }
  }

  private handleAtomicCompletion(): void {
    const route = this.diagnostics.currentRoute;
    const destination = this.diagnostics.destination;
    const progress = this.diagnostics.progress;
    if (!route || !destination || !progress) {
      this.fail("atomic-step-failed", "Atomic step completed without route context.", false);
      return;
    }

    const atomicDiagnostics = this.options.atomicStep.diagnostics;
    const selection = atomicDiagnostics.selectedPlan;
    const movedLegId = atomicDiagnostics.previousMovingLegId ?? selection?.legId ?? null;
    const fromAddress = addressCopy(selection?.currentContact.address);
    const toAddress = addressCopy(selection?.candidate.address);
    this.diagnostics.completedStepCount += 1;
    this.diagnostics.consecutiveFailureCount = 0;
    this.recoveryAttemptsSinceLastSuccess = 0;
    const event: AtomicStepHistoryEvent = {
      ...this.policyContext(route, destination, progress),
      movedLegId,
      fromAddress,
      toAddress,
      atomicCompletedStepCount: atomicDiagnostics.completedStepCount,
      secureBeforeRelease: atomicDiagnostics.secureBeforeRelease,
      localFrameSwing: atomicDiagnostics.localFrameSwing,
    };
    this.options.recordCompletedAtomicStep?.(event);
    this.diagnostics.steps.push({
      stepIndex: this.diagnostics.completedStepCount,
      movedLegId,
      fromAddress,
      toAddress,
      routeStrandIds: [...route.strandIds],
      destinationBranchStrandId:
        progress.selectedDestinationBranchStrandId ??
        this.diagnostics.selectedBranchStrandId,
      secureBeforeRelease: atomicDiagnostics.secureBeforeRelease,
      localFrameSwing: atomicDiagnostics.localFrameSwing,
      atomicStepElapsedSeconds: atomicDiagnostics.stepElapsedSeconds,
    });
    this.settledAction = "atomic-step";
    this.diagnostics.settleElapsedSeconds = 0;
    this.atomicPlanReady = false;
    this.transition(
      "settling",
      `Atomic step ${this.diagnostics.completedStepCount} completed; hold all contacts before reassessment.`,
    );
  }

  private updateSettling(fixedDeltaSeconds: number): void {
    this.diagnostics.settleElapsedSeconds += fixedDeltaSeconds;
    if (
      this.settledAction === "recovery" &&
      (this.options.atomicStep.restorationPending === true ||
        this.diagnostics.safety?.footFailureActive ||
        this.diagnostics.safety?.supportValid === false)
    ) {
      if (
        this.diagnostics.settleElapsedSeconds >
        this.config.maximumRestorationDurationSeconds
      ) {
        this.fail(
          "recovery-exhausted",
          `Atomic contact restoration did not stabilize within ${this.config.maximumRestorationDurationSeconds.toFixed(2)} seconds.`,
          false,
        );
      }
      return;
    }
    if (this.diagnostics.settleElapsedSeconds < this.config.settleDurationSeconds) return;
    if (!this.refreshProgress()) return;
    if (this.hasArrived()) {
      this.arrive("Body and stable destination-side support satisfy semantic arrival.");
      return;
    }
    if (!this.refreshStrategyDirective()) return;
    if (this.settledAction === "atomic-step" && !this.evaluateTransactionProgress()) {
      return;
    }
    if (
      this.settledAction === "atomic-step" &&
      this.diagnostics.runMode === "pause-after-step"
    ) {
      this.diagnostics.pausedAfterStep = true;
      return;
    }
    this.advanceAfterSettlement();
  }

  private advanceAfterSettlement(): void {
    const progress = this.diagnostics.progress;
    if (!progress) {
      this.fail("route-invalid", "Junction progress is unavailable after settling.", false);
      return;
    }
    if (this.hasArrived()) {
      this.arrive("Body and stable destination-side support satisfy semantic arrival.");
      return;
    }
    if (this.diagnostics.completedStepCount >= this.config.maximumStepCount) {
      this.fail(
        "maximum-step-count",
        `Maximum step count ${this.config.maximumStepCount} reached before arrival.`,
        false,
      );
      return;
    }
    if (this.recoveryStepDestination) {
      this.transition(
        "resolving-route",
        "The restored pose settled; re-resolve before the bounded local recovery step.",
      );
      return;
    }

    const junctionKey = this.junctionKey(progress);
    if (
      progress.needsExploratoryTest &&
      junctionKey !== this.lastTestedJunctionKey
    ) {
      this.junctionTestStarted = false;
      this.transition(
        "testing-junction",
        "Two explicit route-adjacent branches merit one bounded semantic test.",
      );
      return;
    }
    if (
      progress.junctionEncountered &&
      !progress.bodyCenterBeyondJunction
    ) {
      this.transition(
        "establishing-branch-support",
        `${progress.destinationSideLoadedContactCount}/${this.config.minimumDestinationSideSupports} destination-side contacts are established; the next coupled transfer must also move or rebalance the body.`,
      );
      return;
    }
    if (
      progress.bodyCenterBeyondJunction &&
      (progress.trailingContactCount > 0 ||
        progress.criticalTrailingReachRatio >
          this.config.maximumCriticalTrailingReachRatio)
    ) {
      this.transition(
        "clearing-trailing-legs",
        `${progress.trailingContactCount} trailing contacts remain while coupled body motion continues.`,
      );
      return;
    }
    this.transition(
      "resolving-route",
      "Destination remains unresolved; re-resolve from the changed web before another step.",
    );
  }

  private updateJunctionTest(fixedDeltaSeconds: number): void {
    if (
      this.diagnostics.stateElapsedSeconds >
      this.config.maximumJunctionTestDurationSeconds
    ) {
      this.fail(
        "junction-test-failed",
        `Bounded junction test exceeded ${this.config.maximumJunctionTestDurationSeconds.toFixed(2)} seconds.`,
        false,
      );
      return;
    }
    const context = this.currentPolicyContext();
    if (!context) return;
    const port = this.options.junctionTest;
    if (!port) {
      this.lastTestedJunctionKey = this.junctionKey(context.progress);
      this.transition(
        "establishing-branch-support",
        "No optional exploratory policy is wired; retain the explicit route-selected branch.",
      );
      return;
    }

    let result: JunctionTraversalOperationResult;
    try {
      if (!this.junctionTestStarted) {
        this.junctionTestStarted = true;
        this.diagnostics.junctionTestCount += 1;
        result = port.begin(context);
      } else if (port.update) {
        result = port.update(fixedDeltaSeconds, context);
      } else {
        this.fail(
          "junction-test-failed",
          "Junction test reported running but supplies no update callback.",
          false,
        );
        return;
      }
    } catch (error) {
      this.fail(
        "junction-test-failed",
        `Junction test failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return;
    }

    if (result.status === "failed") {
      this.fail(
        "junction-test-failed",
        result.message ?? "The bounded junction test found no safe explicit branch.",
        false,
      );
      return;
    }
    if (result.status === "running") return;

    this.lastTestedJunctionKey = this.junctionKey(context.progress);
    this.recoveryStepDestination = result.stepDestination ?? null;
    if (result.selectedBranchStrandId) {
      this.diagnostics.selectedBranchStrandId = result.selectedBranchStrandId;
    }
    this.transition(
      "establishing-branch-support",
      result.message ?? "Bounded branch test completed; establish route-selected support.",
    );
  }

  private handleAtomicFailure(trigger: JunctionRecoveryTrigger): void {
    const atomic = this.options.atomicStep.diagnostics;
    if (trigger === "planning") {
      this.diagnostics.planningFailureCount += 1;
    } else {
      this.diagnostics.atomicExecutionFailureCount += 1;
    }
    this.diagnostics.consecutiveFailureCount += 1;
    this.captureAtomicStatus();

    const recoverable = [
      "no-valid-candidate",
      "support-below-minimum",
      "target-strand-unavailable",
      "target-unreachable",
      "swing-clearance-blocked",
      "probe-response-non-finite",
    ].includes(atomic.failureReason);
    if (!recoverable) {
      this.fail(
        trigger === "planning" ? "planning-failure-limit" : "atomic-step-failed",
        atomic.failureMessage ||
          `Atomic ${trigger} failed with ${atomic.failureReason}.`,
        false,
      );
      return;
    }

    const recovery = this.options.attemptRecovery;
    if (recovery) {
      if (
        this.recoveryAttemptsSinceLastSuccess >=
        this.config.maximumRecoveryAttempts
      ) {
        this.fail(
          "recovery-exhausted",
          `Bounded recovery exhausted ${this.config.maximumRecoveryAttempts} attempts.`,
          false,
        );
        return;
      }
      const context = this.currentPolicyContext();
      if (!context) return;
      this.diagnostics.recoveryAttemptCount += 1;
      this.recoveryAttemptsSinceLastSuccess += 1;
      let decision: JunctionRecoveryDecision;
      try {
        decision = recovery({
          ...context,
          trigger,
          atomicFailureReason: atomic.failureReason,
          atomicFailureMessage: atomic.failureMessage,
          attempt: this.recoveryAttemptsSinceLastSuccess,
        });
      } catch (error) {
        this.fail(
          "recovery-exhausted",
          `Recovery policy failed: ${error instanceof Error ? error.message : String(error)}`,
          false,
        );
        return;
      }
      if (!decision.retry) {
        this.fail(
          "recovery-exhausted",
          decision.message ||
            "The bounded local recovery policy found no safe alternative.",
          false,
        );
        return;
      }

      this.recoveryStepDestination = decision.stepDestination ?? null;
      if (trigger === "execution") {
        this.settledAction = "recovery";
        this.diagnostics.settleElapsedSeconds = 0;
        this.transition(
          "settling",
          `${decision.message} Let the restored atomic contact settle before route re-resolution.`,
        );
      } else {
        this.transition(
          "resolving-route",
          `${decision.message} Re-resolve before retrying one atomic step.`,
        );
      }
      return;
    }

    if (
      this.diagnostics.consecutiveFailureCount >=
      this.config.maximumConsecutiveFailures
    ) {
      this.fail(
        trigger === "planning" ? "planning-failure-limit" : "atomic-step-failed",
        `Stopped after ${this.diagnostics.consecutiveFailureCount} consecutive ${trigger} failures: ${atomic.failureMessage}`,
        false,
      );
      return;
    }
    if (trigger === "planning") {
      this.transition(
        "resolving-route",
        "Planning failed safely; re-resolve before the bounded failure limit.",
      );
      return;
    }
    this.fail(
      "atomic-step-failed",
      atomic.failureMessage ||
        "Atomic execution failed and no local recovery policy is wired.",
      false,
    );
  }

  private handleCoordinatorAtomicMismatch(message: string): void {
    this.diagnostics.atomicExecutionFailureCount += 1;
    this.diagnostics.consecutiveFailureCount += 1;
    this.fail(
      "atomic-step-failed",
      message,
      this.options.atomicStep.isExecuting || this.options.atomicStep.state === "planning",
    );
  }

  private refreshProgress(): boolean {
    const route = this.diagnostics.currentRoute;
    const destination = this.diagnostics.destination;
    if (!route || !destination) return false;
    try {
      const progress = this.options.readProgress(route, destination);
      this.diagnostics.progress = progress;
      if (Number.isFinite(progress.maximumReachRatio)) {
        this.diagnostics.maximumObservedReachRatio = Math.max(
          this.diagnostics.maximumObservedReachRatio,
          progress.maximumReachRatio,
        );
      }
      this.diagnostics.nextRouteTransition = progress.nextRouteTransition;
      this.diagnostics.selectedBranchStrandId =
        progress.selectedDestinationBranchStrandId ??
        this.diagnostics.selectedBranchStrandId;
      return true;
    } catch (error) {
      this.fail(
        "route-invalid",
        `Progress estimator failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
      return false;
    }
  }

  private refreshStrategyDirective(): boolean {
    const route = this.diagnostics.currentRoute;
    const destination = this.diagnostics.destination;
    const progress = this.diagnostics.progress;
    if (!route || !destination || !progress) return false;

    const readStrategyDirective = this.options.readStrategyDirective;
    if (!readStrategyDirective) {
      this.diagnostics.strategyDirective = null;
      return true;
    }

    let directive: TransitionStrategyDirective | null;
    try {
      directive = readStrategyDirective(
        this.policyContext(route, destination, progress),
      );
    } catch (error) {
      return this.failStrategy(
        `Transition strategy failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.diagnostics.strategyDirective = directive;
    if (!directive?.failed) return true;
    return this.failStrategy(
      directive.failureReason ||
        `${directive.strategy} could not complete its ${directive.stage} stage safely.`,
    );
  }

  private failStrategy(reason: string): false {
    this.diagnostics.restorationRequested = true;
    let restorationSucceeded: boolean | null = null;
    try {
      restorationSucceeded = this.options.restoreLastStablePose?.() ?? null;
    } catch (error) {
      restorationSucceeded = false;
      reason = `${reason} Stable-pose restoration failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.diagnostics.restorationSucceeded = restorationSucceeded;
    this.fail("strategy-failed", reason, false);
    return false;
  }

  private hasArrived(): boolean {
    const progress = this.diagnostics.progress;
    if (!progress) return false;
    const junctionSatisfied =
      !progress.junctionEncountered ||
      (progress.bodyCenterBeyondJunction &&
        progress.destinationSideLoadedContactCount >=
          this.config.minimumDestinationSideSupports &&
        progress.destinationSideSpread >= this.config.minimumDestinationSideSpread &&
        progress.criticalTrailingReachRatio <=
          this.config.maximumCriticalTrailingReachRatio);
    return Boolean(
      progress.destinationReached &&
      progress.routeComplete &&
      progress.bodyNearDestination &&
      progress.stableSupportNearDestination &&
      junctionSatisfied,
    );
  }

  private evaluateTransactionProgress(): boolean {
    const before = this.progressBeforeTransaction;
    const after = this.diagnostics.progress;
    if (!before || !after) return true;

    const bodyDelta =
      after.bodyCenterDistancePastJunction -
      before.bodyCenterDistancePastJunction;
    const alignmentImprovement =
      before.branchFrameAngularError - after.branchFrameAngularError;
    const destinationPlaneSupportGain =
      after.destinationPlaneSupportCount -
      before.destinationPlaneSupportCount;
    const trailingSupportReduction =
      before.trailingContactCount - after.trailingContactCount;
    const worstReachImprovement =
      before.maximumReachRatio - after.maximumReachRatio;

    const useful =
      bodyDelta >= this.config.minimumUsefulBodyProgress ||
      alignmentImprovement >= this.config.minimumUsefulAngularImprovement ||
      destinationPlaneSupportGain > 0 ||
      trailingSupportReduction > 0 ||
      worstReachImprovement >= this.config.minimumUsefulReachImprovement;
    const activeRollUnderStage =
      this.diagnostics.strategyDirective?.strategy === "roll-under" &&
      !["approach-junction", "resume-generic"].includes(
        this.diagnostics.strategyDirective.stage,
      );

    this.diagnostics.lastBodyProgressDelta = bodyDelta;
    this.diagnostics.lastBranchFrameAlignmentImprovement =
      alignmentImprovement;
    this.diagnostics.lastDestinationPlaneSupportGain =
      destinationPlaneSupportGain;
    this.diagnostics.lastTrailingSupportReduction = trailingSupportReduction;
    this.diagnostics.lastWorstReachImprovement = worstReachImprovement;
    this.diagnostics.zeroProgressTransactionCount = useful || activeRollUnderStage
      ? 0
      : this.diagnostics.zeroProgressTransactionCount + 1;
    this.progressBeforeTransaction = { ...after };

    // Roll-under owns only its active topology-stage stagnation bound. Its
    // generic approach and resumed branch travel use this ordinary counter.
    if (useful || activeRollUnderStage) return true;
    if (
      this.diagnostics.zeroProgressTransactionCount <
      this.config.maximumZeroProgressTransactions
    ) {
      return true;
    }

    this.diagnostics.deadlockReason =
      `No branch-frame alignment, support-plane transfer, worst-reach, body, or trailing-support progress for ${this.diagnostics.zeroProgressTransactionCount} completed transactions.`;
    this.fail(
      after.nonCoplanarTransition
        ? "angled-transition-stagnation"
        : "coupled-transfer-deadlock",
      this.diagnostics.deadlockReason,
      false,
    );
    return false;
  }

  private currentPolicyContext(): JunctionTraversalPolicyContext | null {
    const route = this.diagnostics.currentRoute;
    const destination = this.diagnostics.destination;
    const progress = this.diagnostics.progress;
    if (!route || !destination || !progress) {
      this.fail("route-invalid", "Traversal policy context is incomplete.", false);
      return null;
    }
    return this.policyContext(route, destination, progress);
  }

  private policyContext(
    route: PlannedRoute,
    destination: RouteDestination,
    progress: JunctionTraversalProgressSnapshot,
  ): JunctionTraversalPolicyContext {
    return {
      destination,
      route,
      progress,
      completedStepCount: this.diagnostics.completedStepCount,
      nextStepIndex: this.diagnostics.completedStepCount + 1,
      strategyDirective: this.diagnostics.strategyDirective,
    };
  }

  private junctionKey(progress: JunctionTraversalProgressSnapshot): string {
    return [
      progress.currentJunctionNodeId ?? "no-junction",
      progress.selectedDestinationBranchStrandId ?? "no-branch",
    ].join("|");
  }

  private arrive(message: string): void {
    this.diagnostics.stopReason = "destination-reached";
    this.diagnostics.stopMessage = message;
    this.diagnostics.pausedAfterStep = false;
    this.transition("arrived", message);
  }

  private fail(
    reason: Exclude<JunctionTraversalStopReason, "none" | "destination-reached" | "user-cancelled">,
    message: string,
    cancelAtomicStep: boolean,
  ): void {
    if (
      cancelAtomicStep &&
      (this.options.atomicStep.isExecuting ||
        this.options.atomicStep.state === "planning")
    ) {
      const restoringMovingFoot = this.options.atomicStep.isExecuting;
      this.options.atomicStep.cancel();
      this.diagnostics.restorationRequested ||= restoringMovingFoot;
    }
    this.options.junctionTest?.cancel?.();
    this.diagnostics.stopReason = reason;
    this.diagnostics.stopMessage = message;
    this.diagnostics.pausedAfterStep = false;
    this.transition("failed", message);
    this.captureAtomicStatus();
  }

  private transition(to: JunctionTraversalState, reason: string): void {
    const from = this.diagnostics.state;
    if (from === to) return;
    const transition: JunctionTraversalTransition = {
      sequence: this.diagnostics.transitions.length,
      from,
      to,
      totalElapsedSeconds: this.diagnostics.totalElapsedSeconds,
      stateElapsedSeconds: this.diagnostics.stateElapsedSeconds,
      completedStepCount: this.diagnostics.completedStepCount,
      reason,
    };
    this.diagnostics.transitions.push(transition);
    this.diagnostics.state = to;
    this.diagnostics.stateElapsedSeconds = 0;
    this.options.onTransition?.(transition);
  }
}
