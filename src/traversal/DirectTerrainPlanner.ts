import { StrandTraversal } from "./StrandTraversal";
import type {
  DirectTerrainRoute,
  MutableVec3,
  RouteDestination,
  StrandAddress,
  TraversalStrandSource,
} from "./types";
import { clamp01, createVec3 } from "./vectorMath";

export interface DirectTerrainPlannerOptions {
  /** Furthest the direct body guide may sit from some usable silk. */
  readonly maximumSupportDistance: number;
  /** Distance between support probes along the straight corridor. */
  readonly sampleSpacing: number;
}

interface ResolvedTerrainDestination {
  readonly address?: StrandAddress;
  readonly nodeId?: string;
  readonly position: MutableVec3;
}

/**
 * Plans a straight body guide through web terrain.
 *
 * The guide itself is not silk. A sparse set of corridor probes merely proves
 * that reachable silk remains nearby; individual legs still choose their own
 * real strand addresses through FootholdSearch. If the corridor has a genuine
 * hole, this planner declines it and the semantic strand graph remains the
 * safe fallback.
 */
export class DirectTerrainPlanner {
  private readonly probe = createVec3();

  constructor(
    private readonly traversal: StrandTraversal,
    private readonly options: DirectTerrainPlannerOptions,
  ) {
    if (!(options.maximumSupportDistance > 0) || !(options.sampleSpacing > 0)) {
      throw new Error("Direct terrain routing requires positive support distances.");
    }
  }

  plan(
    startAddress: StrandAddress,
    destination: RouteDestination,
  ): DirectTerrainRoute | null {
    const startStrand = this.traversal.getStrand(startAddress.strandId);
    if (!this.isTraversable(startStrand)) return null;

    const start = {
      strandId: startStrand.id,
      t: clamp01(startAddress.t),
    };
    const resolved = this.resolveDestination(destination);
    if (!resolved) return null;

    const startPosition = this.traversal.getWorldPosition(start, createVec3());
    const dx = resolved.position.x - startPosition.x;
    const dy = resolved.position.y - startPosition.y;
    const dz = resolved.position.z - startPosition.z;
    const distance = Math.hypot(dx, dy, dz);
    if (!this.corridorHasSupport(startPosition, resolved.position, distance)) {
      return null;
    }

    return {
      startPosition,
      destinationAddress: resolved.address,
      destinationNodeId: resolved.nodeId,
      destinationPosition: resolved.position,
      distance,
    };
  }

  private corridorHasSupport(
    start: MutableVec3,
    destination: MutableVec3,
    distance: number,
  ): boolean {
    const samples = Math.max(1, Math.ceil(distance / this.options.sampleSpacing));
    for (let index = 0; index <= samples; index += 1) {
      const alpha = index / samples;
      this.probe.x = start.x + (destination.x - start.x) * alpha;
      this.probe.y = start.y + (destination.y - start.y) * alpha;
      this.probe.z = start.z + (destination.z - start.z) * alpha;
      if (!this.traversal.findClosestPoint(this.probe, {
        traversableOnly: true,
        maximumDistance: this.options.maximumSupportDistance,
      })) {
        return false;
      }
    }
    return true;
  }

  private resolveDestination(
    destination: RouteDestination,
  ): ResolvedTerrainDestination | null {
    if (destination.kind === "node") {
      if (!this.traversal.getNode(destination.nodeId)) return null;
      return {
        nodeId: destination.nodeId,
        position: this.traversal.getNodePosition(destination.nodeId, createVec3()),
      };
    }

    if (destination.kind === "address") {
      const strand = this.traversal.getStrand(destination.address.strandId);
      if (!this.isTraversable(strand)) return null;
      const address = { strandId: strand.id, t: clamp01(destination.address.t) };
      return {
        address,
        position: this.traversal.getWorldPosition(address, createVec3()),
      };
    }

    const closest = this.traversal.findClosestPoint(destination.position, {
      traversableOnly: true,
      maximumDistance: destination.maximumSnapDistance,
    });
    if (!closest) return null;
    return {
      address: closest.address,
      position: closest.position,
    };
  }

  private isTraversable(
    strand: TraversalStrandSource | undefined,
  ): strand is TraversalStrandSource {
    return Boolean(strand?.active && !strand.broken);
  }
}
