import type { LabConfig } from "../config";
import {
  SPIDER_LEG_IDS,
  type SpiderLegId,
} from "../spider/SpiderRigSpec";
import type { StrandAddress } from "../traversal";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { StrandLocation, WebStrand } from "./WebStrand";

type Vec3Tuple = readonly [x: number, y: number, z: number];

export interface PhaseSevenStrandDestination {
  readonly kind: "strand";
  readonly address: StrandAddress;
}

export interface PhaseSevenJunctionDestination {
  readonly kind: "junction";
  readonly junctionId: string;
}

export interface PhaseSevenWorldDestination {
  readonly kind: "world";
  readonly worldPosition: Vec3Tuple;
}

export type PhaseSevenFixtureDestination =
  | PhaseSevenStrandDestination
  | PhaseSevenJunctionDestination
  | PhaseSevenWorldDestination;

export interface PhaseSevenScenarioDestinations {
  /** A short move toward model-forward (-X) on the primary support. */
  readonly forward: PhaseSevenStrandDestination;
  /** A nearby goal whose useful footholds lie on the angled support. */
  readonly alternate: PhaseSevenStrandDestination;
  /** The forward test repeated with the body/support frame inverted. */
  readonly upsideDown: PhaseSevenStrandDestination;
  /** A traversable semantic goal beyond the one-step foothold envelope. */
  readonly noValid: PhaseSevenStrandDestination;
  /** A world goal near inactive silk, with safer active silk still nearby. */
  readonly unstableRejection: PhaseSevenWorldDestination;
}

export interface PhaseSevenStrandIds {
  readonly primarySupport: string;
  readonly angledSupport: string;
  readonly yUpperBranch: string;
  readonly yLowerBranch: string;
  readonly lowerBehind: string;
  readonly unstableCandidate: string;
  readonly active: readonly string[];
  readonly all: readonly string[];
}

export interface PhaseSevenJunctionIds {
  /** Exactly three semantic strands meet here. */
  readonly y: string;
  /** The angled support and lower/behind strand join the lower Y branch here. */
  readonly lower: string;
  readonly all: readonly string[];
}

export interface PhaseSevenFixture {
  readonly network: WebNetwork;
  readonly nodes: readonly WebNode[];
  readonly strands: readonly WebStrand[];
  readonly strandIds: PhaseSevenStrandIds;
  readonly junctionIds: PhaseSevenJunctionIds;
  /** Eight semantic addresses; locomotion never treats particles as footholds. */
  readonly initialContacts: Readonly<Record<SpiderLegId, StrandAddress>>;
  readonly initiallyLoadedLegIds: readonly SpiderLegId[];
  readonly scenarioDestinations: PhaseSevenScenarioDestinations;
  readonly unstableStrandId: string;
  /** Anatomically weighted center of the eight initial continuous contacts. */
  readonly supportCenter: Vec3Tuple;
  readonly supportFrame: {
    readonly forward: Vec3Tuple;
    readonly up: Vec3Tuple;
  };
  readonly topology: {
    readonly nodeCount: number;
    readonly strandCount: number;
    readonly activeStrandCount: number;
    readonly particleCount: number;
    readonly constraintCount: number;
    readonly connectedComponentCount: 1;
  };
}

interface CourseStrandOptions {
  readonly id: string;
  readonly startNode: WebNode;
  readonly endNode: WebNode;
  readonly slack: number;
  readonly bowHint: Vec3Tuple;
  readonly stiffnessScale?: number;
  readonly linearDensityScale?: number;
  readonly active?: boolean;
}

const LINEAR_DENSITY = 0.15;
const KNOT_MASS = 0.065;

const STRAND_IDS = {
  primarySupport: "locomotion-primary",
  angledSupport: "locomotion-angled",
  yUpperBranch: "locomotion-y-upper",
  yLowerBranch: "locomotion-y-lower",
  lowerBehind: "locomotion-lower-behind",
  unstableCandidate: "locomotion-inactive-candidate",
} as const;

const JUNCTION_IDS = {
  y: "locomotion-junction-y",
  lower: "locomotion-junction-lower",
} as const;

