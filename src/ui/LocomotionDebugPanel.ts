import type { LocomotionConfig, LocomotionDebugToggles } from "../spider/locomotion/LocomotionConfig";
import type { FootholdScoreWeights } from "../spider/locomotion/LocomotionTypes";
import type {
  SpiderStepFailureReason,
  SpiderStepState,
} from "../spider/locomotion/SpiderStepState";
import type { SpiderLegId } from "../spider/SpiderRigSpec";

export const LOCOMOTION_VALIDATION_SCENARIOS = [
  "forward",
  "alternate",
  "unstableRejection",
  "upsideDown",
  "noValid",
] as const;

export type LocomotionValidationScenario =
  (typeof LOCOMOTION_VALIDATION_SCENARIOS)[number];

export interface LocomotionPanelCallbacks {
  onIssueDestination(scenario: LocomotionValidationScenario): void;
  onPlanOnly(): void;
  onExecutePlannedStep(): void;
  onCancelStep(): void;
  onResetFixture(): void;
  onTogglePause(): void;
  onSingleStep(): void;
  onParameterChange(): void;
}

export interface LocomotionPanelMetrics {
  fps: number;
  stepState: SpiderStepState;
  stateElapsedSeconds: number;
  destination: string;
  routeSummary: string;
  candidateCount: number;
  acceptedCandidateCount: number;
  rejectedCandidateCount: number;
  eligibleLegCount: number;
  movingLeg: SpiderLegId | null;
  winnerAddress: string;
  winnerScore: number | null;
  supportFootCount: number;
  probeForceNewtons: number | null;
  loadTransferFactor: number | null;
  bodyAdvanceDistance: number;
  failureReason: SpiderStepFailureReason;
  failureMessage: string;
  paused: boolean;
  /** True only while a frozen or otherwise retained plan can be executed. */
  planReady: boolean;
}

export type LocomotionRigStatus = "pending" | "valid" | "error";

interface RangeOptions<T extends object, K extends keyof T> {
  target: T;
  key: K;
  label: string;
  minimum: number;
  maximum: number;
  step: number;
  suffix?: string;
  digits?: number;
  hint?: string;
}

type DebugToggleKey = keyof LocomotionDebugToggles;
type ScoreWeightKey = keyof FootholdScoreWeights;

const SCENARIO_LABELS: Readonly<Record<LocomotionValidationScenario, string>> = {
  forward: "A - forward on primary",
  alternate: "B - alternate angled strand",
  unstableRejection: "C - reject unstable silk",
  upsideDown: "D - upside-down frame",
  noValid: "E - no valid foothold",
};

const SCORE_CONTROLS: readonly [ScoreWeightKey, string][] = [
  ["progress", "Travel progress"],
  ["comfortableReach", "Comfortable reach"],
  ["homePreference", "FootHome preference"],
  ["strandStability", "Strand stability"],
  ["futureConnectivity", "Future connectivity"],
  ["supportSpacing", "Support spacing"],
  ["reachBoundary", "Reach boundary penalty"],
  ["jointLimitViolation", "Joint-limit penalty"],
  ["bodyRotation", "Body rotation penalty"],
  ["footCrowding", "Foot crowding penalty"],
  ["legCrossing", "Leg crossing penalty"],
  ["weakOrMovingStrand", "Weak / moving strand penalty"],
  ["reducedSupportStability", "Reduced support penalty"],
];

const DEBUG_TOGGLES: readonly [DebugToggleKey, string][] = [
  ["showDestination", "Destination"],
  ["showTravelDirection", "Travel direction"],
  ["showEligibleLegs", "Eligible legs"],
  ["showRejectedLegs", "Rejected legs"],
  ["showCandidates", "Candidates"],
  ["showCandidateScores", "Candidate scores"],
  ["showWinner", "Winning foothold"],
  ["showStepState", "Step state"],
  ["showSwingCurve", "Swing curve"],
  ["showMovingFoot", "Moving foot"],
  ["showSupportSet", "Support set"],
  ["showSupportPolygon", "Support polygon"],
  ["showProbeForce", "Probe force"],
  ["showLoadTransfer", "Load transfer"],
  ["showBodyAdvance", "Body advance"],
  ["showFailure", "Failure reason"],
];

