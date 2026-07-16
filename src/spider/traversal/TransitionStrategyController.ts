export type TransitionStrategyId =
  | "ordinary-traverse"
  | "junction-forward"
  | "roll-under";

export type TransitionStrategyStage =
  | "ordinary-travel"
  | "approach-junction"
  | "transfer-forward"
  | "establish-new-plane"
  | "rotate-and-build"
  | "advance-under"
  | "clear-old-plane"
  | "resume-generic";

export type TransitionLegRegion = "front" | "middle" | "rear" | "any";
export type TransitionContactGoal =
  | "route-progress"
  | "new-plane"
  | "trailing-relief";
export type TransitionBodyGoal = "hold" | "rotate" | "advance";

export interface TransitionStrategySelectionInput {
  readonly hasJunction: boolean;
  readonly transitionPlaneTurnRadians: number;
  readonly rollUnderActivationRadians?: number;
}

export interface TransitionStrategyProgress {
  readonly branchFrameAlignmentRadians: number;
  readonly oldPlaneContactCount: number;
  readonly newPlaneContactCount: number;
  readonly worstReachRatio: number;
  readonly bodyProgress: number;
  readonly trailingSupportCount: number;
}

export interface TransitionStrategyPhase {
  readonly junctionEncountered: boolean;
  readonly bodyCenterBeyondJunction: boolean;
}

export interface TransitionStrategyDirective {
  readonly strategy: TransitionStrategyId;
  readonly stage: TransitionStrategyStage;
  readonly preferredLegRegions: readonly TransitionLegRegion[];
  readonly contactGoal: TransitionContactGoal;
  readonly bodyGoal: TransitionBodyGoal;
  readonly translationScale: number;
  readonly rotationScale: number;
  readonly reachReliefRequired: boolean;
  readonly failed: boolean;
  readonly failureReason: string;
}

export interface TransitionStrategyDiagnostics {
  strategy: TransitionStrategyId;
  stage: TransitionStrategyStage;
  observedTransactionSequence: number;
  totalObservedTransactions: number;
  stageTransactionCount: number;
  stagnantTransactionCount: number;
  stageTransitionCount: number;
  failed: boolean;
  failureReason: string;
  progress: TransitionStrategyProgress | null;
  phase: TransitionStrategyPhase | null;
}

export interface TransitionStrategyControllerConfig {
  readonly rollUnderActivationRadians: number;
  readonly alignedToleranceRadians: number;
  readonly reachWarningRatio: number;
  readonly exploratoryContactCount: number;
  readonly rotationSupportCount: number;
  readonly resumedSupportCount: number;
  readonly advanceBeforeClearProgress: number;
  readonly maximumStagnantTransactions: number;
  readonly maximumStageTransactions: number;
}

export const DEFAULT_TRANSITION_STRATEGY_CONFIG: TransitionStrategyControllerConfig = {
  rollUnderActivationRadians: Math.PI / 12,
  alignedToleranceRadians: Math.PI / 18,
  reachWarningRatio: 0.955,
  exploratoryContactCount: 2,
  rotationSupportCount: 3,
  resumedSupportCount: 5,
  advanceBeforeClearProgress: 0.3,
  maximumStagnantTransactions: 4,
  maximumStageTransactions: 12,
};

export function selectTransitionStrategy(
  input: TransitionStrategySelectionInput,
): TransitionStrategyId {
  if (!input.hasJunction) return "ordinary-traverse";
  const threshold = finiteNonNegative(
    input.rollUnderActivationRadians,
    DEFAULT_TRANSITION_STRATEGY_CONFIG.rollUnderActivationRadians,
  );
  return Number.isFinite(input.transitionPlaneTurnRadians) &&
    input.transitionPlaneTurnRadians >= threshold
    ? "roll-under"
    : "junction-forward";
}

export function boundedStrategyAlternativeAvailable(
  attempt: number,
  maximumAlternatives: number,
): boolean {
  return Number.isInteger(attempt) && attempt >= 1 &&
    Number.isInteger(maximumAlternatives) && maximumAlternatives >= 1 &&
    attempt <= maximumAlternatives;
}

export class TransitionStrategyController {
  readonly config: TransitionStrategyControllerConfig;
  readonly diagnostics: TransitionStrategyDiagnostics;

  private bestProgress: TransitionStrategyProgress | null = null;

