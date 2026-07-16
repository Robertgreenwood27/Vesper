import { SPIDER_LEG_IDS, type SpiderLegId } from "../SpiderRigSpec";
import { DEFAULT_TRAVERSAL_POLICY_CONFIG } from "./TraversalConfig";
import type {
  LegHistoryCandidateContext,
  LegHistoryConfig,
  LegHistoryObservation,
  LegHistoryScoreComponent,
  LegHistoryScoreComponentName,
  LegHistoryScoreInfluence,
  LegHistoryScoreInput,
  LegHistorySnapshot,
  LegSelectionScoreAdjustments,
  LegStepOutcomeRecord,
  TraversalStepOutcome,
} from "./TraversalTypes";

interface InternalLegHistory {
  readonly snapshot: LegHistorySnapshot;
  readonly movedSteps: Int32Array;
  movedStepCount: number;
  movedStepWriteIndex: number;
}

const COMPONENT_NAMES: readonly LegHistoryScoreComponentName[] = [
  "recency-penalty",
  "immediate-repeat-penalty",
  "trailing-urgency",
  "folded-leg-urgency",
  "destination-breadth",
  "alternation",
  "front-crowding-penalty",
  "side-imbalance-penalty",
  "future-flexibility",
];

/**
 * A bounded, non-gait memory. It never selects a leg; it emits additive policy
 * terms for the existing Phase 7 selector and retains each term for diagnostics.
 */
export class LegMovementHistory {
  readonly config: LegHistoryConfig;

  private readonly histories = new Map<SpiderLegId, InternalLegHistory>();

  constructor(config: LegHistoryConfig = DEFAULT_TRAVERSAL_POLICY_CONFIG.history) {
    this.config = { ...config };
    if (!Number.isInteger(config.recentStepWindow) || config.recentStepWindow < 1) {
      throw new Error("Leg history window must be a positive integer.");
    }
    for (const legId of SPIDER_LEG_IDS) {
      this.histories.set(legId, {
        snapshot: createSnapshot(legId),
        movedSteps: new Int32Array(config.recentStepWindow),
        movedStepCount: 0,
        movedStepWriteIndex: 0,
      });
    }
  }

  reset(): void {
    for (const legId of SPIDER_LEG_IDS) {
      const history = this.requireHistory(legId);
      copySnapshot(createSnapshot(legId), history.snapshot);
      history.movedSteps.fill(0);
      history.movedStepCount = 0;
      history.movedStepWriteIndex = 0;
    }
  }

  /** Updates route-relative state without recording a movement. */
  observe(observation: LegHistoryObservation): void {
    const history = this.requireHistory(observation.legId);
    const state = history.snapshot;
    if (
      !finiteVector(observation.contactWorldPosition) ||
      !finiteVector(observation.bodyCenter) ||
      !finiteVector(observation.routeDirection) ||
      !Number.isFinite(observation.currentReachRatio) ||
      !Number.isFinite(observation.supportUsefulness)
    ) {
      throw new Error(`Cannot observe non-finite leg history for ${observation.legId}.`);
    }

    const directionLength = Math.hypot(
      observation.routeDirection.x,
      observation.routeDirection.y,
      observation.routeDirection.z,
    );
    let routeOffset = 0;
    if (directionLength > 1e-10) {
      routeOffset =
        ((observation.contactWorldPosition.x - observation.bodyCenter.x) *
          observation.routeDirection.x +
          (observation.contactWorldPosition.y - observation.bodyCenter.y) *
            observation.routeDirection.y +
          (observation.contactWorldPosition.z - observation.bodyCenter.z) *
            observation.routeDirection.z) /
        directionLength;
    }

    state.currentReachRatio = Math.max(0, observation.currentReachRatio);
    state.currentSupportUsefulness = clamp01(observation.supportUsefulness);
    state.routeOffset = routeOffset;
    state.leading = routeOffset > this.config.leadingTrailingDeadZone;
    state.trailing = routeOffset < -this.config.leadingTrailingDeadZone;
    state.destinationSide = observation.destinationSide;
    this.refreshRecentCount(history, observation.stepIndex);
  }

