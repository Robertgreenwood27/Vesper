import { StrandTraversal } from "./StrandTraversal";
import type {
  MutableVec3,
  PlannedRoute,
  RouteDestination,
  RouteLeg,
  RouteTransition,
  StrandAddress,
  TraversalStrandSource,
} from "./types";
import { clamp01, createVec3 } from "./vectorMath";

interface Predecessor {
  readonly previousNodeId: string;
  readonly strandId: string;
}

interface GraphEdgeStep {
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly strandId: string;
}

interface TargetChoice {
  readonly nodeId: string;
  readonly endpointT?: 0 | 1;
  readonly totalDistance: number;
}

interface ResolvedDestination {
  readonly address?: StrandAddress;
  readonly nodeId?: string;
  readonly position: MutableVec3;
}

/**
 * Dijkstra routing over semantic web nodes and whole strands. Simulation
 * particles never become graph vertices, and geometric crossings never create
 * graph edges; connectivity exists only through shared endpoint node IDs.
 */
export class WebRoutePlanner {
  constructor(readonly traversal: StrandTraversal) {}

  plan(startAddress: StrandAddress, destination: RouteDestination): PlannedRoute | null {
    const startStrand = this.traversal.getStrand(startAddress.strandId);
    if (!this.isTraversable(startStrand)) {
      return null;
    }
    const start: StrandAddress = {
      strandId: startStrand.id,
      t: clamp01(startAddress.t),
    };
    const resolvedDestination = this.resolveDestination(destination);
    if (!resolvedDestination) {
      return null;
    }

    const destinationStrand = resolvedDestination.address
      ? this.traversal.getStrand(resolvedDestination.address.strandId)
      : undefined;
    if (resolvedDestination.address && !this.isTraversable(destinationStrand)) {
      return null;
    }

    // Staying on the same strand is a valid route that need not touch a node.
    let directRoute: PlannedRoute | null = null;
    if (resolvedDestination.address?.strandId === start.strandId) {
      const targetT = clamp01(resolvedDestination.address.t);
      const distance = Math.abs(targetT - start.t) * startStrand.totalRestLength;
      directRoute = this.finishRoute(
        start,
        destination,
        resolvedDestination,
        [this.createLeg(startStrand, start.t, targetT)],
        distance,
      );
    }

    const distances = new Map<string, number>();
    const predecessors = new Map<string, Predecessor>();
    const rootEndpointT = new Map<string, 0 | 1>();
    const visited = new Set<string>();
    for (const nodeId of this.traversal.source.nodes.keys()) {
      distances.set(nodeId, Infinity);
    }

    this.seedNode(
      startStrand.startNode.id,
      start.t * startStrand.totalRestLength,
      0,
      distances,
      rootEndpointT,
    );
    this.seedNode(
      startStrand.endNode.id,
      (1 - start.t) * startStrand.totalRestLength,
      1,
      distances,
      rootEndpointT,
    );

    while (visited.size < this.traversal.source.nodes.size) {
      let nodeId: string | undefined;
      let nodeDistance = Infinity;
      for (const [candidateId, candidateDistance] of distances) {
        if (!visited.has(candidateId) && candidateDistance < nodeDistance) {
          nodeId = candidateId;
          nodeDistance = candidateDistance;
        }
      }
      if (!nodeId || !Number.isFinite(nodeDistance)) {
        break;
      }
      visited.add(nodeId);

      const node = this.traversal.getNode(nodeId);
      if (!node) {
        continue;
      }
      for (const strandId of node.connectedStrandIds) {
        const strand = this.traversal.getStrand(strandId);
        if (!this.isTraversable(strand)) {
          continue;
        }
        if (strand.startNode.id !== nodeId && strand.endNode.id !== nodeId) {
          continue;
        }
        const otherNodeId = strand.startNode.id === nodeId
          ? strand.endNode.id
          : strand.startNode.id;
        const candidateDistance = nodeDistance + strand.totalRestLength;
        if (candidateDistance < (distances.get(otherNodeId) ?? Infinity)) {
          distances.set(otherNodeId, candidateDistance);
          predecessors.set(otherNodeId, { previousNodeId: nodeId, strandId });
          rootEndpointT.delete(otherNodeId);
        }
      }
    }

    const targetChoice = this.chooseGraphTarget(
      resolvedDestination,
      destinationStrand,
      distances,
    );
    if (!targetChoice) {
      return directRoute;
    }

    const graphSteps: GraphEdgeStep[] = [];
    let cursor = targetChoice.nodeId;
    while (predecessors.has(cursor)) {
      const predecessor = predecessors.get(cursor);
      if (!predecessor) {
        break;
      }
      graphSteps.push({
        fromNodeId: predecessor.previousNodeId,
        toNodeId: cursor,
        strandId: predecessor.strandId,
      });
      cursor = predecessor.previousNodeId;
    }
    graphSteps.reverse();

    const startEndpointT = rootEndpointT.get(cursor);
    if (startEndpointT === undefined) {
      return directRoute;
    }

    const legs: RouteLeg[] = [
      this.createLeg(
        startStrand,
        start.t,
        startEndpointT,
        undefined,
        cursor,
      ),
    ];

    for (const step of graphSteps) {
      const strand = this.traversal.getStrand(step.strandId);
      if (!this.isTraversable(strand)) {
        return directRoute;
      }
      const forward = strand.startNode.id === step.fromNodeId;
      legs.push(
        this.createLeg(
          strand,
          forward ? 0 : 1,
          forward ? 1 : 0,
          step.fromNodeId,
          step.toNodeId,
        ),
      );
    }

    if (resolvedDestination.address && destinationStrand && targetChoice.endpointT !== undefined) {
      legs.push(
        this.createLeg(
          destinationStrand,
          targetChoice.endpointT,
          resolvedDestination.address.t,
          targetChoice.nodeId,
          undefined,
        ),
      );
    }

    const graphRoute = this.finishRoute(
      start,
      destination,
      resolvedDestination,
      legs,
      targetChoice.totalDistance,
    );
    return directRoute && directRoute.materialDistance <= graphRoute.materialDistance
      ? directRoute
      : graphRoute;
  }

