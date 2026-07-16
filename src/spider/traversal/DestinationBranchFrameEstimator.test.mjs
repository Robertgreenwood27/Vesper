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
  bodyNearDestinationInSemanticBranchFrame,
  createDestinationBranchFrameEstimate,
  DestinationBranchFrameEstimator,
} = await vite.ssrLoadModule(
  "/src/spider/traversal/DestinationBranchFrameEstimator.ts",
);
const { createPhaseEightFixture } = await vite.ssrLoadModule(
  "/src/web/createPhaseEightFixture.ts",
);
const { labConfig } = await vite.ssrLoadModule("/src/config.ts");

after(async () => {
  await vite.close();
});

test("an invalid destination frame cannot masquerade as aligned", () => {
  const estimate = createDestinationBranchFrameEstimate();

  assert.equal(estimate.valid, false);
  assert.equal(estimate.totalAngularErrorRadians, Math.PI);
});

test("destination and companion rails define an angled sign-continuous frame", () => {
  const fixture = createAngledRailTraversal();
  const estimator = new DestinationBranchFrameEstimator(fixture.traversal);
  const request = makeRequest(["companion"]);

  const first = estimator.estimate(request);

  assert.equal(first.valid, true, first.message);
  assert.equal(first.usedCompanionGeometry, true);
  assert.equal(first.usedParallelTransportFallback, false);
  assert.equal(first.companionStrandId, "companion");
  assert.deepEqual(first.sampleAddress, { strandId: "destination", t: 0.3 });
  assertVectorClose(first.frame.forward, unit({ x: 1, y: -1, z: 0 }));
  assertVectorClose(first.frame.right, { x: 0, y: 0, z: 1 });
  assertVectorClose(first.frame.up, unit({ x: 1, y: 1, z: 0 }));
  assert.ok(close(first.totalAngularErrorRadians, Math.PI / 4));
  assert.ok(close(first.forwardErrorRadians, Math.PI / 4));
  assert.ok(close(first.pitchErrorRadians, Math.PI / 4));
  assert.equal(first.frameSignContinuous, true);

  fixture.setCompanionSide(-1);
  const second = estimator.estimate(request);

  assert.equal(second.valid, true, second.message);
  assert.equal(second.flippedForSignContinuity, true);
  assert.ok(dot(first.frame.up, second.frame.up) > 0.999999);
  assert.ok(dot(first.frame.right, second.frame.right) > 0.999999);
  assertOrthonormal(second.frame);
});

