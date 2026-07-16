import {
  ContactFrameTracker,
  createContactFrame,
  type ContactFrame,
  type MutableVec3,
  type RouteDestination,
  type StrandAddress,
  type StrandTraversal,
  type Vec3Like,
} from "../../traversal";
import type { WebNetwork } from "../../web/WebNetwork";
import type { SpiderFootContact } from "../SpiderFootContact";
import type { SpiderLoadDistributor } from "../SpiderLoadDistributor";
import type { SpiderLegId, SpiderReachSpec } from "../SpiderRigSpec";
import { BodyAdvancePlanner, type BodyAdvancePlan } from "./BodyAdvancePlanner";
import { ContactTestController } from "./ContactTestController";
import { FootholdGenerator } from "./FootholdGenerator";
import { FootholdScorer } from "./FootholdScorer";
import {
  FootSwingTrajectory,
  createFootSwingSample,
  type FootSwingSample,
  type FootSwingSupportFrame,
  type FootSwingTrajectoryConfig,
} from "./FootSwingTrajectory";
import { LegSelector } from "./LegSelector";
import type { LocomotionConfig } from "./LocomotionConfig";
import {
  createSpiderStepDiagnostics,
  type MovingFootIkReport,
  type SpiderStepDiagnostics,
  type StableAddressRecord,
} from "./LocomotionDiagnostics";
import type {
  FootholdCandidateSeed,
  FootholdCandidateObjective,
  FootholdLegContext,
  FootholdCandidateValidator,
  FootholdRiskEstimator,
  JointFeasibilityTest,
  LegSelectionResult,
  LocomotionLegPolicyState,
  LocomotionSupportContact,
  LocomotionSupportFrame,
} from "./LocomotionTypes";
import { SpiderIntentResolver } from "./SpiderIntent";
import type { SpiderStepFailureReason, SpiderStepState } from "./SpiderStepState";
import {
  SupportEstimator,
  type SupportEstimateSample,
} from "./SupportEstimator";

const EPSILON = 1e-8;

export interface SpiderStepRuntimeLeg {
  readonly legId: SpiderLegId;
  readonly footHomeWorldPosition: Vec3Like;
  readonly reachOriginWorldPosition: Vec3Like;
  readonly contactWorldPosition: Vec3Like;
  readonly address: StrandAddress | null;
  readonly reach: SpiderReachSpec;
  readonly reachScale: number;
  readonly planted: boolean;
  readonly loaded: boolean;
  /** Continuous physical participation factor; zero means planted but unloaded. */
  readonly loadFactor?: number;
  readonly valid: boolean;
  readonly currentReachRatio: number;
  /** Latest render-side IK result for this semantic support contact. */
  readonly ikFinite?: boolean;
  readonly ikReached?: boolean;
  readonly ikResidual?: number;
}

export interface SpiderStepRuntimeContext {
  readonly bodyWorldPosition: Vec3Like;
  readonly supportFrame: LocomotionSupportFrame;
  readonly legs: readonly SpiderStepRuntimeLeg[];
  readonly jointFeasibility?: JointFeasibilityTest;
  readonly riskEstimator?: FootholdRiskEstimator;
  /** Bounded higher-level fault/recovery gate; never applied to current contacts. */
  readonly candidateValidator?: FootholdCandidateValidator;
  /**
   * Optional semantic/world-space candidate neighborhoods. Omission preserves
   * the standalone Phase 7 FootHome-centered generator exactly.
   */
  readonly candidateSeeds?: readonly FootholdCandidateSeed[];
  /** Optional bounded ranking influence from a repeated-step coordinator. */
  readonly legSelectionScoreAdjustments?: Readonly<Partial<Record<SpiderLegId, number>>>;
  /**
   * Optional required procedural contact objective for the atomic selector.
   * It cannot bypass candidate validity, reach, support, IK, topology, or
   * spacing gates.
   */
  readonly candidateObjective?: FootholdCandidateObjective;
  /** Allow a bounded higher-level strategy to use ordinary support rebalancing. */
  readonly allowGenericCandidateFallback?: boolean;
  /** Optional semantic main-route subset; omitted by the Phase 7 baseline. */
  readonly routeStrandIds?: ReadonlySet<string>;
  /**
   * Optional largest-first body-advance distances for a repeated-step policy.
   * Omit to preserve the Phase 7 one-shot configured distance exactly.
   */
  readonly bodyAdvanceDistanceCandidates?: readonly number[];
  /** Monotonic render-side IK solve generation used for post-advance validation. */
  readonly ikSolveVersion?: number;
}

export interface SpiderStepControllerOptions {
  readonly network: WebNetwork;
  readonly traversal: StrandTraversal;
  readonly contacts: ReadonlyMap<SpiderLegId, SpiderFootContact>;
  readonly loadDistributor: SpiderLoadDistributor;
  readonly config: LocomotionConfig;
  readonly getRuntimeContext: () => SpiderStepRuntimeContext;
}

export type SpiderStepPlanMode = "plan-only" | "execute";

interface SwingClearancePlanResult {
  readonly cleared: boolean;
  readonly minimumClearance: number;
}

function mutableVector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function copyVector(target: MutableVec3, source: Vec3Like): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function smoothStep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

function sameAddress(left: StrandAddress | null, right: StrandAddress): boolean {
  return Boolean(
    left &&
      left.strandId === right.strandId &&
      Math.abs(left.t - right.t) <= 1e-7,
  );
}

/**
 * One-shot locomotion policy. It coordinates existing semantic traversal,
 * contacts, IK targets, and load distribution without owning any of those
 * lower-level systems or starting a repeating gait.
 */
export class SpiderStepController {
  readonly diagnostics: SpiderStepDiagnostics;
  readonly probe: ContactTestController;
  readonly swingTrajectory = new FootSwingTrajectory();
  readonly movingFootTarget = mutableVector();
  readonly movingFootVelocity = mutableVector();
  readonly targetWorldPosition = mutableVector();
  readonly targetFrame: ContactFrame = createContactFrame();
  readonly bodyAdvanceOffset = mutableVector();

  private readonly intentResolver: SpiderIntentResolver;
  private readonly generator: FootholdGenerator;
  private readonly scorer: FootholdScorer;
  private readonly legSelector = new LegSelector();
  private readonly swingSample: FootSwingSample = createFootSwingSample();
  private readonly clearanceSample: FootSwingSample = createFootSwingSample();
  private readonly clearancePoint = mutableVector();
  private readonly targetFrameTracker = new ContactFrameTracker();
  private readonly stepBaseBodyOffset = mutableVector();
  private readonly targetDelta = mutableVector();

