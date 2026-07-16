import type { LabConfig } from "../config";
import {
  SPIDER_LEG_IDS,
  type SpiderLegId,
} from "../spider/SpiderRigSpec";
import type {
  RouteDestination,
  StrandAddress,
} from "../traversal";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { StrandLocation, WebStrand } from "./WebStrand";

type Vec3Tuple = readonly [x: number, y: number, z: number];

export type PhaseEightBranchId = "forward" | "angled";

export type PhaseEightValidationScenarioId = "A" | "B" | "C" | "D" | "E" | "F";

export type PhaseEightValidationScenarioKey =
  | "forward"
  | "angled"
  | "falseCrossing"
  | "missingExpectedContact"
  | "repeatedFailure"
  | "cancellation";

export interface PhaseEightScenarioDestinations {
  /** Scenario A: a stable address beyond the mostly-forward Y branch. */
  readonly forward: RouteDestination;
  /** Scenario B: a stable address down and around the angled branch. */
  readonly angled: RouteDestination;
  /** Scenario C: snaps only to the disconnected projection crossing. */
  readonly falseCrossing: RouteDestination;
  /** Scenario D: uses the forward goal while one local interval is rejected. */
  readonly missingExpectedContact: RouteDestination;
  /** Scenario E: uses the forward goal before a bounded candidate blockade. */
  readonly repeatedFailure: RouteDestination;
  /** Scenario F: a real multi-step route suitable for later-step cancellation. */
  readonly cancellation: RouteDestination;
  /** A deterministic query too far from every strand to snap. */
  readonly unreachable: RouteDestination;
}

export interface PhaseEightValidationScenario {
  readonly id: PhaseEightValidationScenarioId;
  readonly key: PhaseEightValidationScenarioKey;
  readonly destination: RouteDestination;
  readonly expectedStop: "arrived" | "route-failed" | "failed-stable" | "cancelled-stable";
}

export interface PhaseEightBranchMetadata {
  readonly id: PhaseEightBranchId;
  /** The only route-bearing strand leaving the true Y for this branch. */
  readonly routeStrandId: string;
  /** Nearby silk accepted as destination-side support by the coordinator. */
  readonly supportStrandIds: readonly string[];
  readonly directionFromJunction: Vec3Tuple;
  /** Immutable authored main/companion plane turn from the approach rails. */
  readonly transitionPlaneTurnRadians: number;
  /** Geometry-derived posture-policy gate; never inferred from live thorax pose. */
  readonly nonCoplanarTransition: boolean;
  readonly destinationAddress: StrandAddress;
  readonly destinationCenter: Vec3Tuple;
  readonly destinationRadius: number;
  readonly bodyCrossingDistance: number;
  readonly minimumDestinationSideContacts: number;
  readonly minimumContactSpread: number;
  readonly maximumTrailingReachRatio: number;
}

export interface PhaseEightJunctionMetadata {
  readonly nodeId: string;
  readonly approachStrandId: string;
  readonly position: Vec3Tuple;
  readonly radius: number;
  readonly connectedStrandIds: readonly string[];
  readonly branchIds: readonly PhaseEightBranchId[];
  readonly transitions: Readonly<
    Record<
      PhaseEightBranchId,
      {
        readonly nodeId: string;
        readonly fromStrandId: string;
        readonly toStrandId: string;
      }
    >
  >;
}

export interface PhaseEightProjectionCrossingMetadata {
  readonly id: string;
  readonly connected: false;
  readonly routeStrandAddress: StrandAddress;
  readonly crossingStrandAddress: StrandAddress;
  readonly routeWorldPosition: Vec3Tuple;
  readonly crossingWorldPosition: Vec3Tuple;
  /** Separation in authored X/Y projection; deliberately close to zero. */
  readonly projectedSeparation: number;
  /** True 3D separation; deliberately non-zero. */
  readonly worldSeparation: number;
}

export interface PhaseEightTemporaryInvalidContact {
  readonly branchId: PhaseEightBranchId;
  readonly expectedAddress: StrandAddress;
  readonly invalidInterval: readonly [minimumT: number, maximumT: number];
  readonly injectAfterCompletedStepCount: number;
  readonly localSearchRadius: number;
  readonly localSearchAttemptCount: number;
  readonly sameStrandFallback: true;
  readonly nearbyFallbackStrandIds: readonly string[];
}

