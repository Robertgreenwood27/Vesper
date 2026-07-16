import * as THREE from "three";
import type { Vec3Like } from "../traversal";
import type { LocomotionConfig } from "../spider/locomotion/LocomotionConfig";
import type {
  FootholdCandidate,
  LegIneligibilityReason,
} from "../spider/locomotion/LocomotionTypes";
import type {
  SpiderStepFailureReason,
  SpiderStepState,
} from "../spider/locomotion/SpiderStepState";
import type { SpiderLegId } from "../spider/SpiderRigSpec";

export interface LocomotionDebugDestination {
  readonly position: Vec3Like;
  /** Human-readable semantic address, node ID, or world-query description. */
  readonly label?: string;
}

export interface LocomotionDebugLeg {
  readonly legId: SpiderLegId;
  readonly position: Vec3Like;
  readonly eligible: boolean;
  readonly reasons: readonly (LegIneligibilityReason | string)[];
}

export interface LocomotionDebugMovingFoot {
  readonly legId: SpiderLegId;
  readonly currentPosition: Vec3Like;
  readonly targetPosition: Vec3Like;
}

export interface LocomotionDebugSupport {
  readonly legId: SpiderLegId;
  readonly position: Vec3Like;
  readonly loaded: boolean;
  readonly valid: boolean;
}

export interface LocomotionDebugProbe {
  readonly origin: Vec3Like;
  /** World-space force vector in newtons. */
  readonly force: Vec3Like;
}

export interface LocomotionDebugLoadTransfer {
  readonly legId: SpiderLegId;
  readonly position: Vec3Like;
  /** Normalized commanded load factor. */
  readonly factor: number;
}

export interface LocomotionDebugBodyAdvance {
  readonly origin: Vec3Like;
  readonly vector: Vec3Like;
}

/**
 * Read-only Phase 7 diagnostic handoff. The controller/main loop owns every
 * value; the renderer never feeds data back into policy, contact, or physics.
 */
export interface LocomotionDebugSnapshot {
  readonly destination: LocomotionDebugDestination | null;
  readonly travelOrigin: Vec3Like | null;
  /** Unit direction is preferred; non-unit finite vectors are accepted. */
  readonly travelDirection: Vec3Like | null;
  /** Includes accepted and rejected candidates with their full score records. */
  readonly candidates: readonly FootholdCandidate[];
  readonly winner: FootholdCandidate | null;
  readonly legs: readonly LocomotionDebugLeg[];
  readonly state: SpiderStepState;
  readonly stateElapsedSeconds: number;
  readonly failureReason: SpiderStepFailureReason;
  readonly failureMessage: string;
  readonly movingFoot: LocomotionDebugMovingFoot | null;
  readonly swingCurve: readonly Vec3Like[];
  readonly supports: readonly LocomotionDebugSupport[];
  readonly supportCenter: Vec3Like | null;
  /** Ordered convex-hull or controller-supplied support-plane approximation. */
  readonly supportPolygon: readonly Vec3Like[];
  readonly probe: LocomotionDebugProbe | null;
  readonly loadTransfer: LocomotionDebugLoadTransfer | null;
  readonly bodyAdvance: LocomotionDebugBodyAdvance | null;
}

export function createEmptyLocomotionDebugSnapshot(): LocomotionDebugSnapshot {
  return {
    destination: null,
    travelOrigin: null,
    travelDirection: null,
    candidates: [],
    winner: null,
    legs: [],
    state: "idle",
    stateElapsedSeconds: 0,
    failureReason: "none",
    failureMessage: "",
    movingFoot: null,
    swingCurve: [],
    supports: [],
    supportCenter: null,
    supportPolygon: [],
    probe: null,
    loadTransfer: null,
    bodyAdvance: null,
  };
}

interface MarkerVisual {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.Material>;
  readonly label: HTMLDivElement;
}

