import type {
  RouteDestination,
  StrandAddress,
  Vec3Like,
} from "../../traversal";
import type { SpiderStepDiagnostics } from "../locomotion/LocomotionDiagnostics";
import type { SpiderStepState } from "../locomotion/SpiderStepState";
import type { SpiderLegId } from "../SpiderRigSpec";
import type { AtomicSpiderStepPort } from "./JunctionTraversalCoordinator";

const EPSILON = 1e-8;

export const COUPLED_TRANSFER_STAGES = [
  "idle",
  "planning-foot",
  "transferring-foot",
  "partial-load-held",
  "moving-body",
  "finishing-load",
  "complete",
  "restoring",
  "failed",
  "cancelled",
] as const;

export type CoupledTransferStage = (typeof COUPLED_TRANSFER_STAGES)[number];

export type CoupledTransferFailureReason =
  | "none"
  | "atomic-planning-failed"
  | "atomic-execution-failed"
  | "partial-load-timeout"
  | "body-motion-unavailable"
  | "body-motion-failed"
  | "body-motion-timeout"
  | "atomic-state-mismatch"
  | "restoration-failed"
  | "cancelled";

export type CoupledSupportClassification = "hard-valid" | "soft-valid-corrective" | "invalid";

export interface CoupledBodyMotionCandidateDiagnostic {
  readonly fraction: number;
  readonly translation: Vec3Like;
  readonly rotationRadians: number;
  readonly accepted: boolean;
  readonly useful: boolean;
  readonly limitingLegId: SpiderLegId | null;
  readonly limitingConstraint: string;
  readonly worstReachRatio: number;
  readonly supportClassification: CoupledSupportClassification;
  readonly rejectionReasons: readonly string[];
}

/**
 * Mutable evidence owned by the supplied body-motion implementation. The
 * wrapper snapshots it into immutable transaction records at terminal states.
 */
export interface CoupledBodyMotionDiagnostics {
  proposedCandidates: readonly CoupledBodyMotionCandidateDiagnostic[];
  acceptedTranslation: Vec3Like;
  acceptedRotationRadians: number;
  acceptedFraction: number;
  bodyProgressDelta: number;
  worstReachBefore: number;
  worstReachAfter: number;
  trailingReachBefore: number;
  trailingReachAfter: number;
  supportBefore: CoupledSupportClassification;
  supportAfter: CoupledSupportClassification;
  limitingLegId: SpiderLegId | null;
  limitingConstraint: string;
  reachBudgetImprovement: number;
  branchFrameAngularErrorBefore: number;
  branchFrameAngularErrorAfter: number;
  destinationPlaneSupportCountBefore: number;
  destinationPlaneSupportCountAfter: number;
  circumferentialCoverageBefore: number;
  circumferentialCoverageAfter: number;
  posturePhase: string;
  rotationFirst: boolean;
}

export interface CoupledBodyMotionRequest {
  readonly transactionSequence: number;
  readonly destination: RouteDestination;
  readonly movingLegId: SpiderLegId;
  readonly newContact: StrandAddress;
  readonly partialLoadFactor: number;
  readonly worstReachRatioBeforeTransfer?: number;
  readonly atomicDiagnostics: Readonly<SpiderStepDiagnostics>;
}

export interface CoupledBodyMotionResult {
  readonly status: "running" | "complete" | "failed";
  readonly message?: string;
}

/**
 * Body motion remains outside the Phase 7 controller. Implementations must
 * retain their pre-motion snapshot until `commitStablePose`, so cancellation
 * can restore translation and orientation even after the ease reaches 100% but
 * before the foot finishes loading.
 */
export interface CoupledBodyMotionPort {
  readonly diagnostics: Readonly<CoupledBodyMotionDiagnostics>;
  /**
   * True after a synchronous snapshot restore until the owning rig has
   * published a fresh pose/IK observation for that restored transform.
   */
  readonly restorationPending?: boolean;
  begin(request: CoupledBodyMotionRequest): CoupledBodyMotionResult;
  update(fixedDeltaSeconds: number, request: CoupledBodyMotionRequest): CoupledBodyMotionResult;
  /**
   * Revalidate the actual pose after the new contact reaches full load. The
   * pre-motion snapshot remains restorable until this returns `complete`.
   */
  validateStablePose?(
    fixedDeltaSeconds: number,
    request: CoupledBodyMotionRequest,
  ): CoupledBodyMotionResult;
  cancelAndRestore(): boolean;
  commitStablePose?(): void;
  reset?(): void;
}

/** Opt-in extension implemented by SpiderStepController for coupled use only. */
export interface LoadHoldAtomicSpiderStepPort extends AtomicSpiderStepPort {
  /** `null` resumes the validated Phase 7 load ramp to full load. */
  setLoadTransferHold(factor: number | null): void;
  /** Avoid a duplicate Phase 7 body plan after Phase 8R commits its increment. */
  setCoupledBodyMotionCommitted(committed: boolean): void;
}