  recordStepOutcome(record: LegStepOutcomeRecord): void {
    if (!Number.isInteger(record.stepIndex) || record.stepIndex < 0) {
      throw new Error("Leg movement step index must be a non-negative integer.");
    }
    const history = this.requireHistory(record.legId);
    const state = history.snapshot;
    state.lastOutcome = record.outcome;
    if (record.destinationSideAfter !== undefined) {
      state.destinationSide = record.destinationSideAfter;
    }
    if (record.reachRatioAfter !== undefined) {
      if (!Number.isFinite(record.reachRatioAfter) || record.reachRatioAfter < 0) {
        throw new Error("Recorded leg reach ratio must be finite and non-negative.");
      }
      state.currentReachRatio = record.reachRatioAfter;
    }
    if (record.outcome !== "complete") {
      this.refreshRecentCount(history, record.stepIndex);
      return;
    }

    state.lastMovedStepIndex = record.stepIndex;
    state.totalMovementCount += 1;
    history.movedSteps[history.movedStepWriteIndex] = record.stepIndex;
    history.movedStepWriteIndex =
      (history.movedStepWriteIndex + 1) % history.movedSteps.length;
    history.movedStepCount = Math.min(history.movedStepCount + 1, history.movedSteps.length);
    this.refreshRecentCount(history, record.stepIndex);
  }

  recordMovement(
    legId: SpiderLegId,
    stepIndex: number,
    outcome: TraversalStepOutcome = "complete",
  ): void {
    this.recordStepOutcome({ legId, stepIndex, outcome });
  }

  getSnapshot(legId: SpiderLegId, stepIndex?: number): LegHistorySnapshot {
    const history = this.requireHistory(legId);
    if (stepIndex !== undefined) this.refreshRecentCount(history, stepIndex);
    return { ...history.snapshot };
  }

  writeSnapshots(stepIndex: number, out: LegHistorySnapshot[]): LegHistorySnapshot[] {
    out.length = 0;
    for (const legId of SPIDER_LEG_IDS) {
      const history = this.requireHistory(legId);
      this.refreshRecentCount(history, stepIndex);
      out.push({ ...history.snapshot });
    }
    return out;
  }

