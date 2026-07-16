import * as THREE from "three";
import "./styles.css";
import {
  FIXED_TIME_STEP,
  MAX_FRAME_DELTA,
  MAX_SUBSTEPS,
  labConfig,
} from "./config";
import { InteractionController } from "./interaction/InteractionController";
import { WebPhysicsSolver } from "./physics/WebPhysicsSolver";
import {
  createEmptyLocomotionDebugSnapshot,
  LocomotionDebugRenderer,
  type LocomotionDebugSnapshot,
} from "./rendering/LocomotionDebugRenderer";
import {
  createJunctionTraversalDebugToggles,
  JunctionTraversalDebugRenderer,
  type JunctionDebugCandidate,
  type JunctionTraversalDebugSnapshot,
} from "./rendering/JunctionTraversalDebugRenderer";
import {
  SpiderDebugRenderer,
  type SpiderDebugIkResult,
  type SpiderDebugSnapshot,
} from "./rendering/SpiderDebugRenderer";
import { WebRenderer } from "./rendering/WebRenderer";
import {
  SpiderBodyPose,
  type SpiderSupportSample,
} from "./spider/SpiderBodyPose";
import { spiderConfig } from "./spider/SpiderConfig";
import {
  createBlackWidowFootContacts,
  type SpiderFootContact,
} from "./spider/SpiderFootContact";
import {
  SpiderIKSolver,
  type SpiderIKChainDefinition,
  type SpiderIKSolveResult,
} from "./spider/SpiderIKSolver";
import { SpiderLoadDistributor } from "./spider/SpiderLoadDistributor";
import {
  FootOrientationPolicy,
  type FootOrientationResult,
} from "./spider/locomotion/FootOrientationPolicy";
import { locomotionConfig } from "./spider/locomotion/LocomotionConfig";
import { SupportEstimator } from "./spider/locomotion/SupportEstimator";
import { JointLimitFeasibilityProbe } from "./spider/locomotion/JointLimitFeasibilityProbe";
import {
  SpiderStepController,
  type SpiderStepRuntimeContext,
  type SpiderStepRuntimeLeg,
} from "./spider/locomotion/SpiderStepController";
import type {
  FootholdCandidateObjective,
  FootholdCandidateSeed,
} from "./spider/locomotion/LocomotionTypes";
import {
  formatSpiderRigResolutionReport,
  type SpiderRig,
} from "./spider/SpiderRig";
import { loadSpiderRig } from "./spider/SpiderRigLoader";
import {
  SPIDER_LEG_IDS,
  type SpiderJointLimitSpec,
  type SpiderLegId,
} from "./spider/SpiderRigSpec";
import {
  createWebNetworkTraversal,
  WebRoutePlanner,
  type PlannedRoute,
  type RouteDestination,
  type StrandAddress,
} from "./traversal";
import {
  LocomotionDebugPanel,
  type LocomotionValidationScenario,
} from "./ui/LocomotionDebugPanel";
import {
  JunctionTraversalDebugPanel,
  type JunctionTraversalPanelMetrics,
} from "./ui/JunctionTraversalDebugPanel";
import {
  createPhaseEightFixture,
  type PhaseEightBranchId,
  type PhaseEightFixture,
  type PhaseEightValidationScenarioId,
} from "./web/createPhaseEightFixture";
import { createTraversalPolicyConfig } from "./spider/traversal/TraversalConfig";
import { LegMovementHistory } from "./spider/traversal/LegMovementHistory";
import {
  BodyOrientationPlanner,
  createBodyOrientationPlan,
} from "./spider/traversal/BodyOrientationPlanner";
import { LocalRecoveryPlanner } from "./spider/traversal/LocalRecoveryPlanner";
import { ReachBudgetController } from "./spider/traversal/ReachBudgetController";
import {
  isRecoveryFootholdExcluded,
  type RecoveryFootholdExclusion,
} from "./spider/traversal/RecoveryFootholdExclusion";
import {
  bodyNearDestinationInSemanticBranchFrame,
  DestinationBranchFrameEstimator,
  createDestinationBranchFrameEstimate,
  type DestinationBranchFrameEstimate,
} from "./spider/traversal/DestinationBranchFrameEstimator";
import {
  CoupledTransferTransaction,
  createCoupledBodyMotionDiagnostics,
  type CoupledBodyMotionDiagnostics,
  type CoupledBodyMotionRequest,
} from "./spider/traversal/CoupledTransferTransaction";
import {
  JunctionProgressEstimator,
  createJunctionProgressEstimate,
} from "./spider/traversal/JunctionProgressEstimator";
import {
  JunctionTraversalCoordinator,
  createCoordinatorProgressSnapshot,
  type AtomicStepHistoryEvent,
  type JunctionRecoveryRequest,
  type JunctionTraversalPolicyContext,
  type JunctionTraversalProgressSnapshot,
} from "./spider/traversal/JunctionTraversalCoordinator";
import {
  boundedStrategyAlternativeAvailable,
  selectTransitionStrategy,
  TransitionStrategyController,
  type TransitionStrategyDirective,
  type TransitionStrategyProgress,
} from "./spider/traversal/TransitionStrategyController";
import type {
  JunctionProgressEstimate,
  BodyOrientationPlan,
  CircumferentialContactClassification,
  JunctionPosturePhase,
  LegHistoryScoreInfluence,
  LegHistorySnapshot,
  LocalRecoveryCandidate,
} from "./spider/traversal/TraversalTypes";

const canvasElement = document.querySelector<HTMLCanvasElement>("#web-canvas");
const debugRootElement = document.querySelector<HTMLElement>("#debug-root");
const labelLayerElement = document.querySelector<HTMLElement>("#node-labels");
const tensionLegendElement = document.querySelector<HTMLElement>("#tension-legend");

if (!canvasElement || !debugRootElement || !labelLayerElement || !tensionLegendElement) {
  throw new Error("Bothria Phase 8 mount points are missing.");
}

const canvas = canvasElement;
const debugRoot = debugRootElement;
const labelLayer = labelLayerElement;
const tensionLegend = tensionLegendElement;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(39, 1, 0.05, 100);
camera.up.set(0, 1, 0);
const cameraTarget = new THREE.Vector3();
const cameraDirection = new THREE.Vector3(0.5, 0.58, 0.72).normalize();

const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x000000, 0);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const hemisphere = new THREE.HemisphereLight(0xd7f2ff, 0x071018, 2.45);
const keyLight = new THREE.DirectionalLight(0xc6efff, 4.2);
keyLight.position.set(-2.8, 4.5, 3.4);
const rimLight = new THREE.DirectionalLight(0xff5e8b, 2.25);
rimLight.position.set(3.4, 1.2, -4.5);
scene.add(hemisphere, keyLight, rimLight);

let fixture: PhaseEightFixture = createPhaseEightFixture(labConfig);
let network = fixture.network;
let traversal = createWebNetworkTraversal(network, FIXED_TIME_STEP);
let routePlanner = new WebRoutePlanner(traversal);
const mainRouteStrandIds = new Set<string>([
  fixture.strandIds.approachMain,
  fixture.strandIds.forwardMain,
  fixture.strandIds.angledMain,
]);
const traversalPolicyConfig = createTraversalPolicyConfig({
  scheduler: {
    // Generic travel intentionally takes smaller fail-closed body increments
    // than the earlier emergent experiment. Keep the outer route bound wide
    // enough for a full branch traverse; procedural stages retain their much
    // tighter independent transaction and stagnation limits.
    maximumStepCount: 256,
    settleDurationSeconds: 0.14,
    // A destination address denotes the center of a stable branch region. The
    // thorax is expected to settle behind leading feet rather than coincide
    // with that foot-scale address exactly.
    arrivalMaterialTolerance: 0.3,
    arrivalWorldTolerance: 0.3,
  },
  history: {
    foldedLegUrgency: 6,
    foldedReachThreshold: 0.5,
  },
  junction: {
    destinationSideSupportThreshold: 3,
    minimumDestinationSideWorldSpread: 0.2,
    bodyCrossingDistance: 0.4,
    clearBodyDistance: 0.64,
  },
  orientation: {
    maximumTranslationPerStep: 0.1,
    maximumRotationRadiansPerStep: Math.PI / 14,
    // Keep a small planning reserve for live web deformation. ReachBudget and
    // the runtime IK checks still enforce the exact anatomical hard limit.
    maximumReachSafetyFactor: 0.96,
    minimumReachSafetyFactor: 0.8,
  },
  recovery: { maximumAttempts: 4 },
});
let legMovementHistory = new LegMovementHistory(traversalPolicyConfig.history);
let junctionProgressEstimator = new JunctionProgressEstimator(
  traversal,
  traversalPolicyConfig.junction,
);
let bodyOrientationPlanner = new BodyOrientationPlanner(
  traversal,
  traversalPolicyConfig.orientation,
);
let destinationBranchFrameEstimator = new DestinationBranchFrameEstimator(traversal, {
  defaultLookaheadMaterialDistance: 0.16,
  tangentSampleMaterialDistance: 0.035,
});
let localRecoveryPlanner = new LocalRecoveryPlanner(
  traversal,
  traversalPolicyConfig.recovery,
);
const reachBudgetController = new ReachBudgetController({
  fractionSamples: [0.02, 0.04, 0.06, 0.1, 0.16, 0.25, 0.4, 0.6, 0.8, 1],
  // Keep enough physical reserve for live silk motion between planning and
  // the fresh full-load observation. A contact transfer may still complete
  // without body motion when no safe useful increment fits this soft guard.
  worstReachWorseningTolerance: 0.02,
  reachImprovementEpsilon: 1e-5,
  minimumUsefulTranslation: 0.0005,
  minimumUsefulRotationRadians: 0.0005,
  trailingUrgencyWeight: 2.4,
  reachImprovementScoreWeight: 4,
});
let paused = false;
let accumulator = 0;
let rigStatus = "LOADING";
let rigNames = "PENDING";
let rigLoadError: string | null = null;
let selectedScenario: LocomotionValidationScenario = "forward";
let selectedTraversalScenario: PhaseEightValidationScenarioId = "A";
const standardMinimumProgressImprovement = locomotionConfig.minimumProgressImprovement;
const phaseEightMinimumProgressImprovement = -0.005;
const standardCandidateSearchRadius = locomotionConfig.candidateSearchRadius;
const standardCandidateSamplingDensity = locomotionConfig.candidateSamplingDensity;
const standardMinimumFootSpacing = locomotionConfig.minimumFootSpacing;
const standardFootholdScoreWeights = { ...locomotionConfig.scoreWeights };
const standardLocomotionTiming = {
  swingDuration: locomotionConfig.swingDuration,
  minimumSwingClearance: locomotionConfig.minimumSwingClearance,
  minimumCandidateReachSafetyFactor:
    locomotionConfig.minimumCandidateReachSafetyFactor,
  minimumCandidateImprovement: locomotionConfig.minimumCandidateImprovement,
  testingDuration: locomotionConfig.testingDuration,
  plantingDuration: locomotionConfig.plantingDuration,
  loadTransferDuration: locomotionConfig.loadTransferDuration,
  bodyAdvanceDuration: locomotionConfig.bodyAdvanceDuration,
};
const phaseEightLocomotionTiming = {
  swingDuration: 0.42,
  // The compact junction packs parallel supports inside the Phase 7 course's
  // conservative free-space envelope while remaining wider than rendered silk.
  minimumSwingClearance: 0.012,
  minimumCandidateReachSafetyFactor: 1.5,
  // A junction approach sometimes requires trading a little local foothold
  // comfort for positive semantic route progress. All hard safety gates remain.
  minimumCandidateImprovement: -2.5,
  testingDuration: 0.12,
  plantingDuration: 0.08,
  loadTransferDuration: 0.22,
  bodyAdvanceDuration: 0.28,
};
// Phase 8 normally keeps the proven Phase 7 ten-centimetre body transaction.
// A repeated-step policy may temporarily reduce this to zero when every
// possible lift would otherwise overextend a remaining planted leg. That
// stationary transaction is a real foothold catch-up step, not a direct
// foot edit, and the normal body advance resumes as soon as one lift is safe.
const phaseEightBodyAdvanceDistance = 0.1;
const phaseEightBodyAdvanceDistanceCandidates = [0.1, 0.08, 0.06, 0.04, 0.02, 0] as const;
const phaseEightDeferredBodyAdvanceDistanceCandidates = [0] as const;
// Floating-point comparison tolerance only; planned and live body motion both
// remain bound to the anatomical maximum reach.
const phaseEightRuntimeReachTolerance = 1 + 1e-6;
// Sample the prospective partial-to-full load envelope during body search.
// The actual ramp is independently revalidated after a fresh rig/IK pass.
const phaseEightLoadTransitionSupportSampleCount = 9;
// Failed reach-recovery candidates are excluded in continuous material space.
// This is one eighth of the narrowest semantic seed neighborhood (0.08), so
// numerical rediscovery cannot consume a bounded retry while genuine nearby
// foothold alternatives remain available.
const phaseEightRecoveryFootholdExclusionMaterialRadius = 0.01;

const solver = new WebPhysicsSolver(network, {
  gravityY: labConfig.gravity,
  iterations: labConfig.solverIterations,
  maximumStrain: 0.035,
});
const webRenderer = new WebRenderer(scene, camera, canvas, labelLayer, labConfig);
const spiderDebugRenderer = new SpiderDebugRenderer(
  scene,
  camera,
  canvas,
  labelLayer,
  spiderConfig,
);
const locomotionDebugRenderer = new LocomotionDebugRenderer(
  scene,
  camera,
  canvas,
  labelLayer,
  locomotionConfig,
);
const junctionDebugToggles = createJunctionTraversalDebugToggles();
const junctionDebugRenderer = new JunctionTraversalDebugRenderer(
  scene,
  labelLayer,
  junctionDebugToggles,
);
junctionDebugRenderer.setTraversal(traversal);
const interaction = new InteractionController(canvas, camera, labConfig);

let rig: SpiderRig | null = null;
let bodyPose: SpiderBodyPose | null = null;
let ikSolver: SpiderIKSolver | null = null;
let jointFeasibilityProbe: JointLimitFeasibilityProbe | null = null;
let loadDistributor: SpiderLoadDistributor | null = null;
let stepController: SpiderStepController | null = null;
let coupledTransfer: CoupledTransferTransaction | null = null;
let traversalCoordinator: JunctionTraversalCoordinator | null = null;
let fullTraversalRoute: PlannedRoute | null = null;
let latestJunctionEstimate: JunctionProgressEstimate | null = null;
let latestDestinationBranchFrame: DestinationBranchFrameEstimate =
  createDestinationBranchFrameEstimate();
let latestCandidateSeeds: FootholdCandidateSeed[] = [];
let activeTransitionNonCoplanar = false;
const transitionStrategyController = new TransitionStrategyController(
  "ordinary-traverse",
);
let latestTransitionStrategyDirective: TransitionStrategyDirective =
  transitionStrategyController.directive();
let latestHistoryInfluences: readonly LegHistoryScoreInfluence[] = [];
let latestRecoveryCandidates: readonly LocalRecoveryCandidate[] = [];
let latestExplorationCandidates: readonly JunctionDebugCandidate[] = [];
let latestRecoveryDestination: RouteDestination | null = null;
let localRecoverySearchCount = 0;
let recoverySearchTriggered = false;
const recoveryExcludedLegIds = new Set<SpiderLegId>();
const recoveryExcludedFootholds: RecoveryFootholdExclusion<SpiderLegId>[] = [];
const liftableNextLegIds = new Set<SpiderLegId>();
let activeTraversalBranch: PhaseEightBranchId | null = null;
let phase8FaultMode: "none" | "missing-contact" | "repeated-failure" = "none";
let faultInjectionActive = false;
let cancellationInjected = false;
let phase8MinimumReachScale = 1;
let latestBodyOrientationPlan: BodyOrientationPlan = createBodyOrientationPlan();
const traversalBodyFrame = {
  position: new THREE.Vector3(),
  forward: new THREE.Vector3(-1, 0, 0),
  up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(0, 0, -1),
};
let traversalBodyFrameActive = false;
const orientationStartQuaternion = new THREE.Quaternion();
const orientationTargetQuaternion = new THREE.Quaternion();
const orientationCurrentQuaternion = new THREE.Quaternion();
let orientationEaseElapsedSeconds = 0;
let orientationEaseActive = false;
let orientationEaseStepIndex = -1;
const bodyCommitOffset = new THREE.Vector3();
const supportMembershipRebaseOffset = new THREE.Vector3();
const supportPlacementBeforeUpdate = new THREE.Vector3();
const supportPlacementAfterUpdate = new THREE.Vector3();
let supportMembershipMask = 0;
let supportMembershipInitialized = false;
const bodyCommitStartOffset = new THREE.Vector3();
const bodyCommitTargetOffset = new THREE.Vector3();
const bodyCommitStartWorldPosition = new THREE.Vector3();
const bodyCommitTargetWorldPosition = new THREE.Vector3();
const bodyCommitLiveWorldPosition = new THREE.Vector3();
const bodyCommitStartQuaternion = new THREE.Quaternion();
const bodyCommitTargetQuaternion = new THREE.Quaternion();
let bodyCommitElapsedSeconds = 0;
let bodyCommitActive = false;
let bodyCommitSnapshotRetained = false;
let bodyCommitAwaitingIkVersion: number | null = null;
let bodyCommitRestorationAwaitingIkVersion: number | null = null;
let coupledFullLoadAwaitingIkVersion: number | null = null;
let bodyCommitLastSupportMargin = Number.NEGATIVE_INFINITY;
let bodyCommitLastSupportBroadness = Number.NEGATIVE_INFINITY;
let bodyCommitLastWorstReach = Number.POSITIVE_INFINITY;
let bodyCommitHardSupportReached = false;
let coupledMotionStartProgress = 0;
const coupledBodyMotionDiagnostics: CoupledBodyMotionDiagnostics =
  createCoupledBodyMotionDiagnostics();
const contacts = new Map<SpiderLegId, SpiderFootContact>();
const ikResults = new Map<SpiderLegId, SpiderIKSolveResult>();
const ikDebugResults = new Map<SpiderLegId, SpiderDebugIkResult>();
const footOrientationPolicies = new Map<SpiderLegId, FootOrientationPolicy>();
const footOrientationResults = new Map<SpiderLegId, FootOrientationResult>();
const invalidContactFrameStreak: Record<SpiderLegId, number> = Object.fromEntries(
  SPIDER_LEG_IDS.map((legId) => [legId, 0]),
) as Record<SpiderLegId, number>;
let orientationMovingLeg: SpiderLegId | null = null;
let ikSolveVersion = 0;
const originalMovingFootWorldQuaternion = new THREE.Quaternion();
let hasOriginalMovingFootOrientation = false;

const bodySupportWeights: Readonly<Record<SpiderLegId, number>> = {
  L1: 0.4,
  L2: 0.7,
  L3: 1,
  L4: 1.8,
  R1: 0.4,
  R2: 0.7,
  R3: 1,
  R4: 1.8,
};
const supportSamples: Array<{
  worldPosition: THREE.Vector3;
  referenceUp: THREE.Vector3;
  weight: number;
  valid: boolean;
}> = SPIDER_LEG_IDS.map((legId) => ({
  worldPosition: new THREE.Vector3(),
  referenceUp: new THREE.Vector3(0, 1, 0),
  weight: bodySupportWeights[legId],
  valid: false,
}));
const previousSupportLoadFactors: Record<SpiderLegId, number> = Object.fromEntries(
  SPIDER_LEG_IDS.map((legId) => [legId, 0]),
) as Record<SpiderLegId, number>;
const supportForward = new THREE.Vector3(-1, 0, 0);
const supportUp = new THREE.Vector3(0, 1, 0);
const debugSnapshot: SpiderDebugSnapshot = {
  contacts,
  ikResults: ikDebugResults,
  supportCenter: new THREE.Vector3(),
  bodyForward: new THREE.Vector3(-1, 0, 0),
  bodyUp: new THREE.Vector3(0, 1, 0),
  rigScale: 1,
};
const locomotionDebugSnapshot = createEmptyLocomotionDebugSnapshot() as MutableLocomotionSnapshot;
const legHistorySnapshots: LegHistorySnapshot[] = [];
const legSelectionScoreAdjustments: Partial<Record<SpiderLegId, number>> = {};
let junctionDebugSnapshot: JunctionTraversalDebugSnapshot = {
  fullRoute: null,
  currentRoute: null,
  nextTransition: null,
  junctionPosition: null,
  destinationBranchStrandId: null,
  stepNumber: 0,
  state: "idle",
  movedLegHistory: [],
  contacts: [],
  destinationSideCount: 0,
  destinationSideRequired: traversalPolicyConfig.junction.destinationSideSupportThreshold,
  mayCommitBody: false,
  proposedBodyFrame: null,
  acceptedBodyFrame: null,
  predictedReaches: [],
  explorationCandidates: [],
  recoveryCandidates: [],
  bodyPosition: null,
  bodyCenterProgress: 0,
  stopReason: "none",
  stopMessage: "",
};

const scratchFootHome = new THREE.Vector3();
const scratchReachOrigin = new THREE.Vector3();
const scratchScale = new THREE.Vector3(1, 1, 1);
const orientationRouteDirection = new THREE.Vector3(-1, 0, 0);
const scratchTip = new THREE.Vector3();
const scratchWorldQuaternion = new THREE.Quaternion();
const scratchParentQuaternion = new THREE.Quaternion();
const initialBodyPosition = new THREE.Vector3();
let currentRigScale = 1;

interface MutableLocomotionSnapshot extends LocomotionDebugSnapshot {
  destination: LocomotionDebugSnapshot["destination"];
  travelOrigin: LocomotionDebugSnapshot["travelOrigin"];
  travelDirection: LocomotionDebugSnapshot["travelDirection"];
  candidates: LocomotionDebugSnapshot["candidates"];
  winner: LocomotionDebugSnapshot["winner"];
  legs: LocomotionDebugSnapshot["legs"];
  state: LocomotionDebugSnapshot["state"];
  stateElapsedSeconds: number;
  failureReason: LocomotionDebugSnapshot["failureReason"];
  failureMessage: string;
  movingFoot: LocomotionDebugSnapshot["movingFoot"];
  swingCurve: LocomotionDebugSnapshot["swingCurve"];
  supports: LocomotionDebugSnapshot["supports"];
  supportCenter: LocomotionDebugSnapshot["supportCenter"];
  supportPolygon: LocomotionDebugSnapshot["supportPolygon"];
  probe: LocomotionDebugSnapshot["probe"];
  loadTransfer: LocomotionDebugSnapshot["loadTransfer"];
  bodyAdvance: LocomotionDebugSnapshot["bodyAdvance"];
}

const runtimeLegs: SpiderStepRuntimeLeg[] = SPIDER_LEG_IDS.map((legId) => ({
  legId,
  footHomeWorldPosition: new THREE.Vector3(),
  reachOriginWorldPosition: new THREE.Vector3(),
  contactWorldPosition: new THREE.Vector3(),
  address: null,
  reach: { min: 0, comfortable: 0, max: 1 },
  reachScale: 1,
  planted: false,
  loaded: false,
  loadFactor: 0,
  valid: false,
  currentReachRatio: Infinity,
  ikFinite: false,
  ikReached: false,
  ikResidual: Infinity,
}));
const runtimeContext: SpiderStepRuntimeContext = {
  bodyWorldPosition: new THREE.Vector3(),
  supportFrame: {
    center: new THREE.Vector3(),
    forward: new THREE.Vector3(-1, 0, 0),
    up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(0, 0, -1),
  },
  legs: runtimeLegs,
  get candidateSeeds() {
    return traversalCoordinator?.isActive ? latestCandidateSeeds : undefined;
  },
  get candidateObjective() {
    return transitionCandidateObjectiveIsActive()
      ? phaseEightCandidateObjective
      : undefined;
  },
  get allowGenericCandidateFallback() {
    return transitionCandidateObjectiveAllowsGenericFallback();
  },
  legSelectionScoreAdjustments,
  routeStrandIds: mainRouteStrandIds,
  get bodyAdvanceDistanceCandidates() {
    return traversalCoordinator?.isActive
      ? coupledTransfer
        ? phaseEightDeferredBodyAdvanceDistanceCandidates
        : phaseEightBodyAdvanceDistanceCandidates
      : undefined;
  },
  candidateValidator: (leg, address) => validatePhaseEightCandidate(leg.legId, address),
  ikSolveVersion: 0,
  jointFeasibility: (leg, _address, worldPosition) =>
    jointFeasibilityProbe?.test(leg.legId, worldPosition) ?? {
      feasible: false,
      violation: 1,
      reason: "joint-limit feasibility probe unavailable",
    },
};