  private movingLegIdValue: SpiderLegId | null = null;
  private originalAddress: StrandAddress | null = null;
  private swingElapsedSeconds = 0;
  private swingCurveValue: readonly MutableVec3[] = [];
  private hasMovingTargetValue = false;
  private bodyPlan: BodyAdvancePlan | null = null;
  private activeBodyAdvanceDistance: number;
  private activeBodyAdvanceReachSafetyFactor: number;
  private adaptiveBodyAdvanceActive = false;
  private bodyAdvanceAwaitingIkVersion: number | null = null;
  private pendingRestoreLegId: SpiderLegId | null = null;
  private pendingRestoreElapsedSeconds = 0;
  private loadTransferHoldFactorValue: number | null = null;
  private loadTransferReleaseStartFactor: number | null = null;
  private loadTransferReleaseElapsedSeconds = 0;
  private coupledBodyMotionCommitted = false;

  constructor(private readonly options: SpiderStepControllerOptions) {
    this.intentResolver = new SpiderIntentResolver(options.traversal);
    this.generator = new FootholdGenerator(options.traversal);
    this.scorer = new FootholdScorer(options.config.scoreWeights);
    this.probe = new ContactTestController(options.network, options.traversal);
    this.diagnostics = createSpiderStepDiagnostics(this.probe.snapshot);
    this.activeBodyAdvanceDistance = options.config.bodyAdvanceDistance;
    this.activeBodyAdvanceReachSafetyFactor = options.config.maximumRemainingReachRatio;
  }

  get state(): SpiderStepState {
    return this.diagnostics.state;
  }

  get movingLegId(): SpiderLegId | null {
    return this.movingLegIdValue;
  }

  get hasMovingFootTarget(): boolean {
    return this.hasMovingTargetValue;
  }

  get swingCurve(): readonly MutableVec3[] {
    return this.swingCurveValue;
  }

  get isExecuting(): boolean {
    return [
      "lifting",
      "swinging",
      "testing",
      "planting",
      "loading",
      "body-advance",
    ].includes(this.state);
  }

  get restorationPending(): boolean {
    return this.pendingRestoreLegId !== null;
  }

  /**
   * Optional Phase 8R yield point. The Phase 7 default is `null`, so its
   * validated one-step transaction still ramps directly to full load. A
   * coupled transaction may hold the freshly planted foot at a partial factor
   * while it performs one independently validated body-frame increment.
   */
  setLoadTransferHold(factor: number | null): void {
    if (
      factor === null &&
      this.loadTransferHoldFactorValue !== null &&
      this.state === "loading"
    ) {
      this.loadTransferReleaseStartFactor = this.diagnostics.loadTransfer;
      this.loadTransferReleaseElapsedSeconds = 0;
    } else if (factor !== null) {
      this.loadTransferReleaseStartFactor = null;
      this.loadTransferReleaseElapsedSeconds = 0;
    }
    this.loadTransferHoldFactorValue = factor === null
      ? null
      : clamp01(Number.isFinite(factor) ? factor : 0);
  }

  get loadTransferHoldFactor(): number | null {
    return this.loadTransferHoldFactorValue;
  }

  /**
   * Phase 8R opt-in only. When true, the wrapper has already applied the
   * transaction's reach-checked body increment while the new foot was
   * partially loaded. Phase 7 still owns the final full-load IK validation,
   * but must not plan a second body translation.
   */
  setCoupledBodyMotionCommitted(committed: boolean): void {
    this.coupledBodyMotionCommitted = Boolean(committed);
  }

  /** Candidate search happens only here, never in the animation loop. */
  requestDestination(
    destination: RouteDestination,
    mode: SpiderStepPlanMode = "execute",
  ): boolean {
    if (this.isExecuting || this.pendingRestoreLegId) {
      return false;
    }

    this.preparePlanning(destination);
    const runtime = this.options.getRuntimeContext();
    const routeOrigin = this.options.traversal.findClosestPoint(runtime.bodyWorldPosition, {
      traversableOnly: true,
      strandIds: runtime.routeStrandIds,
    });
    if (!routeOrigin) {
      this.fail("invalid-intent", "No traversable semantic strand exists below the body.", false);
      return false;
    }

    const resolution = this.intentResolver.resolve(
      {
        currentAddress: routeOrigin.address,
        destination,
        worldOrigin: runtime.bodyWorldPosition,
      },
      {
        lookaheadDistance: this.options.config.lookaheadDistance,
        maximumLocalRouteDistance: this.options.config.maximumLocalRouteDistance,
      },
    );
    if (!resolution.ok) {
      this.fail("invalid-intent", `${resolution.reason}: ${resolution.message}`, false);
      return false;
    }
    this.diagnostics.intent = resolution.intent;

    const planningInputs = this.createPlanningInputs(runtime);
    if (planningInputs.legs.length === 0) {
      this.fail("no-valid-candidate", "No planted semantic foot contact can seed candidate generation.", false);
      return false;
    }

    const generated = this.generator.generate({
      intent: resolution.intent,
      legs: planningInputs.legs,
      supports: planningInputs.supports,
      supportFrame: runtime.supportFrame,
      candidateSeeds: runtime.candidateSeeds,
      jointFeasibility: runtime.jointFeasibility,
      riskEstimator: runtime.riskEstimator,
      candidateValidator: runtime.candidateValidator,
      options: {
        searchRadius: this.options.config.candidateSearchRadius,
        samplesPerStrand: this.options.config.candidateSamplingDensity,
        retainRejected: true,
        referenceUp: runtime.supportFrame.up,
        minimumFootSpacing: this.options.config.minimumFootSpacing,
        minimumReachSafetyFactor:
          this.options.config.minimumCandidateReachSafetyFactor,
      },
    });
    this.scorer.setWeights(this.options.config.scoreWeights);
    this.scorer.scoreAll(generated.candidates);
    this.diagnostics.generation = generated;

    const adaptiveDistances = (runtime.bodyAdvanceDistanceCandidates ?? [])
      .filter((distance) => Number.isFinite(distance) && distance >= 0)
      .filter((distance, index, values) => values.indexOf(distance) === index)
      .sort((left, right) => right - left);
    const bodyAdvanceDistances = adaptiveDistances.length > 0
      ? adaptiveDistances
      : [this.options.config.bodyAdvanceDistance];
    this.adaptiveBodyAdvanceActive = adaptiveDistances.length > 0;
    let selection: LegSelectionResult | null = null;
    for (const bodyAdvanceDistance of bodyAdvanceDistances) {
      const reachSafetyFactor =
        this.adaptiveBodyAdvanceActive && bodyAdvanceDistance <= EPSILON
          ? 1
          : this.options.config.maximumRemainingReachRatio;
      selection = this.legSelector.select({
        intent: resolution.intent,
        candidates: generated.candidates,
        legs: planningInputs.policyLegs,
        options: {
          minimumSupportFootCount: this.options.config.minimumSupportFootCount,
          minimumScoreImprovement: this.options.config.minimumCandidateImprovement,
          minimumProgressImprovement: this.options.config.minimumProgressImprovement,
          maximumRemainingReachRatio: reachSafetyFactor,
          expectedBodyAdvanceDistance: bodyAdvanceDistance,
          minimumSupportSpacing: this.options.config.minimumFootSpacing,
          historyScoreAdjustments: runtime.legSelectionScoreAdjustments,
          candidateObjective: runtime.candidateObjective,
          allowGenericCandidateFallback: runtime.allowGenericCandidateFallback,
          previousMovingLegId: this.diagnostics.previousMovingLegId ?? undefined,
          activeMovingLegId: this.movingLegIdValue ?? undefined,
        },
      });
      this.activeBodyAdvanceDistance = bodyAdvanceDistance;
      this.activeBodyAdvanceReachSafetyFactor = reachSafetyFactor;
      if (selection.selection) break;
    }
    if (!selection) {
      throw new Error("Spider step selection requires at least one body-advance distance.");
    }
    this.diagnostics.plannedBodyAdvanceDistance = this.activeBodyAdvanceDistance;
    this.diagnostics.plannedBodyAdvanceReachSafetyFactor =
      this.activeBodyAdvanceReachSafetyFactor;
    this.diagnostics.adaptiveBodyAdvance = this.adaptiveBodyAdvanceActive;
    this.diagnostics.legSelection = selection;
    this.diagnostics.selectedPlan = selection.selection;
    this.diagnostics.movingLegId = selection.selection?.legId ?? null;
    this.diagnostics.requiresAdditionalSteps = resolution.intent.requiresAdditionalSteps;

    if (!selection.selection) {
      const reasons = selection.diagnostics
        .flatMap((entry) => entry.reasons.map((reason) => `${entry.legId}: ${reason}`))
        .slice(0, 8)
        .join("; ");
      this.fail(
        "no-valid-candidate",
        reasons || "No candidate improves progress while preserving the configured support set.",
        false,
      );
      return false;
    }

    if (mode === "execute" && !this.options.config.freezeAfterPlanning) {
      return this.executePlannedStep();
    }
    return true;
  }

