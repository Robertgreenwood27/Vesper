import type { TraversalPolicyConfig } from "./TraversalTypes";

export const DEFAULT_TRAVERSAL_POLICY_CONFIG: Readonly<TraversalPolicyConfig> =
  Object.freeze({
    scheduler: Object.freeze({
      maximumStepCount: 14,
      settleDurationSeconds: 0.35,
      maximumConsecutivePlanningFailures: 2,
      routeLookaheadDistance: 0.72,
      arrivalMaterialTolerance: 0.18,
      arrivalWorldTolerance: 0.24,
    }),
    history: Object.freeze({
      recentStepWindow: 4,
      leadingTrailingDeadZone: 0.04,
      recentLegPenalty: 0.72,
      immediateRepeatPenalty: 1.15,
      trailingLegUrgency: 1.2,
      trailingReachThreshold: 0.78,
      foldedLegUrgency: 2,
      foldedReachThreshold: 0.46,
      destinationBreadthReward: 0.82,
      alternationReward: 0.24,
      destinationFrontCrowdingPenalty: 0.68,
      sideImbalancePenalty: 0.62,
      futureFlexibilityReward: 0.48,
    }),
    junction: Object.freeze({
      destinationSideSupportThreshold: 3,
      minimumDestinationSideMaterialDistance: 0.08,
      minimumDestinationSideWorldSpread: 0.22,
      requireBilateralDestinationSupport: true,
      trailingReachLimit: 0.93,
      bodyCrossingDistance: 0.06,
      clearBodyDistance: 0.24,
      stableLoadedSupportThreshold: 5,
    }),
    orientation: Object.freeze({
      maximumTranslationPerStep: 0.1,
      maximumRotationRadiansPerStep: Math.PI / 12,
      maximumReachSafetyFactor: 0.96,
      minimumReachSafetyFactor: 1,
      bodyEnvelopeRadiusForward: 0.17,
      bodyEnvelopeRadiusRight: 0.12,
      bodyEnvelopeRadiusUp: 0.09,
      minimumSilkClearance: 0.025,
      clampIterations: 9,
      minimumAcceptedFraction: 0.02,
      destinationSupportNormalWeight: 1.5,
    }),
    recovery: Object.freeze({
      searchRadius: 0.24,
      maximumAttempts: 8,
      sameStrandSampleCount: 4,
      connectedStrandSampleCount: 3,
      maximumJunctionDistance: 0.28,
      minimumFootSpacing: 0.1,
    }),
  });

/** Returns a detached config so debug controls never mutate shared defaults. */
export function createTraversalPolicyConfig(
  overrides: Partial<{
    scheduler: Partial<TraversalPolicyConfig["scheduler"]>;
    history: Partial<TraversalPolicyConfig["history"]>;
    junction: Partial<TraversalPolicyConfig["junction"]>;
    orientation: Partial<TraversalPolicyConfig["orientation"]>;
    recovery: Partial<TraversalPolicyConfig["recovery"]>;
  }> = {},
): TraversalPolicyConfig {
  const config: TraversalPolicyConfig = {
    scheduler: { ...DEFAULT_TRAVERSAL_POLICY_CONFIG.scheduler, ...overrides.scheduler },
    history: { ...DEFAULT_TRAVERSAL_POLICY_CONFIG.history, ...overrides.history },
    junction: { ...DEFAULT_TRAVERSAL_POLICY_CONFIG.junction, ...overrides.junction },
    orientation: { ...DEFAULT_TRAVERSAL_POLICY_CONFIG.orientation, ...overrides.orientation },
    recovery: { ...DEFAULT_TRAVERSAL_POLICY_CONFIG.recovery, ...overrides.recovery },
  };
  validateTraversalPolicyConfig(config);
  return config;
}