function syncParameters(): void {
  solver.settings.gravityY = labConfig.gravity;
  solver.settings.iterations = labConfig.solverIterations;
  for (const strand of network.strandList) {
    const weakScale = fixture.weakSupport.strandIds.includes(strand.id)
      ? fixture.weakSupport.stiffnessScale
      : 1;
    strand.stiffness = labConfig.stiffness * weakScale;
    strand.damping = labConfig.damping;
  }
  network.syncParticleDamping();
  loadDistributor
    ?.setTotalWeight(spiderConfig.totalWeight)
    .setMode(spiderConfig.loadMode);
  tensionLegend.hidden = !labConfig.showTension;
  Object.assign(legMovementHistory.config, traversalPolicyConfig.history);
  Object.assign(junctionProgressEstimator.config, traversalPolicyConfig.junction);
  Object.assign(bodyOrientationPlanner.config, traversalPolicyConfig.orientation);
  Object.assign(bodyOrientationPlanner.envelope, {
    forwardRadius: traversalPolicyConfig.orientation.bodyEnvelopeRadiusForward,
    rightRadius: traversalPolicyConfig.orientation.bodyEnvelopeRadiusRight,
    upRadius: traversalPolicyConfig.orientation.bodyEnvelopeRadiusUp,
  });
  Object.assign(localRecoveryPlanner.config, traversalPolicyConfig.recovery);
  if (traversalCoordinator) {
    Object.assign(traversalCoordinator.config, {
      maximumStepCount: traversalPolicyConfig.scheduler.maximumStepCount,
      settleDurationSeconds: traversalPolicyConfig.scheduler.settleDurationSeconds,
      maximumConsecutiveFailures:
        traversalPolicyConfig.scheduler.maximumConsecutivePlanningFailures,
      maximumRecoveryAttempts: traversalPolicyConfig.recovery.maximumAttempts,
      minimumDestinationSideSupports:
        traversalPolicyConfig.junction.destinationSideSupportThreshold,
      minimumDestinationSideSpread:
        traversalPolicyConfig.junction.minimumDestinationSideWorldSpread,
      maximumCriticalTrailingReachRatio: traversalPolicyConfig.junction.trailingReachLimit,
    });
  }
}

function settleCurrentNetwork(): void {
  syncParameters();
  loadDistributor?.releaseAllLoads();
  for (let step = 0; step < 720; step += 1) {
    solver.step(FIXED_TIME_STEP);
  }
  solver.stopMotion();
}

function resetBodyControls(upsideDown = false): void {
  spiderConfig.bodyOffsetX = 0;
  spiderConfig.bodyOffsetY = 0;
  // Center the inverted one-step fixture between the asymmetric main and
  // companion rails; the normal Phase 8 traversal keeps the neutral offset.
  spiderConfig.bodyOffsetZ = upsideDown ? 0.06 : 0;
  spiderConfig.bodyPitchDegrees = 0;
  spiderConfig.bodyYawDegrees = 0;
  spiderConfig.bodyRollDegrees = upsideDown ? 180 : 0;
  // The compact Phase 8 Y has a slightly deeper right-hand support than the
  // original Phase 7 rail. Keep the inverted body below the silk while
  // avoiding a fixture-only initial R1 overreach.
  spiderConfig.thoraxHeight = upsideDown ? -0.08 : 0.2;
}

function plantInitialContacts(): void {
  if (!rig) return;
  loadDistributor?.resetFootLoadFactors();
  for (const legId of SPIDER_LEG_IDS) {
    contacts.get(legId)?.reset().plant(fixture.initialContacts[legId]);
    footOrientationPolicies.get(legId)?.reset();
  }
  orientationMovingLeg = null;
}

function resetStablePose(upsideDown = false): void {
  resetBodyControls(upsideDown);
  ikSolver?.resetAll();
  stepController?.reset();
  bodyPose?.resetSupportFrame();
  traversalCoordinator = null;
  fullTraversalRoute = null;
  latestJunctionEstimate = null;
  destinationBranchFrameEstimator.reset();
  latestDestinationBranchFrame = createDestinationBranchFrameEstimate();
  latestCandidateSeeds = [];
  activeTransitionNonCoplanar = false;
  transitionStrategyController.reset("ordinary-traverse");
  latestTransitionStrategyDirective = transitionStrategyController.directive();
  latestHistoryInfluences = [];
  latestRecoveryCandidates = [];
  latestExplorationCandidates = [];
  latestRecoveryDestination = null;
  localRecoverySearchCount = 0;
  recoverySearchTriggered = false;
  recoveryExcludedLegIds.clear();
  recoveryExcludedFootholds.length = 0;
  liftableNextLegIds.clear();
  activeTraversalBranch = null;
  phase8FaultMode = "none";
  faultInjectionActive = false;
  cancellationInjected = false;
  phase8MinimumReachScale = 1;
  latestBodyOrientationPlan = createBodyOrientationPlan();
  traversalBodyFrameActive = false;
  orientationEaseElapsedSeconds = 0;
  orientationEaseActive = false;
  orientationEaseStepIndex = -1;
  bodyCommitOffset.set(0, 0, 0);
  bodyCommitStartOffset.set(0, 0, 0);
  bodyCommitTargetOffset.set(0, 0, 0);
  bodyCommitStartWorldPosition.set(0, 0, 0);
  bodyCommitTargetWorldPosition.set(0, 0, 0);
  bodyCommitLiveWorldPosition.set(0, 0, 0);
  bodyCommitElapsedSeconds = 0;
  bodyCommitActive = false;
  bodyCommitSnapshotRetained = false;
  bodyCommitAwaitingIkVersion = null;
  bodyCommitRestorationAwaitingIkVersion = null;
  bodyCommitLastSupportMargin = Number.NEGATIVE_INFINITY;
  bodyCommitLastSupportBroadness = Number.NEGATIVE_INFINITY;
  bodyCommitLastWorstReach = Number.POSITIVE_INFINITY;
  bodyCommitHardSupportReached = false;
  coupledMotionStartProgress = 0;
  resetCoupledBodyMotionDiagnostics();
  supportMembershipRebaseOffset.set(0, 0, 0);
  supportMembershipMask = 0;
  supportMembershipInitialized = false;
  for (const legId of SPIDER_LEG_IDS) previousSupportLoadFactors[legId] = 0;
  legMovementHistory.reset();
  for (const legId of SPIDER_LEG_IDS) invalidContactFrameStreak[legId] = 0;
  for (const legId of SPIDER_LEG_IDS) legSelectionScoreAdjustments[legId] = 0;
  plantInitialContacts();
  updateSpiderRig();
  if (bodyPose) initialBodyPosition.copy(bodyPose.result.anchorWorldPosition);
  createTraversalCoordinator();
  panel.refreshControls();
  phase8Panel?.refreshControls();
}

function createStepController(): void {
  if (!loadDistributor) return;
  stepController = new SpiderStepController({
    network,
    traversal,
    contacts,
    loadDistributor,
    config: locomotionConfig,
    getRuntimeContext,
  });
  createTraversalCoordinator();
}

function rebuildFixture(): void {
  interaction.clearSelection();
  stepController?.cancel();
  loadDistributor?.releaseAllLoads();
  fixture = createPhaseEightFixture(labConfig);
  network = fixture.network;
  traversal = createWebNetworkTraversal(network, FIXED_TIME_STEP);
  routePlanner = new WebRoutePlanner(traversal);
  mainRouteStrandIds.clear();
  mainRouteStrandIds.add(fixture.strandIds.approachMain);
  mainRouteStrandIds.add(fixture.strandIds.forwardMain);
  mainRouteStrandIds.add(fixture.strandIds.angledMain);
  legMovementHistory = new LegMovementHistory(traversalPolicyConfig.history);
  junctionProgressEstimator = new JunctionProgressEstimator(
    traversal,
    traversalPolicyConfig.junction,
  );
  bodyOrientationPlanner = new BodyOrientationPlanner(
    traversal,
    traversalPolicyConfig.orientation,
  );
  destinationBranchFrameEstimator = new DestinationBranchFrameEstimator(traversal, {
    defaultLookaheadMaterialDistance: 0.16,
    tangentSampleMaterialDistance: 0.035,
  });
  localRecoveryPlanner = new LocalRecoveryPlanner(
    traversal,
    traversalPolicyConfig.recovery,
  );
  solver.setNetwork(network);
  loadDistributor?.setNetwork(network);
  loadDistributor?.resetFootLoadFactors();
  webRenderer.setNetwork(network);
  junctionDebugRenderer.setTraversal(traversal);
  interaction.setNetwork(network);
  settleCurrentNetwork();
  createStepController();
  selectedScenario = "forward";
  selectedTraversalScenario = "A";
  panel.setSelectedScenario(selectedScenario);
  phase8Panel?.setSelectedScenario(selectedTraversalScenario);
  resetStablePose(false);
  accumulator = 0;
}

function scenarioDestination(scenario: LocomotionValidationScenario): RouteDestination {
  switch (scenario) {
    case "forward":
      return fixture.scenarioDestinations.forward;
    case "alternate":
      return fixture.scenarioDestinations.angled;
    case "upsideDown":
      // Keep the inverted-frame regression on the explicit forward route; the
      // Phase 8 angled branch adds underside geometry beyond this one-step test.
      return fixture.scenarioDestinations.forward;
    case "unstableRejection":
      return fixture.scenarioDestinations.missingExpectedContact;
    case "noValid":
      // The high one-step progress requirement, not route resolution, must be
      // the reason this regression has no eligible foothold.
      return fixture.scenarioDestinations.forward;
  }
}

function prepareScenario(scenario: LocomotionValidationScenario): boolean {
  if (!stepController || !rig || !bodyPose) return false;
  if (traversalCoordinator?.isActive) return false;
  if (stepController.isExecuting) return false;
  selectedScenario = scenario;
  phase8MinimumReachScale = 1;
  Object.assign(locomotionConfig, standardLocomotionTiming);
  locomotionConfig.candidateSearchRadius = standardCandidateSearchRadius;
  locomotionConfig.candidateSamplingDensity = standardCandidateSamplingDensity;
  locomotionConfig.minimumFootSpacing = standardMinimumFootSpacing;
  Object.assign(locomotionConfig.scoreWeights, standardFootholdScoreWeights);
  // Scenario E keeps the destination semantically route-resolvable but raises
  // the one-step progress contract above every reachable local sample. This
  // exercises candidate generation and a genuine no-eligible-foothold result
  // instead of failing early during world-query snapping.
  locomotionConfig.minimumProgressImprovement =
    scenario === "noValid" ? 1.25 : standardMinimumProgressImprovement;
  panel.setSelectedScenario(scenario);
  resetBodyControls(scenario === "upsideDown");
  updateSpiderRig();
  return true;
}

function issueScenario(
  scenario: LocomotionValidationScenario,
  mode: "plan-only" | "execute" = "execute",
): boolean {
  if (!prepareScenario(scenario) || !stepController) return false;
  return stepController.requestDestination(scenarioDestination(scenario), mode);
}

function issueTraversalScenario(
  scenarioId: PhaseEightValidationScenarioId,
  runMode: "pause-after-step" | "run-until-arrival" = "run-until-arrival",
): boolean {
  if (!rig || !bodyPose || !stepController) return false;
  if (traversalCoordinator?.isActive) return false;

  rebuildFixture();
  const scenario = fixture.validationScenarios[scenarioId];
  selectedTraversalScenario = scenarioId;
  phase8Panel.setSelectedScenario(scenarioId);
  fullTraversalRoute = routePlanner.plan(
    { strandId: fixture.strandIds.approachMain, t: 0 },
    scenario.destination,
  );
  activeTraversalBranch = fullTraversalRoute
    ? (Object.values(fixture.branches).find((branch) =>
        fullTraversalRoute?.strandIds.includes(branch.routeStrandId)
      )?.id ?? null)
    : null;
  const strategyBranch = activeTraversalBranch
    ? fixture.branches[activeTraversalBranch]
    : null;
  const selectedStrategy = selectTransitionStrategy({
    hasJunction: Boolean(strategyBranch),
    transitionPlaneTurnRadians:
      strategyBranch?.transitionPlaneTurnRadians ?? 0,
  });
  transitionStrategyController.reset(selectedStrategy);
  latestTransitionStrategyDirective = transitionStrategyController.directive();
  phase8FaultMode = scenarioId === "D"
    ? "missing-contact"
    : scenarioId === "E"
      ? "repeated-failure"
      : "none";
  faultInjectionActive = false;
  cancellationInjected = false;
  phase8MinimumReachScale = 0.8;
  recoverySearchTriggered = false;
  latestRecoveryDestination = null;
  latestRecoveryCandidates = [];
  latestExplorationCandidates = [];
  locomotionConfig.minimumProgressImprovement = phaseEightMinimumProgressImprovement;
  locomotionConfig.candidateSearchRadius = 0.95;
  locomotionConfig.candidateSamplingDensity = 15;
  locomotionConfig.minimumFootSpacing = standardMinimumFootSpacing;
  Object.assign(locomotionConfig, phaseEightLocomotionTiming);
  locomotionConfig.bodyAdvanceDistance = phaseEightBodyAdvanceDistance;
  locomotionConfig.maximumRemainingReachRatio = 0.93;

  activeTransitionNonCoplanar = strategyBranch?.nonCoplanarTransition ?? false;
  if (strategyBranch) {
    const branch = strategyBranch;
    Object.assign(traversalPolicyConfig.junction, {
      destinationSideSupportThreshold: branch.minimumDestinationSideContacts,
      minimumDestinationSideWorldSpread: branch.minimumContactSpread,
      trailingReachLimit: branch.maximumTrailingReachRatio,
      bodyCrossingDistance: branch.bodyCrossingDistance,
      clearBodyDistance: branch.bodyCrossingDistance + 0.24,
    });
    Object.assign(traversalPolicyConfig.orientation, {
      maximumReachSafetyFactor: 0.96,
    });
  }
  syncParameters();

  createTraversalCoordinator();
  return traversalCoordinator?.start(scenario.destination, runMode) ?? false;
}

function createTraversalCoordinator(): void {
  if (!stepController) {
    coupledTransfer = null;
    traversalCoordinator = null;
    return;
  }
  coupledTransfer = new CoupledTransferTransaction({
    atomicStep: stepController,
    config: {
      partialLoadFactor: 0.35,
      maximumPartialLoadWaitSeconds: 1.2,
      maximumBodyMotionDurationSeconds: 1.25,
    },
    readFootLoadFactor: (legId) => loadDistributor?.getFootLoadFactor(legId),
    readWorstReachRatio: maximumPlantedReachRatio,
    readFootRestoration: (legId, originalAddress) => {
      const foot = contacts.get(legId);
      const address = foot?.address;
      const loadFactor = loadDistributor?.getFootLoadFactor(legId) ?? 0;
      const restored = Boolean(
        foot?.isPlanted &&
        foot.contactValid &&
        address?.strandId === originalAddress.strandId &&
        Math.abs((address?.t ?? Number.POSITIVE_INFINITY) - originalAddress.t) <= 1e-6 &&
        loadFactor >= 1 - 1e-6,
      );
      if (restored) return { complete: true, succeeded: true };
      const failureMessage = stepController?.diagnostics.failureMessage ?? "";
      if (failureMessage.includes("Could not restore")) {
        return {
          complete: true,
          succeeded: false,
          message: failureMessage,
        };
      }
      return { complete: false, succeeded: false };
    },
    bodyMotion: {
      diagnostics: coupledBodyMotionDiagnostics,
      get restorationPending() {
        return bodyCommitRestorationPending();
      },
      begin: beginCoupledBodyMotion,
      update: updateCoupledBodyMotion,
      validateStablePose: validateCoupledStablePose,
      cancelAndRestore: restoreBodyCommit,
      commitStablePose: commitCoupledBodyMotion,
      reset: resetCoupledBodyMotionDiagnostics,
    },
  });
  traversalCoordinator = new JunctionTraversalCoordinator({
    atomicStep: coupledTransfer,
    config: {
      minimumUsefulBodyProgress: 0.001,
      // One secure eight-leg support rebalance may legitimately require a
      // complete foot cycle before the thorax can advance. Keep this ordinary
      // no-progress guard finite without pre-empting that cycle; active
      // roll-under stages use their separate, tighter strategy bound.
      maximumZeroProgressTransactions: SPIDER_LEG_IDS.length,
    },
    policyConfig: traversalPolicyConfig,
    resolveRoute: (request) => resolveTraversalRoute(request),
    readProgress: (route, destination) => readTraversalProgress(route, destination),
    readSafety: readTraversalSafety,
    isRouteStillValid: (route) => routeIsStillValid(route),
    prepareAtomicPlan: prepareRepeatedAtomicPlan,
    recordCompletedAtomicStep: recordRepeatedAtomicStep,
    attemptRecovery: attemptTraversalRecovery,
    junctionTest: {
      begin: beginJunctionTest,
      cancel: () => {
        latestExplorationCandidates = [];
      },
    },
    readStrategyDirective: () => latestTransitionStrategyDirective,
    restoreLastStablePose: () => coupledTransfer?.cancelAndRestore() ?? restoreBodyCommit(),
  });
}

function resolveTraversalRoute(
  request: Parameters<NonNullable<ConstructorParameters<typeof JunctionTraversalCoordinator>[0]["resolveRoute"]>>[0],
) {
  const runtime = getRuntimeContext();
  const origin = traversal.findClosestPoint(runtime.bodyWorldPosition, {
    traversableOnly: true,
    strandIds: mainRouteStrandIds,
    maximumDistance: 1.5,
  });
  if (!origin) {
    return { ok: false, route: null, reason: "No route-bearing main strand is near the body." };
  }
  const route = routePlanner.plan(origin.address, request.destination);
  if (!route) {
    return {
      ok: false,
      route: null,
      reason: "No explicit connected route reaches the requested destination; projection crossings add no topology.",
    };
  }
  return {
    ok: true,
    route,
    stepDestination: request.recoveryStepDestination ?? request.destination,
    topologyRevision: topologyRevision(),
  };
}

