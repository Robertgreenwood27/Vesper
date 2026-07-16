import type { LabConfig } from "../config";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { WebStrand } from "./WebStrand";

export interface PhaseTwoWeb {
  network: WebNetwork;
  strands: WebStrand[];
  junction: WebNode;
}

function writeBowedPositions(
  target: Float32Array,
  pointCount: number,
  startX: number,
  startY: number,
  startZ: number,
  endX: number,
  endY: number,
  endZ: number,
  bowX: number,
  bowY: number,
  bowAmount: number,
): void {
  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const bow = bowAmount * 4 * t * (1 - t);
    const offset = point * 3;
    target[offset] = startX + (endX - startX) * t + bowX * bow;
    target[offset + 1] = startY + (endY - startY) * t + bowY * bow;
    target[offset + 2] = startZ + (endZ - startZ) * t;
  }
}

function polylineLength(positions: Float32Array, pointCount: number): number {
  let length = 0;
  for (let point = 0; point < pointCount - 1; point += 1) {
    const offsetA = point * 3;
    const offsetB = offsetA + 3;
    length += Math.hypot(
      positions[offsetB] - positions[offsetA],
      positions[offsetB + 1] - positions[offsetA + 1],
      positions[offsetB + 2] - positions[offsetA + 2],
    );
  }
  return length;
}

function addBowedStrand(
  network: WebNetwork,
  id: string,
  startNode: WebNode,
  endNode: WebNode,
  config: LabConfig,
  verticalFallbackDirection: number,
): WebStrand {
  const store = network.particles;
  const startOffset = startNode.particleIndex * 3;
  const endOffset = endNode.particleIndex * 3;
  const startX = store.positions[startOffset];
  const startY = store.positions[startOffset + 1];
  const startZ = store.positions[startOffset + 2];
  const endX = store.positions[endOffset];
  const endY = store.positions[endOffset + 1];
  const endZ = store.positions[endOffset + 2];
  const chordX = endX - startX;
  const chordY = endY - startY;
  const chordZ = endZ - startZ;
  const chordLength = Math.hypot(chordX, chordY, chordZ);

  let bowX = -chordY / Math.max(chordLength, 1e-8);
  let bowY = chordX / Math.max(chordLength, 1e-8);
  if (Math.abs(bowY) < 0.12) {
    // Gravity is parallel to the nearly vertical branch, so choose a small,
    // deterministic lateral resting plane rather than a degenerate line.
    bowX = verticalFallbackDirection;
    bowY = 0;
  } else if (bowY > 0) {
    bowX *= -1;
    bowY *= -1;
  }

  const positions = new Float32Array(config.pointCount * 3);
  const targetLength = chordLength * config.slack;
  let lowBow = 0;
  let highBow = chordLength;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const bowAmount = (lowBow + highBow) * 0.5;
    writeBowedPositions(
      positions,
      config.pointCount,
      startX,
      startY,
      startZ,
      endX,
      endY,
      endZ,
      bowX,
      bowY,
      bowAmount,
    );
    if (polylineLength(positions, config.pointCount) < targetLength) {
      lowBow = bowAmount;
    } else {
      highBow = bowAmount;
    }
  }
  writeBowedPositions(
    positions,
    config.pointCount,
    startX,
    startY,
    startZ,
    endX,
    endY,
    endZ,
    bowX,
    bowY,
    (lowBow + highBow) * 0.5,
  );

  const restLengths = new Float32Array(config.pointCount - 1);
  for (let segment = 0; segment < restLengths.length; segment += 1) {
    const offsetA = segment * 3;
    const offsetB = offsetA + 3;
    restLengths[segment] = Math.hypot(
      positions[offsetB] - positions[offsetA],
      positions[offsetB + 1] - positions[offsetA + 1],
      positions[offsetB + 2] - positions[offsetA + 2],
    );
  }

  return network.addStrand({
    id,
    startNode,
    endNode,
    initialPositions: positions,
    restLengths,
    stiffness: config.stiffness,
    damping: config.damping,
    linearDensity: 0.2,
  });
}

/** Builds the Phase 2 three-branch web around one shared dynamic particle. */
export function createPhaseTwoNetwork(config: LabConfig): PhaseTwoWeb {
  const network = new WebNetwork();
  const anchorA = network.addNode("anchor-a", "ANCHOR A", -4.45, 2.45, 0, "fixed");
  const anchorB = network.addNode("anchor-b", "ANCHOR B", 3.55, 2.55, 0, "fixed");
  // Keep the lower chord slightly oblique. An exactly vertical slack chain has
  // two mirror-equivalent lateral equilibria when only axial constraints are
  // present; this small offset lets gravity select one stable resting side.
  const anchorC = network.addNode("anchor-c", "ANCHOR C", -1.05, -2.75, 0, "fixed");
  const junction = network.addNode("junction-j", "JUNCTION J", -0.4, -0.15, 0, "dynamic", 0.15);

  const strands = [
    addBowedStrand(network, "silk-a", anchorA, junction, config, -1),
    addBowedStrand(network, "silk-b", anchorB, junction, config, 1),
    addBowedStrand(network, "silk-c", anchorC, junction, config, -1),
  ];

  let junctionMaterialMass = 0;
  for (const strand of strands) {
    const adjacentRestLength = strand.restLengths[strand.constraintCount - 1];
    junctionMaterialMass += 0.5 * strand.linearDensity * adjacentRestLength;
  }
  // A small knot mass plus half of every adjacent segment keeps junction
  // inertia material-consistent as the per-branch point count changes.
  network.setNodeMass(junction, 0.08 + junctionMaterialMass);

  network.syncParticleDamping();
  return { network, strands, junction };
}
