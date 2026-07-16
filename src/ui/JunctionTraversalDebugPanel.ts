import type { JunctionTraversalDebugToggles } from "../rendering/JunctionTraversalDebugRenderer";
import type { TraversalPolicyConfig } from "../spider/traversal/TraversalTypes";
import type {
  JunctionTraversalRunMode,
  JunctionTraversalState,
  JunctionTraversalStopReason,
} from "../spider/traversal/JunctionTraversalCoordinator";
import type { SpiderStepState } from "../spider/locomotion/SpiderStepState";
import type { SpiderLegId } from "../spider/SpiderRigSpec";
import type { PhaseEightValidationScenarioId } from "../web/createPhaseEightFixture";

export interface JunctionTraversalPanelCallbacks {
  onExecute(scenario: PhaseEightValidationScenarioId): void;
  onPauseAfterStep(): void;
  onContinueOneStep(): void;
  onRunUntilArrival(): void;
  onCancelAndRestore(): void;
  onResetFixture(): void;
  onParameterChange(): void;
}

export interface JunctionTraversalPanelMetrics {
  state: JunctionTraversalState;
  atomicState: SpiderStepState;
  runMode: JunctionTraversalRunMode;
  pausedAfterStep: boolean;
  stepNumber: number;
  maximumStepCount: number;
  routeSummary: string;
  nextTransition: string;
  selectedBranch: string;
  destinationSideSupports: number;
  destinationSideRequired: number;
  destinationSideSpread: number;
  bodyCenterProgress: number;
  bodyCrossed: boolean;
  trailingContacts: number;
  maximumTrailingReachRatio: number;
  orientationDegrees: number;
  orientationAcceptedFraction: number;
  movedLegHistory: string;
  historyInfluence: string;
  planningFailures: number;
  recoveryAttempts: number;
  coupledStage: string;
  partialLoadLeg: SpiderLegId | null;
  partialFootLoad: number | null;
  bodyMotionCandidatesSummary: string;
  acceptedBodyTranslation: number;
  acceptedBodyRotationRadians: number;
  limitingFoot: SpiderLegId | null;
  limitingConstraint: string;
  worstReachBefore: number;
  worstReachAfter: number;
  reachBudgetImprovement: number;
  supportClassification: string;
  zeroProgressTransactionCount: number;
  deadlockReason: string;
  stopReason: JunctionTraversalStopReason;
  stopMessage: string;
}

interface RangeOptions<T extends object, K extends keyof T> {
  readonly target: T;
  readonly key: K;
  readonly label: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly step: number;
  readonly suffix?: string;
  readonly digits?: number;
}

const SCENARIO_LABELS: Readonly<Record<PhaseEightValidationScenarioId, string>> = {
  A: "A — forward branch traverse",
  B: "B — angled / underside branch",
  C: "C — false projection crossing",
  D: "D — missing expected contact",
  E: "E — bounded repeated failure",
  F: "F — later-step cancellation",
};

const OVERLAY_CONTROLS: readonly [keyof JunctionTraversalDebugToggles, string][] = [
  ["showFullRoute", "Full semantic route"],
  ["showCurrentRoute", "Current short route"],
  ["showNextTransition", "Next transition"],
  ["showDestinationBranch", "Destination branch"],
  ["showStepHistory", "Step / moved history"],
  ["showContactSides", "Contact sides"],
  ["showCommitment", "Commit threshold"],
  ["showBodyFrames", "Body frames"],
  ["showRotationArc", "Rotation arc"],
  ["showPredictedReach", "Predicted reach"],
  ["showExploration", "Branch test"],
  ["showRecovery", "Recovery candidates"],
  ["showBodyProgress", "Body progress"],
  ["showStopReason", "Arrival / stop"],
];

/** Additive Phase 8 controls; the Phase 7 panel remains mounted below. */
export class JunctionTraversalDebugPanel {
  readonly element: HTMLElement;
  private readonly scenarioSelect: HTMLSelectElement;
  private readonly metricValues = new Map<string, HTMLElement>();
  private readonly refreshers: Array<() => void> = [];
  private readonly executeButton: HTMLButtonElement;
  private readonly continueButton: HTMLButtonElement;
  private readonly runButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;

