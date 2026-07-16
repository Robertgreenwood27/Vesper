import assert from "node:assert/strict";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const workspaceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const vite = await createServer({
  root: workspaceRoot,
  configFile: false,
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});
const { JunctionTraversalCoordinator } = await vite.ssrLoadModule(
  "/src/spider/traversal/JunctionTraversalCoordinator.ts",
);

after(async () => {
  await vite.close();
});

const DESTINATION = Object.freeze({
  kind: "address",
  address: Object.freeze({ strandId: "destination", t: 0.8 }),
});

const ROUTE = Object.freeze({
  strandIds: Object.freeze(["approach", "destination"]),
});

const ROLL_UNDER_DIRECTIVE = Object.freeze({
  strategy: "roll-under",
  stage: "establish-new-plane",
  preferredLegRegions: Object.freeze(["front", "middle"]),
  contactGoal: "new-plane",
  bodyGoal: "hold",
  translationScale: 0,
  rotationScale: 0,
  reachReliefRequired: false,
  failed: false,
  failureReason: "",
});

test("bounded local recovery is the only retry authority for recoverable atomic failures", () => {
  const atomicStep = createFailingAtomicStep("target-unreachable");
  const recoveryAttempts = [];
  const coordinator = createCoordinator(atomicStep, {
    attemptRecovery: (request) => {
      recoveryAttempts.push(request.attempt);
      return {
        retry: true,
        stepDestination: request.destination,
        message: "Try another hard-valid contact.",
      };
    },
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  driveUntil(coordinator, () => !coordinator.isActive);

  assert.deepEqual(recoveryAttempts, [1, 2]);
  assert.equal(coordinator.diagnostics.recoveryAttemptCount, 2);
  assert.equal(coordinator.diagnostics.atomicExecutionFailureCount, 3);
  assert.equal(coordinator.diagnostics.stopReason, "recovery-exhausted");
});

test("planning failure without a recovery port obeys the generic consecutive bound", () => {
  const coordinator = createCoordinator(
    createFailingAtomicStep("no-valid-candidate", "planning"),
  );

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  driveUntil(coordinator, () => !coordinator.isActive);

  assert.equal(coordinator.diagnostics.planningFailureCount, 2);
  assert.equal(coordinator.diagnostics.recoveryAttemptCount, 0);
  assert.equal(coordinator.diagnostics.stopReason, "planning-failure-limit");
});

test("the selected strategy directive reaches ordinary atomic planning", () => {
  const atomicStep = createRunningAtomicStep();
  const strategyContexts = [];
  const planContexts = [];
  const coordinator = createCoordinator(atomicStep, {
    readStrategyDirective: (context) => {
      strategyContexts.push(context);
      return ROLL_UNDER_DIRECTIVE;
    },
    prepareAtomicPlan: (context) => planContexts.push(context),
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  coordinator.update(0);
  coordinator.update(0);

  assert.equal(strategyContexts.length, 1);
  assert.equal(planContexts.length, 1);
  assert.equal(planContexts[0].strategyDirective, ROLL_UNDER_DIRECTIVE);
  assert.equal(
    coordinator.diagnostics.strategyDirective,
    ROLL_UNDER_DIRECTIVE,
  );
  assert.equal(atomicStep.requestCount, 1);
});

test("a failed strategy restores once and terminal-stops before another plan", () => {
  const atomicStep = createRunningAtomicStep();
  let restorationCount = 0;
  const failedDirective = {
    ...ROLL_UNDER_DIRECTIVE,
    stage: "rotate-and-build",
    failed: true,
    failureReason: "Roll-under stage exhausted its bounded alternatives.",
  };
  const coordinator = createCoordinator(atomicStep, {
    readStrategyDirective: () => failedDirective,
    restoreLastStablePose: () => {
      restorationCount += 1;
      return true;
    },
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  coordinator.update(0);
  coordinator.update(1 / 60);

  assert.equal(coordinator.state, "failed");
  assert.equal(coordinator.diagnostics.stopReason, "strategy-failed");
  assert.match(coordinator.diagnostics.stopMessage, /bounded alternatives/i);
  assert.equal(coordinator.diagnostics.restorationRequested, true);
  assert.equal(coordinator.diagnostics.restorationSucceeded, true);
  assert.equal(restorationCount, 1);
  assert.equal(atomicStep.requestCount, 0);
});

test("strategy callback faults also restore once and stop clearly", () => {
  let restorationCount = 0;
  const coordinator = createCoordinator(createRunningAtomicStep(), {
    readStrategyDirective: () => {
      throw new Error("invalid stage evidence");
    },
    restoreLastStablePose: () => {
      restorationCount += 1;
      return true;
    },
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  coordinator.update(0);
  coordinator.update(0);

  assert.equal(coordinator.diagnostics.stopReason, "strategy-failed");
  assert.match(coordinator.diagnostics.stopMessage, /invalid stage evidence/i);
  assert.equal(restorationCount, 1);
});

test("completed transaction progress uses only the five hybrid signals", async (t) => {
  const before = {
    ...createProgress(),
    bodyCenterDistancePastJunction: 0.1,
    branchFrameAngularError: 0.5,
    destinationPlaneSupportCount: 2,
    trailingContactCount: 3,
    maximumReachRatio: 0.82,
  };
  const cases = [
    [
      "body progress",
      { bodyCenterDistancePastJunction: before.bodyCenterDistancePastJunction + 0.01 },
    ],
    [
      "branch-frame alignment",
      { branchFrameAngularError: before.branchFrameAngularError - 0.02 },
    ],
    [
      "new-plane contacts",
      { destinationPlaneSupportCount: before.destinationPlaneSupportCount + 1 },
    ],
    [
      "trailing support count",
      { trailingContactCount: before.trailingContactCount - 1 },
    ],
    [
      "worst reach ratio",
      { maximumReachRatio: before.maximumReachRatio - 0.01 },
    ],
  ];

  for (const [name, change] of cases) {
    await t.test(name, () => {
      const coordinator = createCoordinator(createRunningAtomicStep());
      coordinator.progressBeforeTransaction = before;
      coordinator.diagnostics.progress = { ...before, ...change };
      coordinator.diagnostics.zeroProgressTransactionCount = 1;

      assert.equal(coordinator.evaluateTransactionProgress(), true);
      assert.equal(coordinator.diagnostics.zeroProgressTransactionCount, 0);
    });
  }
});

test("ordinary travel stops after the one generic no-progress bound", () => {
  const flat = createProgress();
  const coordinator = createCoordinator(createRunningAtomicStep(), {
    config: { maximumZeroProgressTransactions: 2 },
  });
  coordinator.diagnostics.strategyDirective = {
    ...ROLL_UNDER_DIRECTIVE,
    strategy: "ordinary-traverse",
    stage: "ordinary-travel",
    contactGoal: "route-progress",
  };
  coordinator.progressBeforeTransaction = flat;
  coordinator.diagnostics.progress = flat;

  assert.equal(coordinator.evaluateTransactionProgress(), true);
  assert.equal(coordinator.evaluateTransactionProgress(), false);
  assert.equal(coordinator.diagnostics.stopReason, "coupled-transfer-deadlock");
  assert.match(coordinator.diagnostics.deadlockReason, /five|branch-frame|support-plane/i);
});

test("roll-under approach uses the ordinary no-progress bound", () => {
  const flat = {
    ...createProgress(),
    nonCoplanarTransition: true,
  };
  const coordinator = createCoordinator(createRunningAtomicStep(), {
    config: { maximumZeroProgressTransactions: 2 },
  });
  coordinator.diagnostics.strategyDirective = {
    ...ROLL_UNDER_DIRECTIVE,
    stage: "approach-junction",
    contactGoal: "route-progress",
  };
  coordinator.progressBeforeTransaction = flat;
  coordinator.diagnostics.progress = flat;

  assert.equal(coordinator.evaluateTransactionProgress(), true);
  assert.equal(coordinator.evaluateTransactionProgress(), false);
  assert.equal(coordinator.diagnostics.stopReason, "angled-transition-stagnation");
});

test("former composite-only signals do not earn hybrid progress credit", () => {
  const before = {
    ...createProgress(0.82),
    semanticRouteProgress: 0.1,
    criticalTrailingReachRatio: 0.8,
    worstRemovalBodyMargin: 0.1,
    circumferentialCoverage: 0.1,
    destinationSideLoadedContactCount: 1,
  };
  const coordinator = createCoordinator(createRunningAtomicStep());
  coordinator.progressBeforeTransaction = before;
  coordinator.diagnostics.progress = {
    ...before,
    semanticRouteProgress: 0.9,
    criticalTrailingReachRatio: 0.4,
    worstRemovalBodyMargin: 0.8,
    circumferentialCoverage: 0.9,
    destinationSideLoadedContactCount: 4,
  };

  assert.equal(coordinator.evaluateTransactionProgress(), true);
  assert.equal(coordinator.diagnostics.zeroProgressTransactionCount, 1);
});

test("roll-under stage stagnation does not consume the resumed generic budget", () => {
  const flat = {
    ...createProgress(),
    junctionEncountered: true,
    nonCoplanarTransition: true,
  };
  const coordinator = createCoordinator(createRunningAtomicStep(), {
    config: { maximumZeroProgressTransactions: 2 },
  });
  coordinator.diagnostics.strategyDirective = ROLL_UNDER_DIRECTIVE;
  coordinator.progressBeforeTransaction = flat;
  coordinator.diagnostics.progress = flat;

  for (let transaction = 0; transaction < 6; transaction += 1) {
    assert.equal(coordinator.evaluateTransactionProgress(), true);
  }
  assert.equal(coordinator.state, "idle");
  assert.equal(coordinator.diagnostics.zeroProgressTransactionCount, 0);

  coordinator.diagnostics.strategyDirective = {
    ...ROLL_UNDER_DIRECTIVE,
    stage: "resume-generic",
  };
  assert.equal(coordinator.evaluateTransactionProgress(), true);
  assert.equal(coordinator.diagnostics.zeroProgressTransactionCount, 1);
  assert.equal(coordinator.evaluateTransactionProgress(), false);
  assert.equal(coordinator.diagnostics.zeroProgressTransactionCount, 2);
  assert.equal(
    coordinator.diagnostics.stopReason,
    "angled-transition-stagnation",
  );
});

test("bounded contact restoration may settle on the remaining hard supports", () => {
  const atomicStep = createFailingAtomicStep("target-unreachable");
  let restoring = false;
  let restoredPoseStable = true;
  Object.defineProperty(atomicStep, "restorationPending", {
    get: () => restoring,
  });
  const coordinator = createCoordinator(atomicStep, {
    attemptRecovery: (request) => {
      restoring = true;
      restoredPoseStable = false;
      return {
        retry: true,
        stepDestination: request.destination,
        message: "Restore the original semantic contact.",
      };
    },
    readSafety: () => ({
      supportValid: !restoring && restoredPoseStable,
      loadedSupportCount: restoring ? 7 : 8,
      requiredSupportCount: 5,
      ikFailureActive: false,
      footFailureActive: restoring,
      routeValid: true,
    }),
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  driveUntil(coordinator, () => coordinator.state === "settling");
  for (let iteration = 0; iteration < 8; iteration += 1) {
    coordinator.update(1 / 60);
  }
  assert.equal(coordinator.state, "settling");
  assert.equal(coordinator.diagnostics.stopReason, "none");

  restoring = false;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    coordinator.update(1 / 60);
  }
  assert.equal(coordinator.state, "settling");

  restoredPoseStable = true;
  driveUntil(coordinator, () => coordinator.state !== "settling");
  assert.equal(coordinator.diagnostics.stopReason, "none");
});

test("an unstable restored pose fails within the bounded settle window", () => {
  let restoredPoseUnstable = false;
  const coordinator = createCoordinator(
    createFailingAtomicStep("target-unreachable"),
    {
      attemptRecovery: (request) => {
        restoredPoseUnstable = true;
        return {
          retry: true,
          stepDestination: request.destination,
          message: "Wait for restored support.",
        };
      },
      readSafety: () => ({
        supportValid: !restoredPoseUnstable,
        loadedSupportCount: 8,
        requiredSupportCount: 5,
        ikFailureActive: false,
        footFailureActive: false,
        routeValid: true,
      }),
      config: { maximumRestorationDurationSeconds: 0.05 },
    },
  );

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  driveUntil(coordinator, () => !coordinator.isActive);

  assert.equal(coordinator.diagnostics.stopReason, "recovery-exhausted");
  assert.match(coordinator.diagnostics.stopMessage, /restoration did not stabilize/i);
});

test("an invalid route stops before strategy selection or atomic planning", () => {
  const atomicStep = createRunningAtomicStep();
  let strategyReadCount = 0;
  const coordinator = createCoordinator(atomicStep, {
    resolveRoute: () => ({
      ok: false,
      route: null,
      reason: "Scenario C has no semantic path.",
    }),
    readStrategyDirective: () => {
      strategyReadCount += 1;
      return ROLL_UNDER_DIRECTIVE;
    },
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  coordinator.update(0);

  assert.equal(coordinator.diagnostics.stopReason, "route-invalid");
  assert.match(coordinator.diagnostics.stopMessage, /no semantic path/i);
  assert.equal(strategyReadCount, 0);
  assert.equal(atomicStep.requestCount, 0);
});

test("maximum observed reach is monotonic for one run and resets for the next", () => {
  let maximumReachRatio = 0.62;
  const coordinator = createCoordinator(createRunningAtomicStep(), {
    readProgress: () => createProgress(maximumReachRatio),
  });

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  coordinator.update(0);
  assert.equal(coordinator.diagnostics.maximumObservedReachRatio, 0.62);

  maximumReachRatio = 0.91;
  assert.equal(coordinator.refreshProgress(), true);
  maximumReachRatio = 0.75;
  assert.equal(coordinator.refreshProgress(), true);
  assert.equal(coordinator.diagnostics.maximumObservedReachRatio, 0.91);

  assert.equal(coordinator.cancelAndRestore(), true);
  maximumReachRatio = 0.4;
  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  assert.equal(coordinator.diagnostics.maximumObservedReachRatio, 0);
  coordinator.update(0);
  assert.equal(coordinator.diagnostics.maximumObservedReachRatio, 0.4);
});

test("cancellation delegates once to an active atomic transaction and schedules nothing else", () => {
  const atomicStep = createRunningAtomicStep();
  const coordinator = createCoordinator(atomicStep);

  assert.equal(coordinator.start(DESTINATION, "run-until-arrival"), true);
  driveUntil(coordinator, () => coordinator.state === "executing-step");
  assert.equal(coordinator.cancelAndRestore(), true);
  assert.equal(coordinator.cancelAndRestore(), false);
  coordinator.update(1 / 60);

  assert.equal(coordinator.state, "cancelled");
  assert.equal(coordinator.diagnostics.stopReason, "user-cancelled");
  assert.equal(coordinator.diagnostics.restorationRequested, true);
  assert.equal(atomicStep.cancelCount, 1);
  assert.equal(atomicStep.requestCount, 1);
});

function createCoordinator(atomicStep, options = {}) {
  const {
    attemptRecovery,
    readProgress = () => createProgress(),
    readSafety = createSafeSnapshot,
    resolveRoute = () => ({
      ok: true,
      route: ROUTE,
      stepDestination: DESTINATION,
      topologyRevision: 1,
    }),
    config = {},
    ...dependencies
  } = options;
  return new JunctionTraversalCoordinator({
    atomicStep,
    resolveRoute,
    readProgress,
    readSafety,
    attemptRecovery,
    ...dependencies,
    config: {
      settleDurationSeconds: 0,
      maximumConsecutiveFailures: 2,
      maximumRecoveryAttempts: 2,
      maximumRestorationDurationSeconds: 0.2,
      maximumZeroProgressTransactions: 2,
      maximumStepCount: 14,
      defaultRunMode: "run-until-arrival",
      ...config,
    },
  });
}

function createSafeSnapshot() {
  return {
    supportValid: true,
    loadedSupportCount: 8,
    requiredSupportCount: 3,
    ikFailureActive: false,
    footFailureActive: false,
    routeValid: true,
  };
}

function createFailingAtomicStep(failureReason, failureStage = "execution") {
  let state = "idle";
  const diagnostics = createAtomicDiagnostics();
  return {
    get state() {
      return state;
    },
    get isExecuting() {
      return !["idle", "planning", "complete", "failed"].includes(state);
    },
    diagnostics,
    requestDestination() {
      if (failureStage === "planning") {
        state = "failed";
        diagnostics.state = state;
        diagnostics.failureReason = failureReason;
        diagnostics.failureMessage =
          "Injected " + failureReason + " during planning.";
        return false;
      }
      state = "planning";
      diagnostics.state = state;
      diagnostics.failureReason = "none";
      diagnostics.failureMessage = "";
      return true;
    },
    executePlannedStep() {
      state = "failed";
      diagnostics.state = state;
      diagnostics.failureReason = failureReason;
      diagnostics.failureMessage = "Injected " + failureReason + ".";
      return false;
    },
    update() {},
    cancel() {
      state = "failed";
      diagnostics.state = state;
      diagnostics.failureReason = "cancelled";
    },
  };
}

function createRunningAtomicStep() {
  let state = "idle";
  let requestCount = 0;
  let cancelCount = 0;
  const diagnostics = createAtomicDiagnostics();
  return {
    get state() {
      return state;
    },
    get isExecuting() {
      return !["idle", "planning", "complete", "failed"].includes(state);
    },
    get requestCount() {
      return requestCount;
    },
    get cancelCount() {
      return cancelCount;
    },
    diagnostics,
    requestDestination() {
      requestCount += 1;
      state = "planning";
      diagnostics.state = state;
      return true;
    },
    executePlannedStep() {
      state = "lifting";
      diagnostics.state = state;
      return true;
    },
    update() {},
    cancel() {
      cancelCount += 1;
      state = "failed";
      diagnostics.state = state;
      diagnostics.failureReason = "cancelled";
      diagnostics.failureMessage = "Cancelled for test.";
    },
  };
}

function createAtomicDiagnostics() {
  return {
    state: "idle",
    failureReason: "none",
    failureMessage: "",
    selectedPlan: null,
    completedStepCount: 0,
    secureBeforeRelease: true,
    localFrameSwing: true,
    stepElapsedSeconds: 0,
  };
}

function createProgress(maximumReachRatio = 0.5) {
  return {
    currentRouteStrandId: "approach",
    currentJunctionNodeId: null,
    nextRouteTransition: null,
    selectedDestinationBranchStrandId: "destination",
    junctionEncountered: false,
    bodyCenterBeyondJunction: false,
    destinationSideLoadedContactCount: 0,
    destinationSideSpread: 0,
    trailingContactCount: 0,
    criticalTrailingReachRatio: 0.5,
    maximumReachRatio,
    canCommitBody: false,
    needsExploratoryTest: false,
    routeComplete: false,
    bodyNearDestination: false,
    stableSupportNearDestination: false,
    destinationReached: false,
    bodyCenterDistancePastJunction: -0.5,
    removableSupportCount: 5,
    worstRemovalBodyMargin: 0.2,
    bodyCenterProgress: 0.1,
    semanticRouteProgress: 0.1,
    nonCoplanarTransition: false,
    posturePhase: "approach",
    branchFrameAngularError: 0,
    branchFrameForwardError: 0,
    branchFramePitchError: 0,
    branchFrameRollError: 0,
    destinationPlaneSupportCount: 0,
    circumferentialCoverage: 0,
    circumferentialContacts: [],
    contactStateFingerprint: "stable-test-pose",
  };
}

function driveUntil(coordinator, predicate) {
  for (let iteration = 0; iteration < 120; iteration += 1) {
    if (predicate()) return;
    coordinator.update(1 / 60);
  }
  assert.fail(
    "Coordinator did not reach the expected state (current: " +
      coordinator.state +
      ").",
  );
}
