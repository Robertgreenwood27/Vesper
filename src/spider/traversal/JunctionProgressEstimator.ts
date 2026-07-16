import { StrandTraversal, createVec3, type PlannedRoute, type StrandAddress } from "../../traversal/index";
import { DEFAULT_TRAVERSAL_POLICY_CONFIG } from "./TraversalConfig";
import type {
  JunctionCommitmentConfig,
  JunctionContactClassification,
  JunctionContactInput,
  JunctionProgressEstimate,
  JunctionProgressRequest,
  JunctionTransitionPhase,
} from "./TraversalTypes";

const EPSILON = 1e-8;

/** Semantic junction progress derived only from explicit route topology. */
export class JunctionProgressEstimator {
  readonly config: JunctionCommitmentConfig;

  private readonly nodePosition = createVec3();
  private readonly branchSample = createVec3();
  private readonly direction = createVec3();

  constructor(
    readonly traversal: StrandTraversal,
    config: JunctionCommitmentConfig = DEFAULT_TRAVERSAL_POLICY_CONFIG.junction,
  ) {
    this.config = { ...config };
  }

  estimate(
    request: JunctionProgressRequest,
    out: JunctionProgressEstimate = createJunctionProgressEstimate(request),
  ): JunctionProgressEstimate {
    resetEstimate(out, request);
    if (!finiteVector(request.bodyCenter)) {
      out.message = "Body center is non-finite.";
      return out;
    }

    const transition = request.route.transitions.find(
      (item) =>
        item.nodeId === request.junctionNodeId &&
        item.fromStrandId === request.approachStrandId &&
        item.toStrandId === request.destinationBranchStrandId,
    );
    if (!transition) {
      out.message = "The route does not contain the requested semantic junction transition.";
      return out;
    }
    out.nextTransition = transition;

    const junctionRouteDistance = findJunctionRouteDistance(
      request.route,
      request.junctionNodeId,
      request.approachStrandId,
      request.destinationBranchStrandId,
    );
    if (!Number.isFinite(junctionRouteDistance)) {
      out.message = "The junction transition could not be located in the route legs.";
      return out;
    }
    out.junctionRouteDistance = junctionRouteDistance;

    const branch = this.traversal.getStrand(request.destinationBranchStrandId);
    const junctionNode = this.traversal.getNode(request.junctionNodeId);
    if (
      !branch ||
      !branch.active ||
      branch.broken ||
      !junctionNode ||
      (branch.startNode.id !== junctionNode.id && branch.endNode.id !== junctionNode.id)
    ) {
      out.message = "The destination branch is unavailable or not attached to the junction.";
      return out;
    }

    this.traversal.getNodePosition(request.junctionNodeId, this.nodePosition);
    const junctionAtStart = branch.startNode.id === request.junctionNodeId;
    const sampleT = junctionAtStart ? Math.min(1, 0.02) : Math.max(0, 0.98);
    this.traversal.getWorldPosition(
      { strandId: branch.id, t: sampleT },
      this.branchSample,
    );
    this.direction.x = this.branchSample.x - this.nodePosition.x;
    this.direction.y = this.branchSample.y - this.nodePosition.y;
    this.direction.z = this.branchSample.z - this.nodePosition.z;
    let directionLength = Math.hypot(this.direction.x, this.direction.y, this.direction.z);
    if (directionLength <= EPSILON) {
      this.direction.x = request.route.destinationPosition.x - this.nodePosition.x;
      this.direction.y = request.route.destinationPosition.y - this.nodePosition.y;
      this.direction.z = request.route.destinationPosition.z - this.nodePosition.z;
      directionLength = Math.hypot(this.direction.x, this.direction.y, this.direction.z);
    }
    if (directionLength <= EPSILON || !Number.isFinite(directionLength)) {
      out.message = "The destination branch has no finite direction away from the junction.";
      return out;
    }
    this.direction.x /= directionLength;
    this.direction.y /= directionLength;
    this.direction.z /= directionLength;
    out.bodyCenterDistancePastJunction =
      (request.bodyCenter.x - this.nodePosition.x) * this.direction.x +
      (request.bodyCenter.y - this.nodePosition.y) * this.direction.y +
      (request.bodyCenter.z - this.nodePosition.z) * this.direction.z;
    out.bodyCenterCrossed =
      out.bodyCenterDistancePastJunction >= this.config.bodyCrossingDistance;

    out.currentRouteStrandId = request.currentAddress?.strandId ?? null;
    const destinationContacts: JunctionContactInput[] = [];
    for (let index = 0; index < request.contacts.length; index += 1) {
      const contact = request.contacts[index];
      const classification = classifyContact(
        this.traversal,
        request.route,
        contact,
        junctionRouteDistance,
        this.config.minimumDestinationSideMaterialDistance,
        request.junctionNodeId,
        request.approachStrandId,
        request.destinationBranchStrandId,
        request.approachSupportStrandIds,
        request.destinationSupportStrandIds,
        this.nodePosition,
        this.direction,
      );
      out.contacts.push(classification);
      if (!classification.loadedAndValid) continue;
      out.stableLoadedSupportCount += 1;
      if (classification.side === "destination") {
        out.destinationSideLoadedCount += 1;
        if (contact.legId[0] === "L") out.destinationLeftCount += 1;
        else out.destinationRightCount += 1;
        destinationContacts.push(contact);
      } else if (classification.side === "approach") {
        out.approachSideLoadedCount += 1;
        if (classification.currentReachRatio > this.config.trailingReachLimit) {
          out.criticalTrailingReachCount += 1;
        }
      }
    }

    out.destinationSideSpread = maximumContactSpread(destinationContacts);
    const supportRatio = clamp01(
      out.destinationSideLoadedCount / this.config.destinationSideSupportThreshold,
    );
    const spreadRatio = this.config.minimumDestinationSideWorldSpread > 0
      ? clamp01(
          out.destinationSideSpread / this.config.minimumDestinationSideWorldSpread,
        )
      : 1;
    const bilateralRatio = !this.config.requireBilateralDestinationSupport ||
      (out.destinationLeftCount > 0 && out.destinationRightCount > 0)
      ? 1
      : 0;
    const trailingRatio = out.criticalTrailingReachCount === 0 ? 1 : 0;
    const stableRatio = clamp01(
      out.stableLoadedSupportCount / this.config.stableLoadedSupportThreshold,
    );
    const orientationRatio = request.predictedOrientationReachSafe === false ? 0 : 1;
    const supportStableRatio = request.supportStable === false ? 0 : 1;
    out.commitmentRatio = Math.min(
      supportRatio,
      spreadRatio,
      bilateralRatio,
      trailingRatio,
      stableRatio,
      orientationRatio,
      supportStableRatio,
    );
    out.mayCommitBody = out.commitmentRatio >= 1 - EPSILON;
    out.junctionCleared =
      out.bodyCenterDistancePastJunction >= this.config.clearBodyDistance &&
      out.approachSideLoadedCount === 0 &&
      out.destinationSideLoadedCount >= this.config.destinationSideSupportThreshold &&
      out.stableLoadedSupportCount >= this.config.stableLoadedSupportThreshold;
    out.phase = choosePhase(out);
    out.valid = true;
    out.message = out.junctionCleared
      ? "Body and support set have cleared the junction."
      : out.mayCommitBody
        ? "Destination-side support is sufficient for bounded body commitment."
        : "More destination-side support is required before body commitment.";
    return out;
  }
}