/**
 * Imperative, developer-only controls for one deliberate Phase 7 step.
 *
 * The panel edits the shared locomotion config directly and reports every edit
 * through `onParameterChange`; policy/controller ownership stays outside the UI.
 */
export class LocomotionDebugPanel {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly headerKicker: HTMLElement;
  private readonly headerTitle: HTMLElement;
  private readonly footerBoundary: HTMLElement;
  private readonly metricValues = new Map<string, HTMLElement>();
  private readonly controlRefreshers: Array<() => void> = [];
  private readonly scenarioSelect: HTMLSelectElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly planButton: HTMLButtonElement;
  private readonly executeButton: HTMLButtonElement;
  private readonly cancelButton: HTMLButtonElement;
  private readonly rigBanner: HTMLDivElement;

  constructor(
    root: HTMLElement,
    private readonly locomotionConfig: LocomotionConfig,
    private readonly callbacks: LocomotionPanelCallbacks,
  ) {
    this.panel = document.createElement("section");
    this.panel.className = "debug-panel spider-debug-panel locomotion-debug-panel";
    this.panel.setAttribute("aria-label", "Phase 7 single-step locomotion controls");

    const header = document.createElement("header");
    header.className = "panel-header";
    header.innerHTML = `
      <div>
        <small class="panel-kicker">PHASE 07 / ONE DELIBERATE STEP</small>
        <h2>Autonomous foothold lab</h2>
      </div>
      <button class="panel-collapse" type="button" aria-label="Collapse controls" aria-expanded="true">
        <span></span><span></span>
      </button>
    `;

    const headerKicker = header.querySelector<HTMLElement>(".panel-kicker");
    const headerTitle = header.querySelector<HTMLElement>("h2");
    if (!headerKicker || !headerTitle) {
      throw new Error("Locomotion panel failed to create its heading.");
    }
    this.headerKicker = headerKicker;
    this.headerTitle = headerTitle;

    const body = document.createElement("div");
    body.className = "panel-body";
    this.body = body;
    const collapse = header.querySelector<HTMLButtonElement>(".panel-collapse");
    if (!collapse) {
      throw new Error("Locomotion panel failed to create its collapse control.");
    }
    collapse.addEventListener("click", () => {
      const collapsed = this.panel.classList.toggle("is-collapsed");
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? "Expand controls" : "Collapse controls");
    });

    this.rigBanner = document.createElement("div");
    this.rigBanner.className = "rig-validation-banner pending";
    this.rigBanner.setAttribute("role", "status");
    this.rigBanner.setAttribute("aria-live", "polite");
    this.rigBanner.textContent = "LOCOMOTION / WAITING FOR VALIDATED RIG";
    body.append(this.rigBanner, this.createMetrics());

    const intentSection = this.createSection(body, "01", "Intent and one-step execution");
    const scenarioRow = document.createElement("label");
    scenarioRow.className = "select-row";
    const scenarioLabel = document.createElement("span");
    scenarioLabel.textContent = "Scenario";
    this.scenarioSelect = document.createElement("select");
    this.scenarioSelect.setAttribute("aria-label", "Validation scenario");
    for (const scenario of LOCOMOTION_VALIDATION_SCENARIOS) {
      const option = document.createElement("option");
      option.value = scenario;
      option.textContent = SCENARIO_LABELS[scenario];
      this.scenarioSelect.append(option);
    }
    scenarioRow.append(scenarioLabel, this.scenarioSelect);
    intentSection.append(scenarioRow);

    const destinationActions = document.createElement("div");
    destinationActions.className = "panel-actions traversal-actions";
    destinationActions.append(
      this.createButton("Issue destination", "I", () => {
        this.callbacks.onIssueDestination(this.selectedScenario);
      }),
      (this.planButton = this.createButton("Plan only", "P", this.callbacks.onPlanOnly)),
    );
    intentSection.append(destinationActions);

    const executionActions = document.createElement("div");
    executionActions.className = "panel-actions traversal-actions";
    this.executeButton = this.createButton(
      "Execute planned step",
      "E",
      this.callbacks.onExecutePlannedStep,
    );
    this.executeButton.disabled = true;
    this.cancelButton = this.createButton("Cancel safely", "ESC", this.callbacks.onCancelStep);
    this.cancelButton.disabled = true;
    executionActions.append(this.executeButton, this.cancelButton);
    intentSection.append(executionActions);

