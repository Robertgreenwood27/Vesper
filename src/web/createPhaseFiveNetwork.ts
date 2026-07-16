import type { LabConfig } from "../config";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { WebStrand } from "./WebStrand";

type Vec3Tuple = readonly [x: number, y: number, z: number];

export interface PhaseFivePlaneGroup {
  id: "plane-a" | "plane-b";
  nodeIds: readonly string[];
  strandIds: readonly string[];
}

/**
 * A crossing is descriptive metadata, never topology. In particular, neither
 * normalized address below is inserted into WebNetwork.nodes.
 */
export interface PhaseFiveNonConnectedCrossing {
  id: string;
  connected: false;
  projection: "xy";
  strandAId: string;
  strandAT: number;
  strandBId: string;
  strandBT: number;
  initialPointA: Vec3Tuple;
  initialPointB: Vec3Tuple;
  initialSeparation: number;
}

export interface PhaseFiveCourseGroups {
  yJunction: {
    nodeId: string;
    strandIds: readonly string[];
  };
  angledPlanes: readonly [PhaseFivePlaneGroup, PhaseFivePlaneGroup];
  verticalDrop: {
    strandId: string;
    startNodeId: string;
    endNodeId: string;
  };
  nonConnectedCrossingPair: readonly [string, string];
  mainConnectedStrandIds: readonly string[];
}

export interface PhaseFiveCourseSemantics {
  straightStrandId: string;
  trueJunctionId: string;
  movableJunctionIds: readonly string[];
  fixedAnchorIds: readonly string[];
}

export interface PhaseFiveTopologyCounts {
  nodeCount: number;
  strandCount: number;
  particleCount: number;
  constraintCount: number;
  connectedComponentCount: number;
}

export interface PhaseFiveWeb {
  network: WebNetwork;
  nodes: readonly WebNode[];
  strands: readonly WebStrand[];
  groups: PhaseFiveCourseGroups;
  crossings: readonly PhaseFiveNonConnectedCrossing[];
  semantics: PhaseFiveCourseSemantics;
  topology: PhaseFiveTopologyCounts;
}

interface AddCourseStrandOptions {
  id: string;
  startNode: WebNode;
  endNode: WebNode;
  slack: number;
  bowHint: Vec3Tuple;
}

const LINEAR_DENSITY = 0.18;
const KNOT_MASS = 0.06;

function readNodePosition(network: WebNetwork, node: WebNode): Vec3Tuple {
  const offset = node.particleIndex * 3;
  const positions = network.particles.positions;
  return [positions[offset], positions[offset + 1], positions[offset + 2]];
}

function polylineLength(positions: Float32Array): number {
  let length = 0;
  for (let offset = 0; offset < positions.length - 3; offset += 3) {
    length += Math.hypot(
      positions[offset + 3] - positions[offset],
      positions[offset + 4] - positions[offset + 1],
      positions[offset + 5] - positions[offset + 2],
    );
  }
  return length;
}

function stablePerpendicular(chord: Vec3Tuple, hint: Vec3Tuple): Vec3Tuple {
  const chordLength = Math.hypot(chord[0], chord[1], chord[2]);
  if (chordLength < 1e-8) {
    throw new Error("A web strand cannot have coincident endpoint nodes.");
  }

  const tx = chord[0] / chordLength;
  const ty = chord[1] / chordLength;
  const tz = chord[2] / chordLength;
  const hintProjection = hint[0] * tx + hint[1] * ty + hint[2] * tz;
  let nx = hint[0] - tx * hintProjection;
  let ny = hint[1] - ty * hintProjection;
  let nz = hint[2] - tz * hintProjection;
  let normalLength = Math.hypot(nx, ny, nz);

  if (normalLength < 1e-5) {
    // Choose the world axis least aligned with the chord. This deterministic
    // fallback also gives the future contact-frame code a reproducible rest
    // orientation for vertical and near-axis-aligned strands.
    const ax = Math.abs(tx);
    const ay = Math.abs(ty);
    const az = Math.abs(tz);
    const fallback: Vec3Tuple = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    const fallbackProjection = fallback[0] * tx + fallback[1] * ty + fallback[2] * tz;
    nx = fallback[0] - tx * fallbackProjection;
    ny = fallback[1] - ty * fallbackProjection;
    nz = fallback[2] - tz * fallbackProjection;
    normalLength = Math.hypot(nx, ny, nz);
  }

  return [nx / normalLength, ny / normalLength, nz / normalLength];
}

