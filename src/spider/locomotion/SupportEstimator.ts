import type { MutableVec3, Vec3Like } from "../../traversal/index";

const EPSILON = 1e-9;

export interface SupportEstimateSample {
  readonly id: string;
  readonly worldPosition: Vec3Like;
  readonly active?: boolean;
  /**
   * Optional participation in the support set. Omitting this preserves the
   * Phase 7 all-or-nothing behavior. Zero represents a planted but unloaded
   * contact; values in (0, 1) represent partial load.
   */
  readonly loadFactor?: number;
  /** A moving contact is reported but contributes no support. */
  readonly moving?: boolean;
  readonly valid?: boolean;
  readonly reachValid?: boolean;
  /** Anatomical/geometric weight, multiplied by `loadFactor` when supplied. */
  readonly weight?: number;
}

export interface SupportEstimateFrame {
  readonly bodyWorldPosition: Vec3Like;
  readonly supportUp: Vec3Like;
  readonly supportForward: Vec3Like;
  /** Contacts being considered for release are removed before the estimate. */
  readonly excludedContactIds?: ReadonlySet<string>;
  /**
   * Soft support is available only for a motion explicitly marked corrective.
   * Merely being close to the support region never enables the soft margin.
   */
  readonly corrective?: boolean;
}

export interface SupportEstimatorConfig {
  readonly minimumSupportCount: number;
  /** Twice the minor-axis RMS spread in the support plane. */
  readonly minimumBroadness?: number;
  /** Required inward distance from the projected convex-hull edge. */
  readonly minimumBodyMargin?: number;
  /**
   * Additional distance outside `minimumBodyMargin` permitted for a corrective
   * estimate. Defaults to zero, preserving the Phase 7 binary rule.
   */
  readonly softBodyMargin?: number;
}

export type SupportValidityClassification =
  | "hard-valid"
  | "soft-valid-corrective"
  | "invalid";

export type SupportFailureReason =
  | "none"
  | "non-finite-frame"
  | "invalid-support"
  | "unreachable-support"
  | "insufficient-supports"
  | "too-narrow"
  | "body-outside-region";

export interface SupportEstimate {
  safe: boolean;
  classification: SupportValidityClassification;
  hardValid: boolean;
  softValidCorrective: boolean;
  failureReason: SupportFailureReason;
  readonly remainingSupportCenter: MutableVec3;
  readonly supportUp: MutableVec3;
  readonly supportForward: MutableVec3;
  readonly supportRight: MutableVec3;
  remainingContactIds: readonly string[];
  activeSupportCount: number;
  remainingSupportCount: number;
  /** Sum of remaining load factors; partial contacts contribute proportionally. */
  effectiveSupportCount: number;
  fullyLoadedSupportCount: number;
  partiallyLoadedSupportCount: number;
  unloadedPlantedContactCount: number;
  movingContactCount: number;
  excludedSupportCount: number;
  invalidSupportCount: number;
  unreachableSupportCount: number;
  totalWeight: number;
  broadness: number;
  planarRmsRadius: number;
  supportRegionArea: number;
  bodyInsideSupportRegion: boolean;
  /** Signed planar distance to the closest convex-hull edge. */
  bodyEdgeMargin: number;
}

interface ProjectedSupport {
  id: string;
  x: number;
  y: number;
  weight: number;
  loadFactor: number;
}

interface EligibleSupport {
  readonly sample: SupportEstimateSample;
  readonly loadFactor: number;
  readonly effectiveWeight: number;
}

function vector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function normalize(target: MutableVec3): boolean {
  const length = Math.hypot(target.x, target.y, target.z);
  if (!Number.isFinite(length) || length <= EPSILON) {
    target.x = 0;
    target.y = 0;
    target.z = 0;
    return false;
  }
  target.x /= length;
  target.y /= length;
  target.z /= length;
  return true;
}

function cross(target: MutableVec3, a: Vec3Like, b: Vec3Like): void {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  target.x = x;
  target.y = y;
  target.z = z;
}

