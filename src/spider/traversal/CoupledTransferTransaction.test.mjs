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
const {
  CoupledTransferTransaction,
  createCoupledBodyMotionDiagnostics,
} = await vite.ssrLoadModule(
  "/src/spider/traversal/CoupledTransferTransaction.ts",
);

after(async () => {
  await vite.close();
});

test("cancelled record waits for foot restoration to complete", () => {
  const atomicStep = createAtomicStep();
  const records = [];
  let restorationComplete = false;
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion: createBodyMotion(),
    readFootRestoration(legId, originalAddress) {
      assert.equal(legId, "L2");
      assert.deepEqual(originalAddress, ORIGINAL_ADDRESS);
      return { complete: restorationComplete, succeeded: true };
    },
    onRecord: (record) => records.push(record),
  });

  beginPlannedTransfer(transaction);
  transaction.cancel();

  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.coupledDiagnostics.restorationSucceeded, null);
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(records.length, 0);

  restorationComplete = true;
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "cancelled");
  assert.equal(transaction.coupledDiagnostics.restorationSucceeded, true);
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "cancelled");
  assert.equal(records[0].restorationRequested, true);
  assert.equal(records[0].restorationSucceeded, true);
});

test("completed restoration failure is recorded immediately", () => {
  const transaction = new CoupledTransferTransaction({
    atomicStep: createAtomicStep(),
    bodyMotion: createBodyMotion(),
    readFootRestoration: () => ({
      complete: true,
      succeeded: false,
      message: "Original foothold could not be restored.",
    }),
  });

  beginPlannedTransfer(transaction);
  transaction.cancel();

  assert.equal(transaction.coupledDiagnostics.stage, "cancelled");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].restorationSucceeded, false);
  assert.match(
    transaction.coupledDiagnostics.records[0].failureMessage,
    /Original foothold could not be restored/,
  );
});

test("full-load completion waits for stable-pose validation", () => {
  const atomicStep = createAtomicStep();
  let validationStatus = "running";
  let validationCalls = 0;
  let commitCalls = 0;
  let restoreCalls = 0;
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    readWorstReachRatio: () => 0.963,
    bodyMotion: createBodyMotion({
      begin: (request) => {
        assert.equal(request.worstReachRatioBeforeTransfer, 0.963);
        return { status: "complete" };
      },
      validateStablePose(_fixedDeltaSeconds, request) {
        validationCalls += 1;
        assert.equal(request.movingLegId, "L2");
        return { status: validationStatus };
      },
      commitStablePose: () => {
        commitCalls += 1;
      },
      cancelAndRestore: () => {
        restoreCalls += 1;
        return true;
      },
    }),
    readFootRestoration: () => ({ complete: true, succeeded: true }),
  });

  enterFullLoadValidation(transaction, atomicStep);
  transaction.update(1 / 60);

  assert.equal(validationCalls, 1);
  assert.equal(transaction.coupledDiagnostics.stage, "finishing-load");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(commitCalls, 0);

  validationStatus = "complete";
  transaction.update(1 / 60);

  assert.equal(validationCalls, 2);
  assert.equal(transaction.coupledDiagnostics.stage, "finishing-load");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(commitCalls, 0);

  atomicStep.setState("complete");
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "complete");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].outcome, "complete");
  assert.equal(commitCalls, 1);
  assert.equal(restoreCalls, 0);
});

test("failed full-load validation restores and cancels the executing atomic step", () => {
  const events = [];
  const atomicStep = createAtomicStep({
    onCancel: () => events.push("atomic-cancel"),
  });
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion: createBodyMotion({
      begin: () => ({ status: "complete" }),
      validateStablePose: () => {
        events.push("validate");
        assert.equal(atomicStep.isExecuting, true);
        return { status: "failed", message: "Full-load support became invalid." };
      },
      cancelAndRestore: () => {
        events.push("restore");
        return true;
      },
    }),
    readFootRestoration: () => ({ complete: true, succeeded: true }),
  });

  enterFullLoadValidation(transaction, atomicStep);
  assert.equal(atomicStep.isExecuting, true);
  transaction.update(1 / 60);

  assert.deepEqual(events, ["validate", "restore", "atomic-cancel"]);
  assert.equal(atomicStep.state, "failed");
  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].outcome, "failed");
  assert.equal(
    transaction.coupledDiagnostics.records[0].failureReason,
    "body-motion-failed",
  );
  assert.equal(transaction.coupledDiagnostics.records[0].restorationRequested, true);
  assert.equal(transaction.coupledDiagnostics.records[0].restorationSucceeded, true);
  assert.match(
    transaction.coupledDiagnostics.records[0].failureMessage,
    /Full-load support became invalid/,
  );
});

