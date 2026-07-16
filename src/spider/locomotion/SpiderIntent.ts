import { WebRoutePlanner, type StrandTraversal } from "../../traversal/index";
import type {
  LocalIntentRouteSegment,
  ResolvedSpiderIntent,
  SpiderIntentOptions,
  SpiderIntentRequest,
  SpiderIntentResolution,
} from "./LocomotionTypes";

const EPSILON = 1e-8;
const DEFAULT_LOOKAHEAD_DISTANCE = 0.55;
const DEFAULT_LOCAL_ROUTE_DISTANCE = 1.5;

function mutableVector(x = 0, y = 0, z = 0) {
  return { x, y, z };
}

function finiteVector(value: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function positiveOption(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value as number : fallback;
}

/**
 * Converts a player/behavior destination into the short, local travel intent
 * consumed by one-step policy. The complete route is retained for diagnostics,
 * but only its clipped semantic prefix is offered as the steering target.
 */
export class SpiderIntentResolver {
  readonly routePlanner: WebRoutePlanner;

  constructor(
    readonly traversal: StrandTraversal,
    routePlanner: WebRoutePlanner = new WebRoutePlanner(traversal),
  ) {
    if (routePlanner.traversal !== traversal) {
      throw new Error("SpiderIntentResolver requires a route planner for the same traversal.");
    }
    this.routePlanner = routePlanner;
  }

  resolve(
    request: SpiderIntentRequest,
    options: SpiderIntentOptions = {},
  ): SpiderIntentResolution {
    const originStrand = this.traversal.getStrand(request.currentAddress.strandId);
    if (!originStrand?.active || originStrand.broken || !Number.isFinite(request.currentAddress.t)) {
      return {
        ok: false,
        reason: "invalid-origin",
        message: `Intent origin ${request.currentAddress.strandId}@${request.currentAddress.t} is not traversable.`,
      };
    }

    let route;
    try {
      route = this.routePlanner.plan(request.currentAddress, request.destination);
    } catch (error) {
      return {
        ok: false,
        reason: "destination-unreachable",
        message: error instanceof Error ? error.message : String(error),
      };
    }
    if (!route) {
      return {
        ok: false,
        reason: "destination-unreachable",
        message: "The destination cannot be reached through explicit semantic web connections.",
      };
    }
    if (!Number.isFinite(route.materialDistance) || !finiteVector(route.destinationPosition)) {
      return {
        ok: false,
        reason: "non-finite-route",
        message: "The resolved route contains non-finite distance or position data.",
      };
    }

    const maximumAccepted = options.maximumAcceptedRouteDistance ?? Infinity;
    if (route.materialDistance > maximumAccepted) {
      return {
        ok: false,
        reason: "route-too-distant",
        message: `Route distance ${route.materialDistance.toFixed(3)} exceeds the local intent limit ${maximumAccepted.toFixed(3)}.`,
      };
    }

    const maximumLocalDistance = positiveOption(
      options.maximumLocalRouteDistance,
      DEFAULT_LOCAL_ROUTE_DISTANCE,
    );
    const lookaheadDistance = Math.min(
      positiveOption(options.lookaheadDistance, DEFAULT_LOOKAHEAD_DISTANCE),
      maximumLocalDistance,
      route.materialDistance,
    );
    const localRoute = this.clipRoute(route.legs, maximumLocalDistance);
    const localTargetAddress = this.addressAtDistance(route.legs, lookaheadDistance);

    const originPosition = request.worldOrigin
      ? mutableVector(request.worldOrigin.x, request.worldOrigin.y, request.worldOrigin.z)
      : this.traversal.getWorldPosition(route.start, mutableVector());
    if (!finiteVector(originPosition)) {
      return {
        ok: false,
        reason: "invalid-origin",
        message: "The supplied intent origin is not finite.",
      };
    }

    const localTargetPosition = localTargetAddress
      ? this.traversal.getWorldPosition(localTargetAddress, mutableVector())
      : mutableVector(
          route.destinationPosition.x,
          route.destinationPosition.y,
          route.destinationPosition.z,
        );
    const desiredDirection = mutableVector(
      localTargetPosition.x - originPosition.x,
      localTargetPosition.y - originPosition.y,
      localTargetPosition.z - originPosition.z,
    );
    let directionLength = Math.hypot(
      desiredDirection.x,
      desiredDirection.y,
      desiredDirection.z,
    );

    // A body origin can coincide with a curved route lookahead. Fall back to
    // the signed first semantic-strand tangent without consulting particles.
    if (directionLength <= EPSILON && route.legs.length > 0) {
      const firstLeg = route.legs.find((leg) => leg.materialDistance > EPSILON);
      if (firstLeg) {
        const tangent = this.traversal.getTangent(
          { strandId: firstLeg.strandId, t: firstLeg.fromT },
          desiredDirection,
        );
        if (firstLeg.toT < firstLeg.fromT) {
          tangent.x *= -1;
          tangent.y *= -1;
          tangent.z *= -1;
        }
        directionLength = Math.hypot(tangent.x, tangent.y, tangent.z);
      }
    }
    if (directionLength <= EPSILON || !Number.isFinite(directionLength)) {
      return {
        ok: false,
        reason: "no-travel-direction",
        message: "The destination does not define a non-zero local travel direction.",
      };
    }
    desiredDirection.x /= directionLength;
    desiredDirection.y /= directionLength;
    desiredDirection.z /= directionLength;

    const destinationPosition = mutableVector(
      route.destinationPosition.x,
      route.destinationPosition.y,
      route.destinationPosition.z,
    );
    const directDistance = Math.hypot(
      destinationPosition.x - originPosition.x,
      destinationPosition.y - originPosition.y,
      destinationPosition.z - originPosition.z,
    );
    const localRouteDistance = Math.min(route.materialDistance, maximumLocalDistance);
    const intent: ResolvedSpiderIntent = {
      request,
      route,
      localRoute,
      originPosition,
      destinationPosition,
      localTargetPosition,
      localTargetAddress,
      desiredDirection,
      routeDistance: route.materialDistance,
      localRouteDistance,
      directDistance,
      requiresAdditionalSteps: route.materialDistance > maximumLocalDistance + EPSILON,
    };
    return { ok: true, intent };
  }

  private clipRoute(
    legs: ResolvedSpiderIntent["route"]["legs"],
    maximumDistance: number,
  ): LocalIntentRouteSegment[] {
    const result: LocalIntentRouteSegment[] = [];
    let remaining = maximumDistance;
    for (const leg of legs) {
      if (remaining <= EPSILON) {
        break;
      }
      const materialDistance = Math.min(leg.materialDistance, remaining);
      const fraction = leg.materialDistance > EPSILON
        ? materialDistance / leg.materialDistance
        : 1;
      const complete = fraction >= 1 - EPSILON;
      result.push({
        strandId: leg.strandId,
        fromT: leg.fromT,
        toT: leg.fromT + (leg.toT - leg.fromT) * fraction,
        materialDistance,
        entryNodeId: leg.entryNodeId,
        exitNodeId: complete ? leg.exitNodeId : undefined,
      });
      remaining -= materialDistance;
    }
    return result;
  }

  private addressAtDistance(
    legs: ResolvedSpiderIntent["route"]["legs"],
    requestedDistance: number,
  ) {
    let remaining = Math.max(0, requestedDistance);
    let lastAddress: { strandId: string; t: number } | undefined;
    for (const leg of legs) {
      lastAddress = { strandId: leg.strandId, t: leg.toT };
      if (leg.materialDistance <= EPSILON) {
        continue;
      }
      if (remaining <= leg.materialDistance) {
        const fraction = remaining / leg.materialDistance;
        return {
          strandId: leg.strandId,
          t: leg.fromT + (leg.toT - leg.fromT) * fraction,
        };
      }
      remaining -= leg.materialDistance;
    }
    return lastAddress;
  }
}

export function resolveSpiderIntent(
  traversal: StrandTraversal,
  request: SpiderIntentRequest,
  options: SpiderIntentOptions = {},
  routePlanner?: WebRoutePlanner,
): SpiderIntentResolution {
  return new SpiderIntentResolver(traversal, routePlanner).resolve(request, options);
}