export interface PhaseEightRepeatedFailureInjection {
  readonly branchId: PhaseEightBranchId;
  readonly injectAfterCompletedStepCount: number;
  /** Candidate intervals to reject without invalidating already planted silk. */
  readonly blockedCandidateIntervals: readonly {
    readonly strandId: string;
    readonly minimumT: number;
    readonly maximumT: number;
  }[];
  readonly maximumPlanningFailures: number;
}

export interface PhaseEightCancellationInjection {
  readonly injectAfterCompletedStepCount: number;
  readonly preferredTraversalState: "committing-body";
  readonly fallbackAtomicState: "swinging";
}

export interface PhaseEightStrandIds {
  readonly approachMain: string;
  readonly approachCompanion: string;
  readonly forwardMain: string;
  readonly forwardCompanion: string;
  readonly angledMain: string;
  readonly angledCompanion: string;
  readonly weakOptionalNear: string;
  readonly weakOptionalFar: string;
  readonly falseCrossing: string;
  readonly approachRegion: readonly string[];
  readonly forwardRegion: readonly string[];
  readonly angledRegion: readonly string[];
  readonly weakOrMoving: readonly string[];
  readonly active: readonly string[];
  readonly all: readonly string[];
}

export interface PhaseEightNodeIds {
  readonly trueY: string;
  readonly movableOptionalSupport: string;
  readonly fixedApproachAnchor: string;
  readonly fixedForwardAnchor: string;
  readonly fixedAngledAnchor: string;
  readonly all: readonly string[];
}