  constructor(
    config: TraversalPolicyConfig,
    overlays: JunctionTraversalDebugToggles,
    private readonly callbacks: JunctionTraversalPanelCallbacks,
  ) {
    this.element = document.createElement("section");
    this.element.className = "phase8-panel-extension";

    const banner = document.createElement("div");
    banner.className = "phase8-boundary-banner";
    banner.innerHTML =
      "<strong>PHASE 08 / DELIBERATE JUNCTION TRAVERSE</strong>" +
      "<span>Coordinator requests one validated Phase 7 transaction at a time.</span>";
    this.element.append(banner, this.createMetrics());

    const execution = this.createSection("P8.1", "Junction scenario and scheduler");
    const selectRow = document.createElement("label");
    selectRow.className = "select-row";
    const selectLabel = document.createElement("span");
    selectLabel.textContent = "Scenario";
    this.scenarioSelect = document.createElement("select");
    this.scenarioSelect.setAttribute("aria-label", "Phase 8 validation scenario");
    for (const [id, label] of Object.entries(SCENARIO_LABELS)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = label;
      this.scenarioSelect.append(option);
    }
    selectRow.append(selectLabel, this.scenarioSelect);
    execution.append(selectRow);

    const primaryActions = document.createElement("div");
    primaryActions.className = "panel-actions traversal-actions";
    this.executeButton = this.button("Execute traverse", () =>
      callbacks.onExecute(this.selectedScenario));
    this.runButton = this.button("Run until arrival", callbacks.onRunUntilArrival);
    primaryActions.append(this.executeButton, this.runButton);
    execution.append(primaryActions);

    const stepActions = document.createElement("div");
    stepActions.className = "panel-actions traversal-actions";
    const pauseButton = this.button("Pause after step", callbacks.onPauseAfterStep);
    this.continueButton = this.button("Continue one step", callbacks.onContinueOneStep);
    stepActions.append(pauseButton, this.continueButton);
    execution.append(stepActions);

    const stopActions = document.createElement("div");
    stopActions.className = "panel-actions traversal-actions";
    this.cancelButton = this.button("Cancel + restore", callbacks.onCancelAndRestore);
    stopActions.append(
      this.cancelButton,
      this.button("Reset Phase 8", callbacks.onResetFixture),
    );
    execution.append(stopActions);
    this.element.append(execution);

    const scheduler = this.createSection("P8.2", "Repeated-step bounds");
    this.addRange(scheduler, {
      target: config.scheduler,
      key: "maximumStepCount",
      label: "Maximum step count",
      minimum: 2,
      maximum: 256,
      step: 1,
      digits: 0,
    });
    this.addRange(scheduler, {
      target: config.scheduler,
      key: "settleDurationSeconds",
      label: "Settle duration",
      minimum: 0,
      maximum: 1.5,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(scheduler, {
      target: config.scheduler,
      key: "routeLookaheadDistance",
      label: "Route look-ahead",
      minimum: 0.15,
      maximum: 2,
      step: 0.01,
      suffix: "u",
      digits: 2,
    });
    this.element.append(scheduler);

    const history = this.createSection("P8.3", "History and branch commitment");
    this.addRange(history, {
      target: config.history,
      key: "recentLegPenalty",
      label: "Recent-leg penalty",
      minimum: 0,
      maximum: 3,
      step: 0.05,
      suffix: "x",
      digits: 2,
    });
    this.addRange(history, {
      target: config.history,
      key: "trailingLegUrgency",
      label: "Trailing-leg urgency",
      minimum: 0,
      maximum: 3,
      step: 0.05,
      suffix: "x",
      digits: 2,
    });
    this.addRange(history, {
      target: config.junction,
      key: "destinationSideSupportThreshold",
      label: "Destination support threshold",
      minimum: 2,
      maximum: 6,
      step: 1,
      digits: 0,
    });
    this.addRange(history, {
      target: config.junction,
      key: "minimumDestinationSideWorldSpread",
      label: "Destination support spread",
      minimum: 0,
      maximum: 0.8,
      step: 0.01,
      suffix: "u",
      digits: 2,
    });
    this.addRange(history, {
      target: config.junction,
      key: "trailingReachLimit",
      label: "Trailing reach limit",
      minimum: 0.55,
      maximum: 1,
      step: 0.01,
      digits: 2,
    });
    this.element.append(history);

    const body = this.createSection("P8.4", "Body frame and bounded recovery");
    this.addRange(body, {
      target: config.orientation,
      key: "maximumTranslationPerStep",
      label: "Body translation limit",
      minimum: 0.01,
      maximum: 0.35,
      step: 0.005,
      suffix: "u",
      digits: 3,
    });
    this.addRange(body, {
      target: config.orientation,
      key: "maximumRotationRadiansPerStep",
      label: "Body rotation limit",
      minimum: 0.01,
      maximum: Math.PI / 2,
      step: Math.PI / 180,
      suffix: "rad",
      digits: 2,
    });
    this.addRange(body, {
      target: config.recovery,
      key: "searchRadius",
      label: "Local-search radius",
      minimum: 0.04,
      maximum: 0.7,
      step: 0.01,
      suffix: "u",
      digits: 2,
    });
    this.addRange(body, {
      target: config.recovery,
      key: "maximumAttempts",
      label: "Local-search attempts",
      minimum: 1,
      maximum: 16,
      step: 1,
      digits: 0,
    });
    this.element.append(body);

    const overlaySection = this.createSection("P8.5", "Independent Phase 8 overlays");
    const toggleGrid = document.createElement("div");
    toggleGrid.className = "toggle-grid spider-toggle-grid";
    for (const [key, label] of OVERLAY_CONTROLS) {
      this.addToggle(toggleGrid, overlays, key, label);
    }
    overlaySection.append(toggleGrid);
    this.element.append(overlaySection);
  }

  get selectedScenario(): PhaseEightValidationScenarioId {
    return this.scenarioSelect.value as PhaseEightValidationScenarioId;
  }

  setSelectedScenario(scenario: PhaseEightValidationScenarioId): void {
    this.scenarioSelect.value = scenario;
  }

  refreshControls(): void {
    for (const refresh of this.refreshers) refresh();
  }

  updateMetrics(metrics: JunctionTraversalPanelMetrics): void {
    this.write("state", `${metrics.state} / ${metrics.atomicState}`);
    this.write(
      "run",
      metrics.pausedAfterStep ? "PAUSED AFTER STEP" : metrics.runMode,
    );
    this.write("step", `${metrics.stepNumber} / ${metrics.maximumStepCount}`);
    this.write("route", metrics.routeSummary);
    this.write("transition", metrics.nextTransition);
    this.write("branch", metrics.selectedBranch);
    this.write(
      "supports",
      `${metrics.destinationSideSupports}/${metrics.destinationSideRequired} · spread ${finite(metrics.destinationSideSpread, 2)}`,
    );
    this.write(
      "body",
      `${finite(metrics.bodyCenterProgress * 100, 0)}% · ${metrics.bodyCrossed ? "CROSSED" : "APPROACH"}`,
    );
    this.write(
      "trailing",
      `${metrics.trailingContacts} · max ${finite(metrics.maximumTrailingReachRatio, 2)}`,
    );
    this.write(
      "orientation",
      `${finite(metrics.orientationDegrees, 1)}° · ${finite(metrics.orientationAcceptedFraction * 100, 0)}% accepted`,
    );
    this.write("history", metrics.movedLegHistory || "none");
    this.write("influence", metrics.historyInfluence || "none");
    this.write(
      "recovery",
      `${metrics.recoveryAttempts} recovery · ${metrics.planningFailures} plan failures`,
    );
    this.write("coupled-stage", metrics.coupledStage || "none");
    this.write(
      "partial-load",
      metrics.partialFootLoad === null
        ? "none"
        : `${metrics.partialLoadLeg ?? "unassigned"} · ${finite(metrics.partialFootLoad * 100, 0)}%`,
    );
    this.write(
      "motion-candidates",
      metrics.bodyMotionCandidatesSummary || "none",
    );
    this.write(
      "accepted-motion",
      `${finite(metrics.acceptedBodyTranslation, 3)}u · ${finite(radiansToDegrees(metrics.acceptedBodyRotationRadians), 1)}°`,
    );
    this.write(
      "limiter",
      `${metrics.limitingFoot ?? "none"} · ${metrics.limitingConstraint || "none"}`,
    );
    this.write(
      "reach-budget",
      `${finite(metrics.worstReachBefore, 2)} → ${finite(metrics.worstReachAfter, 2)} · ${signedFinite(metrics.reachBudgetImprovement, 2)}`,
    );
    this.write(
      "support-classification",
      metrics.supportClassification || "unknown",
    );
    this.write(
      "deadlock",
      `${metrics.zeroProgressTransactionCount} zero-progress${metrics.deadlockReason ? ` · ${metrics.deadlockReason}` : ""}`,
    );
    this.write(
      "stop",
      metrics.stopReason === "none"
        ? "none"
        : `${metrics.stopReason}${metrics.stopMessage ? ` / ${metrics.stopMessage}` : ""}`,
    );

    const active = !["idle", "arrived", "failed", "cancelled"].includes(metrics.state);
    this.executeButton.disabled = active;
    this.continueButton.disabled = !metrics.pausedAfterStep;
    this.runButton.disabled = !active;
    this.cancelButton.disabled = !active;
  }

  private createMetrics(): HTMLElement {
    const grid = document.createElement("div");
    grid.className = "metric-grid phase8-metric-grid";
    for (const [key, label] of [
      ["state", "Traversal / atomic"],
      ["run", "Scheduler mode"],
      ["step", "Step"],
      ["route", "Semantic route"],
      ["transition", "Next transition"],
      ["branch", "Selected branch"],
      ["supports", "Destination supports"],
      ["body", "Body progress"],
      ["trailing", "Trailing contacts"],
      ["orientation", "Body rotation"],
      ["history", "Moved-leg history"],
      ["influence", "History influence"],
      ["recovery", "Bounded recovery"],
      ["coupled-stage", "Coupled transaction stage"],
      ["partial-load", "Partial foot load"],
      ["motion-candidates", "Body-motion candidates"],
      ["accepted-motion", "Accepted translation / rotation"],
      ["limiter", "Limiting foot / constraint"],
      ["reach-budget", "Worst reach before / after / improvement"],
      ["support-classification", "Support classification"],
      ["deadlock", "Zero-progress / deadlock"],
      ["stop", "Arrival / stop"],
    ] as const) {
      const cell = document.createElement("div");
      const name = document.createElement("span");
      const value = document.createElement("strong");
      name.textContent = label;
      value.textContent = "-";
      cell.append(name, value);
      grid.append(cell);
      this.metricValues.set(key, value);
    }
    return grid;
  }

  private createSection(index: string, title: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "panel-section phase8-section";
    const heading = document.createElement("h3");
    const number = document.createElement("span");
    number.textContent = index;
    heading.append(number, document.createTextNode(title));
    section.append(heading);
    return section;
  }

  private addRange<T extends object, K extends keyof T>(
    parent: HTMLElement,
    options: RangeOptions<T, K>,
  ): void {
    const row = document.createElement("label");
    row.className = "control-row";
    const heading = document.createElement("span");
    const label = document.createElement("span");
    label.textContent = options.label;
    const output = document.createElement("output");
    heading.append(label, output);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.minimum);
    input.max = String(options.maximum);
    input.step = String(options.step);
    input.setAttribute("aria-label", options.label);
    const digits = options.digits ?? 2;
    const refresh = (): void => {
      const value = Number(options.target[options.key]);
      input.value = String(value);
      output.textContent = `${value.toFixed(digits)}${options.suffix ? ` ${options.suffix}` : ""}`;
      const ratio = (value - options.minimum) / (options.maximum - options.minimum);
      input.style.setProperty("--range-progress", `${Math.max(0, Math.min(1, ratio)) * 100}%`);
    };
    input.addEventListener("input", () => {
      (options.target as Record<K, unknown>)[options.key] = Number(input.value);
      refresh();
      this.callbacks.onParameterChange();
    });
    row.append(heading, input);
    parent.append(row);
    this.refreshers.push(refresh);
    refresh();
  }

  private addToggle<T extends object, K extends keyof T>(
    parent: HTMLElement,
    target: T,
    key: K,
    label: string,
  ): void {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("aria-label", label);
    const refresh = (): void => {
      input.checked = Boolean(target[key]);
    };
    input.addEventListener("change", () => {
      (target as Record<K, unknown>)[key] = input.checked;
      this.callbacks.onParameterChange();
    });
    const visual = document.createElement("span");
    visual.className = "toggle-switch";
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, visual, text);
    parent.append(row);
    this.refreshers.push(refresh);
    refresh();
  }

  private button(label: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", action);
    return button;
  }

  private write(key: string, value: string): void {
    const element = this.metricValues.get(key);
    if (!element || element.textContent === value) return;
    element.textContent = value;
    element.title = value;
  }
}

function finite(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "invalid";
}

function signedFinite(value: number, digits: number): string {
  if (!Number.isFinite(value)) return "invalid";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function radiansToDegrees(value: number): number {
  return value * 180 / Math.PI;
}
