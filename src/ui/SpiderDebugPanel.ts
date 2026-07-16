import type { LabConfig } from "../config";
import type { SpiderLabConfig } from "../spider/SpiderConfig";
import type { SpiderLegId } from "../web/createPhaseSixFixture";
import { SPIDER_LEG_IDS } from "../web/createPhaseSixFixture";

export interface SpiderPanelMetrics {
  fps: number;
  rigStatus: string;
  rigNames: string;
  loadedFeet: number;
  validFeet: number;
  totalFeet: number;
  totalWeight: number;
  averageFootLoad: number;
  appliedLoad: number;
  loadMismatch: number;
  maximumIkError: number;
  maximumReachRatio: number;
  selectedFootState: string;
  selectedFootAddress: string;
  poseName: string;
  particleCount: number;
  constraintCount: number;
  maximumStretch: number;
  paused: boolean;
}

export interface SpiderPanelCallbacks {
  onTogglePause(): void;
  onSingleStep(): void;
  onResetFixture(): void;
  onParameterChange(): void;
  onSelectFoot(legId: SpiderLegId): void;
  onAssignFoot(legId: SpiderLegId, strandId: string, t: number): void;
  onToggleSelectedFoot(legId: SpiderLegId): void;
  onNeutralPose(): void;
  onDisturbance(): void;
  onSmallTranslation(): void;
  onRotateNinety(): void;
  onUpsideDown(): void;
  onFourFootSupport(): void;
}

type SpiderBooleanKey = {
  [K in keyof SpiderLabConfig]: SpiderLabConfig[K] extends boolean ? K : never;
}[keyof SpiderLabConfig];

export class SpiderDebugPanel {
  private readonly metricValues = new Map<string, HTMLElement>();
  private readonly rangeRefreshers: Array<() => void> = [];
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly rigBanner: HTMLDivElement;
  private readonly selectedFoot: HTMLSelectElement;
  private readonly selectedStrand: HTMLSelectElement;
  private readonly selectedT: HTMLInputElement;
  private readonly selectedTOutput: HTMLOutputElement;