  executePlannedStep(): boolean {
    if (this.state !== "planning" || !this.diagnostics.selectedPlan || !this.diagnostics.intent) {
      return false;
    }

    const selected = this.diagnostics.selectedPlan;
    const runtime = this.options.getRuntimeContext();
    const runtimeLeg = runtime.legs.find((leg) => leg.legId === selected.legId);
    const foot = this.options.contacts.get(selected.legId);
    if (!runtimeLeg || !foot || !runtimeLeg.address || !runtimeLeg.planted || !runtimeLeg.valid) {
      this.fail("target-unreachable", "The selected leg lost its stable planted contact before lift.", false);
      return false;
    }

    const supportSamples: SupportEstimateSample[] = runtime.legs.map((leg) => ({
      id: leg.legId,
      worldPosition: leg.contactWorldPosition,
      active: leg.planted && (leg.loadFactor ?? (leg.loaded ? 1 : 0)) > EPSILON,
      valid: leg.valid,
      reachValid: Number.isFinite(leg.currentReachRatio) && leg.currentReachRatio <= 1,
      weight: Math.max(EPSILON, leg.loadFactor ?? (leg.loaded ? 1 : 0)),
    }));
    const excluded = new Set<string>([selected.legId]);
    const supportEstimate = new SupportEstimator({
      minimumSupportCount: this.options.config.minimumSupportFootCount,
      minimumBroadness: 0.045,
      minimumBodyMargin: 0,
    }).estimate(supportSamples, {
      bodyWorldPosition: runtime.bodyWorldPosition,
      supportUp: runtime.supportFrame.up,
      supportForward: runtime.supportFrame.forward,
      excludedContactIds: excluded,
    });
    this.diagnostics.supportEstimate = supportEstimate;
    if (!supportEstimate.safe) {
      this.fail(
        "support-below-minimum",
        `Support estimate rejected lift: ${supportEstimate.failureReason}.`,
        false,
      );
      return false;
    }

    this.originalAddress = {
      strandId: runtimeLeg.address.strandId,
      t: runtimeLeg.address.t,
    };
    this.diagnostics.originalMovingFootAddress = this.originalAddress;
    this.diagnostics.stableSupportAddresses = runtime.legs
      .filter((leg) => leg.legId !== selected.legId && leg.address)
      .map((leg) => ({
        legId: leg.legId,
        address: { strandId: leg.address!.strandId, t: leg.address!.t },
      } satisfies StableAddressRecord));
    copyVector(this.stepBaseBodyOffset, this.bodyAdvanceOffset);
    copyVector(this.targetWorldPosition, selected.candidate.worldPosition);
    this.targetFrameTracker.reset();
    if (!this.refreshTarget(runtime.supportFrame.up)) {
      this.fail(
        "target-strand-unavailable",
        "The frozen candidate became inactive, broken, or non-finite before lift.",
        false,
      );
      return false;
    }
    if (!this.worldPointWithinLegReach(runtimeLeg, this.targetWorldPosition)) {
      this.fail(
        "target-unreachable",
        "The frozen candidate moved outside the selected leg's reach before lift.",
        false,
      );
      return false;
    }
    const refreshedFeasibility = runtime.jointFeasibility?.(
      {
        legId: runtimeLeg.legId,
        footHomeWorldPosition: runtimeLeg.footHomeWorldPosition,
        reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
        reach: runtimeLeg.reach,
        reachScale: runtimeLeg.reachScale,
        currentAddress: runtimeLeg.address,
        currentWorldPosition: runtimeLeg.contactWorldPosition,
      },
      selected.candidate.address,
      this.targetWorldPosition,
    );
    if (refreshedFeasibility && !refreshedFeasibility.feasible) {
      this.fail(
        "target-unreachable",
        refreshedFeasibility.reason ?? "The frozen candidate violates the selected leg's joint limits.",
        false,
      );
      return false;
    }

    const approachRadians = Math.max(
      THREE_EPSILON,
      (this.options.config.approachAngleDegrees * Math.PI) / 180,
    );
    const approachDistance = Math.min(
      this.options.config.candidateSearchRadius * 0.25,
      (this.options.config.liftHeight * 0.55) / Math.max(0.1, Math.tan(approachRadians)),
    );
    let swingClearance: SwingClearancePlanResult;
    try {
      swingClearance = this.planSwingWithClearance(
        runtimeLeg.contactWorldPosition,
        this.targetWorldPosition,
        { up: runtime.supportFrame.up, forward: this.diagnostics.intent.desiredDirection },
        {
          durationSeconds: this.options.config.swingDuration,
          liftDistance: this.options.config.liftHeight,
          forwardDistance: Math.min(0.06, this.options.config.candidateSearchRadius * 0.08),
          approachDistance,
          descentLiftRatio: 0.5,
        },
        runtimeLeg.address,
        selected.candidate.address,
      );
    } catch (error) {
      this.fail(
        "rig-not-ready",
        `Could not construct a finite swing trajectory: ${
          error instanceof Error ? error.message : String(error)
        }`,
        false,
      );
      return false;
    }
    if (!swingClearance.cleared) {
      this.fail(
        "swing-clearance-blocked",
        `No curved swing clears nearby active silk (${swingClearance.minimumClearance.toFixed(3)}u clearance).`,
        false,
      );
      return false;
    }

    this.swingCurveValue = this.swingTrajectory.sampleDebugCurve(25);
    this.swingElapsedSeconds = 0;
    this.movingLegIdValue = selected.legId;
    this.diagnostics.movingLegId = selected.legId;
    this.diagnostics.movingFootIk.finite = true;
    this.diagnostics.movingFootIk.reached = true;
    this.diagnostics.movingFootIk.residual = 0;
    this.diagnostics.loadTransfer = 0;
    this.options.loadDistributor.setFootLoadFactor(selected.legId, 0);
    foot.approach(selected.candidate.address);
    copyVector(this.movingFootTarget, runtimeLeg.contactWorldPosition);
    this.hasMovingTargetValue = true;
    this.transition("lifting", "Selected foot unloaded; all remaining supports stay planted.");
    return true;
  }

