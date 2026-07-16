import type { LabConfig } from "../config";
import { WebNetwork } from "./WebNetwork";
import type { WebStrand } from "./WebStrand";

export interface PhaseOneWeb {
  network: WebNetwork;
  strand: WebStrand;
}

const ANCHOR_SPAN = 9;
const ANCHOR_Y = 1.4;

function writeBowedPositions(target: Float32Array, pointCount: number, sag: number): void {
  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const offset = point * 3;
    target[offset] = -ANCHOR_SPAN * 0.5 + ANCHOR_SPAN * t;
    target[offset + 1] = ANCHOR_Y - sag * 4 * t * (1 - t);
    target[offset + 2] = 0;
  }
}

function polylineLength(positions: Float32Array, pointCount: number): number {
  let length = 0;
  for (let point = 0; point < pointCount - 1; point += 1) {
    const offsetA = point * 3;
    const offsetB = offsetA + 3;
    const dx = positions[offsetB] - positions[offsetA];
    const dy = positions[offsetB + 1] - positions[offsetA + 1];
    const dz = positions[offsetB + 2] - positions[offsetA + 2];
    length += Math.hypot(dx, dy, dz);
  }
  return length;
}

/** Builds a deterministic, already-slack strand without advancing simulation time. */
export function createPhaseOneNetwork(config: LabConfig): PhaseOneWeb {
  const network = new WebNetwork();
  const anchorA = network.addNode("anchor-a", "ANCHOR A", -ANCHOR_SPAN * 0.5, ANCHOR_Y, 0, "fixed");
  const anchorB = network.addNode("anchor-b", "ANCHOR B", ANCHOR_SPAN * 0.5, ANCHOR_Y, 0, "fixed");

  const positions = new Float32Array(config.pointCount * 3);
  const targetLength = ANCHOR_SPAN * config.slack;

  let lowSag = 0;
  let highSag = ANCHOR_SPAN;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const sag = (lowSag + highSag) * 0.5;
    writeBowedPositions(positions, config.pointCount, sag);
    if (polylineLength(positions, config.pointCount) < targetLength) {
      lowSag = sag;
    } else {
      highSag = sag;
    }
  }
  writeBowedPositions(positions, config.pointCount, (lowSag + highSag) * 0.5);

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

  const strand = network.addStrand({
    id: "silk-001",
    startNode: anchorA,
    endNode: anchorB,
    initialPositions: positions,
    restLengths,
    stiffness: config.stiffness,
    damping: config.damping,
    // Arbitrary lab-scale density; gravity remains an acceleration.
    linearDensity: 0.2,
  });

  return { network, strand };
}
