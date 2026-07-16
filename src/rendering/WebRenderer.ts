import * as THREE from "three";
import type { LabConfig } from "../config";
import type { InteractionController } from "../interaction/InteractionController";
import type { WebNetwork } from "../web/WebNetwork";
import type { WebNode } from "../web/WebNode";
import type { WebStrand } from "../web/WebStrand";
import { DynamicRibbon } from "./DynamicRibbon";

interface StrandVisual {
  strand: WebStrand;
  glow: DynamicRibbon;
  core: DynamicRibbon;
  debugLine: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  debugPositions: Float32Array;
  debugAttribute: THREE.BufferAttribute;
  label: HTMLDivElement;
}

interface NodeVisual {
  node: WebNode;
  group: THREE.Group;
  label: HTMLDivElement;
}

export class WebRenderer {
  private network: WebNetwork | null = null;
  private readonly webGroup = new THREE.Group();
  private readonly overlayGroup = new THREE.Group();
  private readonly strandVisuals: StrandVisual[] = [];
  private readonly nodeVisuals: NodeVisual[] = [];
  private points: THREE.InstancedMesh | null = null;
  private readonly tensionScale = 24;

  private readonly glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.14,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly coreMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    transparent: true,
    opacity: 0.92,
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  private readonly pointGeometry = new THREE.CircleGeometry(0.045, 12);
  private readonly pointMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.86,
    depthTest: false,
    depthWrite: false,
  });
  private readonly anchorRingGeometry = new THREE.RingGeometry(0.11, 0.15, 32);
  private readonly anchorCoreGeometry = new THREE.CircleGeometry(0.047, 20);
  private readonly anchorHaloGeometry = new THREE.RingGeometry(0.205, 0.218, 40);
  private readonly junctionRingGeometry = new THREE.RingGeometry(0.105, 0.155, 4);
  private readonly junctionCoreGeometry = new THREE.CircleGeometry(0.052, 4);
  private readonly junctionHaloGeometry = new THREE.RingGeometry(0.205, 0.22, 4);
  private readonly anchorMaterial = new THREE.MeshBasicMaterial({
    color: 0xe2f8ff,
    transparent: true,
    opacity: 0.92,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly anchorHaloMaterial = new THREE.MeshBasicMaterial({
    color: 0x48bde8,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly junctionMaterial = new THREE.MeshBasicMaterial({
    color: 0xffcc70,
    transparent: true,
    opacity: 0.96,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  private readonly junctionHaloMaterial = new THREE.MeshBasicMaterial({
    color: 0xffa83d,
    transparent: true,
    opacity: 0.36,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  private readonly instanceTransform = new THREE.Object3D();
  private readonly projection = new THREE.Vector3();
  private readonly markerPosition = new THREE.Vector3();
  private readonly labelLocation = { segmentIndex: 0, t: 0, u: 0 };
  private readonly markerGroup = new THREE.Group();
  private readonly markerRing: THREE.Mesh;
  private readonly forceLinePositions = new Float32Array(6);
  private readonly forceLineAttribute = new THREE.BufferAttribute(this.forceLinePositions, 3);
  private readonly forceLine: THREE.Line;
  private readonly contactLabel: HTMLDivElement;

  constructor(
    scene: THREE.Scene,
    private readonly camera: THREE.Camera,
    private readonly canvas: HTMLCanvasElement,
    private readonly labelLayer: HTMLElement,
    private readonly config: LabConfig,
  ) {
    scene.add(this.webGroup, this.overlayGroup);
    this.addLabGrid(scene);

    const markerRing = new THREE.Mesh(
      new THREE.RingGeometry(0.075, 0.105, 32),
      new THREE.MeshBasicMaterial({
        color: 0x72d7ff,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const markerDot = new THREE.Mesh(
      new THREE.CircleGeometry(0.025, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        depthTest: false,
        depthWrite: false,
      }),
    );
    markerDot.position.z = 0.002;
    this.markerGroup.add(markerRing, markerDot);
    this.markerGroup.visible = false;
    this.markerGroup.renderOrder = 20;
    this.markerRing = markerRing;
    this.overlayGroup.add(this.markerGroup);

    this.forceLineAttribute.setUsage(THREE.DynamicDrawUsage);
    const forceGeometry = new THREE.BufferGeometry();
    forceGeometry.setAttribute("position", this.forceLineAttribute);
    this.forceLine = new THREE.Line(
      forceGeometry,
      new THREE.LineBasicMaterial({
        color: 0xff4778,
        transparent: true,
        opacity: 0.88,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.forceLine.visible = false;
    this.forceLine.renderOrder = 19;
    this.overlayGroup.add(this.forceLine);

    this.contactLabel = document.createElement("div");
    this.contactLabel.className = "node-label contact-label";
    this.contactLabel.textContent = "CONTACT";
    this.contactLabel.hidden = true;
    this.labelLayer.append(this.contactLabel);
  }

  setNetwork(network: WebNetwork): void {
    this.clearNetworkVisuals();
    this.network = network;

    for (const strand of network.strandList) {
      const glow = new DynamicRibbon(strand.particleIndices, this.glowMaterial);
      const core = new DynamicRibbon(strand.particleIndices, this.coreMaterial);
      glow.mesh.renderOrder = 2;
      core.mesh.renderOrder = 3;
      this.webGroup.add(glow.mesh, core.mesh);

      const debugPositions = new Float32Array(strand.pointCount * 3);
      const debugAttribute = new THREE.BufferAttribute(debugPositions, 3);
      debugAttribute.setUsage(THREE.DynamicDrawUsage);
      const debugGeometry = new THREE.BufferGeometry();
      debugGeometry.setAttribute("position", debugAttribute);
      const debugLine = new THREE.Line(
        debugGeometry,
        new THREE.LineBasicMaterial({
          color: 0xff4778,
          transparent: true,
          opacity: 0.52,
          depthTest: false,
          depthWrite: false,
        }),
      );
      debugLine.renderOrder = 8;
      this.webGroup.add(debugLine);
      const label = document.createElement("div");
      label.className = "strand-label";
      label.innerHTML = `<span>${strand.id}</span><i>t 0 → 1</i>`;
      this.labelLayer.append(label);
      this.strandVisuals.push({
        strand,
        glow,
        core,
        debugLine,
        debugPositions,
        debugAttribute,
        label,
      });
    }

    this.points = new THREE.InstancedMesh(
      this.pointGeometry,
      this.pointMaterial,
      network.particles.count,
    );
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    const dynamicColor = new THREE.Color(0x6dd6ff);
    const fixedColor = new THREE.Color(0xffcf69);
    for (let particle = 0; particle < network.particles.count; particle += 1) {
      this.points.setColorAt(
        particle,
        network.particles.inverseMasses[particle] === 0 ? fixedColor : dynamicColor,
      );
    }
    if (this.points.instanceColor) {
      this.points.instanceColor.needsUpdate = true;
    }
    this.webGroup.add(this.points);

    for (const node of network.nodeList) {
      this.createNodeVisual(node);
    }
  }

  update(interaction: InteractionController, timeSeconds: number): void {
    if (!this.network) {
      return;
    }

    const store = this.network.particles;
    const glowWidth = 0.085 * this.config.visualScale;
    const coreWidth = 0.014 * this.config.visualScale;
    const cameraPosition = this.camera.position;
    for (const visual of this.strandVisuals) {
      visual.glow.update(
        store,
        glowWidth,
        cameraPosition.x,
        cameraPosition.y,
        cameraPosition.z,
        0.005,
      );
      visual.core.update(
        store,
        coreWidth,
        cameraPosition.x,
        cameraPosition.y,
        cameraPosition.z,
        0.012,
      );
      visual.glow.updateTensionColors(
        visual.strand,
        this.tensionScale,
        this.config.showTension,
      );
      visual.core.updateTensionColors(
        visual.strand,
        this.tensionScale,
        this.config.showTension,
      );
      visual.debugLine.visible = this.config.showDebugLines;

      for (let point = 0; point < visual.strand.pointCount; point += 1) {
        const sourceOffset = visual.strand.particleIndices[point] * 3;
        const targetOffset = point * 3;
        visual.debugPositions[targetOffset] = store.positions[sourceOffset];
        visual.debugPositions[targetOffset + 1] = store.positions[sourceOffset + 1];
        visual.debugPositions[targetOffset + 2] = store.positions[sourceOffset + 2];
      }
      visual.debugAttribute.needsUpdate = true;
      this.updateStrandLabel(visual);
    }

    if (this.points) {
      this.points.visible = this.config.showPoints;
      this.instanceTransform.quaternion.copy(this.camera.quaternion);
      for (let particle = 0; particle < store.count; particle += 1) {
        const offset = particle * 3;
        const isFixed = store.inverseMasses[particle] === 0;
        this.instanceTransform.position.set(
          store.positions[offset],
          store.positions[offset + 1],
          store.positions[offset + 2],
        );
        const scale = isFixed ? 1.35 : 0.8;
        this.instanceTransform.scale.setScalar(scale);
        this.instanceTransform.updateMatrix();
        this.points.setMatrixAt(particle, this.instanceTransform.matrix);
      }
      this.points.instanceMatrix.needsUpdate = true;
    }

    this.updateNodeVisuals();
    this.updateInteractionVisuals(interaction, timeSeconds);
  }

  private updateNodeVisuals(): void {
    if (!this.network) {
      return;
    }

    const positions = this.network.particles.positions;
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    for (const visual of this.nodeVisuals) {
      const offset = visual.node.particleIndex * 3;
      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      visual.group.position.set(x, y, z);
      visual.group.quaternion.copy(this.camera.quaternion);

      visual.label.hidden = !this.config.showNodeIds;
      if (!visual.label.hidden) {
        this.projection.set(x, y, z).project(this.camera);
        const screenX = (this.projection.x * 0.5 + 0.5) * width;
        const screenY = (-this.projection.y * 0.5 + 0.5) * height;
        visual.label.style.transform = `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`;
      }
    }
  }

  private updateStrandLabel(visual: StrandVisual): void {
    visual.label.hidden = !this.config.showStrandIds;
    if (visual.label.hidden || !this.network) {
      return;
    }

    const location = visual.strand.resolveNormalizedLocation(0.5, this.labelLocation);
    const particleA = visual.strand.particleIndices[location.segmentIndex];
    const particleB = visual.strand.particleIndices[location.segmentIndex + 1];
    const offsetA = particleA * 3;
    const offsetB = particleB * 3;
    const positions = this.network.particles.positions;
    this.projection
      .set(
        positions[offsetA] * (1 - location.t) + positions[offsetB] * location.t,
        positions[offsetA + 1] * (1 - location.t) + positions[offsetB + 1] * location.t,
        positions[offsetA + 2] * (1 - location.t) + positions[offsetB + 2] * location.t,
      )
      .project(this.camera);
    const screenX = (this.projection.x * 0.5 + 0.5) * this.canvas.clientWidth;
    const screenY = (-this.projection.y * 0.5 + 0.5) * this.canvas.clientHeight;
    visual.label.style.transform =
      `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`;
  }

  private updateInteractionVisuals(interaction: InteractionController, timeSeconds: number): void {
    const hasMarker = interaction.writeMarkerPosition(this.markerPosition);
    this.markerGroup.visible = hasMarker;
    if (hasMarker) {
      this.markerGroup.position.copy(this.markerPosition);
      this.markerGroup.quaternion.copy(this.camera.quaternion);
      const pulse = 1 + Math.sin(timeSeconds * 5.5) * 0.08;
      this.markerRing.scale.setScalar(pulse);
    }

    const selected = interaction.hasSelection;
    this.contactLabel.hidden = !selected || !this.config.showClosestQuery;
    if (!this.contactLabel.hidden && interaction.writeSelectedPosition(this.markerPosition)) {
      this.projection.copy(this.markerPosition).project(this.camera);
      const screenX = (this.projection.x * 0.5 + 0.5) * this.canvas.clientWidth;
      const screenY = (-this.projection.y * 0.5 + 0.5) * this.canvas.clientHeight;
      this.contactLabel.style.transform = `translate3d(${screenX.toFixed(1)}px, ${screenY.toFixed(1)}px, 0)`;
    }

    this.forceLine.visible = this.config.showDebugLines && interaction.isDragging;
    if (this.forceLine.visible && interaction.writeSelectedPosition(this.markerPosition)) {
      this.forceLinePositions[0] = this.markerPosition.x;
      this.forceLinePositions[1] = this.markerPosition.y;
      this.forceLinePositions[2] = this.markerPosition.z;
      this.forceLinePositions[3] = interaction.dragTarget.x;
      this.forceLinePositions[4] = interaction.dragTarget.y;
      this.forceLinePositions[5] = interaction.dragTarget.z;
      this.forceLineAttribute.needsUpdate = true;
    }
  }

  private createNodeVisual(node: WebNode): void {
    const group = new THREE.Group();
    const halo = new THREE.Mesh(
      node.isFixed ? this.anchorHaloGeometry : this.junctionHaloGeometry,
      node.isFixed ? this.anchorHaloMaterial : this.junctionHaloMaterial,
    );
    const ring = new THREE.Mesh(
      node.isFixed ? this.anchorRingGeometry : this.junctionRingGeometry,
      node.isFixed ? this.anchorMaterial : this.junctionMaterial,
    );
    const core = new THREE.Mesh(
      node.isFixed ? this.anchorCoreGeometry : this.junctionCoreGeometry,
      node.isFixed ? this.anchorMaterial : this.junctionMaterial,
    );
    if (!node.isFixed) {
      halo.rotation.z = Math.PI * 0.25;
      ring.rotation.z = Math.PI * 0.25;
      core.rotation.z = Math.PI * 0.25;
    }
    halo.renderOrder = 4;
    ring.renderOrder = 5;
    core.renderOrder = 6;
    group.add(halo, ring, core);
    this.webGroup.add(group);

    const label = document.createElement("div");
    label.className = node.isFixed ? "node-label" : "node-label node-label-junction";
    label.innerHTML = `<span>${node.id}</span><i>${node.label} / ${node.isFixed ? "FIXED" : "MOVABLE"}</i>`;
    this.labelLayer.append(label);
    this.nodeVisuals.push({ node, group, label });
  }

  private clearNetworkVisuals(): void {
    for (const visual of this.strandVisuals) {
      this.webGroup.remove(visual.glow.mesh, visual.core.mesh, visual.debugLine);
      visual.glow.dispose();
      visual.core.dispose();
      visual.debugLine.geometry.dispose();
      visual.debugLine.material.dispose();
      visual.label.remove();
    }
    this.strandVisuals.length = 0;

    if (this.points) {
      this.webGroup.remove(this.points);
      this.points.dispose();
      this.points = null;
    }

    for (const visual of this.nodeVisuals) {
      this.webGroup.remove(visual.group);
      visual.label.remove();
    }
    this.nodeVisuals.length = 0;
    this.markerGroup.visible = false;
    this.forceLine.visible = false;
    this.contactLabel.hidden = true;
  }

  private addLabGrid(scene: THREE.Scene): void {
    const grid = new THREE.GridHelper(24, 48, 0x1a3546, 0x10202b);
    grid.position.y = -3.45;
    grid.material.transparent = true;
    grid.material.opacity = 0.16;
    grid.material.depthWrite = false;
    scene.add(grid);
  }
}
