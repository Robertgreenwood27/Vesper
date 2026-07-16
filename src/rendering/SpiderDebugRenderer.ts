import * as THREE from "three";
import type { SpiderLabConfig } from "../spider/SpiderConfig";
import type { SpiderFootContact } from "../spider/SpiderFootContact";
import type { SpiderLegId } from "../spider/SpiderRigSpec";

export interface SpiderDebugLegRig {
  readonly id: SpiderLegId;
  readonly bones: readonly THREE.Bone[];
  readonly footTip: THREE.Bone;
  readonly footHome: THREE.Bone;
}

export interface SpiderDebugIkResult {
  readonly error: number;
  readonly reached: boolean;
  readonly finite: boolean;
}

export interface SpiderDebugSnapshot {
  readonly contacts: ReadonlyMap<SpiderLegId, SpiderFootContact>;
  readonly ikResults: ReadonlyMap<SpiderLegId, SpiderDebugIkResult>;
  readonly supportCenter: THREE.Vector3;
  readonly bodyForward: THREE.Vector3;
  readonly bodyUp: THREE.Vector3;
  readonly rigScale: number;
}

interface FootVisual {
  readonly rig: SpiderDebugLegRig;
  readonly target: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly plantedRing: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  readonly home: THREE.Mesh<THREE.OctahedronGeometry, THREE.MeshBasicMaterial>;
  readonly reachComfort: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly reachMaximum: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  readonly targetLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  readonly targetLinePositions: Float32Array;
  readonly tangent: THREE.ArrowHelper;
  readonly normal: THREE.ArrowHelper;
  readonly binormal: THREE.ArrowHelper;
  readonly load: THREE.ArrowHelper;
  readonly label: HTMLDivElement;
}

const COMFORTABLE_COLOR = 0x70ffbd;
const STRAINED_COLOR = 0xffbd4a;
const INVALID_COLOR = 0xff4d89;

