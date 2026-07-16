import type {
  ClosestJunctionOptions,
  ClosestPointOptions,
  ClosestPointResult,
  ContactFrame,
  JunctionProximity,
  MutableVec3,
  ResolvedStrandLocation,
  StrandAddress,
  StrandEndDistances,
  StrandEndpointsInfo,
  StrandState,
  TraversalNetworkSource,
  TraversalNodeSource,
  TraversalStrandSource,
  Vec3Like,
} from "./types";
import {
  clamp01,
  copyVec3,
  createVec3,
  crossVec3,
  lengthSquaredVec3,
  normalizeVec3,
  parallelTransportNormal,
  perpendicularUnit,
  projectOntoNormalPlane,
  setVec3,
} from "./vectorMath";

const DEFAULT_REFERENCE_UP: Vec3Like = Object.freeze({ x: 0, y: 1, z: 0 });

function getPointTension(tensions: ArrayLike<number>, pointIndex: number): number {
  let total = 0;
  let count = 0;
  if (pointIndex > 0) {
    total += Math.max(0, tensions[pointIndex - 1]);
    count += 1;
  }
  if (pointIndex < tensions.length) {
    total += Math.max(0, tensions[pointIndex]);
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

function createResolvedLocation(strand: TraversalStrandSource): ResolvedStrandLocation {
  return {
    strand,
    t: 0,
    segmentIndex: 0,
    segmentT: 0,
    startParticleIndex: strand.particleIndices[0],
    endParticleIndex: strand.particleIndices[1],
  };
}

export function createContactFrame(): ContactFrame {
  return {
    tangent: createVec3(1, 0, 0),
    normal: createVec3(0, 1, 0),
    binormal: createVec3(0, 0, 1),
  };
}

/**
 * Temporal continuity state for one attached object. Keep one tracker per
 * contact/limb; sharing it between unrelated contacts would mix their roll.
 */
export class ContactFrameTracker {
  private initialized = false;
  private readonly tangent = createVec3(1, 0, 0);
  private readonly normal = createVec3(0, 1, 0);

  reset(): void {
    this.initialized = false;
  }

  stabilize(frame: ContactFrame): ContactFrame {
    if (this.initialized) {
      parallelTransportNormal(frame.normal, this.normal, this.tangent, frame.tangent);
      crossVec3(frame.binormal, frame.tangent, frame.normal);
      normalizeVec3(frame.binormal, frame.binormal);
    }

    copyVec3(this.tangent, frame.tangent);
    copyVec3(this.normal, frame.normal);
    this.initialized = true;
    return frame;
  }
}

/**
 * Continuous, renderer-independent queries over a particle-backed web.
 * Particle details stay behind this facade; callers address silk only by
 * `{ strandId, t }` and main-node IDs.
 */
export class StrandTraversal {
  readonly fixedStepSeconds: number;

  private readonly locationScratch: ResolvedStrandLocation;
  private readonly pointScratchA = createVec3();
  private readonly pointScratchB = createVec3();
  private readonly tangentScratchA = createVec3();
  private readonly tangentScratchB = createVec3();

  constructor(
    readonly source: TraversalNetworkSource,
    fixedStepSeconds = 1 / 120,
  ) {
    if (!Number.isFinite(fixedStepSeconds) || fixedStepSeconds <= 0) {
      throw new Error("Traversal velocity queries require a positive fixed step.");
    }
    const firstStrand = source.strands.values().next().value as TraversalStrandSource | undefined;
    this.locationScratch = firstStrand
      ? createResolvedLocation(firstStrand)
      : ({} as ResolvedStrandLocation);
    this.fixedStepSeconds = fixedStepSeconds;
  }

  getStrand(strandId: string): TraversalStrandSource | undefined {
    return this.source.strands.get(strandId);
  }

  getNode(nodeId: string): TraversalNodeSource | undefined {
    return this.source.nodes.get(nodeId);
  }

  /** Resolves material t to the two bracketing simulation particles. */
  resolveAddress(
    address: StrandAddress,
    out: ResolvedStrandLocation = this.locationScratch,
  ): ResolvedStrandLocation {
    const strand = this.requireStrand(address.strandId);
    const segmentCount = strand.particleIndices.length - 1;
    if (segmentCount < 1 || strand.restLengths.length !== segmentCount) {
      throw new Error(`Strand ${strand.id} has invalid traversal topology.`);
    }

    const t = clamp01(address.t);
    const targetDistance = t * strand.totalRestLength;
    let low = 0;
    let high = segmentCount - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (targetDistance <= strand.prefixRestLengths[middle + 1]) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    const segmentIndex = low;
    const segmentStart = strand.prefixRestLengths[segmentIndex];
    const restLength = strand.restLengths[segmentIndex];
    out.strand = strand;
    out.t = t;
    out.segmentIndex = segmentIndex;
    out.segmentT = restLength > 0 ? clamp01((targetDistance - segmentStart) / restLength) : 0;
    out.startParticleIndex = strand.particleIndices[segmentIndex];
    out.endParticleIndex = strand.particleIndices[segmentIndex + 1];
    return out;
  }

  getWorldPosition(address: StrandAddress, out: MutableVec3 = createVec3()): MutableVec3 {
    const location = this.resolveAddress(address);
    this.readParticlePosition(location.startParticleIndex, this.pointScratchA);
    this.readParticlePosition(location.endParticleIndex, this.pointScratchB);
    const alpha = location.segmentT;
    return setVec3(
      out,
      this.pointScratchA.x + (this.pointScratchB.x - this.pointScratchA.x) * alpha,
      this.pointScratchA.y + (this.pointScratchB.y - this.pointScratchA.y) * alpha,
      this.pointScratchA.z + (this.pointScratchB.z - this.pointScratchA.z) * alpha,
    );
  }

  getTangent(address: StrandAddress, out: MutableVec3 = createVec3()): MutableVec3 {
    const location = this.resolveAddress(address);
    this.getPointTangent(location.strand, location.segmentIndex, this.tangentScratchA);
    this.getPointTangent(location.strand, location.segmentIndex + 1, this.tangentScratchB);
    const alpha = location.segmentT;
    setVec3(
      out,
      this.tangentScratchA.x + (this.tangentScratchB.x - this.tangentScratchA.x) * alpha,
      this.tangentScratchA.y + (this.tangentScratchB.y - this.tangentScratchA.y) * alpha,
      this.tangentScratchA.z + (this.tangentScratchB.z - this.tangentScratchA.z) * alpha,
    );
    if (!normalizeVec3(out, out)) {
      this.getSegmentTangent(location.strand, location.segmentIndex, out);
    }
    return out;
  }

  getLocalVelocity(address: StrandAddress, out: MutableVec3 = createVec3()): MutableVec3 {
    const location = this.resolveAddress(address);
    const positions = this.source.particles.positions;
    const previous = this.source.particles.previousPositions;
    const startOffset = location.startParticleIndex * 3;
    const endOffset = location.endParticleIndex * 3;
    const alpha = location.segmentT;
    const inverseStep = 1 / this.fixedStepSeconds;

    return setVec3(
      out,
      ((positions[startOffset] - previous[startOffset]) * (1 - alpha) +
        (positions[endOffset] - previous[endOffset]) * alpha) *
        inverseStep,
      ((positions[startOffset + 1] - previous[startOffset + 1]) * (1 - alpha) +
        (positions[endOffset + 1] - previous[endOffset + 1]) * alpha) *
        inverseStep,
      ((positions[startOffset + 2] - previous[startOffset + 2]) * (1 - alpha) +
        (positions[endOffset + 2] - previous[endOffset + 2]) * alpha) *
        inverseStep,
    );
  }

  getApproximateLocalTension(address: StrandAddress): number {
    const location = this.resolveAddress(address);
    const tensions = location.strand.segmentTensions;
    if (tensions.length === 0) {
      return Math.max(0, location.strand.approximateTension);
    }

    const start = getPointTension(tensions, location.segmentIndex);
    const end = getPointTension(tensions, location.segmentIndex + 1);
    return start + (end - start) * location.segmentT;
  }

  getEndDistances(address: StrandAddress): StrandEndDistances {
    const location = this.resolveAddress(address);
    const strand = location.strand;
    let currentStart = 0;
    let currentTotal = 0;

    for (let segment = 0; segment < strand.particleIndices.length - 1; segment += 1) {
      this.readParticlePosition(strand.particleIndices[segment], this.pointScratchA);
      this.readParticlePosition(strand.particleIndices[segment + 1], this.pointScratchB);
      const dx = this.pointScratchB.x - this.pointScratchA.x;
      const dy = this.pointScratchB.y - this.pointScratchA.y;
      const dz = this.pointScratchB.z - this.pointScratchA.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (segment < location.segmentIndex) {
        currentStart += length;
      } else if (segment === location.segmentIndex) {
        currentStart += length * location.segmentT;
      }
      currentTotal += length;
    }

    const restStart = location.t * strand.totalRestLength;
    return {
      start: currentStart,
      end: Math.max(0, currentTotal - currentStart),
      restStart,
      restEnd: Math.max(0, strand.totalRestLength - restStart),
    };
  }

  getEndpointInfo(strandId: string): StrandEndpointsInfo {
    const strand = this.requireStrand(strandId);
    return {
      start: {
        nodeId: strand.startNode.id,
        fixed: strand.startNode.isFixed,
        movable: !strand.startNode.isFixed,
      },
      end: {
        nodeId: strand.endNode.id,
        fixed: strand.endNode.isFixed,
        movable: !strand.endNode.isFixed,
      },
    };
  }

  getStrandState(strandId: string): StrandState {
    const strand = this.requireStrand(strandId);
    return {
      active: strand.active,
      broken: strand.broken,
      traversable: strand.active && !strand.broken,
    };
  }

  getNodePosition(nodeId: string, out: MutableVec3 = createVec3()): MutableVec3 {
    const node = this.source.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Unknown web node: ${nodeId}`);
    }
    return this.readParticlePosition(node.particleIndex, out);
  }

  getCurrentStrandLength(strandId: string): number {
    const strand = this.requireStrand(strandId);
    let total = 0;
    for (let segment = 0; segment < strand.particleIndices.length - 1; segment += 1) {
      this.readParticlePosition(strand.particleIndices[segment], this.pointScratchA);
      this.readParticlePosition(strand.particleIndices[segment + 1], this.pointScratchB);
      const dx = this.pointScratchB.x - this.pointScratchA.x;
      const dy = this.pointScratchB.y - this.pointScratchA.y;
      const dz = this.pointScratchB.z - this.pointScratchA.z;
      total += Math.sqrt(dx * dx + dy * dy + dz * dz);
    }
    return total;
  }

  /**
   * Builds a rotation-minimizing (Bishop) frame along the current polyline.
   * Passing a ContactFrameTracker additionally prevents temporal roll jumps as
   * a contact and the underlying strand move between simulation frames.
   */
  getContactFrame(
    address: StrandAddress,
    out: ContactFrame = createContactFrame(),
    tracker?: ContactFrameTracker,
    referenceUp: Vec3Like = DEFAULT_REFERENCE_UP,
  ): ContactFrame {
    const location = this.resolveAddress(address);
    const strand = location.strand;
    this.getPointTangent(strand, 0, this.tangentScratchA);

    if (!projectOntoNormalPlane(out.normal, referenceUp, this.tangentScratchA)) {
      perpendicularUnit(out.normal, this.tangentScratchA);
    }

    for (let point = 1; point <= location.segmentIndex; point += 1) {
      this.getPointTangent(strand, point, this.tangentScratchB);
      parallelTransportNormal(
        out.normal,
        out.normal,
        this.tangentScratchA,
        this.tangentScratchB,
      );
      copyVec3(this.tangentScratchA, this.tangentScratchB);
    }

    this.getPointTangent(strand, location.segmentIndex + 1, this.tangentScratchB);
    setVec3(
      out.tangent,
      this.tangentScratchA.x +
        (this.tangentScratchB.x - this.tangentScratchA.x) * location.segmentT,
      this.tangentScratchA.y +
        (this.tangentScratchB.y - this.tangentScratchA.y) * location.segmentT,
      this.tangentScratchA.z +
        (this.tangentScratchB.z - this.tangentScratchA.z) * location.segmentT,
    );
    if (!normalizeVec3(out.tangent, out.tangent)) {
      this.getSegmentTangent(strand, location.segmentIndex, out.tangent);
    }
    parallelTransportNormal(
      out.normal,
      out.normal,
      this.tangentScratchA,
      out.tangent,
    );
    if (!projectOntoNormalPlane(out.normal, out.normal, out.tangent)) {
      perpendicularUnit(out.normal, out.tangent);
    }
    crossVec3(out.binormal, out.tangent, out.normal);
    normalizeVec3(out.binormal, out.binormal);
    return tracker ? tracker.stabilize(out) : out;
  }

  findClosestPoint(
    target: Vec3Like,
    options: ClosestPointOptions = {},
  ): ClosestPointResult | null {
    const traversableOnly = options.traversableOnly ?? true;
    const maximumDistanceSquared = Number.isFinite(options.maximumDistance)
      ? Math.max(0, options.maximumDistance ?? 0) ** 2
      : Infinity;
    let bestDistanceSquared = maximumDistanceSquared;
    let bestStrand: TraversalStrandSource | undefined;
    let bestSegment = 0;
    let bestSegmentT = 0;
    let bestX = 0;
    let bestY = 0;
    let bestZ = 0;

    for (const strand of this.source.strands.values()) {
      if (options.strandIds && !options.strandIds.has(strand.id)) {
        continue;
      }
      if (traversableOnly && (!strand.active || strand.broken)) {
        continue;
      }

      for (let segment = 0; segment < strand.particleIndices.length - 1; segment += 1) {
        this.readParticlePosition(strand.particleIndices[segment], this.pointScratchA);
        this.readParticlePosition(strand.particleIndices[segment + 1], this.pointScratchB);
        const abx = this.pointScratchB.x - this.pointScratchA.x;
        const aby = this.pointScratchB.y - this.pointScratchA.y;
        const abz = this.pointScratchB.z - this.pointScratchA.z;
        const apx = target.x - this.pointScratchA.x;
        const apy = target.y - this.pointScratchA.y;
        const apz = target.z - this.pointScratchA.z;
        const denominator = abx * abx + aby * aby + abz * abz;
        const segmentT = denominator > 1e-12
          ? clamp01((apx * abx + apy * aby + apz * abz) / denominator)
          : 0;
        const x = this.pointScratchA.x + abx * segmentT;
        const y = this.pointScratchA.y + aby * segmentT;
        const z = this.pointScratchA.z + abz * segmentT;
        const dx = target.x - x;
        const dy = target.y - y;
        const dz = target.z - z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;

        if (
          distanceSquared < bestDistanceSquared ||
          (!bestStrand && distanceSquared <= bestDistanceSquared)
        ) {
          bestDistanceSquared = distanceSquared;
          bestStrand = strand;
          bestSegment = segment;
          bestSegmentT = segmentT;
          bestX = x;
          bestY = y;
          bestZ = z;
        }
      }
    }

    if (!bestStrand) {
      return null;
    }

    const materialDistance =
      bestStrand.prefixRestLengths[bestSegment] +
      bestStrand.restLengths[bestSegment] * bestSegmentT;
    const t = bestStrand.totalRestLength > 0
      ? clamp01(materialDistance / bestStrand.totalRestLength)
      : 0;
    const address = { strandId: bestStrand.id, t };
    const tangent = this.getTangent(address, createVec3());
    return {
      address,
      position: createVec3(bestX, bestY, bestZ),
      tangent,
      distance: Math.sqrt(bestDistanceSquared),
      distanceSquared: bestDistanceSquared,
      segmentIndex: bestSegment,
      segmentT: bestSegmentT,
    };
  }

  /**
   * Finds semantically connected main junctions by graph distance. Geometry is
   * never consulted for connectivity, so projected/nearby crossings stay apart.
   */
  getClosestJunctions(
    address: StrandAddress,
    options: ClosestJunctionOptions = {},
  ): JunctionProximity[] {
    const startStrand = this.requireStrand(address.strandId);
    if (!startStrand.active || startStrand.broken) {
      return [];
    }

    const t = clamp01(address.t);
    const distances = new Map<string, number>();
    const visited = new Set<string>();
    for (const nodeId of this.source.nodes.keys()) {
      distances.set(nodeId, Infinity);
    }
    distances.set(startStrand.startNode.id, t * startStrand.totalRestLength);
    distances.set(startStrand.endNode.id, (1 - t) * startStrand.totalRestLength);

    while (visited.size < this.source.nodes.size) {
      let closestNodeId: string | undefined;
      let closestDistance = Infinity;
      for (const [nodeId, distance] of distances) {
        if (!visited.has(nodeId) && distance < closestDistance) {
          closestNodeId = nodeId;
          closestDistance = distance;
        }
      }
      if (!closestNodeId || !Number.isFinite(closestDistance)) {
        break;
      }

      visited.add(closestNodeId);
      const node = this.source.nodes.get(closestNodeId);
      if (!node) {
        continue;
      }
      for (const strandId of node.connectedStrandIds) {
        const strand = this.source.strands.get(strandId);
        if (!strand || !strand.active || strand.broken) {
          continue;
        }
        if (strand.startNode.id !== node.id && strand.endNode.id !== node.id) {
          continue;
        }
        const otherNodeId = strand.startNode.id === node.id
          ? strand.endNode.id
          : strand.startNode.id;
        const candidate = closestDistance + strand.totalRestLength;
        if (candidate < (distances.get(otherNodeId) ?? Infinity)) {
          distances.set(otherNodeId, candidate);
        }
      }
    }

    const worldPosition = this.getWorldPosition(address, createVec3());
    const nodePosition = createVec3();
    const minimumDegree = Math.max(1, Math.floor(options.minimumDegree ?? 2));
    const maximumRouteDistance = options.maximumRouteDistance ?? Infinity;
    const result: JunctionProximity[] = [];
    for (const node of this.source.nodes.values()) {
      const connectedStrandIds = Array.from(node.connectedStrandIds).filter((strandId) => {
        const strand = this.source.strands.get(strandId);
        return Boolean(
          strand?.active &&
          !strand.broken &&
          (strand.startNode.id === node.id || strand.endNode.id === node.id),
        );
      });
      if (connectedStrandIds.length < minimumDegree) {
        continue;
      }
      const routeDistance = distances.get(node.id) ?? Infinity;
      if (!Number.isFinite(routeDistance) || routeDistance > maximumRouteDistance) {
        continue;
      }
      this.getNodePosition(node.id, nodePosition);
      setVec3(
        this.pointScratchA,
        nodePosition.x - worldPosition.x,
        nodePosition.y - worldPosition.y,
        nodePosition.z - worldPosition.z,
      );
      result.push({
        nodeId: node.id,
        routeDistance,
        worldDistance: Math.sqrt(lengthSquaredVec3(this.pointScratchA)),
        fixed: node.isFixed,
        movable: !node.isFixed,
        connectedStrandIds,
      });
    }

    result.sort((a, b) => a.routeDistance - b.routeDistance || a.nodeId.localeCompare(b.nodeId));
    const maximumCount = Math.max(0, Math.floor(options.maximumCount ?? 2));
    return result.slice(0, maximumCount);
  }

  private requireStrand(strandId: string): TraversalStrandSource {
    const strand = this.source.strands.get(strandId);
    if (!strand) {
      throw new Error(`Unknown web strand: ${strandId}`);
    }
    return strand;
  }

  private readParticlePosition(particleIndex: number, out: MutableVec3): MutableVec3 {
    const offset = particleIndex * 3;
    const positions = this.source.particles.positions;
    return setVec3(out, positions[offset], positions[offset + 1], positions[offset + 2]);
  }

  private getSegmentTangent(
    strand: TraversalStrandSource,
    requestedSegment: number,
    out: MutableVec3,
  ): MutableVec3 {
    const maximumSegment = strand.particleIndices.length - 2;
    const segment = Math.max(0, Math.min(maximumSegment, requestedSegment));

    for (let radius = 0; radius <= maximumSegment; radius += 1) {
      const forward = segment + radius;
      if (forward <= maximumSegment) {
        this.readParticlePosition(strand.particleIndices[forward], this.pointScratchA);
        this.readParticlePosition(strand.particleIndices[forward + 1], this.pointScratchB);
        setVec3(
          out,
          this.pointScratchB.x - this.pointScratchA.x,
          this.pointScratchB.y - this.pointScratchA.y,
          this.pointScratchB.z - this.pointScratchA.z,
        );
        if (normalizeVec3(out, out)) {
          return out;
        }
      }

      const backward = segment - radius;
      if (radius > 0 && backward >= 0) {
        this.readParticlePosition(strand.particleIndices[backward], this.pointScratchA);
        this.readParticlePosition(strand.particleIndices[backward + 1], this.pointScratchB);
        setVec3(
          out,
          this.pointScratchB.x - this.pointScratchA.x,
          this.pointScratchB.y - this.pointScratchA.y,
          this.pointScratchB.z - this.pointScratchA.z,
        );
        if (normalizeVec3(out, out)) {
          return out;
        }
      }
    }

    return setVec3(out, 1, 0, 0);
  }

  /** A navigation tangent averaged across adjacent simulation segments. */
  private getPointTangent(
    strand: TraversalStrandSource,
    requestedPoint: number,
    out: MutableVec3,
  ): MutableVec3 {
    const maximumPoint = strand.particleIndices.length - 1;
    const point = Math.max(0, Math.min(maximumPoint, requestedPoint));
    let x = 0;
    let y = 0;
    let z = 0;

    if (point > 0) {
      this.readParticlePosition(strand.particleIndices[point - 1], this.pointScratchA);
      this.readParticlePosition(strand.particleIndices[point], this.pointScratchB);
      const dx = this.pointScratchB.x - this.pointScratchA.x;
      const dy = this.pointScratchB.y - this.pointScratchA.y;
      const dz = this.pointScratchB.z - this.pointScratchA.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length > 1e-10) {
        x += dx / length;
        y += dy / length;
        z += dz / length;
      }
    }

    if (point < maximumPoint) {
      this.readParticlePosition(strand.particleIndices[point], this.pointScratchA);
      this.readParticlePosition(strand.particleIndices[point + 1], this.pointScratchB);
      const dx = this.pointScratchB.x - this.pointScratchA.x;
      const dy = this.pointScratchB.y - this.pointScratchA.y;
      const dz = this.pointScratchB.z - this.pointScratchA.z;
      const length = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (length > 1e-10) {
        x += dx / length;
        y += dy / length;
        z += dz / length;
      }
    }

    setVec3(out, x, y, z);
    if (!normalizeVec3(out, out)) {
      this.getSegmentTangent(strand, Math.max(0, point - 1), out);
    }
    return out;
  }
}
