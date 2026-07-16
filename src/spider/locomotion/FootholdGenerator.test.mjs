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
const { FootholdGenerator } = await vite.ssrLoadModule(
  "/src/spider/locomotion/FootholdGenerator.ts",
);

after(async () => {
  await vite.close();
});

test("continuous semantic seeds add their bounded material neighborhood", () => {
  const traversal = createLinearTraversal([
    ["support-a", 0],
  ]);
  const validatorAddresses = [];
  const result = new FootholdGenerator(traversal).generate(makeRequest(traversal, {
    candidateSeeds: [{
      kind: "continuous-address",
      legId: "L1",
      source: "connected-support",
      address: { strandId: "support-a", t: 0.37 },
      neighborMaterialRadius: 0.08,
    }],
    candidateValidator: (_leg, address) => {
      validatorAddresses.push(`${address.strandId}@${address.t.toFixed(2)}`);
      return { valid: true };
    },
  }));

  const seeded = result.candidates.filter(
    (candidate) => candidate.source === "connected-support",
  );
  assert.deepEqual(
    seeded.map((candidate) => [candidate.address.strandId, round(candidate.t)]),
    [
      ["support-a", 0.37],
      ["support-a", 0.29],
      ["support-a", 0.45],
    ],
  );
  assert.ok(seeded.every((candidate) => candidate.rejectionReasons.length === 0));
  assert.deepEqual(
    validatorAddresses.filter((address) => ["support-a@0.37", "support-a@0.29", "support-a@0.45"].includes(address)),
    ["support-a@0.37", "support-a@0.29", "support-a@0.45"],
  );
});

test("world seeds project only onto explicitly authorized strands", () => {
  const traversal = createLinearTraversal([
    ["support-a", 0],
    ["support-b", 1],
    ["unrelated-c", 2],
  ]);
  const result = new FootholdGenerator(traversal).generate(makeRequest(traversal, {
    candidateSeeds: [{
      kind: "world-position",
      legId: "L1",
      source: "destination-contact-frame",
      worldPosition: { x: 0.62, y: 1, z: 0 },
      authorizedStrandIds: ["support-b", "support-b"],
      neighborMaterialRadius: 0.1,
    }],
  }));

  const seeded = result.candidates.filter(
    (candidate) => candidate.source === "destination-contact-frame",
  );
  assert.deepEqual(
    seeded.map((candidate) => [candidate.address.strandId, round(candidate.t)]),
    [
      ["support-b", 0.62],
      ["support-b", 0.52],
      ["support-b", 0.72],
    ],
  );
  assert.ok(seeded.every((candidate) => candidate.strandId === "support-b"));
  assert.equal(
    result.candidates.some(
      (candidate) => candidate.source === "destination-contact-frame" &&
        candidate.strandId === "unrelated-c",
    ),
    false,
  );
});

test("predicted body-advance seeds remain subject to every hard candidate gate", () => {
  const traversal = createLinearTraversal([
    ["support-a", 0],
    ["support-b", 1],
    ["unrelated-c", 2],
  ]);
  const result = new FootholdGenerator(traversal).generate(makeRequest(traversal, {
    legs: [{
      legId: "L1",
      footHomeWorldPosition: { x: 0.1, y: 0, z: 0 },
      reachOriginWorldPosition: { x: 0.1, y: 0, z: 0 },
      reach: { min: 0, comfortable: 0.15, max: 0.2 },
      reachScale: 1,
      currentAddress: { strandId: "support-a", t: 0.1 },
      currentWorldPosition: { x: 0.1, y: 0, z: 0 },
    }],
    candidateSeeds: [{
      kind: "world-position",
      legId: "L1",
      source: "predicted-body-advance-foot-home",
      worldPosition: { x: 0.62, y: 1, z: 0 },
      authorizedStrandIds: ["support-b"],
      neighborMaterialRadius: 0.05,
    }],
    jointFeasibility: (_leg, address) => ({
      feasible: address.t < 0.6,
      violation: address.t >= 0.6 ? 1 : 0,
      reason: "Injected hard joint envelope.",
    }),
    candidateValidator: (_leg, address) => ({
      valid: Math.abs(address.t - 0.57) > 1e-9,
      reason: "Injected semantic gate.",
    }),
  }));

  const seeded = result.candidates.filter(
    (candidate) => candidate.source === "predicted-body-advance-foot-home",
  );
  assert.deepEqual(
    seeded.map((candidate) => [candidate.strandId, round(candidate.t)]),
    [["support-b", 0.62], ["support-b", 0.57], ["support-b", 0.67]],
  );
  assert.ok(seeded.every((candidate) =>
    candidate.rejectionReasons.includes("outside-maximum-reach")));
  assert.ok(seeded.some((candidate) =>
    candidate.rejectionReasons.includes("impossible-joint-configuration")));
  assert.ok(seeded.some((candidate) =>
    candidate.rejectionReasons.includes("custom-candidate-rejection")));
  assert.equal(seeded.some((candidate) => candidate.strandId === "unrelated-c"), false);
});

