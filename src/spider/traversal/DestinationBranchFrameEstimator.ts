import {
  StrandTraversal,
  createVec3,
  type MutableVec3,
  type PlannedRoute,
  type RouteLeg,
  type StrandAddress,
  type Vec3Like,
} from "../../traversal";

const DEFAULT_LOOKAHEAD_MATERIAL_DISTANCE = 0.12;
const DEFAULT_TANGENT_SAMPLE_MATERIAL_DISTANCE = 0.025;
const DEFAULT_MINIMUM_AXIS_LENGTH = 1e-6;

export interface DestinationBranchFrameEstimatorConfig {
  /** Material distance sampled ahead of the body's current branch projection. */
  readonly defaultLookaheadMaterialDistance?: number;
  /** Half-width of the live finite-difference tangent sample. */
  readonly tangentSampleMaterialDistance?: number;
  /** Lower bound for any vector used as a frame axis. */
  readonly minimumAxisLength?: number;
}

export interface DestinationBranchBodyFrameInput {
  readonly position: Vec3Like;
  readonly forward: Vec3Like;
  readonly up: Vec3Like;
}

export interface DestinationBranchFrameRequest {
  readonly route: PlannedRoute;
  readonly junctionNodeId: string;
  readonly destinationBranchStrandId: string;
  /**
   * Explicit support rails associated with the destination branch, in policy
   * preference order. The route-bearing strand itself may be present; it is
   * ignored when looking for lateral companion geometry.
   */
  readonly companionSupportStrandIds: readonly string[];
  readonly currentBodyFrame: DestinationBranchBodyFrameInput;
  /** Optional semantic reference before the configured look-ahead is applied. */
  readonly sampleAddress?: StrandAddress;
  readonly lookaheadMaterialDistance?: number;
}

export interface DestinationBranchFrameAxes {
  readonly position: MutableVec3;
  readonly forward: MutableVec3;
  readonly up: MutableVec3;
  readonly right: MutableVec3;
}

export interface DestinationBranchFrameEstimate {
  valid: boolean;
  message: string;
  transitionKey: string;
  readonly frame: DestinationBranchFrameAxes;
  sampleAddress: StrandAddress | null;
  companionAddress: StrandAddress | null;
  companionStrandId: string | null;
  routeDirectionSign: -1 | 0 | 1;
  usedCompanionGeometry: boolean;
  usedParallelTransportFallback: boolean;
  usedTangentFallback: boolean;
  flippedForSignContinuity: boolean;
  frameSignContinuous: boolean;
  continuityDot: number;
  companionDistance: number;
  companionLateralDistance: number;
  totalAngularErrorRadians: number;
  forwardErrorRadians: number;
  pitchErrorRadians: number;
  rollErrorRadians: number;
  rollErrorValid: boolean;
}

/**
 * A thorax supported under an angled branch must retain a normal standoff from
 * the silk, so raw point distance cannot by itself express semantic arrival.
 * Once the material route is complete, a valid local branch frame may compare
 * only forward separation; stable destination support remains an independent
 * coordinator arrival requirement. Coplanar routes keep the original world-
 * distance criterion.
 */
export function bodyNearDestinationInSemanticBranchFrame(input: {
  readonly worldDistance: number;
  readonly signedForwardSeparation: number;
  readonly destinationRadius: number;
  readonly arrivalWorldTolerance: number;
  readonly nonCoplanarTransition: boolean;
  readonly routeComplete: boolean;
  readonly frameValid: boolean;
  readonly frameSignContinuous: boolean;
}): boolean {
  if (
    !Number.isFinite(input.worldDistance) ||
    input.worldDistance < 0 ||
    !Number.isFinite(input.destinationRadius) ||
    input.destinationRadius < 0 ||
    !Number.isFinite(input.arrivalWorldTolerance) ||
    input.arrivalWorldTolerance < 0
  ) return false;
  const tolerance = input.destinationRadius + input.arrivalWorldTolerance;
  if (!Number.isFinite(tolerance)) return false;
  if (input.worldDistance <= tolerance) return true;
  return Boolean(
    input.nonCoplanarTransition &&
    input.routeComplete &&
    input.frameValid &&
    input.frameSignContinuous &&
    Number.isFinite(input.signedForwardSeparation) &&
    Math.abs(input.signedForwardSeparation) <= tolerance
  );
}