    this.addToggle(
      intentSection,
      locomotionConfig,
      "freezeAfterPlanning",
      "Freeze after planning",
      true,
    );

    const searchSection = this.createSection(body, "02", "Candidate and support policy");
    this.addRange(searchSection, {
      target: locomotionConfig,
      key: "minimumSupportFootCount",
      label: "Minimum loaded supports",
      minimum: 1,
      maximum: 7,
      step: 1,
      digits: 0,
      hint: "Moving foot is excluded",
    });
    this.addRange(searchSection, {
      target: locomotionConfig,
      key: "candidateSearchRadius",
      label: "Candidate search radius",
      minimum: 0.15,
      maximum: 1.8,
      step: 0.01,
      suffix: "u",
      digits: 2,
    });
    this.addRange(searchSection, {
      target: locomotionConfig,
      key: "candidateSamplingDensity",
      label: "Samples per strand",
      minimum: 3,
      maximum: 25,
      step: 1,
      digits: 0,
    });

    const scoreSection = this.createSection(body, "03", "Inspectable score weights");
    for (const [key, label] of SCORE_CONTROLS) {
      this.addRange(scoreSection, {
        target: locomotionConfig.scoreWeights,
        key,
        label,
        minimum: 0,
        maximum: 5,
        step: 0.05,
        suffix: "x",
        digits: 2,
      });
    }