function writeBowedPositions(
  target: Float32Array,
  pointCount: number,
  start: Vec3Tuple,
  end: Vec3Tuple,
  bowDirection: Vec3Tuple,
  bowAmount: number,
): void {
  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const bow = bowAmount * 4 * t * (1 - t);
    const offset = point * 3;
    target[offset] = start[0] + (end[0] - start[0]) * t + bowDirection[0] * bow;
    target[offset + 1] = start[1] + (end[1] - start[1]) * t + bowDirection[1] * bow;
    target[offset + 2] = start[2] + (end[2] - start[2]) * t + bowDirection[2] * bow;
  }
}

function addCourseStrand(
  network: WebNetwork,
  config: LabConfig,
  pointCount: number,
  options: AddCourseStrandOptions,
): WebStrand {
  const start = readNodePosition(network, options.startNode);
  const end = readNodePosition(network, options.endNode);
  const chord: Vec3Tuple = [end[0] - start[0], end[1] - start[1], end[2] - start[2]];
  const chordLength = Math.hypot(chord[0], chord[1], chord[2]);
  const bowDirection = stablePerpendicular(chord, options.bowHint);
  const positions = new Float32Array(pointCount * 3);
  const slack = Math.max(1, options.slack);

  let bowAmount = 0;
  if (slack > 1.000001) {
    const targetLength = chordLength * slack;
    let low = 0;
    let high = chordLength * Math.max(1, slack);
    for (let iteration = 0; iteration < 36; iteration += 1) {
      const candidate = (low + high) * 0.5;
      writeBowedPositions(positions, pointCount, start, end, bowDirection, candidate);
      if (polylineLength(positions) < targetLength) {
        low = candidate;
      } else {
        high = candidate;
      }
    }
    bowAmount = (low + high) * 0.5;
  }
  writeBowedPositions(positions, pointCount, start, end, bowDirection, bowAmount);

  const restLengths = new Float32Array(pointCount - 1);
  for (let segment = 0; segment < restLengths.length; segment += 1) {
    const offset = segment * 3;
    restLengths[segment] = Math.hypot(
      positions[offset + 3] - positions[offset],
      positions[offset + 4] - positions[offset + 1],
      positions[offset + 5] - positions[offset + 2],
    );
  }

  return network.addStrand({
    id: options.id,
    startNode: options.startNode,
    endNode: options.endNode,
    initialPositions: positions,
    restLengths,
    stiffness: config.stiffness,
    damping: config.damping,
    linearDensity: LINEAR_DENSITY,
  });
}

function assignMaterialNodeMasses(network: WebNetwork): void {
  for (const node of network.nodeList) {
    if (node.isFixed) {
      continue;
    }

    let adjacentMaterialMass = 0;
    for (const strandId of node.connectedStrandIds) {
      const strand = network.strands.get(strandId);
      if (!strand) {
        throw new Error(`Node ${node.id} references missing strand ${strandId}.`);
      }
      const segmentIndex = strand.startNode === node ? 0 : strand.constraintCount - 1;
      adjacentMaterialMass += 0.5 * strand.linearDensity * strand.restLengths[segmentIndex];
    }
    network.setNodeMass(node, KNOT_MASS + adjacentMaterialMass);
  }
}

/**
 * Builds the Phase 5 traversal course exclusively from nodes and simulated
 * strands. At N points/strand it has 15 semantic nodes, 16 strands,
 * 16N - 17 unique particles, and 16(N - 1) distance constraints.
 *
 * Integration note: navigation/query code should consume strand IDs plus a
 * normalized address, and should treat `crossings` as visualization/QA data.
 * A crossing entry never adds graph adjacency or a shared physics particle.
 */