// Actual Phase 6 FootHome positions relative to BodyCenter, translated by the
// rig's 0.2-unit neutral body clearance. These references generate semantic
// t values on the new asymmetric rails instead of hand-authoring eight magic
// particle indices (or eight decorative attachment nodes).
const NEUTRAL_FOOT_REFERENCES: Readonly<Record<SpiderLegId, Vec3Tuple>> = {
  L1: [-1.004, -0.0085, 0.226],
  L2: [-0.417, 0.0053, 0.628],
  L3: [-0.037, 0.0216, 0.63],
  L4: [0.483, 0.0482, 0.439],
  R1: [-1.006, 0.0047, -0.227],
  R2: [-0.423, 0.0395, -0.633],
  R3: [-0.043, 0.0556, -0.638],
  R4: [0.478, 0.0721, -0.451],
};

// Same anatomical weighting used by the validated Phase 6 body support fit.
const SUPPORT_WEIGHTS: Readonly<Record<SpiderLegId, number>> = {
  L1: 0.4,
  L2: 0.7,
  L3: 1,
  L4: 1.8,
  R1: 0.4,
  R2: 0.7,
  R3: 1,
  R4: 1.8,
};

function readNodePosition(network: WebNetwork, node: WebNode): Vec3Tuple {
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

function stablePerpendicular(chord: Vec3Tuple, hint: Vec3Tuple): Vec3Tuple {
  const chordLength = Math.hypot(chord[0], chord[1], chord[2]);
  if (chordLength < 1e-8) {
    throw new Error("A Phase 7 strand cannot have coincident endpoint nodes.");
  }

  const tx = chord[0] / chordLength;
  const ty = chord[1] / chordLength;
  const tz = chord[2] / chordLength;
  const projection = hint[0] * tx + hint[1] * ty + hint[2] * tz;
  let nx = hint[0] - tx * projection;
  let ny = hint[1] - ty * projection;
  let nz = hint[2] - tz * projection;
  let length = Math.hypot(nx, ny, nz);

  if (length < 1e-5) {
    const ax = Math.abs(tx);
    const ay = Math.abs(ty);
    const az = Math.abs(tz);
    const fallback: Vec3Tuple =
      ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
    const fallbackProjection =
      fallback[0] * tx + fallback[1] * ty + fallback[2] * tz;
    nx = fallback[0] - tx * fallbackProjection;
    ny = fallback[1] - ty * fallbackProjection;
    nz = fallback[2] - tz * fallbackProjection;
    length = Math.hypot(nx, ny, nz);
  }

  return [nx / length, ny / length, nz / length];
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
  options: CourseStrandOptions,
): WebStrand {
  const start = readNodePosition(network, options.startNode);
  const end = readNodePosition(network, options.endNode);
  const chord: Vec3Tuple = [
    end[0] - start[0],
    end[1] - start[1],
    end[2] - start[2],
  ];
  const chordLength = Math.hypot(chord[0], chord[1], chord[2]);
  const bowDirection = stablePerpendicular(chord, options.bowHint);
  const positions = new Float32Array(pointCount * 3);
  const targetLength = chordLength * Math.max(1, options.slack);

  let low = 0;
  let high = chordLength * 0.45;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const candidate = (low + high) * 0.5;
    writeBowedPositions(positions, pointCount, start, end, bowDirection, candidate);
    if (polylineLength(positions) < targetLength) {
      low = candidate;
    } else {
      high = candidate;
    }
  }
  writeBowedPositions(positions, pointCount, start, end, bowDirection, (low + high) * 0.5);

  const restLengths = new Float32Array(pointCount - 1);
  for (let segment = 0; segment < restLengths.length; segment += 1) {
    const offset = segment * 3;
    restLengths[segment] = Math.hypot(
      positions[offset + 3] - positions[offset],
      positions[offset + 4] - positions[offset + 1],
      positions[offset + 5] - positions[offset + 2],
    );
  }

  const strand = network.addStrand({
    id: options.id,
    startNode: options.startNode,
    endNode: options.endNode,
    initialPositions: positions,
    restLengths,
    stiffness: config.stiffness * (options.stiffnessScale ?? 1),
    damping: config.damping,
    linearDensity: LINEAR_DENSITY * (options.linearDensityScale ?? 1),
  });
  strand.active = options.active ?? true;
  return strand;
}