  update(fixedDelta: number): void {
    if (!Number.isFinite(fixedDelta) || fixedDelta < 0) return;
    if (this.pendingRestoreLegId) this.updatePendingRestoration(fixedDelta);
    if (!this.isExecuting) return;

    this.diagnostics.stateElapsedSeconds += fixedDelta;
    this.diagnostics.stepElapsedSeconds += fixedDelta;
    const runtime = this.options.getRuntimeContext();
    if (!this.validateStableSupports(runtime)) {
      this.fail("support-below-minimum", "A non-moving support foot changed address or became invalid.", true);
      return;
    }
    const nonFiniteSupport = runtime.legs.find(
      (leg) =>
        leg.legId !== this.movingLegIdValue &&
        leg.planted &&
        leg.valid &&
        (leg.ikFinite === false ||
          (leg.ikResidual !== undefined && !Number.isFinite(leg.ikResidual))),
    );
    if (nonFiniteSupport) {
      this.fail(
        "ik-non-finite",
        `Non-moving support ${nonFiniteSupport.legId} produced a non-finite IK result.`,
        true,
      );
      return;
    }
    if (!this.refreshTarget(runtime.supportFrame.up)) {
      this.fail("target-strand-unavailable", "The selected target strand became inactive, broken, or non-finite.", true);
      return;
    }
    if (!this.targetWithinReach(runtime)) {
      this.fail("target-unreachable", "Web motion carried the selected target outside the moving leg's reach.", true);
      return;
    }
    if (!this.diagnostics.movingFootIk.finite) {
      this.fail("ik-non-finite", "Moving-leg IK reported a non-finite result.", true);
      return;
    }

    switch (this.state) {
      case "lifting":
      case "swinging":
        this.updateSwing(fixedDelta);
        break;
      case "testing":
        this.updateTesting();
        break;
      case "planting":
        copyVector(this.movingFootTarget, this.targetWorldPosition);
        if (this.diagnostics.stateElapsedSeconds >= this.options.config.plantingDuration) {
          this.transition("loading", "Plant held at zero load; begin gradual weight transfer.");
        }
        break;
      case "loading":
        this.updateLoadTransfer(runtime, fixedDelta);
        break;
      case "body-advance":
        this.updateBodyAdvance(runtime);
        break;
    }
  }

  /** Called inside WebPhysicsSolver's external-force callback. */
  applyFixedStep(fixedDelta: number): void {
    if (this.state === "testing") {
      this.probe.applyFixedStep(fixedDelta);
    }
  }

  reportMovingFootIk(report: MovingFootIkReport): void {
    this.diagnostics.movingFootIk.finite = report.finite;
    this.diagnostics.movingFootIk.reached = report.reached;
    this.diagnostics.movingFootIk.residual = report.residual;
  }

  cancel(): void {
    if (this.state === "idle") return;
    this.fail("cancelled", "The developer cancelled the one-step sequence.", this.isExecuting);
  }

  reset(): void {
    this.probe.release();
    this.movingLegIdValue = null;
    this.originalAddress = null;
    this.hasMovingTargetValue = false;
    this.swingCurveValue = [];
    this.bodyPlan = null;
    this.activeBodyAdvanceDistance = this.options.config.bodyAdvanceDistance;
    this.activeBodyAdvanceReachSafetyFactor = this.options.config.maximumRemainingReachRatio;
    this.adaptiveBodyAdvanceActive = false;
    this.bodyAdvanceAwaitingIkVersion = null;
    this.pendingRestoreLegId = null;
    this.pendingRestoreElapsedSeconds = 0;
    this.loadTransferHoldFactorValue = null;
    this.loadTransferReleaseStartFactor = null;
    this.loadTransferReleaseElapsedSeconds = 0;
    this.coupledBodyMotionCommitted = false;
    this.bodyAdvanceOffset.x = 0;
    this.bodyAdvanceOffset.y = 0;
    this.bodyAdvanceOffset.z = 0;
    const completed = this.diagnostics.completedStepCount;
    const previous = this.diagnostics.previousMovingLegId;
    Object.assign(this.diagnostics, createSpiderStepDiagnostics(this.probe.snapshot));
    this.diagnostics.completedStepCount = completed;
    this.diagnostics.previousMovingLegId = previous;
    this.options.loadDistributor.resetFootLoadFactors();
  }