interface ResolvedConfig {
  readonly defaultLookaheadMaterialDistance: number;
  readonly tangentSampleMaterialDistance: number;
  readonly minimumAxisLength: number;
}

/**
 * Builds a destination-branch frame from semantic route direction and the
 * live plane spanned by the route rail and an explicitly supplied companion
 * rail. It owns continuity state only; it never edits body, contact, or web
 * state and has no world-axis fallback.
 */
export class DestinationBranchFrameEstimator {
  readonly config: ResolvedConfig;

  private previousTransitionKey: string | null = null;
  private previousCompanionStrandId: string | null = null;
  private hasPreviousFrame = false;
  private readonly previousForward = createVec3();
  private readonly previousUp = createVec3();

  private readonly currentForward = createVec3();
  private readonly currentUp = createVec3();
  private readonly currentRight = createVec3();
  private readonly samplePosition = createVec3();
  private readonly lowerPosition = createVec3();
  private readonly upperPosition = createVec3();
  private readonly routeForward = createVec3();
  private readonly companionPosition = createVec3();
  private readonly lateral = createVec3();
  private readonly candidateRight = createVec3();
  private readonly candidateUp = createVec3();
  private readonly continuityUp = createVec3();
  private readonly continuityRight = createVec3();
  private readonly vectorA = createVec3();
  private readonly vectorB = createVec3();
  private readonly singleStrandIds = new Set<string>();

  constructor(
    readonly traversal: StrandTraversal,
    config: DestinationBranchFrameEstimatorConfig = {},
  ) {
    this.config = {
      defaultLookaheadMaterialDistance: nonNegativeFinite(
        config.defaultLookaheadMaterialDistance,
        DEFAULT_LOOKAHEAD_MATERIAL_DISTANCE,
        "destination-frame look-ahead material distance",
      ),
      tangentSampleMaterialDistance: positiveFinite(
        config.tangentSampleMaterialDistance,
        DEFAULT_TANGENT_SAMPLE_MATERIAL_DISTANCE,
        "destination-frame tangent sample distance",
      ),
      minimumAxisLength: positiveFinite(
        config.minimumAxisLength,
        DEFAULT_MINIMUM_AXIS_LENGTH,
        "destination-frame minimum axis length",
      ),
    };
  }

  reset(): void {
    this.previousTransitionKey = null;
    this.previousCompanionStrandId = null;
    this.hasPreviousFrame = false;
    clear(this.previousForward);
    clear(this.previousUp);
  }