function closestContinuousAddress(
  network: WebNetwork,
  strand: WebStrand,
  point: Vec3Tuple,
): StrandAddress {
  const positions = network.particles.positions;
  let closestDistanceSquared = Infinity;
  let closestSegment = 0;
  let closestSegmentT = 0;

  for (let segment = 0; segment < strand.constraintCount; segment += 1) {
    const startOffset = strand.particleIndices[segment] * 3;
    const endOffset = strand.particleIndices[segment + 1] * 3;
    const ax = positions[startOffset];
    const ay = positions[startOffset + 1];
    const az = positions[startOffset + 2];
    const dx = positions[endOffset] - ax;
    const dy = positions[endOffset + 1] - ay;
    const dz = positions[endOffset + 2] - az;
    const lengthSquared = dx * dx + dy * dy + dz * dz;
    const segmentT = Math.max(
      0,
      Math.min(
        1,
        lengthSquared > 1e-12
          ? ((point[0] - ax) * dx + (point[1] - ay) * dy + (point[2] - az) * dz) /
              lengthSquared
          : 0,
      ),
    );
    const offsetX = ax + dx * segmentT - point[0];
    const offsetY = ay + dy * segmentT - point[1];
    const offsetZ = az + dz * segmentT - point[2];
    const distanceSquared = offsetX * offsetX + offsetY * offsetY + offsetZ * offsetZ;
    if (distanceSquared < closestDistanceSquared) {
      closestDistanceSquared = distanceSquared;
      closestSegment = segment;
      closestSegmentT = segmentT;
    }
  }

  return {
    strandId: strand.id,
    t: strand.normalizedLocation(closestSegment, closestSegmentT),
  };
}

const SAMPLE_LOCATION: StrandLocation = { segmentIndex: 0, t: 0, u: 0 };

function sampleInitialAddress(
  network: WebNetwork,
  strand: WebStrand,
  address: StrandAddress,
): Vec3Tuple {
  strand.resolveNormalizedLocation(address.t, SAMPLE_LOCATION);
  const startOffset = strand.particleIndices[SAMPLE_LOCATION.segmentIndex] * 3;
  const endOffset = strand.particleIndices[SAMPLE_LOCATION.segmentIndex + 1] * 3;
  const positions = network.particles.positions;
  const t = SAMPLE_LOCATION.t;
  return [
    positions[startOffset] + (positions[endOffset] - positions[startOffset]) * t,
    positions[startOffset + 1] + (positions[endOffset + 1] - positions[startOffset + 1]) * t,
    positions[startOffset + 2] + (positions[endOffset + 2] - positions[startOffset + 2]) * t,
  ];
}

function calculateSupportCenter(
  network: WebNetwork,
  contacts: Readonly<Record<SpiderLegId, StrandAddress>>,
): Vec3Tuple {
  let x = 0;
  let y = 0;
  let z = 0;
  let totalWeight = 0;
  for (const legId of SPIDER_LEG_IDS) {
    const address = contacts[legId];
    const strand = network.strands.get(address.strandId);
    if (!strand) {
      throw new Error(`Phase 7 initial contact ${legId} references missing strand ${address.strandId}.`);
    }
    const position = sampleInitialAddress(network, strand, address);
    const weight = SUPPORT_WEIGHTS[legId];
    x += position[0] * weight;
    y += position[1] * weight;
    z += position[2] * weight;
    totalWeight += weight;
  }
  return [x / totalWeight, y / totalWeight, z / totalWeight];
}

function assignMaterialNodeMasses(network: WebNetwork): void {
  for (const node of network.nodeList) {
    if (node.isFixed) continue;

    let adjacentMaterialMass = 0;
    for (const strandId of node.connectedStrandIds) {
      const strand = network.strands.get(strandId);
      if (!strand || !strand.active || strand.broken) continue;
      const segment = strand.startNode === node ? 0 : strand.constraintCount - 1;
      adjacentMaterialMass += strand.linearDensity * strand.restLengths[segment] * 0.5;
    }
    network.setNodeMass(node, KNOT_MASS + adjacentMaterialMass);
  }
}