export function createJunctionProgressEstimate(
  request: Pick<
    JunctionProgressRequest,
    "junctionNodeId" | "approachStrandId" | "destinationBranchStrandId"
  >,
): JunctionProgressEstimate {
  return {
    valid: false,
    message: "Not estimated.",
    phase: "approaching",
    junctionNodeId: request.junctionNodeId,
    approachStrandId: request.approachStrandId,
    destinationBranchStrandId: request.destinationBranchStrandId,
    nextTransition: null,
    currentRouteStrandId: null,
    junctionRouteDistance: 0,
    bodyCenterDistancePastJunction: 0,
    bodyCenterCrossed: false,
    destinationSideLoadedCount: 0,
    approachSideLoadedCount: 0,
    destinationLeftCount: 0,
    destinationRightCount: 0,
    destinationSideSpread: 0,
    criticalTrailingReachCount: 0,
    stableLoadedSupportCount: 0,
    commitmentRatio: 0,
    mayCommitBody: false,
    junctionCleared: false,
    contacts: [],
  };
}

function resetEstimate(
  out: JunctionProgressEstimate,
  request: JunctionProgressRequest,
): void {
  out.valid = false;
  out.message = "Not estimated.";
  out.phase = "approaching";
  out.nextTransition = null;
  out.currentRouteStrandId = null;
  out.junctionRouteDistance = 0;
  out.bodyCenterDistancePastJunction = 0;
  out.bodyCenterCrossed = false;
  out.destinationSideLoadedCount = 0;
  out.approachSideLoadedCount = 0;
  out.destinationLeftCount = 0;
  out.destinationRightCount = 0;
  out.destinationSideSpread = 0;
  out.criticalTrailingReachCount = 0;
  out.stableLoadedSupportCount = 0;
  out.commitmentRatio = 0;
  out.mayCommitBody = false;
  out.junctionCleared = false;
  out.contacts.length = 0;
  if (
    out.junctionNodeId !== request.junctionNodeId ||
    out.approachStrandId !== request.approachStrandId ||
    out.destinationBranchStrandId !== request.destinationBranchStrandId
  ) {
    throw new Error("A reusable junction estimate must describe the same transition.");
  }
}