function readTraversalProgress(
  currentRoute: PlannedRoute,
  _destination: RouteDestination,
): JunctionTraversalProgressSnapshot {
  const branchId = activeTraversalBranch;
  const branch = branchId ? fixture.branches[branchId] : null;
  const semanticRoute = fullTraversalRoute ?? currentRoute;
  if (!branch || !semanticRoute || !bodyPose) {
    return {
      currentRouteStrandId: currentRoute.strandIds[0] ?? null,
      currentJunctionNodeId: null,
      nextRouteTransition: null,
      selectedDestinationBranchStrandId: null,
      junctionEncountered: false,
      bodyCenterBeyondJunction: false,
      destinationSideLoadedContactCount: 0,
      destinationSideSpread: 0,
      trailingContactCount: 0,
      criticalTrailingReachRatio: 0,
      maximumReachRatio: 0,
      canCommitBody: false,
      needsExploratoryTest: false,
      routeComplete: false,
      bodyNearDestination: false,
      stableSupportNearDestination: false,
      destinationReached: false,
      bodyCenterDistancePastJunction: 0,
      removableSupportCount: 0,
      worstRemovalBodyMargin: 0,
      bodyCenterProgress: 0,
      semanticRouteProgress: 0,
      nonCoplanarTransition: false,
      posturePhase: "approach",
      branchFrameAngularError: 0,
      branchFrameForwardError: 0,
      branchFramePitchError: 0,
      branchFrameRollError: 0,
      destinationPlaneSupportCount: 0,
      circumferentialCoverage: 0,
      circumferentialContacts: [],
      contactStateFingerprint: "unavailable",
    };
  }

  const runtime = getRuntimeContext();
  const currentAddress = traversal.findClosestPoint(runtime.bodyWorldPosition, {
    traversableOnly: true,
    strandIds: mainRouteStrandIds,
  })?.address;
  const request = {
    route: semanticRoute,
    junctionNodeId: fixture.junction.nodeId,
    approachStrandId: fixture.junction.approachStrandId,
    destinationBranchStrandId: branch.routeStrandId,
    approachSupportStrandIds: new Set(fixture.strandIds.approachRegion),
    destinationSupportStrandIds: new Set(branch.supportStrandIds),
    bodyCenter: runtime.bodyWorldPosition,
    contacts: runtime.legs.map((leg) => ({
      legId: leg.legId,
      planted: leg.planted,
      loaded: leg.loaded,
      valid: leg.valid,
      address: leg.address,
      contactPosition: leg.contactWorldPosition,
      currentReachRatio: leg.currentReachRatio,
    })),
    currentAddress,
    predictedOrientationReachSafe:
      !latestBodyOrientationPlan.success ||
      latestBodyOrientationPlan.maximumPredictedReachRatio <=
        traversalPolicyConfig.orientation.maximumReachSafetyFactor,
    supportStable:
      runtime.legs.filter((leg) => leg.planted && leg.loaded && leg.valid).length >=
      traversalPolicyConfig.junction.stableLoadedSupportThreshold,
  };
  if (
    !latestJunctionEstimate ||
    latestJunctionEstimate.destinationBranchStrandId !== branch.routeStrandId
  ) {
    latestJunctionEstimate = createJunctionProgressEstimate(request);
  }
  latestJunctionEstimate = junctionProgressEstimator.estimate(
    request,
    latestJunctionEstimate,
  );

  const destinationPosition = new THREE.Vector3();
  traversal.getWorldPosition(branch.destinationAddress, destinationPosition);
  const bodyDistance = destinationPosition.distanceTo(
    runtime.bodyWorldPosition as THREE.Vector3,
  );
  const closestOnBranch = traversal.findClosestPoint(runtime.bodyWorldPosition, {
    traversableOnly: true,
    strandIds: new Set([branch.routeStrandId]),
  });
  latestDestinationBranchFrame = destinationBranchFrameEstimator.estimate({
    route: semanticRoute,
    junctionNodeId: fixture.junction.nodeId,
    destinationBranchStrandId: branch.routeStrandId,
    companionSupportStrandIds: branch.supportStrandIds,
    currentBodyFrame: {
      position: runtime.bodyWorldPosition,
      forward: bodyPose.result.bodyForward,
      up: bodyPose.result.bodyUp,
    },
    sampleAddress: closestOnBranch?.address,
  }, latestDestinationBranchFrame);
  const branchStrand = traversal.getStrand(branch.routeStrandId);
  const remainingMaterialDistance = closestOnBranch && branchStrand
    ? Math.abs(closestOnBranch.address.t - branch.destinationAddress.t) *
      branchStrand.totalRestLength
    : Infinity;
  const farDestinationSupports = latestJunctionEstimate.contacts.filter((contact) =>
    contact.side === "destination" &&
    contact.loadedAndValid &&
    contact.distancePastJunction >= branch.bodyCrossingDistance + 0.12).length;
  const stableLoaded = latestJunctionEstimate.stableLoadedSupportCount >=
    traversalPolicyConfig.junction.stableLoadedSupportThreshold;
  const routeComplete =
    remainingMaterialDistance <=
    branch.destinationRadius + traversalPolicyConfig.scheduler.arrivalMaterialTolerance;
  const destinationDeltaX = destinationPosition.x - runtime.bodyWorldPosition.x;
  const destinationDeltaY = destinationPosition.y - runtime.bodyWorldPosition.y;
  const destinationDeltaZ = destinationPosition.z - runtime.bodyWorldPosition.z;
  const destinationFrameForwardSeparation = latestDestinationBranchFrame.valid
    ? destinationDeltaX * latestDestinationBranchFrame.frame.forward.x +
      destinationDeltaY * latestDestinationBranchFrame.frame.forward.y +
      destinationDeltaZ * latestDestinationBranchFrame.frame.forward.z
    : Infinity;
  const bodyNearDestination = bodyNearDestinationInSemanticBranchFrame({
    worldDistance: bodyDistance,
    signedForwardSeparation: destinationFrameForwardSeparation,
    destinationRadius: branch.destinationRadius,
    arrivalWorldTolerance: traversalPolicyConfig.scheduler.arrivalWorldTolerance,
    nonCoplanarTransition: activeTransitionNonCoplanar,
    routeComplete,
    frameValid: latestDestinationBranchFrame.valid,
    frameSignContinuous: latestDestinationBranchFrame.frameSignContinuous,
  });
  const stableSupportNearDestination =
    stableLoaded &&
    latestJunctionEstimate.destinationSideLoadedCount >= branch.minimumDestinationSideContacts &&
    farDestinationSupports >= 2;
  const arrival = {
    routeComplete,
    bodyNearDestination,
    stableSupportNearDestination,
    destinationReached:
      routeComplete &&
      bodyNearDestination &&
      stableSupportNearDestination &&
      latestJunctionEstimate.junctionCleared,
  };
  const snapshot = createCoordinatorProgressSnapshot(latestJunctionEstimate, arrival);
  const removalEstimates = runtime.legs
    .filter((leg) => leg.planted && leg.loaded && leg.valid)
    .map((leg) => evaluateCoupledSupport(
      runtime.bodyWorldPosition,
      false,
      undefined,
      leg.legId,
    ));
  const removableSupportCount = removalEstimates.filter(
    (estimate) => estimate.classification === "hard-valid",
  ).length;
  const worstRemovalBodyMargin = removalEstimates.reduce(
    (minimum, estimate) => Math.min(
      minimum,
      Number.isFinite(estimate.bodyEdgeMargin)
        ? Math.max(-1, estimate.bodyEdgeMargin)
        : -1,
    ),
    1,
  );
  const liveDirection = getLiveBranchDirection(branch.id, scratchScale);
  const trailingSupportCount = runtime.legs.filter((leg) => {
    if (!leg.planted || !leg.loaded || !leg.valid) return false;
    const routeOffset =
      (leg.contactWorldPosition.x - runtime.bodyWorldPosition.x) * liveDirection.x +
      (leg.contactWorldPosition.y - runtime.bodyWorldPosition.y) * liveDirection.y +
      (leg.contactWorldPosition.z - runtime.bodyWorldPosition.z) * liveDirection.z;
    return routeOffset < -traversalPolicyConfig.history.leadingTrailingDeadZone;
  }).length;
  const liveJunction = new THREE.Vector3();
  traversal.getNodePosition(fixture.junction.nodeId, liveJunction);
  const distancePast = new THREE.Vector3(
    runtime.bodyWorldPosition.x - liveJunction.x,
    runtime.bodyWorldPosition.y - liveJunction.y,
    runtime.bodyWorldPosition.z - liveJunction.z,
  ).dot(liveDirection);
  const destinationDistance = Math.max(
    branch.bodyCrossingDistance + 0.01,
    destinationPosition.clone().sub(liveJunction).dot(liveDirection),
  );
  const routeStrand = traversal.getStrand(branch.routeStrandId);
  const junctionT = routeStrand?.startNode.id === fixture.junction.nodeId ? 0 : 1;
  const routeDenominator = branch.destinationAddress.t - junctionT;
  const semanticRouteProgress = closestOnBranch && Math.abs(routeDenominator) > 1e-8
    ? (closestOnBranch.address.t - junctionT) / routeDenominator
    : 0;
  const circumferentialContacts = classifyCircumferentialContacts(
    runtime,
    latestJunctionEstimate,
  );
  const circumferentialCoverage = measureCircumferentialCoverage(
    circumferentialContacts,
  );
  const destinationPlaneSupportCount = circumferentialContacts.filter(
    (contact) => contact.region === "destination-plane" && contact.loadedAndValid,
  ).length;
  const angularError = latestDestinationBranchFrame.totalAngularErrorRadians;
  const normalizedBodyProgress = Math.max(0, Math.min(1, distancePast / destinationDistance));
  const maximumReachRatio = runtime.legs.reduce(
    (maximum, leg) => leg.planted && Number.isFinite(leg.currentReachRatio)
      ? Math.max(maximum, leg.currentReachRatio)
      : maximum,
    0,
  );
  const posturePhase = resolveJunctionPosturePhase({
    arrived: arrival.destinationReached,
    junctionEncountered:
      latestJunctionEstimate.phase !== "approaching" ||
      latestJunctionEstimate.destinationSideLoadedCount > 0,
    bodyProgress: normalizedBodyProgress,
    angularError,
    destinationPlaneSupportCount,
    trailingContactCount: latestJunctionEstimate.approachSideLoadedCount,
    nonCoplanar: activeTransitionNonCoplanar,
  });
  const progressSnapshot: JunctionTraversalProgressSnapshot = {
    ...snapshot,
    junctionEncountered:
      latestJunctionEstimate.phase !== "approaching" ||
      latestJunctionEstimate.destinationSideLoadedCount > 0,
    needsExploratoryTest:
      latestJunctionEstimate.phase === "exploring" &&
      latestJunctionEstimate.destinationSideLoadedCount === 0,
    bodyCenterProgress: normalizedBodyProgress,
    semanticRouteProgress,
    nonCoplanarTransition: activeTransitionNonCoplanar,
    posturePhase,
    branchFrameAngularError: angularError,
    branchFrameForwardError: latestDestinationBranchFrame.valid
      ? latestDestinationBranchFrame.forwardErrorRadians
      : 0,
    branchFramePitchError: latestDestinationBranchFrame.valid
      ? latestDestinationBranchFrame.pitchErrorRadians
      : 0,
    branchFrameRollError: latestDestinationBranchFrame.valid
      ? latestDestinationBranchFrame.rollErrorRadians
      : 0,
    destinationPlaneSupportCount,
    circumferentialCoverage,
    circumferentialContacts,
    contactStateFingerprint: createTransitionStateFingerprint(
      runtime,
      normalizedBodyProgress,
      angularError,
    ),
    maximumReachRatio,
    removableSupportCount,
    worstRemovalBodyMargin,
  };
  const strategyProgress: TransitionStrategyProgress = {
    branchFrameAlignmentRadians: progressSnapshot.branchFrameAngularError,
    oldPlaneContactCount: progressSnapshot.trailingContactCount,
    newPlaneContactCount: progressSnapshot.destinationPlaneSupportCount,
    worstReachRatio: progressSnapshot.maximumReachRatio,
    bodyProgress: progressSnapshot.bodyCenterProgress,
    trailingSupportCount,
  };
  latestTransitionStrategyDirective = transitionStrategyController.observe(
    strategyProgress,
    {
      junctionEncountered: progressSnapshot.junctionEncountered,
      bodyCenterBeyondJunction: progressSnapshot.bodyCenterBeyondJunction,
    },
    traversalCoordinator?.diagnostics.completedStepCount ?? 0,
  );
  return progressSnapshot;
}

function classifyCircumferentialContacts(
  runtime: SpiderStepRuntimeContext,
  estimate: JunctionProgressEstimate,
): CircumferentialContactClassification[] {
  const semantic = new Map(estimate.contacts.map((contact) => [contact.legId, contact]));
  const bodyCenter = new THREE.Vector3(
    runtime.bodyWorldPosition.x,
    runtime.bodyWorldPosition.y,
    runtime.bodyWorldPosition.z,
  );
  const supportCenter = new THREE.Vector3(
    runtime.supportFrame.center.x,
    runtime.supportFrame.center.y,
    runtime.supportFrame.center.z,
  );
  const bodyRight = new THREE.Vector3(
    runtime.supportFrame.right.x,
    runtime.supportFrame.right.y,
    runtime.supportFrame.right.z,
  ).normalize();
  const bodyUp = new THREE.Vector3(
    runtime.supportFrame.up.x,
    runtime.supportFrame.up.y,
    runtime.supportFrame.up.z,
  ).normalize();
  return runtime.legs.map((leg) => {
    const position = new THREE.Vector3(
      leg.contactWorldPosition.x,
      leg.contactWorldPosition.y,
      leg.contactWorldPosition.z,
    );
    const relativeToBody = position.clone().sub(bodyCenter);
    const relativeToSupportPlane = position.clone().sub(supportCenter);
    const planeHeight = relativeToSupportPlane.dot(bodyUp);
    const classification = semantic.get(leg.legId);
    const loadedAndValid = leg.planted && leg.loaded && leg.valid;
    const region = classification?.side === "approach"
      ? "trailing-old-plane" as const
      : classification?.side === "destination"
        ? "destination-plane" as const
        : planeHeight > 0.055
          ? "above-current-plane" as const
          : planeHeight < -0.055
            ? "below-current-plane" as const
            : "beside-current-plane" as const;
    return {
      legId: leg.legId,
      region,
      angleRadians: Math.atan2(
        relativeToBody.dot(bodyUp),
        relativeToBody.dot(bodyRight),
      ),
      loadedAndValid,
    };
  });
}

function measureCircumferentialCoverage(
  contactsForCoverage: readonly CircumferentialContactClassification[],
): number {
  const fullTurn = Math.PI * 2;
  const angles = contactsForCoverage
    .filter((contact) => contact.loadedAndValid)
    .map((contact) => (contact.angleRadians + fullTurn) % fullTurn)
    .sort((left, right) => left - right);
  if (angles.length < 2) return 0;
  let largestGap = 0;
  for (let index = 0; index < angles.length; index += 1) {
    const next = index + 1 < angles.length
      ? angles[index + 1]
      : angles[0] + fullTurn;
    largestGap = Math.max(largestGap, next - angles[index]);
  }
  return THREE.MathUtils.clamp((fullTurn - largestGap) / fullTurn, 0, 1);
}

function createTransitionStateFingerprint(
  runtime: SpiderStepRuntimeContext,
  bodyProgress: number,
  angularError: number,
): string {
  const contactsKey = runtime.legs.map((leg) => {
    const address = leg.address;
    return address
      ? `${leg.legId}:${address.strandId}@${Math.round(address.t * 20) / 20}`
      : `${leg.legId}:none`;
  }).join("|");
  const worstReach = runtime.legs.reduce(
    (maximum, leg) => leg.planted && Number.isFinite(leg.currentReachRatio)
      ? Math.max(maximum, leg.currentReachRatio)
      : maximum,
    0,
  );
  return [
    contactsKey,
    `b${Math.round(bodyProgress * 50) / 50}`,
    `a${Math.round(angularError * 50) / 50}`,
    `r${Math.round(worstReach * 50) / 50}`,
  ].join(";");
}

function resolveJunctionPosturePhase(input: {
  readonly arrived: boolean;
  readonly junctionEncountered: boolean;
  readonly bodyProgress: number;
  readonly angularError: number;
  readonly destinationPlaneSupportCount: number;
  readonly trailingContactCount: number;
  readonly nonCoplanar: boolean;
}): JunctionPosturePhase {
  if (input.arrived) return "arrived";
  if (!input.junctionEncountered) return "approach";
  if (!input.nonCoplanar) {
    return input.bodyProgress >= 0.72 ? "final-approach" : "aligned-with-branch";
  }
  if (input.destinationPlaneSupportCount === 0) return "entering-rotation";
  if (input.destinationPlaneSupportCount < 3) return "building-destination-support";
  if (input.angularError > Math.PI / 18) return "rotating-body";
  if (input.trailingContactCount > 0) return "clearing-upper-trailing-legs";
  if (input.bodyProgress >= 0.72) return "final-approach";
  return "aligned-with-branch";
}

function readTraversalSafety() {
  const runtime = getRuntimeContext();
  const stable = runtime.legs.filter((leg) => leg.planted && leg.loaded && leg.valid);
  // Phase 7 has already hard-validated the remaining support set before a
  // lift. Its brief swing/load interval may expose a transient weighted region
  // while one contact is absent or only partially loaded. Body easing is
  // allowed here only because updateBodyCommit independently requires
  // monotonic corrective support and a hard-valid final pose.
  const coupledStage = coupledTransfer?.coupledDiagnostics.stage ?? "idle";
  const transientAtomicTransfer = [
    "transferring-foot",
    "partial-load-held",
    "moving-body",
    "finishing-load",
    "restoring",
  ].includes(coupledStage);
  const continuouslyValidatedBodyCommit = bodyCommitActive;
  const restoredBodyAwaitingFreshPose =
    coupledTransfer?.restorationPending === true;
  const continuousMotionOwnsSafety =
    transientAtomicTransfer ||
    continuouslyValidatedBodyCommit ||
    restoredBodyAwaitingFreshPose;
  const weightedSupport = evaluateCoupledSupport(
    runtime.bodyWorldPosition,
    continuousMotionOwnsSafety,
    undefined,
    undefined,
    undefined,
    continuouslyValidatedBodyCommit && traversalBodyFrameActive
      ? traversalBodyFrame
      : undefined,
  );
  const ikFailure = stable.some((leg) =>
    leg.ikFinite === false ||
    !Number.isFinite(leg.ikResidual ?? Infinity) ||
    (leg.ikReached === false && (leg.ikResidual ?? Infinity) > 0.06));
  const plantedInvalid = runtime.legs.some(
    (leg) => leg.planted && invalidContactFrameStreak[leg.legId] >= 3,
  );
  return {
    supportValid:
      weightedSupport.effectiveSupportCount + 1e-6 >=
        locomotionConfig.minimumSupportFootCount &&
      (continuousMotionOwnsSafety || weightedSupport.classification === "hard-valid"),
    loadedSupportCount: weightedSupport.effectiveSupportCount,
    requiredSupportCount: locomotionConfig.minimumSupportFootCount,
    ikFailureActive: ikFailure,
    footFailureActive: plantedInvalid,
    routeValid: traversalCoordinator?.diagnostics.currentRoute
      ? routeIsStillValid(traversalCoordinator.diagnostics.currentRoute)
      : true,
    supportClassification: weightedSupport.classification,
    bodyEdgeMargin: weightedSupport.bodyEdgeMargin,
    effectiveSupportCount: weightedSupport.effectiveSupportCount,
    message: weightedSupport.classification === "invalid"
      ? `Weighted support is invalid: ${weightedSupport.failureReason}.`
      : ikFailure
      ? "A loaded planted leg cannot hold the current semantic address."
      : plantedInvalid
        ? "A planted semantic contact is invalid."
        : undefined,
  };
}

function routeIsStillValid(route: PlannedRoute): boolean {
  return route.legs.every((leg) => traversal.getStrandState(leg.strandId).traversable) &&
    route.transitions.every((transition) => {
      const node = traversal.getNode(transition.nodeId);
      return Boolean(
        node?.connectedStrandIds.has(transition.fromStrandId) &&
        node.connectedStrandIds.has(transition.toStrandId),
      );
    });
}

function topologyRevision(): string {
  return network.strandList
    .map((strand) => `${strand.id}:${Number(strand.active)}:${Number(strand.broken)}`)
    .join("|");
}

function prepareRepeatedAtomicPlan(context: JunctionTraversalPolicyContext): void {
  const runtime = getRuntimeContext();
  const directive = latestTransitionStrategyDirective;
  const classifications = new Map(
    latestJunctionEstimate?.contacts.map((contact) => [contact.legId, contact]) ?? [],
  );

  Object.assign(locomotionConfig.scoreWeights, standardFootholdScoreWeights);
  locomotionConfig.candidateSearchRadius = standardCandidateSearchRadius;
  locomotionConfig.candidateSamplingDensity = standardCandidateSamplingDensity;
  locomotionConfig.minimumFootSpacing = standardMinimumFootSpacing;
  locomotionConfig.minimumProgressImprovement =
    directive.strategy === "roll-under"
      ? -0.5
      : phaseEightMinimumProgressImprovement;
  locomotionConfig.lookaheadDistance =
    traversalPolicyConfig.scheduler.routeLookaheadDistance;

  liftableNextLegIds.clear();
  for (const leg of runtime.legs) {
    const supportWithoutLeg = leg.planted && leg.loaded && leg.valid
      ? evaluateCoupledSupport(
          runtime.bodyWorldPosition,
          false,
          undefined,
          leg.legId,
        )
      : null;
    if (
      supportWithoutLeg?.classification === "hard-valid" &&
      supportWithoutLeg.effectiveSupportCount + 1e-6 >=
        locomotionConfig.minimumSupportFootCount
    ) {
      liftableNextLegIds.add(leg.legId);
    }
  }

  for (const leg of runtime.legs) {
    if (!liftableNextLegIds.has(leg.legId)) {
      legSelectionScoreAdjustments[leg.legId] = -100;
      continue;
    }
    const side = classifications.get(leg.legId)?.side;
    const reach = Number.isFinite(leg.currentReachRatio)
      ? leg.currentReachRatio
      : phaseEightRuntimeReachTolerance;
    const region = transitionLegRegion(leg.legId);
    const preferredIndex = directive.preferredLegRegions.indexOf(region);
    const acceptsAny = directive.preferredLegRegions.includes("any");
    const regionScale = directive.reachReliefRequired ? 1 : 4;
    const regionPreference = acceptsAny
      ? 0
      : preferredIndex >= 0
        ? (directive.preferredLegRegions.length - preferredIndex) * regionScale
        : directive.reachReliefRequired ? -0.5 : -2;
    const contactPreference = directive.contactGoal === "new-plane"
      ? side === "approach" ? 9 : -1
      : directive.contactGoal === "trailing-relief"
        ? directive.reachReliefRequired
          ? side === "approach" ? 2 : 0
          : side === "approach" ? 12 : -3
        : side === "approach" ? 3 : 0;
    const reachPressure = Math.max(0, reach - 0.68) * (
      directive.reachReliefRequired ? 96 : 8
    );
    const preference = regionPreference + contactPreference + reachPressure;
    legSelectionScoreAdjustments[leg.legId] = preference;
  }

  // Generic repeat avoidance remains in LegSelector. Difficult transitions
  // bypass the old multi-term movement-history score so the stage directive is
  // the only high-level authority.
  latestHistoryInfluences = [];
  legHistorySnapshots.length = 0;
  prepareStrategyCandidateSeeds(runtime, context, directive);
  planRepeatedStepOrientation(
    context,
    directive.translationScale > 0,
    undefined,
    directive.translationScale,
  );
}

function prepareStrategyCandidateSeeds(
  runtime: SpiderStepRuntimeContext,
  context: JunctionTraversalPolicyContext,
  directive: TransitionStrategyDirective,
): void {
  latestCandidateSeeds = [];
  const usesTargetFrameNeighborhood =
    (directive.strategy === "roll-under" && directive.stage !== "resume-generic") ||
    directive.reachReliefRequired;
  if (
    !usesTargetFrameNeighborhood ||
    !context.progress.junctionEncountered ||
    !latestDestinationBranchFrame.valid ||
    !activeTraversalBranch ||
    !bodyPose
  ) return;

  const branch = fixture.branches[activeTraversalBranch];
  const currentBodyPosition = new THREE.Vector3(
    runtime.bodyWorldPosition.x,
    runtime.bodyWorldPosition.y,
    runtime.bodyWorldPosition.z,
  );
  const currentQuaternion = frameQuaternion({
    forward: bodyPose.result.bodyForward,
    up: bodyPose.result.bodyUp,
  }, new THREE.Quaternion());
  const targetQuaternion = frameQuaternion(
    latestDestinationBranchFrame.frame,
    new THREE.Quaternion(),
  );
  const stageQuaternion = currentQuaternion.clone().slerp(
    targetQuaternion,
    Math.max(0.2, directive.rotationScale),
  );
  const inverseCurrent = currentQuaternion.clone().invert();
  const routeStrand = traversal.getStrand(branch.routeStrandId);
  const routeLength = routeStrand?.totalRestLength ?? 0;

  for (const leg of runtime.legs) {
    if (!liftableNextLegIds.has(leg.legId)) continue;
    const localHome = new THREE.Vector3(
      leg.footHomeWorldPosition.x,
      leg.footHomeWorldPosition.y,
      leg.footHomeWorldPosition.z,
    ).sub(currentBodyPosition).applyQuaternion(inverseCurrent);
    latestCandidateSeeds.push({
      kind: "world-position",
      legId: leg.legId,
      source: "target-frame-foot-home",
      worldPosition: localHome.clone()
        .applyQuaternion(stageQuaternion)
        .add(currentBodyPosition),
      authorizedStrandIds: branch.supportStrandIds,
      neighborMaterialRadius: 0.09,
    });

    if (latestDestinationBranchFrame.sampleAddress && routeLength > 1e-8) {
      const forwardOffset = new THREE.Vector3(
        leg.footHomeWorldPosition.x - currentBodyPosition.x,
        leg.footHomeWorldPosition.y - currentBodyPosition.y,
        leg.footHomeWorldPosition.z - currentBodyPosition.z,
      ).dot(bodyPose.result.bodyForward);
      latestCandidateSeeds.push({
        kind: "continuous-address",
        legId: leg.legId,
        source: "connected-support",
        address: {
          strandId: branch.routeStrandId,
          t: THREE.MathUtils.clamp(
            latestDestinationBranchFrame.sampleAddress.t +
              latestDestinationBranchFrame.routeDirectionSign *
                forwardOffset / routeLength,
            0,
            1,
          ),
        },
        neighborMaterialRadius: 0.09,
      });
    }

    // The explicit companion rail is equally part of the selected branch's
    // support region. Seeding its live frame address prevents a junction-edge
    // contact from hiding every spacing-valid clearing move behind a main-rail
    // FootHome projection; the generator still chooses the exact continuous
    // address and applies every ordinary hard gate.
    if (latestDestinationBranchFrame.companionAddress) {
      latestCandidateSeeds.push({
        kind: "continuous-address",
        legId: leg.legId,
        source: "connected-support",
        address: { ...latestDestinationBranchFrame.companionAddress },
        neighborMaterialRadius: 0.09,
      });
    }
  }
}

function transitionLegRegion(
  legId: SpiderLegId,
): "front" | "middle" | "rear" {
  const digit = Number(legId.slice(1));
  if (digit <= 1) return "front";
  if (digit >= 4) return "rear";
  return "middle";
}

function recordRepeatedAtomicStep(event: AtomicStepHistoryEvent): void {
  recoveryExcludedLegIds.clear();
  recoveryExcludedFootholds.length = 0;
  if (!event.movedLegId) return;
  const runtime = getRuntimeContext();
  const leg = runtime.legs.find((entry) => entry.legId === event.movedLegId);
  legMovementHistory.recordStepOutcome({
    legId: event.movedLegId,
    stepIndex: event.completedStepCount,
    outcome: "complete",
    destinationSideAfter: leg?.address
      ? addressIsOnDestinationSide(leg.address, leg.contactWorldPosition)
      : false,
    reachRatioAfter: leg && Number.isFinite(leg.currentReachRatio)
      ? leg.currentReachRatio
      : undefined,
  });
}