function validateFixture(
  network: WebNetwork,
  initialContacts: Readonly<Record<SpiderLegId, StrandAddress>>,
): void {
  const yNode = network.nodes.get(JUNCTION_IDS.y);
  const expectedYStrands = new Set<string>([
    STRAND_IDS.primarySupport,
    STRAND_IDS.yUpperBranch,
    STRAND_IDS.yLowerBranch,
  ]);
  if (
    !yNode ||
    yNode.connectedStrandIds.size !== expectedYStrands.size ||
    [...expectedYStrands].some((strandId) => !yNode.connectedStrandIds.has(strandId))
  ) {
    throw new Error("Phase 7 locomotion-junction-y must remain an explicit three-strand Y.");
  }

  const unstable = network.strands.get(STRAND_IDS.unstableCandidate);
  if (!unstable || unstable.active || unstable.broken) {
    throw new Error("Phase 7 rejection strand must exist as explicitly inactive, unbroken silk.");
  }

  for (const legId of SPIDER_LEG_IDS) {
    const address = initialContacts[legId];
    const strand = network.strands.get(address.strandId);
    if (!strand?.active || strand.broken || !Number.isFinite(address.t) || address.t <= 0 || address.t >= 1) {
      throw new Error(`Phase 7 initial contact ${legId} is not a valid interior semantic address.`);
    }
  }
}

/**
 * Builds the compact asymmetric course for one deliberate Phase 7 step.
 *
 * The only navigable connections are shared WebNode endpoints. No visual
 * crossing or nearest-point coincidence adds graph topology, and all initial
 * footholds remain continuous { strandId, t } addresses independent of the
 * simulation resolution selected by `config.pointCount`.
 */