  private preparePlanning(destination: RouteDestination): void {
    this.probe.release();
    this.movingLegIdValue = null;
    this.originalAddress = null;
    this.hasMovingTargetValue = false;
    this.swingCurveValue = [];
    this.bodyPlan = null;
    this.activeBodyAdvanceDistance = this.options.config.bodyAdvanceDistance;
    this.activeBodyAdvanceReachSafetyFactor = this.options.config.maximumRemainingReachRatio;
    this.adaptiveBodyAdvanceActive = false;
    this.bodyAdvanceAwaitingIkVersion = null;
    this.pendingRestoreLegId = null;
    this.pendingRestoreElapsedSeconds = 0;
    this.loadTransferHoldFactorValue = null;
    this.loadTransferReleaseStartFactor = null;
    this.loadTransferReleaseElapsedSeconds = 0;
    this.coupledBodyMotionCommitted = false;
    this.diagnostics.requestedDestination = destination;
    this.diagnostics.intent = null;
    this.diagnostics.generation = null;
    this.diagnostics.legSelection = null;
    this.diagnostics.selectedPlan = null;
    this.diagnostics.movingLegId = null;
    this.diagnostics.originalMovingFootAddress = null;
    this.diagnostics.stableSupportAddresses = [];
    this.diagnostics.supportEstimate = null;
    this.diagnostics.bodyAdvancePlan = null;
    this.diagnostics.plannedBodyAdvanceDistance = this.options.config.bodyAdvanceDistance;
    this.diagnostics.plannedBodyAdvanceReachSafetyFactor =
      this.options.config.maximumRemainingReachRatio;
    this.diagnostics.adaptiveBodyAdvance = false;
    this.diagnostics.loadTransfer = 0;
    this.diagnostics.otherFootAddressesPreserved = true;
    this.diagnostics.failureReason = "none";
    this.diagnostics.failureMessage = "";
    this.diagnostics.stepElapsedSeconds = 0;
    this.diagnostics.transitions.length = 0;
    this.transition("planning", "A nearby semantic destination requested one deliberate step.");
  }

  private createPlanningInputs(runtime: SpiderStepRuntimeContext): {
    legs: FootholdLegContext[];
    supports: LocomotionSupportContact[];
    policyLegs: LocomotionLegPolicyState[];
  } {
    const legs: FootholdLegContext[] = [];
    const supports: LocomotionSupportContact[] = [];
    const policyLegs: LocomotionLegPolicyState[] = [];
    for (const runtimeLeg of runtime.legs) {
      if (!runtimeLeg.address) continue;
      legs.push({
        legId: runtimeLeg.legId,
        footHomeWorldPosition: runtimeLeg.footHomeWorldPosition,
        reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
        reach: runtimeLeg.reach,
        reachScale: runtimeLeg.reachScale,
        currentAddress: runtimeLeg.address,
        currentWorldPosition: runtimeLeg.contactWorldPosition,
        eligible: runtimeLeg.planted && runtimeLeg.loaded && runtimeLeg.valid,
      });
      supports.push({
        legId: runtimeLeg.legId,
        address: runtimeLeg.address,
        position: runtimeLeg.contactWorldPosition,
        planted: runtimeLeg.planted,
        loaded: runtimeLeg.loaded,
        valid: runtimeLeg.valid,
      });
      policyLegs.push({
        legId: runtimeLeg.legId,
        planted: runtimeLeg.planted,
        loaded: runtimeLeg.loaded,
        valid: runtimeLeg.valid,
        address: runtimeLeg.address,
        contactPosition: runtimeLeg.contactWorldPosition,
        reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
        maximumReach: runtimeLeg.reach.max * runtimeLeg.reachScale,
        currentReachRatio: runtimeLeg.currentReachRatio,
      });
    }
    return { legs, supports, policyLegs };
  }

  private updateSwing(fixedDelta: number): void {
    this.swingElapsedSeconds += fixedDelta;
    this.swingTrajectory.sampleAtTime(this.swingElapsedSeconds, this.swingSample);
    this.targetDelta.x = this.targetWorldPosition.x - this.swingTrajectory.end.x;
    this.targetDelta.y = this.targetWorldPosition.y - this.swingTrajectory.end.y;
    this.targetDelta.z = this.targetWorldPosition.z - this.swingTrajectory.end.z;
    const targetFollow = smoothStep(this.swingSample.normalizedTime);
    this.movingFootTarget.x = this.swingSample.position.x + this.targetDelta.x * targetFollow;
    this.movingFootTarget.y = this.swingSample.position.y + this.targetDelta.y * targetFollow;
    this.movingFootTarget.z = this.swingSample.position.z + this.targetDelta.z * targetFollow;
    copyVector(this.movingFootVelocity, this.swingSample.velocity);

    const liftBoundary = this.options.config.swingDuration * 0.24;
    if (this.state === "lifting" && this.swingElapsedSeconds >= liftBoundary) {
      this.transition("swinging", "Foot cleared the local support plane; continue along the curved path.");
    }
    if (this.swingSample.complete) {
      copyVector(this.movingFootTarget, this.targetWorldPosition);
      const runtime = this.options.getRuntimeContext();
      if (!this.probe.begin(
        this.diagnostics.selectedPlan!.candidate.address,
        runtime.supportFrame.up,
        this.options.config.probeForce,
      )) {
        this.fail("probe-response-non-finite", this.probe.snapshot.message, true);
        return;
      }
      this.transition("testing", "Target reached with zero foot load; temporary probe attached.");
    }
  }

  private updateTesting(): void {
    copyVector(this.movingFootTarget, this.targetWorldPosition);
    if (!this.probe.refresh()) {
      this.fail("probe-response-non-finite", this.probe.snapshot.message, true);
      return;
    }
    if (
      this.diagnostics.stateElapsedSeconds > 0.08 &&
      !this.diagnostics.movingFootIk.reached &&
      this.diagnostics.movingFootIk.residual > 0.05
    ) {
      this.fail("target-unreachable", "Moving-leg IK could not hold the probed contact.", true);
      return;
    }
    if (this.diagnostics.stateElapsedSeconds < this.options.config.testingDuration) return;

    this.probe.release();
    const selected = this.diagnostics.selectedPlan!;
    const foot = this.options.contacts.get(selected.legId);
    if (!foot) {
      this.fail("target-unreachable", "Moving foot state disappeared before planting.", true);
      return;
    }
    foot.plant(selected.candidate.address);
    this.options.loadDistributor.setFootLoadFactor(selected.legId, 0);
    this.transition("planting", "Finite probe response confirmed; semantic foot contact planted at zero load.");
  }

