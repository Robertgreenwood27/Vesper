import * as THREE from "three";
import type {
  PlannedRoute,
  RouteTransition,
  StrandAddress,
  StrandTraversal,
  Vec3Like,
} from "../traversal";
import type { SpiderLegId } from "../spider/SpiderRigSpec";

export interface JunctionTraversalDebugToggles {
  showFullRoute: boolean;
  showCurrentRoute: boolean;
  showNextTransition: boolean;
  showDestinationBranch: boolean;
  showStepHistory: boolean;
  showContactSides: boolean;
  showCommitment: boolean;
  showBodyFrames: boolean;
  showRotationArc: boolean;
  showPredictedReach: boolean;
  showExploration: boolean;
  showRecovery: boolean;
  showBodyProgress: boolean;
  showStopReason: boolean;
}

export function createJunctionTraversalDebugToggles(): JunctionTraversalDebugToggles {
  return {
    showFullRoute: true,
    showCurrentRoute: true,
    showNextTransition: true,
    showDestinationBranch: true,
    showStepHistory: true,
    showContactSides: true,
    showCommitment: true,
    showBodyFrames: true,
    showRotationArc: true,
    showPredictedReach: false,
    showExploration: true,
    showRecovery: true,
    showBodyProgress: true,
    showStopReason: true,
  };
}

export interface JunctionDebugFrame {
  readonly position: Vec3Like;
  readonly forward: Vec3Like;
  readonly up: Vec3Like;
  readonly right: Vec3Like;
}

export interface JunctionDebugContact {
  readonly legId: SpiderLegId;
  readonly position: Vec3Like;
  readonly side: "approach" | "junction" | "destination" | "off-route";
  readonly loaded: boolean;
}

export interface JunctionDebugReach {
  readonly legId: SpiderLegId;
  readonly origin: Vec3Like;
  readonly contact: Vec3Like;
  readonly ratio: number;
  readonly withinLimits: boolean;
}

export interface JunctionDebugCandidate {
  readonly position: Vec3Like;
  readonly accepted: boolean;
  readonly label?: string;
}

export interface JunctionTraversalDebugSnapshot {
  readonly fullRoute: PlannedRoute | null;
  readonly currentRoute: PlannedRoute | null;
  readonly nextTransition: RouteTransition | null;
  readonly junctionPosition: Vec3Like | null;
  readonly destinationBranchStrandId: string | null;
  readonly stepNumber: number;
  readonly state: string;
  readonly movedLegHistory: readonly SpiderLegId[];
  readonly contacts: readonly JunctionDebugContact[];
  readonly destinationSideCount: number;
  readonly destinationSideRequired: number;
  readonly mayCommitBody: boolean;
  readonly proposedBodyFrame: JunctionDebugFrame | null;
  readonly acceptedBodyFrame: JunctionDebugFrame | null;
  readonly predictedReaches: readonly JunctionDebugReach[];
  readonly explorationCandidates: readonly JunctionDebugCandidate[];
  readonly recoveryCandidates: readonly JunctionDebugCandidate[];
  readonly bodyPosition: Vec3Like | null;
  readonly bodyCenterProgress: number;
  readonly stopReason: string;
  readonly stopMessage: string;
}

const MAX_ROUTE_POINTS = 512;
const MAX_CANDIDATES = 24;
const FRAME_AXIS_LENGTH = 0.36;

interface RouteLine {
  readonly line: THREE.Line;
  readonly positions: Float32Array;
  readonly attribute: THREE.BufferAttribute;
}

function routeLine(color: number, opacity: number): RouteLine {
  const positions = new Float32Array(MAX_ROUTE_POINTS * 3);
  const attribute = new THREE.BufferAttribute(positions, 3);
  attribute.setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", attribute);
  geometry.setDrawRange(0, 0);
  const line = new THREE.Line(
    geometry,
    new THREE.LineBasicMaterial({ color, opacity, transparent: true, depthTest: false }),
  );
  line.renderOrder = 20;
  return { line, positions, attribute };
}

function arrow(color: number, opacity = 1): THREE.ArrowHelper {
  const helper = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    FRAME_AXIS_LENGTH,
    color,
    0.09,
    0.045,
  );
  const materials = [
    helper.line.material as THREE.Material,
    helper.cone.material as THREE.Material,
  ];
  for (const material of materials) {
    material.transparent = opacity < 1;
    material.opacity = opacity;
    material.depthTest = false;
  }
  helper.renderOrder = 22;
  return helper;
}

