import type { MutableVec3, Vec3Like } from "./types";

export const VECTOR_EPSILON = 1e-10;

export function createVec3(x = 0, y = 0, z = 0): MutableVec3 {
  return { x, y, z };
}

export function setVec3(out: MutableVec3, x: number, y: number, z: number): MutableVec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copyVec3(out: MutableVec3, value: Vec3Like): MutableVec3 {
  return setVec3(out, value.x, value.y, value.z);
}

export function dotVec3(a: Vec3Like, b: Vec3Like): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function crossVec3(out: MutableVec3, a: Vec3Like, b: Vec3Like): MutableVec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  return setVec3(out, x, y, z);
}

export function lengthSquaredVec3(value: Vec3Like): number {
  return dotVec3(value, value);
}

export function lengthVec3(value: Vec3Like): number {
  return Math.sqrt(lengthSquaredVec3(value));
}

export function normalizeVec3(out: MutableVec3, value: Vec3Like): boolean {
  const length = lengthVec3(value);
  if (length <= VECTOR_EPSILON) {
    setVec3(out, 0, 0, 0);
    return false;
  }
  const inverseLength = 1 / length;
  setVec3(out, value.x * inverseLength, value.y * inverseLength, value.z * inverseLength);
  return true;
}

export function projectOntoNormalPlane(
  out: MutableVec3,
  value: Vec3Like,
  unitNormal: Vec3Like,
): boolean {
  const projection = dotVec3(value, unitNormal);
  setVec3(
    out,
    value.x - unitNormal.x * projection,
    value.y - unitNormal.y * projection,
    value.z - unitNormal.z * projection,
  );
  return normalizeVec3(out, out);
}

/** Picks a deterministic unit vector perpendicular to `unitDirection`. */
export function perpendicularUnit(out: MutableVec3, unitDirection: Vec3Like): MutableVec3 {
  const ax = Math.abs(unitDirection.x);
  const ay = Math.abs(unitDirection.y);
  const az = Math.abs(unitDirection.z);

  if (ax <= ay && ax <= az) {
    setVec3(out, 0, -unitDirection.z, unitDirection.y);
  } else if (ay <= az) {
    setVec3(out, -unitDirection.z, 0, unitDirection.x);
  } else {
    setVec3(out, -unitDirection.y, unitDirection.x, 0);
  }
  normalizeVec3(out, out);
  return out;
}

/**
 * Rotation-minimizing transport from one tangent plane to another. This is the
 * core operation used to keep the strand frame from acquiring arbitrary roll.
 */
export function parallelTransportNormal(
  out: MutableVec3,
  normal: Vec3Like,
  fromTangent: Vec3Like,
  toTangent: Vec3Like,
): MutableVec3 {
  let axisX = fromTangent.y * toTangent.z - fromTangent.z * toTangent.y;
  let axisY = fromTangent.z * toTangent.x - fromTangent.x * toTangent.z;
  let axisZ = fromTangent.x * toTangent.y - fromTangent.y * toTangent.x;
  const sine = Math.sqrt(axisX * axisX + axisY * axisY + axisZ * axisZ);
  const cosine = Math.max(-1, Math.min(1, dotVec3(fromTangent, toTangent)));

  if (sine > 1e-7) {
    const inverseSine = 1 / sine;
    axisX *= inverseSine;
    axisY *= inverseSine;
    axisZ *= inverseSine;

    const axisDotNormal = axisX * normal.x + axisY * normal.y + axisZ * normal.z;
    const crossX = axisY * normal.z - axisZ * normal.y;
    const crossY = axisZ * normal.x - axisX * normal.z;
    const crossZ = axisX * normal.y - axisY * normal.x;
    setVec3(
      out,
      normal.x * cosine + crossX * sine + axisX * axisDotNormal * (1 - cosine),
      normal.y * cosine + crossY * sine + axisY * axisDotNormal * (1 - cosine),
      normal.z * cosine + crossZ * sine + axisZ * axisDotNormal * (1 - cosine),
    );
  } else if (cosine < 0) {
    // A 180-degree cusp has no unique minimal rotation. Rotating around the
    // prior normal preserves roll and is the least surprising continuation.
    copyVec3(out, normal);
  } else {
    copyVec3(out, normal);
  }

  if (!projectOntoNormalPlane(out, out, toTangent)) {
    perpendicularUnit(out, toTangent);
  }
  return out;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}