  private updateLoadTransfer(runtime: SpiderStepRuntimeContext, fixedDelta: number): void {
    copyVector(this.movingFootTarget, this.targetWorldPosition);
    const duration = Math.max(EPSILON, this.options.config.loadTransferDuration);
    const requestedFactor = smoothStep(this.diagnostics.stateElapsedSeconds / duration);
    let factor: number;
    if (this.loadTransferReleaseStartFactor !== null) {
      this.loadTransferReleaseElapsedSeconds += fixedDelta;
      const releaseStart = this.loadTransferReleaseStartFactor;
      const releaseDuration = Math.max(EPSILON, duration * (1 - releaseStart));
      factor = releaseStart +
        (1 - releaseStart) * smoothStep(this.loadTransferReleaseElapsedSeconds / releaseDuration);
      if (factor >= 1 - EPSILON) this.loadTransferReleaseStartFactor = null;
    } else {
      factor = this.loadTransferHoldFactorValue === null
        ? requestedFactor
        : Math.min(requestedFactor, this.loadTransferHoldFactorValue);
    }
    this.diagnostics.loadTransfer = factor;
    this.options.loadDistributor.setFootLoadFactor(this.diagnostics.selectedPlan!.legId, factor);
    if (
      this.loadTransferHoldFactorValue !== null &&
      requestedFactor + EPSILON >= this.loadTransferHoldFactorValue
    ) return;
    if (factor < 1 - EPSILON) return;

    this.options.loadDistributor.setFootLoadFactor(this.diagnostics.selectedPlan!.legId, 1);
    this.diagnostics.loadTransfer = 1;
    const heldContacts = runtime.legs
      .filter((leg) => leg.address && leg.planted && leg.valid)
      .map((leg) => ({
        id: leg.legId,
        address: leg.address!,
        contactWorldPosition: leg.contactWorldPosition,
        reachOriginWorldPosition: leg.reachOriginWorldPosition,
        maximumReach: leg.reach.max * leg.reachScale,
        minimumReach: leg.reach.min * leg.reachScale,
        valid: leg.valid,
        held: true,
      }));
    if (this.coupledBodyMotionCommitted) {
      const destination = this.diagnostics.intent!.destinationPosition;
      const dx = destination.x - runtime.bodyWorldPosition.x;
      const dy = destination.y - runtime.bodyWorldPosition.y;
      const dz = destination.z - runtime.bodyWorldPosition.z;
      const remainingDistance = Math.hypot(dx, dy, dz);
      this.bodyPlan = {
        displacement: { x: 0, y: 0, z: 0 },
        targetBodyPosition: {
          x: runtime.bodyWorldPosition.x,
          y: runtime.bodyWorldPosition.y,
          z: runtime.bodyWorldPosition.z,
        },
        success: true,
        failureReason: "none",
        requestedDistance: remainingDistance,
        plannedDistance: 0,
        remainingDistance,
        clampedByMaximumStep: remainingDistance > EPSILON,
        clampedByReach: false,
        anotherStepRequired: remainingDistance > EPSILON,
        limitingContactId: null,
        limitingContactAddress: null,
        limitingConstraint: null,
        maximumPredictedReachRatio: runtime.legs.reduce(
          (maximum, leg) => leg.planted && Number.isFinite(leg.currentReachRatio)
            ? Math.max(maximum, leg.currentReachRatio)
            : maximum,
          0,
        ),
        heldContactCount: heldContacts.length,
      };
      this.diagnostics.bodyAdvancePlan = this.bodyPlan;
      this.diagnostics.plannedBodyAdvanceDistance = 0;
      this.diagnostics.plannedBodyAdvanceReachSafetyFactor = 1;
      this.diagnostics.requiresAdditionalSteps ||= this.bodyPlan.anotherStepRequired;
      this.bodyAdvanceAwaitingIkVersion = null;
      this.transition(
        "body-advance",
        "Coupled body increment already committed; perform the final full-load IK validation.",
      );
      return;
    }
    this.bodyPlan = new BodyAdvancePlanner({
      maximumStepDistance: this.activeBodyAdvanceDistance,
      maximumReachSafetyFactor: this.activeBodyAdvanceReachSafetyFactor,
      minimumProgressDistance: this.adaptiveBodyAdvanceActive ? 0 : 0.005,
    }).plan({
      currentBodyPosition: runtime.bodyWorldPosition,
      destinationWorldPosition: this.diagnostics.intent!.destinationPosition,
      heldContacts,
    });
    if (!this.bodyPlan.success && this.adaptiveBodyAdvanceActive) {
      // The loaded web may shift after selection and consume the conservative
      // reach margin that justified a non-zero body step. Preserve the newly
      // secured foothold and finish the atomic transaction with zero body
      // translation under the physical reach limit; the coordinator will
      // settle and replan from the changed web.
      const stationaryFallback = new BodyAdvancePlanner({
        maximumStepDistance: 0,
        maximumReachSafetyFactor: 1,
        minimumProgressDistance: 0,
      }).plan({
        currentBodyPosition: runtime.bodyWorldPosition,
        destinationWorldPosition: this.diagnostics.intent!.destinationPosition,
        heldContacts,
      });
      if (stationaryFallback.success) {
        this.bodyPlan = stationaryFallback;
        this.activeBodyAdvanceDistance = 0;
        this.activeBodyAdvanceReachSafetyFactor = 1;
        this.diagnostics.plannedBodyAdvanceDistance = 0;
        this.diagnostics.plannedBodyAdvanceReachSafetyFactor = 1;
      }
    }
    this.diagnostics.bodyAdvancePlan = this.bodyPlan;
    if (!this.bodyPlan.success) {
      this.fail(
        "body-advance-overextends-support",
        `Body advance rejected: ${this.bodyPlan.failureReason}.`,
        true,
      );
      return;
    }
    this.diagnostics.requiresAdditionalSteps ||= this.bodyPlan.anotherStepRequired;
    this.bodyAdvanceAwaitingIkVersion = null;
    this.transition("body-advance", "New foothold is fully loaded; begin one bounded body translation.");
  }