  estimate(
    request: DestinationBranchFrameRequest,
    out: DestinationBranchFrameEstimate = createDestinationBranchFrameEstimate(),
  ): DestinationBranchFrameEstimate {
    resetEstimate(out);

    const currentFrameFailure = this.resolveCurrentFrame(request.currentBodyFrame);
    if (currentFrameFailure) return fail(out, currentFrameFailure);
    if (!request.junctionNodeId || !request.destinationBranchStrandId) {
      return fail(out, "Destination branch and junction IDs must be non-empty.");
    }

    const leg = findDestinationLeg(
      request.route,
      request.junctionNodeId,
      request.destinationBranchStrandId,
    );
    if (!leg) {
      return fail(out, "The route does not contain a destination leg leaving the requested junction.");
    }
    const routeDirectionSign = sign(leg.toT - leg.fromT);
    if (routeDirectionSign === 0) {
      return fail(out, "The destination route leg has no material direction.");
    }
    out.routeDirectionSign = routeDirectionSign;

    const strand = this.traversal.getStrand(request.destinationBranchStrandId);
    if (!strand || !strand.active || strand.broken) {
      return fail(out, "The destination branch is unavailable or non-traversable.");
    }
    if (
      !Number.isFinite(strand.totalRestLength) ||
      strand.totalRestLength <= this.config.minimumAxisLength
    ) {
      return fail(out, "The destination branch has no finite positive material length.");
    }
    if (
      strand.startNode.id !== request.junctionNodeId &&
      strand.endNode.id !== request.junctionNodeId
    ) {
      return fail(out, "The destination branch is not attached to the requested junction.");
    }

    const junctionT = strand.startNode.id === request.junctionNodeId ? 0 : 1;
    if (
      Math.abs(leg.toT - junctionT) <=
      Math.abs(leg.fromT - junctionT) + this.config.minimumAxisLength
    ) {
      return fail(out, "The destination route leg is not oriented away from the junction.");
    }

    const transitionKey = [
      request.junctionNodeId,
      request.destinationBranchStrandId,
      finiteKey(leg.fromT),
      finiteKey(leg.toT),
    ].join("|");
    out.transitionKey = transitionKey;
    if (this.previousTransitionKey !== transitionKey) {
      this.previousTransitionKey = transitionKey;
      this.previousCompanionStrandId = null;
      this.hasPreviousFrame = false;
    }

    const sampleT = this.resolveSampleT(request, leg, strand.totalRestLength);
    if (!Number.isFinite(sampleT)) {
      return fail(out, "A finite destination-branch sample address could not be resolved.");
    }
    out.sampleAddress = {
      strandId: request.destinationBranchStrandId,
      t: sampleT,
    };

    try {
      this.traversal.getWorldPosition(out.sampleAddress, this.samplePosition);
    } catch (error) {
      return fail(
        out,
        `The destination-branch sample could not be resolved: ${errorMessage(error)}`,
      );
    }
    if (!finiteVector(this.samplePosition)) {
      return fail(out, "The destination-branch sample position is non-finite.");
    }
    copy(out.frame.position, this.samplePosition);

    out.usedTangentFallback = !this.resolveLocalRouteTangent(
      request.destinationBranchStrandId,
      leg,
      sampleT,
      strand.totalRestLength,
      routeDirectionSign,
      this.routeForward,
    );
    if (out.usedTangentFallback) {
      if (!this.resolveFallbackRouteTangent(request.destinationBranchStrandId, leg)) {
        return fail(out, "The live destination branch has no finite route-oriented tangent.");
      }
    }

    const continuitySourceForward = this.hasPreviousFrame
      ? this.previousForward
      : this.currentForward;
    const continuitySourceUp = this.hasPreviousFrame
      ? this.previousUp
      : this.currentUp;
    if (!parallelTransportNormal(
      this.continuityUp,
      continuitySourceUp,
      continuitySourceForward,
      this.routeForward,
      this.vectorA,
      this.config.minimumAxisLength,
    )) {
      return fail(out, "The local continuity frame cannot be transported onto the branch tangent.");
    }
    cross(this.continuityRight, this.routeForward, this.continuityUp);
    if (!normalize(this.continuityRight, this.config.minimumAxisLength)) {
      return fail(out, "The transported continuity frame is degenerate.");
    }
    cross(this.continuityUp, this.continuityRight, this.routeForward);
    if (!normalize(this.continuityUp, this.config.minimumAxisLength)) {
      return fail(out, "The transported continuity up axis is degenerate.");
    }

    const companionResolved = this.resolveCompanionGeometry(request, out);
    if (companionResolved) {
      cross(this.candidateUp, this.candidateRight, this.routeForward);
      if (!normalize(this.candidateUp, this.config.minimumAxisLength)) {
        return fail(out, "The main/companion support plane has a degenerate normal.");
      }
      cross(this.candidateRight, this.routeForward, this.candidateUp);
      if (!normalize(this.candidateRight, this.config.minimumAxisLength)) {
        return fail(out, "The main/companion support plane has a degenerate lateral axis.");
      }

      // A support plane has two normal signs. Preserve the geometry-defined
      // plane while choosing the hemisphere reached continuously from the
      // prior semantic frame (or from the current local body frame initially).
      if (dot(this.candidateUp, this.continuityUp) < 0) {
        scale(this.candidateUp, -1);
        scale(this.candidateRight, -1);
        out.flippedForSignContinuity = true;
      }
      copy(out.frame.up, this.candidateUp);
      copy(out.frame.right, this.candidateRight);
      out.usedCompanionGeometry = true;
    } else {
      copy(out.frame.up, this.continuityUp);
      copy(out.frame.right, this.continuityRight);
      out.usedParallelTransportFallback = true;
    }
    copy(out.frame.forward, this.routeForward);

    out.continuityDot = dot(out.frame.up, this.continuityUp);
    out.frameSignContinuous =
      Number.isFinite(out.continuityDot) && out.continuityDot >= -1e-8;
    if (!out.frameSignContinuous || !finiteOrthonormalFrame(out.frame, 2e-4)) {
      return fail(out, "The destination frame failed finite orthonormal continuity checks.");
    }

    this.measureBodyError(out);
    if (!finiteErrors(out)) {
      return fail(out, "The destination-frame orientation errors are non-finite.");
    }

    this.previousTransitionKey = transitionKey;
    this.previousCompanionStrandId = out.companionStrandId;
    copy(this.previousForward, out.frame.forward);
    copy(this.previousUp, out.frame.up);
    this.hasPreviousFrame = true;

    out.valid = true;
    out.message = out.usedCompanionGeometry
      ? "Destination frame resolved from route-oriented branch and explicit companion support geometry."
      : "Destination frame retained by local parallel transport because companion support geometry was unavailable.";
    return out;
  }