test("failed body restoration remains pending until its owner publishes a fresh pose", () => {
  const atomicStep = createAtomicStep();
  let restorationPending = false;
  const bodyMotion = createBodyMotion({
    begin: () => ({ status: "complete" }),
    validateStablePose: () => ({
      status: "failed",
      message: "Full-load reach reserve rejected the pose.",
    }),
    cancelAndRestore: () => {
      restorationPending = true;
      return true;
    },
  });
  Object.defineProperty(bodyMotion, "restorationPending", {
    get: () => restorationPending,
  });
  bodyMotion.diagnostics.limitingConstraint =
    "full-load-strategic-reach-reserve";
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion,
    readFootRestoration: () => ({ complete: true, succeeded: true }),
  });

  enterFullLoadValidation(transaction, atomicStep);
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.state, "loading");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(transaction.restorationPending, true);

  restorationPending = false;
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.restorationPending, false);
  assert.equal(transaction.failureRecoveryMode, "reach-reserve");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].restorationSucceeded, true);
});

test("failed transfer does not become retry-ready before exact foot restoration", () => {
  const atomicStep = createAtomicStep();
  let restoration = { complete: false, succeeded: false };
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion: createBodyMotion({
      begin: () => ({ status: "complete" }),
      validateStablePose: () => ({
        status: "failed",
        message: "Full-load support became invalid.",
      }),
    }),
    readFootRestoration(legId, originalAddress) {
      assert.equal(legId, "L2");
      assert.deepEqual(originalAddress, ORIGINAL_ADDRESS);
      return restoration;
    },
  });

  enterFullLoadValidation(transaction, atomicStep);
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.state, "loading");
  assert.equal(transaction.isExecuting, true);
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(transaction.diagnostics.failureReason, "no-valid-candidate");

  transaction.update(1 / 60);
  assert.equal(transaction.coupledDiagnostics.records.length, 0);

  restoration = { complete: true, succeeded: true };
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.state, "failed");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].failureReason, "body-motion-failed");
  assert.equal(transaction.coupledDiagnostics.records[0].restorationSucceeded, true);
});

test("explicit foot restoration failure is surfaced as non-recoverable", () => {
  const atomicStep = createAtomicStep();
  let restoration = { complete: false, succeeded: false };
  const bodyMotion = createBodyMotion({
    begin: () => ({ status: "complete" }),
    validateStablePose: () => ({
      status: "failed",
      message: "Full-load reach failed.",
    }),
  });
  bodyMotion.diagnostics.limitingConstraint = "full-load-strategic-reach-reserve";
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion,
    readFootRestoration: () => restoration,
  });

  enterFullLoadValidation(transaction, atomicStep);
  transaction.update(1 / 60);
  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);

  restoration = {
    complete: true,
    succeeded: false,
    message: "Could not restore L2 to its original semantic address and full load.",
  };
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.coupledDiagnostics.failureReason, "restoration-failed");
  assert.equal(transaction.diagnostics.failureReason, "restoration-failed");
  assert.equal(transaction.coupledDiagnostics.restorationSucceeded, false);
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].failureReason, "restoration-failed");
  assert.match(transaction.diagnostics.failureMessage, /Could not restore L2/);
  assert.equal(transaction.failureRecoveryMode, undefined);
});

test("failed transfer restoration times out explicitly without a retry-ready record", () => {
  const atomicStep = createAtomicStep();
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    config: { maximumRestorationWaitSeconds: 0.02 },
    bodyMotion: createBodyMotion({
      begin: () => ({ status: "complete" }),
      validateStablePose: () => ({
        status: "failed",
        message: "Full-load support failed.",
      }),
    }),
    readFootRestoration: () => ({ complete: false, succeeded: false }),
  });

  enterFullLoadValidation(transaction, atomicStep);
  transaction.update(1 / 60);
  transaction.update(0.011);
  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);

  transaction.update(0.011);
  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.diagnostics.failureReason, "restoration-failed");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.match(transaction.diagnostics.failureMessage, /did not complete within 0\.02 seconds/);
});