  constructor(
    root: HTMLElement,
    webConfig: LabConfig,
    private readonly spiderConfig: SpiderLabConfig,
    supportStrandIds: readonly string[],
    private readonly callbacks: SpiderPanelCallbacks,
  ) {
    const panel = document.createElement("section");
    panel.className = "debug-panel spider-debug-panel";
    panel.setAttribute("aria-label", "Spider rig and planted contact controls");
    panel.innerHTML = `
      <header class="panel-header">
        <div><small>PHASE 06 / RIG BRIDGE</small><h2>Planted contact lab</h2></div>
        <button class="panel-collapse" type="button" aria-label="Collapse controls" aria-expanded="true">−</button>
      </header>
      <div class="panel-body"></div>
    `;
    root.replaceChildren(panel);
    const body = panel.querySelector<HTMLElement>(".panel-body");
    const collapse = panel.querySelector<HTMLButtonElement>(".panel-collapse");
    if (!body || !collapse) {
      throw new Error("Spider debug panel failed to create its required controls.");
    }
    collapse.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("is-collapsed");
      collapse.textContent = collapsed ? "+" : "−";
      collapse.setAttribute("aria-expanded", String(!collapsed));
      collapse.setAttribute("aria-label", collapsed ? "Expand controls" : "Collapse controls");
    });

    this.rigBanner = document.createElement("div");
    this.rigBanner.className = "rig-validation-banner pending";
    this.rigBanner.textContent = "RIG / LOADING EXACT NAMES";
    body.append(this.rigBanner);

    const metrics = document.createElement("div");
    metrics.className = "metric-grid spider-metric-grid";
    for (const [key, label] of [
      ["rig", "Rig"], ["names", "Name validation"],
      ["feet", "Loaded / valid"], ["weight", "Spider weight"],
      ["footLoad", "Weight / foot"], ["applied", "Applied web load"],
      ["mismatch", "Distribution mismatch"], ["ik", "Max IK error"],
      ["reach", "Max reach ratio"], ["selected", "Selected foot"],
      ["address", "Foot address"], ["pose", "Fixture pose"],
      ["web", "Web topology"], ["stretch", "Web stretch"],
      ["fps", "FPS"], ["state", "State"],
    ] as const) {
      const cell = document.createElement("div");
      const name = document.createElement("span");
      const value = document.createElement("strong");
      name.textContent = label;
      value.textContent = "—";
      cell.append(name, value);
      metrics.append(cell);
      this.metricValues.set(key, value);
    }
    body.append(metrics);

    const bodySection = this.createSection(body, "01", "Body fixture");
    this.addRange(bodySection, "Spider total weight", spiderConfig, "totalWeight", 0.2, 6, 0.1, "N");
    this.addRange(bodySection, "Body offset X", spiderConfig, "bodyOffsetX", -0.35, 0.35, 0.01, "u");
    this.addRange(bodySection, "Body offset Y", spiderConfig, "bodyOffsetY", -0.25, 0.25, 0.01, "u");
    this.addRange(bodySection, "Body offset Z", spiderConfig, "bodyOffsetZ", -0.35, 0.35, 0.01, "u");
    this.addRange(bodySection, "Body pitch", spiderConfig, "bodyPitchDegrees", -180, 180, 1, "°");
    this.addRange(bodySection, "Body yaw", spiderConfig, "bodyYawDegrees", -180, 180, 1, "°");
    this.addRange(bodySection, "Body roll", spiderConfig, "bodyRollDegrees", -180, 180, 1, "°");
    this.addRange(bodySection, "Thorax height", spiderConfig, "thoraxHeight", -0.35, 0.35, 0.005, "u", 3);
    const loadMode = document.createElement("label");
    loadMode.className = "toggle-row wide-toggle";
    const loadInput = document.createElement("input");
    loadInput.type = "checkbox";
    loadInput.checked = spiderConfig.loadMode === "position-weighted";
    loadInput.addEventListener("change", () => {
      spiderConfig.loadMode = loadInput.checked ? "position-weighted" : "equal";
      callbacks.onParameterChange();
    });
    const loadSwitch = document.createElement("span");
    loadSwitch.className = "toggle-switch";
    const loadText = document.createElement("span");
    loadText.textContent = "Position-weighted load distribution";
    loadMode.append(loadInput, loadSwitch, loadText);
    bodySection.append(loadMode);

    const contactSection = this.createSection(body, "02", "Foot contact inspector");
    const selectors = document.createElement("div");
    selectors.className = "foot-contact-selectors";
    this.selectedFoot = this.createSelect("Selected foot", SPIDER_LEG_IDS);
    this.selectedFoot.value = spiderConfig.selectedFoot;
    this.selectedStrand = this.createSelect("Assigned strand", supportStrandIds);
    this.selectedStrand.value = `support-${spiderConfig.selectedFoot.toLowerCase()}`;
    this.selectedT = document.createElement("input");
    this.selectedT.type = "range";
    this.selectedT.min = "0.02";
    this.selectedT.max = "0.98";
    this.selectedT.step = "0.001";
    this.selectedT.value = String(spiderConfig.selectedContactT);
    this.selectedT.setAttribute("aria-label", "Selected foot contact t");
    this.selectedTOutput = document.createElement("output");
    this.selectedTOutput.setAttribute("aria-label", "Selected foot contact t");
    this.selectedTOutput.textContent = spiderConfig.selectedContactT.toFixed(3);
    const tRow = document.createElement("label");
    tRow.className = "control-row";
    const tHeading = document.createElement("span");
    tHeading.textContent = "Normalized strand t";
    tHeading.append(this.selectedTOutput);
    tRow.append(tHeading, this.selectedT);
    selectors.append(
      this.wrapSelect("Foot", this.selectedFoot),
      this.wrapSelect("Strand", this.selectedStrand),
      tRow,
    );
    contactSection.append(selectors);
    this.selectedFoot.addEventListener("change", () => {
      spiderConfig.selectedFoot = this.selectedFoot.value as SpiderLegId;
      callbacks.onSelectFoot(spiderConfig.selectedFoot);
    });
    this.selectedT.addEventListener("input", () => {
      spiderConfig.selectedContactT = Number(this.selectedT.value);
      this.selectedTOutput.textContent = spiderConfig.selectedContactT.toFixed(3);
    });
    const contactActions = document.createElement("div");
    contactActions.className = "panel-actions traversal-actions";
    contactActions.append(
      this.createButton("Assign address", "A", () => callbacks.onAssignFoot(
        this.selectedFoot.value as SpiderLegId,
        this.selectedStrand.value,
        Number(this.selectedT.value),
      )),
      this.createButton("Plant / release", "F", () => callbacks.onToggleSelectedFoot(
        this.selectedFoot.value as SpiderLegId,
      )),
    );
    contactSection.append(contactActions);

    const scenarioSection = this.createSection(body, "03", "Validation scenarios");
    const scenarioActions = document.createElement("div");
    scenarioActions.className = "panel-actions spider-scenario-actions";
    scenarioActions.append(
      this.createButton("Neutral / 8 feet", "A", callbacks.onNeutralPose),
      this.createButton("Disturb web", "B", callbacks.onDisturbance),
      this.createButton("Small translation", "C", callbacks.onSmallTranslation),
      this.createButton("Rotate 90°", "D", callbacks.onRotateNinety),
      this.createButton("Upside down", "U", callbacks.onUpsideDown),
      this.createButton("Four-foot support", "E", callbacks.onFourFootSupport),
    );
    scenarioSection.append(scenarioActions);

    const overlaySection = this.createSection(body, "04", "Spider diagnostics");
    const toggles = document.createElement("div");
    toggles.className = "toggle-grid spider-toggle-grid";
    for (const [key, label] of [
      ["showSkeleton", "Skeleton"], ["showBoneAxes", "Bone axes"],
      ["showFootTargets", "Foot targets"], ["showPlantedContacts", "Planted contacts"],
      ["showFootHomes", "FootHome references"], ["showReachRanges", "Reach ranges"],
      ["showReachRatio", "Reach ratio"], ["showContactFrames", "Contact frames"],
      ["showPerFootLoad", "Per-foot load"], ["showSupportCenter", "Support center"],
      ["showBodyAxes", "Body forward / up"], ["showInvalidContacts", "Invalid contacts"],
      ["showRigValidation", "Rig-name validation"],
    ] as const) {
      this.addToggle(toggles, key, label);
    }
    overlaySection.append(toggles);

    const webSection = this.createSection(body, "05", "Web simulation");
    this.addRange(webSection, "Gravity", webConfig, "gravity", -12, 0, 0.1, "m/s²");
    this.addRange(webSection, "Damping", webConfig, "damping", 0.4, 4, 0.05, "/s");
    this.addRange(webSection, "Stiffness", webConfig, "stiffness", 0.7, 0.995, 0.005, "", 3);
    this.addRange(webSection, "Solver passes", webConfig, "solverIterations", 4, 18, 1, "");
    this.addRange(webSection, "Disturbance force", webConfig, "appliedForce", 1, 12, 0.5, "N");

    const simulationActions = document.createElement("div");
    simulationActions.className = "panel-actions simulation-actions";
    this.pauseButton = this.createButton("Pause", "SPACE", callbacks.onTogglePause);
    this.stepButton = this.createButton("Step", ".", callbacks.onSingleStep);
    this.stepButton.disabled = true;
    simulationActions.append(
      this.pauseButton,
      this.stepButton,
      this.createButton("Reset fixture", "R", callbacks.onResetFixture),
    );
    body.append(simulationActions);
    const footer = document.createElement("footer");
    footer.className = "panel-footer";
    footer.innerHTML = "<span>GLTF · CONTINUOUS CONTACT · IK</span><span>NO GAIT</span>";
    body.append(footer);
  }

  setRigStatus(status: "pending" | "valid" | "error", message: string): void {
    this.rigBanner.className = `rig-validation-banner ${status}`;
    this.rigBanner.textContent = message;
  }

  setSelectedContact(strandId: string, t: number): void {
    this.selectedStrand.value = strandId;
    this.selectedT.value = String(t);
    this.spiderConfig.selectedContactT = t;
    this.selectedTOutput.textContent = t.toFixed(3);
  }

  setPaused(paused: boolean): void {
    this.pauseButton.firstChild!.textContent = paused ? "Resume" : "Pause";
    this.stepButton.disabled = !paused;
  }

  /** Keep programmatic validation-scenario changes reflected in the controls. */
  refreshControls(): void {
    for (const refresh of this.rangeRefreshers) refresh();
  }

  updateMetrics(metrics: SpiderPanelMetrics): void {
    this.write("rig", metrics.rigStatus);
    this.write("names", metrics.rigNames);
    this.write("feet", `${metrics.loadedFeet}/${metrics.totalFeet} · ${metrics.validFeet} valid`);
    this.write("weight", `${metrics.totalWeight.toFixed(2)} N`);
    this.write("footLoad", `${metrics.averageFootLoad.toFixed(3)} N`);
    this.write("applied", `${metrics.appliedLoad.toFixed(3)} N`);
    this.write("mismatch", `${metrics.loadMismatch.toFixed(4)} N`);
    this.write("ik", `${(metrics.maximumIkError * 1000).toFixed(1)} mm`);
    this.write("reach", `${(metrics.maximumReachRatio * 100).toFixed(1)}%`);
    this.write("selected", metrics.selectedFootState);
    this.write("address", metrics.selectedFootAddress);
    this.write("pose", metrics.poseName);
    this.write("web", `${metrics.particleCount} pts · ${metrics.constraintCount} links`);
    this.write("stretch", `${(metrics.maximumStretch * 100).toFixed(2)}%`);
    this.write("fps", metrics.fps.toFixed(0));
    this.write("state", metrics.paused ? "PAUSED" : "RUNNING");
  }

  private write(key: string, value: string): void {
    const element = this.metricValues.get(key);
    if (element && element.textContent !== value) {
      element.textContent = value;
    }
  }

  private createSection(parent: HTMLElement, number: string, title: string): HTMLElement {
    const section = document.createElement("section");
    section.className = "panel-section";
    const heading = document.createElement("h3");
    heading.innerHTML = `<span>${number}</span>${title}`;
    section.append(heading);
    parent.append(section);
    return section;
  }

  private addRange<T extends object, K extends keyof T>(
    parent: HTMLElement,
    label: string,
    target: T,
    key: K,
    minimum: number,
    maximum: number,
    step: number,
    suffix: string,
    digits = step < 0.01 ? 3 : step < 0.1 ? 2 : 1,
  ): void {
    const row = document.createElement("label");
    row.className = "control-row";
    const heading = document.createElement("span");
    heading.textContent = label;
    const output = document.createElement("output");
    output.setAttribute("aria-label", label);
    heading.append(output);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(minimum);
    input.max = String(maximum);
    input.step = String(step);
    input.value = String(target[key]);
    input.setAttribute("aria-label", label);
    const refresh = (): void => {
      const value = Number(target[key]);
      input.value = String(value);
      output.textContent = `${value.toFixed(digits)}${suffix ? ` ${suffix}` : ""}`;
    };
    const update = (): void => {
      const value = Number(input.value);
      (target as Record<K, unknown>)[key] = value;
      output.textContent = `${value.toFixed(digits)}${suffix ? ` ${suffix}` : ""}`;
      this.callbacks.onParameterChange();
    };
    input.addEventListener("input", update);
    row.append(heading, input);
    parent.append(row);
    this.rangeRefreshers.push(refresh);
    refresh();
  }

  private addToggle(parent: HTMLElement, key: SpiderBooleanKey, label: string): void {
    const row = document.createElement("label");
    row.className = "toggle-row";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.spiderConfig[key];
    input.addEventListener("change", () => {
      this.spiderConfig[key] = input.checked;
      this.callbacks.onParameterChange();
    });
    const visual = document.createElement("span");
    visual.className = "toggle-switch";
    const text = document.createElement("span");
    text.textContent = label;
    row.append(input, visual, text);
    parent.append(row);
  }

  private createSelect(label: string, options: readonly string[]): HTMLSelectElement {
    const select = document.createElement("select");
    select.setAttribute("aria-label", label);
    for (const value of options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.append(option);
    }
    return select;
  }

  private wrapSelect(label: string, select: HTMLSelectElement): HTMLElement {
    const row = document.createElement("label");
    row.className = "select-row";
    const text = document.createElement("span");
    text.textContent = label;
    row.append(text, select);
    return row;
  }

  private createButton(label: string, key: string, action: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.append(document.createTextNode(label));
    const keyNode = document.createElement("kbd");
    keyNode.textContent = key;
    button.append(keyNode);
    button.addEventListener("click", action);
    return button;
  }
}
