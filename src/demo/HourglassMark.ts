import * as THREE from "three";
import type { SpiderRig } from "../spider/SpiderRig";

/**
 * The red hourglass.
 *
 * It is the one marking that makes a black widow a black widow, and it lives
 * on the *ventral* abdomen — which is exactly the side a keeper sees, because
 * a widow hangs inverted under her web with her belly to the silk. The GLB has
 * no UVs worth trusting and its bone axes proved slippery in practice, so
 * nothing here is assumed: the abdomen's vertices are collected from the skin
 * weights, the ventral direction is read from the settled pose itself (world
 * up, transformed into the abdomen bone's frame), and the mark is draped onto
 * the measured surface point by point. If the model changes, the mark follows.
 *
 * Call after the spider has settled into her hanging pose.
 */

/** Collects bind-pose vertices dominated by the abdomen bone, in bone-local space. */
function collectAbdomenVertices(mesh: THREE.SkinnedMesh, abdomen: THREE.Bone): THREE.Vector3[] {
  const skeleton = mesh.skeleton;
  const boneIndex = skeleton.bones.indexOf(abdomen);
  if (boneIndex < 0) return [];

  const geometry = mesh.geometry;
  const positions = geometry.getAttribute("position");
  const skinIndices = geometry.getAttribute("skinIndex");
  const skinWeights = geometry.getAttribute("skinWeight");
  if (!positions || !skinIndices || !skinWeights) return [];

  const toBoneLocal = new THREE.Matrix4()
    .copy(skeleton.boneInverses[boneIndex])
    .multiply(mesh.bindMatrix);

  const collected: THREE.Vector3[] = [];
  for (let i = 0; i < positions.count; i += 1) {
    let weight = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      if (skinIndices.getComponent(i, slot) === boneIndex) {
        weight += skinWeights.getComponent(i, slot);
      }
    }
    if (weight < 0.6) continue;
    collected.push(new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(toBoneLocal));
  }
  return collected;
}

/** Paints the hourglass: two soft-edged lobes meeting at a narrow waist. */
function paintHourglass(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, size, size);
    const cx = size / 2;
    const cy = size / 2;
    // A live widow's hourglass is not printer-red: it grades from deep
    // crimson at the edges to an almost orange heart.
    const fill = ctx.createRadialGradient(cx, cy, 8, cx, cy, size * 0.42);
    fill.addColorStop(0, "#ff4a26");
    fill.addColorStop(0.55, "#d3122a");
    fill.addColorStop(1, "#8d0a1e");
    ctx.fillStyle = fill;
    ctx.filter = "blur(2.5px)";

    const halfWidth = size * 0.17;
    const halfHeight = size * 0.27;
    const waist = size * 0.035;
    const drawLobe = (direction: 1 | -1): void => {
      ctx.beginPath();
      ctx.moveTo(cx - waist, cy + direction * waist * 0.6);
      ctx.quadraticCurveTo(
        cx - halfWidth * 0.9,
        cy + direction * halfHeight * 0.45,
        cx - halfWidth,
        cy + direction * halfHeight,
      );
      ctx.quadraticCurveTo(cx, cy + direction * halfHeight * 1.18, cx + halfWidth, cy + direction * halfHeight);
      ctx.quadraticCurveTo(
        cx + halfWidth * 0.9,
        cy + direction * halfHeight * 0.45,
        cx + waist,
        cy + direction * waist * 0.6,
      );
      ctx.closePath();
      ctx.fill();
    };
    drawLobe(1);
    drawLobe(-1);
    ctx.filter = "none";
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

const scratchMatrix = new THREE.Matrix4();

/** Transforms a world-space direction into the bone's local frame. */
function worldDirectionToBoneLocal(bone: THREE.Bone, worldDirection: THREE.Vector3): THREE.Vector3 {
  scratchMatrix.copy(bone.matrixWorld).invert();
  return worldDirection.clone().transformDirection(scratchMatrix).normalize();
}

/**
 * Attaches the hourglass to the settled rig. `worldVentral` is the direction
 * the spider's belly currently faces (world up, for a widow hanging beneath
 * her silk). Returns false if the abdomen resisted measurement.
 */