  private resolveDestination(destination: RouteDestination): ResolvedDestination | null {
    if (destination.kind === "node") {
      if (!this.traversal.getNode(destination.nodeId)) {
        return null;
      }
      return {
        nodeId: destination.nodeId,
        position: this.traversal.getNodePosition(destination.nodeId, createVec3()),
      };
    }

    if (destination.kind === "address") {
      const strand = this.traversal.getStrand(destination.address.strandId);
      if (!this.isTraversable(strand)) {
        return null;
      }
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
    if (!closest) {
      return null;
    }
    return {
      address: closest.address,
      position: closest.position,
    };
  }

  private chooseGraphTarget(
    destination: ResolvedDestination,
    destinationStrand: TraversalStrandSource | undefined,
    distances: ReadonlyMap<string, number>,
  ): TargetChoice | null {
    if (destination.nodeId) {
      const distance = distances.get(destination.nodeId) ?? Infinity;
      return Number.isFinite(distance)
        ? { nodeId: destination.nodeId, totalDistance: distance }
        : null;
    }

    if (!destination.address || !destinationStrand) {
      return null;
    }
    const targetT = clamp01(destination.address.t);
    const startCost =
      (distances.get(destinationStrand.startNode.id) ?? Infinity) +
      targetT * destinationStrand.totalRestLength;
    const endCost =
      (distances.get(destinationStrand.endNode.id) ?? Infinity) +
      (1 - targetT) * destinationStrand.totalRestLength;

    if (!Number.isFinite(startCost) && !Number.isFinite(endCost)) {
      return null;
    }
    return startCost <= endCost
      ? {
          nodeId: destinationStrand.startNode.id,
          endpointT: 0,
          totalDistance: startCost,
        }
      : {
          nodeId: destinationStrand.endNode.id,
          endpointT: 1,
          totalDistance: endCost,
        };
  }

  private finishRoute(
    start: StrandAddress,
    requestedDestination: RouteDestination,
    resolvedDestination: ResolvedDestination,
    legs: RouteLeg[],
    materialDistance: number,
  ): PlannedRoute {
    const transitions: RouteTransition[] = [];
    const strandIds: string[] = [];
    for (let index = 0; index < legs.length; index += 1) {
      const leg = legs[index];
      if (strandIds[strandIds.length - 1] !== leg.strandId) {
        strandIds.push(leg.strandId);
      }
      if (index === 0) {
        continue;
      }
      const previous = legs[index - 1];
      if (
        previous.exitNodeId &&
        previous.exitNodeId === leg.entryNodeId &&
        previous.strandId !== leg.strandId
      ) {
        transitions.push({
          nodeId: previous.exitNodeId,
          fromStrandId: previous.strandId,
          toStrandId: leg.strandId,
        });
      }
    }

    return {
      start,
      requestedDestination,
      destinationAddress: resolvedDestination.address,
      destinationNodeId: resolvedDestination.nodeId,
      destinationPosition: resolvedDestination.position,
      materialDistance,
      legs,
      transitions,
      strandIds,
    };
  }

  private createLeg(
    strand: TraversalStrandSource,
    fromT: number,
    toT: number,
    entryNodeId?: string,
    exitNodeId?: string,
  ): RouteLeg {
    const clampedFrom = clamp01(fromT);
    const clampedTo = clamp01(toT);
    return {
      strandId: strand.id,
      fromT: clampedFrom,
      toT: clampedTo,
      materialDistance: Math.abs(clampedTo - clampedFrom) * strand.totalRestLength,
      entryNodeId,
      exitNodeId,
    };
  }

  private seedNode(
    nodeId: string,
    distance: number,
    endpointT: 0 | 1,
    distances: Map<string, number>,
    rootEndpointT: Map<string, 0 | 1>,
  ): void {
    if (distance < (distances.get(nodeId) ?? Infinity)) {
      distances.set(nodeId, distance);
      rootEndpointT.set(nodeId, endpointT);
    }
  }

  private isTraversable(
    strand: TraversalStrandSource | undefined,
  ): strand is TraversalStrandSource {
    return Boolean(strand?.active && !strand.broken);
  }
}