  constructor(
    strategy: TransitionStrategyId,
    config: Partial<TransitionStrategyControllerConfig> = {},
  ) {
    this.config = {
      rollUnderActivationRadians: finiteNonNegative(
        config.rollUnderActivationRadians,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.rollUnderActivationRadians,
      ),
      alignedToleranceRadians: finiteNonNegative(
        config.alignedToleranceRadians,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.alignedToleranceRadians,
      ),
      reachWarningRatio: finitePositive(
        config.reachWarningRatio,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.reachWarningRatio,
      ),
      exploratoryContactCount: positiveInteger(
        config.exploratoryContactCount,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.exploratoryContactCount,
      ),
      rotationSupportCount: positiveInteger(
        config.rotationSupportCount,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.rotationSupportCount,
      ),
      resumedSupportCount: positiveInteger(
        config.resumedSupportCount,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.resumedSupportCount,
      ),
      advanceBeforeClearProgress: finiteNonNegative(
        config.advanceBeforeClearProgress,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.advanceBeforeClearProgress,
      ),
      maximumStagnantTransactions: positiveInteger(
        config.maximumStagnantTransactions,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.maximumStagnantTransactions,
      ),
      maximumStageTransactions: positiveInteger(
        config.maximumStageTransactions,
        DEFAULT_TRANSITION_STRATEGY_CONFIG.maximumStageTransactions,
      ),
    };
    this.diagnostics = createDiagnostics(strategy);
  }

  reset(strategy: TransitionStrategyId): void {
    Object.assign(this.diagnostics, createDiagnostics(strategy));
    this.bestProgress = null;
  }

  observe(
    progress: TransitionStrategyProgress,
    phase: TransitionStrategyPhase,
    completedTransactionSequence: number,
  ): TransitionStrategyDirective {
    if (
      !Number.isInteger(completedTransactionSequence) ||
      completedTransactionSequence < 0 ||
      completedTransactionSequence <= this.diagnostics.observedTransactionSequence
    ) return this.directive();

    this.diagnostics.observedTransactionSequence = completedTransactionSequence;
    this.diagnostics.progress = { ...progress };
    this.diagnostics.phase = { ...phase };
    if (this.bestProgress === null) {
      this.bestProgress = { ...progress };
      this.advanceCompletedStages(progress, phase);
      return this.directive();
    }

    this.diagnostics.totalObservedTransactions += 1;
    this.diagnostics.stageTransactionCount += 1;
    if (progressImproved(this.bestProgress, progress)) {
      this.bestProgress = mergeBestProgress(this.bestProgress, progress);
      this.diagnostics.stagnantTransactionCount = 0;
    } else {
      this.diagnostics.stagnantTransactionCount += 1;
    }

    if (this.advanceCompletedStages(progress, phase)) return this.directive();
    if (
      this.diagnostics.strategy === "roll-under" &&
      this.diagnostics.stage !== "approach-junction" &&
      this.diagnostics.stage !== "resume-generic" &&
      (this.diagnostics.stagnantTransactionCount >=
        this.config.maximumStagnantTransactions ||
        this.diagnostics.stageTransactionCount >= this.config.maximumStageTransactions)
    ) {
      this.diagnostics.failed = true;
      this.diagnostics.failureReason =
        `Roll-under stage ${this.diagnostics.stage} exhausted its bounded alternatives ` +
        `after ${this.diagnostics.stageTransactionCount} transactions ` +
        `(${this.diagnostics.stagnantTransactionCount} stagnant).`;
    }
    return this.directive();
  }

