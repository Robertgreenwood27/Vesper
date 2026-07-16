import type { LabConfig } from "../config";
import {
  SPIDER_LEG_IDS,
  type SpiderLegId,
} from "../spider/SpiderRigSpec";
import type { StrandAddress } from "../traversal";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { WebStrand } from "./WebStrand";

export { SPIDER_LEG_IDS };
export type { SpiderLegId };

interface SupportLayout {
  readonly legId: SpiderLegId;
  readonly directionX: number;
  readonly directionZ: number;
  /** Neutral FootHome radius divided by the authored support-anchor radius. */
  readonly contactT: number;
}

export interface PhaseSixFixture {
  readonly network: WebNetwork;
  readonly supportCenterNodeId: string;
  readonly supportStrandIds: readonly string[];
  readonly initialContacts: Readonly<Record<SpiderLegId, StrandAddress>>;
  readonly disturbanceAddress: StrandAddress;
}

const ANCHOR_RADIUS = 1.55;
const LINEAR_DENSITY = 0.15;
const CENTER_KNOT_MASS = 0.09;

// Directions and material coordinates are taken from the actual neutral
// FootHome positions relative to BodyCenter in the supplied GLB, not guessed
// from generic spider anatomy. The fixture remains ordinary semantic web data.
const SUPPORT_LAYOUT: readonly SupportLayout[] = [
  { legId: "L1", directionX: -0.9756, directionZ: 0.2197, contactT: 0.3361 },
  { legId: "L2", directionX: -0.5540, directionZ: 0.8325, contactT: 0.5136 },
  { legId: "L3", directionX: -0.0588, directionZ: 0.9983, contactT: 0.5926 },
  { legId: "L4", directionX: 0.7398, directionZ: 0.6728, contactT: 0.5790 },
  { legId: "R1", directionX: -0.9754, directionZ: -0.2203, contactT: 0.3345 },
  { legId: "R2", directionX: -0.5560, directionZ: -0.8312, contactT: 0.5087 },
  { legId: "R3", directionX: -0.0674, directionZ: -0.9977, contactT: 0.5871 },
  { legId: "R4", directionX: 0.7275, directionZ: -0.6861, contactT: 0.5758 },
] as const;

function readNodePosition(network: WebNetwork, node: WebNode): readonly [number, number, number] {
  const offset = node.particleIndex * 3;
  return [
    network.particles.positions[offset],
    network.particles.positions[offset + 1],
    network.particles.positions[offset + 2],
  ];
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

function writeSupportCurve(
  target: Float32Array,
  pointCount: number,
  start: readonly [number, number, number],
  end: readonly [number, number, number],
  bow: number,
): void {
  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const offset = point * 3;
    target[offset] = start[0] + (end[0] - start[0]) * t;
    target[offset + 1] = start[1] + (end[1] - start[1]) * t - bow * 4 * t * (1 - t);
    target[offset + 2] = start[2] + (end[2] - start[2]) * t;
  }
}

function addSupportStrand(
  network: WebNetwork,
  config: LabConfig,
  startNode: WebNode,
  endNode: WebNode,
  id: string,
): WebStrand {
  const pointCount = Math.max(8, Math.round(config.pointCount));
  const start = readNodePosition(network, startNode);
  const end = readNodePosition(network, endNode);
  const chordLength = Math.hypot(
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  );
  const targetLength = chordLength * (1 + (Math.max(1, config.slack) - 1) * 0.18);
  const positions = new Float32Array(pointCount * 3);
  let low = 0;
  let high = chordLength * 0.4;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const candidate = (low + high) * 0.5;
    writeSupportCurve(positions, pointCount, start, end, candidate);
    if (polylineLength(positions) < targetLength) {
      low = candidate;
    } else {
      high = candidate;
    }
  }
  writeSupportCurve(positions, pointCount, start, end, (low + high) * 0.5);

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
    id,
    startNode,
    endNode,
    initialPositions: positions,
    restLengths,
    stiffness: config.stiffness,
    damping: config.damping,
    linearDensity: LINEAR_DENSITY,
  });
}

/**
 * A deliberately local Phase 6 support fixture: eight simulated silk spokes
 * share one movable center, and each neutral foot owns one continuous address.
 * It is not authored display geometry and introduces no particle-level contacts.
 */
export function createPhaseSixFixture(config: LabConfig): PhaseSixFixture {
  const network = new WebNetwork();
  const center = network.addNode(
    "support-center",
    "MOVABLE SUPPORT CENTER",
    0,
    0,
    0,
    "dynamic",
    CENTER_KNOT_MASS,
  );
  const supportStrandIds: string[] = [];
  const initialContacts = {} as Record<SpiderLegId, StrandAddress>;

  for (const layout of SUPPORT_LAYOUT) {
    const anchor = network.addNode(
      `support-anchor-${layout.legId.toLowerCase()}`,
      `FIXED ${layout.legId}`,
      layout.directionX * ANCHOR_RADIUS,
      0,
      layout.directionZ * ANCHOR_RADIUS,
      "fixed",
    );
    const strandId = `support-${layout.legId.toLowerCase()}`;
    addSupportStrand(network, config, anchor, center, strandId);
    supportStrandIds.push(strandId);
    initialContacts[layout.legId] = { strandId, t: layout.contactT };
  }

  let centerMaterialMass = CENTER_KNOT_MASS;
  for (const strandId of supportStrandIds) {
    const strand = network.strands.get(strandId);
    if (!strand) {
      throw new Error(`Phase 6 fixture lost required strand ${strandId}.`);
    }
    centerMaterialMass +=
      strand.linearDensity * strand.restLengths[strand.constraintCount - 1] * 0.5;
  }
  network.setNodeMass(center, centerMaterialMass);
  network.syncParticleDamping();

  return {
    network,
    supportCenterNodeId: center.id,
    supportStrandIds,
    initialContacts,
    disturbanceAddress: { strandId: "support-l2", t: 0.62 },
  };
}
