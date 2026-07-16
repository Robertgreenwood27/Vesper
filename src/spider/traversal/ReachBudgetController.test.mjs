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
const { ReachBudgetController } = await vite.ssrLoadModule(
  "/src/spider/traversal/ReachBudgetController.ts",
);

after(async () => {
  await vite.close();
});

test("worst-reach worsening requires an explicit corrective override", () => {
  const controller = new ReachBudgetController({
    fractionSamples: [0.1, 1],
    worstReachWorseningTolerance: 0.005,
    minimumUsefulTranslation: 0.0001,
  });
  const request = {
    currentFrame: frame(0),
    targetFrame: frame(0.045),
    contacts: [contactAtCurrentRatio(0.953)],
    support: () => true,
    clearance: () => true,
    usefulness: () => true,
  };

  const strict = controller.search(request);
  const strictSmall = candidateAtFraction(strict, 0.1);
  const strictFull = candidateAtFraction(strict, 1);

  assert.equal(strictSmall.accepted, true);
  assert.ok(strictSmall.budget.worstPredictedReachRatio <= 0.958 + 1e-12);
  assert.equal(strictFull.budget.worstPredictedReachRatio, 0.998);
  assert.equal(strictFull.accepted, false);
  assert.equal(strictFull.limitingConstraint, "worst-reach-worsened");

  const corrective = controller.search({
    ...request,
    allowCorrectiveWorstReachWorsening: () => true,
  });
  const correctiveFull = candidateAtFraction(corrective, 1);
  assert.equal(correctiveFull.budget.worstPredictedReachRatio, 0.998);
  assert.equal(correctiveFull.accepted, true);
  assert.equal(correctiveFull.limitingConstraint, "none");
});

test("a corrective worsening override cannot waive anatomical hard reach", () => {
  const controller = new ReachBudgetController({
    fractionSamples: [1],
    worstReachWorseningTolerance: 0.005,
    minimumUsefulTranslation: 0.0001,
  });
  const result = controller.search({
    currentFrame: frame(0),
    targetFrame: frame(0.057),
    contacts: [contactAtCurrentRatio(0.953)],
    support: () => true,
    clearance: () => true,
    usefulness: () => true,
    allowCorrectiveWorstReachWorsening: () => true,
  });
  const full = candidateAtFraction(result, 1);

  assert.ok(full.budget.worstPredictedReachRatio > 1);
  assert.equal(full.accepted, false);
  assert.equal(full.limitingConstraint, "hard-maximum-reach");
  assert.equal(result.success, false);
});

function frame(x) {
  return {
    position: { x, y: 0, z: 0 },
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    forward: { x: 0, y: 0, z: -1 },
  };
}

function contactAtCurrentRatio(ratio) {
  return {
    legId: "L1",
    planted: true,
    contactWorldPosition: { x: -ratio, y: 0, z: 0 },
    reachOriginWorldPosition: { x: 0, y: 0, z: 0 },
    minimumReach: 0,
    comfortableReach: 0.7,
    maximumReach: 1,
    loadFactor: 1,
    trailing: false,
  };
}

function candidateAtFraction(result, fraction) {
  const candidate = result.candidates.find(
    (entry) => Math.abs(entry.translationFraction - fraction) <= 1e-12,
  );
  assert.ok(candidate, `missing translation fraction ${fraction}`);
  return candidate;
}
