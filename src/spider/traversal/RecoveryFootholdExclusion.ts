import type { StrandAddress } from "../../traversal";

export interface RecoveryFootholdExclusion<LegId extends string = string> {
  readonly legId: LegId;
  readonly address: StrandAddress;
}

export interface RecoveryFootholdExclusionQuery<LegId extends string = string> {
  readonly legId: LegId;
  readonly address: StrandAddress;
  readonly strandTotalRestLength: number;
  readonly materialRadius: number;
}

/**
 * Tests a continuous candidate against failed footholds in material space.
 * The comparison is deliberately scoped to one leg and one strand: a failed
 * address must not blacklist another leg or the remaining continuous search.
 */
export function isRecoveryFootholdExcluded<LegId extends string>(
  exclusions: readonly RecoveryFootholdExclusion<LegId>[],
  query: RecoveryFootholdExclusionQuery<LegId>,
): boolean {
  if (
    !Number.isFinite(query.address.t) ||
    !Number.isFinite(query.strandTotalRestLength) ||
    query.strandTotalRestLength <= 0 ||
    !Number.isFinite(query.materialRadius) ||
    query.materialRadius < 0
  ) {
    return false;
  }

  return exclusions.some((exclusion) =>
    exclusion.legId === query.legId &&
    exclusion.address.strandId === query.address.strandId &&
    Number.isFinite(exclusion.address.t) &&
    Math.abs(exclusion.address.t - query.address.t) * query.strandTotalRestLength <=
      query.materialRadius
  );
}
