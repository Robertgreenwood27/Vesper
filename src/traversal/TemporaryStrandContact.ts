import type { WebNetwork } from "../web/WebNetwork";
import type { WebStrand } from "../web/WebStrand";
import type { MutableVec3, StrandAddress } from "./types";

export interface TemporaryContactLocation extends StrandAddress {
  segmentIndex: number;
  segmentT: number;
  particleA: number;
  particleB: number;
  weightA: number;
  weightB: number;
}

export interface TemporaryContactState {
  attached: boolean;
  strandId: string | null;
  t: number;
  slideSpeed: number;
  forceX: number;
  forceY: number;
  forceZ: number;
  supportedMass: number;
  gravityX: number;
  gravityY: number;
  gravityZ: number;
}

const clamp01 = (value: number): number => Math.max(0, Math.min(1, value));

/**
 * A transient load addressed by strand ID and normalized material distance.
 *
 * This contact deliberately owns no particle or WebNode. During a fixed step,
 * its point force is distributed to the two particles that bracket its current
 * strand address using linear shape weights. Call `applyFixedStep` from
 * `WebPhysicsSolver.step`'s external-force callback, after the solver has
 * cleared the force buffer and before integration begins.
 */
export class TemporaryStrandContact {
  private attachedStrandId: string | null = null;
  private normalizedT = 0;
  private normalizedSlideSpeed = 0;

  private forceX = 0;
  private forceY = 0;
  private forceZ = 0;

  private supportedMass = 0;
  private gravityX = 0;
  private gravityY = -9.81;
  private gravityZ = 0;

  private readonly resolvedLocation = { segmentIndex: 0, t: 0, u: 0 };

  constructor(private network: WebNetwork) {}

  get isAttached(): boolean {
    return this.attachedStrandId !== null;
  }

  get strandId(): string | null {
    return this.attachedStrandId;
  }

  /** Normalized material distance along the attached strand. */
  get t(): number {
    return this.normalizedT;
  }

  /** Normalized strand distance travelled per second. */
  get slideSpeed(): number {
    return this.normalizedSlideSpeed;
  }

  /**
   * Rebinds the contact service after a network rebuild. An attachment is kept
   * only when a strand with the same ID still exists and is traversable.
   */
  setNetwork(network: WebNetwork): void {
    this.network = network;
    if (this.attachedStrandId !== null && !this.getTraversableStrand(this.attachedStrandId)) {
      this.release();
    }
  }

  attach(strandId: string, t: number): this {
    this.assertFinite(t, "Contact t");
    if (!this.getTraversableStrand(strandId)) {
      throw new Error(`Cannot attach to missing, inactive, or broken strand ${strandId}.`);
    }

    this.attachedStrandId = strandId;
    this.normalizedT = clamp01(t);
    this.normalizedSlideSpeed = 0;
    return this;
  }

  /** Releases without changing network topology or leaving a residual constraint. */
  release(): void {
    this.attachedStrandId = null;
    this.normalizedT = 0;
    this.normalizedSlideSpeed = 0;
  }

  setForce(x: number, y: number, z: number): this {
    this.assertVector(x, y, z, "Contact force");
    this.forceX = x;
    this.forceY = y;
    this.forceZ = z;
    return this;
  }

  clearForce(): this {
    this.forceX = 0;
    this.forceY = 0;
    this.forceZ = 0;
    return this;
  }

  /**
   * Configures an attached mass whose weight is added to the explicit force.
   * Set mass to zero to disable weight while retaining the explicit force.
   */
  setWeight(
    mass: number,
    gravityX = this.gravityX,
    gravityY = this.gravityY,
    gravityZ = this.gravityZ,
  ): this {
    if (!Number.isFinite(mass) || mass < 0) {
      throw new Error("Contact mass must be a finite, non-negative number.");
    }
    this.assertVector(gravityX, gravityY, gravityZ, "Contact gravity");
    this.supportedMass = mass;
    this.gravityX = gravityX;
    this.gravityY = gravityY;
    this.gravityZ = gravityZ;
    return this;
  }

  setGravity(x: number, y: number, z: number): this {
    this.assertVector(x, y, z, "Contact gravity");
    this.gravityX = x;
    this.gravityY = y;
    this.gravityZ = z;
    return this;
  }

  /** Starts or updates continuous motion in normalized strand units per second. */
  commandSlide(normalizedDistancePerSecond: number): this {
    this.assertFinite(normalizedDistancePerSecond, "Contact slide speed");
    this.normalizedSlideSpeed = normalizedDistancePerSecond;
    return this;
  }

  stopSliding(): this {
    this.normalizedSlideSpeed = 0;
    return this;
  }

  moveTo(t: number): this {
    this.requireAttachment();
    this.assertFinite(t, "Contact t");
    this.normalizedT = clamp01(t);
    return this;
  }

  moveBy(normalizedDistance: number): this {
    this.requireAttachment();
    this.assertFinite(normalizedDistance, "Contact distance");
    this.normalizedT = clamp01(this.normalizedT + normalizedDistance);
    return this;
  }