function classifyContact(
  traversal: StrandTraversal,
  route: PlannedRoute,
  contact: JunctionContactInput,
  junctionRouteDistance: number,
  establishmentDistance: number,
  junctionNodeId: string,
  approachStrandId: string,
  destinationBranchStrandId: string,
  approachSupportStrandIds: ReadonlySet<string> | undefined,
  destinationSupportStrandIds: ReadonlySet<string> | undefined,
  junctionPosition: { readonly x: number; readonly y: number; readonly z: number },
  branchDirection: { readonly x: number; readonly y: number; readonly z: number },
): JunctionContactClassification {
  let distancePast = Infinity;
  if (contact.address) {
    if (
      contact.address.strandId !== approachStrandId &&
      approachSupportStrandIds?.has(contact.address.strandId)
    ) {
      distancePast = -distance(contact.contactPosition, junctionPosition);
    } else if (
      contact.address.strandId !== destinationBranchStrandId &&
      destinationSupportStrandIds?.has(contact.address.strandId)
    ) {
      distancePast =
        (contact.contactPosition.x - junctionPosition.x) * branchDirection.x +
        (contact.contactPosition.y - junctionPosition.y) * branchDirection.y +
        (contact.contactPosition.z - junctionPosition.z) * branchDirection.z;
    } else {
      distancePast = directTransitionDistance(
        traversal,
        contact.address,
        junctionNodeId,
        approachStrandId,
        destinationBranchStrandId,
      );
    }
  }
  let routeDistance = Number.isFinite(distancePast)
    ? junctionRouteDistance + distancePast
    : Infinity;
  if (contact.address && !Number.isFinite(distancePast)) {
    routeDistance = routeDistanceForAddress(traversal, route, contact.address);
    distancePast = Number.isFinite(routeDistance)
      ? routeDistance - junctionRouteDistance
      : -Infinity;
  }
  const side = !Number.isFinite(routeDistance)
    ? "off-route"
    : distancePast >= establishmentDistance
      ? "destination"
      : distancePast <= -establishmentDistance
        ? "approach"
        : "junction";
  return {
    legId: contact.legId,
    address: contact.address,
    side,
    routeDistance,
    distancePastJunction: distancePast,
    loadedAndValid: contact.planted && contact.loaded && contact.valid,
    currentReachRatio: contact.currentReachRatio,
  };
}