export function createPhaseSevenFixture(config: LabConfig): PhaseSevenFixture {
  const network = new WebNetwork();
  const pointCount = Math.max(10, Math.round(config.pointCount));
  const slackDelta = Math.max(0, config.slack - 1);

  // The left/primary rail follows the rig's L-foot rest arc. Model forward is
  // -X, so material t increases in the forward direction on this strand.
  const primaryRear = network.addNode(
    "locomotion-anchor-primary-rear",
    "PRIMARY REAR ANCHOR",
    1.55,
    0.06,
    0.48,
    "fixed",
  );
  const yJunction = network.addNode(
    JUNCTION_IDS.y,
    "EXPLICIT Y JUNCTION",
    -1.5,
    -0.02,
    0.34,
    "dynamic",
    KNOT_MASS,
  );
  const upperAnchor = network.addNode(
    "locomotion-anchor-y-upper",
    "Y UPPER ANCHOR",
    -2.3,
    0.27,
    0.83,
    "fixed",
  );
  const lowerJunction = network.addNode(
    JUNCTION_IDS.lower,
    "FIXED LOWER ANGLED JUNCTION",
    -2.18,
    -0.04,
    -0.05,
    "fixed",
  );
  const angledRear = network.addNode(
    "locomotion-anchor-angled-rear",
    "ANGLED REAR ANCHOR",
    1.52,
    0.1,
    -0.85,
    "fixed",
  );
  const lowerBehindAnchor = network.addNode(
    "locomotion-anchor-lower-behind",
    "LOWER BEHIND ANCHOR",
    -0.28,
    -0.5,
    -1.32,
    "fixed",
  );
  const unstableAnchor = network.addNode(
    "locomotion-anchor-inactive",
    "INACTIVE CANDIDATE ANCHOR",
    -0.18,
    0.31,
    -0.27,
    "fixed",
  );

  const strands: WebStrand[] = [];
  const add = (options: CourseStrandOptions): WebStrand => {
    const strand = addCourseStrand(network, config, pointCount, options);
    strands.push(strand);
    return strand;
  };

  const primarySupport = add({
    id: STRAND_IDS.primarySupport,
    startNode: primaryRear,
    endNode: yJunction,
    slack: 1 + slackDelta * 0.12,
    bowHint: [0, -1, 0.08],
  });
  add({
    id: STRAND_IDS.yUpperBranch,
    startNode: yJunction,
    endNode: upperAnchor,
    slack: 1 + slackDelta * 0.24,
    bowHint: [0.2, -1, 0.1],
  });
  add({
    id: STRAND_IDS.yLowerBranch,
    startNode: yJunction,
    endNode: lowerJunction,
    slack: 1 + slackDelta * 0.2,
    bowHint: [0, -1, -0.2],
  });
  const angledSupport = add({
    id: STRAND_IDS.angledSupport,
    startNode: lowerJunction,
    endNode: angledRear,
    slack: 1 + slackDelta * 0.14,
    bowHint: [0, -1, -0.08],
  });
  add({
    id: STRAND_IDS.lowerBehind,
    startNode: lowerJunction,
    endNode: lowerBehindAnchor,
    slack: 1 + slackDelta * 0.3,
    bowHint: [0.1, -1, 0],
  });
  add({
    id: STRAND_IDS.unstableCandidate,
    startNode: primaryRear,
    endNode: unstableAnchor,
    slack: 1 + slackDelta * 0.18,
    bowHint: [0, -1, 0.1],
    stiffnessScale: 0.08,
    linearDensityScale: 0.45,
    active: false,
  });

  const initialContacts = {} as Record<SpiderLegId, StrandAddress>;
  for (const legId of SPIDER_LEG_IDS) {
    const support = legId.startsWith("L") ? primarySupport : angledSupport;
    initialContacts[legId] = closestContinuousAddress(
      network,
      support,
      NEUTRAL_FOOT_REFERENCES[legId],
    );
    // The asymmetric rear rail settles toward the movable Y under eight-foot
    // load. Give the longest rear leg a small material-distance reserve so it
    // remains inside maximum reach after that loaded settle, not merely in the
    // unloaded authored geometry.
    if (legId === "R4") {
      initialContacts[legId] = {
        strandId: support.id,
        t: Math.max(0.05, initialContacts[legId].t - 0.055),
      };
    }
  }

  assignMaterialNodeMasses(network);
  network.syncParticleDamping();
  validateFixture(network, initialContacts);

  const activeStrandIds = strands.filter((strand) => strand.active).map((strand) => strand.id);
  const allStrandIds = strands.map((strand) => strand.id);
  const supportCenter = calculateSupportCenter(network, initialContacts);

  return {
    network,
    nodes: network.nodeList,
    strands,
    strandIds: {
      ...STRAND_IDS,
      active: activeStrandIds,
      all: allStrandIds,
    },
    junctionIds: {
      ...JUNCTION_IDS,
      all: [JUNCTION_IDS.y, JUNCTION_IDS.lower],
    },
    initialContacts,
    initiallyLoadedLegIds: [...SPIDER_LEG_IDS],
    scenarioDestinations: {
      forward: {
        kind: "strand",
        address: { strandId: STRAND_IDS.primarySupport, t: 0.955 },
      },
      alternate: {
        kind: "strand",
        address: { strandId: STRAND_IDS.angledSupport, t: 0.58 },
      },
      upsideDown: {
        kind: "strand",
        address: { strandId: STRAND_IDS.primarySupport, t: 0.945 },
      },
      noValid: {
        // This address is intentionally real and route-resolvable. Scenario E
        // therefore exercises candidate generation/selection rather than
        // failing early while snapping an unrelated world-space query.
        kind: "strand",
        address: { strandId: STRAND_IDS.lowerBehind, t: 0.92 },
      },
      unstableRejection: {
        kind: "world",
        worldPosition: [-0.08, 0.26, -0.22],
      },
    },
    unstableStrandId: STRAND_IDS.unstableCandidate,
    supportCenter,
    supportFrame: {
      forward: [-1, 0, 0],
      up: [0, 1, 0],
    },
    topology: {
      nodeCount: network.nodeList.length,
      strandCount: network.strandList.length,
      activeStrandCount: activeStrandIds.length,
      particleCount: network.particles.count,
      constraintCount: network.constraintCount,
      connectedComponentCount: 1,
    },
  };
}