  directive(): TransitionStrategyDirective {
    const progress = this.diagnostics.progress;
    const phase = this.diagnostics.phase;
    const reachReliefRequired = Boolean(
      progress &&
      phase?.junctionEncountered &&
      this.diagnostics.strategy !== "ordinary-traverse" &&
      Number.isFinite(progress.worstReachRatio) &&
      progress.worstReachRatio >= this.config.reachWarningRatio,
    );
    const base = directiveFor(this.diagnostics.strategy, this.diagnostics.stage);
    const reachReliefContactGoal = reachReliefRequired;
    const rotationNeedsSupport = Boolean(
      progress &&
      this.diagnostics.strategy === "roll-under" &&
      this.diagnostics.stage === "rotate-and-build" &&
      progress.newPlaneContactCount < this.config.rotationSupportCount,
    );
    const clearStageNeedsBodyAdvance = Boolean(
      progress &&
      this.diagnostics.strategy === "roll-under" &&
      this.diagnostics.stage === "clear-old-plane" &&
      progress.bodyProgress < this.config.advanceBeforeClearProgress,
    );
    return {
      ...base,
      preferredLegRegions: reachReliefRequired
        ? ["rear", "middle", "front"]
        : base.preferredLegRegions,
      // A reach warning is one explicit safety goal inside the current stage,
      // not another recovery mode. The ordinary selector still chooses the
      // exact removable leg and hard-valid continuous foothold; the objective
      // only requires the limiting contact's reach to improve while the body
      // is held.
      contactGoal: reachReliefContactGoal
        ? "trailing-relief"
        : rotationNeedsSupport
          ? "new-plane"
          : clearStageNeedsBodyAdvance
            ? "route-progress"
        : base.contactGoal,
      bodyGoal: reachReliefRequired ? "hold" : base.bodyGoal,
      // The clear stage first uses ordinary route progress to move the hard
      // support region far enough forward for a trailing foot to be removable.
      // Request the normal bounded body step during that preparation; the
      // body planner still clamps it through every reach, support, and
      // clearance constraint before anything moves.
      translationScale: reachReliefRequired
        ? 0
        : clearStageNeedsBodyAdvance
          ? 1
          : base.translationScale,
      // Do not finish the non-coplanar rotation on only exploratory support.
      // Build the configured new-plane support count under the same partial
      // rotation cap used by establish-new-plane, then let generic selection
      // finish alignment without demanding an unnecessary fifth contact.
      rotationScale: reachReliefRequired
        ? 0
        : rotationNeedsSupport
          ? 0.35
          : base.rotationScale,
      reachReliefRequired,
      failed: this.diagnostics.failed,
      failureReason: this.diagnostics.failureReason,
    };
  }

  private advanceCompletedStages(
    progress: TransitionStrategyProgress,
    phase: TransitionStrategyPhase,
  ): boolean {
    const next = nextStage(
      this.diagnostics.strategy,
      this.diagnostics.stage,
      progress,
      phase,
      this.config,
    );
    if (next === this.diagnostics.stage) return false;
    this.diagnostics.stage = next;
    this.diagnostics.stageTransactionCount = 0;
    this.diagnostics.stagnantTransactionCount = 0;
    this.diagnostics.stageTransitionCount += 1;
    this.bestProgress = { ...progress };
    return true;
  }
}

function createDiagnostics(strategy: TransitionStrategyId): TransitionStrategyDiagnostics {
  return {
    strategy,
    stage: initialStage(strategy),
    observedTransactionSequence: -1,
    totalObservedTransactions: 0,
    stageTransactionCount: 0,
    stagnantTransactionCount: 0,
    stageTransitionCount: 0,
    failed: false,
    failureReason: "",
    progress: null,
    phase: null,
  };
}

function initialStage(strategy: TransitionStrategyId): TransitionStrategyStage {
  if (strategy === "ordinary-traverse") return "ordinary-travel";
  if (strategy === "junction-forward") return "approach-junction";
  return "approach-junction";
}

function nextStage(
  strategy: TransitionStrategyId,
  stage: TransitionStrategyStage,
  progress: TransitionStrategyProgress,
  phase: TransitionStrategyPhase,
  config: TransitionStrategyControllerConfig,
): TransitionStrategyStage {
  if (strategy === "ordinary-traverse") return "ordinary-travel";
  if (strategy === "junction-forward") {
    if (stage === "approach-junction" && phase.junctionEncountered) {
      return "transfer-forward";
    }
    if (stage === "transfer-forward" && phase.bodyCenterBeyondJunction) {
      return "resume-generic";
    }
    return stage;
  }

  if (stage === "approach-junction" && phase.junctionEncountered) {
    return "establish-new-plane";
  }

  if (
    stage === "establish-new-plane" &&
    progress.newPlaneContactCount >= config.exploratoryContactCount
  ) return "rotate-and-build";
  if (
    stage === "rotate-and-build" &&
    progress.newPlaneContactCount >= config.rotationSupportCount &&
    progress.branchFrameAlignmentRadians <= config.alignedToleranceRadians
  ) return "advance-under";
  if (
    stage === "advance-under" &&
    (progress.bodyProgress >= config.advanceBeforeClearProgress ||
      progress.trailingSupportCount <= 3 ||
      progress.worstReachRatio >= config.reachWarningRatio)
  ) return "clear-old-plane";
  if (
    stage === "clear-old-plane" &&
    progress.oldPlaneContactCount === 0 &&
    progress.trailingSupportCount === 0 &&
    progress.newPlaneContactCount >= config.resumedSupportCount &&
    progress.branchFrameAlignmentRadians <= config.alignedToleranceRadians * 1.5
  ) return "resume-generic";
  return stage;
}

