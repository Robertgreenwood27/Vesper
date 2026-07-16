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
  boundedStrategyAlternativeAvailable,
  selectTransitionStrategy,
  TransitionStrategyController,
} = await vite.ssrLoadModule(
  "/src/spider/traversal/TransitionStrategyController.ts",
);

after(async () => {
  await vite.close();
});

test("strategy selection uses route geometry rather than scenario identity", () => {
  assert.equal(selectTransitionStrategy({
    hasJunction: false,
    transitionPlaneTurnRadians: Math.PI,
  }), "ordinary-traverse");
  assert.equal(selectTransitionStrategy({
    hasJunction: true,
    transitionPlaneTurnRadians: 0.213890338,
  }), "junction-forward");
  assert.equal(selectTransitionStrategy({
    hasJunction: true,
    transitionPlaneTurnRadians: 0.549505,
  }), "roll-under");
});

test("junction-forward keeps generic contacts with a forward leg-band preference", () => {
  const controller = new TransitionStrategyController("junction-forward");
  assert.equal(controller.directive().stage, "approach-junction");
  assert.equal(controller.directive().contactGoal, "route-progress");

  controller.observe(progress({ bodyProgress: 1 }), phase(), 0);
  assert.equal(
    controller.directive().stage,
    "approach-junction",
    "progress metrics do not replace the junction phase gate",
  );
  controller.observe(progress({ bodyProgress: 1 }), phase({ junctionEncountered: true }), 1);
  const transfer = controller.directive();
  assert.equal(transfer.stage, "transfer-forward");
  assert.equal(transfer.contactGoal, "route-progress");
  assert.deepEqual(transfer.preferredLegRegions, ["front", "middle"]);
  assert.deepEqual(controller.diagnostics.phase, {
    junctionEncountered: true,
    bodyCenterBeyondJunction: false,
  });
  assert.equal(
    transfer.preferredLegRegions.some((region) => /^[LR][1-4]$/.test(region)),
    false,
    "strategy preferences are anatomical bands, never exact leg IDs",
  );

  controller.observe(
    progress({ bodyProgress: 1 }),
    phase({ junctionEncountered: true, bodyCenterBeyondJunction: true }),
    2,
  );
  assert.equal(controller.directive().stage, "resume-generic");
});

test("roll-under advances through bounded posture and support stages", () => {
  const controller = new TransitionStrategyController("roll-under");
  assert.equal(controller.directive().stage, "approach-junction");
  controller.observe(progress(), phase({ junctionEncountered: true }), 0);
  assert.equal(controller.directive().stage, "establish-new-plane");
  assert.deepEqual(controller.directive().preferredLegRegions, ["front", "middle"]);

  controller.observe(
    progress({ newPlaneContactCount: 2 }),
    phase({ junctionEncountered: true }),
    1,
  );
  assert.equal(controller.directive().stage, "rotate-and-build");
  controller.observe(progress({
    newPlaneContactCount: 4,
    branchFrameAlignmentRadians: 0.1,
  }), phase({ junctionEncountered: true }), 2);
  assert.equal(controller.directive().stage, "advance-under");
  controller.observe(progress({
    newPlaneContactCount: 6,
    branchFrameAlignmentRadians: 0.08,
    bodyProgress: 0.31,
    trailingSupportCount: 3,
    oldPlaneContactCount: 3,
  }), phase({ junctionEncountered: true }), 3);
  assert.equal(controller.directive().stage, "clear-old-plane");
  controller.observe(progress({
    newPlaneContactCount: 8,
    branchFrameAlignmentRadians: 0.07,
    bodyProgress: 0.5,
    trailingSupportCount: 0,
    oldPlaneContactCount: 0,
  }), phase({ junctionEncountered: true }), 4);
  assert.equal(controller.directive().stage, "resume-generic");
  assert.equal(controller.directive().failed, false);
});

