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
const { LegSelector } = await vite.ssrLoadModule(
  "/src/spider/locomotion/LegSelector.ts",
);

after(async () => {
  await vite.close();
});

test("a required contact objective selects its lower-scored candidate", () => {
  const selector = new LegSelector();
  const current = makeCandidate({
    source: "current-contact",
    isCurrentContact: true,
    strandId: "old-plane",
    t: 0.4,
    score: 10,
    progress: 0,
  });
  const higherScoredNonObjective = makeCandidate({
    strandId: "new-plane",
    t: 0.7,
    score: 24,
    progress: 0.5,
  });
  const lowerScoredObjective = makeCandidate({
    strandId: "old-plane",
    t: 0.55,
    score: 2,
    progress: -0.25,
  });
  const calls = [];

  const result = selector.select(makeRequest([
    current,
    higherScoredNonObjective,
    lowerScoredObjective,
  ], {
    candidateObjective: (leg, currentContact, candidate) => {
      calls.push({
        legId: leg.legId,
        current: currentContact.address.strandId,
        candidate: candidate.address.strandId,
      });
      return candidate.address.strandId === "old-plane";
    },
  }));

  assert.equal(result.selection?.candidate, lowerScoredObjective);
  assert.equal(result.selection?.scoreImprovement, -8);
  assert.equal(
    calls.some((call) => call.candidate === "new-plane"),
    true,
  );
  assert.equal(
    calls.some((call) => call.candidate === "old-plane"),
    true,
  );
  assert.deepEqual(result.diagnostics[0].reasons, []);
});

test("a required contact objective cannot bypass minimum support spacing", () => {
  const selector = new LegSelector();
  const current = makeCandidate({
    source: "current-contact",
    isCurrentContact: true,
    strandId: "old-plane",
    t: 0.4,
    score: 10,
    progress: 0,
  });
  const crowdedObjective = makeCandidate({
    strandId: "old-plane",
    t: 0.55,
    score: 20,
    progress: 0.4,
    nearestSupportDistance: 0.05,
  });

  const result = selector.select(makeRequest([current, crowdedObjective], {
    candidateObjective: (_leg, _currentContact, candidate) =>
      candidate === crowdedObjective,
    minimumSupportSpacing: 0.2,
  }));

  assert.equal(result.selection, null);
  assert.equal(
    result.diagnostics[0].reasons.includes("support-spacing-too-narrow"),
    true,
  );
});

test("diagnostics distinguish an unsatisfied candidate objective", () => {
  const selector = new LegSelector();
  const current = makeCandidate({
    source: "current-contact",
    isCurrentContact: true,
    strandId: "old-plane",
    t: 0.4,
    score: 10,
    progress: 0,
  });
  const otherwiseValid = makeCandidate({
    strandId: "new-plane",
    t: 0.7,
    score: 24,
    progress: 0.5,
  });

  const result = selector.select(makeRequest([current, otherwiseValid], {
    candidateObjective: () => false,
  }));

  assert.equal(result.selection, null);
  assert.equal(
    result.diagnostics[0].reasons.includes("candidate-objective-unsatisfied"),
    true,
  );
  assert.equal(
    result.diagnostics[0].reasons.includes("no-current-contact-improvement"),
    false,
  );
});

test("a bounded strategy may fall back to ordinary support rebalancing", () => {
  const selector = new LegSelector();
  const current = makeCandidate({
    source: "current-contact",
    isCurrentContact: true,
    strandId: "old-plane",
    t: 0.4,
    score: 10,
    progress: 0,
  });
  const genericRebalance = makeCandidate({
    strandId: "old-plane",
    t: 0.58,
    score: 12,
    progress: 0.18,
  });

  const result = selector.select(makeRequest([current, genericRebalance], {
    candidateObjective: () => false,
    allowGenericCandidateFallback: true,
  }));

  assert.equal(result.selection?.candidate, genericRebalance);
  assert.equal(
    result.diagnostics[0].reasons.includes("candidate-objective-unsatisfied"),
    false,
  );
});

function makeRequest(candidates, optionOverrides = {}) {
  return {
    intent: {
      desiredDirection: { x: 1, y: 0, z: 0 },
    },
    candidates,
    legs: ["L1", "L2", "L3", "L4", "R1", "R2"].map((legId, index) => ({
      legId,
      planted: true,
      loaded: true,
      valid: true,
      address: { strandId: `support-${legId}`, t: 0.5 },
      contactPosition: { x: 0, y: index * 0.1, z: 0 },
      reachOriginWorldPosition: { x: 0, y: index * 0.1, z: 0 },
      maximumReach: 10,
      currentReachRatio: 0,
    })),
    options: {
      minimumSupportFootCount: 5,
      minimumScoreImprovement: 0.05,
      minimumProgressImprovement: 0.02,
      maximumRemainingReachRatio: 1,
      expectedBodyAdvanceDistance: 0,
      minimumSupportSpacing: 0.2,
      maximumSupportSpacingLoss: 0.15,
      ...optionOverrides,
    },
  };
}

function makeCandidate({
  source = "local-sample",
  isCurrentContact = false,
  strandId,
  t,
  score,
  progress,
  nearestSupportDistance = 0.5,
}) {
  return {
    legId: "L1",
    address: { strandId, t },
    strandId,
    t,
    source,
    isCurrentContact,
    worldPosition: { x: t, y: 0, z: 0 },
    tangent: { x: 1, y: 0, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    binormal: { x: 0, y: 0, z: 1 },
    strandVelocity: { x: 0, y: 0, z: 0 },
    localTension: 1,
    reachDistance: 1,
    reachRatio: 0.5,
    progressTowardDestination: progress,
    distanceFromFootHome: 0,
    approximateSupportContribution: 1,
    nearestSupportDistance,
    signals: {
      supportSpacing: 0.8,
    },
    rejectionReasons: [],
    rejectionDetails: [],
    score: {
      total: score,
      positive: score,
      negative: 0,
      scored: true,
      valid: true,
      components: {},
    },
  };
}