function directiveFor(
  strategy: TransitionStrategyId,
  stage: TransitionStrategyStage,
): Omit<TransitionStrategyDirective, "reachReliefRequired" | "failed" | "failureReason"> {
  if (strategy === "ordinary-traverse") {
    return {
      strategy,
      stage,
      preferredLegRegions: ["any"],
      contactGoal: "route-progress",
      bodyGoal: "advance",
      translationScale: 1,
      rotationScale: 1,
    };
  }
  if (strategy === "junction-forward") {
    const transferring = stage === "transfer-forward";
    return {
      strategy,
      stage,
      preferredLegRegions: transferring ? ["front", "middle"] : ["any"],
      contactGoal: "route-progress",
      bodyGoal: "advance",
      translationScale: transferring ? 0.65 : 1,
      rotationScale: transferring ? 0.65 : 1,
    };
  }
  switch (stage) {
    case "approach-junction":
      return {
        strategy,
        stage,
        preferredLegRegions: ["any"],
        contactGoal: "route-progress",
        bodyGoal: "advance",
        translationScale: 1,
        rotationScale: 0.25,
      };
    case "establish-new-plane":
      return {
        strategy,
        stage,
        preferredLegRegions: ["front", "middle"],
        contactGoal: "new-plane",
        bodyGoal: "hold",
        translationScale: 0,
        rotationScale: 0.35,
      };
    case "rotate-and-build":
      return {
        strategy,
        stage,
        preferredLegRegions: ["middle", "front"],
        contactGoal: "route-progress",
        bodyGoal: "rotate",
        translationScale: 0.15,
        rotationScale: 1,
      };
    case "advance-under":
      return {
        strategy,
        stage,
        preferredLegRegions: ["middle", "rear"],
        contactGoal: "route-progress",
        bodyGoal: "advance",
        translationScale: 0.55,
        rotationScale: 0.5,
      };
    case "clear-old-plane":
      return {
        strategy,
        stage,
        preferredLegRegions: ["rear", "middle"],
        contactGoal: "trailing-relief",
        bodyGoal: "advance",
        translationScale: 0.35,
        rotationScale: 0.35,
      };
    default:
      return {
        strategy,
        stage: "resume-generic",
        preferredLegRegions: ["any"],
        contactGoal: "route-progress",
        bodyGoal: "advance",
        translationScale: 1,
        rotationScale: 0.25,
      };
  }
}

function progressImproved(
  best: TransitionStrategyProgress,
  current: TransitionStrategyProgress,
): boolean {
  return (
    current.branchFrameAlignmentRadians <= best.branchFrameAlignmentRadians - Math.PI / 360 ||
    current.newPlaneContactCount > best.newPlaneContactCount ||
    current.worstReachRatio <= best.worstReachRatio - 0.002 ||
    current.bodyProgress >= best.bodyProgress + 0.002 ||
    current.trailingSupportCount < best.trailingSupportCount ||
    current.oldPlaneContactCount < best.oldPlaneContactCount
  );
}

function mergeBestProgress(
  best: TransitionStrategyProgress,
  current: TransitionStrategyProgress,
): TransitionStrategyProgress {
  return {
    branchFrameAlignmentRadians: Math.min(
      best.branchFrameAlignmentRadians,
      current.branchFrameAlignmentRadians,
    ),
    oldPlaneContactCount: Math.min(best.oldPlaneContactCount, current.oldPlaneContactCount),
    newPlaneContactCount: Math.max(best.newPlaneContactCount, current.newPlaneContactCount),
    worstReachRatio: Math.min(best.worstReachRatio, current.worstReachRatio),
    bodyProgress: Math.max(best.bodyProgress, current.bodyProgress),
    trailingSupportCount: Math.min(best.trailingSupportCount, current.trailingSupportCount),
  };
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? -1) >= 0 ? value as number : fallback;
}

function finitePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
