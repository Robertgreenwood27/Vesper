import {
  StrandTraversal,
  createVec3,
  type MutableVec3,
  type StrandAddress,
  type TraversalNodeSource,
  type TraversalStrandSource,
  type Vec3Like,
} from "../../traversal/index";
import { DEFAULT_TRAVERSAL_POLICY_CONFIG } from "./TraversalConfig";
import type {
  LocalRecoveryCandidate,
  LocalRecoveryCandidateSource,
  LocalRecoveryConfig,
  LocalRecoveryRejectionReason,
  LocalRecoveryRequest,
  LocalRecoveryResult,
} from "./TraversalTypes";

const EPSILON = 1e-9;

/**
 * Generates a finite recovery set around one expected semantic contact. It
 * cannot discover geometric crossings: alternate strands are considered only
 * when an endpoint node explicitly lists them as connected.
 */
export class LocalRecoveryPlanner {
  readonly config: LocalRecoveryConfig;

  private readonly expectedPosition = createVec3();
  private readonly candidatePosition = createVec3();
  private readonly localVelocity = createVec3();
  private readonly direction = createVec3();
  private readonly seenAddresses = new Set<string>();
  private readonly junctions: TraversalNodeSource[] = [];

  constructor(
    readonly traversal: StrandTraversal,
    config: LocalRecoveryConfig = DEFAULT_TRAVERSAL_POLICY_CONFIG.recovery,
  ) {
    this.config = { ...config };
  }

  generate(
    request: LocalRecoveryRequest,
    out: LocalRecoveryResult = createLocalRecoveryResult(request),
  ): LocalRecoveryResult {
    resetResult(out, request);
    this.seenAddresses.clear();
    this.junctions.length = 0;
    const expectedStrand = this.traversal.getStrand(request.expectedAddress.strandId);
    if (!expectedStrand || !finiteAddress(request.expectedAddress)) {
      out.exhausted = true;
      return out;
    }
    try {
      this.traversal.getWorldPosition(request.expectedAddress, this.expectedPosition);
    } catch {
      out.exhausted = true;
      return out;
    }

    this.collectEligibleJunctions(request, expectedStrand);
    const hasConnectedSearch = this.junctions.length > 0;
    const sameStrandBudget = Math.min(
      this.config.sameStrandSampleCount,
      hasConnectedSearch
        ? Math.max(1, Math.floor(this.config.maximumAttempts * 0.5))
        : this.config.maximumAttempts,
    );
    this.generateSameStrand(request, expectedStrand, sameStrandBudget, out);
    if (out.attemptedCount < this.config.maximumAttempts) {
      this.generateConnectedStrands(request, expectedStrand, out);
    }

    out.accepted.sort(compareRecoveryCandidates);
    out.selected = out.accepted[0] ?? null;
    out.exhausted = out.selected === null;
    return out;
  }

  private collectEligibleJunctions(
    request: LocalRecoveryRequest,
    strand: TraversalStrandSource,
  ): void {
    if (request.junctionNodeId) {
      const explicit = this.traversal.getNode(request.junctionNodeId);
      if (
        explicit &&
        (strand.startNode.id === explicit.id || strand.endNode.id === explicit.id)
      ) {
        this.junctions.push(explicit);
      }
      return;
    }

    const startDistance = request.expectedAddress.t * strand.totalRestLength;
    const endDistance = (1 - request.expectedAddress.t) * strand.totalRestLength;
    if (startDistance <= this.config.maximumJunctionDistance + EPSILON) {
      this.junctions.push(strand.startNode);
    }
    if (
      endDistance <= this.config.maximumJunctionDistance + EPSILON &&
      strand.endNode.id !== strand.startNode.id
    ) {
      this.junctions.push(strand.endNode);
    }
  }

  private generateSameStrand(
    request: LocalRecoveryRequest,
    strand: TraversalStrandSource,
    budget: number,
    out: LocalRecoveryResult,
  ): void {
    const halfCount = Math.max(1, Math.ceil(budget / 2));
    const maximumDeltaT = this.config.searchRadius / Math.max(EPSILON, strand.totalRestLength);
    for (let sample = 0; sample < budget; sample += 1) {
      if (out.attemptedCount >= this.config.maximumAttempts) return;
      const shell = Math.floor(sample / 2) + 1;
      const sign = sample % 2 === 0 ? 1 : -1;
      const t = clamp01(
        request.expectedAddress.t + sign * maximumDeltaT * (shell / halfCount),
      );
      if (Math.abs(t - request.expectedAddress.t) <= EPSILON) continue;
      this.tryCandidate(
        request,
        strand,
        { strandId: strand.id, t },
        "same-strand",
        null,
        Math.abs(t - request.expectedAddress.t) * strand.totalRestLength,
        out,
      );
    }
  }