export interface CoupledTransferConfig {
  readonly partialLoadFactor: number;
  readonly partialLoadTolerance: number;
  readonly maximumPartialLoadWaitSeconds: number;
  readonly maximumBodyMotionDurationSeconds: number;
  /** Bound for exact moving-foot/body restoration after a failed transfer. */
  readonly maximumRestorationWaitSeconds: number;
}

export const DEFAULT_COUPLED_TRANSFER_CONFIG: Readonly<CoupledTransferConfig> =
  Object.freeze({
    partialLoadFactor: 0.35,
    partialLoadTolerance: 1e-4,
    maximumPartialLoadWaitSeconds: 2,
    maximumBodyMotionDurationSeconds: 1.75,
    maximumRestorationWaitSeconds: 2.25,
  });

export interface CoupledTransferTransition {
  readonly sequence: number;
  readonly from: CoupledTransferStage;
  readonly to: CoupledTransferStage;
  readonly elapsedSeconds: number;
  readonly atomicState: SpiderStepState;
  readonly reason: string;
}

export interface CoupledTransferRecord {
  readonly transactionSequence: number;
  readonly outcome: "complete" | "failed" | "cancelled";
  readonly destination: RouteDestination;
  readonly movingLegId: SpiderLegId | null;
  readonly newContact: StrandAddress | null;
  readonly initialLoadFactor: number;
  readonly partialLoadFactor: number;
  readonly finalLoadFactor: number;
  readonly elapsedSeconds: number;
  readonly bodyMotion: CoupledBodyMotionDiagnostics;
  readonly failureReason: CoupledTransferFailureReason;
  readonly failureMessage: string;
  readonly restorationRequested: boolean;
  readonly restorationSucceeded: boolean | null;
  readonly transitions: readonly CoupledTransferTransition[];
}

export interface CoupledTransferDiagnostics {
  stage: CoupledTransferStage;
  transactionSequence: number;
  destination: RouteDestination | null;
  movingLegId: SpiderLegId | null;
  newContact: StrandAddress | null;
  initialLoadFactor: number;
  partialLoadFactor: number;
  currentLoadFactor: number;
  finalLoadFactor: number;
  elapsedSeconds: number;
  stageElapsedSeconds: number;
  bodyMotionElapsedSeconds: number;
  bodyMotionStarted: boolean;
  failureReason: CoupledTransferFailureReason;
  failureMessage: string;
  restorationRequested: boolean;
  restorationSucceeded: boolean | null;
  transitions: CoupledTransferTransition[];
  records: CoupledTransferRecord[];
  bodyMotion: CoupledBodyMotionDiagnostics;
}

export interface CoupledTransferTransactionOptions {
  readonly atomicStep: LoadHoldAtomicSpiderStepPort;
  readonly bodyMotion: CoupledBodyMotionPort;
  readonly config?: Partial<CoupledTransferConfig>;
  readonly readFootLoadFactor?: (legId: SpiderLegId) => number | undefined;
  readonly readWorstReachRatio?: () => number | undefined;
  readonly readFootRestoration?: (
    legId: SpiderLegId,
    originalAddress: StrandAddress,
  ) => {
    readonly complete: boolean;
    readonly succeeded: boolean;
    readonly message?: string;
  };
  readonly onRecord?: (record: CoupledTransferRecord) => void;
}

function vector(): { x: number; y: number; z: number } {
  return { x: 0, y: 0, z: 0 };
}

export function createCoupledBodyMotionDiagnostics(): CoupledBodyMotionDiagnostics {
  return {
    proposedCandidates: [],
    acceptedTranslation: vector(),
    acceptedRotationRadians: 0,
    acceptedFraction: 0,
    bodyProgressDelta: 0,
    worstReachBefore: 0,
    worstReachAfter: 0,
    trailingReachBefore: 0,
    trailingReachAfter: 0,
    supportBefore: "invalid",
    supportAfter: "invalid",
    limitingLegId: null,
    limitingConstraint: "none",
    reachBudgetImprovement: 0,
    branchFrameAngularErrorBefore: 0,
    branchFrameAngularErrorAfter: 0,
    destinationPlaneSupportCountBefore: 0,
    destinationPlaneSupportCountAfter: 0,
    circumferentialCoverageBefore: 0,
    circumferentialCoverageAfter: 0,
    posturePhase: "approach",
    rotationFirst: false,
  };
}

function copyVector(value: Vec3Like): { x: number; y: number; z: number } {
  return { x: value.x, y: value.y, z: value.z };
}

function copyAddress(address: StrandAddress | null): StrandAddress | null {
  return address ? { strandId: address.strandId, t: address.t } : null;
}