    const motionSection = this.createSection(body, "04", "Swing, test, and transfer");
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "swingDuration",
      label: "Swing duration",
      minimum: 0.12,
      maximum: 2,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "liftHeight",
      label: "Lift height",
      minimum: 0.01,
      maximum: 0.5,
      step: 0.005,
      suffix: "u",
      digits: 3,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "approachAngleDegrees",
      label: "Approach angle",
      minimum: 0,
      maximum: 85,
      step: 1,
      suffix: "deg",
      digits: 0,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "testingDuration",
      label: "Contact-test duration",
      minimum: 0.02,
      maximum: 1.2,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "probeForce",
      label: "Probe force",
      minimum: 0,
      maximum: 1,
      step: 0.01,
      suffix: "N",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "plantingDuration",
      label: "Planting duration",
      minimum: 0.02,
      maximum: 0.8,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "loadTransferDuration",
      label: "Load-transfer duration",
      minimum: 0.05,
      maximum: 1.5,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "bodyAdvanceDuration",
      label: "Body-advance duration",
      minimum: 0.05,
      maximum: 1.5,
      step: 0.01,
      suffix: "s",
      digits: 2,
    });
    this.addRange(motionSection, {
      target: locomotionConfig,
      key: "bodyAdvanceDistance",
      label: "Body-advance distance",
      minimum: 0.005,
      maximum: 0.35,
      step: 0.005,
      suffix: "u",
      digits: 3,
    });

    const overlaySection = this.createSection(body, "05", "Locomotion diagnostics");
    const toggleGrid = document.createElement("div");
    toggleGrid.className = "toggle-grid spider-toggle-grid";
    for (const [key, label] of DEBUG_TOGGLES) {
      this.addToggle(toggleGrid, locomotionConfig.debug, key, label);
    }
    overlaySection.append(toggleGrid);

    const simulationActions = document.createElement("div");
    simulationActions.className = "panel-actions simulation-actions";
    this.pauseButton = this.createButton("Pause", "SPACE", this.callbacks.onTogglePause);
    this.stepButton = this.createButton("Fixed step", ".", this.callbacks.onSingleStep);
    this.stepButton.disabled = true;
    simulationActions.append(
      this.pauseButton,
      this.stepButton,
      this.createButton("Reset fixture", "R", this.callbacks.onResetFixture),
    );
    body.append(simulationActions);

    const footer = document.createElement("footer");
    footer.className = "panel-footer";
    footer.innerHTML = "<span>SEMANTIC FOOTHOLDS + SECURE TRANSFER</span><span>ONE STEP ONLY</span>";
    const footerBoundary = footer.lastElementChild;
    if (!(footerBoundary instanceof HTMLElement)) {
      throw new Error("Locomotion panel failed to create its milestone footer.");
    }
    this.footerBoundary = footerBoundary;
    body.append(footer);

    this.panel.append(header, body);
    root.replaceChildren(this.panel);
    this.setPaused(false);
    window.addEventListener("keydown", this.onKeyDown);
  }

  get selectedScenario(): LocomotionValidationScenario {
    return this.scenarioSelect.value as LocomotionValidationScenario;
  }

  /**
   * Adds a higher-level developer surface while retaining every Phase 7
   * metric and control. The appended element remains owned by its caller.
   */
  mountExtension(element: HTMLElement): void {
    const simulationActions = this.body.querySelector(".simulation-actions");
    this.body.insertBefore(element, simulationActions ?? null);
  }

  setMilestoneHeading(kicker: string, title: string, boundary: string): void {
    this.headerKicker.textContent = kicker;
    this.headerTitle.textContent = title;
    this.footerBoundary.textContent = boundary;
    this.panel.setAttribute("aria-label", `${kicker} ${title}`);
  }

  setSelectedScenario(scenario: LocomotionValidationScenario): void {
    this.scenarioSelect.value = scenario;
  }

  setRigStatus(status: LocomotionRigStatus, message: string): void {
    this.rigBanner.className = `rig-validation-banner ${status}`;
    this.rigBanner.textContent = message;
  }

  setPaused(paused: boolean): void {
    this.panel.classList.toggle("is-paused", paused);
    this.pauseButton.firstChild!.textContent = paused ? "Resume" : "Pause";
    this.stepButton.disabled = !paused;
  }

  /** Reflect programmatic scenario/config changes without firing callbacks. */
  refreshControls(): void {
    for (const refresh of this.controlRefreshers) refresh();
  }

  updateMetrics(metrics: LocomotionPanelMetrics): void {
    this.write("state", `${metrics.stepState} / ${formatFinite(metrics.stateElapsedSeconds, 2)}s`);
    this.write("destination", metrics.destination || "none");
    this.write("route", metrics.routeSummary || "none");
    this.write(
      "candidates",
      `${metrics.acceptedCandidateCount}/${metrics.candidateCount} accepted / ${metrics.rejectedCandidateCount} rejected`,
    );
    this.write("eligible", `${metrics.eligibleLegCount} legs`);
    this.write("moving", metrics.movingLeg ?? "none");
    this.write("winner", metrics.winnerAddress || "none");
    this.write(
      "score",
      metrics.winnerScore === null ? "none" : formatFinite(metrics.winnerScore, 3),
    );
    this.write(
      "support",
      `${metrics.supportFootCount} / ${this.locomotionConfig.minimumSupportFootCount} minimum`,
    );
    this.write(
      "probe",
      metrics.probeForceNewtons === null
        ? "inactive"
        : `${formatFinite(metrics.probeForceNewtons, 3)} N`,
    );
    this.write(
      "transfer",
      metrics.loadTransferFactor === null
        ? "inactive"
        : `${formatFinite(metrics.loadTransferFactor * 100, 1)}%`,
    );
    this.write("advance", `${formatFinite(metrics.bodyAdvanceDistance, 3)} u`);
    this.write(
      "failure",
      metrics.failureReason === "none"
        ? "none"
        : `${metrics.failureReason}${metrics.failureMessage ? ` / ${metrics.failureMessage}` : ""}`,
    );
    this.write("fps", formatFinite(metrics.fps, 0));
    this.write("simulation", metrics.paused ? "PAUSED" : "RUNNING");

    this.executeButton.disabled = !metrics.planReady;
    const terminal = ["idle", "complete", "failed"].includes(metrics.stepState);
    this.cancelButton.disabled = terminal;
    this.planButton.disabled = !terminal && metrics.stepState !== "planning";
    this.setPaused(metrics.paused);
  }

  /** Removes the sole global listener owned by this panel. */
  destroy(): void {
    window.removeEventListener("keydown", this.onKeyDown);
  }

  private createMetrics(): HTMLElement {
    const metrics = document.createElement("div");
    metrics.className = "metric-grid spider-metric-grid";
    for (const [key, label] of [
      ["state", "Step state"],
      ["simulation", "Simulation"],
      ["destination", "Destination"],
      ["route", "Local route"],
      ["candidates", "Candidates"],
      ["eligible", "Eligible legs"],
      ["moving", "Moving leg"],
      ["winner", "Winning address"],
      ["score", "Winning score"],
      ["support", "Loaded supports"],
      ["probe", "Probe"],
      ["transfer", "Load transfer"],
      ["advance", "Body advance"],
      ["failure", "Failure"],
      ["fps", "FPS"],
      ["boundary", "Milestone"],
    ] as const) {
      const cell = document.createElement("div");
      const name = document.createElement("span");
      const value = document.createElement("strong");
      name.textContent = label;
      value.textContent = key === "boundary" ? "ONE STEP" : "-";
      cell.append(name, value);
      metrics.append(cell);
      this.metricValues.set(key, value);
    }
    return metrics;
  }

  private createSection(parent: HTMLElement, index: string, title: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "panel-section";
    const heading = document.createElement("h3");
    const number = document.createElement("span");
    number.textContent = index;
    heading.append(number, document.createTextNode(title));
    section.append(heading);
    parent.append(section);
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
    output.setAttribute("aria-label", `${options.label} value`);
    heading.append(label, output);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.minimum);
    input.max = String(options.maximum);
    input.step = String(options.step);
    input.setAttribute("aria-label", options.label);

    const digits = options.digits ?? (options.step < 0.01 ? 3 : options.step < 0.1 ? 2 : 1);
    const refresh = (): void => {
      const value = Number(options.target[options.key]);
      input.value = String(value);
      output.textContent = `${value.toFixed(digits)}${options.suffix ? ` ${options.suffix}` : ""}`;
      const progress = (value - options.minimum) / (options.maximum - options.minimum);
      input.style.setProperty("--range-progress", `${Math.max(0, Math.min(1, progress)) * 100}%`);
    };
    input.addEventListener("input", () => {
      const value = Number(input.value);
      (options.target as Record<K, unknown>)[options.key] = value;
      refresh();
      this.callbacks.onParameterChange();
    });

    row.append(heading, input);
    if (options.hint) {
      const hint = document.createElement("small");
      hint.textContent = options.hint;
      row.append(hint);
    }
    parent.append(row);
    this.controlRefreshers.push(refresh);
    refresh();
  }

  private addToggle<T extends object, K extends keyof T>(
    parent: HTMLElement,
    target: T,
    key: K,
    label: string,
    wide = false,
  ): void {
    const row = document.createElement("label");
    row.className = wide ? "toggle-row wide-toggle" : "toggle-row";
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
    const switchVisual = document.createElement("span");
    switchVisual.className = "toggle-switch";
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, switchVisual, text);
    parent.append(row);
    this.controlRefreshers.push(refresh);
    refresh();
  }

  private createButton(label: string, key: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    const keyNode = document.createElement("kbd");
    keyNode.textContent = key;
    button.append(document.createTextNode(label), keyNode);
    button.addEventListener("click", action);
    return button;
  }

  private write(key: string, value: string): void {
    const element = this.metricValues.get(key);
    if (element && element.textContent !== value) element.textContent = value;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, button, select, textarea")) return;

    if (event.code === "Space") {
      event.preventDefault();
      this.callbacks.onTogglePause();
    } else if (event.code === "Period" || event.code === "KeyN") {
      event.preventDefault();
      this.callbacks.onSingleStep();
    } else if (event.code === "KeyI") {
      event.preventDefault();
      this.callbacks.onIssueDestination(this.selectedScenario);
    } else if (event.code === "KeyP") {
      event.preventDefault();
      this.callbacks.onPlanOnly();
    } else if (event.code === "KeyE" && !this.executeButton.disabled) {
      event.preventDefault();
      this.callbacks.onExecutePlannedStep();
    } else if (event.code === "Escape" && !this.cancelButton.disabled) {
      event.preventDefault();
      this.callbacks.onCancelStep();
    } else if (event.code === "KeyR") {
      event.preventDefault();
      this.callbacks.onResetFixture();
    }
  };
}

function formatFinite(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "invalid";
}