  private generateConnectedStrands(
    request: LocalRecoveryRequest,
    expectedStrand: TraversalStrandSource,
    out: LocalRecoveryResult,
  ): void {
    for (const junction of this.junctions) {
      const expectedToJunction = junction.id === expectedStrand.startNode.id
        ? request.expectedAddress.t * expectedStrand.totalRestLength
        : (1 - request.expectedAddress.t) * expectedStrand.totalRestLength;
      for (const strandId of junction.connectedStrandIds) {
        if (out.attemptedCount >= this.config.maximumAttempts) return;
        if (strandId === expectedStrand.id) continue;
        const strand = this.traversal.getStrand(strandId);
        if (
          !strand ||
          (strand.startNode.id !== junction.id && strand.endNode.id !== junction.id)
        ) continue;
        const junctionAtStart = strand.startNode.id === junction.id;
        const availableRadius = Math.max(0, this.config.searchRadius - expectedToJunction);
        if (availableRadius <= EPSILON) continue;
        for (
          let sample = 1;
          sample <= this.config.connectedStrandSampleCount;
          sample += 1
        ) {
          if (out.attemptedCount >= this.config.maximumAttempts) return;
          const distanceAlong =
            availableRadius * sample / this.config.connectedStrandSampleCount;
          const deltaT = distanceAlong / Math.max(EPSILON, strand.totalRestLength);
          const t = clamp01(junctionAtStart ? deltaT : 1 - deltaT);
          this.tryCandidate(
            request,
            strand,
            { strandId: strand.id, t },
            "connected-strand",
            junction.id,
            expectedToJunction + distanceAlong,
            out,
          );
        }
      }
    }
  }