  /**
   * Advances a commanded slide and applies this contact's load for one solver
   * step. Returns false when detached or when the strand is no longer usable.
   */
  applyFixedStep(fixedDelta: number): boolean {
    if (!Number.isFinite(fixedDelta) || fixedDelta < 0) {
      throw new Error("Fixed delta must be a finite, non-negative number.");
    }

    const strand = this.getAttachedTraversableStrand();
    if (!strand) {
      return false;
    }

    if (this.normalizedSlideSpeed !== 0 && fixedDelta > 0) {
      this.normalizedT = clamp01(
        this.normalizedT + this.normalizedSlideSpeed * fixedDelta,
      );
      if (
        (this.normalizedT === 0 && this.normalizedSlideSpeed < 0) ||
        (this.normalizedT === 1 && this.normalizedSlideSpeed > 0)
      ) {
        this.normalizedSlideSpeed = 0;
      }
    }

    const location = strand.resolveNormalizedLocation(this.normalizedT, this.resolvedLocation);
    const segment = location.segmentIndex;
    const particleA = strand.particleIndices[segment];
    const particleB = strand.particleIndices[segment + 1];
    const weightB = clamp01(location.t);
    const weightA = 1 - weightB;
    const totalForceX = this.forceX + this.supportedMass * this.gravityX;
    const totalForceY = this.forceY + this.supportedMass * this.gravityY;
    const totalForceZ = this.forceZ + this.supportedMass * this.gravityZ;
    const forces = this.network.particles.forces;
    const offsetA = particleA * 3;
    const offsetB = particleB * 3;

    forces[offsetA] += totalForceX * weightA;
    forces[offsetA + 1] += totalForceY * weightA;
    forces[offsetA + 2] += totalForceZ * weightA;
    forces[offsetB] += totalForceX * weightB;
    forces[offsetB + 1] += totalForceY * weightB;
    forces[offsetB + 2] += totalForceZ * weightB;
    return true;
  }

  getAddress(): StrandAddress | null {
    return this.attachedStrandId === null
      ? null
      : { strandId: this.attachedStrandId, t: this.normalizedT };
  }

  getLocation(): TemporaryContactLocation | null {
    const strand = this.getAttachedTraversableStrand();
    if (!strand || this.attachedStrandId === null) {
      return null;
    }

    const location = strand.resolveNormalizedLocation(this.normalizedT, this.resolvedLocation);
    const weightB = clamp01(location.t);
    return {
      strandId: this.attachedStrandId,
      t: this.normalizedT,
      segmentIndex: location.segmentIndex,
      segmentT: weightB,
      particleA: strand.particleIndices[location.segmentIndex],
      particleB: strand.particleIndices[location.segmentIndex + 1],
      weightA: 1 - weightB,
      weightB,
    };
  }

  /** Writes the current interpolated contact position without allocating. */
  writeWorldPosition(target: MutableVec3): boolean {
    const strand = this.getAttachedTraversableStrand();
    if (!strand) {
      return false;
    }

    const location = strand.resolveNormalizedLocation(this.normalizedT, this.resolvedLocation);
    const particleA = strand.particleIndices[location.segmentIndex];
    const particleB = strand.particleIndices[location.segmentIndex + 1];
    const weightB = clamp01(location.t);
    const weightA = 1 - weightB;

    const positions = this.network.particles.positions;
    const offsetA = particleA * 3;
    const offsetB = particleB * 3;
    target.x =
      positions[offsetA] * weightA + positions[offsetB] * weightB;
    target.y =
      positions[offsetA + 1] * weightA + positions[offsetB + 1] * weightB;
    target.z =
      positions[offsetA + 2] * weightA + positions[offsetB + 2] * weightB;
    return true;
  }

  /** Writes explicit force plus configured weight. */
  writeAppliedForce(target: MutableVec3): void {
    target.x = this.forceX + this.supportedMass * this.gravityX;
    target.y = this.forceY + this.supportedMass * this.gravityY;
    target.z = this.forceZ + this.supportedMass * this.gravityZ;
  }

  getState(): TemporaryContactState {
    return {
      attached: this.isAttached,
      strandId: this.attachedStrandId,
      t: this.normalizedT,
      slideSpeed: this.normalizedSlideSpeed,
      forceX: this.forceX,
      forceY: this.forceY,
      forceZ: this.forceZ,
      supportedMass: this.supportedMass,
      gravityX: this.gravityX,
      gravityY: this.gravityY,
      gravityZ: this.gravityZ,
    };
  }

  private getAttachedTraversableStrand(): WebStrand | null {
    if (this.attachedStrandId === null) {
      return null;
    }
    const strand = this.getTraversableStrand(this.attachedStrandId);
    if (!strand) {
      this.release();
    }
    return strand;
  }

  private getTraversableStrand(strandId: string): WebStrand | null {
    const strand = this.network.strands.get(strandId);
    return strand && strand.active && !strand.broken ? strand : null;
  }

  private requireAttachment(): void {
    if (this.attachedStrandId === null) {
      throw new Error("Temporary strand contact is not attached.");
    }
  }

  private assertFinite(value: number, label: string): void {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be finite.`);
    }
  }

  private assertVector(x: number, y: number, z: number, label: string): void {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      throw new Error(`${label} components must be finite.`);
    }
  }
}