const ACCEPTED_COLOR = 0x57d9ff;
const ELIGIBLE_COLOR = 0x70ffbd;
const WARNING_COLOR = 0xffbd4a;
const REJECTED_COLOR = 0xff4d89;
const MUTED_COLOR = 0x5a7784;
const MAX_SWING_POINTS = 256;
const MAX_SUPPORT_POLYGON_POINTS = 32;

/** Three.js/DOM-only visualization for a single deliberate locomotion step. */
export class LocomotionDebugRenderer {
  private readonly group = new THREE.Group();
  private readonly candidateVisuals: MarkerVisual[] = [];
  private readonly legVisuals: MarkerVisual[] = [];
  private readonly supportVisuals: MarkerVisual[] = [];
  private readonly labels: HTMLDivElement[] = [];
  private readonly labelMarkup = new Map<HTMLDivElement, string>();

  private readonly candidateGeometry = new THREE.OctahedronGeometry(0.035, 0);
  private readonly legGeometry = new THREE.TorusGeometry(0.075, 0.012, 6, 24);
  private readonly supportGeometry = new THREE.SphereGeometry(0.038, 8, 6);
  private readonly acceptedMaterial = this.createMaterial(ACCEPTED_COLOR, 0.82);
  private readonly rejectedMaterial = this.createMaterial(REJECTED_COLOR, 0.72);
  private readonly currentMaterial = this.createMaterial(MUTED_COLOR, 0.65);
  private readonly eligibleMaterial = this.createMaterial(ELIGIBLE_COLOR, 0.86);
  private readonly warningMaterial = this.createMaterial(WARNING_COLOR, 0.86);
  private readonly invalidMaterial = this.createMaterial(REJECTED_COLOR, 0.9);