function hullCross(a: ProjectedSupport, b: ProjectedSupport, c: ProjectedSupport): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function convexHull(points: readonly ProjectedSupport[]): ProjectedSupport[] {
  if (points.length < 3) {
    return [...points];
  }
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id));
  const lower: ProjectedSupport[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && hullCross(lower.at(-2)!, lower.at(-1)!, point) <= EPSILON) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: ProjectedSupport[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && hullCross(upper.at(-2)!, upper.at(-1)!, point) <= EPSILON) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Conservative support check for planning a release. It uses a projected
 * convex region plus minor-axis broadness; this is intentionally not a rigid
 * body center-of-pressure or torque solve.
 */
export class SupportEstimator {
  private readonly minimumSupportCount: number;
  private readonly minimumBroadness: number;
  private readonly minimumBodyMargin: number;
  private readonly softBodyMargin: number;

  constructor(config: SupportEstimatorConfig) {
    if (!Number.isInteger(config.minimumSupportCount) || config.minimumSupportCount < 1) {
      throw new Error("Minimum support count must be a positive integer.");
    }
    const broadness = config.minimumBroadness ?? 0;
    const margin = config.minimumBodyMargin ?? 0;
    const softMargin = config.softBodyMargin ?? 0;
    if (!Number.isFinite(broadness) || broadness < 0) {
      throw new Error("Minimum support broadness must be finite and non-negative.");
    }
    if (!Number.isFinite(margin) || margin < 0) {
      throw new Error("Minimum body margin must be finite and non-negative.");
    }
    if (!Number.isFinite(softMargin) || softMargin < 0) {
      throw new Error("Soft body margin must be finite and non-negative.");
    }
    this.minimumSupportCount = config.minimumSupportCount;
    this.minimumBroadness = broadness;
    this.minimumBodyMargin = margin;
    this.softBodyMargin = softMargin;
  }