test("atomic restorationPending and exact observation both gate failed-transfer finalization", () => {
  const atomicStep = createAtomicStep();
  let restorationPending = true;
  let restoration = { complete: true, succeeded: true };
  const records = [];
  Object.defineProperty(atomicStep, "restorationPending", {
    get: () => restorationPending,
  });
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion: createBodyMotion(),
    readFootRestoration: () => restoration,
    onRecord: (record) => records.push(record),
  });

  beginPlannedTransfer(transaction);
  assert.equal(transaction.executePlannedStep(), true);
  atomicStep.setFailure("target-unreachable", "Target left the moving leg's reach.");
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.state, "loading");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(records.length, 0);

  restorationPending = false;
  restoration = { complete: false, succeeded: false };
  transaction.update(1 / 60);
  assert.equal(transaction.coupledDiagnostics.stage, "restoring");
  assert.equal(transaction.coupledDiagnostics.records.length, 0);
  assert.equal(records.length, 0);

  restoration = { complete: true, succeeded: true };
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.diagnostics.failureReason, "target-unreachable");
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.equal(transaction.coupledDiagnostics.records[0].restorationSucceeded, true);
  assert.equal(records.length, 1);
});

test("an executing failed transfer without an exact restoration observer fails closed", () => {
  const atomicStep = createAtomicStep();
  const transaction = new CoupledTransferTransaction({
    atomicStep,
    bodyMotion: createBodyMotion(),
  });

  beginPlannedTransfer(transaction);
  assert.equal(transaction.executePlannedStep(), true);
  atomicStep.setFailure("target-unreachable", "Target left the moving leg's reach.");
  transaction.update(1 / 60);

  assert.equal(transaction.coupledDiagnostics.stage, "failed");
  assert.equal(transaction.diagnostics.failureReason, "restoration-failed");
  assert.equal(transaction.coupledDiagnostics.restorationSucceeded, false);
  assert.equal(transaction.coupledDiagnostics.records.length, 1);
  assert.match(
    transaction.diagnostics.failureMessage,
    /Exact semantic foot-restoration observation is unavailable/,
  );
});

const ORIGINAL_ADDRESS = Object.freeze({ strandId: "approach", t: 0.25 });
const NEW_ADDRESS = Object.freeze({ strandId: "destination", t: 0.4 });
const DESTINATION = Object.freeze({ kind: "address", address: NEW_ADDRESS });

function beginPlannedTransfer(transaction) {
  assert.equal(transaction.requestDestination(DESTINATION, "plan-only"), true);
  assert.equal(transaction.coupledDiagnostics.stage, "planning-foot");
}

function enterFullLoadValidation(transaction, atomicStep) {
  beginPlannedTransfer(transaction);
  assert.equal(transaction.executePlannedStep(), true);
  assert.equal(transaction.coupledDiagnostics.stage, "transferring-foot");
  atomicStep.diagnostics.loadTransfer = transaction.config.partialLoadFactor;
  transaction.update(1 / 60);
  assert.equal(transaction.coupledDiagnostics.stage, "finishing-load");
  atomicStep.diagnostics.loadTransfer = 1;
  atomicStep.setState("body-advance");
}

function createAtomicStep({ onCancel = () => {} } = {}) {
  const diagnostics = {
    state: "idle",
    stateElapsedSeconds: 0,
    loadTransfer: 0,
    selectedPlan: null,
    failureReason: "none",
    failureMessage: "",
  };

  return {
    get state() {
      return diagnostics.state;
    },
    get isExecuting() {
      return !["idle", "planning", "complete", "failed"].includes(diagnostics.state);
    },
    diagnostics,
    requestDestination() {
      diagnostics.state = "planning";
      diagnostics.selectedPlan = {
        legId: "L2",
        currentContact: { address: ORIGINAL_ADDRESS },
        candidate: { address: NEW_ADDRESS },
      };
      return true;
    },
    executePlannedStep() {
      diagnostics.state = "loading";
      return true;
    },
    update(fixedDeltaSeconds) {
      diagnostics.stateElapsedSeconds += fixedDeltaSeconds;
    },
    cancel() {
      onCancel();
      diagnostics.state = "failed";
      diagnostics.failureReason = "cancelled";
      diagnostics.failureMessage = "Atomic transfer cancelled.";
    },
    setState(state) {
      diagnostics.state = state;
    },
    setFailure(reason, message) {
      diagnostics.state = "failed";
      diagnostics.failureReason = reason;
      diagnostics.failureMessage = message;
    },
    setLoadTransferHold() {},
    setCoupledBodyMotionCommitted() {},
  };
}

function createBodyMotion(overrides = {}) {
  return {
    diagnostics: createCoupledBodyMotionDiagnostics(),
    begin: () => ({ status: "running" }),
    update: () => ({ status: "running" }),
    cancelAndRestore: () => true,
    ...overrides,
  };
}