export interface PhaseEightFixture {
  readonly network: WebNetwork;
  readonly nodes: readonly WebNode[];
  readonly strands: readonly WebStrand[];
  readonly strandIds: PhaseEightStrandIds;
  readonly nodeIds: PhaseEightNodeIds;
  /** Eight continuous semantic contacts, independent of particle resolution. */
  readonly initialContacts: Readonly<Record<SpiderLegId, StrandAddress>>;
  readonly initiallyLoadedLegIds: readonly SpiderLegId[];
  /** A semantic route origin close to the weighted initial support center. */
  readonly initialRouteAddress: StrandAddress;
  readonly scenarioDestinations: PhaseEightScenarioDestinations;
  readonly validationScenarios: Readonly<
    Record<PhaseEightValidationScenarioId, PhaseEightValidationScenario>
  >;
  readonly branches: Readonly<Record<PhaseEightBranchId, PhaseEightBranchMetadata>>;
  readonly junction: PhaseEightJunctionMetadata;
  readonly falseProjectionCrossing: PhaseEightProjectionCrossingMetadata;
  readonly weakSupport: {
    readonly movableNodeId: string;
    readonly strandIds: readonly string[];
    readonly stiffnessScale: number;
  };
  readonly faultInjection: {
    readonly temporaryInvalidContact: PhaseEightTemporaryInvalidContact;
    readonly repeatedFailure: PhaseEightRepeatedFailureInjection;
    readonly cancellation: PhaseEightCancellationInjection;
  };
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
    readonly connectedComponentCount: number;
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
const JUNCTION_MASS = 0.075;
const OPTIONAL_SUPPORT_STIFFNESS_SCALE = 0.22;

const STRAND_IDS = {
  approachMain: "phase8-approach-main",
  approachCompanion: "phase8-approach-companion",
  forwardMain: "phase8-forward-main",
  forwardCompanion: "phase8-forward-companion",
  angledMain: "phase8-angled-main",
  angledCompanion: "phase8-angled-companion",
  weakOptionalNear: "phase8-weak-optional-near",
  weakOptionalFar: "phase8-weak-optional-far",
  falseCrossing: "phase8-false-projection-crossing",
} as const;

const NODE_IDS = {
  trueY: "phase8-junction-y",
  movableOptionalSupport: "phase8-movable-optional-support",
  fixedApproachAnchor: "phase8-anchor-approach-main",
  fixedForwardAnchor: "phase8-anchor-forward-main",
  fixedAngledAnchor: "phase8-anchor-angled-main",
} as const;

// Phase 6/7 neutral foot homes translated 0.38 units toward the rear of this
// approach. The spider begins clearly before the Y while leaving enough of the
// bounded step budget for branch support and body commitment.
const INITIAL_FOOT_REFERENCES: Readonly<Record<SpiderLegId, Vec3Tuple>> = {
  L1: [-0.624, -0.0085, 0.226],
  L2: [-0.037, 0.0053, 0.628],
  L3: [0.343, 0.0216, 0.63],
  L4: [0.863, 0.0482, 0.439],
  R1: [-0.626, 0.0047, -0.227],
  R2: [-0.043, 0.0395, -0.633],
  R3: [0.337, 0.0556, -0.638],
  R4: [0.858, 0.0721, -0.451],
};

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

const SAMPLE_LOCATION: StrandLocation = { segmentIndex: 0, t: 0, u: 0 };

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
    throw new Error("A Phase 8 strand cannot have coincident endpoint nodes.");
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
  let high = chordLength * 0.5;
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

function semanticRailPlaneNormal(
  network: WebNetwork,
  main: WebStrand,
  companion: WebStrand,
  address: StrandAddress,
): Vec3Tuple {
  const sampleT = Math.max(0, Math.min(1, address.t));
  const lowerT = Math.max(0, sampleT - 0.025);
  const upperT = Math.min(1, sampleT + 0.025);
  const lower = sampleInitialAddress(network, main, {
    strandId: main.id,
    t: lowerT,
  });
  const upper = sampleInitialAddress(network, main, {
    strandId: main.id,
    t: upperT,
  });
  const tangent = normalizedDirection(lower, upper);
  const mainPosition = sampleInitialAddress(network, main, {
    strandId: main.id,
    t: sampleT,
  });
  const companionAddress = closestContinuousAddress(
    network,
    companion,
    mainPosition,
  );
  const companionPosition = sampleInitialAddress(
    network,
    companion,
    companionAddress,
  );
  const lateralProjection =
    (companionPosition[0] - mainPosition[0]) * tangent[0] +
    (companionPosition[1] - mainPosition[1]) * tangent[1] +
    (companionPosition[2] - mainPosition[2]) * tangent[2];
  const lateral: Vec3Tuple = [
    companionPosition[0] - mainPosition[0] - tangent[0] * lateralProjection,
    companionPosition[1] - mainPosition[1] - tangent[1] * lateralProjection,
    companionPosition[2] - mainPosition[2] - tangent[2] * lateralProjection,
  ];
  const normal: Vec3Tuple = [
    lateral[1] * tangent[2] - lateral[2] * tangent[1],
    lateral[2] * tangent[0] - lateral[0] * tangent[2],
    lateral[0] * tangent[1] - lateral[1] * tangent[0],
  ];
  const normalLength = Math.hypot(normal[0], normal[1], normal[2]);
  if (!Number.isFinite(normalLength) || normalLength <= 1e-8) {
    throw new Error(`Phase 8 rail plane ${main.id}/${companion.id} is degenerate.`);
  }
  return [
    normal[0] / normalLength,
    normal[1] / normalLength,
    normal[2] / normalLength,
  ];
}

function semanticPlaneTurnRadians(
  approachNormal: Vec3Tuple,
  destinationNormal: Vec3Tuple,
): number {
  const unorientedPlaneDot = Math.abs(
    approachNormal[0] * destinationNormal[0] +
    approachNormal[1] * destinationNormal[1] +
    approachNormal[2] * destinationNormal[2],
  );
  return Math.acos(Math.max(0, Math.min(1, unorientedPlaneDot)));
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
      throw new Error(`Phase 8 initial contact ${legId} references missing strand ${address.strandId}.`);
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

function normalizedDirection(from: Vec3Tuple, to: Vec3Tuple): Vec3Tuple {
  const x = to[0] - from[0];
  const y = to[1] - from[1];
  const z = to[2] - from[2];
  const length = Math.hypot(x, y, z);
  if (length < 1e-8) {
    throw new Error("Phase 8 branch direction requires distinct points.");
  }
  return [x / length, y / length, z / length];
}

function distance(left: Vec3Tuple, right: Vec3Tuple): number {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
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
    network.setNodeMass(node, JUNCTION_MASS + adjacentMaterialMass);
  }
}

function activeConnectedComponents(network: WebNetwork): Map<string, number> {
  const components = new Map<string, number>();
  let component = 0;
  for (const startNode of network.nodeList) {
    if (components.has(startNode.id)) continue;
    const pending = [startNode];
    components.set(startNode.id, component);
    while (pending.length > 0) {
      const node = pending.pop();
      if (!node) continue;
      for (const strandId of node.connectedStrandIds) {
        const strand = network.strands.get(strandId);
        if (!strand?.active || strand.broken) continue;
        const other = strand.startNode === node ? strand.endNode : strand.startNode;
        if (!components.has(other.id)) {
          components.set(other.id, component);
          pending.push(other);
        }
      }
    }
    component += 1;
  }
  return components;
}

function validateFixture(
  network: WebNetwork,
  contacts: Readonly<Record<SpiderLegId, StrandAddress>>,
  supportCenter: Vec3Tuple,
  crossing: PhaseEightProjectionCrossingMetadata,
): void {
  const yNode = network.nodes.get(NODE_IDS.trueY);
  const expectedYStrands = new Set<string>([
    STRAND_IDS.approachMain,
    STRAND_IDS.forwardMain,
    STRAND_IDS.angledMain,
  ]);
  if (
    !yNode ||
    yNode.connectedStrandIds.size !== 3 ||
    [...expectedYStrands].some((strandId) => !yNode.connectedStrandIds.has(strandId))
  ) {
    throw new Error("Phase 8 true Y must remain exactly the approach, forward, and angled strands.");
  }

  const movable = network.nodes.get(NODE_IDS.movableOptionalSupport);
  const approach = network.strands.get(STRAND_IDS.approachMain);
  const weakNear = network.strands.get(STRAND_IDS.weakOptionalNear);
  const weakFar = network.strands.get(STRAND_IDS.weakOptionalFar);
  if (
    !movable ||
    movable.isFixed ||
    movable.connectedStrandIds.size !== 2 ||
    !approach ||
    !weakNear ||
    !weakFar ||
    weakNear.stiffness >= approach.stiffness ||
    weakFar.stiffness >= approach.stiffness
  ) {
    throw new Error("Phase 8 optional support must remain weak and attached through one movable node.");
  }

  const components = activeConnectedComponents(network);
  const falseStrand = network.strands.get(STRAND_IDS.falseCrossing);
  if (
    !falseStrand?.active ||
    falseStrand.broken ||
    components.get(falseStrand.startNode.id) === components.get(NODE_IDS.trueY)
  ) {
    throw new Error("Phase 8 false crossing must be active, unbroken, and topologically disconnected.");
  }
  if (
    crossing.connected ||
    crossing.projectedSeparation > 0.12 ||
    crossing.worldSeparation < 0.4
  ) {
    throw new Error("Phase 8 crossing must overlap only in projection and remain separated in 3D.");
  }

  for (const legId of SPIDER_LEG_IDS) {
    const address = contacts[legId];
    const strand = network.strands.get(address.strandId);
    if (
      !strand?.active ||
      strand.broken ||
      !Number.isFinite(address.t) ||
      address.t <= 0.05 ||
      address.t >= 0.95 ||
      (address.strandId !== STRAND_IDS.approachMain &&
        address.strandId !== STRAND_IDS.approachCompanion)
    ) {
      throw new Error(`Phase 8 initial contact ${legId} is not a valid interior approach address.`);
    }
  }

  const junctionPosition = readNodePosition(network, yNode);
  if (supportCenter[0] <= junctionPosition[0] + 0.7) {
    throw new Error("Phase 8 support center must begin clearly before the junction.");
  }

  const forward = network.strands.get(STRAND_IDS.forwardMain);
  const angled = network.strands.get(STRAND_IDS.angledMain);
  if (!forward || !angled) {
    throw new Error("Phase 8 fixture lost a required destination branch.");
  }
  const forwardEnd = readNodePosition(network, forward.endNode);
  const angledEnd = readNodePosition(network, angled.endNode);
  if (
    Math.abs(angledEnd[1] - junctionPosition[1]) < 0.75 ||
    Math.abs(angledEnd[2] - junctionPosition[2]) < 1.1 ||
    distance(forwardEnd, angledEnd) < 1.5
  ) {
    throw new Error("Phase 8 branch endpoints must remain meaningfully distinct in true 3D.");
  }
}

/**
 * Builds the compact deterministic course for a deliberate Phase 8 junction
 * traverse. Shared endpoint nodes are the sole source of graph connectivity:
 * companion rails and the false crossing are nearby physical silk, but never
 * implicit route edges. Fault scenarios are described as metadata so the
 * coordinator can reject bounded candidate intervals without corrupting held
 * contacts or changing this reusable baseline fixture.
 */
export function createPhaseEightFixture(config: LabConfig): PhaseEightFixture {
  const network = new WebNetwork();
  const pointCount = Math.max(12, Math.round(config.pointCount));
  const slackDelta = Math.max(0, config.slack - 1);

  const approachAnchor = network.addNode(
    NODE_IDS.fixedApproachAnchor,
    "PHASE 8 FIXED APPROACH ANCHOR",
    1.8,
    0.04,
    0.45,
    "fixed",
  );
  const trueY = network.addNode(
    NODE_IDS.trueY,
    "PHASE 8 TRUE MOVABLE Y",
    -1.45,
    -0.04,
    0.35,
    "dynamic",
    JUNCTION_MASS,
  );
  const forwardAnchor = network.addNode(
    NODE_IDS.fixedForwardAnchor,
    "PHASE 8 FIXED FORWARD DESTINATION",
    -3.65,
    0.18,
    0.49,
    "fixed",
  );
  const angledAnchor = network.addNode(
    NODE_IDS.fixedAngledAnchor,
    "PHASE 8 FIXED ANGLED DESTINATION",
    -3.05,
    -1.22,
    -1.38,
    "fixed",
  );

  const approachCompanionRear = network.addNode(
    "phase8-anchor-approach-companion-rear",
    "FIXED APPROACH COMPANION REAR",
    1.76,
    0.08,
    -0.48,
    "fixed",
  );
  const approachCompanionFront = network.addNode(
    "phase8-anchor-approach-companion-front",
    "FIXED APPROACH COMPANION FRONT",
    -1.24,
    -0.14,
    -0.5,
    "fixed",
  );
  const forwardCompanionNear = network.addNode(
    "phase8-anchor-forward-companion-near",
    "FIXED FORWARD COMPANION NEAR",
    -1.3,
    0.1,
    -0.29,
    "fixed",
  );
  const forwardCompanionFar = network.addNode(
    "phase8-anchor-forward-companion-far",
    "FIXED FORWARD COMPANION FAR",
    -3.55,
    0.3,
    -0.22,
    "fixed",
  );
  const angledCompanionNear = network.addNode(
    "phase8-anchor-angled-companion-near",
    "FIXED ANGLED COMPANION NEAR",
    -1.28,
    -0.14,
    -0.47,
    "fixed",
  );
  const angledCompanionFar = network.addNode(
    "phase8-anchor-angled-companion-far",
    "FIXED ANGLED COMPANION FAR",
    -3.02,
    -1.28,
    -1.94,
    "fixed",
  );

  const weakAnchorNear = network.addNode(
    "phase8-anchor-weak-near",
    "FIXED WEAK SUPPORT NEAR",
    -0.92,
    0.68,
    0.02,
    "fixed",
  );
  const movableOptionalSupport = network.addNode(
    NODE_IDS.movableOptionalSupport,
    "MOVABLE WEAK OPTIONAL SUPPORT",
    -1.72,
    0.16,
    -0.07,
    "dynamic",
    JUNCTION_MASS,
  );
  const weakAnchorFar = network.addNode(
    "phase8-anchor-weak-far",
    "FIXED WEAK SUPPORT FAR",
    -2.42,
    0.64,
    -0.02,
    "fixed",
  );

  const falseCrossingLow = network.addNode(
    "phase8-anchor-false-crossing-low",
    "FALSE CROSSING LOW",
    -2.12,
    -1.16,
    -0.28,
    "fixed",
  );
  const falseCrossingHigh = network.addNode(
    "phase8-anchor-false-crossing-high",
    "FALSE CROSSING HIGH",
    -2.12,
    1.16,
    -0.28,
    "fixed",
  );

  const strands: WebStrand[] = [];
  const add = (options: CourseStrandOptions): WebStrand => {
    const strand = addCourseStrand(network, config, pointCount, options);
    strands.push(strand);
    return strand;
  };

  const approachMain = add({
    id: STRAND_IDS.approachMain,
    startNode: approachAnchor,
    endNode: trueY,
    slack: 1 + slackDelta * 0.1,
    bowHint: [0, -1, 0.08],
  });
  const forwardMain = add({
    id: STRAND_IDS.forwardMain,
    startNode: trueY,
    endNode: forwardAnchor,
    slack: 1 + slackDelta * 0.12,
    bowHint: [0, -1, 0],
  });
  const angledMain = add({
    id: STRAND_IDS.angledMain,
    startNode: trueY,
    endNode: angledAnchor,
    slack: 1 + slackDelta * 0.14,
    bowHint: [0.15, -0.25, 1],
  });
  const approachCompanion = add({
    id: STRAND_IDS.approachCompanion,
    startNode: approachCompanionRear,
    endNode: approachCompanionFront,
    slack: 1 + slackDelta * 0.08,
    bowHint: [0, -1, -0.05],
  });
  const forwardCompanion = add({
    id: STRAND_IDS.forwardCompanion,
    startNode: forwardCompanionNear,
    endNode: forwardCompanionFar,
    slack: 1 + slackDelta * 0.1,
    bowHint: [0, -1, 0.08],
  });
  const angledCompanion = add({
    id: STRAND_IDS.angledCompanion,
    startNode: angledCompanionNear,
    endNode: angledCompanionFar,
    slack: 1 + slackDelta * 0.12,
    bowHint: [0.1, -0.15, 1],
  });
  add({
    id: STRAND_IDS.weakOptionalNear,
    startNode: weakAnchorNear,
    endNode: movableOptionalSupport,
    slack: 1 + slackDelta * 0.34,
    bowHint: [0, -1, 0.2],
    stiffnessScale: OPTIONAL_SUPPORT_STIFFNESS_SCALE,
    linearDensityScale: 0.5,
  });
  add({
    id: STRAND_IDS.weakOptionalFar,
    startNode: movableOptionalSupport,
    endNode: weakAnchorFar,
    slack: 1 + slackDelta * 0.34,
    bowHint: [0, -1, -0.2],
    stiffnessScale: OPTIONAL_SUPPORT_STIFFNESS_SCALE,
    linearDensityScale: 0.5,
  });
  const falseCrossing = add({
    id: STRAND_IDS.falseCrossing,
    startNode: falseCrossingLow,
    endNode: falseCrossingHigh,
    slack: 1,
    bowHint: [1, 0, 0],
  });

  const initialContacts = {} as Record<SpiderLegId, StrandAddress>;
  for (const legId of SPIDER_LEG_IDS) {
    const support = legId.startsWith("L") ? approachMain : approachCompanion;
    initialContacts[legId] = closestContinuousAddress(
      network,
      support,
      INITIAL_FOOT_REFERENCES[legId],
    );
    // The movable Y settles substantially under the full eight-foot load.
    // Keep the longest forward leg just inside its loaded reach envelope after
    // that settle rather than only in the authored, unloaded geometry.
    if (legId === "L1") {
      initialContacts[legId] = {
        strandId: support.id,
        t: Math.max(0.05, initialContacts[legId].t - 0.022),
      };
    }
    if (legId === "R2") {
      // R2 is the inside middle leg for the angled branch turn. Seed it a small
      // material distance forward so the deliberate early yaw/roll has folded-
      // reach margin before any foot is released.
      initialContacts[legId] = {
        strandId: support.id,
        t: Math.min(0.95, initialContacts[legId].t + 0.08),
      };
    }
  }

  assignMaterialNodeMasses(network);
  network.syncParticleDamping();

  const supportCenter = calculateSupportCenter(network, initialContacts);
  const initialRouteAddress = closestContinuousAddress(network, approachMain, supportCenter);
  const junctionPosition = readNodePosition(network, trueY);
  const forwardDestinationAddress: StrandAddress = {
    strandId: STRAND_IDS.forwardMain,
    t: 0.9,
  };
  const angledDestinationAddress: StrandAddress = {
    strandId: STRAND_IDS.angledMain,
    t: 0.9,
  };
  const forwardDestinationCenter = sampleInitialAddress(
    network,
    forwardMain,
    forwardDestinationAddress,
  );
  const angledDestinationCenter = sampleInitialAddress(
    network,
    angledMain,
    angledDestinationAddress,
  );
  const approachPlaneNormal = semanticRailPlaneNormal(
    network,
    approachMain,
    approachCompanion,
    initialRouteAddress,
  );
  const forwardTransitionPlaneTurn = semanticPlaneTurnRadians(
    approachPlaneNormal,
    semanticRailPlaneNormal(network, forwardMain, forwardCompanion, {
      strandId: forwardMain.id,
      t: forwardDestinationAddress.t * 0.25,
    }),
  );
  const angledTransitionPlaneTurn = semanticPlaneTurnRadians(
    approachPlaneNormal,
    semanticRailPlaneNormal(network, angledMain, angledCompanion, {
      strandId: angledMain.id,
      t: angledDestinationAddress.t * 0.25,
    }),
  );

  const forwardCrossingAddress: StrandAddress = {
    strandId: STRAND_IDS.forwardMain,
    t: 0.305,
  };
  const forwardCrossingPosition = sampleInitialAddress(
    network,
    forwardMain,
    forwardCrossingAddress,
  );
  const falseCrossingT = Math.max(
    0,
    Math.min(1, (forwardCrossingPosition[1] + 1.16) / 2.32),
  );
  const falseCrossingAddress: StrandAddress = {
    strandId: STRAND_IDS.falseCrossing,
    t: falseCrossingT,
  };
  const falseCrossingPosition = sampleInitialAddress(
    network,
    falseCrossing,
    falseCrossingAddress,
  );
  const projectedSeparation = Math.hypot(
    forwardCrossingPosition[0] - falseCrossingPosition[0],
    forwardCrossingPosition[1] - falseCrossingPosition[1],
  );
  const worldSeparation = distance(forwardCrossingPosition, falseCrossingPosition);
  const crossingMetadata: PhaseEightProjectionCrossingMetadata = {
    id: "phase8-projection-only-crossing",
    connected: false,
    routeStrandAddress: forwardCrossingAddress,
    crossingStrandAddress: falseCrossingAddress,
    routeWorldPosition: forwardCrossingPosition,
    crossingWorldPosition: falseCrossingPosition,
    projectedSeparation,
    worldSeparation,
  };

  const forwardDestination: RouteDestination = {
    kind: "address",
    address: forwardDestinationAddress,
  };
  const angledDestination: RouteDestination = {
    kind: "address",
    address: angledDestinationAddress,
  };
  const falseCrossingDestination: RouteDestination = {
    kind: "world",
    position: {
      x: falseCrossingPosition[0],
      y: falseCrossingPosition[1],
      z: falseCrossingPosition[2],
    },
    maximumSnapDistance: 0.14,
  };
  const unreachableDestination: RouteDestination = {
    kind: "world",
    position: { x: -5.8, y: 3.9, z: 4.6 },
    maximumSnapDistance: 0.12,
  };
  const scenarioDestinations: PhaseEightScenarioDestinations = {
    forward: forwardDestination,
    angled: angledDestination,
    falseCrossing: falseCrossingDestination,
    missingExpectedContact: forwardDestination,
    repeatedFailure: forwardDestination,
    cancellation: angledDestination,
    unreachable: unreachableDestination,
  };

  const branches: Readonly<Record<PhaseEightBranchId, PhaseEightBranchMetadata>> = {
    forward: {
      id: "forward",
      routeStrandId: STRAND_IDS.forwardMain,
      supportStrandIds: [STRAND_IDS.forwardMain, STRAND_IDS.forwardCompanion],
      directionFromJunction: normalizedDirection(junctionPosition, forwardDestinationCenter),
      transitionPlaneTurnRadians: forwardTransitionPlaneTurn,
      nonCoplanarTransition: forwardTransitionPlaneTurn >= Math.PI / 12,
      destinationAddress: forwardDestinationAddress,
      destinationCenter: forwardDestinationCenter,
      destinationRadius: 0.44,
      bodyCrossingDistance: 0.42,
      minimumDestinationSideContacts: 3,
      minimumContactSpread: 0.3,
      maximumTrailingReachRatio: 0.9,
    },
    angled: {
      id: "angled",
      routeStrandId: STRAND_IDS.angledMain,
      supportStrandIds: [STRAND_IDS.angledMain, STRAND_IDS.angledCompanion],
      directionFromJunction: normalizedDirection(junctionPosition, angledDestinationCenter),
      transitionPlaneTurnRadians: angledTransitionPlaneTurn,
      nonCoplanarTransition: angledTransitionPlaneTurn >= Math.PI / 12,
      destinationAddress: angledDestinationAddress,
      destinationCenter: angledDestinationCenter,
      destinationRadius: 0.48,
      bodyCrossingDistance: 0.4,
      minimumDestinationSideContacts: 2,
      minimumContactSpread: 0.32,
      maximumTrailingReachRatio: 0.999,
    },
  };

  const validationScenarios: Readonly<
    Record<PhaseEightValidationScenarioId, PhaseEightValidationScenario>
  > = {
    A: {
      id: "A",
      key: "forward",
      destination: scenarioDestinations.forward,
      expectedStop: "arrived",
    },
    B: {
      id: "B",
      key: "angled",
      destination: scenarioDestinations.angled,
      expectedStop: "arrived",
    },
    C: {
      id: "C",
      key: "falseCrossing",
      destination: scenarioDestinations.falseCrossing,
      expectedStop: "route-failed",
    },
    D: {
      id: "D",
      key: "missingExpectedContact",
      destination: scenarioDestinations.missingExpectedContact,
      expectedStop: "arrived",
    },
    E: {
      id: "E",
      key: "repeatedFailure",
      destination: scenarioDestinations.repeatedFailure,
      expectedStop: "failed-stable",
    },
    F: {
      id: "F",
      key: "cancellation",
      destination: scenarioDestinations.cancellation,
      expectedStop: "cancelled-stable",
    },
  };

  validateFixture(network, initialContacts, supportCenter, crossingMetadata);

  const activeStrandIds = strands
    .filter((strand) => strand.active && !strand.broken)
    .map((strand) => strand.id);
  const components = activeConnectedComponents(network);
  const connectedComponentCount = new Set(components.values()).size;

  return {
    network,
    nodes: network.nodeList,
    strands,
    strandIds: {
      ...STRAND_IDS,
      approachRegion: [STRAND_IDS.approachMain, STRAND_IDS.approachCompanion],
      forwardRegion: [STRAND_IDS.forwardMain, STRAND_IDS.forwardCompanion],
      angledRegion: [STRAND_IDS.angledMain, STRAND_IDS.angledCompanion],
      weakOrMoving: [STRAND_IDS.weakOptionalNear, STRAND_IDS.weakOptionalFar],
      active: activeStrandIds,
      all: strands.map((strand) => strand.id),
    },
    nodeIds: {
      ...NODE_IDS,
      all: network.nodeList.map((node) => node.id),
    },
    initialContacts,
    initiallyLoadedLegIds: [...SPIDER_LEG_IDS],
    initialRouteAddress,
    scenarioDestinations,
    validationScenarios,
    branches,
    junction: {
      nodeId: NODE_IDS.trueY,
      approachStrandId: STRAND_IDS.approachMain,
      position: junctionPosition,
      radius: 0.48,
      connectedStrandIds: [
        STRAND_IDS.approachMain,
        STRAND_IDS.forwardMain,
        STRAND_IDS.angledMain,
      ],
      branchIds: ["forward", "angled"],
      transitions: {
        forward: {
          nodeId: NODE_IDS.trueY,
          fromStrandId: STRAND_IDS.approachMain,
          toStrandId: STRAND_IDS.forwardMain,
        },
        angled: {
          nodeId: NODE_IDS.trueY,
          fromStrandId: STRAND_IDS.approachMain,
          toStrandId: STRAND_IDS.angledMain,
        },
      },
    },
    falseProjectionCrossing: crossingMetadata,
    weakSupport: {
      movableNodeId: NODE_IDS.movableOptionalSupport,
      strandIds: [STRAND_IDS.weakOptionalNear, STRAND_IDS.weakOptionalFar],
      stiffnessScale: OPTIONAL_SUPPORT_STIFFNESS_SCALE,
    },
    faultInjection: {
      temporaryInvalidContact: {
        branchId: "forward",
        expectedAddress: { strandId: STRAND_IDS.forwardMain, t: 0.48 },
        invalidInterval: [0.43, 0.53],
        injectAfterCompletedStepCount: 2,
        localSearchRadius: 0.24,
        localSearchAttemptCount: 4,
        sameStrandFallback: true,
        nearbyFallbackStrandIds: [STRAND_IDS.forwardCompanion],
      },
      repeatedFailure: {
        branchId: "forward",
        injectAfterCompletedStepCount: 3,
        blockedCandidateIntervals: [
          { strandId: STRAND_IDS.forwardMain, minimumT: 0.56, maximumT: 1 },
          { strandId: STRAND_IDS.forwardCompanion, minimumT: 0.5, maximumT: 1 },
          { strandId: STRAND_IDS.weakOptionalFar, minimumT: 0, maximumT: 1 },
        ],
        maximumPlanningFailures: 2,
      },
      cancellation: {
        injectAfterCompletedStepCount: 2,
        preferredTraversalState: "committing-body",
        fallbackAtomicState: "swinging",
      },
    },
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
      connectedComponentCount,
    },
  };
}