function copyBodyMotionDiagnostics(
  source: Readonly<CoupledBodyMotionDiagnostics>,
): CoupledBodyMotionDiagnostics {
  return {
    proposedCandidates: source.proposedCandidates.map((candidate) => ({
    ...candidate,
    translation: copyVector(candidate.translation),
    rejectionReasons: [...candidate.rejectionReasons],
    })),
    acceptedTranslation: copyVector(source.acceptedTranslation),
    acceptedRotationRadians: source.acceptedRotationRadians,
    acceptedFraction: source.acceptedFraction,
    bodyProgressDelta: source.bodyProgressDelta,
    worstReachBefore: source.worstReachBefore,
    worstReachAfter: source.worstReachAfter,
    trailingReachBefore: source.trailingReachBefore,
    trailingReachAfter: source.trailingReachAfter,
    supportBefore: source.supportBefore,
    supportAfter: source.supportAfter,
    limitingLegId: source.limitingLegId,
    limitingConstraint: source.limitingConstraint,
    reachBudgetImprovement: source.reachBudgetImprovement,
    branchFrameAngularErrorBefore: source.branchFrameAngularErrorBefore,
    branchFrameAngularErrorAfter: source.branchFrameAngularErrorAfter,
    destinationPlaneSupportCountBefore: source.destinationPlaneSupportCountBefore,
    destinationPlaneSupportCountAfter: source.destinationPlaneSupportCountAfter,
    circumferentialCoverageBefore: source.circumferentialCoverageBefore,
    circumferentialCoverageAfter: source.circumferentialCoverageAfter,
    posturePhase: source.posturePhase,
    rotationFirst: source.rotationFirst,
  };
}

function resolveConfig(config: Partial<CoupledTransferConfig> = {}): CoupledTransferConfig {
  const result = { ...DEFAULT_COUPLED_TRANSFER_CONFIG, ...config };
  if (
    !Number.isFinite(result.partialLoadFactor) ||
    result.partialLoadFactor <= 0 ||
    result.partialLoadFactor >= 1
  ) {
    throw new Error("Coupled partial load factor must be finite and in (0, 1).");
  }
  if (
    !Number.isFinite(result.partialLoadTolerance) ||
    result.partialLoadTolerance < 0 ||
    result.partialLoadTolerance >= 1
  ) {
    throw new Error("Coupled partial load tolerance must be finite and in [0, 1).");
  }
  if (
    !Number.isFinite(result.maximumPartialLoadWaitSeconds) ||
    result.maximumPartialLoadWaitSeconds <= 0 ||
    !Number.isFinite(result.maximumBodyMotionDurationSeconds) ||
    result.maximumBodyMotionDurationSeconds <= 0 ||
    !Number.isFinite(result.maximumRestorationWaitSeconds) ||
    result.maximumRestorationWaitSeconds <= 0
  ) {
    throw new Error("Coupled transfer time bounds must be finite and positive.");
  }
  return result;
}

function isTerminal(stage: CoupledTransferStage): boolean {
  return ["idle", "complete", "failed", "cancelled"].includes(stage);
}

/**
 * Phase 8 adapter around the validated Phase 7 transaction. It deliberately
 * leaves swing, probe, semantic planting, final loading, IK validation, and
 * moving-foot restoration inside the atomic controller.
 */
export class CoupledTransferTransaction implements AtomicSpiderStepPort {
  readonly config: CoupledTransferConfig;
  readonly coupledDiagnostics: CoupledTransferDiagnostics;

  private bodyRequest: CoupledBodyMotionRequest | null = null;
  private bodySnapshotRetained = false;
  private stablePoseValidated = false;
  private recordFinalized = false;
  private cancellationRequested = false;
  private cancellationOriginalAddress: StrandAddress | null = null;
  private failureRestorationActive = false;
  private failureOriginalAddress: StrandAddress | null = null;
  private worstReachRatioBeforeTransfer = Number.NaN;

  constructor(private readonly options: CoupledTransferTransactionOptions) {
    this.config = resolveConfig(options.config);
    this.coupledDiagnostics = {
      stage: "idle",
      transactionSequence: 0,
      destination: null,
      movingLegId: null,
      newContact: null,
      initialLoadFactor: 0,
      partialLoadFactor: this.config.partialLoadFactor,
      currentLoadFactor: 0,
      finalLoadFactor: 0,
      elapsedSeconds: 0,
      stageElapsedSeconds: 0,
      bodyMotionElapsedSeconds: 0,
      bodyMotionStarted: false,
      failureReason: "none",
      failureMessage: "",
      restorationRequested: false,
      restorationSucceeded: null,
      transitions: [],
      records: [],
      bodyMotion: createCoupledBodyMotionDiagnostics(),
    };
  }

  get state(): SpiderStepState {
    if (
      this.coupledDiagnostics.stage === "restoring" &&
      this.failureRestorationActive
    ) {
      // Do not expose a retry-ready failure to the outer coordinator until the
      // prior semantic foot address/load and body snapshot are resolved.
      return "loading";
    }
    if (this.coupledDiagnostics.stage === "failed" || this.coupledDiagnostics.stage === "cancelled") {
      return "failed";
    }
    return this.options.atomicStep.state;
  }