/** Renderer-only diagnostics. It never changes contact, IK, or web state. */
export class SpiderDebugRenderer {
  private skeleton: THREE.SkeletonHelper | null = null;
  private readonly boneAxes: THREE.AxesHelper[] = [];
  private readonly feet = new Map<SpiderLegId, FootVisual>();
  private readonly supportCenter = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.055, 0),
    new THREE.MeshBasicMaterial({ color: 0xffbd4a, depthTest: false }),
  );
  private readonly forwardArrow = new THREE.ArrowHelper(
    new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(),
    0.48,
    0x57d9ff,
    0.1,
    0.055,
  );
  private readonly upArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(),
    0.42,
    0xffbd4a,
    0.1,
    0.055,
  );
  private readonly validationLabel: HTMLDivElement;
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchDirection = new THREE.Vector3();
  private readonly scratchQuaternion = new THREE.Quaternion();
  private readonly ringNormal = new THREE.Vector3(0, 0, 1);

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly labelLayer: HTMLElement,
    private readonly config: SpiderLabConfig,
  ) {
    this.supportCenter.renderOrder = 20;
    (this.forwardArrow.line.material as THREE.LineBasicMaterial).depthTest = false;
    (this.forwardArrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    (this.upArrow.line.material as THREE.LineBasicMaterial).depthTest = false;
    (this.upArrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    scene.add(this.supportCenter, this.forwardArrow, this.upArrow);

    this.validationLabel = document.createElement("div");
    this.validationLabel.className = "spider-validation-label";
    this.validationLabel.hidden = true;
    this.labelLayer.append(this.validationLabel);
  }

  setRig(
    skeletonRoot: THREE.Object3D,
    allBones: readonly THREE.Bone[],
    legs: readonly SpiderDebugLegRig[],
    validationMessage: string,
  ): void {
    this.disposeRigVisuals();
    this.skeleton = new THREE.SkeletonHelper(skeletonRoot);
    const skeletonMaterial = this.skeleton.material as THREE.LineBasicMaterial;
    skeletonMaterial.depthTest = false;
    skeletonMaterial.transparent = true;
    skeletonMaterial.opacity = 0.74;
    this.skeleton.renderOrder = 21;
    this.scene.add(this.skeleton);

    for (const bone of allBones) {
      const axes = new THREE.AxesHelper(0.075);
      const axesMaterial = axes.material as THREE.LineBasicMaterial;
      axesMaterial.depthTest = false;
      axesMaterial.transparent = true;
      axesMaterial.opacity = 0.7;
      bone.add(axes);
      this.boneAxes.push(axes);
    }

    for (const rig of legs) {
      const visual = this.createFootVisual(rig);
      this.feet.set(rig.id, visual);
    }
    this.validationLabel.className = "spider-validation-label";
    this.validationLabel.innerHTML = `<strong>RIG CONTRACT VALID</strong><br>${validationMessage}`;
  }

  showRigError(message: string): void {
    this.validationLabel.className = "spider-validation-label error";
    this.validationLabel.innerHTML = `<strong>RIG CONTRACT ERROR</strong><br>${message}`;
    this.validationLabel.hidden = !this.config.showRigValidation;
  }

  update(snapshot: SpiderDebugSnapshot): void {
    if (this.skeleton) {
      this.skeleton.visible = this.config.showSkeleton;
    }
    for (const axes of this.boneAxes) {
      axes.visible = this.config.showBoneAxes;
    }
    this.validationLabel.hidden = !this.config.showRigValidation;

    this.supportCenter.visible = this.config.showSupportCenter;
    this.supportCenter.position.copy(snapshot.supportCenter);
    this.supportCenter.quaternion.copy(this.camera.quaternion);
    this.forwardArrow.visible = this.config.showBodyAxes;
    this.upArrow.visible = this.config.showBodyAxes;
    if (this.config.showBodyAxes) {
      this.forwardArrow.position.copy(snapshot.supportCenter);
      this.upArrow.position.copy(snapshot.supportCenter);
      this.setArrowDirection(this.forwardArrow, snapshot.bodyForward, 0.48);
      this.setArrowDirection(this.upArrow, snapshot.bodyUp, 0.42);
    }

    for (const [legId, visual] of this.feet) {
      const contact = snapshot.contacts.get(legId);
      const ik = snapshot.ikResults.get(legId);
      if (!contact) {
        this.setFootVisible(visual, false);
        continue;
      }
      this.updateFoot(visual, contact, ik, snapshot.rigScale);
    }
  }

  private createFootVisual(rig: SpiderDebugLegRig): FootVisual {
    const target = new THREE.Mesh(
      new THREE.SphereGeometry(0.045, 12, 8),
      new THREE.MeshBasicMaterial({ color: COMFORTABLE_COLOR, depthTest: false }),
    );
    const plantedRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.075, 0.012, 7, 24),
      new THREE.MeshBasicMaterial({ color: COMFORTABLE_COLOR, depthTest: false }),
    );
    const home = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.035, 0),
      new THREE.MeshBasicMaterial({ color: 0x57d9ff, wireframe: true, depthTest: false }),
    );
    const reachComfort = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: COMFORTABLE_COLOR,
        wireframe: true,
        transparent: true,
        opacity: 0.1,
        depthTest: false,
      }),
    );
    const reachMaximum = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshBasicMaterial({
        color: STRAINED_COLOR,
        wireframe: true,
        transparent: true,
        opacity: 0.12,
        depthTest: false,
      }),
    );
    const targetLinePositions = new Float32Array(6);
    const lineGeometry = new THREE.BufferGeometry();
    lineGeometry.setAttribute("position", new THREE.BufferAttribute(targetLinePositions, 3));
    const targetLine = new THREE.Line(
      lineGeometry,
      new THREE.LineBasicMaterial({
        color: COMFORTABLE_COLOR,
        transparent: true,
        opacity: 0.78,
        depthTest: false,
      }),
    );
    const tangent = this.createArrow(0x57d9ff);
    const normal = this.createArrow(0xffbd4a);
    const binormal = this.createArrow(0xff4d89);
    const load = this.createArrow(0xffbd4a);
    const label = document.createElement("div");
    label.className = "spider-debug-label";
    label.hidden = true;
    this.labelLayer.append(label);
    this.scene.add(
      target,
      plantedRing,
      home,
      reachComfort,
      reachMaximum,
      targetLine,
      tangent,
      normal,
      binormal,
      load,
    );
    return {
      rig,
      target,
      plantedRing,
      home,
      reachComfort,
      reachMaximum,
      targetLine,
      targetLinePositions,
      tangent,
      normal,
      binormal,
      load,
      label,
    };
  }

  private updateFoot(
    visual: FootVisual,
    contact: SpiderFootContact,
    ik: SpiderDebugIkResult | undefined,
    rigScale: number,
  ): void {
    const hasTarget = contact.hasResolvedWorldPosition && contact.address !== null;
    const showInvalid = this.config.showInvalidContacts && !contact.contactValid && hasTarget;
    const color = contact.contactValid
      ? contact.reachStatus === "comfortable" ? COMFORTABLE_COLOR : STRAINED_COLOR
      : INVALID_COLOR;
    visual.target.material.color.setHex(color);
    visual.plantedRing.material.color.setHex(color);
    visual.targetLine.material.color.setHex(color);

    visual.target.visible = this.config.showFootTargets && hasTarget;
    visual.plantedRing.visible = this.config.showPlantedContacts && contact.isPlanted && hasTarget;
    visual.targetLine.visible = this.config.showFootTargets && hasTarget;
    visual.home.visible = this.config.showFootHomes;
    visual.reachComfort.visible = this.config.showReachRanges;
    visual.reachMaximum.visible = this.config.showReachRanges;
    visual.label.hidden = !(this.config.showReachRatio || showInvalid);

    visual.rig.footHome.getWorldPosition(this.scratchA);
    visual.home.position.copy(this.scratchA);
    visual.home.quaternion.copy(this.camera.quaternion);
    visual.rig.bones[0]?.getWorldPosition(this.scratchA);
    visual.reachComfort.position.copy(this.scratchA);
    visual.reachMaximum.position.copy(this.scratchA);
    visual.reachComfort.scale.setScalar(contact.reach.comfortable * rigScale);
    visual.reachMaximum.scale.setScalar(contact.reach.max * rigScale);

    if (!hasTarget) {
      this.hideFootFrames(visual);
      return;
    }
    visual.target.position.set(contact.worldPosition.x, contact.worldPosition.y, contact.worldPosition.z);
    visual.target.quaternion.copy(this.camera.quaternion);
    visual.plantedRing.position.copy(visual.target.position);
    this.scratchDirection.set(
      contact.frame.tangent.x,
      contact.frame.tangent.y,
      contact.frame.tangent.z,
    );
    if (this.scratchDirection.lengthSq() > 1e-10) {
      this.scratchDirection.normalize();
      this.scratchQuaternion.setFromUnitVectors(this.ringNormal, this.scratchDirection);
      visual.plantedRing.quaternion.copy(this.scratchQuaternion);
    }

    visual.rig.footTip.getWorldPosition(this.scratchA);
    const p = visual.targetLinePositions;
    p[0] = this.scratchA.x;
    p[1] = this.scratchA.y;
    p[2] = this.scratchA.z;
    p[3] = contact.worldPosition.x;
    p[4] = contact.worldPosition.y;
    p[5] = contact.worldPosition.z;
    (visual.targetLine.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;

    this.updateContactArrow(visual.tangent, contact.worldPosition, contact.frame.tangent, this.config.showContactFrames, 0.18);
    this.updateContactArrow(visual.normal, contact.worldPosition, contact.frame.normal, this.config.showContactFrames, 0.16);
    this.updateContactArrow(visual.binormal, contact.worldPosition, contact.frame.binormal, this.config.showContactFrames, 0.16);
    this.scratchDirection.set(0, -1, 0);
    this.updateContactArrow(
      visual.load,
      contact.worldPosition,
      this.scratchDirection,
      this.config.showPerFootLoad && contact.carriedLoadNewtons > 1e-6,
      Math.min(0.3, 0.08 + contact.carriedLoadNewtons * 0.18),
    );

    const errorMillimeters = (ik?.error ?? 0) * 1000;
    visual.label.className = `spider-debug-label${
      !contact.contactValid ? " invalid" : contact.reachStatus === "strained" ? " strained" : ""
    }`;
    visual.label.innerHTML = `<strong>${visual.rig.id} · ${contact.state}</strong> · ${(
      contact.currentReachRatio * 100
    ).toFixed(0)}%<br>${contact.address!.strandId} @ ${contact.address!.t.toFixed(3)} · ${
      contact.carriedLoadNewtons
    .toFixed(2)}N · IK ${errorMillimeters.toFixed(1)}mm`;
    this.placeLabel(visual.label, contact.worldPosition);
  }

  private updateContactArrow(
    arrow: THREE.ArrowHelper,
    origin: { readonly x: number; readonly y: number; readonly z: number },
    direction: { readonly x: number; readonly y: number; readonly z: number },
    visible: boolean,
    length: number,
  ): void {
    arrow.visible = visible;
    if (!visible) {
      return;
    }
    arrow.position.set(origin.x, origin.y, origin.z);
    this.scratchDirection.set(direction.x, direction.y, direction.z);
    if (this.scratchDirection.lengthSq() < 1e-10) {
      arrow.visible = false;
      return;
    }
    this.setArrowDirection(arrow, this.scratchDirection, length);
  }

  private setArrowDirection(arrow: THREE.ArrowHelper, direction: THREE.Vector3, length: number): void {
    this.scratchDirection.copy(direction).normalize();
    arrow.setDirection(this.scratchDirection);
    arrow.setLength(length, Math.min(0.07, length * 0.28), Math.min(0.04, length * 0.17));
  }

  private createArrow(color: number): THREE.ArrowHelper {
    const arrow = new THREE.ArrowHelper(
      new THREE.Vector3(0, 1, 0),
      new THREE.Vector3(),
      0.15,
      color,
      0.04,
      0.025,
    );
    (arrow.line.material as THREE.LineBasicMaterial).depthTest = false;
    (arrow.cone.material as THREE.MeshBasicMaterial).depthTest = false;
    arrow.visible = false;
    return arrow;
  }

  private hideFootFrames(visual: FootVisual): void {
    visual.tangent.visible = false;
    visual.normal.visible = false;
    visual.binormal.visible = false;
    visual.load.visible = false;
  }

  private setFootVisible(visual: FootVisual, visible: boolean): void {
    visual.target.visible = visible;
    visual.plantedRing.visible = visible;
    visual.home.visible = visible;
    visual.reachComfort.visible = visible;
    visual.reachMaximum.visible = visible;
    visual.targetLine.visible = visible;
    visual.label.hidden = !visible;
    this.hideFootFrames(visual);
  }

  private placeLabel(label: HTMLElement, point: { readonly x: number; readonly y: number; readonly z: number }): void {
    this.scratchA.set(point.x, point.y, point.z).project(this.camera);
    const x = Math.max(
      8,
      Math.min(
        Math.max(8, this.canvas.clientWidth - 220),
        (this.scratchA.x * 0.5 + 0.5) * this.canvas.clientWidth,
      ),
    );
    const y = Math.max(
      28,
      Math.min(
        Math.max(28, this.canvas.clientHeight - 42),
        (-this.scratchA.y * 0.5 + 0.5) * this.canvas.clientHeight,
      ),
    );
    label.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
  }

  private disposeRigVisuals(): void {
    if (this.skeleton) {
      this.scene.remove(this.skeleton);
      this.skeleton.dispose();
      this.skeleton = null;
    }
    for (const axes of this.boneAxes) {
      axes.removeFromParent();
      axes.dispose();
    }
    this.boneAxes.length = 0;
    for (const visual of this.feet.values()) {
      for (const object of [
        visual.target,
        visual.plantedRing,
        visual.home,
        visual.reachComfort,
        visual.reachMaximum,
        visual.targetLine,
        visual.tangent,
        visual.normal,
        visual.binormal,
        visual.load,
      ]) {
        object.removeFromParent();
      }
      visual.label.remove();
      visual.target.geometry.dispose();
      visual.target.material.dispose();
      visual.plantedRing.geometry.dispose();
      visual.plantedRing.material.dispose();
      visual.home.geometry.dispose();
      visual.home.material.dispose();
      visual.reachComfort.geometry.dispose();
      visual.reachComfort.material.dispose();
      visual.reachMaximum.geometry.dispose();
      visual.reachMaximum.material.dispose();
      visual.targetLine.geometry.dispose();
      visual.targetLine.material.dispose();
    }
    this.feet.clear();
  }
}