test("roll-under approach remains generic until the junction is encountered", () => {
  const controller = new TransitionStrategyController("roll-under", {
    maximumStagnantTransactions: 2,
    maximumStageTransactions: 3,
  });
  controller.observe(progress(), phase(), 0);
  for (let sequence = 1; sequence <= 8; sequence += 1) {
    controller.observe(progress(), phase(), sequence);
  }
  assert.equal(controller.directive().stage, "approach-junction");
  assert.equal(controller.directive().failed, false);
});

test("rotate-and-build interleaves generic contacts with procedural rotation", () => {
  const controller = new TransitionStrategyController("roll-under");
  controller.observe(progress(), phase({ junctionEncountered: true }), 0);
  controller.observe(progress({
    newPlaneContactCount: 2,
    branchFrameAlignmentRadians: 0.5,
  }), phase({ junctionEncountered: true }), 1);
  assert.equal(controller.directive().stage, "rotate-and-build");
  assert.equal(controller.directive().contactGoal, "new-plane");
  assert.equal(controller.directive().bodyGoal, "rotate");
  assert.equal(controller.directive().rotationScale, 0.35);

  controller.observe(progress({
    newPlaneContactCount: 3,
    branchFrameAlignmentRadians: 0.5,
  }), phase({ junctionEncountered: true }), 2);
  assert.equal(controller.directive().stage, "rotate-and-build");
  assert.equal(controller.directive().contactGoal, "route-progress");
  assert.equal(controller.directive().rotationScale, 1);

  controller.observe(progress({
    newPlaneContactCount: 3,
    branchFrameAlignmentRadians: 0.05,
  }), phase({ junctionEncountered: true }), 3);
  assert.equal(controller.directive().stage, "advance-under");
  assert.equal(controller.directive().contactGoal, "route-progress");
  assert.equal(controller.directive().bodyGoal, "advance");
});

test("clear-old-plane advances support geometry before requiring trailing transfer", () => {
  const controller = new TransitionStrategyController("roll-under");
  controller.observe(progress(), phase({ junctionEncountered: true }), 0);
  controller.observe(progress({
    newPlaneContactCount: 4,
    branchFrameAlignmentRadians: 0.05,
  }), phase({ junctionEncountered: true }), 1);
  controller.observe(progress({
    newPlaneContactCount: 5,
    branchFrameAlignmentRadians: 0.05,
    trailingSupportCount: 2,
    oldPlaneContactCount: 2,
    bodyProgress: 0,
  }), phase({ junctionEncountered: true }), 2);
  assert.equal(controller.directive().stage, "advance-under");
  controller.observe(progress({
    newPlaneContactCount: 5,
    branchFrameAlignmentRadians: 0.05,
    trailingSupportCount: 2,
    oldPlaneContactCount: 2,
    bodyProgress: 0,
  }), phase({ junctionEncountered: true }), 3);
  assert.equal(controller.directive().stage, "clear-old-plane");
  assert.equal(controller.directive().contactGoal, "route-progress");
  assert.equal(controller.directive().translationScale, 1);

  controller.observe(progress({
    newPlaneContactCount: 5,
    branchFrameAlignmentRadians: 0.05,
    trailingSupportCount: 2,
    oldPlaneContactCount: 2,
    bodyProgress: 0.31,
  }), phase({ junctionEncountered: true }), 4);
  assert.equal(controller.directive().contactGoal, "trailing-relief");
  assert.equal(controller.directive().translationScale, 0.35);
});

test("reach warning changes the stage preference without creating recovery mode", () => {
  const controller = new TransitionStrategyController("roll-under");
  controller.observe(progress(), phase({ junctionEncountered: true }), 0);
  controller.observe(
    progress({ worstReachRatio: 0.98 }),
    phase({ junctionEncountered: true }),
    1,
  );
  const directive = controller.directive();
  assert.equal(directive.reachReliefRequired, true);
  assert.equal(directive.contactGoal, "trailing-relief");
  assert.deepEqual(directive.preferredLegRegions, ["rear", "middle", "front"]);
  assert.equal(directive.bodyGoal, "hold");
  assert.equal(directive.translationScale, 0);
  assert.equal(directive.rotationScale, 0);
});