  private resolveCurrentFrame(frame: DestinationBranchBodyFrameInput): string | null {
    if (!finiteVector(frame.position) || !finiteVector(frame.forward) || !finiteVector(frame.up)) {
      return "The current body frame contains a non-finite vector.";
    }
    copy(this.currentForward, frame.forward);
    if (!normalize(this.currentForward, this.config.minimumAxisLength)) {
      return "The current body forward axis is degenerate.";
    }
    copy(this.currentUp, frame.up);
    projectPerpendicular(this.currentUp, this.currentForward);
    if (!normalize(this.currentUp, this.config.minimumAxisLength)) {
      return "The current body up axis is parallel to its forward axis.";
    }
    cross(this.currentRight, this.currentForward, this.currentUp);
    if (!normalize(this.currentRight, this.config.minimumAxisLength)) {
      return "The current body frame has no finite right axis.";
    }
    cross(this.currentUp, this.currentRight, this.currentForward);
    if (!normalize(this.currentUp, this.config.minimumAxisLength)) {
      return "The current body frame could not be orthonormalized.";
    }
    return null;
  }

  private resolveSampleT(
    request: DestinationBranchFrameRequest,
    leg: RouteLeg,
    totalRestLength: number,
  ): number {
    const minimumT = Math.max(0, Math.min(leg.fromT, leg.toT));
    const maximumT = Math.min(1, Math.max(leg.fromT, leg.toT));
    let baseT: number;
    if (request.sampleAddress) {
      if (
        request.sampleAddress.strandId !== request.destinationBranchStrandId ||
        !Number.isFinite(request.sampleAddress.t)
      ) return Number.NaN;
      baseT = clamp(request.sampleAddress.t, minimumT, maximumT);
    } else {
      this.singleStrandIds.clear();
      this.singleStrandIds.add(request.destinationBranchStrandId);
      try {
        const closest = this.traversal.findClosestPoint(request.currentBodyFrame.position, {
          traversableOnly: true,
          strandIds: this.singleStrandIds,
        });
        baseT = closest?.address.strandId === request.destinationBranchStrandId
          ? clamp(closest.address.t, minimumT, maximumT)
          : leg.fromT;
      } catch {
        baseT = leg.fromT;
      }
    }

    const lookahead = request.lookaheadMaterialDistance ??
      this.config.defaultLookaheadMaterialDistance;
    if (!Number.isFinite(lookahead) || lookahead < 0) return Number.NaN;
    const routeSign = sign(leg.toT - leg.fromT);
    return clamp(
      baseT + routeSign * lookahead / totalRestLength,
      minimumT,
      maximumT,
    );
  }