  scoreInfluence(
    input: LegHistoryScoreInput,
    out: LegHistoryScoreInfluence = createLegHistoryScoreInfluence(input.legId),
  ): LegHistoryScoreInfluence {
    if (out.legId !== input.legId) {
      throw new Error("A reusable history influence must belong to the scored leg.");
    }
    const history = this.requireHistory(input.legId);
    const state = history.snapshot;
    this.refreshRecentCount(history, input.stepIndex);
    resetInfluence(out);

    const candidate = input.candidate;
    const predictedDestinationSide = candidate?.destinationSide ?? state.destinationSide;
    const predictedReachRatio = Math.max(
      0,
      candidate?.predictedReachRatio ?? state.currentReachRatio,
    );
    const predictedUsefulness = clamp01(
      candidate?.predictedSupportUsefulness ?? state.currentSupportUsefulness,
    );
    const age = state.lastMovedStepIndex < 0
      ? Infinity
      : Math.max(0, input.stepIndex - state.lastMovedStepIndex);
    const recency = Number.isFinite(age)
      ? clamp01(1 - age / this.config.recentStepWindow)
      : 0;

    setComponent(
      out,
      "recency-penalty",
      recency,
      -this.config.recentLegPenalty,
    );
    const globallyLastMoved = this.findLastMovedLeg();
    const immediateRepeat =
      input.alternateUsefulLegAvailable !== false &&
      globallyLastMoved === input.legId &&
      age <= 1
        ? 1
        : 0;
    setComponent(
      out,
      "immediate-repeat-penalty",
      immediateRepeat,
      -this.config.immediateRepeatPenalty,
    );

    const trailingUrgency = state.trailing
      ? clamp01(
          (state.currentReachRatio - this.config.trailingReachThreshold) /
            Math.max(1e-6, 1 - this.config.trailingReachThreshold),
        )
      : 0;
    const reachRelief = clamp01(state.currentReachRatio - predictedReachRatio + 0.25);
    setComponent(
      out,
      "trailing-urgency",
      trailingUrgency * reachRelief,
      this.config.trailingLegUrgency,
    );

    // A folded leg can become invalid under the next small body rotation even
    // when the overall support polygon is broad. This remains a soft history
    // influence: it asks the existing selector to relocate that leg, but never
    // dictates a gait order or bypasses normal candidate/support checks.
    const foldedUrgency = clamp01(
      (this.config.foldedReachThreshold - state.currentReachRatio) /
        Math.max(0.08, this.config.foldedReachThreshold - 0.3),
    );
    setComponent(
      out,
      "folded-leg-urgency",
      foldedUrgency,
      this.config.foldedLegUrgency,
    );

    const legIndex = legNumber(input.legId);
    const establishesDestination = predictedDestinationSide && !state.destinationSide;
    const breadth = establishesDestination ? (legIndex >= 3 ? 1 : 0.55) : 0;
    setComponent(
      out,
      "destination-breadth",
      breadth,
      this.config.destinationBreadthReward,
    );

    const lastMoved = globallyLastMoved ? this.requireHistory(globallyLastMoved).snapshot : null;
    const alternatesSide = lastMoved && sideOf(lastMoved.legId) !== sideOf(input.legId) ? 1 : 0;
    setComponent(
      out,
      "alternation",
      alternatesSide,
      this.config.alternationReward,
    );

    const destinationStats = this.destinationSideStats();
    const onlyFrontDestinationSupport =
      destinationStats.total >= 2 && destinationStats.rear === 0;
    const frontCrowding =
      predictedDestinationSide && legIndex <= 2 && onlyFrontDestinationSupport ? 1 : 0;
    setComponent(
      out,
      "front-crowding-penalty",
      frontCrowding,
      -this.config.destinationFrontCrowdingPenalty,
    );

    let left = destinationStats.left;
    let right = destinationStats.right;
    if (establishesDestination) {
      if (sideOf(input.legId) === "left") left += 1;
      else right += 1;
    }
    const dominantSide = left === right
      ? null
      : left > right
        ? "left"
        : "right";
    const imbalance =
      establishesDestination && dominantSide === sideOf(input.legId)
        ? Math.abs(left - right) / Math.max(1, left + right)
        : 0;
    setComponent(
      out,
      "side-imbalance-penalty",
      imbalance,
      -this.config.sideImbalancePenalty,
    );

    const flexibility = clamp01(1 - predictedReachRatio) * (0.5 + 0.5 * predictedUsefulness);
    setComponent(
      out,
      "future-flexibility",
      flexibility,
      this.config.futureFlexibilityReward,
    );

    let total = 0;
    for (const name of COMPONENT_NAMES) total += out.components[name].contribution;
    out.total = total;
    return out;
  }

  getScoreAdjustment(
    legId: SpiderLegId,
    stepIndex: number,
    candidate?: LegHistoryCandidateContext,
  ): number {
    return this.scoreInfluence({ legId, stepIndex, candidate }).total;
  }

  /** Fills an object accepted directly by the Phase 7 additive selector hook. */
  getScoreAdjustments(
    stepIndex: number,
    candidates: Partial<Record<SpiderLegId, LegHistoryCandidateContext>> = {},
    out: LegSelectionScoreAdjustments = {},
  ): LegSelectionScoreAdjustments {
    let eligibleCount = 0;
    for (const legId of SPIDER_LEG_IDS) {
      if (candidates[legId] !== undefined) eligibleCount += 1;
    }
    const alternateUsefulLegAvailable = eligibleCount === 0 || eligibleCount > 1;
    for (const legId of SPIDER_LEG_IDS) {
      out[legId] = this.scoreInfluence({
        legId,
        stepIndex,
        candidate: candidates[legId],
        alternateUsefulLegAvailable,
      }).total;
    }
    return out;
  }

