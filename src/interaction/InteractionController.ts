import * as THREE from "three";
import type { LabConfig } from "../config";
import type { WebPhysicsSolver } from "../physics/WebPhysicsSolver";
import type { WebNetwork } from "../web/WebNetwork";
import type { WebStrand } from "../web/WebStrand";

/**
 * Screen-space strand picking plus a material-coordinate drag attachment.
 * Selection is stored as segment + fractional t, never as a render vertex.
 */
export class InteractionController {
  readonly dragTarget = new THREE.Vector3();
  readonly appliedForce = new THREE.Vector3();

  isDragging = false;

  private network: WebNetwork | null = null;
  private selectedStrand: WebStrand | null = null;
  private selectedSegment = -1;
  private selectedT = 0;
  private selectedU = 0;
  private hoverStrand: WebStrand | null = null;
  private hoverSegment = -1;
  private hoverT = 0;
  private pendingClickImpulse = false;
  private activePointerId: number | null = null;
  private pointerStartX = 0;
  private pointerStartY = 0;
  private maximumPointerDistanceSquared = 0;

  private readonly raycaster = new THREE.Raycaster();
  private readonly pointerNdc = new THREE.Vector2();
  private readonly webPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly dragPlaneNormal = new THREE.Vector3();
  private readonly pointerWorld = new THREE.Vector3();
  private readonly grabOffset = new THREE.Vector3();
  private readonly projectedPoint = new THREE.Vector3();
  private projectedPositions = new Float32Array(0);
  private pickStrand: WebStrand | null = null;
  private pickSegment = -1;
  private pickT = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly config: LabConfig,
  ) {
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);
    canvas.addEventListener("lostpointercapture", this.onLostPointerCapture);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    window.addEventListener("blur", this.cancelActiveDrag);
  }

  setNetwork(network: WebNetwork): void {
    this.cancelActiveDrag();
    this.network = network;
    let maximumPointCount = 0;
    for (const strand of network.strandList) {
      maximumPointCount = Math.max(maximumPointCount, strand.pointCount);
    }
    this.projectedPositions = new Float32Array(maximumPointCount * 3);
    this.clearSelection();
  }

  get hasSelection(): boolean {
    return this.selectedStrand !== null && this.selectedSegment >= 0;
  }

  get selectionDescription(): string {
    if (!this.hasSelection) {
      return "NONE";
    }
    const shortId = this.selectedStrand!.id.replace("silk-", "");
    return `${shortId}  ·  u ${this.selectedU.toFixed(3)}  ·  ${this.selectedSegment}→${this.selectedSegment + 1} @ ${this.selectedT.toFixed(2)}`;
  }

  get selectedStrandId(): string | null {
    return this.selectedStrand?.id ?? null;
  }

  get selectedNormalizedT(): number {
    return this.selectedU;
  }

  writeHoverAddress(target: { strandId: string; t: number }): boolean {
    if (!this.hoverStrand || this.hoverSegment < 0) {
      return false;
    }
    target.strandId = this.hoverStrand.id;
    target.t = this.hoverStrand.normalizedLocation(this.hoverSegment, this.hoverT);
    return true;
  }

  clearSelection(): void {
    this.selectedStrand = null;
    this.selectedSegment = -1;
    this.selectedT = 0;
    this.selectedU = 0;
    this.hoverStrand = null;
    this.hoverSegment = -1;
    this.hoverT = 0;
    this.pendingClickImpulse = false;
    this.appliedForce.set(0, 0, 0);
    this.canvas.style.cursor = "default";
  }

  applyForces(solver: WebPhysicsSolver, fixedDelta: number): void {
    const selectedStrand = this.selectedStrand;
    if (!this.network || !selectedStrand || this.selectedSegment < 0) {
      return;
    }

    if (this.pendingClickImpulse) {
      // A real impulse is encoded into Verlet's previous position, so a click
      // has the same effect regardless of the browser's render frame rate.
      solver.applyContactEnergyImpulse(
        selectedStrand,
        this.selectedSegment,
        this.selectedT,
        0,
        -this.config.appliedForce * 0.13,
        0,
        fixedDelta,
      );
      this.pendingClickImpulse = false;
    }

    if (!this.isDragging) {
      this.appliedForce.set(0, 0, 0);
      return;
    }

    const store = this.network.particles;
    const particleA = selectedStrand.particleIndices[this.selectedSegment];
    const particleB = selectedStrand.particleIndices[this.selectedSegment + 1];
    const offsetA = particleA * 3;
    const offsetB = particleB * 3;
    const weightA = 1 - this.selectedT;
    const weightB = this.selectedT;
    const positions = store.positions;
    const previous = store.previousPositions;

    const pointX = positions[offsetA] * weightA + positions[offsetB] * weightB;
    const pointY = positions[offsetA + 1] * weightA + positions[offsetB + 1] * weightB;
    const pointZ = positions[offsetA + 2] * weightA + positions[offsetB + 2] * weightB;
    const velocityX =
      ((positions[offsetA] - previous[offsetA]) * weightA +
        (positions[offsetB] - previous[offsetB]) * weightB) /
      fixedDelta;
    const velocityY =
      ((positions[offsetA + 1] - previous[offsetA + 1]) * weightA +
        (positions[offsetB + 1] - previous[offsetB + 1]) * weightB) /
      fixedDelta;
    const velocityZ =
      ((positions[offsetA + 2] - previous[offsetA + 2]) * weightA +
        (positions[offsetB + 2] - previous[offsetB + 2]) * weightB) /
      fixedDelta;

    let deltaX = this.dragTarget.x - pointX;
    let deltaY = this.dragTarget.y - pointY;
    let deltaZ = this.dragTarget.z - pointZ;
    const targetDistance = Math.hypot(deltaX, deltaY, deltaZ);
    if (targetDistance > 1.8) {
      const targetScale = 1.8 / targetDistance;
      deltaX *= targetScale;
      deltaY *= targetScale;
      deltaZ *= targetScale;
    }

    const springStrength = 30;
    const dragDamping = 1.4;
    let forceX = deltaX * springStrength - velocityX * dragDamping;
    let forceY = deltaY * springStrength - velocityY * dragDamping;
    let forceZ = deltaZ * springStrength - velocityZ * dragDamping;
    const forceMagnitude = Math.hypot(forceX, forceY, forceZ);
    const maximumForce = this.config.appliedForce;
    if (forceMagnitude > maximumForce && forceMagnitude > 0) {
      const forceScale = maximumForce / forceMagnitude;
      forceX *= forceScale;
      forceY *= forceScale;
      forceZ *= forceScale;
    }

    this.appliedForce.set(forceX, forceY, forceZ);
    solver.addForceAtLocation(
      selectedStrand,
      this.selectedSegment,
      this.selectedT,
      forceX,
      forceY,
      forceZ,
    );
  }

  writeSelectedPosition(target: THREE.Vector3): boolean {
    if (!this.network || !this.selectedStrand || this.selectedSegment < 0) {
      return false;
    }
    this.sampleSegment(this.selectedStrand, this.selectedSegment, this.selectedT, target);
    return true;
  }

  writeMarkerPosition(target: THREE.Vector3): boolean {
    if (this.writeSelectedPosition(target)) {
      return true;
    }
    if (!this.network || !this.hoverStrand || this.hoverSegment < 0) {
      return false;
    }
    this.sampleSegment(this.hoverStrand, this.hoverSegment, this.hoverT, target);
    return true;
  }

  private sampleSegment(
    strand: WebStrand,
    segment: number,
    t: number,
    target: THREE.Vector3,
  ): void {
    if (!this.network) {
      return;
    }
    const particleA = strand.particleIndices[segment];
    const particleB = strand.particleIndices[segment + 1];
    const offsetA = particleA * 3;
    const offsetB = particleB * 3;
    const positions = this.network.particles.positions;
    const weightA = 1 - t;
    target.set(
      positions[offsetA] * weightA + positions[offsetB] * t,
      positions[offsetA + 1] * weightA + positions[offsetB + 1] * t,
      positions[offsetA + 2] * weightA + positions[offsetB + 2] * t,
    );
  }

  private pick(clientX: number, clientY: number): boolean {
    if (!this.network) {
      return false;
    }

    const rect = this.canvas.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const positions = this.network.particles.positions;

    let closestDistanceSquared = Number.POSITIVE_INFINITY;
    let closestDepth = Number.POSITIVE_INFINITY;
    this.pickStrand = null;
    this.pickSegment = -1;
    this.pickT = 0;
    for (const strand of this.network.strandList) {
      if (!strand.active || strand.broken) {
        continue;
      }

      for (let point = 0; point < strand.pointCount; point += 1) {
        const sourceOffset = strand.particleIndices[point] * 3;
        this.projectedPoint
          .set(positions[sourceOffset], positions[sourceOffset + 1], positions[sourceOffset + 2])
          .project(this.camera);
        const targetOffset = point * 3;
        this.projectedPositions[targetOffset] =
          (this.projectedPoint.x * 0.5 + 0.5) * rect.width;
        this.projectedPositions[targetOffset + 1] =
          (-this.projectedPoint.y * 0.5 + 0.5) * rect.height;
        this.projectedPositions[targetOffset + 2] = this.projectedPoint.z;
      }

      for (let segment = 0; segment < strand.constraintCount; segment += 1) {
        const offsetA = segment * 3;
        const offsetB = offsetA + 3;
        const ax = this.projectedPositions[offsetA];
        const ay = this.projectedPositions[offsetA + 1];
        const bx = this.projectedPositions[offsetB];
        const by = this.projectedPositions[offsetB + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const lengthSquared = dx * dx + dy * dy;
        const t =
          lengthSquared > 0
            ? Math.max(
                0,
                Math.min(1, ((localX - ax) * dx + (localY - ay) * dy) / lengthSquared),
              )
            : 0;
        const nearestX = ax + dx * t;
        const nearestY = ay + dy * t;
        const distanceX = localX - nearestX;
        const distanceY = localY - nearestY;
        const distanceSquared = distanceX * distanceX + distanceY * distanceY;
        const depth =
          this.projectedPositions[offsetA + 2] * (1 - t) +
          this.projectedPositions[offsetB + 2] * t;
        const winsByDistance = distanceSquared < closestDistanceSquared - 0.25;
        const winsDepthTie =
          Math.abs(distanceSquared - closestDistanceSquared) <= 0.25 && depth < closestDepth;
        if (winsByDistance || winsDepthTie) {
          closestDistanceSquared = distanceSquared;
          closestDepth = depth;
          this.pickStrand = strand;
          this.pickSegment = segment;
          this.pickT = t;
        }
      }
    }

    const hitRadius = Math.max(14, 8 + this.config.visualScale * 3);
    return this.pickStrand !== null && closestDistanceSquared <= hitRadius * hitRadius;
  }

  private updatePointerWorld(clientX: number, clientY: number): boolean {
    const rect = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    return this.raycaster.ray.intersectPlane(this.webPlane, this.pointerWorld) !== null;
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || !event.isPrimary || !this.network) {
      return;
    }

    if (!this.pick(event.clientX, event.clientY)) {
      this.clearSelection();
      return;
    }

    event.preventDefault();
    this.selectedStrand = this.pickStrand;
    this.selectedSegment = this.pickSegment;
    this.selectedT = this.pickT;
    this.selectedU = this.selectedStrand!.normalizedLocation(this.selectedSegment, this.selectedT);
    this.pendingClickImpulse = false;
    this.isDragging = true;
    this.activePointerId = event.pointerId;
    this.pointerStartX = event.clientX;
    this.pointerStartY = event.clientY;
    this.maximumPointerDistanceSquared = 0;

    this.sampleSegment(this.selectedStrand!, this.selectedSegment, this.selectedT, this.dragTarget);
    this.camera.getWorldDirection(this.dragPlaneNormal);
    this.webPlane.setFromNormalAndCoplanarPoint(this.dragPlaneNormal, this.dragTarget);
    if (this.updatePointerWorld(event.clientX, event.clientY)) {
      this.grabOffset.copy(this.dragTarget).sub(this.pointerWorld);
      this.dragTarget.copy(this.pointerWorld).add(this.grabOffset);
    }

    this.canvas.setPointerCapture(event.pointerId);
    this.canvas.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.activePointerId === event.pointerId && this.isDragging) {
      event.preventDefault();
      const deltaX = event.clientX - this.pointerStartX;
      const deltaY = event.clientY - this.pointerStartY;
      this.maximumPointerDistanceSquared = Math.max(
        this.maximumPointerDistanceSquared,
        deltaX * deltaX + deltaY * deltaY,
      );
      if (this.updatePointerWorld(event.clientX, event.clientY)) {
        this.dragTarget.copy(this.pointerWorld).add(this.grabOffset);
      }
      return;
    }

    if (this.pick(event.clientX, event.clientY)) {
      this.hoverStrand = this.pickStrand;
      this.hoverSegment = this.pickSegment;
      this.hoverT = this.pickT;
      this.canvas.style.cursor = "grab";
    } else {
      this.hoverStrand = null;
      this.hoverSegment = -1;
      this.hoverT = 0;
      this.canvas.style.cursor = "default";
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (this.activePointerId !== event.pointerId) {
      return;
    }

    event.preventDefault();
    this.pendingClickImpulse = this.maximumPointerDistanceSquared < 16;
    this.finishDrag(event.pointerId);
  };

  private readonly onPointerCancel = (event: PointerEvent): void => {
    if (this.activePointerId === event.pointerId) {
      this.finishDrag(event.pointerId);
    }
  };

  private readonly onLostPointerCapture = (event: PointerEvent): void => {
    if (this.activePointerId === event.pointerId) {
      this.isDragging = false;
      this.activePointerId = null;
      this.appliedForce.set(0, 0, 0);
      this.canvas.style.cursor = "default";
    }
  };

  private readonly onPointerLeave = (): void => {
    if (!this.isDragging) {
      this.hoverStrand = null;
      this.hoverSegment = -1;
      this.hoverT = 0;
      this.canvas.style.cursor = "default";
    }
  };

  private readonly cancelActiveDrag = (): void => {
    if (this.activePointerId !== null) {
      this.finishDrag(this.activePointerId);
    }
    this.pendingClickImpulse = false;
  };

  private finishDrag(pointerId: number): void {
    this.isDragging = false;
    this.activePointerId = null;
    this.appliedForce.set(0, 0, 0);
    if (this.canvas.hasPointerCapture(pointerId)) {
      this.canvas.releasePointerCapture(pointerId);
    }
    this.canvas.style.cursor = "grab";
  }
}
