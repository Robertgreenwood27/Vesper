import {
  createContactFrame,
  type StrandTraversal,
  type TraversalStrandSource,
  type Vec3Like,
} from "../../traversal/index";
import { createFootholdScore } from "./FootholdScorer";
import type {
  FootholdCandidate,
  FootholdCandidateSeed,
  FootholdCandidateSource,
  FootholdGenerationOptions,
  FootholdGenerationRequest,
  FootholdGenerationResult,
  FootholdLegContext,
  FootholdRejectionReason,
  LocomotionSupportContact,
  LocomotionSupportFrame,
} from "./LocomotionTypes";

const EPSILON = 1e-8;
const DEFAULT_SEARCH_RADIUS = 0.72;
const DEFAULT_SAMPLES_PER_STRAND = 7;
const DEFAULT_TENSION_REFERENCE = 0.18;
const DEFAULT_VELOCITY_REFERENCE = 0.35;
const DEFAULT_MINIMUM_FOOT_SPACING = 0.16;
const DEFAULT_CONNECTIVITY_DEGREE_REFERENCE = 3;
const DEFAULT_SEED_NEIGHBOR_RADIUS_FACTOR = 0.2;
const MAXIMUM_DEFAULT_SEED_NEIGHBOR_RADIUS = 0.12;

interface NormalizedGenerationOptions {
  readonly searchRadius: number;
  readonly samplesPerStrand: number;
  readonly retainRejected: boolean;
  readonly referenceUp: Vec3Like;
  readonly tensionReference: number;
  readonly velocityReference: number;
  readonly minimumFootSpacing: number;
  readonly minimumReachSafetyFactor: number;
  readonly connectivityDegreeReference: number;
}