  get isExecuting(): boolean {
    return this.options.atomicStep.isExecuting ||
      ["partial-load-held", "moving-body", "finishing-load", "restoring"].includes(
        this.coupledDiagnostics.stage,
      );
  }

  get restorationPending(): boolean {
    return (
      this.coupledDiagnostics.stage === "restoring" ||
      this.options.bodyMotion.restorationPending === true ||
      this.options.atomicStep.restorationPending === true
    );
  }

  get failureRecoveryMode(): "reach-reserve" | undefined {
    if (this.coupledDiagnostics.stage !== "failed") {
      return this.options.atomicStep.failureRecoveryMode;
    }
    if (this.coupledDiagnostics.failureReason === "restoration-failed") {
      return undefined;
    }
    const constraint = this.coupledDiagnostics.bodyMotion.limitingConstraint;
    if ([
      "full-load-hard-reach",
      "full-load-strategic-reach-reserve",
      "full-load-reach-recovery-regression",
    ].includes(constraint)) {
      return "reach-reserve";
    }
    return this.options.atomicStep.failureRecoveryMode;
  }

  get diagnostics(): Readonly<SpiderStepDiagnostics> {
    const atomic = this.options.atomicStep.diagnostics;
    if (
      this.coupledDiagnostics.stage === "failed" &&
      this.coupledDiagnostics.failureReason === "restoration-failed"
    ) {
      return {
        ...atomic,
        state: "failed",
        failureReason: "restoration-failed",
        failureMessage: this.coupledDiagnostics.failureMessage,
      };
    }
    if (
      (this.coupledDiagnostics.stage === "failed" ||
        (this.coupledDiagnostics.stage === "restoring" &&
          this.failureRestorationActive)) &&
      [
        "body-motion-unavailable",
        "body-motion-failed",
        "body-motion-timeout",
        "partial-load-timeout",
        "atomic-state-mismatch",
      ].includes(this.coupledDiagnostics.failureReason)
    ) {
      // Internal coupled restoration uses Phase 7's cancellation machinery,
      // but it is not a developer/user cancellation. Surface a recoverable
      // planning result so the outer scheduler can settle and replan instead
      // of misreporting the implementation-owned restore as terminal input.
      return {
        ...atomic,
        state: this.state,
        failureReason: "no-valid-candidate",
        failureMessage:
          this.coupledDiagnostics.failureMessage ||
          "No safe useful coupled body increment was available.",
      };
    }
    if (this.failureRestorationActive) {
      return { ...atomic, state: this.state };
    }
    return atomic;
  }

  requestDestination(destination: RouteDestination, mode: "plan-only"): boolean {
    if (this.isExecuting || this.options.atomicStep.state === "planning") return false;
    this.beginRecord(destination);
    this.options.bodyMotion.reset?.();
    this.stablePoseValidated = false;
    this.options.atomicStep.setCoupledBodyMotionCommitted(false);
    this.options.atomicStep.setLoadTransferHold(null);
    this.transition("planning-foot", "Request one Phase 7 foothold plan for the coupled transfer.");
    const accepted = this.options.atomicStep.requestDestination(destination, mode);
    this.captureSelection();
    if (!accepted || this.options.atomicStep.state === "failed") {
      this.finishFailure(
        "atomic-planning-failed",
        this.options.atomicStep.diagnostics.failureMessage || "The atomic foothold plan failed.",
        false,
      );
      return false;
    }
    if (this.options.atomicStep.state === "complete") this.finishComplete();
    return accepted;
  }

  executePlannedStep(): boolean {
    if (this.options.atomicStep.state !== "planning") return false;
    this.captureSelection();
    const worstReachRatioBeforeTransfer = this.options.readWorstReachRatio?.();
    this.worstReachRatioBeforeTransfer = Number.isFinite(worstReachRatioBeforeTransfer)
      ? worstReachRatioBeforeTransfer as number
      : Number.NaN;
    this.options.atomicStep.setLoadTransferHold(this.config.partialLoadFactor);
    const started = this.options.atomicStep.executePlannedStep();
    const resultingState = this.options.atomicStep.diagnostics.state;
    if (!started || resultingState === "failed") {
      this.finishFailure(
        "atomic-execution-failed",
        this.options.atomicStep.diagnostics.failureMessage || "The atomic foothold execution failed.",
        false,
      );
      return false;
    }
    if (resultingState === "complete") {
      this.finishComplete();
      return true;
    }
    this.transition(
      "transferring-foot",
      "Phase 7 owns lift, swing, probe, and zero-load semantic planting.",
    );
    return true;
  }