  /** Returns true when the local finite-difference tangent was used. */
  private resolveLocalRouteTangent(
    strandId: string,
    leg: RouteLeg,
    sampleT: number,
    totalRestLength: number,
    routeSign: -1 | 1,
    out: MutableVec3,
  ): boolean {
    const minimumT = Math.max(0, Math.min(leg.fromT, leg.toT));
    const maximumT = Math.min(1, Math.max(leg.fromT, leg.toT));
    const deltaT = this.config.tangentSampleMaterialDistance / totalRestLength;
    let lowerT = Math.max(minimumT, sampleT - deltaT);
    let upperT = Math.min(maximumT, sampleT + deltaT);
    if (upperT - lowerT <= this.config.minimumAxisLength) {
      lowerT = minimumT;
      upperT = maximumT;
    }
    if (upperT - lowerT <= this.config.minimumAxisLength) return false;
    try {
      this.traversal.getWorldPosition({ strandId, t: lowerT }, this.lowerPosition);
      this.traversal.getWorldPosition({ strandId, t: upperT }, this.upperPosition);
    } catch {
      return false;
    }
    if (!finiteVector(this.lowerPosition) || !finiteVector(this.upperPosition)) return false;
    subtract(out, this.upperPosition, this.lowerPosition);
    if (!normalize(out, this.config.minimumAxisLength)) return false;
    if (routeSign < 0) scale(out, -1);
    return true;
  }

  private resolveFallbackRouteTangent(strandId: string, leg: RouteLeg): boolean {
    try {
      this.traversal.getWorldPosition(
        { strandId, t: clamp01(leg.fromT) },
        this.lowerPosition,
      );
      this.traversal.getWorldPosition(
        { strandId, t: clamp01(leg.toT) },
        this.upperPosition,
      );
      subtract(this.routeForward, this.upperPosition, this.lowerPosition);
      if (normalize(this.routeForward, this.config.minimumAxisLength)) return true;
    } catch {
      // Continue to the prior semantic tangent when this is the same route.
    }
    if (this.hasPreviousFrame) {
      copy(this.routeForward, this.previousForward);
      return normalize(this.routeForward, this.config.minimumAxisLength);
    }
    return false;
  }

  private resolveCompanionGeometry(
    request: DestinationBranchFrameRequest,
    out: DestinationBranchFrameEstimate,
  ): boolean {
    const preferred = this.previousCompanionStrandId;
    if (
      preferred &&
      request.companionSupportStrandIds.includes(preferred) &&
      preferred !== request.destinationBranchStrandId &&
      this.tryCompanion(preferred, out)
    ) return true;

    for (const strandId of request.companionSupportStrandIds) {
      if (
        !strandId ||
        strandId === request.destinationBranchStrandId ||
        strandId === preferred
      ) continue;
      if (this.tryCompanion(strandId, out)) return true;
    }
    return false;
  }

  private tryCompanion(
    strandId: string,
    out: DestinationBranchFrameEstimate,
  ): boolean {
    const strand = this.traversal.getStrand(strandId);
    if (!strand || !strand.active || strand.broken) return false;
    this.singleStrandIds.clear();
    this.singleStrandIds.add(strandId);
    let closest: ReturnType<StrandTraversal["findClosestPoint"]>;
    try {
      closest = this.traversal.findClosestPoint(this.samplePosition, {
        traversableOnly: true,
        strandIds: this.singleStrandIds,
      });
    } catch {
      return false;
    }
    if (!closest || closest.address.strandId !== strandId || !finiteVector(closest.position)) {
      return false;
    }
    copy(this.companionPosition, closest.position);
    subtract(this.lateral, this.companionPosition, this.samplePosition);
    const companionDistance = length(this.lateral);
    projectPerpendicular(this.lateral, this.routeForward);
    const companionLateralDistance = length(this.lateral);
    if (
      !Number.isFinite(companionDistance) ||
      !Number.isFinite(companionLateralDistance) ||
      companionLateralDistance <= this.config.minimumAxisLength
    ) return false;
    copy(this.candidateRight, this.lateral);
    if (!normalize(this.candidateRight, this.config.minimumAxisLength)) return false;

    out.companionAddress = {
      strandId,
      t: closest.address.t,
    };
    out.companionStrandId = strandId;
    out.companionDistance = companionDistance;
    out.companionLateralDistance = companionLateralDistance;
    return true;
  }

