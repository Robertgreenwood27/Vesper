/** A small, renderer-independent 3D vector shape. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface MutableVec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Public, continuous address for locomotion and interaction code.
 * `t` is material distance along the strand, normalized to [0, 1].
 */
export interface StrandAddress {
  readonly strandId: string;
  readonly t: number;
}

/** The minimum node surface required by the traversal layer. */
export interface TraversalNodeSource {
  readonly id: string;
  readonly particleIndex: number;
  readonly isFixed: boolean;
  readonly connectedStrandIds: ReadonlySet<string>;
}

/** The minimum strand surface required by the traversal layer. */
export interface TraversalStrandSource {
  readonly id: string;
  readonly startNode: TraversalNodeSource;
  readonly endNode: TraversalNodeSource;
  readonly particleIndices: ArrayLike<number>;
  readonly restLengths: ArrayLike<number>;
  readonly prefixRestLengths: ArrayLike<number>;
  readonly totalRestLength: number;
  readonly segmentTensions: ArrayLike<number>;
  readonly approximateTension: number;
  readonly active: boolean;
  readonly broken: boolean;
}

export interface TraversalParticleSource {
  readonly positions: ArrayLike<number>;
  readonly previousPositions: ArrayLike<number>;
}

/**
 * Structural adapter for the simulation. The current WebNetwork satisfies this
 * interface without inheriting from, or importing, the traversal package.
 */
export interface TraversalNetworkSource {
  readonly particles: TraversalParticleSource;
  readonly nodes: ReadonlyMap<string, TraversalNodeSource>;
  readonly strands: ReadonlyMap<string, TraversalStrandSource>;
}

export interface ResolvedStrandLocation {
  strand: TraversalStrandSource;
  t: number;
  segmentIndex: number;
  segmentT: number;
  startParticleIndex: number;
  endParticleIndex: number;
}

export interface StrandEndDistances {
  /** Current, deformed arc distance to the start node. */
  start: number;
  /** Current, deformed arc distance to the end node. */
  end: number;
  /** Material/rest distance to the start node. */
  restStart: number;
  /** Material/rest distance to the end node. */
  restEnd: number;
}

export interface StrandEndpointInfo {
  readonly nodeId: string;
  readonly fixed: boolean;
  readonly movable: boolean;
}

export interface StrandEndpointsInfo {
  readonly start: StrandEndpointInfo;
  readonly end: StrandEndpointInfo;
}

export interface StrandState {
  readonly active: boolean;
  readonly broken: boolean;
  readonly traversable: boolean;
}

export interface ContactFrame {
  /** Unit direction of increasing strand t. */
  tangent: MutableVec3;
  /** Rotation-minimizing reference direction perpendicular to tangent. */
  normal: MutableVec3;
  /** `tangent x normal`; completes a right-handed orthonormal basis. */
  binormal: MutableVec3;
}

export interface ClosestPointOptions {
  /** Defaults to true, so broken/inactive silk cannot be selected for travel. */
  readonly traversableOnly?: boolean;
  readonly strandIds?: ReadonlySet<string>;
  readonly maximumDistance?: number;
}

export interface ClosestPointResult {
  readonly address: StrandAddress;
  readonly position: MutableVec3;
  readonly tangent: MutableVec3;
  readonly distance: number;
  readonly distanceSquared: number;
  readonly segmentIndex: number;
  readonly segmentT: number;
}

export interface JunctionProximity {
  readonly nodeId: string;
  /** Shortest traversable material distance through explicit network edges. */
  readonly routeDistance: number;
  readonly worldDistance: number;
  readonly fixed: boolean;
  readonly movable: boolean;
  readonly connectedStrandIds: readonly string[];
}

export interface ClosestJunctionOptions {
  readonly maximumCount?: number;
  /** Two means a connected main node; use three for branch-only junctions. */
  readonly minimumDegree?: number;
  readonly maximumRouteDistance?: number;
}

export type RouteDestination =
  | { readonly kind: "address"; readonly address: StrandAddress }
  | { readonly kind: "node"; readonly nodeId: string }
  | {
      readonly kind: "world";
      readonly position: Vec3Like;
      readonly maximumSnapDistance?: number;
    };

export interface RouteLeg {
  readonly strandId: string;
  readonly fromT: number;
  readonly toT: number;
  readonly materialDistance: number;
  readonly entryNodeId?: string;
  readonly exitNodeId?: string;
}

export interface RouteTransition {
  readonly nodeId: string;
  readonly fromStrandId: string;
  readonly toStrandId: string;
}

/**
 * A straight cinematic guide whose body path is independent of strand
 * topology. The start is a world-space support point captured when planning;
 * the destination remains semantic so a sagging web is followed live.
 */
export interface DirectTerrainRoute {
  readonly startPosition: MutableVec3;
  readonly destinationAddress?: StrandAddress;
  readonly destinationNodeId?: string;
  readonly destinationPosition: MutableVec3;
  readonly distance: number;
}

export interface PlannedRoute {
  readonly start: StrandAddress;
  readonly requestedDestination: RouteDestination;
  /** Address resolved from an address/world target; absent for a node target. */
  readonly destinationAddress?: StrandAddress;
  readonly destinationNodeId?: string;
  readonly destinationPosition: MutableVec3;
  readonly materialDistance: number;
  readonly legs: readonly RouteLeg[];
  readonly transitions: readonly RouteTransition[];
  /** Consecutive route strand IDs, useful for compact debug rendering. */
  readonly strandIds: readonly string[];
}