test("missing companion geometry parallel-transports the caller's local frame", () => {
  const fixture = createAngledRailTraversal();
  const estimator = new DestinationBranchFrameEstimator(fixture.traversal);
  const estimate = estimator.estimate({
    ...makeRequest([]),
    currentBodyFrame: {
      position: { x: 0.3, y: -0.3, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
  });

  assert.equal(estimate.valid, true, estimate.message);
  assert.equal(estimate.usedCompanionGeometry, false);
  assert.equal(estimate.usedParallelTransportFallback, true);
  assertVectorClose(estimate.frame.forward, unit({ x: 1, y: -1, z: 0 }));
  assertVectorClose(estimate.frame.up, { x: 0, y: 0, z: 1 });
  assertVectorClose(estimate.frame.right, unit({ x: -1, y: -1, z: 0 }));
  assertOrthonormal(estimate.frame);
});

test("non-coplanar arrival measures forward separation without discarding thorax standoff", () => {
  const undersidePose = {
    worldDistance: 0.8756414794875498,
    signedForwardSeparation: 0.4817836426585227,
    destinationRadius: 0.48,
    arrivalWorldTolerance: 0.3,
    nonCoplanarTransition: true,
    routeComplete: true,
    frameValid: true,
    frameSignContinuous: true,
  };
  assert.equal(
    bodyNearDestinationInSemanticBranchFrame(undersidePose),
    true,
    "the normal support-plane standoff must not mask semantic forward arrival",
  );
  assert.equal(bodyNearDestinationInSemanticBranchFrame({
    ...undersidePose,
    routeComplete: false,
  }), false);
  assert.equal(bodyNearDestinationInSemanticBranchFrame({
    ...undersidePose,
    nonCoplanarTransition: false,
  }), false, "coplanar routes retain the direct world-distance rule");
  assert.equal(bodyNearDestinationInSemanticBranchFrame({
    ...undersidePose,
    frameValid: false,
  }), false);
  assert.equal(bodyNearDestinationInSemanticBranchFrame({
    ...undersidePose,
    frameSignContinuous: false,
  }), false);
  assert.equal(bodyNearDestinationInSemanticBranchFrame({
    ...undersidePose,
    worldDistance: 0.78,
    nonCoplanarTransition: false,
    routeComplete: false,
    frameValid: false,
    frameSignContinuous: false,
  }), true, "the existing world-distance path remains authoritative");
  for (const signedForwardSeparation of [0.78, -0.78]) {
    assert.equal(bodyNearDestinationInSemanticBranchFrame({
      ...undersidePose,
      signedForwardSeparation,
    }), true, "semantic arrival includes either exact signed boundary");
  }
  for (const signedForwardSeparation of [0.781, -0.781]) {
    assert.equal(bodyNearDestinationInSemanticBranchFrame({
      ...undersidePose,
      signedForwardSeparation,
    }), false, "semantic arrival rejects either direction outside the boundary");
  }
  for (const invalid of [
    { worldDistance: -1 },
    { worldDistance: Number.NaN },
    { destinationRadius: -0.1 },
    { destinationRadius: Number.POSITIVE_INFINITY },
    { arrivalWorldTolerance: -0.1 },
    { arrivalWorldTolerance: Number.NaN },
  ]) {
    assert.equal(bodyNearDestinationInSemanticBranchFrame({
      ...undersidePose,
      ...invalid,
    }), false, "invalid distance inputs fail closed");
  }
});

test("authored semantic rail planes distinguish forward and underside transitions", () => {
  const fixture = createPhaseEightFixture(labConfig);
  assert.equal(fixture.branches.forward.nonCoplanarTransition, false);
  assert.equal(fixture.branches.angled.nonCoplanarTransition, true);
  assert.ok(fixture.branches.forward.transitionPlaneTurnRadians < Math.PI / 12);
  assert.ok(fixture.branches.angled.transitionPlaneTurnRadians >= Math.PI / 12);
});

function makeRequest(companionSupportStrandIds) {
  return {
    route: {
      start: { strandId: "approach", t: 0.8 },
      requestedDestination: {
        kind: "address",
        address: { strandId: "destination", t: 1 },
      },
      destinationAddress: { strandId: "destination", t: 1 },
      destinationPosition: { x: 1, y: -1, z: 0 },
      materialDistance: 1,
      legs: [{
        strandId: "destination",
        fromT: 0,
        toT: 1,
        materialDistance: 1,
        entryNodeId: "junction",
        exitNodeId: "destination-end",
      }],
      transitions: [{
        nodeId: "junction",
        fromStrandId: "approach",
        toStrandId: "destination",
      }],
      strandIds: ["approach", "destination"],
    },
    junctionNodeId: "junction",
    destinationBranchStrandId: "destination",
    companionSupportStrandIds,
    currentBodyFrame: {
      position: { x: 0.3, y: -0.3, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
    },
    sampleAddress: { strandId: "destination", t: 0.3 },
    lookaheadMaterialDistance: 0,
  };
}

function createAngledRailTraversal() {
  let companionSide = 1;
  const junction = node("junction");
  const definitions = new Map([
    ["destination", {
      id: "destination",
      active: true,
      broken: false,
      totalRestLength: Math.SQRT2,
      startNode: junction,
      endNode: node("destination-end"),
      point: (t) => ({ x: t, y: -t, z: 0 }),
    }],
    ["companion", {
      id: "companion",
      active: true,
      broken: false,
      totalRestLength: Math.SQRT2,
      startNode: node("companion-start"),
      endNode: node("companion-end"),
      point: (t) => ({ x: t, y: -t, z: companionSide }),
    }],
  ]);

  const traversal = {
    getStrand(strandId) {
      return definitions.get(strandId);
    },
    getWorldPosition(address, out = {}) {
      const strand = definitions.get(address.strandId);
      if (!strand) throw new Error(`Unknown strand ${address.strandId}.`);
      return Object.assign(out, strand.point(clamp01(address.t)));
    },
    findClosestPoint(target, options = {}) {
      let best = null;
      const allowed = options.strandIds ?? new Set(definitions.keys());
      for (const strandId of allowed) {
        const strand = definitions.get(strandId);
        if (!strand || !strand.active || strand.broken) continue;
        const start = strand.point(0);
        const end = strand.point(1);
        const delta = subtract(end, start);
        const denominator = dot(delta, delta);
        const t = clamp01(dot(subtract(target, start), delta) / denominator);
        const position = strand.point(t);
        const distance = Math.hypot(
          target.x - position.x,
          target.y - position.y,
          target.z - position.z,
        );
        if (!best || distance < best.distance) {
          best = {
            address: { strandId, t },
            position,
            distance,
          };
        }
      }
      return best;
    },
  };

  return {
    traversal,
    setCompanionSide(side) {
      companionSide = side;
    },
  };
}

function node(id) {
  return { id, connectedStrandIds: new Set() };
}

function assertOrthonormal(frame) {
  for (const axis of [frame.forward, frame.up, frame.right]) {
    assert.ok(close(Math.hypot(axis.x, axis.y, axis.z), 1));
  }
  assert.ok(close(dot(frame.forward, frame.up), 0));
  assert.ok(close(dot(frame.forward, frame.right), 0));
  assert.ok(close(dot(frame.up, frame.right), 0));
}

function assertVectorClose(actual, expected) {
  assert.ok(close(actual.x, expected.x), `x: ${actual.x} != ${expected.x}`);
  assert.ok(close(actual.y, expected.y), `y: ${actual.y} != ${expected.y}`);
  assert.ok(close(actual.z, expected.z), `z: ${actual.z} != ${expected.z}`);
}

function unit(vector) {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  return {
    x: vector.x / magnitude,
    y: vector.y / magnitude,
    z: vector.z / magnitude,
  };
}

function subtract(left, right) {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}

function dot(left, right) {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function close(left, right, tolerance = 1e-8) {
  return Math.abs(left - right) <= tolerance;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}