function attemptTraversalRecovery(request: JunctionRecoveryRequest) {
  if (phase8FaultMode === "missing-contact") {
    recoverySearchTriggered = true;
    const decision = findLocalRecoveryDecision(request);
    latestRecoveryDestination = decision.stepDestination ?? null;
    return decision;
  }
  if (phase8FaultMode === "repeated-failure") {
    const retry = boundedStrategyAlternativeAvailable(request.attempt, 1);
    return {
      retry,
      stepDestination: request.destination,
      message: retry
        ? "Use the one bounded retry after the injected candidate blockade."
        : "The injected candidate blockade exhausted its bounded retry.",
    };
  }

  const failedPlan = stepController?.diagnostics.selectedPlan;
  if (failedPlan) {
    if (request.atomicFailureReason === "support-below-minimum") {
      recoveryExcludedLegIds.add(failedPlan.legId);
    } else {
      recoveryExcludedFootholds.push({
        legId: failedPlan.legId,
        address: { ...failedPlan.candidate.address },
      });
    }
  }
  const maximumAlternatives =
    latestTransitionStrategyDirective.strategy === "roll-under" ? 3 : 1;
  const retry = boundedStrategyAlternativeAvailable(
    request.attempt,
    maximumAlternatives,
  );
  return {
    retry,
    stepDestination: request.destination,
    message: retry
      ? "Try a distinct hard-valid leg or continuous foothold within the strategy's bounded alternatives."
      : "The active transition stage exhausted its bounded hard-valid alternatives.",
  };
}

function findLocalRecoveryDecision(request: JunctionRecoveryRequest) {
  const runtime = getRuntimeContext();
  const expectedAddress = fixture.faultInjection.temporaryInvalidContact.expectedAddress;
  const expectedPosition = new THREE.Vector3();
  traversal.getWorldPosition(expectedAddress, expectedPosition);
  const eligible = runtime.legs
    .filter((leg) => leg.address && leg.planted && leg.valid)
    .sort((left, right) => {
      const leftDistance = distance3(left.footHomeWorldPosition, expectedPosition);
      const rightDistance = distance3(right.footHomeWorldPosition, expectedPosition);
      return leftDistance - rightDistance || left.legId.localeCompare(right.legId);
    });
  const direction = activeTraversalBranch
    ? getLiveBranchDirection(activeTraversalBranch, scratchScale)
    : bodyPose?.result.bodyForward ?? supportForward;
  for (const runtimeLeg of eligible) {
    const leg = {
      legId: runtimeLeg.legId,
      footHomeWorldPosition: runtimeLeg.footHomeWorldPosition,
      reachOriginWorldPosition: runtimeLeg.reachOriginWorldPosition,
      reach: runtimeLeg.reach,
      reachScale: runtimeLeg.reachScale,
      currentAddress: runtimeLeg.address!,
      currentWorldPosition: runtimeLeg.contactWorldPosition,
      eligible: true,
    };
    const supports = runtime.legs
      .filter((support) => support.address)
      .map((support) => ({
        legId: support.legId,
        address: support.address!,
        position: support.contactWorldPosition,
        planted: support.planted,
        loaded: support.loaded,
        valid: support.valid,
      }));
    const result = localRecoveryPlanner.generate({
      leg,
      expectedAddress,
      supports,
      routeDirection: direction,
      junctionNodeId: undefined,
      jointFeasibility: runtime.jointFeasibility,
      validateCandidate: (address) => validatePhaseEightCandidate(runtimeLeg.legId, address),
    });
    latestRecoveryCandidates = result.candidates;
    localRecoverySearchCount += 1;
    if (result.selected) {
      return {
        retry: true,
        stepDestination: {
          kind: "address" as const,
          address: { ...result.selected.address },
        },
        message: `Bounded local recovery selected ${result.selected.address.strandId}@${result.selected.address.t.toFixed(3)} from ${result.attemptedCount} attempts.`,
      };
    }
  }
  return {
    retry: false,
    message:
      `Bounded local recovery found no safe alternative after ${localRecoverySearchCount} searches ` +
      `during coordinator attempt ${request.attempt}.`,
  };
}

function beginJunctionTest(_context: JunctionTraversalPolicyContext) {
  const branch = activeTraversalBranch ? fixture.branches[activeTraversalBranch] : null;
  const junction = traversal.getNode(fixture.junction.nodeId);
  const liveJunction = new THREE.Vector3();
  traversal.getNodePosition(fixture.junction.nodeId, liveJunction);
  latestExplorationCandidates = [];
  if (!branch || !junction) {
    return { status: "failed" as const, message: "No explicit true-Y branch is selected." };
  }
  for (const strandId of [...junction.connectedStrandIds].sort()) {
    if (strandId === fixture.junction.approachStrandId) continue;
    const strand = traversal.getStrand(strandId);
    if (!strand) continue;
    const leavesStart = strand.startNode.id === junction.id;
    const address = { strandId, t: leavesStart ? 0.13 : 0.87 };
    const position = new THREE.Vector3();
    traversal.getWorldPosition(address, position);
    latestExplorationCandidates = [
      ...latestExplorationCandidates,
      {
        position,
        accepted: strandId === branch.routeStrandId,
        label: strandId,
      },
    ];
  }
  const falseCrossingWasExcluded = !junction.connectedStrandIds.has(
    fixture.strandIds.falseCrossing,
  );
  if (!falseCrossingWasExcluded) {
    return { status: "failed" as const, message: "Projection crossing leaked into Y connectivity." };
  }
  return {
    status: "complete" as const,
    stepDestination: {
      kind: "address" as const,
      address: {
        strandId: branch.routeStrandId,
        t: traversal.getStrand(branch.routeStrandId)?.startNode.id === junction.id ? 0.16 : 0.84,
      },
    },
    selectedBranchStrandId: branch.routeStrandId,
    message: `Bounded true-Y test retained ${branch.routeStrandId}; ${fixture.strandIds.falseCrossing} was not connected.`,
  };
}

function resetCoupledBodyMotionDiagnostics(): void {
  Object.assign(
    coupledBodyMotionDiagnostics,
    createCoupledBodyMotionDiagnostics(),
  );
  coupledFullLoadAwaitingIkVersion = null;
}

function coupledPolicyContext(): JunctionTraversalPolicyContext | null {
  const diagnostics = traversalCoordinator?.diagnostics;
  const route = diagnostics?.currentRoute;
  const destination = diagnostics?.destination;
  if (!diagnostics || !route || !destination) return null;
  const progress = readTraversalProgress(route, destination);
  diagnostics.progress = progress;
  return {
    destination,
    route,
    progress,
    completedStepCount: diagnostics.completedStepCount,
    nextStepIndex: diagnostics.completedStepCount + 1,
  };
}

function evaluateCoupledSupport(
  bodyPosition: { readonly x: number; readonly y: number; readonly z: number },
  corrective: boolean,
  predictedReachRatios?: ReadonlyMap<SpiderLegId, number>,
  excludedLegId?: SpiderLegId,
  candidateOverride?: {
    readonly legId: SpiderLegId;
    readonly worldPosition: { readonly x: number; readonly y: number; readonly z: number };
    readonly loadFactor: number;
    readonly valid: boolean;
    readonly reachValid: boolean;
  },
  supportFrameOverride?: {
    readonly up: { readonly x: number; readonly y: number; readonly z: number };
    readonly forward: { readonly x: number; readonly y: number; readonly z: number };
  },
) {
  const runtime = getRuntimeContext();
  return new SupportEstimator({
    minimumSupportCount: locomotionConfig.minimumSupportFootCount,
    minimumBroadness: 0.045,
    minimumBodyMargin: 0,
    softBodyMargin: 0.055,
  }).estimate(
    runtime.legs.map((leg) => {
      const isCandidate = candidateOverride?.legId === leg.legId;
      return ({
        id: leg.legId,
        worldPosition: isCandidate
          ? candidateOverride.worldPosition
          : leg.contactWorldPosition,
        active: isCandidate || leg.planted,
        moving: (!isCandidate && !leg.planted) || leg.legId === excludedLegId,
        loadFactor: isCandidate
          ? candidateOverride.loadFactor
          : leg.loadFactor ?? (leg.loaded ? 1 : 0),
        // Contact-frame validity already uses a three-sample hysteresis before
        // it becomes an actionable semantic-foot failure. Match that contract
        // here so one solver-frame fluctuation does not invalidate the entire
        // weighted support region.
        valid: isCandidate
          ? candidateOverride.valid
          : leg.planted &&
            (leg.valid || invalidContactFrameStreak[leg.legId] < 3),
        reachValid:
          (!isCandidate || candidateOverride.reachValid) &&
          (predictedReachRatios?.get(leg.legId) ?? leg.currentReachRatio) <=
            phaseEightRuntimeReachTolerance,
        weight: bodySupportWeights[leg.legId],
      });
    }),
    {
      bodyWorldPosition: bodyPosition,
      supportUp: supportFrameOverride?.up ?? runtime.supportFrame.up,
      supportForward: supportFrameOverride?.forward ?? runtime.supportFrame.forward,
      corrective,
    },
  );
}

function maximumPlantedReachRatio(): number {
  return getRuntimeContext().legs.reduce(
    (maximum, leg) => leg.planted && Number.isFinite(leg.currentReachRatio)
      ? Math.max(maximum, leg.currentReachRatio)
      : maximum,
    0,
  );
}

function coupledBodyClearance(frame: {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly forward: { readonly x: number; readonly y: number; readonly z: number };
  readonly up: { readonly x: number; readonly y: number; readonly z: number };
  readonly right: { readonly x: number; readonly y: number; readonly z: number };
}): number {
  const samples = [
    new THREE.Vector3(frame.position.x, frame.position.y, frame.position.z),
  ];
  for (const [axis, radius] of [
    [frame.forward, traversalPolicyConfig.orientation.bodyEnvelopeRadiusForward],
    [frame.right, traversalPolicyConfig.orientation.bodyEnvelopeRadiusRight],
    [frame.up, traversalPolicyConfig.orientation.bodyEnvelopeRadiusUp],
  ] as const) {
    samples.push(
      new THREE.Vector3(frame.position.x, frame.position.y, frame.position.z)
        .addScaledVector(new THREE.Vector3(axis.x, axis.y, axis.z), radius),
      new THREE.Vector3(frame.position.x, frame.position.y, frame.position.z)
        .addScaledVector(new THREE.Vector3(axis.x, axis.y, axis.z), -radius),
    );
  }
  return samples.reduce((minimum, point) =>
    Math.min(
      minimum,
      traversal.findClosestPoint(point, { traversableOnly: true })?.distance ?? Infinity,
  ), Infinity);
}

function beginCoupledBodyMotion(_request: CoupledBodyMotionRequest) {
  resetCoupledBodyMotionDiagnostics();
  const context = coupledPolicyContext();
  if (!context || !bodyPose) {
    return {
      status: "failed" as const,
      message: "Coupled body motion lacks a live route/body policy context.",
    };
  }

  const runtime = getRuntimeContext();
  const directive = latestTransitionStrategyDirective;
  const movingRuntimeLeg = runtime.legs.find(
    (leg) => leg.legId === _request.movingLegId,
  );
  const settledContactOverride = movingRuntimeLeg
    ? {
        legId: movingRuntimeLeg.legId,
        worldPosition: movingRuntimeLeg.contactWorldPosition,
        loadFactor: THREE.MathUtils.clamp(_request.partialLoadFactor, 0, 1),
        valid: movingRuntimeLeg.valid,
        reachValid:
          Number.isFinite(movingRuntimeLeg.currentReachRatio) &&
          movingRuntimeLeg.currentReachRatio <= phaseEightRuntimeReachTolerance,
      }
    : undefined;
  const partialLoadFactor = THREE.MathUtils.clamp(_request.partialLoadFactor, 0, 1);
  const loadTransitionFactors = Array.from(
    { length: phaseEightLoadTransitionSupportSampleCount },
    (_, index) => partialLoadFactor +
      (1 - partialLoadFactor) *
        (index / Math.max(1, phaseEightLoadTransitionSupportSampleCount - 1)),
  );
  const supportBefore = evaluateCoupledSupport(runtime.bodyWorldPosition, false);
  const currentPhysicalWorstReach = maximumPlantedReachRatio();
  const transactionWorstReachBefore = Number.isFinite(
    _request.worstReachRatioBeforeTransfer,
  )
    ? _request.worstReachRatioBeforeTransfer as number
    : currentPhysicalWorstReach;
  coupledMotionStartProgress = context.progress.bodyCenterDistancePastJunction;
  coupledBodyMotionDiagnostics.worstReachBefore = transactionWorstReachBefore;
  coupledBodyMotionDiagnostics.trailingReachBefore =
    context.progress.criticalTrailingReachRatio;
  coupledBodyMotionDiagnostics.supportBefore = supportBefore.classification;
  coupledBodyMotionDiagnostics.branchFrameAngularErrorBefore =
    context.progress.branchFrameAngularError;
  coupledBodyMotionDiagnostics.destinationPlaneSupportCountBefore =
    context.progress.destinationPlaneSupportCount;
  coupledBodyMotionDiagnostics.circumferentialCoverageBefore =
    context.progress.circumferentialCoverage;
  coupledBodyMotionDiagnostics.posturePhase = context.progress.posturePhase;
  coupledBodyMotionDiagnostics.rotationFirst = directive.bodyGoal !== "advance";

  const orientationProposal = planRepeatedStepOrientation(
    context,
    directive.translationScale > 0,
    undefined,
    directive.translationScale,
  );
  const currentFrame = {
    position: runtime.bodyWorldPosition,
    forward: bodyPose.result.bodyForward,
    up: bodyPose.result.bodyUp,
    right: bodyPose.result.bodyRight,
  };
  const currentQuaternion = frameQuaternion(currentFrame, new THREE.Quaternion());
  const acceptedOrientationQuaternion = frameQuaternion(
    orientationProposal.acceptedFrame,
    new THREE.Quaternion(),
  );
  const boundedQuaternion = currentQuaternion.clone().slerp(
    acceptedOrientationQuaternion,
    THREE.MathUtils.clamp(directive.rotationScale, 0, 1),
  );
  const targetFrame = {
    position: orientationProposal.acceptedFrame.position,
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(boundedQuaternion).normalize(),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(boundedQuaternion).normalize(),
    forward: new THREE.Vector3(0, 0, -1)
      .applyQuaternion(boundedQuaternion)
      .normalize(),
  };
  const classifications = new Map(
    latestJunctionEstimate?.contacts.map((contact) => [contact.legId, contact]) ?? [],
  );
  const reachContacts = runtime.legs.map((leg) => ({
    legId: leg.legId,
    planted: leg.planted,
    contactWorldPosition: leg.contactWorldPosition,
    reachOriginWorldPosition: leg.reachOriginWorldPosition,
    minimumReach: leg.reach.min * leg.reachScale * phase8MinimumReachScale,
    comfortableReach: leg.reach.comfortable * leg.reachScale,
    maximumReach: leg.reach.max * leg.reachScale,
    loadFactor: leg.loadFactor ?? (leg.loaded ? 1 : 0),
    trailing: classifications.get(leg.legId)?.side === "approach",
  }));
  const branchDirection = activeTraversalBranch
    ? getLiveBranchDirection(activeTraversalBranch, new THREE.Vector3())
    : bodyPose.result.bodyForward;
  const branchTargetFrame = latestDestinationBranchFrame.valid
    ? latestDestinationBranchFrame.frame
    : null;

  const search = reachBudgetController.search({
    currentFrame,
    targetFrame,
    contacts: reachContacts,
    support: (candidate) => {
      const predicted = new Map(
        candidate.budget.legs.map((leg) => [leg.legId, leg.predictedReachRatio]),
      );
      const loadEstimates = loadTransitionFactors.map((loadFactor) =>
        evaluateCoupledSupport(
          candidate.frame.position,
          false,
          predicted,
          undefined,
          settledContactOverride
            ? { ...settledContactOverride, loadFactor }
            : undefined,
          candidate.frame,
        ),
      );
      const failedIndex = loadEstimates.findIndex(
        (estimate) => estimate.classification !== "hard-valid",
      );
      const weakest = loadEstimates.reduce((left, right) =>
        right.bodyEdgeMargin < left.bodyEdgeMargin ? right : left);
      return {
        valid: failedIndex < 0,
        classification: failedIndex < 0 ? "hard-valid" : "invalid",
        reason: failedIndex < 0
          ? weakest.failureReason
          : "load-transition-" +
            loadTransitionFactors[failedIndex].toFixed(3) + "-" +
            loadEstimates[failedIndex].failureReason,
        score: 0,
      };
    },
    clearance: (candidate) => {
      const withinIncrementLimits =
        candidate.translationDistance <=
          traversalPolicyConfig.orientation.maximumTranslationPerStep + 1e-8 &&
        candidate.rotationRadians <=
          traversalPolicyConfig.orientation.maximumRotationRadiansPerStep + 1e-8;
      const clearance = coupledBodyClearance(candidate.frame);
      return {
        valid:
          withinIncrementLimits &&
          clearance + 1e-8 >= traversalPolicyConfig.orientation.minimumSilkClearance,
        reason: withinIncrementLimits
          ? "body clearance " + clearance.toFixed(4)
          : "bounded translation/rotation increment exceeded",
        score: 0,
      };
    },
    usefulness: (candidate) => {
      const routeProgress =
        (candidate.frame.position.x - currentFrame.position.x) * branchDirection.x +
        (candidate.frame.position.y - currentFrame.position.y) * branchDirection.y +
        (candidate.frame.position.z - currentFrame.position.z) * branchDirection.z;
      const candidateAngularError = branchTargetFrame
        ? bodyFrameAngularError(candidate.frame, branchTargetFrame)
        : context.progress.branchFrameAngularError;
      const angularImprovement =
        context.progress.branchFrameAngularError - candidateAngularError;
      const reachImprovement = Math.max(
        0,
        candidate.budget.reachBudgetImprovement,
        candidate.budget.trailingReachImprovement,
      );
      const activeMetric = directive.bodyGoal === "advance"
        ? routeProgress
        : angularImprovement;
      const useful =
        activeMetric > 1e-5 ||
        (directive.reachReliefRequired && reachImprovement > 1e-5);
      return {
        useful,
        reason: useful
          ? undefined
          : "no improvement in the active strategy-stage metric",
        score:
          Math.max(0, activeMetric) * 100 +
          reachImprovement * 10 +
          Math.max(candidate.translationFraction, candidate.rotationFraction) * 0.01,
      };
    },
  });

  coupledBodyMotionDiagnostics.proposedCandidates = search.candidates.map((candidate) => ({
    fraction: Math.max(candidate.translationFraction, candidate.rotationFraction),
    translation: {
      x: candidate.frame.position.x - currentFrame.position.x,
      y: candidate.frame.position.y - currentFrame.position.y,
      z: candidate.frame.position.z - currentFrame.position.z,
    },
    rotationRadians: candidate.rotationRadians,
    accepted: candidate === search.accepted,
    useful: candidate.usefulness.useful,
    limitingLegId: candidate.limitingLegId,
    limitingConstraint: candidate.limitingConstraint,
    worstReachRatio: candidate.budget.worstPredictedReachRatio,
    supportClassification:
      candidate.support.classification === "hard-valid"
        ? "hard-valid"
        : "invalid",
    rejectionReasons: [
      candidate.limitingConstraint,
      candidate.support.reason,
      candidate.clearance.reason,
      candidate.usefulness.reason,
    ].filter((reason): reason is string => Boolean(reason)),
  }));

  const accepted = search.accepted;
  if (!search.success || !accepted) {
    coupledBodyMotionDiagnostics.limitingLegId = search.limitingLegId;
    coupledBodyMotionDiagnostics.limitingConstraint = search.limitingConstraint;
    const selectedPlan = _request.atomicDiagnostics.selectedPlan;
    const contactGoalSatisfied = selectedPlan
      ? transitionContactGoalSatisfied(
          selectedPlan.currentContact.address,
          selectedPlan.currentContact.worldPosition,
          selectedPlan.currentContact.reachRatio,
          selectedPlan.candidate.address,
          selectedPlan.candidate.worldPosition,
          selectedPlan.candidate.reachRatio,
          Math.max(
            transactionWorstReachBefore,
            selectedPlan.currentContact.reachRatio,
          ),
        )
      : false;
    if (
      supportBefore.classification === "hard-valid" &&
      currentPhysicalWorstReach <= phaseEightRuntimeReachTolerance &&
      contactGoalSatisfied
    ) {
      coupledBodyMotionDiagnostics.worstReachAfter = currentPhysicalWorstReach;
      coupledBodyMotionDiagnostics.trailingReachAfter =
        context.progress.criticalTrailingReachRatio;
      coupledBodyMotionDiagnostics.supportAfter = "hard-valid";
      coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter =
        context.progress.branchFrameAngularError;
      coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter =
        context.progress.destinationPlaneSupportCount;
      coupledBodyMotionDiagnostics.circumferentialCoverageAfter =
        context.progress.circumferentialCoverage;
      coupledBodyMotionDiagnostics.limitingConstraint = "strategy-contact-only";
      return {
        status: "complete" as const,
        message:
          "The real foothold transfer satisfied this stage; no additional body motion was safe or necessary.",
      };
    }
    return {
      status: "failed" as const,
      message: search.message,
    };
  }

  Object.assign(latestBodyOrientationPlan.acceptedFrame.position, accepted.frame.position);
  Object.assign(latestBodyOrientationPlan.acceptedFrame.forward, accepted.frame.forward);
  Object.assign(latestBodyOrientationPlan.acceptedFrame.up, accepted.frame.up);
  Object.assign(latestBodyOrientationPlan.acceptedFrame.right, accepted.frame.right);
  latestBodyOrientationPlan.success = true;
  latestBodyOrientationPlan.failureReason = "none";
  latestBodyOrientationPlan.message = search.message;
  latestBodyOrientationPlan.requestedTranslation = search.requestedTranslation;
  latestBodyOrientationPlan.requestedRotationRadians = search.requestedRotationRadians;
  latestBodyOrientationPlan.plannedTranslation = accepted.translationDistance;
  latestBodyOrientationPlan.plannedRotationRadians = accepted.rotationRadians;
  latestBodyOrientationPlan.acceptedFraction = Math.max(
    accepted.translationFraction,
    accepted.rotationFraction,
  );
  latestBodyOrientationPlan.maximumPredictedReachRatio =
    accepted.budget.worstPredictedReachRatio;
  latestBodyOrientationPlan.limitingLegId = accepted.budget.limitingLegId;
  latestBodyOrientationPlan.predictedReaches.length = 0;
  latestBodyOrientationPlan.predictedReaches.push(
    ...accepted.budget.legs.map((leg) => ({
      legId: leg.legId,
      distance: leg.predictedDistance,
      ratio: leg.predictedReachRatio,
      withinLimits: leg.hardValid,
    })),
  );

  Object.assign(coupledBodyMotionDiagnostics.acceptedTranslation, {
    x: accepted.frame.position.x - currentFrame.position.x,
    y: accepted.frame.position.y - currentFrame.position.y,
    z: accepted.frame.position.z - currentFrame.position.z,
  });
  coupledBodyMotionDiagnostics.acceptedRotationRadians = accepted.rotationRadians;
  coupledBodyMotionDiagnostics.acceptedFraction =
    latestBodyOrientationPlan.acceptedFraction;
  coupledBodyMotionDiagnostics.worstReachAfter =
    accepted.budget.worstPredictedReachRatio;
  coupledBodyMotionDiagnostics.trailingReachBefore =
    accepted.budget.worstTrailingCurrentReachRatio;
  coupledBodyMotionDiagnostics.trailingReachAfter =
    accepted.budget.worstTrailingPredictedReachRatio;
  coupledBodyMotionDiagnostics.reachBudgetImprovement =
    accepted.budget.reachBudgetImprovement +
    Math.max(0, accepted.budget.trailingReachImprovement);
  coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter = branchTargetFrame
    ? bodyFrameAngularError(accepted.frame, branchTargetFrame)
    : context.progress.branchFrameAngularError;
  coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter =
    context.progress.destinationPlaneSupportCount;
  coupledBodyMotionDiagnostics.circumferentialCoverageAfter =
    context.progress.circumferentialCoverage;
  coupledBodyMotionDiagnostics.supportAfter =
    accepted.support.classification === "hard-valid"
      ? "hard-valid"
      : "invalid";
  coupledBodyMotionDiagnostics.limitingLegId = accepted.budget.limitingLegId;
  coupledBodyMotionDiagnostics.limitingConstraint = "none";
  return startBodyCommit(latestBodyOrientationPlan);
}