  update(fixedDeltaSeconds: number): void {
    if (!Number.isFinite(fixedDeltaSeconds) || fixedDeltaSeconds < 0) return;
    this.options.atomicStep.update(fixedDeltaSeconds);
    if (isTerminal(this.coupledDiagnostics.stage)) return;

    this.coupledDiagnostics.elapsedSeconds += fixedDeltaSeconds;
    this.coupledDiagnostics.stageElapsedSeconds += fixedDeltaSeconds;
    this.captureSelection();
    this.captureCurrentLoad();

    if (this.coupledDiagnostics.stage === "restoring") {
      if (this.cancellationRequested) {
        this.finishCancellationRestoration();
      } else {
        this.finishFailureRestoration();
      }
      return;
    }

    if (
      this.coupledDiagnostics.stage === "finishing-load" &&
      this.options.atomicStep.state === "body-advance"
    ) {
      this.validateStablePose(fixedDeltaSeconds);
      if (
        isTerminal(this.coupledDiagnostics.stage) ||
        this.failureRestorationActive
      ) return;
    }

    if (this.options.atomicStep.state === "failed") {
      this.finishFailure(
        "atomic-execution-failed",
        this.options.atomicStep.diagnostics.failureMessage || "The atomic foothold execution failed.",
        false,
      );
      return;
    }
    if (this.options.atomicStep.state === "complete") {
      if (
        this.coupledDiagnostics.stage === "finishing-load" &&
        !this.stablePoseValidated
      ) {
        this.finishFailure(
          "body-motion-failed",
          "Atomic loading completed before the actual full-load pose was validated.",
          false,
        );
        return;
      }
      this.finishComplete();
      return;
    }

    const stage = this.coupledDiagnostics.stage;
    if (stage === "transferring-foot" && this.options.atomicStep.state === "loading") {
      if (
        this.coupledDiagnostics.currentLoadFactor + this.config.partialLoadTolerance >=
        this.config.partialLoadFactor
      ) {
        this.transition(
          "partial-load-held",
          "The new semantic contact reached its configured partial load.",
        );
        this.beginBodyMotion();
      } else if (
        this.options.atomicStep.diagnostics.stateElapsedSeconds >
        this.config.maximumPartialLoadWaitSeconds
      ) {
        this.finishFailure(
          "partial-load-timeout",
          `Partial load did not settle within ${this.config.maximumPartialLoadWaitSeconds.toFixed(2)} seconds.`,
          true,
        );
      }
      return;
    }

    if (stage === "partial-load-held") {
      this.beginBodyMotion();
      return;
    }

    if (stage === "moving-body") {
      this.coupledDiagnostics.bodyMotionElapsedSeconds += fixedDeltaSeconds;
      if (
        this.coupledDiagnostics.bodyMotionElapsedSeconds >
        this.config.maximumBodyMotionDurationSeconds
      ) {
        this.finishFailure(
          "body-motion-timeout",
          `Coupled body motion exceeded ${this.config.maximumBodyMotionDurationSeconds.toFixed(2)} seconds.`,
          true,
        );
        return;
      }
      if (this.options.atomicStep.state !== "loading" || !this.bodyRequest) {
        this.finishFailure(
          "atomic-state-mismatch",
          `Atomic state ${this.options.atomicStep.state} left loading before coupled body motion completed.`,
          true,
        );
        return;
      }
      let result: CoupledBodyMotionResult;
      try {
        result = this.options.bodyMotion.update(fixedDeltaSeconds, this.bodyRequest);
      } catch (error) {
        this.finishFailure(
          "body-motion-failed",
          `Coupled body update threw: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
        return;
      }
      this.captureBodyDiagnostics();
      this.handleBodyResult(result);
      return;
    }

    if (stage === "finishing-load") {
      if (this.options.atomicStep.state === "loading" || this.options.atomicStep.state === "body-advance") {
        return;
      }
      if (!this.options.atomicStep.isExecuting) {
        this.finishFailure(
          "atomic-state-mismatch",
          `Atomic final loading stopped in unexpected state ${this.options.atomicStep.state}.`,
          true,
        );
      }
    }
  }

  cancel(): void {
    if (isTerminal(this.coupledDiagnostics.stage)) return;
    this.cancellationRequested = true;
    this.cancellationOriginalAddress = copyAddress(
      this.options.atomicStep.diagnostics.selectedPlan?.currentContact.address ?? null,
    );
    this.transition("restoring", "Cancellation requested; restore coupled body pose before atomic contact restoration.");
    this.restoreBodySnapshot();
    this.coupledDiagnostics.restorationRequested = true;
    this.options.atomicStep.setCoupledBodyMotionCommitted(false);
    this.options.atomicStep.setLoadTransferHold(null);
    this.options.atomicStep.cancel();
    this.coupledDiagnostics.failureReason = "cancelled";
    this.coupledDiagnostics.failureMessage = "Coupled transfer cancelled and no later transaction was scheduled.";
    this.finishCancellationRestoration();
  }

  cancelAndRestore(): boolean {
    this.cancel();
    return this.coupledDiagnostics.restorationSucceeded !== false;
  }

  private beginRecord(destination: RouteDestination): void {
    const records = this.coupledDiagnostics.records;
    Object.assign(this.coupledDiagnostics, {
      stage: "idle",
      transactionSequence: this.coupledDiagnostics.transactionSequence + 1,
      destination,
      movingLegId: null,
      newContact: null,
      initialLoadFactor: 0,
      partialLoadFactor: this.config.partialLoadFactor,
      currentLoadFactor: 0,
      finalLoadFactor: 0,
      elapsedSeconds: 0,
      stageElapsedSeconds: 0,
      bodyMotionElapsedSeconds: 0,
      bodyMotionStarted: false,
      failureReason: "none",
      failureMessage: "",
      restorationRequested: false,
      restorationSucceeded: null,
      transitions: [],
      records,
      bodyMotion: createCoupledBodyMotionDiagnostics(),
    });
    this.bodyRequest = null;
    this.bodySnapshotRetained = false;
    this.recordFinalized = false;
    this.cancellationRequested = false;
    this.cancellationOriginalAddress = null;
    this.failureRestorationActive = false;
    this.failureOriginalAddress = null;
    this.worstReachRatioBeforeTransfer = Number.NaN;
  }

  private finishCancellationRestoration(): void {
    if (this.recordFinalized || !this.cancellationRequested) return;
    const legId = this.coupledDiagnostics.movingLegId;
    const originalAddress = this.cancellationOriginalAddress;
    const footRestoration = legId && originalAddress && this.options.readFootRestoration
      ? this.options.readFootRestoration(legId, originalAddress)
      : { complete: true, succeeded: true };
    if (!footRestoration.complete) return;

    this.coupledDiagnostics.restorationSucceeded =
      this.coupledDiagnostics.restorationSucceeded !== false &&
      footRestoration.succeeded;
    if (!footRestoration.succeeded && footRestoration.message) {
      this.coupledDiagnostics.failureMessage =
        `${this.coupledDiagnostics.failureMessage} ${footRestoration.message}`;
    }
    this.transition("cancelled", this.coupledDiagnostics.failureMessage);
    this.finalizeRecord("cancelled");
  }

  private captureSelection(): void {
    const selected = this.options.atomicStep.diagnostics.selectedPlan;
    if (!selected) return;
    this.coupledDiagnostics.movingLegId = selected.legId;
    this.coupledDiagnostics.newContact = copyAddress(selected.candidate.address);
    if (this.coupledDiagnostics.initialLoadFactor <= EPSILON) {
      this.coupledDiagnostics.initialLoadFactor =
        this.options.readFootLoadFactor?.(selected.legId) ?? 1;
    }
  }

  private captureCurrentLoad(): void {
    const legId = this.coupledDiagnostics.movingLegId;
    this.coupledDiagnostics.currentLoadFactor = legId
      ? this.options.readFootLoadFactor?.(legId) ??
        this.options.atomicStep.diagnostics.loadTransfer
      : this.options.atomicStep.diagnostics.loadTransfer;
  }

  private beginBodyMotion(): void {
    if (this.coupledDiagnostics.stage !== "partial-load-held") return;
    const destination = this.coupledDiagnostics.destination;
    const movingLegId = this.coupledDiagnostics.movingLegId;
    const newContact = this.coupledDiagnostics.newContact;
    if (!destination || !movingLegId || !newContact) {
      this.finishFailure(
        "body-motion-unavailable",
        "Coupled body motion lacks a selected leg, new semantic contact, or destination.",
        true,
      );
      return;
    }
    this.bodyRequest = {
      transactionSequence: this.coupledDiagnostics.transactionSequence,
      destination,
      movingLegId,
      newContact,
      partialLoadFactor: this.config.partialLoadFactor,
      worstReachRatioBeforeTransfer: this.worstReachRatioBeforeTransfer,
      atomicDiagnostics: this.options.atomicStep.diagnostics,
    };
    this.coupledDiagnostics.bodyMotionStarted = true;
    this.coupledDiagnostics.bodyMotionElapsedSeconds = 0;
    this.bodySnapshotRetained = true;
    let result: CoupledBodyMotionResult;
    try {
      result = this.options.bodyMotion.begin(this.bodyRequest);
    } catch (error) {
      this.finishFailure(
        "body-motion-failed",
        `Coupled body planning threw: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      return;
    }
    this.captureBodyDiagnostics();
    this.transition("moving-body", result.message ?? "Begin bounded coupled translation and rotation.");
    this.handleBodyResult(result);
  }

  private handleBodyResult(result: CoupledBodyMotionResult): void {
    if (result.status === "running") return;
    if (result.status === "failed") {
      this.finishFailure(
        "body-motion-failed",
        result.message ?? "No positive useful coupled body increment was available.",
        true,
      );
      return;
    }
    this.options.atomicStep.setCoupledBodyMotionCommitted(true);
    this.options.atomicStep.setLoadTransferHold(null);
    this.stablePoseValidated = this.options.bodyMotion.validateStablePose === undefined;
    this.transition(
      "finishing-load",
      result.message ?? "Coupled body motion completed; finish loading the new contact.",
    );
  }

  private validateStablePose(fixedDeltaSeconds: number): void {
    if (this.stablePoseValidated || !this.bodyRequest) return;
    const validate = this.options.bodyMotion.validateStablePose;
    if (!validate) {
      this.stablePoseValidated = true;
      return;
    }
    let result: CoupledBodyMotionResult;
    try {
      result = validate(fixedDeltaSeconds, this.bodyRequest);
    } catch (error) {
      this.finishFailure(
        "body-motion-failed",
        `Full-load pose validation threw: ${error instanceof Error ? error.message : String(error)}`,
        true,
      );
      return;
    }
    this.captureBodyDiagnostics();
    if (result.status === "failed") {
      this.finishFailure(
        "body-motion-failed",
        result.message ?? "The actual full-load pose failed support validation.",
        true,
      );
      return;
    }
    if (result.status === "complete") this.stablePoseValidated = true;
  }

  private finishComplete(): void {
    if (this.recordFinalized) return;
    try {
      if (this.bodySnapshotRetained) this.options.bodyMotion.commitStablePose?.();
    } catch (error) {
      this.restoreBodySnapshot();
      this.coupledDiagnostics.failureReason = "restoration-failed";
      this.coupledDiagnostics.failureMessage =
        `Could not commit the coupled stable pose: ${error instanceof Error ? error.message : String(error)}`;
      this.transition("failed", this.coupledDiagnostics.failureMessage);
      this.finalizeRecord("failed");
      return;
    }
    this.bodySnapshotRetained = false;
    this.options.atomicStep.setCoupledBodyMotionCommitted(false);
    this.captureCurrentLoad();
    this.coupledDiagnostics.finalLoadFactor = this.coupledDiagnostics.currentLoadFactor;
    this.captureBodyDiagnostics();
    this.transition("complete", "One foot placement and one bounded body increment reached a stable pose.");
    this.finalizeRecord("complete");
  }

  private finishFailure(
    reason: Exclude<CoupledTransferFailureReason, "none" | "cancelled">,
    message: string,
    cancelAtomic: boolean,
  ): void {
    if (this.recordFinalized) return;
    const failedStage = this.coupledDiagnostics.stage;
    const selected = this.options.atomicStep.diagnostics.selectedPlan;
    const originalAddress = copyAddress(selected?.currentContact.address ?? null);
    this.coupledDiagnostics.failureReason = reason;
    this.coupledDiagnostics.failureMessage = message;
    if (this.bodySnapshotRetained) this.restoreBodySnapshot();
    this.options.atomicStep.setCoupledBodyMotionCommitted(false);
    this.options.atomicStep.setLoadTransferHold(null);
    if (
      cancelAtomic &&
      (this.options.atomicStep.isExecuting || this.options.atomicStep.state === "planning")
    ) {
      this.options.atomicStep.cancel();
    }

    const movingLegId = this.coupledDiagnostics.movingLegId ?? selected?.legId ?? null;
    const transferMayBeRestoring = Boolean(
      failedStage !== "idle" &&
      failedStage !== "planning-foot" &&
      movingLegId &&
      originalAddress,
    );
    if (transferMayBeRestoring) {
      this.coupledDiagnostics.movingLegId = movingLegId;
      this.failureOriginalAddress = originalAddress;
      this.failureRestorationActive = true;
      this.coupledDiagnostics.restorationRequested = true;
      this.transition(
        "restoring",
        "Failed transfer is waiting for exact semantic foot and body restoration.",
      );
      this.finishFailureRestoration();
      return;
    }

    this.transition("failed", this.coupledDiagnostics.failureMessage);
    this.finalizeRecord("failed");
  }

  private finishFailureRestoration(): void {
    if (!this.failureRestorationActive || this.recordFinalized) return;
    const legId = this.coupledDiagnostics.movingLegId;
    const originalAddress = this.failureOriginalAddress;
    if (!legId || !originalAddress) {
      this.failFailureRestoration(
        "Failed transfer lost the moving leg or its original semantic address.",
      );
      return;
    }

    if (this.options.bodyMotion.restorationPending === true) {
      this.failFailureRestorationOnTimeout(legId, originalAddress);
      return;
    }
    if (this.options.atomicStep.restorationPending === true) {
      this.failFailureRestorationOnTimeout(legId, originalAddress);
      return;
    }
    if (this.coupledDiagnostics.restorationSucceeded === false) {
      this.failFailureRestoration("The saved body pose could not be restored.");
      return;
    }

    let footRestoration: {
      readonly complete: boolean;
      readonly succeeded: boolean;
      readonly message?: string;
    };
    try {
      if (!this.options.readFootRestoration) {
        this.failFailureRestoration(
          "Exact semantic foot-restoration observation is unavailable.",
        );
        return;
      }
      footRestoration = this.options.readFootRestoration(legId, originalAddress);
    } catch (error) {
      this.failFailureRestoration(
        `Exact foot-restoration observation threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    if (!footRestoration.complete) {
      this.failFailureRestorationOnTimeout(legId, originalAddress);
      return;
    }
    if (!footRestoration.succeeded) {
      this.failFailureRestoration(
        footRestoration.message ??
          `Could not restore ${legId} to ${originalAddress.strandId}@${originalAddress.t.toFixed(6)} at full load.`,
      );
      return;
    }

    this.coupledDiagnostics.restorationSucceeded = true;
    this.failureRestorationActive = false;
    this.failureOriginalAddress = null;
    const message = this.coupledDiagnostics.failureMessage;
    this.transition("failed", message);
    this.finalizeRecord("failed");
  }

  private failFailureRestorationOnTimeout(
    legId: SpiderLegId,
    originalAddress: StrandAddress,
  ): void {
    if (
      this.coupledDiagnostics.stageElapsedSeconds + EPSILON <
      this.config.maximumRestorationWaitSeconds
    ) return;
    this.failFailureRestoration(
      `Exact restoration of ${legId} to ${originalAddress.strandId}@${originalAddress.t.toFixed(6)} ` +
        `did not complete within ${this.config.maximumRestorationWaitSeconds.toFixed(2)} seconds.`,
    );
  }

  private failFailureRestoration(message: string): void {
    const originalFailure = this.coupledDiagnostics.failureMessage;
    this.coupledDiagnostics.failureReason = "restoration-failed";
    this.coupledDiagnostics.failureMessage = originalFailure && !message.includes(originalFailure)
      ? `${originalFailure} ${message}`
      : message;
    this.coupledDiagnostics.restorationRequested = true;
    this.coupledDiagnostics.restorationSucceeded = false;
    this.failureRestorationActive = false;
    this.failureOriginalAddress = null;
    this.transition("failed", this.coupledDiagnostics.failureMessage);
    this.finalizeRecord("failed");
  }

  private restoreBodySnapshot(): void {
    if (!this.bodySnapshotRetained) return;
    this.coupledDiagnostics.restorationRequested = true;
    try {
      this.coupledDiagnostics.restorationSucceeded =
        this.options.bodyMotion.cancelAndRestore();
    } catch (error) {
      this.coupledDiagnostics.restorationSucceeded = false;
      const detail = error instanceof Error ? error.message : String(error);
      this.coupledDiagnostics.failureMessage = this.coupledDiagnostics.failureMessage
        ? `${this.coupledDiagnostics.failureMessage} Body restoration threw: ${detail}`
        : `Body restoration threw: ${detail}`;
    }
    this.bodySnapshotRetained = false;
  }

  private captureBodyDiagnostics(): void {
    this.coupledDiagnostics.bodyMotion = copyBodyMotionDiagnostics(
      this.options.bodyMotion.diagnostics,
    );
  }

  private transition(to: CoupledTransferStage, reason: string): void {
    const from = this.coupledDiagnostics.stage;
    if (from === to) return;
    this.coupledDiagnostics.transitions.push({
      sequence: this.coupledDiagnostics.transitions.length,
      from,
      to,
      elapsedSeconds: this.coupledDiagnostics.elapsedSeconds,
      atomicState: this.options.atomicStep.state,
      reason,
    });
    this.coupledDiagnostics.stage = to;
    this.coupledDiagnostics.stageElapsedSeconds = 0;
  }

  private finalizeRecord(outcome: CoupledTransferRecord["outcome"]): void {
    if (this.recordFinalized || !this.coupledDiagnostics.destination) return;
    this.recordFinalized = true;
    this.captureCurrentLoad();
    if (outcome !== "complete") {
      this.coupledDiagnostics.finalLoadFactor = this.coupledDiagnostics.currentLoadFactor;
    }
    const record: CoupledTransferRecord = {
      transactionSequence: this.coupledDiagnostics.transactionSequence,
      outcome,
      destination: this.coupledDiagnostics.destination,
      movingLegId: this.coupledDiagnostics.movingLegId,
      newContact: copyAddress(this.coupledDiagnostics.newContact),
      initialLoadFactor: this.coupledDiagnostics.initialLoadFactor,
      partialLoadFactor: this.coupledDiagnostics.partialLoadFactor,
      finalLoadFactor: this.coupledDiagnostics.finalLoadFactor,
      elapsedSeconds: this.coupledDiagnostics.elapsedSeconds,
      bodyMotion: copyBodyMotionDiagnostics(this.coupledDiagnostics.bodyMotion),
      failureReason: this.coupledDiagnostics.failureReason,
      failureMessage: this.coupledDiagnostics.failureMessage,
      restorationRequested: this.coupledDiagnostics.restorationRequested,
      restorationSucceeded: this.coupledDiagnostics.restorationSucceeded,
      transitions: this.coupledDiagnostics.transitions.map((transition) => ({ ...transition })),
    };
    this.coupledDiagnostics.records.push(record);
    this.options.onRecord?.(record);
  }
}