function vector(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function clamp01(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function distance(left: Vec3Like, right: Vec3Like): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function dotDifference(
  target: Vec3Like,
  origin: Vec3Like,
  direction: Vec3Like,
): number {
  return (
    (target.x - origin.x) * direction.x +
    (target.y - origin.y) * direction.y +
    (target.z - origin.z) * direction.z
  );
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

function normalizeOptions(
  options: FootholdGenerationOptions | undefined,
  fallbackUp: Vec3Like,
): NormalizedGenerationOptions {
  return {
    searchRadius: positive(options?.searchRadius, DEFAULT_SEARCH_RADIUS),
    samplesPerStrand: Math.max(
      2,
      Math.min(32, Math.round(positive(options?.samplesPerStrand, DEFAULT_SAMPLES_PER_STRAND))),
    ),
    retainRejected: options?.retainRejected ?? true,
    referenceUp: options?.referenceUp ?? fallbackUp,
    tensionReference: positive(options?.tensionReference, DEFAULT_TENSION_REFERENCE),
    velocityReference: positive(options?.velocityReference, DEFAULT_VELOCITY_REFERENCE),
    minimumFootSpacing: positive(
      options?.minimumFootSpacing,
      DEFAULT_MINIMUM_FOOT_SPACING,
    ),
    minimumReachSafetyFactor: positive(options?.minimumReachSafetyFactor, 1),
    connectivityDegreeReference: positive(
      options?.connectivityDegreeReference,
      DEFAULT_CONNECTIVITY_DEGREE_REFERENCE,
    ),
  };
}

function pushReason(
  reasons: FootholdRejectionReason[],
  details: string[],
  reason: FootholdRejectionReason,
  detail?: string,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
    details.push(detail ?? reason);
  }
}

function reachComfort(
  reachDistance: number,
  minimum: number,
  comfortable: number,
  maximum: number,
): number {
  if (reachDistance <= comfortable) {
    return clamp01((reachDistance - minimum) / Math.max(EPSILON, comfortable - minimum));
  }
  return clamp01((maximum - reachDistance) / Math.max(EPSILON, maximum - comfortable));
}

function currentPositionForLeg(
  traversal: StrandTraversal,
  leg: FootholdLegContext,
) {
  if (leg.currentWorldPosition && finiteVector(leg.currentWorldPosition)) {
    return vector(
      leg.currentWorldPosition.x,
      leg.currentWorldPosition.y,
      leg.currentWorldPosition.z,
    );
  }
  try {
    return traversal.getWorldPosition(leg.currentAddress, vector());
  } catch {
    return vector(
      leg.footHomeWorldPosition.x,
      leg.footHomeWorldPosition.y,
      leg.footHomeWorldPosition.z,
    );
  }
}

/**
 * One-shot, deterministic continuous foothold sampling. It reads particle-backed
 * geometry only through StrandTraversal and never emits particle identities.
 */
export class FootholdGenerator {
  private readonly strandFilter = new Set<string>();
  private readonly sampleTs: number[] = [];

  constructor(readonly traversal: StrandTraversal) {}

  generate(request: FootholdGenerationRequest): FootholdGenerationResult {
    const options = normalizeOptions(request.options, request.supportFrame.up);
    const strands = Array.from(this.traversal.source.strands.values()).sort((left, right) =>
      left.id.localeCompare(right.id));
    const legs = request.legs
      .filter((leg) => leg.eligible !== false)
      .slice()
      .sort((left, right) => left.legId.localeCompare(right.legId));
    const candidates: FootholdCandidate[] = [];
    const accepted: FootholdCandidate[] = [];
    const rejected: FootholdCandidate[] = [];

    for (const leg of legs) {
      const candidateKeys = new Set<string>();
      const currentPosition = currentPositionForLeg(this.traversal, leg);
      this.appendCandidate(
        request,
        options,
        leg,
        this.traversal.getStrand(leg.currentAddress.strandId),
        leg.currentAddress.t,
        "current-contact",
        currentPosition,
        candidateKeys,
        candidates,
        accepted,
        rejected,
      );

      this.appendSemanticSeeds(
        request,
        options,
        leg,
        currentPosition,
        candidateKeys,
        candidates,
        accepted,
        rejected,
      );

      for (const strand of strands) {
        this.strandFilter.clear();
        this.strandFilter.add(strand.id);
        const closest = this.traversal.findClosestPoint(leg.footHomeWorldPosition, {
          traversableOnly: false,
          strandIds: this.strandFilter,
        });
        const closestT = closest?.address.t ?? 0.5;
        const tRadius = Math.min(1, options.searchRadius / Math.max(EPSILON, strand.totalRestLength));
        const startT = clamp01(closestT - tRadius);
        const endT = clamp01(closestT + tRadius);

        this.sampleTs.length = 0;
        if (request.intent.localTargetAddress?.strandId === strand.id) {
          this.sampleTs.push(clamp01(request.intent.localTargetAddress.t));
        }
        this.sampleTs.push(clamp01(closestT));
        for (let sample = 0; sample < options.samplesPerStrand; sample += 1) {
          const alpha = options.samplesPerStrand === 1
            ? 0.5
            : sample / (options.samplesPerStrand - 1);
          this.sampleTs.push(startT + (endT - startT) * alpha);
        }

        for (let index = 0; index < this.sampleTs.length; index += 1) {
          const t = this.sampleTs[index];
          const source: FootholdCandidateSource =
            index === 0 && request.intent.localTargetAddress?.strandId === strand.id
              ? "route-target"
              : index <= (request.intent.localTargetAddress?.strandId === strand.id ? 1 : 0)
                ? "nearest-home"
                : "local-sample";
          this.appendCandidate(
            request,
            options,
            leg,
            strand,
            t,
            source,
            currentPosition,
            candidateKeys,
            candidates,
            accepted,
            rejected,
          );
        }
      }
    }

    return {
      candidates,
      accepted,
      rejected,
      inspectedLegCount: legs.length,
      inspectedStrandCount: strands.length,
    };
  }

  private appendSemanticSeeds(
    request: FootholdGenerationRequest,
    options: NormalizedGenerationOptions,
    leg: FootholdLegContext,
    currentPosition: Vec3Like,
    keys: Set<string>,
    all: FootholdCandidate[],
    accepted: FootholdCandidate[],
    rejected: FootholdCandidate[],
  ): void {
    const seeds = (request.candidateSeeds ?? [])
      .filter((seed) => seed.legId === leg.legId)
      .slice()
      .sort(compareSeeds);

    for (const seed of seeds) {
      if (seed.kind === "continuous-address") {
        const strand = this.traversal.getStrand(seed.address.strandId);
        if (!strand || !Number.isFinite(seed.address.t)) continue;
        this.appendSeedNeighborhood(
          request,
          options,
          leg,
          strand,
          seed.address.t,
          seed,
          currentPosition,
          keys,
          all,
          accepted,
          rejected,
        );
        continue;
      }

      if (!finiteVector(seed.worldPosition)) continue;
      const authorizedStrandIds = [...new Set(seed.authorizedStrandIds)]
        .filter((strandId) => typeof strandId === "string" && strandId.length > 0)
        .sort((left, right) => left.localeCompare(right));
      for (const strandId of authorizedStrandIds) {
        const strand = this.traversal.getStrand(strandId);
        if (!strand) continue;
        this.strandFilter.clear();
        this.strandFilter.add(strandId);
        const closest = this.traversal.findClosestPoint(seed.worldPosition, {
          traversableOnly: false,
          strandIds: this.strandFilter,
        });
        if (!closest || closest.address.strandId !== strandId) continue;
        this.appendSeedNeighborhood(
          request,
          options,
          leg,
          strand,
          closest.address.t,
          seed,
          currentPosition,
          keys,
          all,
          accepted,
          rejected,
        );
      }
    }
  }

  private appendSeedNeighborhood(
    request: FootholdGenerationRequest,
    options: NormalizedGenerationOptions,
    leg: FootholdLegContext,
    strand: TraversalStrandSource,
    centerT: number,
    seed: FootholdCandidateSeed,
    currentPosition: Vec3Like,
    keys: Set<string>,
    all: FootholdCandidate[],
    accepted: FootholdCandidate[],
    rejected: FootholdCandidate[],
  ): void {
    const requestedRadius = seed.neighborMaterialRadius;
    const defaultRadius = Math.min(
      MAXIMUM_DEFAULT_SEED_NEIGHBOR_RADIUS,
      options.searchRadius * DEFAULT_SEED_NEIGHBOR_RADIUS_FACTOR,
    );
    const materialRadius = Math.min(
      options.searchRadius,
      Number.isFinite(requestedRadius)
        ? Math.max(0, requestedRadius as number)
        : defaultRadius,
    );
    const tRadius = materialRadius / Math.max(EPSILON, strand.totalRestLength);
    const sampleTs = tRadius > EPSILON
      ? [centerT, centerT - tRadius, centerT + tRadius]
      : [centerT];
    for (const sampleT of sampleTs) {
      this.appendCandidate(
        request,
        options,
        leg,
        strand,
        clamp01(sampleT),
        seed.source,
        currentPosition,
        keys,
        all,
        accepted,
        rejected,
      );
    }
  }

  private appendCandidate(
    request: FootholdGenerationRequest,
    options: NormalizedGenerationOptions,
    leg: FootholdLegContext,
    strand: TraversalStrandSource | undefined,
    requestedT: number,
    source: FootholdCandidateSource,
    currentPosition: Vec3Like,
    keys: Set<string>,
    all: FootholdCandidate[],
    accepted: FootholdCandidate[],
    rejected: FootholdCandidate[],
  ): void {
    const strandId = strand?.id ?? leg.currentAddress.strandId;
    const t = clamp01(requestedT);
    const key = `${strandId}:${Math.round(t * 1_000_000)}`;
    if (keys.has(key)) {
      return;
    }
    keys.add(key);

    const address = { strandId, t };
    const frame = createContactFrame();
    const worldPosition = vector();
    const strandVelocity = vector();
    const rejectionReasons: FootholdRejectionReason[] = [];
    const rejectionDetails: string[] = [];
    let localTension = 0;

    if (!strand) {
      pushReason(rejectionReasons, rejectionDetails, "inactive-strand", `Unknown strand ${strandId}.`);
    } else {
      if (!strand.active) {
        pushReason(rejectionReasons, rejectionDetails, "inactive-strand");
      }
      if (strand.broken) {
        pushReason(rejectionReasons, rejectionDetails, "broken-strand");
      }
      try {
        this.traversal.getWorldPosition(address, worldPosition);
        this.traversal.getContactFrame(address, frame, undefined, options.referenceUp);
        this.traversal.getLocalVelocity(address, strandVelocity);
        localTension = Math.max(0, this.traversal.getApproximateLocalTension(address));
      } catch (error) {
        pushReason(
          rejectionReasons,
          rejectionDetails,
          "non-finite-query",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    if (
      !finiteVector(worldPosition) ||
      !finiteVector(frame.tangent) ||
      !finiteVector(frame.normal) ||
      !finiteVector(frame.binormal) ||
      !finiteVector(strandVelocity) ||
      !Number.isFinite(localTension)
    ) {
      pushReason(rejectionReasons, rejectionDetails, "non-finite-query");
    }

    const reachScale = positive(leg.reachScale, 1);
    const minimumReach = leg.reach.min * reachScale;
    const comfortableReach = leg.reach.comfortable * reachScale;
    const maximumReach = leg.reach.max * reachScale;
    const reachDistance = distance(worldPosition, leg.reachOriginWorldPosition);
    const reachRatio = reachDistance / Math.max(EPSILON, maximumReach);
    const distanceFromFootHome = distance(worldPosition, leg.footHomeWorldPosition);
    const isCurrentContact =
      source === "current-contact" ||
      (strandId === leg.currentAddress.strandId && Math.abs(t - leg.currentAddress.t) <= 1e-6);
    if (!isCurrentContact && request.candidateValidator && finiteVector(worldPosition)) {
      const validation = request.candidateValidator(leg, address, worldPosition);
      if (!validation.valid) {
        pushReason(
          rejectionReasons,
          rejectionDetails,
          "custom-candidate-rejection",
          validation.reason ?? "The higher-level bounded policy rejected this candidate.",
        );
      }
    }
    if (!isCurrentContact && distanceFromFootHome > options.searchRadius) {
      pushReason(rejectionReasons, rejectionDetails, "outside-search-radius");
    }
    const candidateMinimumReach = isCurrentContact
      ? minimumReach
      : minimumReach * options.minimumReachSafetyFactor;
    if (reachDistance < candidateMinimumReach) {
      pushReason(rejectionReasons, rejectionDetails, "inside-minimum-reach");
    }
    if (reachDistance > maximumReach) {
      pushReason(rejectionReasons, rejectionDetails, "outside-maximum-reach");
    }

    let jointViolation = 0;
    const feasibility = request.jointFeasibility?.(leg, address, worldPosition);
    if (feasibility) {
      jointViolation = clamp01(feasibility.violation ?? (feasibility.feasible ? 0 : 1));
      // A valid planted current contact is observable evidence that the live
      // rig can hold that baseline. Keep it for leg-selection comparison even
      // if the detached approximate probe reports a constrained residual.
      if (!feasibility.feasible && !isCurrentContact) {
        pushReason(
          rejectionReasons,
          rejectionDetails,
          "impossible-joint-configuration",
          feasibility.reason,
        );
      }
    }

    const currentDestinationDistance = distance(currentPosition, request.intent.destinationPosition);
    const candidateDestinationDistance = distance(worldPosition, request.intent.destinationPosition);
    const progressTowardDestination =
      (currentDestinationDistance - candidateDestinationDistance) / options.searchRadius;
    const velocityMagnitude = Math.hypot(
      strandVelocity.x,
      strandVelocity.y,
      strandVelocity.z,
    );
    const tensionStrength = localTension / (localTension + options.tensionReference);
    const motionSignal = clamp01(velocityMagnitude / options.velocityReference);
    const stability = clamp01(0.55 * tensionStrength + 0.45 * (1 - motionSignal));
    const weaknessOrMotion = clamp01(Math.max(1 - tensionStrength, motionSignal));
    const comfort = reachComfort(
      reachDistance,
      minimumReach,
      comfortableReach,
      maximumReach,
    );
    const connectivity = strand
      ? this.connectivitySignal(strand, t, options.connectivityDegreeReference)
      : 0;
    const nearestSupportDistance = this.nearestOtherSupportDistance(
      request.supports,
      leg.legId,
      worldPosition,
    );
    const spacing = Number.isFinite(nearestSupportDistance)
      ? clamp01(nearestSupportDistance / options.minimumFootSpacing)
      : 1;
    const currentLayoutStability = this.layoutStability(
      request.supports,
      leg.legId,
      currentPosition,
      request.supportFrame,
      options.minimumFootSpacing,
    );
    const candidateLayoutStability = this.layoutStability(
      request.supports,
      leg.legId,
      worldPosition,
      request.supportFrame,
      options.minimumFootSpacing,
    );
    const supportReduction = clamp01(currentLayoutStability - candidateLayoutStability);
    const supportSpacing = clamp01(0.55 * spacing + 0.45 * candidateLayoutStability);
    const heuristicRisks = this.estimateRisks(
      leg,
      worldPosition,
      request.supportFrame,
      request.intent.desiredDirection,
      options.searchRadius,
    );
    const suppliedRisks = request.riskEstimator?.(leg, address, worldPosition);
    const bodyRotation = clamp01(suppliedRisks?.bodyRotation ?? heuristicRisks.bodyRotation);
    const legCrossing = clamp01(suppliedRisks?.legCrossing ?? heuristicRisks.legCrossing);

    const candidate: FootholdCandidate = {
      legId: leg.legId,
      address,
      strandId,
      t,
      source,
      isCurrentContact,
      worldPosition,
      tangent: frame.tangent,
      normal: frame.normal,
      binormal: frame.binormal,
      strandVelocity,
      localTension,
      reachDistance,
      reachRatio,
      progressTowardDestination,
      distanceFromFootHome,
      approximateSupportContribution: candidateLayoutStability,
      nearestSupportDistance,
      signals: {
        progress: clamp01(progressTowardDestination),
        comfortableReach: comfort,
        homePreference: clamp01(1 - distanceFromFootHome / options.searchRadius),
        strandStability: stability,
        futureConnectivity: connectivity,
        supportSpacing,
        reachBoundary: 1 - comfort,
        jointLimitViolation: jointViolation,
        bodyRotation,
        footCrowding: 1 - spacing,
        legCrossing,
        weakOrMovingStrand: weaknessOrMotion,
        reducedSupportStability: supportReduction,
      },
      rejectionReasons,
      rejectionDetails,
      score: createFootholdScore(),
    };

    if (rejectionReasons.length === 0) {
      all.push(candidate);
      accepted.push(candidate);
    } else {
      rejected.push(candidate);
      if (options.retainRejected) {
        all.push(candidate);
      }
    }
  }

  private connectivitySignal(
    strand: TraversalStrandSource,
    t: number,
    degreeReference: number,
  ): number {
    // Only explicit endpoint topology contributes. Nearby/projected crossings
    // are deliberately invisible here and can never become a route junction.
    // Inactive/broken edges also cannot promise useful future travel.
    const traversableDegree = (strandIds: ReadonlySet<string>): number => {
      let degree = 0;
      for (const strandId of strandIds) {
        const connected = this.traversal.getStrand(strandId);
        if (connected?.active && !connected.broken) degree += 1;
      }
      return degree;
    };
    const startBranches = Math.max(
      0,
      traversableDegree(strand.startNode.connectedStrandIds) - 1,
    );
    const endBranches = Math.max(
      0,
      traversableDegree(strand.endNode.connectedStrandIds) - 1,
    );
    const weightedBranches = startBranches * (1 - t) + endBranches * t;
    return clamp01(weightedBranches / degreeReference);
  }

  private nearestOtherSupportDistance(
    supports: readonly LocomotionSupportContact[],
    excludedLegId: FootholdLegContext["legId"],
    position: Vec3Like,
  ): number {
    let nearest = Infinity;
    for (const support of supports) {
      if (
        support.legId === excludedLegId ||
        !support.planted ||
        !support.loaded ||
        !support.valid
      ) {
        continue;
      }
      nearest = Math.min(nearest, distance(position, support.position));
    }
    return nearest;
  }

  private layoutStability(
    supports: readonly LocomotionSupportContact[],
    excludedLegId: FootholdLegContext["legId"],
    proposedPosition: Vec3Like,
    frame: LocomotionSupportFrame,
    spacingReference: number,
  ): number {
    let x = proposedPosition.x;
    let y = proposedPosition.y;
    let z = proposedPosition.z;
    let count = 1;
    for (const support of supports) {
      if (
        support.legId === excludedLegId ||
        !support.planted ||
        !support.loaded ||
        !support.valid
      ) {
        continue;
      }
      x += support.position.x;
      y += support.position.y;
      z += support.position.z;
      count += 1;
    }
    x /= count;
    y /= count;
    z /= count;

    let averageRadius = distance(proposedPosition, { x, y, z });
    for (const support of supports) {
      if (
        support.legId === excludedLegId ||
        !support.planted ||
        !support.loaded ||
        !support.valid
      ) {
        continue;
      }
      averageRadius += distance(support.position, { x, y, z });
    }
    averageRadius /= count;
    const centerOffset = distance(frame.center, { x, y, z });
    const centered = clamp01(1 - centerOffset / Math.max(spacingReference, averageRadius));
    const spread = clamp01(averageRadius / (spacingReference * 1.5));
    return clamp01(centered * 0.65 + spread * 0.35);
  }

  private estimateRisks(
    leg: FootholdLegContext,
    position: Vec3Like,
    frame: LocomotionSupportFrame,
    desiredDirection: Vec3Like,
    searchRadius: number,
  ): { bodyRotation: number; legCrossing: number } {
    const movementDistance = distance(position, leg.footHomeWorldPosition);
    let bodyRotation = 0;
    if (movementDistance > EPSILON) {
      const directionalAlignment = dotDifference(
        position,
        leg.footHomeWorldPosition,
        desiredDirection,
      ) / movementDistance;
      bodyRotation = clamp01((1 - directionalAlignment) * 0.5);
    }

    const homeSide = dotDifference(leg.footHomeWorldPosition, frame.center, frame.right);
    const candidateSide = dotDifference(position, frame.center, frame.right);
    const crossed = homeSide * candidateSide < 0;
    const legCrossing = crossed
      ? clamp01(Math.abs(candidateSide) / Math.max(EPSILON, searchRadius * 0.5))
      : 0;
    return { bodyRotation, legCrossing };
  }
}

function compareSeeds(left: FootholdCandidateSeed, right: FootholdCandidateSeed): number {
  const sourceOrder = left.source.localeCompare(right.source);
  if (sourceOrder !== 0) return sourceOrder;
  const kindOrder = left.kind.localeCompare(right.kind);
  if (kindOrder !== 0) return kindOrder;
  if (left.kind === "continuous-address" && right.kind === "continuous-address") {
    return left.address.strandId.localeCompare(right.address.strandId) ||
      left.address.t - right.address.t;
  }
  if (left.kind === "world-position" && right.kind === "world-position") {
    return left.worldPosition.x - right.worldPosition.x ||
      left.worldPosition.y - right.worldPosition.y ||
      left.worldPosition.z - right.worldPosition.z;
  }
  return 0;
}