  private updateBodyAdvance(runtime: SpiderStepRuntimeContext): void {
    if (!this.bodyPlan) {
      this.fail("body-advance-overextends-support", "Body advance plan is missing.", true);
      return;
    }
    const duration = Math.max(EPSILON, this.options.config.bodyAdvanceDuration);
    const factor = smoothStep(this.diagnostics.stateElapsedSeconds / duration);
    this.bodyAdvanceOffset.x = this.stepBaseBodyOffset.x + this.bodyPlan.displacement.x * factor;
    this.bodyAdvanceOffset.y = this.stepBaseBodyOffset.y + this.bodyPlan.displacement.y * factor;
    this.bodyAdvanceOffset.z = this.stepBaseBodyOffset.z + this.bodyPlan.displacement.z * factor;
    if (factor < 1 - EPSILON) return;

    // The body offset is consumed by the render-side rig solver. Wait until at
    // least one complete IK pass has observed the final offset, then validate
    // every planted semantic support rather than only the moving foot.
    const ikSolveVersion = runtime.ikSolveVersion ?? 0;
    if (this.bodyAdvanceAwaitingIkVersion === null) {
      this.bodyAdvanceAwaitingIkVersion = ikSolveVersion;
      return;
    }
    if (ikSolveVersion <= this.bodyAdvanceAwaitingIkVersion) return;

    const invalidSupport = runtime.legs.find(
      (leg) =>
        leg.planted &&
        leg.valid &&
        (leg.ikFinite === false ||
          !Number.isFinite(leg.ikResidual ?? Infinity) ||
          (leg.ikReached === false && (leg.ikResidual ?? Infinity) > 0.05)),
    );
    if (invalidSupport) {
      const nonFinite =
        invalidSupport.ikFinite === false ||
        !Number.isFinite(invalidSupport.ikResidual ?? Infinity);
      this.fail(
        nonFinite ? "ik-non-finite" : "body-advance-overextends-support",
        nonFinite
          ? `Planted leg ${invalidSupport.legId} produced a non-finite IK result after body advance.`
          : `Planted leg ${invalidSupport.legId} could not hold its semantic address after body advance.`,
        true,
      );
      return;
    }

    const completedLeg = this.movingLegIdValue;
    this.hasMovingTargetValue = false;
    this.movingLegIdValue = null;
    this.diagnostics.movingLegId = null;
    this.diagnostics.previousMovingLegId = completedLeg;
    this.diagnostics.completedStepCount += 1;
    this.coupledBodyMotionCommitted = false;
    this.transition("complete", "One secure autonomous step and bounded body advance completed.");
  }

