import type { LabConfig } from "../config";

type NumericConfigKey =
  | "gravity"
  | "damping"
  | "stiffness"
  | "solverIterations"
  | "pointCount"
  | "slack"
  | "appliedForce"
  | "contactLoad"
  | "visualScale";

type BooleanConfigKey =
  | "showPoints"
  | "showNodeLabels"
  | "showDebugLines"
  | "showTension"
  | "showStrandIds"
  | "showNodeIds"
  | "showCrossings"
  | "showRoute"
  | "showClosestQuery"
  | "showTangent"
  | "showNormal"
  | "showBinormal"
  | "showContact"
  | "showVelocity";

export interface PanelCallbacks {
  onTogglePause: () => void;
  onSingleStep: () => void;
  onReset: () => void;
  onTopologyChange: () => void;
  onParameterChange: () => void;
  onToggleContact: () => void;
  onMoveContact: (deltaT: number) => void;
  onCycleRoute: () => void;
}

export interface DebugMetrics {
  fps: number;
  pointCount: number;
  fixedPointCount: number;
  dynamicNodeCount: number;
  strandCount: number;
  constraintCount: number;
  maximumStretch: number;
  maximumTension: number;
  selectedPoint: string;
  queryAddress: string;
  contactAddress: string;
  routeSummary: string;
  crossingSummary: string;
  paused: boolean;
}

interface SliderOptions {
  key: NumericConfigKey;
  label: string;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  rebuild?: boolean;
  hint?: string;
}

export class DebugPanel {
  private readonly root: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly statusText: HTMLElement;
  private readonly metricValues = new Map<string, HTMLElement>();