function updateCoupledBodyMotion(fixedDeltaSeconds: number, _request: CoupledBodyMotionRequest) {
  const result = updateBodyCommit(fixedDeltaSeconds);
  if (result.status !== "complete") return result;

  const context = coupledPolicyContext();
  const worstAfter = maximumPlantedReachRatio();
  const supportAfter = evaluateCoupledSupport(getRuntimeContext().bodyWorldPosition, false);
  coupledBodyMotionDiagnostics.worstReachAfter = worstAfter;
  coupledBodyMotionDiagnostics.trailingReachAfter =
    context?.progress.criticalTrailingReachRatio ?? 0;
  coupledBodyMotionDiagnostics.bodyProgressDelta =
    (context?.progress.bodyCenterDistancePastJunction ?? coupledMotionStartProgress) -
    coupledMotionStartProgress;
  coupledBodyMotionDiagnostics.supportAfter = supportAfter.classification;
  coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter =
    context?.progress.branchFrameAngularError ??
    coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter;
  coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter =
    context?.progress.destinationPlaneSupportCount ??
    coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter;
  coupledBodyMotionDiagnostics.circumferentialCoverageAfter =
    context?.progress.circumferentialCoverage ??
    coupledBodyMotionDiagnostics.circumferentialCoverageAfter;
  coupledBodyMotionDiagnostics.reachBudgetImprovement =
    coupledBodyMotionDiagnostics.worstReachBefore - worstAfter +
    Math.max(
      0,
      coupledBodyMotionDiagnostics.trailingReachBefore -
        coupledBodyMotionDiagnostics.trailingReachAfter,
    );
  return result;
}

function validateCoupledStablePose(
  _fixedDeltaSeconds: number,
  _request: CoupledBodyMotionRequest,
) {
  const runtime = getRuntimeContext();
  const ikVersion = runtime.ikSolveVersion ?? 0;
  if (coupledFullLoadAwaitingIkVersion === null) {
    coupledFullLoadAwaitingIkVersion = ikVersion;
    return {
      status: "running" as const,
      message: "Full load reached; wait for one fresh rig and IK observation.",
    };
  }
  if (ikVersion <= coupledFullLoadAwaitingIkVersion) {
    return { status: "running" as const };
  }

  const unstableReach = runtime.legs.find((leg) =>
    leg.planted &&
    (!Number.isFinite(leg.currentReachRatio) ||
      leg.currentReachRatio > phaseEightRuntimeReachTolerance));
  if (unstableReach) {
    coupledBodyMotionDiagnostics.limitingLegId = unstableReach.legId;
    coupledBodyMotionDiagnostics.limitingConstraint = "full-load-hard-reach";
    coupledBodyMotionDiagnostics.supportAfter = "invalid";
    return {
      status: "failed" as const,
      message: `Full-load validation rejected hard reach at ${unstableReach.legId}.`,
    };
  }

  const support = evaluateCoupledSupport(runtime.bodyWorldPosition, false);
  coupledBodyMotionDiagnostics.supportAfter = support.classification;
  coupledBodyMotionDiagnostics.worstReachAfter = maximumPlantedReachRatio();
  const fallbackRight = new THREE.Vector3()
    .crossVectors(runtime.supportFrame.forward, runtime.supportFrame.up)
    .normalize();
  const actualFrame = {
    position: runtime.bodyWorldPosition,
    forward: traversalBodyFrameActive
      ? traversalBodyFrame.forward
      : bodyPose?.result.bodyForward ?? runtime.supportFrame.forward,
    up: traversalBodyFrameActive
      ? traversalBodyFrame.up
      : bodyPose?.result.bodyUp ?? runtime.supportFrame.up,
    right: traversalBodyFrameActive
      ? traversalBodyFrame.right
      : bodyPose?.result.bodyRight ?? fallbackRight,
  };
  const clearance = coupledBodyClearance(actualFrame);
  if (support.classification !== "hard-valid") {
    coupledBodyMotionDiagnostics.limitingConstraint =
      `full-load-support-${support.failureReason}`;
    return {
      status: "failed" as const,
      message:
        `Full-load validation rejected support (${support.failureReason}; ` +
        `margin ${support.bodyEdgeMargin.toFixed(4)}).`,
    };
  }
  if (clearance + 1e-8 < traversalPolicyConfig.orientation.minimumSilkClearance) {
    coupledBodyMotionDiagnostics.limitingConstraint = "full-load-silk-clearance";
    return {
      status: "failed" as const,
      message: `Full-load validation rejected body clearance at ${clearance.toFixed(4)}.`,
    };
  }
  const context = coupledPolicyContext();
  coupledBodyMotionDiagnostics.trailingReachAfter =
    context?.progress.criticalTrailingReachRatio ?? 0;
  coupledBodyMotionDiagnostics.bodyProgressDelta =
    (context?.progress.bodyCenterDistancePastJunction ?? coupledMotionStartProgress) -
    coupledMotionStartProgress;
  coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter =
    context?.progress.branchFrameAngularError ??
    coupledBodyMotionDiagnostics.branchFrameAngularErrorAfter;
  coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter =
    context?.progress.destinationPlaneSupportCount ??
    coupledBodyMotionDiagnostics.destinationPlaneSupportCountAfter;
  coupledBodyMotionDiagnostics.circumferentialCoverageAfter =
    context?.progress.circumferentialCoverage ??
    coupledBodyMotionDiagnostics.circumferentialCoverageAfter;
  coupledBodyMotionDiagnostics.reachBudgetImprovement =
    coupledBodyMotionDiagnostics.worstReachBefore -
    coupledBodyMotionDiagnostics.worstReachAfter +
    Math.max(
      0,
      coupledBodyMotionDiagnostics.trailingReachBefore -
        coupledBodyMotionDiagnostics.trailingReachAfter,
    );
  coupledBodyMotionDiagnostics.limitingConstraint = "none";
  return {
    status: "complete" as const,
    message: "Fresh full-load support, reach, clearance, and IK observation are valid.",
  };
}


function startBodyCommit(plan: BodyOrientationPlan) {
  if (!plan.success || !bodyPose) {
    return {
      status: "failed" as const,
      message: `Body commitment rejected: ${plan.message}`,
    };
  }
  bodyCommitStartOffset.copy(bodyCommitOffset);
  bodyCommitStartWorldPosition.copy(bodyPose.result.anchorWorldPosition);
  bodyCommitTargetWorldPosition.set(
    plan.acceptedFrame.position.x,
    plan.acceptedFrame.position.y,
    plan.acceptedFrame.position.z,
  );
  const initialSupport = evaluateCoupledSupport(
    bodyCommitStartWorldPosition,
    true,
    undefined,
    undefined,
    undefined,
    traversalBodyFrameActive
      ? traversalBodyFrame
      : {
          up: bodyPose.result.bodyUp,
          forward: bodyPose.result.bodyForward,
        },
  );
  bodyCommitLastSupportMargin = initialSupport.bodyEdgeMargin;
  bodyCommitLastSupportBroadness = initialSupport.broadness;
  bodyCommitLastWorstReach = maximumPlantedReachRatio();
  bodyCommitHardSupportReached = initialSupport.classification === "hard-valid";
  bodyCommitTargetOffset.copy(bodyCommitOffset).add(new THREE.Vector3(
    plan.acceptedFrame.position.x - bodyPose.result.anchorWorldPosition.x,
    plan.acceptedFrame.position.y - bodyPose.result.anchorWorldPosition.y,
    plan.acceptedFrame.position.z - bodyPose.result.anchorWorldPosition.z,
  ));
  frameQuaternion(
    traversalBodyFrameActive ? traversalBodyFrame : {
      forward: bodyPose.result.bodyForward,
      up: bodyPose.result.bodyUp,
    },
    bodyCommitStartQuaternion,
  );
  frameQuaternion(plan.acceptedFrame, bodyCommitTargetQuaternion);
  bodyCommitElapsedSeconds = 0;
  bodyCommitActive = true;
  bodyCommitSnapshotRetained = true;
  bodyCommitAwaitingIkVersion = null;
  return { status: "running" as const, message: "Reach-checked body commitment began." };
}

function updateBodyCommit(fixedDeltaSeconds: number) {
  if (!bodyCommitActive) {
    return { status: "failed" as const, message: "Body commitment state was lost." };
  }
  bodyCommitElapsedSeconds += fixedDeltaSeconds;
  const duration = Math.max(0.12, locomotionConfig.bodyAdvanceDuration);
  const factor = smoothStep01(bodyCommitElapsedSeconds / duration);
  bodyCommitOffset.lerpVectors(bodyCommitStartOffset, bodyCommitTargetOffset, factor);
  orientationCurrentQuaternion.slerpQuaternions(
    bodyCommitStartQuaternion,
    bodyCommitTargetQuaternion,
    factor,
  );
  writeTraversalFrame(orientationCurrentQuaternion);
  bodyCommitLiveWorldPosition.lerpVectors(
    bodyCommitStartWorldPosition,
    bodyCommitTargetWorldPosition,
    factor,
  );
  traversalBodyFrame.position.copy(bodyCommitLiveWorldPosition);
  const runtime = getRuntimeContext();
  const unstable = runtime.legs.find((leg) =>
    leg.planted &&
    (!Number.isFinite(leg.currentReachRatio) ||
      leg.currentReachRatio > phaseEightRuntimeReachTolerance));
  if (unstable) {
    restoreBodyCommit();
    return {
      status: "failed" as const,
      message: `Continuous reach check rejected body commitment at ${unstable.legId}.`,
    };
  }
  const liveSupport = evaluateCoupledSupport(
    bodyCommitLiveWorldPosition,
    true,
    undefined,
    undefined,
    undefined,
    traversalBodyFrame,
  );
  const liveClearance = coupledBodyClearance(traversalBodyFrame);
  const liveWorstReach = maximumPlantedReachRatio();
  const minimumSupportPreserved =
    liveSupport.effectiveSupportCount + 1e-6 >=
      locomotionConfig.minimumSupportFootCount;
  const correctiveSupportImproved =
    liveSupport.bodyEdgeMargin + 0.0005 >= bodyCommitLastSupportMargin ||
    liveSupport.broadness + 0.002 >= bodyCommitLastSupportBroadness ||
    liveWorstReach <= bodyCommitLastWorstReach + 0.001;
  const finalFactor = factor >= 1 - 1e-6;
  const supportPathValid =
    minimumSupportPreserved &&
    (liveSupport.classification === "hard-valid" ||
      (!finalFactor && !bodyCommitHardSupportReached && correctiveSupportImproved));
  if (
    !supportPathValid ||
    liveClearance + 1e-8 < traversalPolicyConfig.orientation.minimumSilkClearance
  ) {
    restoreBodyCommit();
    return {
      status: "failed" as const,
      message: !supportPathValid
        ? `Continuous support check rejected body commitment (${liveSupport.failureReason}; hard final support required).`
        : `Continuous silk-clearance check rejected body commitment at ${liveClearance.toFixed(4)}.`,
    };
  }
  bodyCommitLastSupportMargin = liveSupport.bodyEdgeMargin;
  bodyCommitLastSupportBroadness = liveSupport.broadness;
  bodyCommitLastWorstReach = liveWorstReach;
  bodyCommitHardSupportReached ||= liveSupport.classification === "hard-valid";
  if (factor < 1 - 1e-6) {
    return { status: "running" as const };
  }
  const ikVersion = runtime.ikSolveVersion ?? 0;
  if (bodyCommitAwaitingIkVersion === null) {
    bodyCommitAwaitingIkVersion = ikVersion;
    return { status: "running" as const };
  }
  if (ikVersion <= bodyCommitAwaitingIkVersion) {
    return { status: "running" as const };
  }
  bodyCommitActive = false;
  bodyCommitAwaitingIkVersion = null;
  return {
    status: "complete" as const,
    message: "Body translation and local-frame rotation committed with fixed foot addresses.",
  };
}

function commitCoupledBodyMotion(): void {
  bodyCommitSnapshotRetained = false;
  bodyCommitAwaitingIkVersion = null;
  bodyCommitRestorationAwaitingIkVersion = null;
  coupledFullLoadAwaitingIkVersion = null;
}

function restoreBodyCommit(): boolean {
  if (!bodyCommitActive && !bodyCommitSnapshotRetained) return true;
  bodyCommitOffset.copy(bodyCommitStartOffset);
  writeTraversalFrame(bodyCommitStartQuaternion);
  traversalBodyFrame.position.copy(bodyCommitStartWorldPosition);
  bodyCommitActive = false;
  bodyCommitSnapshotRetained = false;
  bodyCommitAwaitingIkVersion = null;
  bodyCommitRestorationAwaitingIkVersion = ikSolveVersion;
  bodyCommitElapsedSeconds = 0;
  return true;
}

function bodyCommitRestorationPending(): boolean {
  if (bodyCommitRestorationAwaitingIkVersion === null) return false;
  if (ikSolveVersion <= bodyCommitRestorationAwaitingIkVersion) return true;
  bodyCommitRestorationAwaitingIkVersion = null;
  return false;
}

function planRepeatedStepOrientation(
  context: JunctionTraversalPolicyContext,
  includeTranslation: boolean,
  translationDirection?: THREE.Vector3,
  translationScale = 1,
): BodyOrientationPlan {
  if (!bodyPose) return latestBodyOrientationPlan;
  const runtime = getRuntimeContext();
  const branchId = activeTraversalBranch;
  const branch = branchId ? fixture.branches[branchId] : null;
  const branchDirection = branchId
    ? getLiveBranchDirection(branchId, scratchScale)
    : bodyPose.result.bodyForward;
  const establishedDestinationSupports =
    latestJunctionEstimate?.destinationSideLoadedCount ?? 0;
  const turnWeight = branch
    ? THREE.MathUtils.clamp(
        establishedDestinationSupports /
          Math.max(1, branch.minimumDestinationSideContacts),
        0,
        1,
      )
    : 1;
  // Route direction is an orientation proposal, not permission to turn the
  // body before the feet have established the branch. Blend progressively as
  // destination-side contacts make that rotation supportable.
  const direction = orientationRouteDirection
    .copy(bodyPose.result.bodyForward)
    .lerp(branchDirection, turnWeight)
    .normalize();
  const classifications = new Map(
    latestJunctionEstimate?.contacts.map((contact) => [contact.legId, contact]) ?? [],
  );
  const contactsForPlan = runtime.legs.map((leg) => {
    const foot = contacts.get(leg.legId);
    return {
      legId: leg.legId,
      contactWorldPosition: leg.contactWorldPosition,
      reachOriginWorldPosition: leg.reachOriginWorldPosition,
      maximumReach: leg.reach.max * leg.reachScale,
      minimumReach: leg.reach.min * leg.reachScale,
      referenceUp: foot?.frame.normal,
      loaded: leg.loaded,
      valid: leg.valid,
      destinationSide: classifications.get(leg.legId)?.side === "destination",
      strandId: leg.address?.strandId,
    };
  });
  const desiredPosition = includeTranslation
    ? new THREE.Vector3(
        runtime.bodyWorldPosition.x,
        runtime.bodyWorldPosition.y,
        runtime.bodyWorldPosition.z,
      ).addScaledVector(
        translationDirection ?? direction,
        traversalPolicyConfig.orientation.maximumTranslationPerStep *
          THREE.MathUtils.clamp(translationScale, 0, 1),
      )
    : runtime.bodyWorldPosition;
  latestBodyOrientationPlan = bodyOrientationPlanner.plan({
    currentFrame: {
      position: runtime.bodyWorldPosition,
      forward: bodyPose.result.bodyForward,
      up: bodyPose.result.bodyUp,
      right: bodyPose.result.bodyRight,
    },
    routeDirection: direction,
    targetOrientationFrame:
      latestDestinationBranchFrame.valid &&
      (!context.progress.nonCoplanarTransition || establishedDestinationSupports > 0)
        ? latestDestinationBranchFrame.frame
        : undefined,
    contacts: contactsForPlan,
    desiredBodyPosition: desiredPosition,
  });
  if (latestBodyOrientationPlan.success && !includeTranslation) {
    frameQuaternion({
      forward: bodyPose.result.bodyForward,
      up: bodyPose.result.bodyUp,
    }, orientationStartQuaternion);
    frameQuaternion(latestBodyOrientationPlan.acceptedFrame, orientationTargetQuaternion);
    orientationEaseElapsedSeconds = 0;
    orientationEaseActive = false;
    orientationEaseStepIndex = context.nextStepIndex;
  }
  return latestBodyOrientationPlan;
}

function updateTraversalBodyOrientation(fixedDeltaSeconds: number): void {
  if (
    bodyCommitActive ||
    coupledTransfer?.isExecuting ||
    !bodyPose ||
    !latestBodyOrientationPlan.success
  ) return;
  const atomicState = stepController?.state;
  if (atomicState !== "body-advance" && !orientationEaseActive) return;
  if (!orientationEaseActive) {
    orientationEaseActive = true;
    orientationEaseElapsedSeconds = 0;
    frameQuaternion(
      traversalBodyFrameActive ? traversalBodyFrame : {
        forward: bodyPose.result.bodyForward,
        up: bodyPose.result.bodyUp,
      },
      orientationStartQuaternion,
    );
  }
  orientationEaseElapsedSeconds += fixedDeltaSeconds;
  const factor = smoothStep01(
    orientationEaseElapsedSeconds / Math.max(0.12, locomotionConfig.bodyAdvanceDuration),
  );
  orientationCurrentQuaternion.slerpQuaternions(
    orientationStartQuaternion,
    orientationTargetQuaternion,
    factor,
  );
  writeTraversalFrame(orientationCurrentQuaternion);
  if (factor >= 1 - 1e-6 || atomicState === "complete" || atomicState === "failed") {
    orientationEaseActive = false;
  }
}

function frameQuaternion(
  frame: { readonly forward: { readonly x: number; readonly y: number; readonly z: number }; readonly up: { readonly x: number; readonly y: number; readonly z: number } },
  target: THREE.Quaternion,
): THREE.Quaternion {
  const forward = scratchTip.set(frame.forward.x, frame.forward.y, frame.forward.z).normalize();
  const up = scratchFootHome.set(frame.up.x, frame.up.y, frame.up.z);
  up.addScaledVector(forward, -up.dot(forward)).normalize();
  const right = scratchReachOrigin.crossVectors(forward, up).normalize();
  const matrix = new THREE.Matrix4().makeBasis(right, up, scratchScale.copy(forward).negate());
  return target.setFromRotationMatrix(matrix).normalize();
}

function bodyFrameAngularError(
  current: { readonly forward: { readonly x: number; readonly y: number; readonly z: number }; readonly up: { readonly x: number; readonly y: number; readonly z: number } },
  target: { readonly forward: { readonly x: number; readonly y: number; readonly z: number }; readonly up: { readonly x: number; readonly y: number; readonly z: number } },
): number {
  const currentQuaternion = frameQuaternion(current, new THREE.Quaternion());
  const targetQuaternion = frameQuaternion(target, new THREE.Quaternion());
  return currentQuaternion.angleTo(targetQuaternion);
}

function writeTraversalFrame(quaternion: THREE.Quaternion): void {
  traversalBodyFrame.right.set(1, 0, 0).applyQuaternion(quaternion).normalize();
  traversalBodyFrame.up.set(0, 1, 0).applyQuaternion(quaternion).normalize();
  traversalBodyFrame.forward.set(0, 0, -1).applyQuaternion(quaternion).normalize();
  if (bodyPose) traversalBodyFrame.position.copy(bodyPose.result.anchorWorldPosition);
  traversalBodyFrameActive = true;
}

function getLiveBranchDirection(
  branchId: PhaseEightBranchId,
  target: THREE.Vector3,
): THREE.Vector3 {
  const branch = fixture.branches[branchId];
  const strand = traversal.getStrand(branch.routeStrandId);
  const junction = new THREE.Vector3();
  const sample = new THREE.Vector3();
  traversal.getNodePosition(fixture.junction.nodeId, junction);
  const junctionAtStart = strand?.startNode.id === fixture.junction.nodeId;
  traversal.getWorldPosition(
    { strandId: branch.routeStrandId, t: junctionAtStart ? 0.14 : 0.86 },
    sample,
  );
  return target.copy(sample).sub(junction).normalize();
}

function addressIsOnDestinationSide(
  address: StrandAddress,
  worldPosition: { readonly x: number; readonly y: number; readonly z: number },
): boolean {
  if (!activeTraversalBranch) return false;
  const branch = fixture.branches[activeTraversalBranch];
  if (!branch.supportStrandIds.includes(address.strandId)) return false;
  const junction = new THREE.Vector3();
  traversal.getNodePosition(fixture.junction.nodeId, junction);
  const direction = getLiveBranchDirection(activeTraversalBranch, scratchScale);
  return (
    (worldPosition.x - junction.x) * direction.x +
    (worldPosition.y - junction.y) * direction.y +
    (worldPosition.z - junction.z) * direction.z
  ) >= traversalPolicyConfig.junction.minimumDestinationSideMaterialDistance;
}

function transitionCandidateObjectiveIsActive(): boolean {
  return Boolean(
    traversalCoordinator?.isActive &&
    latestTransitionStrategyDirective.strategy !== "ordinary-traverse" &&
    latestTransitionStrategyDirective.contactGoal !== "route-progress",
  );
}

function transitionCandidateObjectiveAllowsGenericFallback(): boolean {
  return transitionCandidateObjectiveIsActive() &&
    latestTransitionStrategyDirective.contactGoal === "new-plane" &&
    latestTransitionStrategyDirective.bodyGoal !== "hold";
}

const phaseEightCandidateObjective: FootholdCandidateObjective = (
  leg,
  currentContact,
  candidate,
) => {
  if (
    latestTransitionStrategyDirective.contactGoal === "trailing-relief" &&
    transitionReachReliefNeedsSupportBuild()
  ) {
    return candidateBuildsReachReliefSupport(
      leg.legId,
      candidate.worldPosition,
      candidate.reachRatio,
    );
  }
  let worstLoadedReachRatio = 0;
  for (const runtimeLeg of runtimeLegs) {
    if (
      runtimeLeg.planted &&
      runtimeLeg.loaded &&
      runtimeLeg.valid &&
      Number.isFinite(runtimeLeg.currentReachRatio)
    ) {
      worstLoadedReachRatio = Math.max(
        worstLoadedReachRatio,
        runtimeLeg.currentReachRatio,
      );
    }
  }
  return transitionContactGoalSatisfied(
    currentContact.address,
    currentContact.worldPosition,
    currentContact.reachRatio,
    candidate.address,
    candidate.worldPosition,
    candidate.reachRatio,
    Math.max(worstLoadedReachRatio, leg.currentReachRatio),
  );
};

function transitionReachLimitingLegIds(): SpiderLegId[] {
  let worstReachRatio = Number.NEGATIVE_INFINITY;
  for (const leg of runtimeLegs) {
    if (
      leg.planted &&
      leg.loaded &&
      leg.valid &&
      Number.isFinite(leg.currentReachRatio)
    ) {
      worstReachRatio = Math.max(worstReachRatio, leg.currentReachRatio);
    }
  }
  if (!Number.isFinite(worstReachRatio)) return [];
  return runtimeLegs
    .filter((leg) =>
      leg.planted &&
      leg.loaded &&
      leg.valid &&
      Number.isFinite(leg.currentReachRatio) &&
      leg.currentReachRatio >= worstReachRatio - 1e-4
    )
    .map((leg) => leg.legId);
}

function transitionReachReliefNeedsSupportBuild(): boolean {
  const limitingLegIds = transitionReachLimitingLegIds();
  return limitingLegIds.length > 0 &&
    !limitingLegIds.some((legId) => liftableNextLegIds.has(legId));
}