  private readonly destinationMarker = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.11, 0),
    this.createMaterial(WARNING_COLOR, 0.92),
  );
  private readonly winnerGroup = new THREE.Group();
  private readonly movingTarget = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 12, 8),
    this.createMaterial(0xffffff, 0.95),
  );
  private readonly supportCenterMarker = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.055, 0),
    this.createMaterial(WARNING_COLOR, 0.92),
  );
  private readonly loadTransferMarker = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.016, 7, 28),
    this.createMaterial(WARNING_COLOR, 0.92),
  );

  private readonly travelArrow = this.createArrow(ACCEPTED_COLOR);
  private readonly probeArrow = this.createArrow(REJECTED_COLOR);
  private readonly bodyAdvanceArrow = this.createArrow(ELIGIBLE_COLOR);

  private readonly movingLinePositions = new Float32Array(6);
  private readonly movingLineAttribute = new THREE.BufferAttribute(this.movingLinePositions, 3);
  private readonly movingLine: THREE.Line;
  private readonly swingPositions = new Float32Array(MAX_SWING_POINTS * 3);
  private readonly swingAttribute = new THREE.BufferAttribute(this.swingPositions, 3);
  private readonly swingLine: THREE.Line;
  private readonly supportPolygonPositions = new Float32Array(MAX_SUPPORT_POLYGON_POINTS * 3);
  private readonly supportPolygonAttribute = new THREE.BufferAttribute(
    this.supportPolygonPositions,
    3,
  );
  private readonly supportPolygonLine: THREE.LineLoop;

  private readonly destinationLabel: HTMLDivElement;
  private readonly winnerLabel: HTMLDivElement;
  private readonly movingFootLabel: HTMLDivElement;
  private readonly probeLabel: HTMLDivElement;
  private readonly loadTransferLabel: HTMLDivElement;
  private readonly bodyAdvanceLabel: HTMLDivElement;
  private readonly stateLabel: HTMLDivElement;
  private readonly failureLabel: HTMLDivElement;

  private readonly projection = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly labelLayer: HTMLElement,
    private readonly config: LocomotionConfig,
  ) {
    this.group.name = "phase-7-locomotion-diagnostics";
    this.destinationMarker.visible = false;
    this.winnerGroup.visible = false;
    this.movingTarget.visible = false;
    this.supportCenterMarker.visible = false;
    this.loadTransferMarker.visible = false;
    this.destinationMarker.renderOrder = 90;
    this.movingTarget.renderOrder = 94;
    this.supportCenterMarker.renderOrder = 91;
    this.loadTransferMarker.renderOrder = 95;

    const winnerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.095, 0.018, 8, 30),
      this.createMaterial(ELIGIBLE_COLOR, 0.96),
    );
    const winnerCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.05, 0),
      this.createMaterial(ELIGIBLE_COLOR, 0.96),
    );
    this.winnerGroup.add(winnerRing, winnerCore);
    this.winnerGroup.renderOrder = 96;

    this.movingLineAttribute.setUsage(THREE.DynamicDrawUsage);
    const movingLineGeometry = new THREE.BufferGeometry();
    movingLineGeometry.setAttribute("position", this.movingLineAttribute);
    this.movingLine = new THREE.Line(
      movingLineGeometry,
      new THREE.LineDashedMaterial({
        color: 0xffffff,
        dashSize: 0.055,
        gapSize: 0.035,
        transparent: true,
        opacity: 0.75,
        depthTest: false,
      }),
    );
    this.movingLine.visible = false;

    this.swingAttribute.setUsage(THREE.DynamicDrawUsage);
    const swingGeometry = new THREE.BufferGeometry();
    swingGeometry.setAttribute("position", this.swingAttribute);
    swingGeometry.setDrawRange(0, 0);
    this.swingLine = new THREE.Line(
      swingGeometry,
      new THREE.LineBasicMaterial({
        color: 0xc88cff,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    );
    this.swingLine.visible = false;

    this.supportPolygonAttribute.setUsage(THREE.DynamicDrawUsage);
    const supportPolygonGeometry = new THREE.BufferGeometry();
    supportPolygonGeometry.setAttribute("position", this.supportPolygonAttribute);
    supportPolygonGeometry.setDrawRange(0, 0);
    this.supportPolygonLine = new THREE.LineLoop(
      supportPolygonGeometry,
      new THREE.LineBasicMaterial({
        color: ELIGIBLE_COLOR,
        transparent: true,
        opacity: 0.58,
        depthTest: false,
      }),
    );
    this.supportPolygonLine.visible = false;

    this.group.add(
      this.destinationMarker,
      this.winnerGroup,
      this.movingTarget,
      this.supportCenterMarker,
      this.loadTransferMarker,
      this.travelArrow,
      this.probeArrow,
      this.bodyAdvanceArrow,
      this.movingLine,
      this.swingLine,
      this.supportPolygonLine,
    );
    scene.add(this.group);

    this.destinationLabel = this.createLabel("traversal-label query-debug-label");
    this.winnerLabel = this.createLabel("traversal-label route-debug-label");
    this.movingFootLabel = this.createLabel("spider-debug-label");
    this.probeLabel = this.createLabel("spider-debug-label invalid");
    this.loadTransferLabel = this.createLabel("spider-debug-label strained");
    this.bodyAdvanceLabel = this.createLabel("spider-debug-label");
    this.stateLabel = this.createLabel("traversal-label locomotion-state-label");
    this.failureLabel = this.createLabel(
      "traversal-label locomotion-state-label locomotion-failure-label",
    );
    this.stateLabel.style.translate = "0 0";
    this.failureLabel.style.translate = "0 0";
  }

  update(snapshot: LocomotionDebugSnapshot): void {
    this.updateDestination(snapshot);
    this.updateCandidates(snapshot);
    this.updateWinner(snapshot);
    this.updateLegs(snapshot);
    this.updateState(snapshot);
    this.updateMovingFoot(snapshot);
    this.updateSwingCurve(snapshot.swingCurve);
    this.updateSupports(snapshot);
    this.updateProbe(snapshot.probe);
    this.updateLoadTransfer(snapshot.loadTransfer);
    this.updateBodyAdvance(snapshot.bodyAdvance);
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const label of this.labels) {
      label.remove();
    }
    this.labels.length = 0;
    this.labelMarkup.clear();

    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.Line) {
        geometries.add(object.geometry);
        const objectMaterials = Array.isArray(object.material)
          ? object.material
          : [object.material];
        for (const material of objectMaterials) {
          materials.add(material);
        }
      }
    });
    geometries.add(this.candidateGeometry);
    geometries.add(this.legGeometry);
    geometries.add(this.supportGeometry);
    for (const material of [
      this.acceptedMaterial,
      this.rejectedMaterial,
      this.currentMaterial,
      this.eligibleMaterial,
      this.warningMaterial,
      this.invalidMaterial,
    ]) {
      materials.add(material);
    }
    for (const geometry of geometries) {
      geometry.dispose();
    }
    for (const material of materials) {
      material.dispose();
    }
  }

  private updateDestination(snapshot: LocomotionDebugSnapshot): void {
    const destinationVisible =
      this.config.debug.showDestination &&
      snapshot.destination !== null &&
      this.isFiniteVector(snapshot.destination.position);
    this.destinationMarker.visible = destinationVisible;
    this.destinationLabel.hidden = !destinationVisible;
    if (destinationVisible && snapshot.destination) {
      this.destinationMarker.position.copy(this.toVector(snapshot.destination.position));
      this.destinationMarker.rotation.x += 0.006;
      this.destinationMarker.rotation.y += 0.009;
      this.setLabelMarkup(
        this.destinationLabel,
        `<span>DESTINATION</span><i>${this.escapeMarkup(snapshot.destination.label ?? "world target")}</i>`,
      );
      this.placeLabel(this.destinationLabel, snapshot.destination.position);
    }

    const directionVisible =
      this.config.debug.showTravelDirection &&
      snapshot.travelOrigin !== null &&
      snapshot.travelDirection !== null &&
      this.isFiniteVector(snapshot.travelOrigin) &&
      this.isFiniteVector(snapshot.travelDirection);
    this.setArrow(
      this.travelArrow,
      snapshot.travelOrigin,
      snapshot.travelDirection,
      directionVisible,
      0.62,
    );
  }

  private updateCandidates(snapshot: LocomotionDebugSnapshot): void {
    const showMarkers = this.config.debug.showCandidates;
    const showLabels = this.config.debug.showCandidateScores;
    const required = showMarkers || showLabels ? snapshot.candidates.length : 0;
    this.ensureCandidatePool(required);

    for (let index = 0; index < this.candidateVisuals.length; index += 1) {
      const visual = this.candidateVisuals[index];
      const candidate = snapshot.candidates[index];
      const validPosition = candidate !== undefined && this.isFiniteVector(candidate.worldPosition);
      const markerVisible = showMarkers && validPosition;
      const labelVisible = showLabels && validPosition;
      visual.mesh.visible = markerVisible;
      visual.label.hidden = !labelVisible;
      if (!candidate || !validPosition) {
        continue;
      }

      visual.mesh.position.copy(this.toVector(candidate.worldPosition));
      visual.mesh.material = candidate.isCurrentContact
        ? this.currentMaterial
        : candidate.rejectionReasons.length > 0 || !candidate.score.valid
          ? this.rejectedMaterial
          : this.acceptedMaterial;
      const reason = candidate.rejectionReasons.length > 0
        ? candidate.rejectionReasons.join(", ")
        : candidate.score.valid
          ? "accepted"
          : "invalid score";
      visual.label.className = `spider-debug-label${
        candidate.rejectionReasons.length > 0 || !candidate.score.valid ? " invalid" : ""
      }`;
      this.setLabelMarkup(
        visual.label,
        `<strong>${this.escapeMarkup(candidate.legId)} · ${this.escapeMarkup(candidate.strandId)} @ ${this.format(candidate.t, 3)}</strong>` +
          ` · score ${this.format(candidate.score.total, 3)}` +
          `<br>+${this.format(candidate.score.positive, 3)} / -${this.format(candidate.score.negative, 3)} · ${this.escapeMarkup(candidate.source)}` +
          `<br>${this.escapeMarkup(reason)}`,
      );
      visual.label.title = this.candidateTitle(candidate);
      if (labelVisible) {
        this.placeLabel(visual.label, candidate.worldPosition);
      }
    }
  }

  private updateWinner(snapshot: LocomotionDebugSnapshot): void {
    const winner = snapshot.winner;
    const visible =
      this.config.debug.showWinner &&
      winner !== null &&
      this.isFiniteVector(winner.worldPosition);
    this.winnerGroup.visible = visible;
    this.winnerLabel.hidden = !visible;
    if (!visible || !winner) {
      return;
    }
    this.winnerGroup.position.copy(this.toVector(winner.worldPosition));
    this.winnerGroup.quaternion.copy(this.camera.quaternion);
    this.setLabelMarkup(
      this.winnerLabel,
      `<span>WINNER · ${this.escapeMarkup(winner.legId)}</span>` +
        `<i>${this.escapeMarkup(winner.strandId)} @ ${this.format(winner.t, 3)} · ${this.format(winner.score.total, 3)}</i>`,
    );
    this.placeLabel(this.winnerLabel, winner.worldPosition);
  }

  private updateLegs(snapshot: LocomotionDebugSnapshot): void {
    this.ensureLegPool(snapshot.legs.length);
    for (let index = 0; index < this.legVisuals.length; index += 1) {
      const visual = this.legVisuals[index];
      const leg = snapshot.legs[index];
      const toggleVisible = leg?.eligible
        ? this.config.debug.showEligibleLegs
        : this.config.debug.showRejectedLegs;
      const visible = leg !== undefined && toggleVisible && this.isFiniteVector(leg.position);
      visual.mesh.visible = visible;
      visual.label.hidden = !visible;
      if (!visible || !leg) {
        continue;
      }
      visual.mesh.position.copy(this.toVector(leg.position));
      visual.mesh.quaternion.copy(this.camera.quaternion);
      visual.mesh.material = leg.eligible ? this.eligibleMaterial : this.invalidMaterial;
      visual.label.className = `spider-debug-label${leg.eligible ? "" : " invalid"}`;
      this.setLabelMarkup(
        visual.label,
        `<strong>${this.escapeMarkup(leg.legId)} · ${leg.eligible ? "eligible" : "rejected"}</strong>` +
          `${leg.reasons.length > 0 ? `<br>${this.escapeMarkup(leg.reasons.join(", "))}` : ""}`,
      );
      this.placeLabel(visual.label, leg.position);
    }
  }

  private updateState(snapshot: LocomotionDebugSnapshot): void {
    const hasFailure = snapshot.failureReason !== "none" || snapshot.state === "failed";
    const showState = this.config.debug.showStepState;
    const showFailure = hasFailure && this.config.debug.showFailure;
    this.stateLabel.hidden = !showState;
    this.failureLabel.hidden = !showFailure;
    this.stateLabel.style.transform = "translate3d(46px, 174px, 0)";
    const elapsed = Number.isFinite(snapshot.stateElapsedSeconds)
      ? Math.max(0, snapshot.stateElapsedSeconds)
      : 0;
    if (showState) {
      this.stateLabel.className = "traversal-label locomotion-state-label";
      this.stateLabel.style.borderLeft = "2px solid #70ffbd";
      this.stateLabel.style.color = "#98ffd0";
      this.setLabelMarkup(
        this.stateLabel,
        `<span>STEP · ${this.escapeMarkup(snapshot.state)}</span><i>${elapsed.toFixed(2)}s</i>`,
      );
    }

    if (showFailure) {
      this.failureLabel.style.borderLeft = "2px solid #ff4d89";
      this.failureLabel.style.color = "#ff87a9";
      this.failureLabel.style.transform = `translate3d(46px, ${showState ? 218 : 174}px, 0)`;
      this.setLabelMarkup(
        this.failureLabel,
        `<span>FAILURE</span><i>${this.escapeMarkup(snapshot.failureReason)}${
          snapshot.failureMessage ? ` · ${this.escapeMarkup(snapshot.failureMessage)}` : ""
        }</i>`,
      );
    }
  }

  private updateMovingFoot(snapshot: LocomotionDebugSnapshot): void {
    const moving = snapshot.movingFoot;
    const visible =
      this.config.debug.showMovingFoot &&
      moving !== null &&
      this.isFiniteVector(moving.currentPosition) &&
      this.isFiniteVector(moving.targetPosition);
    this.movingTarget.visible = visible;
    this.movingLine.visible = visible;
    this.movingFootLabel.hidden = !visible;
    if (!visible || !moving) {
      return;
    }
    this.movingTarget.position.copy(this.toVector(moving.targetPosition));
    this.writeSegment(this.movingLinePositions, moving.currentPosition, moving.targetPosition);
    this.movingLineAttribute.needsUpdate = true;
    this.movingLine.computeLineDistances();
    this.setLabelMarkup(
      this.movingFootLabel,
      `<strong>MOVING · ${this.escapeMarkup(moving.legId)}</strong><br>commanded target`,
    );
    this.placeLabel(this.movingFootLabel, moving.targetPosition);
  }

  private updateSwingCurve(points: readonly Vec3Like[]): void {
    const count = this.writePolyline(this.swingPositions, points, MAX_SWING_POINTS);
    const visible = this.config.debug.showSwingCurve && count >= 2;
    this.swingLine.visible = visible;
    this.swingLine.geometry.setDrawRange(0, visible ? count : 0);
    if (visible) {
      this.swingAttribute.needsUpdate = true;
    }
  }

  private updateSupports(snapshot: LocomotionDebugSnapshot): void {
    const showSet = this.config.debug.showSupportSet;
    this.ensureSupportPool(showSet ? snapshot.supports.length : 0);
    for (let index = 0; index < this.supportVisuals.length; index += 1) {
      const visual = this.supportVisuals[index];
      const support = snapshot.supports[index];
      const visible = showSet && support !== undefined && this.isFiniteVector(support.position);
      visual.mesh.visible = visible;
      visual.label.hidden = !visible;
      if (!visible || !support) {
        continue;
      }
      visual.mesh.position.copy(this.toVector(support.position));
      visual.mesh.material = !support.valid
        ? this.invalidMaterial
        : support.loaded
          ? this.eligibleMaterial
          : this.warningMaterial;
      visual.label.className = `spider-debug-label${!support.valid ? " invalid" : ""}`;
      this.setLabelMarkup(
        visual.label,
        `<strong>SUPPORT · ${this.escapeMarkup(support.legId)}</strong><br>${
          !support.valid ? "invalid" : support.loaded ? "loaded" : "unloaded"
        }`,
      );
      this.placeLabel(visual.label, support.position);
    }

    const centerVisible =
      (showSet || this.config.debug.showSupportPolygon) &&
      snapshot.supportCenter !== null &&
      this.isFiniteVector(snapshot.supportCenter);
    this.supportCenterMarker.visible = centerVisible;
    if (centerVisible && snapshot.supportCenter) {
      this.supportCenterMarker.position.copy(this.toVector(snapshot.supportCenter));
    }

    const polygonCount = this.writePolyline(
      this.supportPolygonPositions,
      snapshot.supportPolygon,
      MAX_SUPPORT_POLYGON_POINTS,
    );
    const polygonVisible = this.config.debug.showSupportPolygon && polygonCount >= 3;
    this.supportPolygonLine.visible = polygonVisible;
    this.supportPolygonLine.geometry.setDrawRange(0, polygonVisible ? polygonCount : 0);
    if (polygonVisible) {
      this.supportPolygonAttribute.needsUpdate = true;
    }
  }

  private updateProbe(probe: LocomotionDebugProbe | null): void {
    const visible =
      this.config.debug.showProbeForce &&
      probe !== null &&
      this.isFiniteVector(probe.origin) &&
      this.isFiniteVector(probe.force);
    const magnitude = probe ? this.vectorLength(probe.force) : 0;
    this.setArrow(
      this.probeArrow,
      probe?.origin ?? null,
      probe?.force ?? null,
      visible && magnitude > 1e-8,
      Math.min(0.5, 0.1 + magnitude * 0.8),
    );
    this.probeLabel.hidden = !(visible && magnitude > 1e-8);
    if (!visible || !probe || magnitude <= 1e-8) {
      return;
    }
    this.setLabelMarkup(
      this.probeLabel,
      `<strong>PROBE FORCE</strong><br>${this.format(magnitude, 3)} N`,
    );
    this.placeLabel(this.probeLabel, probe.origin);
  }

  private updateLoadTransfer(load: LocomotionDebugLoadTransfer | null): void {
    const visible =
      this.config.debug.showLoadTransfer &&
      load !== null &&
      this.isFiniteVector(load.position) &&
      Number.isFinite(load.factor);
    this.loadTransferMarker.visible = visible;
    this.loadTransferLabel.hidden = !visible;
    if (!visible || !load) {
      return;
    }
    const factor = THREE.MathUtils.clamp(load.factor, 0, 1);
    this.loadTransferMarker.position.copy(this.toVector(load.position));
    this.loadTransferMarker.quaternion.copy(this.camera.quaternion);
    this.loadTransferMarker.scale.setScalar(0.7 + factor * 0.55);
    this.setLabelMarkup(
      this.loadTransferLabel,
      `<strong>LOAD · ${this.escapeMarkup(load.legId)}</strong><br>${Math.round(factor * 100)}%`,
    );
    this.placeLabel(this.loadTransferLabel, load.position);
  }

  private updateBodyAdvance(advance: LocomotionDebugBodyAdvance | null): void {
    const visible =
      this.config.debug.showBodyAdvance &&
      advance !== null &&
      this.isFiniteVector(advance.origin) &&
      this.isFiniteVector(advance.vector);
    const magnitude = advance ? this.vectorLength(advance.vector) : 0;
    this.setArrow(
      this.bodyAdvanceArrow,
      advance?.origin ?? null,
      advance?.vector ?? null,
      visible && magnitude > 1e-8,
      Math.max(0.12, magnitude),
    );
    this.bodyAdvanceLabel.hidden = !(visible && magnitude > 1e-8);
    if (!visible || !advance || magnitude <= 1e-8) {
      return;
    }
    this.setLabelMarkup(
      this.bodyAdvanceLabel,
      `<strong>BODY ADVANCE</strong><br>${this.format(magnitude, 3)} u`,
    );
    const end = this.projection.set(
      advance.origin.x + advance.vector.x,
      advance.origin.y + advance.vector.y,
      advance.origin.z + advance.vector.z,
    );
    this.placeLabel(this.bodyAdvanceLabel, end);
  }

  private ensureCandidatePool(count: number): void {
    while (this.candidateVisuals.length < count) {
      const mesh = new THREE.Mesh(this.candidateGeometry, this.acceptedMaterial);
      mesh.renderOrder = 92;
      this.group.add(mesh);
      this.candidateVisuals.push({
        mesh,
        label: this.createLabel("spider-debug-label"),
      });
    }
  }

  private ensureLegPool(count: number): void {
    while (this.legVisuals.length < count) {
      const mesh = new THREE.Mesh(this.legGeometry, this.eligibleMaterial);
      mesh.renderOrder = 91;
      this.group.add(mesh);
      this.legVisuals.push({
        mesh,
        label: this.createLabel("spider-debug-label"),
      });
    }
  }

  private ensureSupportPool(count: number): void {
    while (this.supportVisuals.length < count) {
      const mesh = new THREE.Mesh(this.supportGeometry, this.eligibleMaterial);
      mesh.renderOrder = 90;
      this.group.add(mesh);
      this.supportVisuals.push({
        mesh,
        label: this.createLabel("spider-debug-label"),
      });
    }
  }

  private createLabel(className: string): HTMLDivElement {
    const label = document.createElement("div");
    label.className = className;
    label.hidden = true;
    this.labelLayer.append(label);
    this.labels.push(label);
    return label;
  }

  private createMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({
      color,
      transparent: opacity < 1,
      opacity,
      depthTest: false,
      depthWrite: false,
    });
  }

  private createArrow(color: number): THREE.ArrowHelper {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(),
      0.4,
      color,
      0.08,
      0.045,
    );
    (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
    (arrow.line.material as THREE.LineBasicMaterial).depthWrite = false;
    (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    (arrow.cone.material as THREE.MeshBasicMaterial).depthWrite = false;
    arrow.visible = false;
    return arrow;
  }

  private setArrow(
    arrow: THREE.ArrowHelper,
    origin: Vec3Like | null,
    vector: Vec3Like | null,
    visible: boolean,
    length: number,
  ): void {
    arrow.visible = visible;
    if (!visible || !origin || !vector) {
      return;
    }
    this.direction.set(vector.x, vector.y, vector.z);
    const magnitude = this.direction.length();
    if (!Number.isFinite(magnitude) || magnitude <= 1e-10) {
      arrow.visible = false;
      return;
    }
    this.direction.multiplyScalar(1 / magnitude);
    arrow.position.set(origin.x, origin.y, origin.z);
    arrow.setDirection(this.direction);
    arrow.setLength(length, Math.min(0.09, length * 0.28), Math.min(0.05, length * 0.17));
  }

  private writeSegment(target: Float32Array, start: Vec3Like, end: Vec3Like): void {
    target[0] = start.x;
    target[1] = start.y;
    target[2] = start.z;
    target[3] = end.x;
    target[4] = end.y;
    target[5] = end.z;
  }

  private writePolyline(
    target: Float32Array,
    points: readonly Vec3Like[],
    capacity: number,
  ): number {
    const finitePoints = points.filter((point) => this.isFiniteVector(point));
    const count = Math.min(capacity, finitePoints.length);
    for (let index = 0; index < count; index += 1) {
      const sourceIndex = count === finitePoints.length
        ? index
        : Math.round((index / Math.max(1, count - 1)) * (finitePoints.length - 1));
      const point = finitePoints[sourceIndex];
      const offset = index * 3;
      target[offset] = point.x;
      target[offset + 1] = point.y;
      target[offset + 2] = point.z;
    }
    return count;
  }

  private setLabelMarkup(label: HTMLDivElement, markup: string): void {
    if (this.labelMarkup.get(label) === markup) {
      return;
    }
    label.innerHTML = markup;
    this.labelMarkup.set(label, markup);
  }

  private placeLabel(label: HTMLElement, point: Vec3Like): void {
    this.projection.set(point.x, point.y, point.z).project(this.camera);
    const x = Math.max(
      8,
      Math.min(
        Math.max(8, this.canvas.clientWidth - 230),
        (this.projection.x * 0.5 + 0.5) * this.canvas.clientWidth,
      ),
    );
    const y = Math.max(
      32,
      Math.min(
        Math.max(32, this.canvas.clientHeight - 46),
        (-this.projection.y * 0.5 + 0.5) * this.canvas.clientHeight,
      ),
    );
    label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  private toVector(value: Vec3Like): THREE.Vector3 {
    return this.projection.set(value.x, value.y, value.z);
  }

  private isFiniteVector(value: Vec3Like): boolean {
    return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
  }

  private vectorLength(value: Vec3Like): number {
    return Math.hypot(value.x, value.y, value.z);
  }

  private format(value: number, digits: number): string {
    return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
  }

  private candidateTitle(candidate: FootholdCandidate): string {
    const components = Object.entries(candidate.score.components)
      .map(
        ([name, component]) =>
          `${name}: ${this.format(component.value, 3)} × ${this.format(component.weight, 3)} = ${this.format(component.contribution, 3)}`,
      )
      .join("\n");
    const rejection = candidate.rejectionDetails.length > 0
      ? `\nRejected: ${candidate.rejectionDetails.join("; ")}`
      : "";
    return `${candidate.legId} · ${candidate.strandId} @ ${this.format(candidate.t, 3)}\n${components}${rejection}`;
  }

  private escapeMarkup(value: string): string {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
}
