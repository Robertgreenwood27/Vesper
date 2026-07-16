import type { WebNode } from "./WebNode";

export interface StrandLocation {
  segmentIndex: number;
  t: number;
  u: number;
}

/**
 * Topology and material data for one strand.
 * Rendering never writes to this object; it only reads the particle indices.
 */
export class WebStrand {
  active = true;
  broken = false;
  maximumStretch = 0;
  approximateTension = 0;

  readonly prefixRestLengths: Float32Array;
  readonly lambdas: Float32Array;
  readonly segmentTensions: Float32Array;
  readonly totalRestLength: number;

  constructor(
    readonly id: string,
    readonly startNode: WebNode,
    readonly endNode: WebNode,
    readonly particleIndices: Uint32Array,
    readonly restLengths: Float32Array,
    public stiffness: number,
    public damping: number,
    readonly linearDensity: number,
  ) {
    if (particleIndices.length < 2 || restLengths.length !== particleIndices.length - 1) {
      throw new Error(`Invalid topology for strand ${id}.`);
    }

    this.lambdas = new Float32Array(restLengths.length);
    this.segmentTensions = new Float32Array(restLengths.length);
    this.prefixRestLengths = new Float32Array(particleIndices.length);

    let total = 0;
    for (let segment = 0; segment < restLengths.length; segment += 1) {
      total += restLengths[segment];
      this.prefixRestLengths[segment + 1] = total;
    }
    this.totalRestLength = total;
  }

  get pointCount(): number {
    return this.particleIndices.length;
  }

  get constraintCount(): number {
    return this.restLengths.length;
  }

  normalizedLocation(segmentIndex: number, t: number): number {
    const clampedSegment = Math.max(0, Math.min(this.constraintCount - 1, segmentIndex));
    const clampedT = Math.max(0, Math.min(1, t));
    const distance =
      this.prefixRestLengths[clampedSegment] + this.restLengths[clampedSegment] * clampedT;
    return this.totalRestLength > 0 ? distance / this.totalRestLength : 0;
  }

  resolveNormalizedLocation(u: number, target: StrandLocation): StrandLocation {
    const clampedU = Math.max(0, Math.min(1, u));
    const targetDistance = clampedU * this.totalRestLength;

    let segmentIndex = this.constraintCount - 1;
    for (let segment = 0; segment < this.constraintCount; segment += 1) {
      if (targetDistance <= this.prefixRestLengths[segment + 1]) {
        segmentIndex = segment;
        break;
      }
    }

    const segmentStart = this.prefixRestLengths[segmentIndex];
    const segmentLength = this.restLengths[segmentIndex];
    target.segmentIndex = segmentIndex;
    target.t = segmentLength > 0 ? (targetDistance - segmentStart) / segmentLength : 0;
    target.u = clampedU;
    return target;
  }

  resetConstraintState(): void {
    this.lambdas.fill(0);
    this.segmentTensions.fill(0);
    this.maximumStretch = 0;
    this.approximateTension = 0;
  }
}