function candidateBuildsReachReliefSupport(
  movingLegId: SpiderLegId,
  candidateWorldPosition: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
  candidateReachRatio: number,
): boolean {
  const runtime = getRuntimeContext();
  return transitionReachLimitingLegIds().some((limitingLegId) => {
    if (limitingLegId === movingLegId) return false;
    const estimate = evaluateCoupledSupport(
      runtime.bodyWorldPosition,
      false,
      undefined,
      limitingLegId,
      {
        legId: movingLegId,
        worldPosition: candidateWorldPosition,
        loadFactor: 1,
        valid: true,
        reachValid:
          Number.isFinite(candidateReachRatio) &&
          candidateReachRatio <= phaseEightRuntimeReachTolerance,
      },
    );
    return estimate.classification === "hard-valid" &&
      estimate.effectiveSupportCount + 1e-6 >=
        locomotionConfig.minimumSupportFootCount;
  });
}

function transitionContactGoalSatisfied(
  currentAddress: StrandAddress,
  currentWorldPosition: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
  currentReachRatio: number,
  candidateAddress: StrandAddress,
  candidateWorldPosition: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
  candidateReachRatio: number,
  worstReachRatioBefore: number,
): boolean {
  const directive = latestTransitionStrategyDirective;
  if (directive.contactGoal === "route-progress") return true;
  if (
    directive.contactGoal === "trailing-relief" &&
    transitionReachReliefNeedsSupportBuild()
  ) {
    // Candidate selection already required this foothold to make a limiting
    // contact removable under the full hard support estimate. The secured
    // support-building foothold itself completes this held-body stage.
    return true;
  }

  const currentWasDestination = addressIsOnDestinationSide(
    currentAddress,
    currentWorldPosition,
  );
  const candidateIsDestination = addressIsOnDestinationSide(
    candidateAddress,
    candidateWorldPosition,
  );
  const migratedToDestination = !currentWasDestination && candidateIsDestination;
  if (directive.contactGoal === "new-plane") return migratedToDestination;
  if (migratedToDestination) return true;

  const limitingContact =
    Number.isFinite(currentReachRatio) &&
    Number.isFinite(worstReachRatioBefore) &&
    currentReachRatio >= worstReachRatioBefore - 1e-4;
  return limitingContact &&
    Number.isFinite(candidateReachRatio) &&
    currentReachRatio - candidateReachRatio > 1e-5;
}

function validatePhaseEightCandidate(legId: SpiderLegId, address: StrandAddress) {
  if (traversalCoordinator?.isActive && activeTraversalBranch) {
    if (!liftableNextLegIds.has(legId)) {
      return {
        valid: false,
        reason: "This leg is not yet removable under the hard Phase 7 support estimate.",
      };
    }
    if (recoveryExcludedLegIds.has(legId)) {
      return {
        valid: false,
        reason: "This leg already failed in the current bounded recovery series; try a distinct secure alternative.",
      };
    }
    const recoveryStrand = traversal.getStrand(address.strandId);
    if (
      recoveryStrand &&
      isRecoveryFootholdExcluded(recoveryExcludedFootholds, {
        legId,
        address,
        strandTotalRestLength: recoveryStrand.totalRestLength,
        materialRadius: phaseEightRecoveryFootholdExclusionMaterialRadius,
      })
    ) {
      return {
        valid: false,
        reason: "This continuous foothold is inside a material neighborhood that already failed in the current bounded reach-recovery series; try another address for the urgent leg.",
      };
    }
    const branch = fixture.branches[activeTraversalBranch];
    const allowed = new Set<string>([
      ...fixture.strandIds.approachRegion,
      ...branch.supportStrandIds,
      ...fixture.strandIds.weakOrMoving,
    ]);
    if (!allowed.has(address.strandId)) {
      return {
        valid: false,
        reason: address.strandId === fixture.strandIds.falseCrossing
          ? "Projection-only crossing is not an explicit route branch."
          : "Candidate belongs to the non-selected real branch.",
      };
    }
    if (
      fixture.strandIds.weakOrMoving.includes(address.strandId) &&
      phase8FaultMode !== "missing-contact"
    ) {
      return {
        valid: false,
        reason: "Weak optional silk is reserved for bounded recovery while stable route support exists.",
      };
    }
    const candidatePosition = new THREE.Vector3();
    traversal.getWorldPosition(address, candidatePosition);
    const currentFoot = contacts.get(legId);
    const sameStrandMaterialDistance =
      currentFoot?.address &&
      currentFoot.address.strandId === address.strandId &&
      recoveryStrand
        ? Math.abs(currentFoot.address.t - address.t) *
          recoveryStrand.totalRestLength
        : Infinity;
    if (
      currentFoot?.address &&
      currentFoot.address.strandId === address.strandId &&
      sameStrandMaterialDistance <= 0.01 &&
      candidatePosition.distanceTo(
        new THREE.Vector3(
          currentFoot.worldPosition.x,
          currentFoot.worldPosition.y,
          currentFoot.worldPosition.z,
        ),
      ) <= 0.015
    ) {
      return {
        valid: false,
        reason: "Candidate does not materially reposition the current semantic contact.",
      };
    }

    const destinationCandidate =
      branch.supportStrandIds.includes(address.strandId) &&
      addressIsOnDestinationSide(address, candidatePosition);
    const directive = latestTransitionStrategyDirective;
    const stageTargetsNewPlane =
      directive.strategy !== "ordinary-traverse" &&
      directive.stage !== "resume-generic" &&
      directive.contactGoal === "new-plane";
    if (stageTargetsNewPlane && !destinationCandidate) {
      return {
        valid: false,
        reason:
          "The active transition stage requires a real destination-plane contact on the selected route.",
      };
    }
  }
  if (faultInjectionActive && phase8FaultMode === "missing-contact") {
    const fault = fixture.faultInjection.temporaryInvalidContact;
    if (
      address.strandId === fault.expectedAddress.strandId &&
      address.t >= fault.invalidInterval[0] &&
      address.t <= fault.invalidInterval[1]
    ) {
      return { valid: false, reason: "Scenario D temporarily invalidated this local interval." };
    }
  }
  if (faultInjectionActive && phase8FaultMode === "repeated-failure") {
    const blocked = fixture.faultInjection.repeatedFailure.blockedCandidateIntervals.some(
      (interval) =>
        interval.strandId === address.strandId &&
        address.t >= interval.minimumT &&
        address.t <= interval.maximumT,
    );
    if (blocked) {
      return { valid: false, reason: "Scenario E removed all safe forward candidates in this interval." };
    }
  }
  return { valid: true };
}

function updatePhaseEightFaults(): void {
  const coordinator = traversalCoordinator;
  if (!coordinator?.isActive) return;
  const completed = coordinator.diagnostics.completedStepCount;
  if (phase8FaultMode === "missing-contact") {
    const fault = fixture.faultInjection.temporaryInvalidContact;
    if (completed >= fault.injectAfterCompletedStepCount) {
      faultInjectionActive = true;
    }
  } else if (phase8FaultMode === "repeated-failure") {
    faultInjectionActive =
      completed >= fixture.faultInjection.repeatedFailure.injectAfterCompletedStepCount;
  }

  if (
    selectedTraversalScenario === "F" &&
    !cancellationInjected &&
    completed >= fixture.faultInjection.cancellation.injectAfterCompletedStepCount &&
    ((bodyCommitActive && bodyCommitElapsedSeconds > 0.08) ||
      stepController?.state === fixture.faultInjection.cancellation.fallbackAtomicState)
  ) {
    cancellationInjected = true;
    coordinator.cancelAndRestore();
  }
}

