import * as THREE from "three";
import type { ParticleStore } from "../web/ParticleStore";
import type { WebStrand } from "../web/WebStrand";

/** A camera-facing GPU ribbon whose centerline mirrors physics particles. */
export class DynamicRibbon {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;

  private readonly positions: Float32Array;
  private readonly positionAttribute: THREE.BufferAttribute;
  private readonly colors: Float32Array;
  private readonly colorAttribute: THREE.BufferAttribute;

  constructor(
    private readonly particleIndices: Uint32Array,
    material: THREE.MeshBasicMaterial,
  ) {
    const pointCount = particleIndices.length;
    this.positions = new Float32Array(pointCount * 2 * 3);
    this.positionAttribute = new THREE.BufferAttribute(this.positions, 3);
    this.positionAttribute.setUsage(THREE.DynamicDrawUsage);
    this.colors = new Float32Array(pointCount * 2 * 3);
    this.colorAttribute = new THREE.BufferAttribute(this.colors, 3);
    this.colorAttribute.setUsage(THREE.DynamicDrawUsage);

    const indices = new Uint16Array((pointCount - 1) * 6);
    for (let segment = 0; segment < pointCount - 1; segment += 1) {
      const vertex = segment * 2;
      const offset = segment * 6;
      indices[offset] = vertex;
      indices[offset + 1] = vertex + 1;
      indices[offset + 2] = vertex + 2;
      indices[offset + 3] = vertex + 1;
      indices[offset + 4] = vertex + 3;
      indices[offset + 5] = vertex + 2;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", this.positionAttribute);
    geometry.setAttribute("color", this.colorAttribute);
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
  }

  update(
    store: ParticleStore,
    halfWidth: number,
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    cameraOffset: number,
  ): void {
    const source = store.positions;
    const pointCount = this.particleIndices.length;

    for (let point = 0; point < pointCount; point += 1) {
      const previousPoint = Math.max(0, point - 1);
      const nextPoint = Math.min(pointCount - 1, point + 1);
      const currentOffset = this.particleIndices[point] * 3;
      const previousOffset = this.particleIndices[previousPoint] * 3;
      const nextOffset = this.particleIndices[nextPoint] * 3;
      const tangentX = source[nextOffset] - source[previousOffset];
      const tangentY = source[nextOffset + 1] - source[previousOffset + 1];
      const tangentZ = source[nextOffset + 2] - source[previousOffset + 2];
      const vertexOffset = point * 6;
      const x = source[currentOffset];
      const y = source[currentOffset + 1];
      const z = source[currentOffset + 2];

      let viewX = cameraX - x;
      let viewY = cameraY - y;
      let viewZ = cameraZ - z;
      const viewLength = Math.hypot(viewX, viewY, viewZ);
      if (viewLength > 1e-8) {
        viewX /= viewLength;
        viewY /= viewLength;
        viewZ /= viewLength;
      }

      // A 3D camera-facing ribbon uses tangent x view as its screen-space
      // width. The fallbacks cover an end-on strand without allocating vectors.
      let sideX = tangentY * viewZ - tangentZ * viewY;
      let sideY = tangentZ * viewX - tangentX * viewZ;
      let sideZ = tangentX * viewY - tangentY * viewX;
      let sideLength = Math.hypot(sideX, sideY, sideZ);
      if (sideLength < 1e-8) {
        sideX = -tangentZ;
        sideY = 0;
        sideZ = tangentX;
        sideLength = Math.hypot(sideX, sideZ);
      }
      if (sideLength < 1e-8) {
        sideX = 1;
        sideY = 0;
        sideZ = 0;
        sideLength = 1;
      }
      sideX /= sideLength;
      sideY /= sideLength;
      sideZ /= sideLength;
      const surfaceX = x + viewX * cameraOffset;
      const surfaceY = y + viewY * cameraOffset;
      const surfaceZ = z + viewZ * cameraOffset;

      this.positions[vertexOffset] = surfaceX + sideX * halfWidth;
      this.positions[vertexOffset + 1] = surfaceY + sideY * halfWidth;
      this.positions[vertexOffset + 2] = surfaceZ + sideZ * halfWidth;
      this.positions[vertexOffset + 3] = surfaceX - sideX * halfWidth;
      this.positions[vertexOffset + 4] = surfaceY - sideY * halfWidth;
      this.positions[vertexOffset + 5] = surfaceZ - sideZ * halfWidth;
    }

    this.positionAttribute.needsUpdate = true;
  }

  updateTensionColors(strand: WebStrand, scale: number, enabled: boolean): void {
    const pointCount = this.particleIndices.length;
    const safeScale = Math.max(1e-6, scale);

    for (let point = 0; point < pointCount; point += 1) {
      const leftTension = point > 0 ? strand.segmentTensions[point - 1] : 0;
      const rightTension =
        point < strand.constraintCount ? strand.segmentTensions[point] : 0;
      const sampleCount = (point > 0 ? 1 : 0) + (point < strand.constraintCount ? 1 : 0);
      const tension = sampleCount > 0 ? (leftTension + rightTension) / sampleCount : 0;
      const normalized = enabled ? Math.min(1, Math.max(0, tension / safeScale)) : 0;

      let red: number;
      let green: number;
      let blue: number;
      if (normalized < 0.55) {
        const mix = normalized / 0.55;
        red = 0.55 + (1 - 0.55) * mix;
        green = 0.9 + (0.66 - 0.9) * mix;
        blue = 1 + (0.25 - 1) * mix;
      } else {
        const mix = (normalized - 0.55) / 0.45;
        red = 1;
        green = 0.66 + (0.18 - 0.66) * mix;
        blue = 0.25 + (0.42 - 0.25) * mix;
      }

      const vertexOffset = point * 6;
      this.colors[vertexOffset] = red;
      this.colors[vertexOffset + 1] = green;
      this.colors[vertexOffset + 2] = blue;
      this.colors[vertexOffset + 3] = red;
      this.colors[vertexOffset + 4] = green;
      this.colors[vertexOffset + 5] = blue;
    }

    this.colorAttribute.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
  }
}