  estimate(
    samples: readonly SupportEstimateSample[],
    frame: SupportEstimateFrame,
  ): SupportEstimate {
    const result = this.emptyResult();
    if (
      !finiteVector(frame.bodyWorldPosition) ||
      !finiteVector(frame.supportUp) ||
      !finiteVector(frame.supportForward)
    ) {
      result.failureReason = "non-finite-frame";
      return result;
    }

    result.supportUp.x = frame.supportUp.x;
    result.supportUp.y = frame.supportUp.y;
    result.supportUp.z = frame.supportUp.z;
    if (!normalize(result.supportUp)) {
      result.failureReason = "non-finite-frame";
      return result;
    }
    result.supportForward.x = frame.supportForward.x;
    result.supportForward.y = frame.supportForward.y;
    result.supportForward.z = frame.supportForward.z;
    const forwardUp =
      result.supportForward.x * result.supportUp.x +
      result.supportForward.y * result.supportUp.y +
      result.supportForward.z * result.supportUp.z;
    result.supportForward.x -= result.supportUp.x * forwardUp;
    result.supportForward.y -= result.supportUp.y * forwardUp;
    result.supportForward.z -= result.supportUp.z * forwardUp;
    if (!normalize(result.supportForward)) {
      result.failureReason = "non-finite-frame";
      return result;
    }
    cross(result.supportRight, result.supportForward, result.supportUp);
    if (!normalize(result.supportRight)) {
      result.failureReason = "non-finite-frame";
      return result;
    }

    const eligible: EligibleSupport[] = [];
    const remainingIds = new Set<string>();
    let activeCount = 0;
    let excludedCount = 0;
    for (const sample of samples) {
      if (sample.moving) {
        result.movingContactCount += 1;
        continue;
      }
      if (sample.active === false) {
        continue;
      }
      activeCount += 1;
      if (frame.excludedContactIds?.has(sample.id)) {
        excludedCount += 1;
        continue;
      }
      if (!sample.id || remainingIds.has(sample.id) || !finiteVector(sample.worldPosition)) {
        result.invalidSupportCount += 1;
        continue;
      }
      remainingIds.add(sample.id);
      if (sample.valid === false) {
        result.invalidSupportCount += 1;
        continue;
      }
      if (sample.reachValid === false) {
        result.unreachableSupportCount += 1;
        continue;
      }
      const loadFactor = sample.loadFactor ?? 1;
      if (!Number.isFinite(loadFactor) || loadFactor < 0 || loadFactor > 1) {
        result.invalidSupportCount += 1;
        continue;
      }
      if (sample.weight !== undefined && (!Number.isFinite(sample.weight) || sample.weight <= 0)) {
        result.invalidSupportCount += 1;
        continue;
      }
      if (loadFactor <= EPSILON) {
        result.unloadedPlantedContactCount += 1;
        continue;
      }
      if (loadFactor >= 1 - EPSILON) result.fullyLoadedSupportCount += 1;
      else result.partiallyLoadedSupportCount += 1;
      eligible.push({
        sample,
        loadFactor,
        effectiveWeight: (sample.weight ?? 1) * loadFactor,
      });
      result.effectiveSupportCount += loadFactor;
    }
    result.activeSupportCount = activeCount;
    result.excludedSupportCount = excludedCount;
    result.remainingSupportCount = eligible.length;

    let totalWeight = 0;
    for (const support of eligible) {
      const { sample, effectiveWeight } = support;
      result.remainingSupportCenter.x += sample.worldPosition.x * effectiveWeight;
      result.remainingSupportCenter.y += sample.worldPosition.y * effectiveWeight;
      result.remainingSupportCenter.z += sample.worldPosition.z * effectiveWeight;
      totalWeight += effectiveWeight;
    }
    result.totalWeight = totalWeight;
    if (totalWeight > EPSILON) {
      result.remainingSupportCenter.x /= totalWeight;
      result.remainingSupportCenter.y /= totalWeight;
      result.remainingSupportCenter.z /= totalWeight;
    }

    const projected: ProjectedSupport[] = [];
    let covarianceXX = 0;
    let covarianceXY = 0;
    let covarianceYY = 0;
    for (const support of eligible) {
      const { sample, effectiveWeight, loadFactor } = support;
      const relativeX = sample.worldPosition.x - result.remainingSupportCenter.x;
      const relativeY = sample.worldPosition.y - result.remainingSupportCenter.y;
      const relativeZ = sample.worldPosition.z - result.remainingSupportCenter.z;
      const rawX =
        relativeX * result.supportForward.x +
        relativeY * result.supportForward.y +
        relativeZ * result.supportForward.z;
      const rawY =
        relativeX * result.supportRight.x +
        relativeY * result.supportRight.y +
        relativeZ * result.supportRight.z;
      // A partially loaded foot must not become a full-strength hull vertex.
      // Contract its geometric extent toward the weighted support center while
      // retaining linear load weighting for the broadness covariance.
      projected.push({
        id: sample.id,
        x: rawX * loadFactor,
        y: rawY * loadFactor,
        weight: effectiveWeight,
        loadFactor,
      });
      covarianceXX += rawX * rawX * effectiveWeight;
      covarianceXY += rawX * rawY * effectiveWeight;
      covarianceYY += rawY * rawY * effectiveWeight;
    }
    if (totalWeight > EPSILON) {
      covarianceXX /= totalWeight;
      covarianceXY /= totalWeight;
      covarianceYY /= totalWeight;
    }
    const trace = covarianceXX + covarianceYY;
    const eigenDelta = Math.sqrt(
      Math.max(0, (covarianceXX - covarianceYY) ** 2 + 4 * covarianceXY * covarianceXY),
    );
    const minorEigenvalue = Math.max(0, (trace - eigenDelta) * 0.5);
    result.broadness = 2 * Math.sqrt(minorEigenvalue);
    result.planarRmsRadius = Math.sqrt(Math.max(0, trace));

    const hull = convexHull(projected);
    let twiceArea = 0;
    for (let index = 0; index < hull.length; index += 1) {
      const current = hull[index];
      const next = hull[(index + 1) % hull.length];
      twiceArea += current.x * next.y - current.y * next.x;
    }
    result.supportRegionArea = Math.abs(twiceArea) * 0.5;

    const bodyRelativeX = frame.bodyWorldPosition.x - result.remainingSupportCenter.x;
    const bodyRelativeY = frame.bodyWorldPosition.y - result.remainingSupportCenter.y;
    const bodyRelativeZ = frame.bodyWorldPosition.z - result.remainingSupportCenter.z;
    const bodyX =
      bodyRelativeX * result.supportForward.x +
      bodyRelativeY * result.supportForward.y +
      bodyRelativeZ * result.supportForward.z;
    const bodyY =
      bodyRelativeX * result.supportRight.x +
      bodyRelativeY * result.supportRight.y +
      bodyRelativeZ * result.supportRight.z;
    let edgeMargin = Number.POSITIVE_INFINITY;
    if (hull.length >= 3 && result.supportRegionArea > EPSILON) {
      for (let index = 0; index < hull.length; index += 1) {
        const current = hull[index];
        const next = hull[(index + 1) % hull.length];
        const edgeX = next.x - current.x;
        const edgeY = next.y - current.y;
        const edgeLength = Math.hypot(edgeX, edgeY);
        const signedDistance =
          ((bodyX - current.x) * edgeY * -1 + (bodyY - current.y) * edgeX) /
          edgeLength;
        edgeMargin = Math.min(edgeMargin, signedDistance);
      }
    } else {
      edgeMargin = Number.NEGATIVE_INFINITY;
    }
    result.bodyEdgeMargin = edgeMargin;
    result.bodyInsideSupportRegion = edgeMargin >= -EPSILON;

    result.remainingContactIds = projected.map((support) => support.id);
    if (result.invalidSupportCount > 0) {
      result.failureReason = "invalid-support";
    } else if (result.unreachableSupportCount > 0) {
      result.failureReason = "unreachable-support";
    } else if (result.effectiveSupportCount + EPSILON < this.minimumSupportCount) {
      result.failureReason = "insufficient-supports";
    } else if (result.broadness + EPSILON < this.minimumBroadness) {
      result.failureReason = "too-narrow";
    } else if (edgeMargin + EPSILON >= this.minimumBodyMargin) {
      result.safe = true;
      result.hardValid = true;
      result.classification = "hard-valid";
      result.failureReason = "none";
    } else if (
      frame.corrective === true &&
      this.softBodyMargin > 0 &&
      edgeMargin + EPSILON >= this.minimumBodyMargin - this.softBodyMargin
    ) {
      result.safe = true;
      result.softValidCorrective = true;
      result.classification = "soft-valid-corrective";
      result.failureReason = "none";
    } else {
      result.failureReason = "body-outside-region";
    }
    return result;
  }

  private emptyResult(): SupportEstimate {
    return {
      safe: false,
      classification: "invalid",
      hardValid: false,
      softValidCorrective: false,
      failureReason: "none",
      remainingSupportCenter: vector(),
      supportUp: vector(),
      supportForward: vector(),
      supportRight: vector(),
      remainingContactIds: [],
      activeSupportCount: 0,
      remainingSupportCount: 0,
      effectiveSupportCount: 0,
      fullyLoadedSupportCount: 0,
      partiallyLoadedSupportCount: 0,
      unloadedPlantedContactCount: 0,
      movingContactCount: 0,
      excludedSupportCount: 0,
      invalidSupportCount: 0,
      unreachableSupportCount: 0,
      totalWeight: 0,
      broadness: 0,
      planarRmsRadius: 0,
      supportRegionArea: 0,
      bodyInsideSupportRegion: false,
      bodyEdgeMargin: Number.NEGATIVE_INFINITY,
    };
  }
}