  private measureBodyError(out: DestinationBranchFrameEstimate): void {
    const frame = out.frame;
    const trace =
      dot(this.currentRight, frame.right) +
      dot(this.currentUp, frame.up) +
      dot(this.currentForward, frame.forward);
    out.totalAngularErrorRadians = Math.acos(clamp((trace - 1) * 0.5, -1, 1));
    out.forwardErrorRadians = Math.acos(
      clamp(dot(this.currentForward, frame.forward), -1, 1),
    );
    out.pitchErrorRadians = Math.asin(
      clamp(dot(this.currentForward, frame.up), -1, 1),
    );

    copy(this.vectorA, this.currentUp);
    projectPerpendicular(this.vectorA, frame.forward);
    out.rollErrorValid = normalize(this.vectorA, this.config.minimumAxisLength);
    if (!out.rollErrorValid) {
      out.rollErrorRadians = 0;
      return;
    }
    cross(this.vectorB, frame.up, this.vectorA);
    out.rollErrorRadians = Math.atan2(
      dot(this.vectorB, frame.forward),
      clamp(dot(frame.up, this.vectorA), -1, 1),
    );
  }
}

export function createDestinationBranchFrameEstimate(): DestinationBranchFrameEstimate {
  return {
    valid: false,
    message: "Not estimated.",
    transitionKey: "",
    frame: {
      position: createVec3(),
      forward: createVec3(),
      up: createVec3(),
      right: createVec3(),
    },
    sampleAddress: null,
    companionAddress: null,
    companionStrandId: null,
    routeDirectionSign: 0,
    usedCompanionGeometry: false,
    usedParallelTransportFallback: false,
    usedTangentFallback: false,
    flippedForSignContinuity: false,
    frameSignContinuous: false,
    continuityDot: 0,
    companionDistance: 0,
    companionLateralDistance: 0,
    // Invalid or not-yet-estimated frames must never look aligned to a
    // one-way strategy stage gate. Pi is the finite worst-case frame error.
    totalAngularErrorRadians: Math.PI,
    forwardErrorRadians: 0,
    pitchErrorRadians: 0,
    rollErrorRadians: 0,
    rollErrorValid: false,
  };
}

function resetEstimate(out: DestinationBranchFrameEstimate): void {
  out.valid = false;
  out.message = "Not estimated.";
  out.transitionKey = "";
  clear(out.frame.position);
  clear(out.frame.forward);
  clear(out.frame.up);
  clear(out.frame.right);
  out.sampleAddress = null;
  out.companionAddress = null;
  out.companionStrandId = null;
  out.routeDirectionSign = 0;
  out.usedCompanionGeometry = false;
  out.usedParallelTransportFallback = false;
  out.usedTangentFallback = false;
  out.flippedForSignContinuity = false;
  out.frameSignContinuous = false;
  out.continuityDot = 0;
  out.companionDistance = 0;
  out.companionLateralDistance = 0;
  out.totalAngularErrorRadians = Math.PI;
  out.forwardErrorRadians = 0;
  out.pitchErrorRadians = 0;
  out.rollErrorRadians = 0;
  out.rollErrorValid = false;
}

function fail(
  out: DestinationBranchFrameEstimate,
  message: string,
): DestinationBranchFrameEstimate {
  out.valid = false;
  out.message = message;
  return out;
}

function findDestinationLeg(
  route: PlannedRoute,
  junctionNodeId: string,
  destinationBranchStrandId: string,
): RouteLeg | null {
  const direct = route.legs.find(
    (leg) =>
      leg.strandId === destinationBranchStrandId &&
      leg.entryNodeId === junctionNodeId,
  );
  if (direct) return finiteLeg(direct) ? direct : null;

  const hasTransition = route.transitions.some(
    (transition) =>
      transition.nodeId === junctionNodeId &&
      transition.toStrandId === destinationBranchStrandId,
  );
  if (!hasTransition) return null;
  const fallback = route.legs.find(
    (leg) => leg.strandId === destinationBranchStrandId,
  );
  return fallback && finiteLeg(fallback) ? fallback : null;
}

function finiteLeg(leg: RouteLeg): boolean {
  return (
    Number.isFinite(leg.fromT) &&
    Number.isFinite(leg.toT) &&
    leg.fromT >= 0 &&
    leg.fromT <= 1 &&
    leg.toT >= 0 &&
    leg.toT <= 1
  );
}

function finiteErrors(out: DestinationBranchFrameEstimate): boolean {
  return (
    Number.isFinite(out.totalAngularErrorRadians) &&
    Number.isFinite(out.forwardErrorRadians) &&
    Number.isFinite(out.pitchErrorRadians) &&
    Number.isFinite(out.rollErrorRadians)
  );
}