  private tryCandidate(
    request: LocalRecoveryRequest,
    strand: TraversalStrandSource,
    address: StrandAddress,
    source: LocalRecoveryCandidateSource,
    connectedViaNodeId: string | null,
    materialDistance: number,
    out: LocalRecoveryResult,
  ): void {
    const key = `${address.strandId}:${address.t.toFixed(8)}`;
    if (this.seenAddresses.has(key)) return;
    this.seenAddresses.add(key);
    if (out.attemptedCount >= this.config.maximumAttempts) return;
    out.attemptedCount += 1;

    const candidate = createCandidate(source, address, connectedViaNodeId);
    candidate.materialDistanceFromExpected = materialDistance;
    out.candidates.push(candidate);
    if (!strand.active) addRejection(candidate, "inactive-strand", "Strand is inactive.");
    if (strand.broken) addRejection(candidate, "broken-strand", "Strand is broken.");
    if (materialDistance > this.config.searchRadius + EPSILON) {
      addRejection(candidate, "outside-search-radius", "Candidate exceeds the bounded recovery radius.");
    }

    try {
      this.traversal.getWorldPosition(address, this.candidatePosition);
      copy(candidate.worldPosition, this.candidatePosition);
      candidate.localTension = Math.max(
        0,
        this.traversal.getApproximateLocalTension(address),
      );
      this.traversal.getLocalVelocity(address, this.localVelocity);
      candidate.localVelocityMagnitude = length(this.localVelocity);
    } catch (error) {
      addRejection(
        candidate,
        "non-finite-query",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!finiteVector(candidate.worldPosition)) {
      addRejection(candidate, "non-finite-query", "Candidate position is non-finite.");
    }

    const reachScale = request.leg.reachScale ?? 1;
    if (
      !finiteVector(request.leg.reachOriginWorldPosition) ||
      !Number.isFinite(reachScale) ||
      reachScale <= 0
    ) {
      addRejection(candidate, "non-finite-query", "Leg reach input is invalid.");
    }
    const reachDistance = finiteVector(request.leg.reachOriginWorldPosition)
      ? distance(candidate.worldPosition, request.leg.reachOriginWorldPosition)
      : Infinity;
    const maximumReach = request.leg.reach.max * reachScale;
    const minimumReach = request.leg.reach.min * reachScale;
    candidate.reachRatio = reachDistance / Math.max(EPSILON, maximumReach);
    if (reachDistance > maximumReach + EPSILON) {
      addRejection(candidate, "outside-reach", "Candidate exceeds maximum leg reach.");
    }
    if (reachDistance + EPSILON < minimumReach) {
      addRejection(candidate, "inside-minimum-reach", "Candidate compresses the leg below minimum reach.");
    }

    let nearestSupport = Infinity;
    for (const support of request.supports) {
      if (!support.planted || !support.valid || support.legId === request.leg.legId) continue;
      nearestSupport = Math.min(
        nearestSupport,
        distance(candidate.worldPosition, support.position),
      );
    }
    if (nearestSupport < this.config.minimumFootSpacing) {
      addRejection(candidate, "support-crowding", "Candidate crowds another planted foot.");
    }

    subtract(this.direction, candidate.worldPosition, this.expectedPosition);
    const directionLength = length(this.direction);
    const routeLength = finiteVector(request.routeDirection)
      ? length(request.routeDirection)
      : 0;
    if (!finiteVector(request.routeDirection)) {
      addRejection(candidate, "non-finite-query", "Route direction is non-finite.");
    }
    candidate.routeAlignment = directionLength > EPSILON && routeLength > EPSILON
      ? dot(this.direction, request.routeDirection) / (directionLength * routeLength)
      : 0;

    if (request.jointFeasibility && candidate.rejectionReasons.length === 0) {
      const feasibility = request.jointFeasibility(
        request.leg,
        candidate.address,
        candidate.worldPosition,
      );
      if (!feasibility.feasible) {
        addRejection(
          candidate,
          "joint-infeasible",
          feasibility.reason ?? "Detached joint feasibility rejected the candidate.",
        );
      }
    }
    if (request.validateCandidate && candidate.rejectionReasons.length === 0) {
      const validation = request.validateCandidate(candidate.address, candidate.worldPosition);
      if (!validation.valid) {
        addRejection(
          candidate,
          "custom-rejection",
          validation.reason ?? "Runtime contact validation rejected the candidate.",
        );
      }
    }

    const distancePreference = clamp01(1 - materialDistance / this.config.searchRadius);
    const reachComfort = clamp01(1 - Math.abs(candidate.reachRatio - 0.66) / 0.66);
    const routePreference = (clamp(candidate.routeAlignment, -1, 1) + 1) * 0.5;
    const motionPenalty = clamp01(candidate.localVelocityMagnitude / 0.5);
    candidate.score =
      distancePreference * 1.1 +
      reachComfort * 0.45 +
      routePreference * 0.35 -
      motionPenalty * 0.25;
    candidate.accepted = candidate.rejectionReasons.length === 0;
    if (candidate.accepted) out.accepted.push(candidate);
    else out.rejected.push(candidate);
  }
}

export function createLocalRecoveryResult(
  request: Pick<LocalRecoveryRequest, "leg" | "expectedAddress">,
): LocalRecoveryResult {
  return {
    legId: request.leg.legId,
    expectedAddress: {
      strandId: request.expectedAddress.strandId,
      t: request.expectedAddress.t,
    },
    candidates: [],
    accepted: [],
    rejected: [],
    attemptedCount: 0,
    exhausted: false,
    selected: null,
  };
}

export function compareRecoveryCandidates(
  first: LocalRecoveryCandidate,
  second: LocalRecoveryCandidate,
): number {
  if (second.score !== first.score) return second.score - first.score;
  if (first.materialDistanceFromExpected !== second.materialDistanceFromExpected) {
    return first.materialDistanceFromExpected - second.materialDistanceFromExpected;
  }
  const strandOrder = first.address.strandId.localeCompare(second.address.strandId);
  return strandOrder !== 0 ? strandOrder : first.address.t - second.address.t;
}

function resetResult(out: LocalRecoveryResult, request: LocalRecoveryRequest): void {
  if (
    out.legId !== request.leg.legId ||
    out.expectedAddress.strandId !== request.expectedAddress.strandId ||
    out.expectedAddress.t !== request.expectedAddress.t
  ) {
    throw new Error("A reusable recovery result must describe the same leg and expected address.");
  }
  out.candidates.length = 0;
  out.accepted.length = 0;
  out.rejected.length = 0;
  out.attemptedCount = 0;
  out.exhausted = false;
  out.selected = null;
}

function createCandidate(
  source: LocalRecoveryCandidateSource,
  address: StrandAddress,
  connectedViaNodeId: string | null,
): LocalRecoveryCandidate {
  return {
    source,
    address: { strandId: address.strandId, t: address.t },
    worldPosition: createVec3(),
    connectedViaNodeId,
    accepted: false,
    score: -Infinity,
    materialDistanceFromExpected: Infinity,
    reachRatio: Infinity,
    routeAlignment: 0,
    localTension: 0,
    localVelocityMagnitude: 0,
    rejectionReasons: [],
    rejectionDetails: [],
  };
}

function addRejection(
  candidate: LocalRecoveryCandidate,
  reason: LocalRecoveryRejectionReason,
  detail: string,
): void {
  if (!candidate.rejectionReasons.includes(reason)) {
    candidate.rejectionReasons.push(reason);
    candidate.rejectionDetails.push(detail);
  }
}

function finiteAddress(address: StrandAddress): boolean {
  return Boolean(address.strandId) && Number.isFinite(address.t) &&
    address.t >= 0 && address.t <= 1;
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function copy(out: MutableVec3, value: Vec3Like): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

function subtract(out: MutableVec3, first: Vec3Like, second: Vec3Like): void {
  out.x = first.x - second.x;
  out.y = first.y - second.y;
  out.z = first.z - second.z;
}

function dot(first: Vec3Like, second: Vec3Like): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

function length(value: Vec3Like): number {
  return Math.hypot(value.x, value.y, value.z);
}

function distance(first: Vec3Like, second: Vec3Like): number {
  return Math.hypot(
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  );
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