/**
 * Allocation-stable, Phase 8-only overlays. It consumes semantic routes,
 * contact classifications, and policy diagnostics; it never inspects a
 * simulation particle as a navigation vertex.
 */
export class JunctionTraversalDebugRenderer {
  private traversal: StrandTraversal | null = null;
  private readonly group = new THREE.Group();
  private readonly fullRoute = routeLine(0xffc85c, 0.5);
  private readonly currentRoute = routeLine(0x5be4ff, 0.98);
  private readonly destinationBranch = routeLine(0xc275ff, 0.95);
  private readonly transitionArrow = arrow(0xff6f9e);
  private readonly branchArrow = arrow(0xc275ff);
  private readonly contactMarkers: THREE.Mesh[] = [];
  private readonly reachLines: THREE.Line[] = [];
  private readonly explorationMarkers: THREE.Mesh[] = [];
  private readonly recoveryMarkers: THREE.Mesh[] = [];
  private readonly commitmentRing: THREE.Mesh;
  private readonly bodyMarker: THREE.Mesh;
  private readonly progressLine: THREE.Line;
  private readonly progressPositions = new Float32Array(6);
  private readonly progressAttribute: THREE.BufferAttribute;
  private readonly rotationArc: THREE.Line;
  private readonly rotationPositions = new Float32Array(25 * 3);
  private readonly rotationAttribute: THREE.BufferAttribute;
  private readonly proposedAxes = [arrow(0x65e5ff, 0.48), arrow(0xffc85c, 0.48), arrow(0xff6f9e, 0.48)];
  private readonly acceptedAxes = [arrow(0x65e5ff), arrow(0xffc85c), arrow(0xff6f9e)];
  private readonly hud: HTMLDivElement;
  private readonly scratchPosition: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 };
  private readonly scratchDirection = new THREE.Vector3();
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchC = new THREE.Vector3();
  private readonly routeAddress: StrandAddress = { strandId: "", t: 0 };

  constructor(
    scene: THREE.Scene,
    labelLayer: HTMLElement,
    readonly toggles: JunctionTraversalDebugToggles,
  ) {
    this.commitmentRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.49, 0.018, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0xffc85c, transparent: true, opacity: 0.72, depthTest: false }),
    );
    this.bodyMarker = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xeafcff, wireframe: true, depthTest: false }),
    );

    this.progressAttribute = new THREE.BufferAttribute(this.progressPositions, 3);
    this.progressAttribute.setUsage(THREE.DynamicDrawUsage);
    const progressGeometry = new THREE.BufferGeometry();
    progressGeometry.setAttribute("position", this.progressAttribute);
    this.progressLine = new THREE.Line(
      progressGeometry,
      new THREE.LineDashedMaterial({
        color: 0xeafcff,
        dashSize: 0.07,
        gapSize: 0.05,
        transparent: true,
        opacity: 0.7,
        depthTest: false,
      }),
    );

    this.rotationAttribute = new THREE.BufferAttribute(this.rotationPositions, 3);
    this.rotationAttribute.setUsage(THREE.DynamicDrawUsage);
    const rotationGeometry = new THREE.BufferGeometry();
    rotationGeometry.setAttribute("position", this.rotationAttribute);
    this.rotationArc = new THREE.Line(
      rotationGeometry,
      new THREE.LineBasicMaterial({ color: 0xc275ff, transparent: true, opacity: 0.86, depthTest: false }),
    );
    this.rotationArc.geometry.setDrawRange(0, 0);

    const markerGeometry = new THREE.SphereGeometry(0.055, 10, 7);
    for (let index = 0; index < 8; index += 1) {
      const marker = new THREE.Mesh(
        markerGeometry,
        new THREE.MeshBasicMaterial({ color: 0x667680, depthTest: false }),
      );
      this.contactMarkers.push(marker);
      const positions = new Float32Array(6);
      const attribute = new THREE.BufferAttribute(positions, 3);
      attribute.setUsage(THREE.DynamicDrawUsage);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", attribute);
      const line = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x72d8ff, transparent: true, opacity: 0.45, depthTest: false }),
      );
      line.userData.positionBuffer = positions;
      line.userData.positionAttribute = attribute;
      this.reachLines.push(line);
    }

    const candidateGeometry = new THREE.OctahedronGeometry(0.045, 0);
    for (let index = 0; index < MAX_CANDIDATES; index += 1) {
      this.explorationMarkers.push(new THREE.Mesh(
        candidateGeometry,
        new THREE.MeshBasicMaterial({ color: 0x54eeb0, wireframe: true, depthTest: false }),
      ));
      this.recoveryMarkers.push(new THREE.Mesh(
        candidateGeometry,
        new THREE.MeshBasicMaterial({ color: 0xff8a5f, wireframe: true, depthTest: false }),
      ));
    }

    this.group.add(
      this.fullRoute.line,
      this.currentRoute.line,
      this.destinationBranch.line,
      this.transitionArrow,
      this.branchArrow,
      this.commitmentRing,
      this.bodyMarker,
      this.progressLine,
      this.rotationArc,
      ...this.proposedAxes,
      ...this.acceptedAxes,
      ...this.contactMarkers,
      ...this.reachLines,
      ...this.explorationMarkers,
      ...this.recoveryMarkers,
    );
    scene.add(this.group);

    this.hud = document.createElement("div");
    this.hud.className = "junction-traversal-hud";
    this.hud.hidden = true;
    labelLayer.append(this.hud);
  }

  setTraversal(traversal: StrandTraversal): void {
    this.traversal = traversal;
  }

  update(snapshot: JunctionTraversalDebugSnapshot): void {
    this.writeRoute(this.fullRoute, snapshot.fullRoute, this.toggles.showFullRoute);
    this.writeRoute(this.currentRoute, snapshot.currentRoute, this.toggles.showCurrentRoute);
    this.updateTransition(snapshot);
    this.updateDestinationBranch(snapshot);
    this.updateContacts(snapshot.contacts);
    this.updateCommitment(snapshot);
    this.updateFrames(snapshot.proposedBodyFrame, snapshot.acceptedBodyFrame);
    this.updateRotationArc(snapshot.proposedBodyFrame, snapshot.acceptedBodyFrame);
    this.updateReaches(snapshot.predictedReaches);
    this.updateCandidates(this.explorationMarkers, snapshot.explorationCandidates, this.toggles.showExploration);
    this.updateCandidates(this.recoveryMarkers, snapshot.recoveryCandidates, this.toggles.showRecovery);
    this.updateBodyProgress(snapshot);
    this.updateHud(snapshot);
  }

  private writeRoute(target: RouteLine, route: PlannedRoute | null, visible: boolean): void {
    target.line.visible = visible && Boolean(route && this.traversal);
    target.line.geometry.setDrawRange(0, 0);
    if (!target.line.visible || !route || !this.traversal) return;
    let count = 0;
    for (const leg of route.legs) {
      const samples = Math.max(2, Math.ceil(Math.abs(leg.toT - leg.fromT) * 30) + 1);
      for (let index = 0; index < samples && count < MAX_ROUTE_POINTS; index += 1) {
        if (count > 0 && index === 0) continue;
        const alpha = index / (samples - 1);
        (this.routeAddress as { strandId: string; t: number }).strandId = leg.strandId;
        (this.routeAddress as { strandId: string; t: number }).t = leg.fromT + (leg.toT - leg.fromT) * alpha;
        try {
          this.traversal.getWorldPosition(this.routeAddress, this.scratchPosition);
        } catch {
          continue;
        }
        const offset = count * 3;
        target.positions[offset] = this.scratchPosition.x;
        target.positions[offset + 1] = this.scratchPosition.y;
        target.positions[offset + 2] = this.scratchPosition.z;
        count += 1;
      }
    }
    target.line.geometry.setDrawRange(0, count);
    target.attribute.needsUpdate = true;
  }

  private updateTransition(snapshot: JunctionTraversalDebugSnapshot): void {
    const visible = this.toggles.showNextTransition && Boolean(
      snapshot.nextTransition && snapshot.junctionPosition && this.traversal,
    );
    this.transitionArrow.visible = visible;
    if (!visible || !snapshot.nextTransition || !snapshot.junctionPosition || !this.traversal) return;
    const transition = snapshot.nextTransition;
    const strand = this.traversal.getStrand(transition.toStrandId);
    if (!strand) {
      this.transitionArrow.visible = false;
      return;
    }
    const leavesStart = strand.startNode.id === transition.nodeId;
    try {
      this.traversal.getWorldPosition(
        { strandId: strand.id, t: leavesStart ? 0.12 : 0.88 },
        this.scratchPosition,
      );
    } catch {
      this.transitionArrow.visible = false;
      return;
    }
    this.setArrow(this.transitionArrow, snapshot.junctionPosition, {
      x: this.scratchPosition.x - snapshot.junctionPosition.x,
      y: this.scratchPosition.y - snapshot.junctionPosition.y,
      z: this.scratchPosition.z - snapshot.junctionPosition.z,
    }, 0.55);
  }

  private updateDestinationBranch(snapshot: JunctionTraversalDebugSnapshot): void {
    const route = snapshot.fullRoute;
    const strandId = snapshot.destinationBranchStrandId;
    const branchRoute = route && strandId
      ? { ...route, legs: route.legs.filter((leg) => leg.strandId === strandId) }
      : null;
    this.writeRoute(this.destinationBranch, branchRoute, this.toggles.showDestinationBranch);
    this.branchArrow.visible = false;
    if (!this.toggles.showDestinationBranch || !strandId || !snapshot.junctionPosition || !this.traversal) return;
    const strand = this.traversal.getStrand(strandId);
    if (!strand) return;
    const leavesStart = strand.startNode.id === snapshot.nextTransition?.nodeId;
    try {
      this.traversal.getWorldPosition({ strandId, t: leavesStart ? 0.2 : 0.8 }, this.scratchPosition);
    } catch {
      return;
    }
    this.branchArrow.visible = true;
    this.setArrow(this.branchArrow, snapshot.junctionPosition, {
      x: this.scratchPosition.x - snapshot.junctionPosition.x,
      y: this.scratchPosition.y - snapshot.junctionPosition.y,
      z: this.scratchPosition.z - snapshot.junctionPosition.z,
    }, 0.7);
  }

  private updateContacts(contacts: readonly JunctionDebugContact[]): void {
    for (let index = 0; index < this.contactMarkers.length; index += 1) {
      const marker = this.contactMarkers[index];
      const contact = contacts[index];
      marker.visible = this.toggles.showContactSides && Boolean(contact);
      if (!marker.visible || !contact) continue;
      marker.position.set(contact.position.x, contact.position.y, contact.position.z);
      const material = marker.material as THREE.MeshBasicMaterial;
      material.color.setHex(contact.side === "destination"
        ? 0x54eeb0
        : contact.side === "approach"
          ? 0xff8a5f
          : contact.side === "junction"
            ? 0xffc85c
            : 0x62727c);
      material.wireframe = !contact.loaded;
    }
  }

  private updateCommitment(snapshot: JunctionTraversalDebugSnapshot): void {
    const visible = this.toggles.showCommitment && Boolean(snapshot.junctionPosition);
    this.commitmentRing.visible = visible;
    if (!visible || !snapshot.junctionPosition) return;
    this.commitmentRing.position.set(
      snapshot.junctionPosition.x,
      snapshot.junctionPosition.y,
      snapshot.junctionPosition.z,
    );
    const material = this.commitmentRing.material as THREE.MeshBasicMaterial;
    material.color.setHex(snapshot.mayCommitBody ? 0x54eeb0 : 0xffc85c);
    material.opacity = 0.35 + 0.55 * Math.min(
      1,
      snapshot.destinationSideCount / Math.max(1, snapshot.destinationSideRequired),
    );
  }

  private updateFrames(proposed: JunctionDebugFrame | null, accepted: JunctionDebugFrame | null): void {
    this.setFrameAxes(this.proposedAxes, proposed, this.toggles.showBodyFrames);
    this.setFrameAxes(this.acceptedAxes, accepted, this.toggles.showBodyFrames);
  }

  private setFrameAxes(axes: readonly THREE.ArrowHelper[], frame: JunctionDebugFrame | null, visible: boolean): void {
    const vectors = frame ? [frame.forward, frame.up, frame.right] : [];
    for (let index = 0; index < axes.length; index += 1) {
      axes[index].visible = visible && Boolean(frame);
      if (visible && frame) this.setArrow(axes[index], frame.position, vectors[index], FRAME_AXIS_LENGTH);
    }
  }

  private updateRotationArc(proposed: JunctionDebugFrame | null, accepted: JunctionDebugFrame | null): void {
    const visible = this.toggles.showRotationArc && Boolean(proposed && accepted);
    this.rotationArc.visible = visible;
    this.rotationArc.geometry.setDrawRange(0, 0);
    if (!visible || !proposed || !accepted) return;
    const center = this.scratchA.set(
      accepted.position.x,
      accepted.position.y,
      accepted.position.z,
    );
    const from = this.scratchB.set(
      accepted.forward.x,
      accepted.forward.y,
      accepted.forward.z,
    ).normalize();
    const to = this.scratchC.set(
      proposed.forward.x,
      proposed.forward.y,
      proposed.forward.z,
    ).normalize();
    for (let index = 0; index < 25; index += 1) {
      const alpha = index / 24;
      this.scratchDirection.copy(from).lerp(to, alpha);
      if (this.scratchDirection.lengthSq() < 1e-8) this.scratchDirection.copy(from);
      this.scratchDirection.normalize().multiplyScalar(0.46).add(center);
      const offset = index * 3;
      this.rotationPositions[offset] = this.scratchDirection.x;
      this.rotationPositions[offset + 1] = this.scratchDirection.y;
      this.rotationPositions[offset + 2] = this.scratchDirection.z;
    }
    this.rotationArc.geometry.setDrawRange(0, 25);
    this.rotationAttribute.needsUpdate = true;
  }

  private updateReaches(reaches: readonly JunctionDebugReach[]): void {
    for (let index = 0; index < this.reachLines.length; index += 1) {
      const line = this.reachLines[index];
      const reach = reaches[index];
      line.visible = this.toggles.showPredictedReach && Boolean(reach);
      if (!line.visible || !reach) continue;
      const positions = line.userData.positionBuffer as Float32Array;
      positions.set([
        reach.origin.x, reach.origin.y, reach.origin.z,
        reach.contact.x, reach.contact.y, reach.contact.z,
      ]);
      (line.userData.positionAttribute as THREE.BufferAttribute).needsUpdate = true;
      const material = line.material as THREE.LineBasicMaterial;
      material.color.setHex(reach.withinLimits ? 0x72d8ff : 0xff5e75);
      material.opacity = Math.max(0.25, Math.min(1, reach.ratio));
    }
  }

  private updateCandidates(
    markers: readonly THREE.Mesh[],
    candidates: readonly JunctionDebugCandidate[],
    visible: boolean,
  ): void {
    for (let index = 0; index < markers.length; index += 1) {
      const marker = markers[index];
      const candidate = candidates[index];
      marker.visible = visible && Boolean(candidate);
      if (!marker.visible || !candidate) continue;
      marker.position.set(candidate.position.x, candidate.position.y, candidate.position.z);
      const material = marker.material as THREE.MeshBasicMaterial;
      material.color.setHex(candidate.accepted ? 0x54eeb0 : 0xff5e75);
      marker.scale.setScalar(candidate.accepted ? 1.35 : 0.8);
    }
  }

  private updateBodyProgress(snapshot: JunctionTraversalDebugSnapshot): void {
    const visible = this.toggles.showBodyProgress && Boolean(
      snapshot.bodyPosition && snapshot.junctionPosition,
    );
    this.bodyMarker.visible = visible;
    this.progressLine.visible = visible;
    if (!visible || !snapshot.bodyPosition || !snapshot.junctionPosition) return;
    this.bodyMarker.position.set(
      snapshot.bodyPosition.x,
      snapshot.bodyPosition.y,
      snapshot.bodyPosition.z,
    );
    this.progressPositions.set([
      snapshot.junctionPosition.x,
      snapshot.junctionPosition.y,
      snapshot.junctionPosition.z,
      snapshot.bodyPosition.x,
      snapshot.bodyPosition.y,
      snapshot.bodyPosition.z,
    ]);
    this.progressAttribute.needsUpdate = true;
    this.progressLine.computeLineDistances();
    const material = this.bodyMarker.material as THREE.MeshBasicMaterial;
    material.color.setHex(snapshot.bodyCenterProgress >= 1 ? 0x54eeb0 : 0xeafcff);
  }

  private updateHud(snapshot: JunctionTraversalDebugSnapshot): void {
    const visible = this.toggles.showStepHistory || (
      this.toggles.showStopReason && snapshot.stopReason !== "none"
    );
    this.hud.hidden = !visible;
    if (!visible) return;
    const history = snapshot.movedLegHistory.length > 0
      ? snapshot.movedLegHistory.join(" → ")
      : "none";
    const stop = snapshot.stopReason === "none"
      ? "ACTIVE"
      : `${snapshot.stopReason}${snapshot.stopMessage ? ` / ${snapshot.stopMessage}` : ""}`;
    this.hud.innerHTML =
      `<span>STEP ${snapshot.stepNumber} · ${snapshot.state}</span>` +
      `<i>${snapshot.destinationSideCount}/${snapshot.destinationSideRequired} destination supports · ${history}</i>` +
      `<b>${stop}</b>`;
  }

  private setArrow(helper: THREE.ArrowHelper, origin: Vec3Like, direction: Vec3Like, length: number): void {
    this.scratchDirection.set(direction.x, direction.y, direction.z);
    if (this.scratchDirection.lengthSq() < 1e-10) {
      helper.visible = false;
      return;
    }
    helper.position.set(origin.x, origin.y, origin.z);
    helper.setDirection(this.scratchDirection.normalize());
    helper.setLength(length, Math.min(0.1, length * 0.24), Math.min(0.055, length * 0.13));
  }
}