function finiteOrthonormalFrame(
  frame: DestinationBranchFrameAxes,
  tolerance: number,
): boolean {
  if (
    !finiteVector(frame.position) ||
    !finiteVector(frame.forward) ||
    !finiteVector(frame.up) ||
    !finiteVector(frame.right)
  ) return false;
  return (
    Math.abs(length(frame.forward) - 1) <= tolerance &&
    Math.abs(length(frame.up) - 1) <= tolerance &&
    Math.abs(length(frame.right) - 1) <= tolerance &&
    Math.abs(dot(frame.forward, frame.up)) <= tolerance &&
    Math.abs(dot(frame.forward, frame.right)) <= tolerance &&
    Math.abs(dot(frame.up, frame.right)) <= tolerance
  );
}

function parallelTransportNormal(
  out: MutableVec3,
  normal: Vec3Like,
  fromTangent: Vec3Like,
  toTangent: Vec3Like,
  axisScratch: MutableVec3,
  minimumLength: number,
): boolean {
  cross(axisScratch, fromTangent, toTangent);
  const sine = length(axisScratch);
  const cosine = clamp(dot(fromTangent, toTangent), -1, 1);
  if (sine > minimumLength) {
    scale(axisScratch, 1 / sine);
    const axisDotNormal = dot(axisScratch, normal);
    const crossX = axisScratch.y * normal.z - axisScratch.z * normal.y;
    const crossY = axisScratch.z * normal.x - axisScratch.x * normal.z;
    const crossZ = axisScratch.x * normal.y - axisScratch.y * normal.x;
    out.x =
      normal.x * cosine +
      crossX * sine +
      axisScratch.x * axisDotNormal * (1 - cosine);
    out.y =
      normal.y * cosine +
      crossY * sine +
      axisScratch.y * axisDotNormal * (1 - cosine);
    out.z =
      normal.z * cosine +
      crossZ * sine +
      axisScratch.z * axisDotNormal * (1 - cosine);
  } else {
    // Parallel and antiparallel tangents both retain a perpendicular normal.
    // This avoids inventing an arbitrary rotation axis for an exact reversal.
    copy(out, normal);
  }
  projectPerpendicular(out, toTangent);
  return normalize(out, minimumLength);
}

function nonNegativeFinite(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be finite and non-negative.`);
  }
  return resolved;
}

function positiveFinite(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${label} must be finite and positive.`);
  }
  return resolved;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function finiteKey(value: number): string {
  return Number.isFinite(value) ? value.toFixed(8) : "non-finite";
}

function finiteVector(value: Vec3Like | undefined): value is Vec3Like {
  return Boolean(
    value &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z),
  );
}

function sign(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function clear(out: MutableVec3): void {
  out.x = 0;
  out.y = 0;
  out.z = 0;
}

function copy(out: MutableVec3, value: Vec3Like): void {
  out.x = value.x;
  out.y = value.y;
  out.z = value.z;
}

function subtract(out: MutableVec3, left: Vec3Like, right: Vec3Like): void {
  out.x = left.x - right.x;
  out.y = left.y - right.y;
  out.z = left.z - right.z;
}

function scale(out: MutableVec3, scalar: number): void {
  out.x *= scalar;
  out.y *= scalar;
  out.z *= scalar;
}

function dot(left: Vec3Like, right: Vec3Like): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function cross(out: MutableVec3, left: Vec3Like, right: Vec3Like): void {
  const x = left.y * right.z - left.z * right.y;
  const y = left.z * right.x - left.x * right.z;
  const z = left.x * right.y - left.y * right.x;
  out.x = x;
  out.y = y;
  out.z = z;
}

function length(value: Vec3Like): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(out: MutableVec3, minimumLength: number): boolean {
  const magnitude = length(out);
  if (!Number.isFinite(magnitude) || magnitude <= minimumLength) return false;
  scale(out, 1 / magnitude);
  return finiteVector(out);
}

function projectPerpendicular(out: MutableVec3, normal: Vec3Like): void {
  const projection = dot(out, normal);
  out.x -= normal.x * projection;
  out.y -= normal.y * projection;
  out.z -= normal.z * projection;
}