  private refreshRecentCount(history: InternalLegHistory, stepIndex: number): void {
    const oldestIncluded = stepIndex - this.config.recentStepWindow + 1;
    let count = 0;
    for (let index = 0; index < history.movedStepCount; index += 1) {
      if (history.movedSteps[index] >= oldestIncluded) count += 1;
    }
    history.snapshot.recentMovementCount = count;
  }

  private findLastMovedLeg(): SpiderLegId | null {
    let best: SpiderLegId | null = null;
    let bestStep = -1;
    for (const legId of SPIDER_LEG_IDS) {
      const step = this.requireHistory(legId).snapshot.lastMovedStepIndex;
      if (step > bestStep) {
        best = legId;
        bestStep = step;
      }
    }
    return best;
  }

  private destinationSideStats(): {
    total: number;
    left: number;
    right: number;
    rear: number;
  } {
    let total = 0;
    let left = 0;
    let right = 0;
    let rear = 0;
    for (const legId of SPIDER_LEG_IDS) {
      if (!this.requireHistory(legId).snapshot.destinationSide) continue;
      total += 1;
      if (sideOf(legId) === "left") left += 1;
      else right += 1;
      if (legNumber(legId) >= 3) rear += 1;
    }
    return { total, left, right, rear };
  }

  private requireHistory(legId: SpiderLegId): InternalLegHistory {
    const history = this.histories.get(legId);
    if (!history) throw new Error(`Unknown spider leg history: ${legId}`);
    return history;
  }
}

export function createLegHistoryScoreInfluence(
  legId: SpiderLegId,
): LegHistoryScoreInfluence {
  const components = {} as Record<
    LegHistoryScoreComponentName,
    LegHistoryScoreComponent
  >;
  for (const name of COMPONENT_NAMES) {
    components[name] = { name, value: 0, weight: 0, contribution: 0 };
  }
  return { legId, total: 0, components };
}

function createSnapshot(legId: SpiderLegId): LegHistorySnapshot {
  return {
    legId,
    lastMovedStepIndex: -1,
    recentMovementCount: 0,
    totalMovementCount: 0,
    currentReachRatio: 0,
    currentSupportUsefulness: 0,
    leading: false,
    trailing: false,
    routeOffset: 0,
    destinationSide: false,
    lastOutcome: "none",
  };
}

function copySnapshot(source: LegHistorySnapshot, target: LegHistorySnapshot): void {
  target.lastMovedStepIndex = source.lastMovedStepIndex;
  target.recentMovementCount = source.recentMovementCount;
  target.totalMovementCount = source.totalMovementCount;
  target.currentReachRatio = source.currentReachRatio;
  target.currentSupportUsefulness = source.currentSupportUsefulness;
  target.leading = source.leading;
  target.trailing = source.trailing;
  target.routeOffset = source.routeOffset;
  target.destinationSide = source.destinationSide;
  target.lastOutcome = source.lastOutcome;
}

function resetInfluence(influence: LegHistoryScoreInfluence): void {
  influence.total = 0;
  for (const name of COMPONENT_NAMES) {
    const component = influence.components[name];
    component.value = 0;
    component.weight = 0;
    component.contribution = 0;
  }
}

function setComponent(
  influence: LegHistoryScoreInfluence,
  name: LegHistoryScoreComponentName,
  value: number,
  weight: number,
): void {
  const component = influence.components[name];
  component.value = value;
  component.weight = weight;
  component.contribution = value * weight;
}

function sideOf(legId: SpiderLegId): "left" | "right" {
  return legId[0] === "L" ? "left" : "right";
}

function legNumber(legId: SpiderLegId): number {
  return Number(legId[1]);
}

function finiteVector(value: { readonly x: number; readonly y: number; readonly z: number }): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