  private planSwingWithClearance(
    start: Vec3Like,
    end: Vec3Like,
    supportFrame: FootSwingSupportFrame,
    config: FootSwingTrajectoryConfig,
    currentAddress: StrandAddress,
    targetAddress: StrandAddress,
  ): SwingClearancePlanResult {
    const requiredClearance = Math.max(0, this.options.config.minimumSwingClearance);
    let liftDistance = config.liftDistance;
    let bestClearance = -Infinity;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      this.swingTrajectory.plan(start, end, supportFrame, {
        ...config,
        liftDistance,
      });
      bestClearance = this.minimumSwingClearance(currentAddress, targetAddress);
      if (bestClearance >= requiredClearance) {
        return { cleared: true, minimumClearance: bestClearance };
      }
      liftDistance += Math.max(0.045, requiredClearance - bestClearance + 0.025);
    }
    return { cleared: false, minimumClearance: bestClearance };
  }

  /** Planning-only semantic clearance query; it never inspects physics particle IDs. */
  private minimumSwingClearance(
    currentAddress: StrandAddress,
    targetAddress: StrandAddress,
  ): number {
    let minimumSquared = Infinity;
    const curveSamples = 17;
    const strandSamples = Math.max(
      16,
      Math.min(32, this.options.config.candidateSamplingDensity * 2),
    );

    for (let curveIndex = 0; curveIndex < curveSamples; curveIndex += 1) {
      const normalizedTime = 0.22 + (curveIndex / (curveSamples - 1)) * 0.56;
      this.swingTrajectory.sampleNormalized(normalizedTime, this.clearanceSample);
      const swingPoint = this.clearanceSample.position;
      for (const strand of this.options.network.strandList) {
        if (!strand.active || strand.broken) continue;
        for (let strandIndex = 0; strandIndex <= strandSamples; strandIndex += 1) {
          const t = strandIndex / strandSamples;
          if (
            strand.id === currentAddress.strandId &&
            normalizedTime < 0.36 &&
            Math.abs(t - currentAddress.t) < 0.12
          ) {
            continue;
          }
          if (
            strand.id === targetAddress.strandId &&
            normalizedTime > 0.64 &&
            Math.abs(t - targetAddress.t) < 0.12
          ) {
            continue;
          }
          try {
            this.options.traversal.getWorldPosition(
              { strandId: strand.id, t },
              this.clearancePoint,
            );
          } catch {
            continue;
          }
          const dx = swingPoint.x - this.clearancePoint.x;
          const dy = swingPoint.y - this.clearancePoint.y;
          const dz = swingPoint.z - this.clearancePoint.z;
          const squared = dx * dx + dy * dy + dz * dz;
          if (squared < minimumSquared) minimumSquared = squared;
        }
      }
    }
    return Number.isFinite(minimumSquared) ? Math.sqrt(minimumSquared) : Infinity;
  }

  private worldPointWithinLegReach(
    leg: SpiderStepRuntimeLeg,
    point: Vec3Like,
  ): boolean {
    const distance = Math.hypot(
      point.x - leg.reachOriginWorldPosition.x,
      point.y - leg.reachOriginWorldPosition.y,
      point.z - leg.reachOriginWorldPosition.z,
    );
    const scale = leg.reachScale;
    return (
      Number.isFinite(distance) &&
      distance >= leg.reach.min * scale * 0.96 &&
      distance <= leg.reach.max * scale * 1.025
    );
  }

  private refreshTarget(referenceUp: Vec3Like): boolean {
    const targetAddress = this.diagnostics.selectedPlan?.candidate.address;
    if (!targetAddress) return false;
    try {
      const state = this.options.traversal.getStrandState(targetAddress.strandId);
      if (!state.traversable) return false;
      this.options.traversal.getWorldPosition(targetAddress, this.targetWorldPosition);
      this.options.traversal.getContactFrame(
        targetAddress,
        this.targetFrame,
        this.targetFrameTracker,
        referenceUp,
      );
      return (
        finiteVector(this.targetWorldPosition) &&
        finiteVector(this.targetFrame.tangent) &&
        finiteVector(this.targetFrame.normal) &&
        finiteVector(this.targetFrame.binormal)
      );
    } catch {
      return false;
    }
  }

  private targetWithinReach(runtime: SpiderStepRuntimeContext): boolean {
    if (!this.movingLegIdValue) return true;
    const leg = runtime.legs.find((entry) => entry.legId === this.movingLegIdValue);
    if (!leg) return false;
    return this.worldPointWithinLegReach(leg, this.targetWorldPosition);
  }

  private validateStableSupports(runtime: SpiderStepRuntimeContext): boolean {
    let validLoadedCount = 0;
    let addressesPreserved = true;
    for (const stable of this.diagnostics.stableSupportAddresses) {
      const runtimeLeg = runtime.legs.find((leg) => leg.legId === stable.legId);
      if (!runtimeLeg || !sameAddress(runtimeLeg.address, stable.address)) {
        addressesPreserved = false;
        continue;
      }
      if (runtimeLeg.planted && runtimeLeg.loaded && runtimeLeg.valid) validLoadedCount += 1;
    }
    this.diagnostics.otherFootAddressesPreserved = addressesPreserved;
    return addressesPreserved && validLoadedCount >= this.options.config.minimumSupportFootCount;
  }

  private updatePendingRestoration(fixedDelta: number): void {
    const legId = this.pendingRestoreLegId;
    if (!legId || !this.originalAddress) return;
    this.pendingRestoreElapsedSeconds += fixedDelta;
    const foot = this.options.contacts.get(legId);
    const runtime = this.options.getRuntimeContext();
    const runtimeLeg = runtime.legs.find((leg) => leg.legId === legId);
    if (foot && runtimeLeg) {
      const restored = foot.update(this.options.traversal, {
        footHomeWorldPosition: runtimeLeg.footHomeWorldPosition,
        reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
        // Recovery may begin just outside the nominal sphere because removing
        // the foot load lets elastic silk rebound. Resolve against a small,
        // explicit recovery envelope, then use a partial freshly-resolved load
        // to pull the same material address back into strict reach.
        reachScale: runtimeLeg.reachScale * 1.15,
        referenceUp: runtime.supportFrame.up,
      });
      if (restored && foot.contactValid && sameAddress(foot.address, this.originalAddress)) {
        const strictDistance = Math.hypot(
          foot.worldPosition.x - runtimeLeg.reachOriginWorldPosition.x,
          foot.worldPosition.y - runtimeLeg.reachOriginWorldPosition.y,
          foot.worldPosition.z - runtimeLeg.reachOriginWorldPosition.z,
        );
        const strictMinimum = runtimeLeg.reach.min * runtimeLeg.reachScale;
        const strictMaximum = runtimeLeg.reach.max * runtimeLeg.reachScale;
        const insideStrictReach =
          Number.isFinite(strictDistance) &&
          strictDistance >= strictMinimum &&
          strictDistance <= strictMaximum;
        this.options.loadDistributor.setFootLoadFactor(legId, insideStrictReach ? 1 : 0.5);
        if (insideStrictReach) {
          this.pendingRestoreLegId = null;
          this.pendingRestoreElapsedSeconds = 0;
          return;
        }
      }
    }

    if (this.pendingRestoreElapsedSeconds < 2) return;
    this.options.loadDistributor.setFootLoadFactor(legId, 0);
    foot?.reset();
    this.pendingRestoreLegId = null;
    this.pendingRestoreElapsedSeconds = 0;
    const detail = `Could not restore ${legId}: original contact did not re-resolve inside reach.`;
    this.diagnostics.failureMessage = this.diagnostics.failureMessage
      ? `${this.diagnostics.failureMessage} ${detail}`
      : detail;
  }

  private restoreMovingFoot(): string | null {
    const legId = this.movingLegIdValue ?? this.diagnostics.selectedPlan?.legId ?? null;
    if (!legId) return null;
    copyVector(this.bodyAdvanceOffset, this.stepBaseBodyOffset);
    const foot = this.options.contacts.get(legId);
    this.options.loadDistributor.setFootLoadFactor(legId, 0);
    if (!foot || !this.originalAddress) {
      return `Could not restore ${legId}: its original semantic contact is unavailable.`;
    }

    const runtime = this.options.getRuntimeContext();
    const runtimeLeg = runtime.legs.find((leg) => leg.legId === legId);
    if (!runtimeLeg) {
      foot.reset();
      return `Could not restore ${legId}: its rig context is unavailable.`;
    }

    try {
      const state = this.options.traversal.getStrandState(this.originalAddress.strandId);
      if (!state.traversable) {
        foot.reset();
        return `Could not restore ${legId}: original strand ${this.originalAddress.strandId} is unavailable.`;
      }
      // reset() clears cached resolution so no load can be restored from stale
      // world data. Resolve the semantic address immediately at zero load.
      foot.reset().plant(this.originalAddress);
      const restored = foot.update(this.options.traversal, {
        footHomeWorldPosition: runtimeLeg.footHomeWorldPosition,
        reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
        reachScale: runtimeLeg.reachScale,
        referenceUp: runtime.supportFrame.up,
      });
      if (!restored || !foot.contactValid) {
        // Keep the semantic address planted at zero load. The web can move
        // while a swing is in progress, so give the regular fixed-step/update
        // loop a bounded window to re-resolve it before declaring recovery
        // impossible. No stale contact is loaded during that window.
        this.pendingRestoreLegId = legId;
        this.pendingRestoreElapsedSeconds = 0;
        return null;
      }
    } catch (error) {
      foot.reset();
      return `Could not restore ${legId}: ${error instanceof Error ? error.message : String(error)}`;
    }
    this.options.loadDistributor.setFootLoadFactor(legId, 1);
    return null;
  }

  private fail(
    reason: SpiderStepFailureReason,
    message: string,
    restoreMovingFoot: boolean,
  ): void {
    this.probe.release();
    const restorationFailure = restoreMovingFoot ? this.restoreMovingFoot() : null;
    this.hasMovingTargetValue = false;
    this.movingLegIdValue = null;
    this.diagnostics.movingLegId = null;
    this.diagnostics.failureReason = reason;
    this.diagnostics.failureMessage = restorationFailure
      ? `${message} ${restorationFailure}`
      : message;
    this.loadTransferHoldFactorValue = null;
    this.loadTransferReleaseStartFactor = null;
    this.loadTransferReleaseElapsedSeconds = 0;
    this.transition("failed", this.diagnostics.failureMessage);
  }

  private transition(state: SpiderStepState, reason: string): void {
    const from = this.diagnostics.state;
    if (from === state && state !== "planning") return;
    this.diagnostics.transitions.push({
      from,
      to: state,
      elapsedSeconds: this.diagnostics.stepElapsedSeconds,
      reason,
    });
    this.diagnostics.state = state;
    this.diagnostics.stateElapsedSeconds = 0;
  }
}

// Named constant avoids a magic literal in the approach-angle guard while
// keeping this module independent of Three.js.
const THREE_EPSILON = 1e-5;