export function validateTraversalPolicyConfig(config: TraversalPolicyConfig): void {
  positiveInteger(config.scheduler.maximumStepCount, "maximum step count");
  nonNegative(config.scheduler.settleDurationSeconds, "settle duration");
  positiveInteger(
    config.scheduler.maximumConsecutivePlanningFailures,
    "planning failure limit",
  );
  positive(config.scheduler.routeLookaheadDistance, "route look-ahead");
  nonNegative(config.scheduler.arrivalMaterialTolerance, "material arrival tolerance");
  nonNegative(config.scheduler.arrivalWorldTolerance, "world arrival tolerance");

  positiveInteger(config.history.recentStepWindow, "history window");
  nonNegative(config.history.leadingTrailingDeadZone, "leading/trailing dead zone");
  nonNegative(config.history.recentLegPenalty, "recent-leg penalty");
  nonNegative(config.history.immediateRepeatPenalty, "repeat penalty");
  nonNegative(config.history.trailingLegUrgency, "trailing urgency");
  unit(config.history.trailingReachThreshold, "trailing reach threshold");
  nonNegative(config.history.foldedLegUrgency, "folded-leg urgency");
  unit(config.history.foldedReachThreshold, "folded reach threshold");
  nonNegative(config.history.destinationBreadthReward, "destination breadth reward");
  nonNegative(config.history.alternationReward, "alternation reward");
  nonNegative(
    config.history.destinationFrontCrowdingPenalty,
    "front crowding penalty",
  );
  nonNegative(config.history.sideImbalancePenalty, "side imbalance penalty");
  nonNegative(config.history.futureFlexibilityReward, "future flexibility reward");

  positiveInteger(
    config.junction.destinationSideSupportThreshold,
    "destination support threshold",
  );
  nonNegative(
    config.junction.minimumDestinationSideMaterialDistance,
    "destination-side material distance",
  );
  nonNegative(
    config.junction.minimumDestinationSideWorldSpread,
    "destination-side spread",
  );
  unit(config.junction.trailingReachLimit, "trailing reach limit");
  nonNegative(config.junction.bodyCrossingDistance, "body crossing distance");
  if (config.junction.clearBodyDistance < config.junction.bodyCrossingDistance) {
    throw new Error("Junction clear-body distance must not precede body crossing distance.");
  }
  positiveInteger(
    config.junction.stableLoadedSupportThreshold,
    "stable support threshold",
  );

  positive(config.orientation.maximumTranslationPerStep, "body translation limit");
  positive(config.orientation.maximumRotationRadiansPerStep, "body rotation limit");
  if (config.orientation.maximumRotationRadiansPerStep > Math.PI) {
    throw new Error("Traversal body rotation limit must not exceed PI radians.");
  }
  unitPositive(config.orientation.maximumReachSafetyFactor, "maximum reach safety factor");
  positive(config.orientation.minimumReachSafetyFactor, "minimum reach safety factor");
  if (config.orientation.minimumReachSafetyFactor > 1.5) {
    throw new Error("Traversal minimum reach safety factor must not exceed 1.5.");
  }
  positive(config.orientation.bodyEnvelopeRadiusForward, "forward envelope radius");
  positive(config.orientation.bodyEnvelopeRadiusRight, "right envelope radius");
  positive(config.orientation.bodyEnvelopeRadiusUp, "up envelope radius");
  nonNegative(config.orientation.minimumSilkClearance, "minimum silk clearance");
  positiveInteger(config.orientation.clampIterations, "orientation clamp iterations");
  unitPositive(config.orientation.minimumAcceptedFraction, "minimum accepted fraction");
  positive(
    config.orientation.destinationSupportNormalWeight,
    "destination support normal weight",
  );

  positive(config.recovery.searchRadius, "local recovery radius");
  positiveInteger(config.recovery.maximumAttempts, "local recovery attempt count");
  positiveInteger(config.recovery.sameStrandSampleCount, "same-strand sample count");
  positiveInteger(
    config.recovery.connectedStrandSampleCount,
    "connected-strand sample count",
  );
  nonNegative(config.recovery.maximumJunctionDistance, "junction search distance");
  nonNegative(config.recovery.minimumFootSpacing, "recovery foot spacing");
}

function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Traversal ${name} must be finite and positive.`);
  }
}

function nonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Traversal ${name} must be finite and non-negative.`);
  }
}

function positiveInteger(value: number, name: string): void {
  positive(value, name);
  if (!Number.isInteger(value)) {
    throw new Error(`Traversal ${name} must be an integer.`);
  }
}

function unit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Traversal ${name} must be in [0, 1].`);
  }
}

function unitPositive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`Traversal ${name} must be in (0, 1].`);
  }
}