function distance3(
  left: { readonly x: number; readonly y: number; readonly z: number },
  right: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function smoothStep01(value: number): number {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
}

function applyExternalForces(fixedDelta: number): void {
  interaction.applyForces(solver, fixedDelta);
  stepController?.applyFixedStep(fixedDelta);
  if (loadDistributor) {
    const supportCenter = bodyPose?.frame.valid ? bodyPose.frame.center : undefined;
    loadDistributor.applyFixedStep(fixedDelta, supportCenter);
  }
}

function runFixedStep(): void {
  syncParameters();
  updatePhaseEightFaults();
  if (traversalCoordinator) {
    traversalCoordinator.update(FIXED_TIME_STEP);
  } else {
    stepController?.update(FIXED_TIME_STEP);
  }
  updateTraversalBodyOrientation(FIXED_TIME_STEP);
  solver.step(FIXED_TIME_STEP, applyExternalForces);
}

const panel = new LocomotionDebugPanel(debugRoot, locomotionConfig, {
  onIssueDestination: (scenario) => {
    issueScenario(scenario, "execute");
  },
  onPlanOnly: () => {
    issueScenario(panel.selectedScenario, "plan-only");
  },
  onExecutePlannedStep: () => {
    stepController?.executePlannedStep();
  },
  onCancelStep: () => {
    stepController?.cancel();
  },
  onResetFixture: rebuildFixture,
  onTogglePause: () => {
    paused = !paused;
    accumulator = 0;
    panel.setPaused(paused);
  },
  onSingleStep: () => {
    if (!paused) return;
    runFixedStep();
    updateSpiderRig();
    accumulator = 0;
  },
  onParameterChange: syncParameters,
});

const phase8Panel = new JunctionTraversalDebugPanel(
  traversalPolicyConfig,
  junctionDebugToggles,
  {
    onExecute: (scenario) => {
      issueTraversalScenario(scenario, "run-until-arrival");
    },
    onPauseAfterStep: () => traversalCoordinator?.pauseAfterCurrentStep(),
    onContinueOneStep: () => traversalCoordinator?.continueOneStep(),
    onRunUntilArrival: () => traversalCoordinator?.runUntilArrival(),
    onCancelAndRestore: () => traversalCoordinator?.cancelAndRestore(),
    onResetFixture: rebuildFixture,
    onParameterChange: syncParameters,
  },
);
panel.mountExtension(phase8Panel.element);
panel.setMilestoneHeading(
  "PHASE 08 / DELIBERATE JUNCTION TRAVERSE",
  "Secure transaction coordinator",
  "ONE REAL Y JUNCTION",
);

function updateSupportFrame(): void {
  if (!rig || !bodyPose) return;
  let nextSupportMembershipMask = 0;
  let supportWeightsChanged = false;
  for (let index = 0; index < SPIDER_LEG_IDS.length; index += 1) {
    const legId = SPIDER_LEG_IDS[index];
    const foot = contacts.get(legId);
    const sample = supportSamples[index];
    const address = foot?.address;
    const loadFactor = loadDistributor?.getFootLoadFactor(legId) ?? 0;
    supportWeightsChanged ||= Math.abs(loadFactor - previousSupportLoadFactors[legId]) > 1e-5;
    previousSupportLoadFactors[legId] = loadFactor;
    sample.weight = bodySupportWeights[legId] * loadFactor;
    sample.valid = Boolean(
      foot?.isPlanted &&
        address &&
        loadFactor > 1e-5 &&
        (foot.contactValid || !bodyPose.frame.valid),
    );
    if (!sample.valid || !address) continue;
    try {
      traversal.getWorldPosition(address, sample.worldPosition);
      sample.referenceUp.set(
        foot.frame.normal.x,
        foot.frame.normal.y,
        foot.frame.normal.z,
      );
      const continuityUp = traversalBodyFrameActive
        ? traversalBodyFrame.up
        : bodyPose.result.bodyUp;
      if (sample.referenceUp.dot(continuityUp) < 0) sample.referenceUp.negate();
      nextSupportMembershipMask |= 1 << index;
    } catch {
      sample.valid = false;
    }
  }

  const hadSupportFrame = bodyPose.frame.valid;
  supportPlacementBeforeUpdate
    .copy(bodyPose.frame.center)
    .addScaledVector(bodyPose.frame.up, spiderConfig.thoraxHeight)
    .addScaledVector(bodyPose.frame.right, spiderConfig.bodyOffsetX)
    .addScaledVector(bodyPose.frame.forward, spiderConfig.bodyOffsetZ);
  bodyPose.updateSupport(
    supportSamples as readonly SpiderSupportSample[],
    bodyPose.frame.valid
      ? { forward: traversalBodyFrameActive ? traversalBodyFrame.forward : bodyPose.result.bodyForward }
      : { forward: supportForward, up: supportUp },
  );
  if (
    supportMembershipInitialized &&
    hadSupportFrame &&
    bodyPose.frame.valid &&
    bodyPose.frame.supportCount > 0 &&
    (nextSupportMembershipMask !== supportMembershipMask || supportWeightsChanged)
  ) {
    // Load and membership changes redefine both the support center and axes.
    // Rebase the complete nominal placement used by SpiderBodyPose.apply so
    // the frame redefinition cannot create an unvalidated thorax translation.
    // Continuing deformation with unchanged membership/weights still carries
    // the body naturally.
    supportPlacementAfterUpdate
      .copy(bodyPose.frame.center)
      .addScaledVector(bodyPose.frame.up, spiderConfig.thoraxHeight)
      .addScaledVector(bodyPose.frame.right, spiderConfig.bodyOffsetX)
      .addScaledVector(bodyPose.frame.forward, spiderConfig.bodyOffsetZ);
    supportMembershipRebaseOffset
      .add(supportPlacementBeforeUpdate)
      .sub(supportPlacementAfterUpdate);
  }
  supportMembershipMask = nextSupportMembershipMask;
  supportMembershipInitialized = true;
  applyCurrentBodyPose();
  correctBodyCommitRestorationPosition();
}

function applyCurrentBodyPose(): void {
  if (!bodyPose) return;
  const advance = stepController?.bodyAdvanceOffset;
  bodyPose.apply({
    thoraxHeight: spiderConfig.thoraxHeight,
    worldOffset: {
      x: supportMembershipRebaseOffset.x + (advance?.x ?? 0) + bodyCommitOffset.x,
      y:
        spiderConfig.bodyOffsetY +
        supportMembershipRebaseOffset.y +
        (advance?.y ?? 0) +
        bodyCommitOffset.y,
      z: supportMembershipRebaseOffset.z + (advance?.z ?? 0) + bodyCommitOffset.z,
    },
    supportOffset: {
      x: spiderConfig.bodyOffsetX,
      y: 0,
      z: spiderConfig.bodyOffsetZ,
    },
    pitch: THREE.MathUtils.degToRad(spiderConfig.bodyPitchDegrees),
    yaw: THREE.MathUtils.degToRad(spiderConfig.bodyYawDegrees),
    roll: THREE.MathUtils.degToRad(spiderConfig.bodyRollDegrees),
    worldFrame: traversalBodyFrameActive ? traversalBodyFrame : undefined,
  });
}

function correctBodyCommitRestorationPosition(): void {
  if (bodyCommitRestorationAwaitingIkVersion === null || !bodyPose) return;
  const observed = bodyPose.result.anchorWorldPosition;
  const deltaX = bodyCommitStartWorldPosition.x - observed.x;
  const deltaY = bodyCommitStartWorldPosition.y - observed.y;
  const deltaZ = bodyCommitStartWorldPosition.z - observed.z;
  if (![deltaX, deltaY, deltaZ].every(Number.isFinite)) return;
  if (Math.hypot(deltaX, deltaY, deltaZ) <= 1e-8) return;

  // Support membership/load restoration can redefine the nominal support
  // center after the body offset snapshot has already been restored. Preserve
  // the transaction's world-space anchor, not that transient coordinate
  // decomposition, then publish IK from this corrected pose below.
  bodyCommitOffset.x += deltaX;
  bodyCommitOffset.y += deltaY;
  bodyCommitOffset.z += deltaZ;
  applyCurrentBodyPose();
}

function applyMovingFootOrientation(legId: SpiderLegId): void {
  if (!rig || !stepController) return;
  const policy = footOrientationPolicies.get(legId);
  if (!policy) return;
  const result = policy.resolve(stepController.targetFrame);
  footOrientationResults.set(legId, result);
  if (!result.valid) return;

  const tip = rig.legs[legId].footTip;
  scratchWorldQuaternion.set(
    result.quaternion.x,
    result.quaternion.y,
    result.quaternion.z,
    result.quaternion.w,
  );
  if (tip.parent) {
    tip.parent.getWorldQuaternion(scratchParentQuaternion).invert();
    tip.quaternion.copy(scratchParentQuaternion.multiply(scratchWorldQuaternion)).normalize();
  } else {
    tip.quaternion.copy(scratchWorldQuaternion).normalize();
  }
  tip.updateWorldMatrix(false, true);
}

function applyFootWorldOrientation(legId: SpiderLegId, worldOrientation: THREE.Quaternion): void {
  if (!rig) return;
  const tip = rig.legs[legId].footTip;
  if (tip.parent) {
    tip.parent.getWorldQuaternion(scratchParentQuaternion).invert();
    tip.quaternion.copy(scratchParentQuaternion.multiply(worldOrientation)).normalize();
  } else {
    tip.quaternion.copy(worldOrientation).normalize();
  }
  tip.updateWorldMatrix(false, true);
}

function updateSpiderRig(): void {
  if (!rig || !bodyPose || !ikSolver) return;

  updateSupportFrame();
  rig.rootObject.updateWorldMatrix(true, true);
  rig.rootObject.getWorldScale(scratchScale);
  currentRigScale = Math.max(
    Math.abs(scratchScale.x),
    Math.abs(scratchScale.y),
    Math.abs(scratchScale.z),
  );

  const activeMovingLeg = stepController?.hasMovingFootTarget
    ? stepController.movingLegId
    : null;
  let restoreOrientationLeg: SpiderLegId | null = null;
  if (activeMovingLeg !== orientationMovingLeg) {
    if (activeMovingLeg) {
      const tip = rig.legs[activeMovingLeg].footTip;
      tip.getWorldQuaternion(originalMovingFootWorldQuaternion);
      hasOriginalMovingFootOrientation = footOrientationPolicies
        .get(activeMovingLeg)
        ?.seedWorldOrientation(originalMovingFootWorldQuaternion) ?? false;
    } else if (
      orientationMovingLeg &&
      stepController?.state === "failed" &&
      hasOriginalMovingFootOrientation
    ) {
      restoreOrientationLeg = orientationMovingLeg;
    }
    orientationMovingLeg = activeMovingLeg;
  }

  for (const legId of SPIDER_LEG_IDS) {
    const leg = rig.legs[legId];
    const foot = contacts.get(legId);
    if (!foot) continue;
    leg.footHome.getWorldPosition(scratchFootHome);
    leg.chain[0].getWorldPosition(scratchReachOrigin);
    const valid = foot.update(traversal, {
      footHomeWorldPosition: scratchFootHome,
      reachOriginWorldPosition: scratchReachOrigin,
      reachScale: currentRigScale,
      minimumReachScale: phase8MinimumReachScale,
      referenceUp: bodyPose.result.bodyUp,
    });
    invalidContactFrameStreak[legId] = foot.isPlanted && !valid
      ? invalidContactFrameStreak[legId] + 1
      : 0;
    const controller = stepController;
    const isMoving = activeMovingLeg === legId && controller?.hasMovingFootTarget;
    const target = isMoving ? controller!.movingFootTarget : foot.worldPosition;
    if ((!valid && !isMoving) || (!foot.isPlanted && !isMoving)) {
      ikResults.delete(legId);
      const debugResult = ikDebugResults.get(legId);
      if (debugResult) {
        (debugResult as { error: number }).error = 0;
        (debugResult as { reached: boolean }).reached = false;
        (debugResult as { finite: boolean }).finite = valid;
      }
      continue;
    }

    const result = ikSolver.solve(legId, target, {
      maxIterations: 24,
      tolerance: 0.001,
      bendBias: 0.5,
      enforceJointLimits: false,
    });
    ikResults.set(legId, result);
    const finite = result.targetValid && result.status !== "non-finite-result";
    const debugResult = ikDebugResults.get(legId);
    if (debugResult) {
      (debugResult as { error: number }).error = result.residual;
      (debugResult as { reached: boolean }).reached = result.reached;
      (debugResult as { finite: boolean }).finite = finite;
    }
    if (isMoving && stepController) {
      stepController.reportMovingFootIk({
        finite,
        reached: result.reached,
        residual: result.residual,
      });
      applyMovingFootOrientation(legId);
    }
  }

  ikSolveVersion += 1;
  if (restoreOrientationLeg) {
    applyFootWorldOrientation(restoreOrientationLeg, originalMovingFootWorldQuaternion);
    footOrientationPolicies.get(restoreOrientationLeg)?.reset();
  }
  if (!activeMovingLeg) hasOriginalMovingFootOrientation = false;

  rig.rootObject.updateWorldMatrix(true, true);
  debugSnapshot.supportCenter.copy(bodyPose.frame.center);
  debugSnapshot.bodyForward.copy(bodyPose.result.bodyForward);
  debugSnapshot.bodyUp.copy(bodyPose.result.bodyUp);
  (debugSnapshot as { rigScale: number }).rigScale = currentRigScale;
  spiderDebugRenderer.update(debugSnapshot);
  updateLocomotionDebugSnapshot();
  updateJunctionDebugSnapshot();
}

function getRuntimeContext(): SpiderStepRuntimeContext {
  if (!rig || !bodyPose) return runtimeContext;
  (runtimeContext as { ikSolveVersion: number }).ikSolveVersion = ikSolveVersion;
  rig.rootObject.updateWorldMatrix(true, true);
  bodyPose.result.anchorWorldPosition &&
    (runtimeContext.bodyWorldPosition as THREE.Vector3).copy(bodyPose.result.anchorWorldPosition);
  (runtimeContext.supportFrame.center as THREE.Vector3).copy(bodyPose.frame.center);
  (runtimeContext.supportFrame.forward as THREE.Vector3).copy(bodyPose.result.bodyForward);
  (runtimeContext.supportFrame.up as THREE.Vector3).copy(bodyPose.result.bodyUp);
  (runtimeContext.supportFrame.right as THREE.Vector3).copy(bodyPose.result.bodyRight);

  for (let index = 0; index < SPIDER_LEG_IDS.length; index += 1) {
    const legId = SPIDER_LEG_IDS[index];
    const runtimeLeg = runtimeLegs[index] as MutableRuntimeLeg;
    const leg = rig.legs[legId];
    const foot = contacts.get(legId);
    leg.footHome.getWorldPosition(runtimeLeg.footHomeWorldPosition as THREE.Vector3);
    leg.chain[0].getWorldPosition(runtimeLeg.reachOriginWorldPosition as THREE.Vector3);
    if (foot?.hasResolvedWorldPosition) {
      (runtimeLeg.contactWorldPosition as THREE.Vector3).set(
        foot.worldPosition.x,
        foot.worldPosition.y,
        foot.worldPosition.z,
      );
    }
    runtimeLeg.address = foot?.address ?? null;
    runtimeLeg.reach = foot?.reach ?? leg.reach;
    runtimeLeg.reachScale = currentRigScale;
    runtimeLeg.planted = foot?.isPlanted ?? false;
    const loadFactor = loadDistributor?.getFootLoadFactor(legId) ?? 0;
    runtimeLeg.loadFactor = loadFactor;
    runtimeLeg.loaded = Boolean(foot?.isPlanted && foot.contactValid && loadFactor > 1e-5);
    runtimeLeg.valid = foot?.contactValid ?? false;
    runtimeLeg.currentReachRatio = foot?.currentReachRatio ?? Infinity;
    const ikResult = ikResults.get(legId);
    runtimeLeg.ikFinite = Boolean(
      ikResult &&
        ikResult.targetValid &&
        Number.isFinite(ikResult.residual) &&
        ikResult.status !== "invalid-chain" &&
        ikResult.status !== "invalid-target" &&
        ikResult.status !== "non-finite-result",
    );
    runtimeLeg.ikReached = ikResult?.reached ?? false;
    runtimeLeg.ikResidual = ikResult?.residual ?? Infinity;
  }
  return runtimeContext;
}

interface MutableRuntimeLeg extends SpiderStepRuntimeLeg {
  address: StrandAddress | null;
  reach: SpiderStepRuntimeLeg["reach"];
  reachScale: number;
  planted: boolean;
  loaded: boolean;
  loadFactor: number;
  valid: boolean;
  currentReachRatio: number;
  ikFinite: boolean;
  ikReached: boolean;
  ikResidual: number;
}

function toIkLimit(limit: SpiderJointLimitSpec) {
  return {
    bendX: { min: limit.bend_x[0], max: limit.bend_x[1] },
    twistY: { min: limit.twist_y[0], max: limit.twist_y[1] },
    swingZ: { min: limit.swing_z[0], max: limit.swing_z[1] },
    unit: "degrees" as const,
  };
}

async function initializeSpiderRig(): Promise<void> {
  panel.setRigStatus("pending", "LOCOMOTION / LOADING VALIDATED GLB + SPEC");
  try {
    const loadedRig = await loadSpiderRig();
    rig = loadedRig;
    rig.mesh.frustumCulled = false;
    scene.add(rig.rootObject);

    const createdContacts = createBlackWidowFootContacts(rig.spec.reach_units.per_leg);
    for (const [legId, foot] of createdContacts) contacts.set(legId, foot);

    const ikDefinitions: SpiderIKChainDefinition[] = SPIDER_LEG_IDS.map((legId) => {
      const leg = rig!.legs[legId];
      return {
        id: legId,
        bones: leg.chain,
        reach: {
          minimum: leg.reach.min,
          comfortable: leg.reach.comfortable,
          maximum: leg.reach.max,
        },
        jointLimits: leg.jointLimits.map(toIkLimit),
      };
    });
    ikSolver = new SpiderIKSolver(ikDefinitions, {
      maxIterations: 24,
      tolerance: 0.001,
      bendBias: 0.5,
      enforceJointLimits: false,
    });
    jointFeasibilityProbe = new JointLimitFeasibilityProbe(ikDefinitions, {
      maxIterations: 24,
      tolerance: 0.001,
      bendBias: 0.5,
    });
    for (const legId of SPIDER_LEG_IDS) {
      ikDebugResults.set(legId, { error: 0, reached: false, finite: true });
      footOrientationPolicies.set(
        legId,
        new FootOrientationPolicy(
          { localAlongAxis: { x: 0, y: 1, z: 0 }, localReferenceAxis: { x: 0, y: 0, z: 1 } },
          {
            referenceDirection: "normal",
            tangentSign: legId.startsWith("L") ? 1 : -1,
            referenceSign: 1,
            maximumAngularStepRadians: 0.22,
          },
        ),
      );
    }

    bodyPose = new SpiderBodyPose({
      root: rig.rootObject,
      anchor: rig.references.bodyCenter,
      modelForward: rig.axes.forward,
      modelUp: rig.axes.up,
    });
    supportForward.copy(rig.axes.forward);
    supportUp.copy(rig.axes.up);
    loadDistributor = new SpiderLoadDistributor(network, contacts.values())
      .setTotalWeight(spiderConfig.totalWeight)
      .setMode(spiderConfig.loadMode);
    createStepController();

    const allBones: THREE.Bone[] = [];
    rig.assetRoot.traverse((object) => {
      if (object instanceof THREE.Bone) allBones.push(object);
    });
    const report = rig.validationReport;
    spiderDebugRenderer.setRig(
      rig.rootObject,
      allBones,
      SPIDER_LEG_IDS.map((legId) => ({
        id: legId,
        bones: rig!.legs[legId].chain,
        footTip: rig!.legs[legId].footTip,
        footHome: rig!.legs[legId].footHome,
      })),
      `${report.resolvedRequiredBoneCount}/${report.requiredBoneCount} exact required bones · ${report.discoveredBoneCount} total bones`,
    );

    rigStatus = "READY";
    rigNames = `${report.resolvedRequiredBoneCount}/${report.requiredBoneCount} EXACT`;
    panel.setRigStatus(
      "valid",
      `LOCOMOTION READY / ${report.resolvedRequiredBoneCount}/${report.requiredBoneCount} EXACT BONE NAMES`,
    );
    resetStablePose(false);
  } catch (error) {
    rigLoadError = error instanceof Error ? error.message : String(error);
    rigStatus = "ERROR";
    rigNames = "FAILED";
    panel.setRigStatus("error", `RIG ERROR / ${rigLoadError}`);
    spiderDebugRenderer.showRigError(rigLoadError);
    console.error("Phase 7 spider rig failed to load or validate.", error);
  }
}

function updateLocomotionDebugSnapshot(): void {
  const controller = stepController;
  const diagnostics = controller?.diagnostics;
  const runtime = getRuntimeContext();
  const selectionDiagnostics = new Map(
    diagnostics?.legSelection?.diagnostics.map((entry) => [entry.legId, entry]) ?? [],
  );
  const selected = diagnostics?.selectedPlan ?? null;
  const movingLegId = controller?.movingLegId ?? null;
  const movingLeg = movingLegId ? rig?.legs[movingLegId] : null;
  if (movingLeg) movingLeg.footTip.getWorldPosition(scratchTip);

  locomotionDebugSnapshot.destination = diagnostics?.intent
    ? {
        position: diagnostics.intent.destinationPosition,
        label: destinationLabel(diagnostics.requestedDestination),
      }
    : null;
  locomotionDebugSnapshot.travelOrigin = diagnostics?.intent?.originPosition ?? null;
  locomotionDebugSnapshot.travelDirection = diagnostics?.intent?.desiredDirection ?? null;
  locomotionDebugSnapshot.candidates = diagnostics?.generation?.candidates ?? [];
  locomotionDebugSnapshot.winner = selected?.candidate ?? null;
  locomotionDebugSnapshot.legs = runtime.legs.map((leg) => {
    const entry = selectionDiagnostics.get(leg.legId);
    return {
      legId: leg.legId,
      position: leg.contactWorldPosition,
      eligible: entry?.eligible ?? false,
      reasons: entry?.reasons ?? [],
    };
  });
  locomotionDebugSnapshot.state = diagnostics?.state ?? "idle";
  locomotionDebugSnapshot.stateElapsedSeconds = diagnostics?.stateElapsedSeconds ?? 0;
  locomotionDebugSnapshot.failureReason = diagnostics?.failureReason ?? "none";
  locomotionDebugSnapshot.failureMessage = diagnostics?.failureMessage ?? "";
  locomotionDebugSnapshot.movingFoot =
    controller?.hasMovingFootTarget && movingLegId
      ? {
          legId: movingLegId,
          currentPosition: scratchTip,
          targetPosition: controller.movingFootTarget,
        }
      : null;
  locomotionDebugSnapshot.swingCurve = controller?.swingCurve ?? [];
  locomotionDebugSnapshot.supports = runtime.legs.map((leg) => ({
    legId: leg.legId,
    position: leg.contactWorldPosition,
    loaded: leg.loaded,
    valid: leg.valid,
  }));
  locomotionDebugSnapshot.supportCenter = bodyPose?.frame.center ?? null;
  locomotionDebugSnapshot.supportPolygon = supportPolygon(runtime);
  locomotionDebugSnapshot.probe =
    diagnostics?.state === "testing" && diagnostics.probe.address
      ? { origin: diagnostics.probe.position, force: diagnostics.probe.force }
      : null;
  locomotionDebugSnapshot.loadTransfer =
    diagnostics && selected && ["planting", "loading"].includes(diagnostics.state)
      ? {
          legId: selected.legId,
          position: controller!.targetWorldPosition,
          factor: diagnostics.loadTransfer,
        }
      : null;
  const bodyPlan = diagnostics?.bodyAdvancePlan;
  locomotionDebugSnapshot.bodyAdvance = bodyPlan
    ? {
        origin: {
          x: bodyPlan.targetBodyPosition.x - bodyPlan.displacement.x,
          y: bodyPlan.targetBodyPosition.y - bodyPlan.displacement.y,
          z: bodyPlan.targetBodyPosition.z - bodyPlan.displacement.z,
        },
        vector: bodyPlan.displacement,
      }
    : null;
  locomotionDebugRenderer.update(locomotionDebugSnapshot);
}

function updateJunctionDebugSnapshot(): void {
  const coordinator = traversalCoordinator;
  const diagnostics = coordinator?.diagnostics;
  const runtime = getRuntimeContext();
  const estimateByLeg = new Map(
    latestJunctionEstimate?.contacts.map((contact) => [contact.legId, contact]) ?? [],
  );
  const liveJunction = new THREE.Vector3();
  try {
    traversal.getNodePosition(fixture.junction.nodeId, liveJunction);
  } catch {
    liveJunction.set(0, 0, 0);
  }
  const recoveryCandidates: JunctionDebugCandidate[] = latestRecoveryCandidates.map(
    (candidate) => ({
      position: candidate.worldPosition,
      accepted: candidate.accepted,
      label: `${candidate.address.strandId}@${candidate.address.t.toFixed(3)}`,
    }),
  );
  const plannedReach = new Map(
    latestBodyOrientationPlan.predictedReaches.map((reach) => [reach.legId, reach]),
  );
  const branch = activeTraversalBranch ? fixture.branches[activeTraversalBranch] : null;
  junctionDebugSnapshot = {
    fullRoute: fullTraversalRoute,
    currentRoute: diagnostics?.currentRoute ?? null,
    nextTransition: diagnostics?.nextRouteTransition ?? null,
    junctionPosition: liveJunction,
    destinationBranchStrandId: branch?.routeStrandId ?? null,
    stepNumber: diagnostics?.completedStepCount ?? 0,
    state: diagnostics?.state ?? "idle",
    movedLegHistory: diagnostics?.steps
      .map((step) => step.movedLegId)
      .filter((legId): legId is SpiderLegId => legId !== null) ?? [],
    contacts: runtime.legs.map((leg) => ({
      legId: leg.legId,
      position: leg.contactWorldPosition,
      side: estimateByLeg.get(leg.legId)?.side ?? "off-route",
      loaded: leg.loaded,
    })),
    destinationSideCount:
      latestJunctionEstimate?.destinationSideLoadedCount ?? 0,
    destinationSideRequired:
      branch?.minimumDestinationSideContacts ??
      traversalPolicyConfig.junction.destinationSideSupportThreshold,
    mayCommitBody: latestJunctionEstimate?.mayCommitBody ?? false,
    proposedBodyFrame: latestBodyOrientationPlan.success
      ? latestBodyOrientationPlan.proposedFrame
      : null,
    acceptedBodyFrame: latestBodyOrientationPlan.success
      ? latestBodyOrientationPlan.acceptedFrame
      : null,
    predictedReaches: runtime.legs.flatMap((leg) => {
      const prediction = plannedReach.get(leg.legId);
      return prediction
        ? [{
            legId: leg.legId,
            origin: leg.reachOriginWorldPosition,
            contact: leg.contactWorldPosition,
            ratio: prediction.ratio,
            withinLimits: prediction.withinLimits,
          }]
        : [];
    }),
    explorationCandidates: latestExplorationCandidates,
    recoveryCandidates,
    bodyPosition: bodyPose?.result.anchorWorldPosition ?? null,
    bodyCenterProgress: diagnostics?.progress?.bodyCenterProgress ?? 0,
    stopReason: diagnostics?.stopReason ?? "none",
    stopMessage: diagnostics?.stopMessage ?? "",
  };
  junctionDebugRenderer.update(junctionDebugSnapshot);
}

function supportPolygon(runtime: SpiderStepRuntimeContext): readonly THREE.Vector3[] {
  const center = runtime.supportFrame.center;
  const right = runtime.supportFrame.right;
  const forward = runtime.supportFrame.forward;
  return runtime.legs
    .filter((leg) => leg.planted && leg.loaded && leg.valid)
    .map((leg) => ({
      position: new THREE.Vector3(
        leg.contactWorldPosition.x,
        leg.contactWorldPosition.y,
        leg.contactWorldPosition.z,
      ),
      angle: Math.atan2(
        (leg.contactWorldPosition.x - center.x) * forward.x +
          (leg.contactWorldPosition.y - center.y) * forward.y +
          (leg.contactWorldPosition.z - center.z) * forward.z,
        (leg.contactWorldPosition.x - center.x) * right.x +
          (leg.contactWorldPosition.y - center.y) * right.y +
          (leg.contactWorldPosition.z - center.z) * right.z,
      ),
    }))
    .sort((left, rightEntry) => left.angle - rightEntry.angle)
    .map((entry) => entry.position);
}

function destinationLabel(destination: RouteDestination | null | undefined): string {
  if (!destination) return "none";
  if (destination.kind === "address") {
    return `${destination.address.strandId}@${destination.address.t.toFixed(3)}`;
  }
  if (destination.kind === "node") return destination.nodeId;
  return `world (${destination.position.x.toFixed(2)}, ${destination.position.y.toFixed(2)}, ${destination.position.z.toFixed(2)})`;
}

settleCurrentNetwork();
webRenderer.setNetwork(network);
interaction.setNetwork(network);
syncParameters();
void initializeSpiderRig();

function resize(): void {
  const width = Math.max(1, canvas.clientWidth);
  const height = Math.max(1, canvas.clientHeight);
  const aspect = width / height;
  const compact = width <= 900;
  const portrait = aspect < 0.8;
  const distance = portrait ? 7.1 : compact ? 6.2 : 5.35;
  cameraTarget.set(portrait ? -0.25 : -0.4, portrait ? -0.18 : -0.08, -0.12);
  camera.position.copy(cameraTarget).addScaledVector(cameraDirection, distance);
  camera.aspect = aspect;
  camera.lookAt(cameraTarget);
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
}

const resizeObserver = new ResizeObserver(resize);
resizeObserver.observe(canvas);
resize();

let previousTime = performance.now();
let smoothedFps = 60;
let lastMetricsUpdate = 0;

function maximumWebStretch(): number {
  let maximum = 0;
  for (const strand of network.strandList) maximum = Math.max(maximum, strand.maximumStretch);
  return maximum;
}

function updatePanelMetrics(): void {
  const diagnostics = stepController?.diagnostics;
  const generation = diagnostics?.generation;
  const selection = diagnostics?.selectedPlan;
  const runtime = getRuntimeContext();
  const supportCount = runtime.legs.filter((leg) => leg.loaded && leg.planted && leg.valid).length;
  const probeMagnitude = diagnostics?.state === "testing"
    ? Math.hypot(
        diagnostics.probe.force.x,
        diagnostics.probe.force.y,
        diagnostics.probe.force.z,
      )
    : null;
  panel.updateMetrics({
    fps: smoothedFps,
    stepState: diagnostics?.state ?? "idle",
    stateElapsedSeconds: diagnostics?.stateElapsedSeconds ?? 0,
    destination: destinationLabel(diagnostics?.requestedDestination),
    routeSummary: diagnostics?.intent
      ? `${diagnostics.intent.route.strandIds.join(" > ")} / ${diagnostics.intent.routeDistance.toFixed(2)}u`
      : "none",
    candidateCount: generation?.candidates.length ?? 0,
    acceptedCandidateCount: generation?.accepted.length ?? 0,
    rejectedCandidateCount: generation?.rejected.length ?? 0,
    eligibleLegCount: diagnostics?.legSelection?.diagnostics.filter((leg) => leg.eligible).length ?? 0,
    movingLeg: diagnostics?.movingLegId ?? null,
    winnerAddress: selection
      ? `${selection.candidate.strandId}@${selection.candidate.t.toFixed(3)}`
      : "none",
    winnerScore: selection?.candidate.score.total ?? null,
    supportFootCount: supportCount,
    probeForceNewtons: probeMagnitude,
    loadTransferFactor: diagnostics && ["planting", "loading"].includes(diagnostics.state)
      ? diagnostics.loadTransfer
      : null,
    bodyAdvanceDistance: diagnostics?.bodyAdvancePlan?.plannedDistance ?? 0,
    failureReason: diagnostics?.failureReason ?? "none",
    failureMessage: diagnostics?.failureMessage ?? "",
    paused,
    planReady: diagnostics?.state === "planning" && Boolean(selection),
  });
  debugRoot.dataset.phase7Ready = String(rigStatus === "READY");
  debugRoot.dataset.phase7Diagnostics = JSON.stringify(diagnosticsSnapshot(false));
  updatePhaseEightPanelMetrics();
  debugRoot.dataset.phase8Ready = String(rigStatus === "READY");
  debugRoot.dataset.phase8Diagnostics = JSON.stringify(phase8DiagnosticsSnapshot(false));
}

function updatePhaseEightPanelMetrics(): void {
  const diagnostics = traversalCoordinator?.diagnostics;
  const progress = diagnostics?.progress;
  const orientation = latestBodyOrientationPlan;
  const coupled = coupledTransfer?.coupledDiagnostics;
  const motion = coupled?.bodyMotion;
  const selectedInfluence = stepController?.diagnostics.selectedPlan
    ? latestHistoryInfluences.find(
        (entry) => entry.legId === stepController?.diagnostics.selectedPlan?.legId,
      )
    : undefined;
  const strongestComponent = selectedInfluence
    ? Object.values(selectedInfluence.components)
        .slice()
        .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution))[0]
    : undefined;
  const metrics: JunctionTraversalPanelMetrics = {
    state: diagnostics?.state ?? "idle",
    atomicState: stepController?.state ?? "idle",
    runMode: diagnostics?.runMode ?? "pause-after-step",
    pausedAfterStep: diagnostics?.pausedAfterStep ?? false,
    stepNumber: diagnostics?.completedStepCount ?? 0,
    maximumStepCount:
      traversalCoordinator?.config.maximumStepCount ??
      traversalPolicyConfig.scheduler.maximumStepCount,
    routeSummary: diagnostics?.currentRoute
      ? `${diagnostics.currentRoute.strandIds.join(" > ")} / ${diagnostics.currentRoute.materialDistance.toFixed(2)}u`
      : "none",
    nextTransition: diagnostics?.nextRouteTransition
      ? `${diagnostics.nextRouteTransition.fromStrandId} > ${diagnostics.nextRouteTransition.toStrandId}`
      : "none",
    selectedBranch: diagnostics?.selectedBranchStrandId ?? "none",
    destinationSideSupports:
      progress?.destinationSideLoadedContactCount ?? 0,
    destinationSideRequired:
      traversalCoordinator?.config.minimumDestinationSideSupports ??
      traversalPolicyConfig.junction.destinationSideSupportThreshold,
    destinationSideSpread: progress?.destinationSideSpread ?? 0,
    bodyCenterProgress: progress?.bodyCenterProgress ?? 0,
    bodyCrossed: progress?.bodyCenterBeyondJunction ?? false,
    trailingContacts: progress?.trailingContactCount ?? 0,
    maximumTrailingReachRatio: progress?.criticalTrailingReachRatio ?? 0,
    orientationDegrees: THREE.MathUtils.radToDeg(orientation.plannedRotationRadians),
    orientationAcceptedFraction: orientation.acceptedFraction,
    coupledStage: coupled?.stage ?? "idle",
    partialLoadLeg: coupled?.movingLegId ?? null,
    partialFootLoad: coupled && [
      "partial-load-held",
      "moving-body",
      "finishing-load",
    ].includes(coupled.stage)
      ? coupled.currentLoadFactor
      : null,
    bodyMotionCandidatesSummary: motion?.proposedCandidates.length
      ? motion.proposedCandidates
          .map((candidate) =>
            `${candidate.fraction.toFixed(2)}:${candidate.accepted ? "ok" : candidate.limitingConstraint}`)
          .join(" / ")
      : "none",
    acceptedBodyTranslation: motion
      ? Math.hypot(
          motion.acceptedTranslation.x,
          motion.acceptedTranslation.y,
          motion.acceptedTranslation.z,
        )
      : 0,
    acceptedBodyRotationRadians: motion?.acceptedRotationRadians ?? 0,
    limitingFoot: motion?.limitingLegId ?? null,
    limitingConstraint: motion?.limitingConstraint ?? "none",
    worstReachBefore: motion?.worstReachBefore ?? 0,
    worstReachAfter: motion?.worstReachAfter ?? 0,
    reachBudgetImprovement: motion?.reachBudgetImprovement ?? 0,
    supportClassification: motion?.supportAfter ?? "invalid",
    zeroProgressTransactionCount: diagnostics?.zeroProgressTransactionCount ?? 0,
    deadlockReason: diagnostics?.deadlockReason ?? "",
    movedLegHistory: diagnostics?.steps
      .map((step) => step.movedLegId ?? "-")
      .join(" > ") ?? "",
    historyInfluence: selectedInfluence
      ? `${selectedInfluence.legId} ${selectedInfluence.total >= 0 ? "+" : ""}${selectedInfluence.total.toFixed(2)}${strongestComponent ? ` / ${strongestComponent.name}` : ""}`
      : "none",
    planningFailures: diagnostics?.planningFailureCount ?? 0,
    recoveryAttempts: Math.max(
      diagnostics?.recoveryAttemptCount ?? 0,
      localRecoverySearchCount,
    ),
    stopReason: diagnostics?.stopReason ?? "none",
    stopMessage: diagnostics?.stopMessage ?? "",
  };
  phase8Panel.updateMetrics(metrics);
}

function candidateSnapshot(candidate: NonNullable<SpiderStepController["diagnostics"]["selectedPlan"]>["candidate"]) {
  return {
    legId: candidate.legId,
    address: { ...candidate.address },
    source: candidate.source,
    worldPosition: [candidate.worldPosition.x, candidate.worldPosition.y, candidate.worldPosition.z],
    tangent: [candidate.tangent.x, candidate.tangent.y, candidate.tangent.z],
    normal: [candidate.normal.x, candidate.normal.y, candidate.normal.z],
    binormal: [candidate.binormal.x, candidate.binormal.y, candidate.binormal.z],
    localTension: candidate.localTension,
    strandVelocity: [candidate.strandVelocity.x, candidate.strandVelocity.y, candidate.strandVelocity.z],
    reachRatio: candidate.reachRatio,
    progress: candidate.progressTowardDestination,
    distanceFromFootHome: candidate.distanceFromFootHome,
    supportContribution: candidate.approximateSupportContribution,
    rejectionReasons: [...candidate.rejectionReasons],
    rejectionDetails: [...candidate.rejectionDetails],
    score: {
      total: candidate.score.total,
      positive: candidate.score.positive,
      negative: candidate.score.negative,
      components: Object.fromEntries(
        Object.entries(candidate.score.components).map(([key, component]) => [key, { ...component }]),
      ),
    },
  };
}