export function attachHourglass(
  rig: SpiderRig,
  worldVentral = new THREE.Vector3(0, 1, 0),
): boolean {
  const vertices = collectAbdomenVertices(rig.mesh, rig.abdomen);
  if (vertices.length < 64) return false;

  const center = new THREE.Vector3();
  for (const vertex of vertices) center.add(vertex);
  center.divideScalar(vertices.length);

  rig.mesh.skeleton.update();
  rig.abdomen.updateWorldMatrix(true, false);

  // The pose is the authority on anatomy: her belly faces the silk, so world
  // up in the settled pose *is* ventral, expressed in the bone's frame.
  const ventralAxis = worldDirectionToBoneLocal(rig.abdomen, worldVentral);

  // The long axis runs head-to-tail: the bone's own Y, squared against ventral.
  const tailAxis = new THREE.Vector3(0, 1, 0)
    .addScaledVector(ventralAxis, -ventralAxis.y)
    .normalize();
  if (tailAxis.lengthSq() < 0.25) return false;
  const sideAxis = new THREE.Vector3().crossVectors(tailAxis, ventralAxis).normalize();

  // Drape a grid over the ventral surface. Each grid direction takes its
  // radius from the outermost measured vertex inside a cone around it, so the
  // mark hugs the real, asymmetric abdomen instead of an idealized ellipsoid.
  const longitudeSpan = 0.66; // radians either side of dead-ventral
  const latitudeSpan = 0.58; // radians head-to-tail
  // The world-up direction grazes the tail end of the tilted abdomen, but the
  // hourglass lives midway along the belly — slide the patch toward the pedicel.
  const latitudeOffset = -0.15;
  const segments = 20;
  const coneCosine = Math.cos(THREE.MathUtils.degToRad(32));
  // The skinned surface sits a little proud of the bind-pose drape, so the
  // lift is generous; the texture's soft edges hide the offset at grazing angles.
  const lift = 1.06;

  const offsets = vertices.map((vertex) => vertex.clone().sub(center));
  const fallbackRadius = offsets.reduce((sum, offset) => sum + offset.length(), 0) / offsets.length;

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const direction = new THREE.Vector3();

  for (let row = 0; row <= segments; row += 1) {
    const lat = latitudeOffset + THREE.MathUtils.lerp(-latitudeSpan, latitudeSpan, row / segments);
    for (let col = 0; col <= segments; col += 1) {
      const lon = THREE.MathUtils.lerp(-longitudeSpan, longitudeSpan, col / segments);
      direction
        .copy(ventralAxis)
        .multiplyScalar(Math.cos(lat) * Math.cos(lon))
        .addScaledVector(tailAxis, Math.sin(lat))
        .addScaledVector(sideAxis, Math.cos(lat) * Math.sin(lon));

      let radius = 0;
      for (const offset of offsets) {
        const along = offset.dot(direction);
        if (along <= radius) continue;
        if (along * along >= offset.lengthSq() * coneCosine * coneCosine) {
          radius = along;
        }
      }
      // Stray vertices near the spinnerets can spike a sample; keep the drape
      // within honest reach of the average surface.
      radius = radius <= 0
        ? fallbackRadius
        : THREE.MathUtils.clamp(radius, fallbackRadius * 0.7, fallbackRadius * 1.35);

      positions.push(
        center.x + direction.x * radius * lift,
        center.y + direction.y * radius * lift,
        center.z + direction.z * radius * lift,
      );
      normals.push(direction.x, direction.y, direction.z);
      uvs.push(col / segments, row / segments);
    }
  }

  for (let row = 0; row < segments; row += 1) {
    for (let col = 0; col < segments; col += 1) {
      const a = row * (segments + 1) + col;
      const b = a + 1;
      const c = a + segments + 1;
      const d = c + 1;
      indices.push(a, b, c, b, d, c);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);

  const material = new THREE.MeshStandardMaterial({
    map: paintHourglass(),
    transparent: true,
    roughness: 0.34,
    metalness: 0,
    depthWrite: false,
    // The cuticle around the mark is glossy; let the mark share the sheen and
    // keep a faint ember of its own so it never fully drowns in shadow.
    emissive: new THREE.Color(0x30060a),
    emissiveIntensity: 0.55,
  });

  const patch = new THREE.Mesh(geometry, material);
  patch.name = "hourglass-mark";
  patch.renderOrder = 1;
  rig.abdomen.add(patch);
  return true;
}