test("junction-forward requests dynamic reach relief while holding the body", () => {
  const controller = new TransitionStrategyController("junction-forward");
  controller.observe(progress({ worstReachRatio: 0.98 }), phase(), 0);
  assert.equal(controller.directive().contactGoal, "route-progress");
  assert.equal(controller.directive().reachReliefRequired, false);
  controller.observe(
    progress({ worstReachRatio: 0.98 }),
    phase({ junctionEncountered: true }),
    1,
  );
  const directive = controller.directive();
  assert.equal(directive.stage, "transfer-forward");
  assert.equal(directive.contactGoal, "trailing-relief");
  assert.equal(directive.bodyGoal, "hold");
  assert.equal(directive.translationScale, 0);

  controller.observe(progress({
    worstReachRatio: 0.98,
  }), phase({ junctionEncountered: true, bodyCenterBeyondJunction: true }), 2);
  assert.equal(controller.directive().stage, "resume-generic");
  assert.equal(controller.directive().contactGoal, "trailing-relief");
  assert.equal(controller.directive().bodyGoal, "hold");
});

test("old- and new-plane contacts are distinct progress signals", () => {
  const controller = new TransitionStrategyController("roll-under");
  const encountered = phase({ junctionEncountered: true });
  controller.observe(progress(), encountered, 0);

  controller.observe(progress({ oldPlaneContactCount: 7 }), encountered, 1);
  assert.equal(controller.directive().stage, "establish-new-plane");
  assert.equal(controller.diagnostics.stagnantTransactionCount, 0);
  assert.equal(controller.diagnostics.progress.oldPlaneContactCount, 7);
  assert.equal(controller.diagnostics.progress.trailingSupportCount, 8);

  controller.observe(progress({
    oldPlaneContactCount: 7,
    newPlaneContactCount: 1,
  }), encountered, 2);
  assert.equal(controller.directive().stage, "establish-new-plane");
  assert.equal(controller.diagnostics.stagnantTransactionCount, 0);
  assert.deepEqual(
    Object.keys(controller.diagnostics.progress).sort(),
    [
      "bodyProgress",
      "branchFrameAlignmentRadians",
      "newPlaneContactCount",
      "oldPlaneContactCount",
      "trailingSupportCount",
      "worstReachRatio",
    ],
  );

  controller.observe(progress({
    oldPlaneContactCount: 7,
    newPlaneContactCount: 1,
  }), encountered, 3);
  assert.equal(controller.diagnostics.stagnantTransactionCount, 1);
});

test("strategy alternatives use the coordinator's one-based attempt number", () => {
  assert.equal(boundedStrategyAlternativeAvailable(1, 1), true);
  assert.equal(boundedStrategyAlternativeAvailable(2, 1), false);
  assert.deepEqual(
    [1, 2, 3, 4].map((attempt) =>
      boundedStrategyAlternativeAvailable(attempt, 3)),
    [true, true, true, false],
  );
});

test("one roll-under stage fails after a bounded stagnant alternative set", () => {
  const controller = new TransitionStrategyController("roll-under", {
    maximumStagnantTransactions: 3,
  });
  const encountered = phase({ junctionEncountered: true });
  controller.observe(progress(), encountered, 0);
  controller.observe(progress(), encountered, 1);
  controller.observe(progress(), encountered, 2);
  controller.observe(progress(), encountered, 3);
  const exhausted = controller.observe(progress(), encountered, 4);
  assert.equal(exhausted.failed, true);
  assert.match(exhausted.failureReason, /establish-new-plane exhausted/);
  assert.equal(
    controller.observe(progress(), phase(), 3).failed,
    true,
    "same sequence is idempotent",
  );
});

function progress(overrides = {}) {
  return {
    branchFrameAlignmentRadians: 1,
    oldPlaneContactCount: 8,
    newPlaneContactCount: 0,
    worstReachRatio: 0.8,
    bodyProgress: 0,
    trailingSupportCount: 8,
    ...overrides,
  };
}

function phase(overrides = {}) {
  return {
    junctionEncountered: false,
    bodyCenterBeyondJunction: false,
    ...overrides,
  };
}