function diagnosticsSnapshot(includeCandidates = false) {
  const diagnostics = stepController?.diagnostics;
  const generated = diagnostics?.generation;
  const selected = diagnostics?.selectedPlan;
  const runtime = getRuntimeContext();
  const rejectedReasonCounts: Record<string, number> = {};
  const rejectedDetailCounts: Record<string, number> = {};
  for (const candidate of generated?.rejected ?? []) {
    for (const reason of candidate.rejectionReasons) {
      rejectedReasonCounts[reason] = (rejectedReasonCounts[reason] ?? 0) + 1;
    }
    for (const detail of candidate.rejectionDetails) {
      rejectedDetailCounts[detail] = (rejectedDetailCounts[detail] ?? 0) + 1;
    }
  }
  const orientation = selected ? footOrientationResults.get(selected.legId) : undefined;
  return {
    phase: 7,
    milestone: "one-deliberate-autonomous-step",
    continuousGait: false,
    fullRouteExecution: false,
    scenario: selectedScenario,
    rig: {
      status: rigStatus,
      names: rigNames,
      error: rigLoadError,
      report: rig ? formatSpiderRigResolutionReport(rig.validationReport) : null,
      axes: rig ? { forward: rig.axes.forwardToken, up: rig.axes.upToken } : null,
    },
    fixture: {
      topology: fixture.topology,
      strandIds: fixture.strandIds,
      nodeIds: fixture.nodeIds,
      junction: fixture.junction,
      initialContacts: fixture.initialContacts,
      initiallyLoadedLegIds: fixture.initiallyLoadedLegIds,
      weakSupport: fixture.weakSupport,
    },
    state: diagnostics?.state ?? "idle",
    stateElapsedSeconds: diagnostics?.stateElapsedSeconds ?? 0,
    stepElapsedSeconds: diagnostics?.stepElapsedSeconds ?? 0,
    completedStepCount: diagnostics?.completedStepCount ?? 0,
    movingLegId: diagnostics?.movingLegId ?? null,
    previousMovingLegId: diagnostics?.previousMovingLegId ?? null,
    failure: {
      reason: diagnostics?.failureReason ?? "none",
      message: diagnostics?.failureMessage ?? "",
    },
    intent: diagnostics?.intent
      ? {
          requestedDestination: diagnostics.requestedDestination,
          desiredDirection: [
            diagnostics.intent.desiredDirection.x,
            diagnostics.intent.desiredDirection.y,
            diagnostics.intent.desiredDirection.z,
          ],
          destinationPosition: [
            diagnostics.intent.destinationPosition.x,
            diagnostics.intent.destinationPosition.y,
            diagnostics.intent.destinationPosition.z,
          ],
          routeDistance: diagnostics.intent.routeDistance,
          localRouteDistance: diagnostics.intent.localRouteDistance,
          strandIds: diagnostics.intent.route.strandIds,
          transitions: diagnostics.intent.route.transitions,
          requiresAdditionalSteps: diagnostics.requiresAdditionalSteps,
        }
      : null,
    planning: {
      candidates: generated?.candidates.length ?? 0,
      accepted: generated?.accepted.length ?? 0,
      rejected: generated?.rejected.length ?? 0,
      rejectedReasonCounts,
      rejectedDetailCounts,
      legDiagnostics: diagnostics?.legSelection?.diagnostics ?? [],
      winner: selected ? candidateSnapshot(selected.candidate) : null,
      topAccepted: generated
        ? [...generated.accepted]
            .sort((left, right) => right.score.total - left.score.total)
            .slice(0, 16)
            .map(candidateSnapshot)
        : [],
      allCandidates: includeCandidates
        ? generated?.candidates.map(candidateSnapshot) ?? []
        : undefined,
    },
    support: {
      minimum: locomotionConfig.minimumSupportFootCount,
      loaded: runtime.legs.filter((leg) => leg.loaded && leg.planted && leg.valid).length,
      estimate: diagnostics?.supportEstimate,
      otherFootAddressesPreserved: diagnostics?.otherFootAddressesPreserved ?? true,
      stableAddresses: diagnostics?.stableSupportAddresses ?? [],
    },
    secureTransfer: {
      secureBeforeRelease: diagnostics?.secureBeforeRelease ?? true,
      probeWasEntered: diagnostics?.transitions.some((transition) => transition.to === "testing") ?? false,
      plantingWasEntered: diagnostics?.transitions.some((transition) => transition.to === "planting") ?? false,
      loadFactor: diagnostics?.loadTransfer ?? 0,
      perFootLoadFactors: Object.fromEntries(
        SPIDER_LEG_IDS.map((legId) => [legId, loadDistributor?.getFootLoadFactor(legId) ?? 0]),
      ),
    },
    swing: stepController
      ? {
          localFrame: diagnostics?.localFrameSwing ?? true,
          supportUp: { ...stepController.swingTrajectory.supportUp },
          start: { ...stepController.swingTrajectory.start },
          departureControl: { ...stepController.swingTrajectory.departureControl },
          approachControl: { ...stepController.swingTrajectory.approachControl },
          end: { ...stepController.swingTrajectory.end },
          curve: stepController.swingCurve.map((point) => [point.x, point.y, point.z]),
        }
      : null,
    orientation: orientation
      ? {
          valid: orientation.valid,
          failureReason: orientation.failureReason,
          tangentSignFlippedForContinuity: orientation.tangentSignFlippedForContinuity,
          referenceSignFlippedForContinuity: orientation.referenceSignFlippedForContinuity,
          targetAngularDeltaRadians: orientation.targetAngularDeltaRadians,
          appliedAngularDeltaRadians: orientation.appliedAngularDeltaRadians,
          quaternion: { ...orientation.quaternion },
        }
      : null,
    body: bodyPose
      ? {
          initialPosition: initialBodyPosition.toArray(),
          position: bodyPose.result.anchorWorldPosition.toArray(),
          forward: bodyPose.result.bodyForward.toArray(),
          up: bodyPose.result.bodyUp.toArray(),
          supportCenter: bodyPose.frame.center.toArray(),
          supportCount: bodyPose.frame.supportCount,
          advanceOffset: stepController
            ? [
                stepController.bodyAdvanceOffset.x,
                stepController.bodyAdvanceOffset.y,
                stepController.bodyAdvanceOffset.z,
              ]
            : [0, 0, 0],
          advancePlan: diagnostics?.bodyAdvancePlan,
        }
      : null,
    contacts: SPIDER_LEG_IDS.map((legId) => {
      const foot = contacts.get(legId);
      const result = ikResults.get(legId);
      return foot
        ? {
            legId,
            state: foot.state,
            planted: foot.isPlanted,
            valid: foot.contactValid,
            address: foot.address ? { ...foot.address } : null,
            load: foot.carriedLoadNewtons,
            loadFactor: loadDistributor?.getFootLoadFactor(legId) ?? 0,
            reachRatio: foot.currentReachRatio,
            ik: result
              ? { status: result.status, reached: result.reached, residual: result.residual }
              : null,
          }
        : { legId, state: "loading" };
    }),
    transitions: diagnostics?.transitions ?? [],
    web: {
      particles: network.particles.count,
      constraints: network.constraintCount,
      maximumStretch: maximumWebStretch(),
    },
    paused,
  };
}

function coupledMotionDiagnosticsSnapshot(
  motion: Readonly<CoupledBodyMotionDiagnostics>,
  includeCandidates: boolean,
) {
  const rejectionCounts: Record<string, number> = {};
  for (const candidate of motion.proposedCandidates) {
    if (candidate.accepted) continue;
    rejectionCounts[candidate.limitingConstraint] =
      (rejectionCounts[candidate.limitingConstraint] ?? 0) + 1;
  }
  return {
    ...motion,
    acceptedTranslation: { ...motion.acceptedTranslation },
    candidateSummary: {
      count: motion.proposedCandidates.length,
      acceptedCount: motion.proposedCandidates.filter((candidate) => candidate.accepted).length,
      rejectionCounts,
    },
    proposedCandidates: (includeCandidates
      ? motion.proposedCandidates
      : motion.proposedCandidates.filter((candidate) => candidate.accepted)
    ).map((candidate) => ({
      ...candidate,
      translation: { ...candidate.translation },
    })),
  };
}

function coupledTransferDiagnosticsSnapshot(includeCandidates: boolean) {
  const diagnostics = coupledTransfer?.coupledDiagnostics;
  if (!diagnostics || !coupledTransfer) return null;
  const finiteOrZero = (value: number) => Number.isFinite(value) ? value : 0;
  const allRecords = diagnostics.records;
  const completedRecords = allRecords.filter((record) => record.outcome === "complete");
  const motionSummary = completedRecords.map((record) => {
    const translation = finiteOrZero(Math.hypot(
      record.bodyMotion.acceptedTranslation.x,
      record.bodyMotion.acceptedTranslation.y,
      record.bodyMotion.acceptedTranslation.z,
    ));
    const rotation = finiteOrZero(Math.abs(record.bodyMotion.acceptedRotationRadians));
    return { record, translation, rotation };
  });
  const firstPositiveMotion = motionSummary.find(
    ({ translation, rotation }) => translation > 1e-6 || rotation > 1e-6,
  );
  const firstCombinedMotion = motionSummary.find(
    ({ translation, rotation }) => translation > 1e-6 && rotation > 1e-6,
  );
  const stageOrder = [
    "planning-foot",
    "transferring-foot",
    "partial-load-held",
    "moving-body",
    "finishing-load",
    "complete",
  ] as const;
  const stageOrderValid = (record: (typeof allRecords)[number]) => {
    const entered = record.transitions.map((transition) => transition.to);
    let previous = -1;
    return stageOrder.every((stage) => {
      const index = entered.indexOf(stage);
      if (index <= previous) return false;
      previous = index;
      return true;
    });
  };
  const motionEvidence = (
    entry: (typeof motionSummary)[number] | undefined,
  ) => entry
    ? {
        transactionSequence: entry.record.transactionSequence,
        movingLegId: entry.record.movingLegId,
        translation: entry.translation,
        rotationRadians: entry.rotation,
        bodyProgressDelta: finiteOrZero(entry.record.bodyMotion.bodyProgressDelta),
        worstReachBefore: finiteOrZero(entry.record.bodyMotion.worstReachBefore),
        worstReachAfter: finiteOrZero(entry.record.bodyMotion.worstReachAfter),
        supportBefore: entry.record.bodyMotion.supportBefore,
        supportAfter: entry.record.bodyMotion.supportAfter,
        partialLoadFactor: entry.record.partialLoadFactor,
      }
    : null;
  const records = includeCandidates
    ? allRecords
    : allRecords.slice(-12);
  return {
    ...diagnostics,
    config: { ...coupledTransfer.config },
    totalRecordCount: allRecords.length,
    aggregate: {
      completedCount: completedRecords.length,
      failedCount: allRecords.filter((record) => record.outcome === "failed").length,
      cancelledCount: allRecords.filter((record) => record.outcome === "cancelled").length,
      positiveTranslationCount: motionSummary.filter(({ translation }) => translation > 1e-6).length,
      positiveRotationCount: motionSummary.filter(({ rotation }) => rotation > 1e-6).length,
      combinedMotionCount: motionSummary.filter(
        ({ translation, rotation }) => translation > 1e-6 && rotation > 1e-6,
      ).length,
      nonFiniteMotionRecordCount: completedRecords.filter((record) =>
        ![
          record.bodyMotion.acceptedTranslation.x,
          record.bodyMotion.acceptedTranslation.y,
          record.bodyMotion.acceptedTranslation.z,
          record.bodyMotion.acceptedRotationRadians,
          record.bodyMotion.bodyProgressDelta,
          record.bodyMotion.worstReachBefore,
          record.bodyMotion.worstReachAfter,
        ].every(Number.isFinite)).length,
      maximumAcceptedTranslation: motionSummary.reduce(
        (maximum, entry) => Math.max(maximum, entry.translation),
        0,
      ),
      maximumAcceptedRotationRadians: motionSummary.reduce(
        (maximum, entry) => Math.max(maximum, entry.rotation),
        0,
      ),
      maximumRecordedWorstReachAfter: motionSummary.reduce(
        (maximum, entry) => Math.max(
          maximum,
          finiteOrZero(entry.record.bodyMotion.worstReachAfter),
        ),
        0,
      ),
      minimumBodyProgressDelta: motionSummary.length > 0
        ? motionSummary.reduce(
            (minimum, entry) => Math.min(
              minimum,
              finiteOrZero(entry.record.bodyMotion.bodyProgressDelta),
            ),
            Number.POSITIVE_INFINITY,
          )
        : 0,
      maximumBodyProgressDelta: motionSummary.length > 0
        ? motionSummary.reduce(
            (maximum, entry) => Math.max(
              maximum,
              finiteOrZero(entry.record.bodyMotion.bodyProgressDelta),
            ),
            Number.NEGATIVE_INFINITY,
          )
        : 0,
      orderedCompleteCount: completedRecords.filter(stageOrderValid).length,
      allCompleteTransactionsOrdered: completedRecords.every(stageOrderValid),
      firstPositiveMotion: motionEvidence(firstPositiveMotion),
      firstCombinedMotion: motionEvidence(firstCombinedMotion),
      translationWithinConfiguredBound: motionSummary.every(
        ({ translation }) =>
          translation <=
          traversalPolicyConfig.orientation.maximumTranslationPerStep + 1e-8,
      ),
      rotationWithinConfiguredBound: motionSummary.every(
        ({ rotation }) =>
          rotation <=
          traversalPolicyConfig.orientation.maximumRotationRadiansPerStep + 1e-8,
      ),
    },
    transitions: diagnostics.transitions.map((transition) => ({ ...transition })),
    records: records.map((record) => ({
      ...record,
      destination: { ...record.destination },
      newContact: record.newContact ? { ...record.newContact } : null,
      transitions: record.transitions.map((transition) => ({ ...transition })),
      bodyMotion: coupledMotionDiagnosticsSnapshot(record.bodyMotion, includeCandidates),
    })),
    bodyMotion: coupledMotionDiagnosticsSnapshot(diagnostics.bodyMotion, includeCandidates),
  };
}

function phase8DiagnosticsSnapshot(includeCandidates = false) {
  const diagnostics = traversalCoordinator?.diagnostics;
  const runtime = getRuntimeContext();
  const weightedSupport = evaluateCoupledSupport(runtime.bodyWorldPosition, false);
  const liveJunction = new THREE.Vector3();
  traversal.getNodePosition(fixture.junction.nodeId, liveJunction);
  const history = legMovementHistory.writeSnapshots(
    (diagnostics?.completedStepCount ?? 0) + 1,
    legHistorySnapshots,
  );
  return {
    phase: 8,
    milestone: "phase-8r2-angled-underside-transition",
    unrestrictedRoaming: false,
    webConstruction: false,
    atomicAuthority: "SpiderStepController / Phase 7 secure transaction",
    scenario: selectedTraversalScenario,
    expectedStop: fixture.validationScenarios[selectedTraversalScenario].expectedStop,
    strategy: {
      directive: latestTransitionStrategyDirective,
      diagnostics: { ...transitionStrategyController.diagnostics },
    },
    fixture: {
      topology: fixture.topology,
      strandIds: fixture.strandIds,
      nodeIds: fixture.nodeIds,
      junction: fixture.junction,
      liveJunctionPosition: liveJunction.toArray(),
      branches: fixture.branches,
      falseProjectionCrossing: fixture.falseProjectionCrossing,
      weakSupport: fixture.weakSupport,
      initialContacts: fixture.initialContacts,
      faultInjection: fixture.faultInjection,
    },
    coordinator: diagnostics
      ? {
          ...diagnostics,
          currentRoute: diagnostics.currentRoute,
          transitions: [...diagnostics.transitions],
          steps: [...diagnostics.steps],
        }
      : null,
    coupledTransfer: coupledTransferDiagnosticsSnapshot(includeCandidates),
    route: {
      full: fullTraversalRoute,
      resolutionCount: diagnostics?.routeResolutionCount ?? 0,
      explicitFalseCrossingConnected:
        traversal.getNode(fixture.junction.nodeId)?.connectedStrandIds.has(
          fixture.strandIds.falseCrossing,
        ) ?? false,
    },
    progress: latestJunctionEstimate,
    history: {
      snapshots: history.map((entry) => ({ ...entry })),
      adjustments: { ...legSelectionScoreAdjustments },
      influences: latestHistoryInfluences.map((influence) => ({
        legId: influence.legId,
        total: influence.total,
        components: Object.fromEntries(
          Object.entries(influence.components).map(([name, component]) => [
            name,
            { ...component },
          ]),
        ),
      })),
    },
    orientation: {
      plan: latestBodyOrientationPlan,
      destinationBranchFrame: {
        valid: latestDestinationBranchFrame.valid,
        message: latestDestinationBranchFrame.message,
        transitionKey: latestDestinationBranchFrame.transitionKey,
        sampleAddress: latestDestinationBranchFrame.sampleAddress
          ? { ...latestDestinationBranchFrame.sampleAddress }
          : null,
        companionAddress: latestDestinationBranchFrame.companionAddress
          ? { ...latestDestinationBranchFrame.companionAddress }
          : null,
        companionStrandId: latestDestinationBranchFrame.companionStrandId,
        frame: {
          position: { ...latestDestinationBranchFrame.frame.position },
          forward: { ...latestDestinationBranchFrame.frame.forward },
          up: { ...latestDestinationBranchFrame.frame.up },
          right: { ...latestDestinationBranchFrame.frame.right },
        },
        routeDirectionSign: latestDestinationBranchFrame.routeDirectionSign,
        usedCompanionGeometry: latestDestinationBranchFrame.usedCompanionGeometry,
        usedParallelTransportFallback:
          latestDestinationBranchFrame.usedParallelTransportFallback,
        flippedForSignContinuity: latestDestinationBranchFrame.flippedForSignContinuity,
        frameSignContinuous: latestDestinationBranchFrame.frameSignContinuous,
        totalAngularErrorRadians: latestDestinationBranchFrame.totalAngularErrorRadians,
        forwardErrorRadians: latestDestinationBranchFrame.forwardErrorRadians,
        pitchErrorRadians: latestDestinationBranchFrame.pitchErrorRadians,
        rollErrorRadians: latestDestinationBranchFrame.rollErrorRadians,
      },
      frameActive: traversalBodyFrameActive,
      appliedFrame: {
        position: traversalBodyFrame.position.toArray(),
        forward: traversalBodyFrame.forward.toArray(),
        up: traversalBodyFrame.up.toArray(),
        right: traversalBodyFrame.right.toArray(),
      },
      easing: {
        active: orientationEaseActive,
        stepIndex: orientationEaseStepIndex,
        elapsedSeconds: orientationEaseElapsedSeconds,
      },
      bodyCommit: {
        active: bodyCommitActive,
        elapsedSeconds: bodyCommitElapsedSeconds,
        offset: bodyCommitOffset.toArray(),
      },
    },
    adaptiveBodyAdvance: {
      active: stepController?.diagnostics.adaptiveBodyAdvance ?? false,
      candidates: [...phaseEightBodyAdvanceDistanceCandidates],
      plannedDistance:
        stepController?.diagnostics.plannedBodyAdvanceDistance ??
        phaseEightBodyAdvanceDistance,
      reachSafetyFactor:
        stepController?.diagnostics.plannedBodyAdvanceReachSafetyFactor ??
        locomotionConfig.maximumRemainingReachRatio,
      catchUpStep:
        (stepController?.diagnostics.plannedBodyAdvanceDistance ??
          phaseEightBodyAdvanceDistance) <= 1e-8,
      maximumCurrentReachRatio: runtime.legs.reduce(
        (maximum, leg) => Math.max(
          maximum,
          Number.isFinite(leg.currentReachRatio) ? leg.currentReachRatio : 0,
        ),
        0,
      ),
      eligibleMovingLegIds:
        stepController?.diagnostics.legSelection?.diagnostics
          .filter((leg) => leg.eligible)
          .map((leg) => leg.legId) ?? [],
    },
    candidateSeeds: latestCandidateSeeds.map((seed) => seed.kind === "continuous-address"
      ? {
          ...seed,
          address: { ...seed.address },
        }
      : {
          ...seed,
          worldPosition: { ...seed.worldPosition },
          authorizedStrandIds: [...seed.authorizedStrandIds],
        }),
    exploration: latestExplorationCandidates.map((candidate) => ({
      position: [candidate.position.x, candidate.position.y, candidate.position.z],
      accepted: candidate.accepted,
      label: candidate.label,
    })),
    recovery: {
      searchCount: localRecoverySearchCount,
      pendingDestination: latestRecoveryDestination,
      candidates: includeCandidates
        ? latestRecoveryCandidates.map((candidate) => ({ ...candidate }))
        : latestRecoveryCandidates.map((candidate) => ({
            source: candidate.source,
            address: candidate.address,
            accepted: candidate.accepted,
            score: candidate.score,
            rejectionReasons: [...candidate.rejectionReasons],
          })),
    },
    fault: {
      mode: phase8FaultMode,
      active: faultInjectionActive,
      recoverySearchTriggered,
      cancellationInjected,
    },
    support: {
      required: locomotionConfig.minimumSupportFootCount,
      validLoaded: runtime.legs.filter((leg) => leg.planted && leg.loaded && leg.valid).length,
      effectiveWeightedCount: weightedSupport.effectiveSupportCount,
      classification: weightedSupport.classification,
      bodyEdgeMargin: weightedSupport.bodyEdgeMargin,
      loadFactors: Object.fromEntries(runtime.legs.map((leg) => [
        leg.legId,
        leg.loadFactor ?? (leg.loaded ? 1 : 0),
      ])),
      allAddressesFinite: runtime.legs.every((leg) =>
        !leg.address || Number.isFinite(leg.address.t)),
      maximumReachRatio: runtime.legs.reduce(
        (maximum, leg) => Math.max(
          maximum,
          Number.isFinite(leg.currentReachRatio) ? leg.currentReachRatio : 0,
        ),
        0,
      ),
    },
    atomic: diagnosticsSnapshot(includeCandidates),
    policyConfig: traversalPolicyConfig,
    paused,
  };
}

Object.assign(window, {
  __BOTHRIA_PHASE7__: {
    diagnostics: () => diagnosticsSnapshot(true),
    compactDiagnostics: () => diagnosticsSnapshot(false),
    issueScenario: (scenario: LocomotionValidationScenario) => issueScenario(scenario, "execute"),
    planScenario: (scenario: LocomotionValidationScenario) => issueScenario(scenario, "plan-only"),
    executePlannedStep: () => stepController?.executePlannedStep() ?? false,
    issueDestination: (destination: RouteDestination, mode: "plan-only" | "execute" = "execute") =>
      stepController?.requestDestination(destination, mode) ?? false,
    cancel: () => stepController?.cancel(),
    reset: rebuildFixture,
    setPaused: (value: boolean) => {
      paused = Boolean(value);
      accumulator = 0;
      panel.setPaused(paused);
    },
  },
  __BOTHRIA_PHASE8__: {
    diagnostics: () => phase8DiagnosticsSnapshot(true),
    compactDiagnostics: () => phase8DiagnosticsSnapshot(false),
    issueScenario: (
      scenario: PhaseEightValidationScenarioId,
      runMode: "pause-after-step" | "run-until-arrival" = "run-until-arrival",
    ) => issueTraversalScenario(scenario, runMode),
    pauseAfterCurrentStep: () => traversalCoordinator?.pauseAfterCurrentStep(),
    continueOneStep: () => traversalCoordinator?.continueOneStep() ?? false,
    runUntilArrival: () => traversalCoordinator?.runUntilArrival() ?? false,
    cancelAndRestore: () => traversalCoordinator?.cancelAndRestore() ?? false,
    reset: rebuildFixture,
    setPaused: (value: boolean) => {
      paused = Boolean(value);
      accumulator = 0;
      panel.setPaused(paused);
    },
    fixedSteps: (count = 1) => {
      const steps = Math.max(0, Math.min(120_000, Math.floor(Number(count) || 0)));
      for (let index = 0; index < steps; index += 1) runFixedStep();
      updateSpiderRig();
      updatePanelMetrics();
      return phase8DiagnosticsSnapshot(false);
    },
  },
});

function frame(time: number): void {
  const rawDelta = Math.max(0, (time - previousTime) / 1000);
  previousTime = time;
  const frameDelta = Math.min(rawDelta, MAX_FRAME_DELTA);
  if (rawDelta > 0) {
    const instantaneousFps = 1 / rawDelta;
    smoothedFps += (instantaneousFps - smoothedFps) * 0.08;
  }

  if (!paused) {
    accumulator += frameDelta;
    let substeps = 0;
    while (accumulator >= FIXED_TIME_STEP && substeps < MAX_SUBSTEPS) {
      runFixedStep();
      accumulator -= FIXED_TIME_STEP;
      substeps += 1;
    }
    if (substeps === MAX_SUBSTEPS && accumulator >= FIXED_TIME_STEP) accumulator = 0;
  }

  updateSpiderRig();
  webRenderer.update(interaction, time / 1000);
  renderer.render(scene, camera);

  if (time - lastMetricsUpdate >= 180) {
    updatePanelMetrics();
    lastMetricsUpdate = time;
  }
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
