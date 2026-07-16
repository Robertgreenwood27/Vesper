import type { RouteDestination, StrandAddress } from "../../traversal";
import type { SpiderLegId } from "../SpiderRigSpec";
import type { BodyAdvancePlan } from "./BodyAdvancePlanner";
import type { ContactTestSnapshot } from "./ContactTestController";
import type {
  FootholdGenerationResult,
  LegSelectionResult,
  ResolvedSpiderIntent,
  SelectedLegPlan,
} from "./LocomotionTypes";
import type { SpiderStepFailureReason, SpiderStepState, SpiderStepTransition } from "./SpiderStepState";
import type { SupportEstimate } from "./SupportEstimator";

export interface MovingFootIkReport {
  finite: boolean;
  reached: boolean;
  residual: number;
}

export interface StableAddressRecord {
  readonly legId: SpiderLegId;
  readonly address: StrandAddress;
}

function finiteFrame(plan: SelectedLegPlan | null): boolean {
  if (!plan) return false;
  const { tangent, normal, binormal } = plan.candidate;
  const axes = [tangent, normal, binormal];
  if (!axes.every((axis) =>
    Number.isFinite(axis.x) &&
    Number.isFinite(axis.y) &&
    Number.isFinite(axis.z) &&
    Math.hypot(axis.x, axis.y, axis.z) > 0.5)) {
    return false;
  }
  const dot = (
    left: typeof tangent,
    right: typeof tangent,
  ) => left.x * right.x + left.y * right.y + left.z * right.z;
  return (
    Math.abs(dot(tangent, normal)) < 0.15 &&
    Math.abs(dot(tangent, binormal)) < 0.15 &&
    Math.abs(dot(normal, binormal)) < 0.15
  );
}

/** Evidence that support was checked successfully before the foot was released. */
export function hasSecureReleaseEvidence(
  diagnostics: Pick<SpiderStepDiagnostics, "supportEstimate" | "transitions">,
): boolean {
  return Boolean(
    diagnostics.supportEstimate?.safe &&
      diagnostics.transitions.some((transition) => transition.to === "lifting"),
  );
}

/** Evidence that a finite local contact frame existed when the planned swing began. */
export function hasLocalFrameSwingEvidence(
  diagnostics: Pick<SpiderStepDiagnostics, "selectedPlan" | "transitions">,
): boolean {
  return (
    finiteFrame(diagnostics.selectedPlan) &&
    diagnostics.transitions.some((transition) => transition.to === "lifting")
  );
}

/** Read-only-by-convention state exposed to rendering, the panel, and QA. */
export interface SpiderStepDiagnostics {
  state: SpiderStepState;
  stateElapsedSeconds: number;
  stepElapsedSeconds: number;
  requestedDestination: RouteDestination | null;
  intent: ResolvedSpiderIntent | null;
  generation: FootholdGenerationResult | null;
  legSelection: LegSelectionResult | null;
  selectedPlan: SelectedLegPlan | null;
  movingLegId: SpiderLegId | null;
  previousMovingLegId: SpiderLegId | null;
  originalMovingFootAddress: StrandAddress | null;
  stableSupportAddresses: readonly StableAddressRecord[];
  supportEstimate: SupportEstimate | null;
  bodyAdvancePlan: BodyAdvancePlan | null;
  /** Step-local distance selected before lift; may be zero for a catch-up foothold. */
  plannedBodyAdvanceDistance: number;
  plannedBodyAdvanceReachSafetyFactor: number;
  /** True only when a higher-level caller opted into bounded distance sampling. */
  adaptiveBodyAdvance: boolean;
  probe: ContactTestSnapshot;
  movingFootIk: MovingFootIkReport;
  loadTransfer: number;
  otherFootAddressesPreserved: boolean;
  /** Derived from a safe support estimate plus an actual lift transition. */
  readonly secureBeforeRelease: boolean;
  /** Derived from a finite selected contact frame plus a planned lift. */
  readonly localFrameSwing: boolean;
  requiresAdditionalSteps: boolean;
  completedStepCount: number;
  failureReason: SpiderStepFailureReason;
  failureMessage: string;
  transitions: SpiderStepTransition[];
}

export function createSpiderStepDiagnostics(
  probe: ContactTestSnapshot,
): SpiderStepDiagnostics {
  const diagnostics: SpiderStepDiagnostics = {
    state: "idle",
    stateElapsedSeconds: 0,
    stepElapsedSeconds: 0,
    requestedDestination: null,
    intent: null,
    generation: null,
    legSelection: null,
    selectedPlan: null,
    movingLegId: null,
    previousMovingLegId: null,
    originalMovingFootAddress: null,
    stableSupportAddresses: [],
    supportEstimate: null,
    bodyAdvancePlan: null,
    plannedBodyAdvanceDistance: 0,
    plannedBodyAdvanceReachSafetyFactor: 1,
    adaptiveBodyAdvance: false,
    probe,
    movingFootIk: { finite: true, reached: true, residual: 0 },
    loadTransfer: 0,
    otherFootAddressesPreserved: true,
    secureBeforeRelease: false,
    localFrameSwing: false,
    requiresAdditionalSteps: false,
    completedStepCount: 0,
    failureReason: "none",
    failureMessage: "",
    transitions: [],
  };

  // `SpiderStepController.reset` assigns a fresh diagnostics object over this
  // one. No-op setters keep these derived properties compatible with that
  // reset path while preventing assignment from turning evidence into claims.
  Object.defineProperties(diagnostics, {
    secureBeforeRelease: {
      enumerable: true,
      configurable: false,
      get: () => hasSecureReleaseEvidence(diagnostics),
      set: () => undefined,
    },
    localFrameSwing: {
      enumerable: true,
      configurable: false,
      get: () => hasLocalFrameSwingEvidence(diagnostics),
      set: () => undefined,
    },
  });

  return diagnostics;
}
