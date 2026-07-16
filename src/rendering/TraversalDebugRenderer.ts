import * as THREE from "three";
import type { LabConfig } from "../config";
import type {
  ClosestPointResult,
  ContactFrame,
  MutableVec3,
  PlannedRoute,
  StrandAddress,
  Vec3Like,
} from "../traversal";
import type { StrandTraversal } from "../traversal";
import type { PhaseFiveWeb } from "../web/createPhaseFiveNetwork";

export interface TraversalDebugSnapshot {
  queryTarget: Vec3Like;
  queryResult: ClosestPointResult | null;
  frameAddress: StrandAddress | null;
  framePosition: Vec3Like | null;
  frame: ContactFrame | null;
  localVelocity: Vec3Like;
  localTension: number;
  contactAddress: StrandAddress | null;
  contactPosition: Vec3Like | null;
  contactForce: Vec3Like;
  route: PlannedRoute | null;
}

const MAX_ROUTE_POINTS = 640;

/** Three.js-only diagnostics for the renderer-independent traversal services. */
export class TraversalDebugRenderer {
  private course: PhaseFiveWeb | null = null;
  private traversal: StrandTraversal | null = null;
  private readonly group = new THREE.Group();
  private readonly queryTarget: THREE.Mesh;
  private readonly queryPoint: THREE.Mesh;
  private readonly contactGroup = new THREE.Group();
  private readonly connectedJunctionGroup = new THREE.Group();
  private readonly crossingPointA: THREE.Mesh;
  private readonly crossingPointB: THREE.Mesh;
  private readonly queryLinePositions = new Float32Array(6);
  private readonly queryLineAttribute = new THREE.BufferAttribute(this.queryLinePositions, 3);
  private readonly queryLine: THREE.Line;
  private readonly crossingLinePositions = new Float32Array(6);
  private readonly crossingLineAttribute = new THREE.BufferAttribute(this.crossingLinePositions, 3);
  private readonly crossingLine: THREE.Line;
  private readonly routePositions = new Float32Array(MAX_ROUTE_POINTS * 3);
  private readonly routeAttribute = new THREE.BufferAttribute(this.routePositions, 3);
  private readonly routeLine: THREE.Line;
  private readonly tangentArrow = new THREE.ArrowHelper(
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(),
    0.7,
    0x57d9ff,
    0.12,
    0.07,
  );
  private readonly normalArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(),
    0.7,
    0xffbd4a,
    0.12,
    0.07,
  );
  private readonly binormalArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 0, 1),
    new THREE.Vector3(),
    0.7,
    0xff4d89,
    0.12,
    0.07,
  );
  private readonly velocityArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(),
    0.4,
    0x70ffbd,
    0.1,
    0.055,
  );
  private readonly contactForceArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0),
    new THREE.Vector3(),
    0.5,
    0xff5a71,
    0.11,
    0.06,
  );

  private readonly queryLabel: HTMLDivElement;
  private readonly contactLabel: HTMLDivElement;
  private readonly routeLabel: HTMLDivElement;
  private readonly crossingLabel: HTMLDivElement;
  private readonly labelMarkup = new Map<HTMLDivElement, string>();
  private readonly projection = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();
  private readonly scratchA: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly scratchB: MutableVec3 = { x: 0, y: 0, z: 0 };
  private readonly routeAddress: { strandId: string; t: number } = { strandId: "", t: 0 };

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    labelLayer: HTMLElement,
    private readonly config: LabConfig,
  ) {
    const queryTargetMaterial = new THREE.MeshBasicMaterial({
      color: 0x57d9ff,
      wireframe: true,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
    });
    this.queryTarget = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), queryTargetMaterial);
    this.queryPoint = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xe9fbff, depthTest: false }),
    );
    this.crossingPointA = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.1, 0),
      new THREE.MeshBasicMaterial({ color: 0xff4d89, depthTest: false }),
    );
    this.crossingPointB = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.1, 0),
      new THREE.MeshBasicMaterial({ color: 0x57d9ff, depthTest: false }),
    );

    const contactRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.13, 0.022, 8, 30),
      new THREE.MeshBasicMaterial({ color: 0xffbd4a, depthTest: false }),
    );
    const contactCore = new THREE.Mesh(
      new THREE.SphereGeometry(0.052, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }),
    );
    this.contactGroup.add(contactRing, contactCore);

    const connectedRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.27, 0.025, 8, 36),
      new THREE.MeshBasicMaterial({ color: 0x70ffbd, depthTest: false }),
    );
    const connectedCore = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.095, 0),
      new THREE.MeshBasicMaterial({ color: 0x70ffbd, depthTest: false }),
    );
    this.connectedJunctionGroup.add(connectedRing, connectedCore);

    this.queryLineAttribute.setUsage(THREE.DynamicDrawUsage);
    const queryGeometry = new THREE.BufferGeometry();
    queryGeometry.setAttribute("position", this.queryLineAttribute);
    this.queryLine = new THREE.Line(
      queryGeometry,
      new THREE.LineDashedMaterial({
        color: 0x57d9ff,
        dashSize: 0.12,
        gapSize: 0.08,
        transparent: true,
        opacity: 0.8,
        depthTest: false,
      }),
    );
    this.queryLine.computeLineDistances();

    this.crossingLineAttribute.setUsage(THREE.DynamicDrawUsage);
    const crossingGeometry = new THREE.BufferGeometry();
    crossingGeometry.setAttribute("position", this.crossingLineAttribute);
    this.crossingLine = new THREE.Line(
      crossingGeometry,
      new THREE.LineDashedMaterial({
        color: 0xff4d89,
        dashSize: 0.09,
        gapSize: 0.08,
        transparent: true,
        opacity: 0.76,
        depthTest: false,
      }),
    );
    this.crossingLine.computeLineDistances();

    this.routeAttribute.setUsage(THREE.DynamicDrawUsage);
    const routeGeometry = new THREE.BufferGeometry();
    routeGeometry.setAttribute("position", this.routeAttribute);
    routeGeometry.setDrawRange(0, 0);
    this.routeLine = new THREE.Line(
      routeGeometry,
      new THREE.LineBasicMaterial({
        color: 0xffbd4a,
        transparent: true,
        opacity: 0.96,
        depthTest: false,
      }),
    );

    this.group.add(
      this.queryTarget,
      this.queryPoint,
      this.queryLine,
      this.contactGroup,
      this.connectedJunctionGroup,
      this.crossingPointA,
      this.crossingPointB,
      this.crossingLine,
      this.routeLine,
      this.tangentArrow,
      this.normalArrow,
      this.binormalArrow,
      this.velocityArrow,
      this.contactForceArrow,
    );
    scene.add(this.group);

    this.queryLabel = this.createLabel(labelLayer, "traversal-label query-debug-label");
    this.contactLabel = this.createLabel(labelLayer, "traversal-label contact-debug-label");
    this.routeLabel = this.createLabel(labelLayer, "traversal-label route-debug-label");
    this.crossingLabel = this.createLabel(labelLayer, "traversal-label crossing-debug-label");
  }

  setCourse(course: PhaseFiveWeb, traversal: StrandTraversal): void {
    this.course = course;
    this.traversal = traversal;
  }

  update(snapshot: TraversalDebugSnapshot): void {
    this.updateQuery(snapshot);
    this.updateContactFrame(snapshot);
    this.updateContact(snapshot);
    this.updateRoute(snapshot.route);
    this.updateConnectivity();
  }

  private updateQuery(snapshot: TraversalDebugSnapshot): void {
    const visible = this.config.showClosestQuery && snapshot.queryResult !== null;
    this.queryTarget.visible = visible;
    this.queryPoint.visible = visible;
    this.queryLine.visible = visible;
    this.queryLabel.hidden = !visible;
    if (!visible || !snapshot.queryResult) {
      return;
    }

    this.queryTarget.position.set(
      snapshot.queryTarget.x,
      snapshot.queryTarget.y,
      snapshot.queryTarget.z,
    );
    this.queryTarget.rotation.x += 0.007;
    this.queryTarget.rotation.y += 0.011;
    this.queryPoint.position.set(
      snapshot.queryResult.position.x,
      snapshot.queryResult.position.y,
      snapshot.queryResult.position.z,
    );
    this.writeLine(
      this.queryLinePositions,
      snapshot.queryTarget,
      snapshot.queryResult.position,
    );
    this.queryLineAttribute.needsUpdate = true;
    this.queryLine.computeLineDistances();
    this.setLabelMarkup(
      this.queryLabel,
      `<span>CLOSEST · ${snapshot.queryResult.address.strandId}</span>` +
        `<i>t ${snapshot.queryResult.address.t.toFixed(3)} · ${snapshot.queryResult.distance.toFixed(2)}u</i>`,
    );
    this.placeLabel(this.queryLabel, snapshot.queryResult.position);
  }

  private updateContactFrame(snapshot: TraversalDebugSnapshot): void {
    const hasFrame = snapshot.frame !== null && snapshot.framePosition !== null;
    this.setArrow(
      this.tangentArrow,
      snapshot.framePosition,
      snapshot.frame?.tangent ?? null,
      this.config.showTangent && hasFrame,
      0.72,
    );
    this.setArrow(
      this.normalArrow,
      snapshot.framePosition,
      snapshot.frame?.normal ?? null,
      this.config.showNormal && hasFrame,
      0.66,
    );
    this.setArrow(
      this.binormalArrow,
      snapshot.framePosition,
      snapshot.frame?.binormal ?? null,
      this.config.showBinormal && hasFrame,
      0.66,
    );
    const velocityMagnitude = Math.hypot(
      snapshot.localVelocity.x,
      snapshot.localVelocity.y,
      snapshot.localVelocity.z,
    );
    this.setArrow(
      this.velocityArrow,
      snapshot.framePosition,
      snapshot.localVelocity,
      this.config.showVelocity && hasFrame && velocityMagnitude > 1e-4,
      Math.min(0.9, 0.18 + velocityMagnitude * 0.18),
    );
  }

  private updateContact(snapshot: TraversalDebugSnapshot): void {
    const visible =
      this.config.showContact && snapshot.contactAddress !== null && snapshot.contactPosition !== null;
    this.contactGroup.visible = visible;
    this.contactLabel.hidden = !visible;
    if (!visible || !snapshot.contactAddress || !snapshot.contactPosition) {
      this.contactForceArrow.visible = false;
      return;
    }
    this.contactGroup.position.set(
      snapshot.contactPosition.x,
      snapshot.contactPosition.y,
      snapshot.contactPosition.z,
    );
    this.contactGroup.quaternion.copy(this.camera.quaternion);
    this.setLabelMarkup(
      this.contactLabel,
      `<span>TEMP CONTACT · ${snapshot.contactAddress.strandId}</span>` +
        `<i>t ${snapshot.contactAddress.t.toFixed(3)} · load ${Math.hypot(snapshot.contactForce.x, snapshot.contactForce.y, snapshot.contactForce.z).toFixed(1)}N · tension ${snapshot.localTension.toFixed(1)}N</i>`,
    );
    this.placeLabel(this.contactLabel, snapshot.contactPosition);

    const forceMagnitude = Math.hypot(
      snapshot.contactForce.x,
      snapshot.contactForce.y,
      snapshot.contactForce.z,
    );
    this.setArrow(
      this.contactForceArrow,
      snapshot.contactPosition,
      snapshot.contactForce,
      forceMagnitude > 1e-5,
      Math.min(0.9, 0.2 + forceMagnitude * 0.12),
    );
  }

  private updateRoute(route: PlannedRoute | null): void {
    const visible = this.config.showRoute && route !== null && this.traversal !== null;
    this.routeLine.visible = visible;
    this.routeLabel.hidden = !visible;
    if (!visible || !route || !this.traversal) {
      this.routeLine.geometry.setDrawRange(0, 0);
      return;
    }

    let pointCount = 0;
    for (const leg of route.legs) {
      const samples = Math.max(2, Math.ceil(Math.abs(leg.toT - leg.fromT) * 24) + 1);
      for (let sample = 0; sample < samples && pointCount < MAX_ROUTE_POINTS; sample += 1) {
        if (pointCount > 0 && sample === 0) {
          continue;
        }
        const alpha = sample / (samples - 1);
        this.routeAddress.strandId = leg.strandId;
        this.routeAddress.t = leg.fromT + (leg.toT - leg.fromT) * alpha;
        this.traversal.getWorldPosition(this.routeAddress, this.scratchA);
        const offset = pointCount * 3;
        this.routePositions[offset] = this.scratchA.x;
        this.routePositions[offset + 1] = this.scratchA.y;
        this.routePositions[offset + 2] = this.scratchA.z;
        pointCount += 1;
      }
    }
    this.routeLine.geometry.setDrawRange(0, pointCount);
    this.routeAttribute.needsUpdate = true;
    this.setLabelMarkup(
      this.routeLabel,
      `<span>ROUTE · ${route.strandIds.join(" → ")}</span>` +
        `<i>${route.transitions.length} junction transitions · ${route.materialDistance.toFixed(1)}u</i>`,
    );
    let destinationPosition: Vec3Like = route.destinationPosition;
    if (route.destinationAddress) {
      this.traversal.getWorldPosition(route.destinationAddress, this.scratchB);
      destinationPosition = this.scratchB;
    } else if (route.destinationNodeId) {
      this.traversal.getNodePosition(route.destinationNodeId, this.scratchB);
      destinationPosition = this.scratchB;
    }
    this.placeLabel(this.routeLabel, destinationPosition);
  }

  private updateConnectivity(): void {
    const visible = this.config.showCrossings && this.course !== null && this.traversal !== null;
    this.crossingPointA.visible = visible;
    this.crossingPointB.visible = visible;
    this.crossingLine.visible = visible;
    this.connectedJunctionGroup.visible = visible;
    this.crossingLabel.hidden = !visible;
    if (!visible || !this.course || !this.traversal) {
      return;
    }

    const crossing = this.course.crossings[0];
    this.traversal.getWorldPosition(
      { strandId: crossing.strandAId, t: crossing.strandAT },
      this.scratchA,
    );
    this.traversal.getWorldPosition(
      { strandId: crossing.strandBId, t: crossing.strandBT },
      this.scratchB,
    );
    this.crossingPointA.position.set(this.scratchA.x, this.scratchA.y, this.scratchA.z);
    this.crossingPointB.position.set(this.scratchB.x, this.scratchB.y, this.scratchB.z);
    this.writeLine(this.crossingLinePositions, this.scratchA, this.scratchB);
    this.crossingLineAttribute.needsUpdate = true;
    this.crossingLine.computeLineDistances();
    const midpoint = this.projection.set(
      (this.scratchA.x + this.scratchB.x) * 0.5,
      (this.scratchA.y + this.scratchB.y) * 0.5,
      (this.scratchA.z + this.scratchB.z) * 0.5,
    );
    this.setLabelMarkup(
      this.crossingLabel,
      `<span>PROJECTION CROSSING · NO NODE</span>` +
        `<i>${crossing.strandAId} × ${crossing.strandBId} · separate components</i>`,
    );
    this.placeLabel(this.crossingLabel, midpoint);

    this.traversal.getNodePosition(this.course.semantics.trueJunctionId, this.scratchA);
    this.connectedJunctionGroup.position.set(this.scratchA.x, this.scratchA.y, this.scratchA.z);
    this.connectedJunctionGroup.quaternion.copy(this.camera.quaternion);
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
    if (magnitude < 1e-8) {
      arrow.visible = false;
      return;
    }
    this.direction.multiplyScalar(1 / magnitude);
    arrow.position.set(origin.x, origin.y, origin.z);
    arrow.setDirection(this.direction);
    arrow.setLength(length, Math.min(0.13, length * 0.28), Math.min(0.075, length * 0.16));
  }

  private writeLine(target: Float32Array, start: Vec3Like, end: Vec3Like): void {
    target[0] = start.x;
    target[1] = start.y;
    target[2] = start.z;
    target[3] = end.x;
    target[4] = end.y;
    target[5] = end.z;
  }

  private createLabel(layer: HTMLElement, className: string): HTMLDivElement {
    const label = document.createElement("div");
    label.className = className;
    label.hidden = true;
    layer.append(label);
    return label;
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
    // The debug labels have a 250 px CSS maximum plus a small translated
    // offset. Clamp their anchor so long route/crossing names remain readable
    // on the compact portrait course without changing the world-space marker.
    const x = Math.max(
      8,
      Math.min(
        Math.max(8, this.canvas.clientWidth - 270),
        (this.projection.x * 0.5 + 0.5) * this.canvas.clientWidth,
      ),
    );
    const y = Math.max(
      36,
      Math.min(
        Math.max(36, this.canvas.clientHeight - 48),
        (-this.projection.y * 0.5 + 0.5) * this.canvas.clientHeight,
      ),
    );
    label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }
}