export function createPhaseFiveNetwork(config: LabConfig): PhaseFiveWeb {
  const network = new WebNetwork();
  const pointCount = Math.max(4, Math.round(config.pointCount));
  const configuredSlack = Math.max(1, config.slack);
  const planeSlack = 1 + (configuredSlack - 1) * 0.45;
  const braceSlack = 1 + (configuredSlack - 1) * 0.25;
  const stemSlack = 1 + (configuredSlack - 1) * 0.5;

  // The Y is an explicit three-edge junction. Its center is movable and every
  // branch shares exactly the center node's one physics particle.
  const ceilingLeft = network.addNode(
    "anchor-ceiling-left",
    "CEILING LEFT",
    -3.9,
    3.2,
    -0.5,
    "fixed",
  );
  const ceilingRight = network.addNode(
    "anchor-ceiling-right",
    "CEILING RIGHT",
    0.9,
    3.5,
    1.1,
    "fixed",
  );
  const yJunction = network.addNode("junction-y", "MOVABLE Y", -1.1, 1.25, 0.35, "dynamic", 0.2);
  const hub = network.addNode("junction-hub", "TRUE HUB", 0, 0, 0, "dynamic", 0.3);

  // Each quadrilateral is exactly coplanar at rest: far = up + low relative
  // to the shared hub. Their distinct depth slopes make this a true 3D course.
  const planeAUp = network.addNode("plane-a-up", "PLANE A CEILING", 0.25, 2.1, 0.65, "fixed");
  const planeAFar = network.addNode("plane-a-far", "PLANE A WALL", 3.25, 2, 2.05, "fixed");
  const planeALow = network.addNode("plane-a-low", "PLANE A FLEX", 3, -0.1, 1.4, "dynamic", 0.16);

  const planeBUp = network.addNode("plane-b-up", "PLANE B CEILING", 0.5, 1.9, -0.9, "fixed");
  const planeBFar = network.addNode("plane-b-far", "PLANE B WALL", -2.3, 1.7, -2.4, "fixed");
  const planeBLow = network.addNode("plane-b-low", "PLANE B FLEX", -2.8, -0.2, -1.5, "dynamic", 0.16);
  const dropTip = network.addNode("drop-tip", "DROP TIP", 0, -3, 0, "dynamic", 0.12);

  // These four endpoints belong to two independent graph components. The
  // strands cross at (0, -1.5) in XY projection, but remain 2.3 units apart.
  const crossingOverLeft = network.addNode(
    "cross-over-left",
    "CROSS OVER L",
    -2.1,
    -1.5,
    1.15,
    "fixed",
  );
  const crossingOverRight = network.addNode(
    "cross-over-right",
    "CROSS OVER R",
    2.1,
    -1.5,
    1.15,
    "fixed",
  );
  const crossingUnderTop = network.addNode(
    "cross-under-top",
    "CROSS UNDER T",
    0,
    -0.6,
    -1.15,
    "fixed",
  );
  const crossingUnderBottom = network.addNode(
    "cross-under-bottom",
    "CROSS UNDER B",
    0,
    -3.35,
    -1.15,
    "fixed",
  );

  const strands: WebStrand[] = [];
  const add = (options: AddCourseStrandOptions): WebStrand => {
    const strand = addCourseStrand(network, config, pointCount, options);
    strands.push(strand);
    return strand;
  };

  add({
    id: "y-left",
    startNode: ceilingLeft,
    endNode: yJunction,
    slack: configuredSlack,
    bowHint: [0, -1, 0.25],
  });
  add({
    id: "y-right",
    startNode: ceilingRight,
    endNode: yJunction,
    slack: configuredSlack,
    bowHint: [0, -1, -0.2],
  });
  add({
    id: "y-stem",
    startNode: yJunction,
    endNode: hub,
    slack: stemSlack,
    bowHint: [0.4, 0, -1],
  });

  const planeAStrandIds = [
    "plane-a-edge-up",
    "plane-a-straight",
    "plane-a-edge-low",
    "plane-a-edge-return",
    "plane-a-brace-forward",
  ] as const;
  add({ id: planeAStrandIds[0], startNode: hub, endNode: planeAUp, slack: planeSlack, bowHint: [0, -1, 0] });
  // This taut plane edge is the course's named straight traversal strand.
  add({ id: planeAStrandIds[1], startNode: planeAUp, endNode: planeAFar, slack: 1, bowHint: [0, -1, 0] });
  add({ id: planeAStrandIds[2], startNode: planeAFar, endNode: planeALow, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeAStrandIds[3], startNode: planeALow, endNode: hub, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeAStrandIds[4], startNode: hub, endNode: planeAFar, slack: braceSlack, bowHint: [0, -1, 0] });

  const planeBStrandIds = [
    "plane-b-edge-up",
    "plane-b-edge-far",
    "plane-b-edge-low",
    "plane-b-edge-return",
    "plane-b-brace-forward",
  ] as const;
  add({ id: planeBStrandIds[0], startNode: hub, endNode: planeBUp, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeBStrandIds[1], startNode: planeBUp, endNode: planeBFar, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeBStrandIds[2], startNode: planeBFar, endNode: planeBLow, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeBStrandIds[3], startNode: planeBLow, endNode: hub, slack: planeSlack, bowHint: [0, -1, 0] });
  add({ id: planeBStrandIds[4], startNode: hub, endNode: planeBFar, slack: braceSlack, bowHint: [0, -1, 0] });

  add({ id: "drop-line", startNode: hub, endNode: dropTip, slack: 1, bowHint: [1, 0, 0] });
  add({ id: "crossing-over", startNode: crossingOverLeft, endNode: crossingOverRight, slack: 1, bowHint: [0, -1, 0] });
  add({ id: "crossing-under", startNode: crossingUnderTop, endNode: crossingUnderBottom, slack: 1, bowHint: [1, 0, 0] });

  assignMaterialNodeMasses(network);
  network.syncParticleDamping();

  const mainConnectedStrandIds = [
    "y-left",
    "y-right",
    "y-stem",
    ...planeAStrandIds,
    ...planeBStrandIds,
    "drop-line",
  ] as const;
  const fixedAnchorIds = network.nodeList.filter((node) => node.isFixed).map((node) => node.id);
  const crossings: PhaseFiveNonConnectedCrossing[] = [
    {
      id: "projection-crossing-01",
      connected: false,
      projection: "xy",
      strandAId: "crossing-over",
      strandAT: 0.5,
      strandBId: "crossing-under",
      strandBT: 0.3272727273,
      initialPointA: [0, -1.5, 1.15],
      initialPointB: [0, -1.5, -1.15],
      initialSeparation: 2.3,
    },
  ];

  return {
    network,
    nodes: network.nodeList,
    strands,
    groups: {
      yJunction: { nodeId: "junction-y", strandIds: ["y-left", "y-right", "y-stem"] },
      angledPlanes: [
        {
          id: "plane-a",
          nodeIds: ["junction-hub", "plane-a-up", "plane-a-far", "plane-a-low"],
          strandIds: planeAStrandIds,
        },
        {
          id: "plane-b",
          nodeIds: ["junction-hub", "plane-b-up", "plane-b-far", "plane-b-low"],
          strandIds: planeBStrandIds,
        },
      ],
      verticalDrop: {
        strandId: "drop-line",
        startNodeId: "junction-hub",
        endNodeId: "drop-tip",
      },
      nonConnectedCrossingPair: ["crossing-over", "crossing-under"],
      mainConnectedStrandIds,
    },
    crossings,
    semantics: {
      straightStrandId: "plane-a-straight",
      trueJunctionId: "junction-hub",
      movableJunctionIds: ["junction-y", "junction-hub", "plane-a-low", "plane-b-low"],
      fixedAnchorIds,
    },
    topology: {
      nodeCount: network.nodeList.length,
      strandCount: network.strandList.length,
      particleCount: network.particles.count,
      constraintCount: network.constraintCount,
      connectedComponentCount: 3,
    },
  };
}