test("omitting semantic seeds preserves the original FootHome candidate set", () => {
  const traversal = createLinearTraversal([
    ["support-a", 0],
    ["support-b", 0.45],
  ]);
  const generator = new FootholdGenerator(traversal);
  const omitted = generator.generate(makeRequest(traversal));
  const explicitlyEmpty = generator.generate(makeRequest(traversal, {
    candidateSeeds: [],
  }));

  assert.deepEqual(candidateSnapshot(omitted), candidateSnapshot(explicitlyEmpty));
  assert.ok(omitted.candidates.every((candidate) => [
    "current-contact",
    "nearest-home",
    "local-sample",
    "route-target",
  ].includes(candidate.source)));
});

function makeRequest(traversal, overrides = {}) {
  const currentAddress = { strandId: "support-a", t: 0.1 };
  const currentWorldPosition = traversal.getWorldPosition(currentAddress, {});
  return {
    intent: {
      destinationPosition: { x: 1, y: 0, z: 0 },
      desiredDirection: { x: 1, y: 0, z: 0 },
    },
    legs: [{
      legId: "L1",
      footHomeWorldPosition: { x: 0.1, y: 0, z: 0 },
      reachOriginWorldPosition: { x: 0.1, y: 0, z: 0 },
      reach: { min: 0, comfortable: 1, max: 3 },
      reachScale: 1,
      currentAddress,
      currentWorldPosition,
    }],
    supports: [],
    supportFrame: {
      center: { x: 0.1, y: 0, z: 0 },
      forward: { x: 1, y: 0, z: 0 },
      up: { x: 0, y: 1, z: 0 },
      right: { x: 0, y: 0, z: 1 },
    },
    options: {
      searchRadius: 2.25,
      samplesPerStrand: 2,
      retainRejected: true,
      minimumFootSpacing: 0.1,
    },
    jointFeasibility: () => ({ feasible: true, violation: 0 }),
    candidateValidator: () => ({ valid: true }),
    ...overrides,
  };
}

function createLinearTraversal(definitions) {
  const strands = new Map();
  const nodes = new Map();
  for (const [id, y] of definitions) {
    const startNode = {
      id: `${id}-start`,
      connectedStrandIds: new Set([id]),
    };
    const endNode = {
      id: `${id}-end`,
      connectedStrandIds: new Set([id]),
    };
    nodes.set(startNode.id, startNode);
    nodes.set(endNode.id, endNode);
    strands.set(id, {
      id,
      y,
      active: true,
      broken: false,
      totalRestLength: 1,
      startNode,
      endNode,
    });
  }

  return {
    source: { strands },
    getStrand(strandId) {
      return strands.get(strandId);
    },
    getNode(nodeId) {
      return nodes.get(nodeId);
    },
    getWorldPosition(address, out = {}) {
      const strand = strands.get(address.strandId);
      if (!strand) throw new Error(`Unknown strand ${address.strandId}.`);
      out.x = clamp01(address.t);
      out.y = strand.y;
      out.z = 0;
      return out;
    },
    getContactFrame(_address, out) {
      Object.assign(out.tangent, { x: 1, y: 0, z: 0 });
      Object.assign(out.normal, { x: 0, y: 1, z: 0 });
      Object.assign(out.binormal, { x: 0, y: 0, z: 1 });
      return out;
    },
    getLocalVelocity(_address, out) {
      Object.assign(out, { x: 0, y: 0, z: 0 });
      return out;
    },
    getApproximateLocalTension() {
      return 1;
    },
    findClosestPoint(target, options = {}) {
      const allowed = options.strandIds ?? new Set(strands.keys());
      let best = null;
      for (const strandId of allowed) {
        const strand = strands.get(strandId);
        if (!strand) continue;
        const t = clamp01(target.x);
        const distance = Math.hypot(target.x - t, target.y - strand.y, target.z);
        if (!best || distance < best.distance) {
          best = { address: { strandId, t }, distance };
        }
      }
      return best;
    },
  };
}

function candidateSnapshot(result) {
  return result.candidates.map((candidate) => ({
    legId: candidate.legId,
    source: candidate.source,
    strandId: candidate.strandId,
    t: round(candidate.t),
    accepted: candidate.rejectionReasons.length === 0,
    rejectionReasons: [...candidate.rejectionReasons],
  }));
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round(value) {
  return Math.round(value * 1e8) / 1e8;
}