  constructor(
    mount: HTMLElement,
    private readonly config: LabConfig,
    private readonly callbacks: PanelCallbacks,
  ) {
    this.root = document.createElement("section");
    this.root.className = "debug-panel";
    this.root.setAttribute("aria-label", "Silk simulation controls");

    const header = document.createElement("header");
    header.className = "panel-header";
    header.innerHTML = `
      <div>
        <span class="panel-kicker">SIMULATION</span>
        <h2>Traversal controls</h2>
      </div>
      <button class="panel-collapse" type="button" aria-label="Collapse controls" aria-expanded="true">
        <span></span><span></span>
      </button>
    `;

    const panelBody = document.createElement("div");
    panelBody.className = "panel-body";
    const collapseButton = header.querySelector<HTMLButtonElement>(".panel-collapse");
    collapseButton?.addEventListener("click", () => {
      const collapsed = this.root.classList.toggle("is-collapsed");
      collapseButton.setAttribute("aria-expanded", String(!collapsed));
      collapseButton.setAttribute("aria-label", collapsed ? "Expand controls" : "Collapse controls");
    });

    const liveStatus = document.createElement("div");
    liveStatus.className = "live-status";
    liveStatus.innerHTML = `<span class="live-dot"></span><strong>NETWORK LIVE</strong><em>120 Hz fixed step</em>`;
    this.statusText = liveStatus.querySelector("strong") as HTMLElement;
    panelBody.append(liveStatus);

    panelBody.append(this.createMetrics());

    const tuning = this.createSection("Tuning", "01");
    this.addSlider(tuning, {
      key: "gravity",
      label: "Gravity",
      min: -18,
      max: 0,
      step: 0.1,
      format: (value) => `${value.toFixed(1)} m/s²`,
    });
    this.addSlider(tuning, {
      key: "damping",
      label: "Damping",
      min: 0.1,
      max: 4,
      step: 0.05,
      format: (value) => `${value.toFixed(2)} /s`,
      hint: "Higher settles faster",
    });
    this.addSlider(tuning, {
      key: "stiffness",
      label: "Stiffness",
      min: 0.55,
      max: 1,
      step: 0.005,
      format: (value) => `${Math.round(value * 100)}%`,
    });
    this.addSlider(tuning, {
      key: "solverIterations",
      label: "Solver passes",
      min: 4,
      max: 20,
      step: 1,
      format: (value) => `${Math.round(value)}`,
    });
    this.addSlider(tuning, {
      key: "appliedForce",
      label: "Applied force",
      min: 0.5,
      max: 12,
      step: 0.1,
      format: (value) => `${value.toFixed(1)} N`,
    });
    this.addSlider(tuning, {
      key: "contactLoad",
      label: "Temporary contact load",
      min: 0,
      max: 8,
      step: 0.1,
      format: (value) => `${value.toFixed(1)} N`,
    });
    panelBody.append(tuning);

    const topology = this.createSection("Network model", "02");
    this.addSlider(topology, {
      key: "pointCount",
      label: "Points / strand",
      min: 16,
      max: 24,
      step: 1,
      format: (value) => `${Math.round(value)}`,
      rebuild: true,
      hint: "Rebuilds on release",
    });
    this.addSlider(topology, {
      key: "slack",
      label: "Rest length / slack",
      min: 1.01,
      max: 1.28,
      step: 0.005,
      format: (value) => `+${Math.round((value - 1) * 100)}%`,
      rebuild: true,
      hint: "Over anchor distance",
    });
    this.addSlider(topology, {
      key: "visualScale",
      label: "Silk visual scale",
      min: 0.5,
      max: 2.5,
      step: 0.05,
      format: (value) => `${value.toFixed(2)}×`,
    });
    panelBody.append(topology);

    const overlays = this.createSection("Overlays", "03");
    const toggleGrid = document.createElement("div");
    toggleGrid.className = "toggle-grid";
    this.addToggle(toggleGrid, "showTension", "Local tension");
    this.addToggle(toggleGrid, "showStrandIds", "Strand IDs");
    this.addToggle(toggleGrid, "showNodeIds", "Node IDs");
    this.addToggle(toggleGrid, "showCrossings", "Crossing types");
    this.addToggle(toggleGrid, "showRoute", "Selected route");
    this.addToggle(toggleGrid, "showClosestQuery", "Closest-point query");
    this.addToggle(toggleGrid, "showTangent", "Tangent");
    this.addToggle(toggleGrid, "showNormal", "Normal");
    this.addToggle(toggleGrid, "showBinormal", "Binormal");
    this.addToggle(toggleGrid, "showContact", "Temporary contact");
    this.addToggle(toggleGrid, "showVelocity", "Strand velocity");
    this.addToggle(toggleGrid, "showPoints", "Simulation points");
    this.addToggle(toggleGrid, "showDebugLines", "Debug lines");
    overlays.append(toggleGrid);
    panelBody.append(overlays);

    const traversalActions = document.createElement("div");
    traversalActions.className = "panel-actions traversal-actions";
    traversalActions.append(
      this.createActionButton("Contact −", "[", () => this.callbacks.onMoveContact(-0.08)),
      this.createActionButton("Attach / release", "C", this.callbacks.onToggleContact),
      this.createActionButton("Contact +", "]", () => this.callbacks.onMoveContact(0.08)),
      this.createActionButton("Cycle route", "V", this.callbacks.onCycleRoute),
    );
    panelBody.append(traversalActions);

    const actions = document.createElement("div");
    actions.className = "panel-actions";
    this.pauseButton = this.createActionButton("Pause", "SPACE", this.callbacks.onTogglePause);
    this.stepButton = this.createActionButton("Step", ".", this.callbacks.onSingleStep);
    const resetButton = this.createActionButton("Reset", "R", this.callbacks.onReset);
    actions.append(this.pauseButton, this.stepButton, resetButton);
    panelBody.append(actions);

    const footer = document.createElement("footer");
    footer.className = "panel-footer";
    footer.innerHTML = `<span>VERLET + XPBD + GRAPH</span><span>PHASE 5 / TRAVERSAL</span>`;
    panelBody.append(footer);

    this.root.append(header, panelBody);
    mount.append(this.root);
    this.setPaused(false);
    window.addEventListener("keydown", this.onKeyDown);
  }

  setPaused(paused: boolean): void {
    this.root.classList.toggle("is-paused", paused);
    this.pauseButton.firstChild!.textContent = paused ? "Resume" : "Pause";
    this.stepButton.disabled = !paused;
    this.statusText.textContent = paused ? "NETWORK PAUSED" : "NETWORK LIVE";
  }

  updateMetrics(metrics: DebugMetrics): void {
    this.metricValues.get("fps")!.textContent = metrics.fps.toFixed(0);
    this.metricValues.get("points")!.textContent =
      `${metrics.pointCount} · ${metrics.fixedPointCount}F / ${metrics.dynamicNodeCount}M`;
    this.metricValues.get("strands")!.textContent = `${metrics.strandCount}`;
    this.metricValues.get("constraints")!.textContent = `${metrics.constraintCount}`;
    this.metricValues.get("stretch")!.textContent = `${(metrics.maximumStretch * 100).toFixed(2)}%`;
    this.metricValues.get("tension")!.textContent = `${metrics.maximumTension.toFixed(2)} N`;
    this.metricValues.get("selected")!.textContent = metrics.selectedPoint;
    this.metricValues.get("query")!.textContent = metrics.queryAddress;
    this.metricValues.get("contact")!.textContent = metrics.contactAddress;
    this.metricValues.get("route")!.textContent = metrics.routeSummary;
    this.metricValues.get("crossings")!.textContent = metrics.crossingSummary;
    this.metricValues.get("state")!.textContent = metrics.paused ? "PAUSED" : "RUNNING";
    this.setPaused(metrics.paused);
  }