function directTransitionDistance(
  traversal: StrandTraversal,
  address: StrandAddress,
  junctionNodeId: string,
  approachStrandId: string,
  destinationBranchStrandId: string,
): number {
  if (
    address.strandId !== approachStrandId &&
    address.strandId !== destinationBranchStrandId
  ) return Infinity;
  const strand = traversal.getStrand(address.strandId);
  if (!strand) return Infinity;
  let distanceFromJunction: number;
  if (strand.startNode.id === junctionNodeId) {
    distanceFromJunction = address.t * strand.totalRestLength;
  } else if (strand.endNode.id === junctionNodeId) {
    distanceFromJunction = (1 - address.t) * strand.totalRestLength;
  } else {
    return Infinity;
  }
  return address.strandId === approachStrandId
    ? -distanceFromJunction
    : distanceFromJunction;
}

function routeDistanceForAddress(
  traversal: StrandTraversal,
  route: PlannedRoute,
  address: StrandAddress,
): number {
  let prefix = 0;
  let best = Infinity;
  for (const leg of route.legs) {
    if (leg.strandId === address.strandId) {
      const minimumT = Math.min(leg.fromT, leg.toT) - EPSILON;
      const maximumT = Math.max(leg.fromT, leg.toT) + EPSILON;
      if (address.t >= minimumT && address.t <= maximumT) {
        const strand = traversal.getStrand(leg.strandId);
        if (strand) {
          best = Math.min(
            best,
            prefix + Math.abs(address.t - leg.fromT) * strand.totalRestLength,
          );
        }
      }
    }
    prefix += leg.materialDistance;
  }
  return best;
}

function findJunctionRouteDistance(
  route: PlannedRoute,
  junctionNodeId: string,
  approachStrandId: string,
  destinationBranchStrandId: string,
): number {
  let prefix = 0;
  for (let index = 0; index < route.legs.length; index += 1) {
    const leg = route.legs[index];
    if (
      index > 0 &&
      route.legs[index - 1].strandId === approachStrandId &&
      leg.strandId === destinationBranchStrandId &&
      route.legs[index - 1].exitNodeId === junctionNodeId &&
      leg.entryNodeId === junctionNodeId
    ) {
      return prefix;
    }
    prefix += leg.materialDistance;
  }
  return Infinity;
}

function maximumContactSpread(contacts: readonly JunctionContactInput[]): number {
  let maximum = 0;
  for (let first = 0; first < contacts.length - 1; first += 1) {
    const a = contacts[first].contactPosition;
    for (let second = first + 1; second < contacts.length; second += 1) {
      const b = contacts[second].contactPosition;
      maximum = Math.max(maximum, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
    }
  }
  return maximum;
}

function choosePhase(estimate: JunctionProgressEstimate): JunctionTransitionPhase {
  if (estimate.junctionCleared) return "cleared";
  if (estimate.bodyCenterCrossed) return "clearing-trailing-legs";
  if (estimate.bodyCenterDistancePastJunction > 0 && estimate.mayCommitBody) {
    return "committed";
  }
  if (estimate.mayCommitBody) return "ready-to-commit";
  if (estimate.destinationSideLoadedCount >= 1) return "establishing-support";
  if (estimate.bodyCenterDistancePastJunction > -0.3) return "exploring";
  return "approaching";
}

function finiteVector(value: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function distance(
  first: { readonly x: number; readonly y: number; readonly z: number },
  second: { readonly x: number; readonly y: number; readonly z: number },
): number {
  return Math.hypot(
    first.x - second.x,
    first.y - second.y,
    first.z - second.z,
  );
}