  private createMetrics(): HTMLElement {
    const section = document.createElement("section");
    section.className = "metrics";
    const metrics = [
      ["fps", "FPS"],
      ["points", "Points"],
      ["strands", "Strands"],
      ["constraints", "Constraints"],
      ["stretch", "Max stretch"],
      ["tension", "Peak tension"],
      ["selected", "Selected"],
      ["query", "Closest query"],
      ["contact", "Contact"],
      ["route", "Route"],
      ["crossings", "Crossings"],
      ["state", "State"],
    ];

    for (const [key, label] of metrics) {
      const item = document.createElement("div");
      item.className = ["selected", "query", "contact", "route", "crossings"].includes(key)
        ? "metric metric-wide"
        : "metric";
      const labelElement = document.createElement("span");
      labelElement.textContent = label;
      const value = document.createElement("strong");
      value.textContent = "—";
      item.append(labelElement, value);
      section.append(item);
      this.metricValues.set(key, value);
    }
    return section;
  }

  private createSection(title: string, index: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "control-section";
    const heading = document.createElement("div");
    heading.className = "section-heading";
    heading.innerHTML = `<span>${index}</span><h3>${title}</h3>`;
    section.append(heading);
    return section;
  }

  private addSlider(parent: HTMLElement, options: SliderOptions): void {
    const row = document.createElement("label");
    row.className = "control-row";
    const heading = document.createElement("span");
    heading.className = "control-label";
    const name = document.createElement("span");
    name.textContent = options.label;
    const value = document.createElement("output");
    value.textContent = options.format(this.config[options.key]);
    heading.append(name, value);

    const input = document.createElement("input");
    input.type = "range";
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(this.config[options.key]);
    input.setAttribute("aria-label", options.label);

    const updateValue = (): void => {
      const nextValue = Number(input.value);
      this.config[options.key] = nextValue;
      value.textContent = options.format(nextValue);
      input.style.setProperty(
        "--range-progress",
        `${((nextValue - options.min) / (options.max - options.min)) * 100}%`,
      );
      if (!options.rebuild) {
        this.callbacks.onParameterChange();
      }
    };
    input.addEventListener("input", updateValue);
    if (options.rebuild) {
      input.addEventListener("change", this.callbacks.onTopologyChange);
    }

    row.append(heading, input);
    if (options.hint) {
      const hint = document.createElement("small");
      hint.textContent = options.hint;
      row.append(hint);
    }
    parent.append(row);
    updateValue();
  }

  private addToggle(parent: HTMLElement, key: BooleanConfigKey, label: string): void {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.config[key];
    input.addEventListener("change", () => {
      this.config[key] = input.checked;
      this.callbacks.onParameterChange();
    });
    const switchVisual = document.createElement("span");
    switchVisual.className = "toggle-switch";
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, switchVisual, text);
    parent.append(row);
  }

  private createActionButton(label: string, key: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    const labelNode = document.createTextNode(label);
    const keyNode = document.createElement("kbd");
    keyNode.textContent = key;
    button.append(labelNode, keyNode);
    button.addEventListener("click", action);
    return button;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.matches("input, button, select, textarea")) {
      return;
    }

    if (event.code === "Space") {
      event.preventDefault();
      this.callbacks.onTogglePause();
    } else if (event.code === "Period" || event.code === "KeyN") {
      event.preventDefault();
      this.callbacks.onSingleStep();
    } else if (event.code === "KeyR") {
      event.preventDefault();
      this.callbacks.onReset();
    } else if (event.code === "BracketLeft") {
      event.preventDefault();
      this.callbacks.onMoveContact(-0.08);
    } else if (event.code === "BracketRight") {
      event.preventDefault();
      this.callbacks.onMoveContact(0.08);
    } else if (event.code === "KeyC") {
      event.preventDefault();
      this.callbacks.onToggleContact();
    } else if (event.code === "KeyV") {
      event.preventDefault();
      this.callbacks.onCycleRoute();
    }
  };
}
