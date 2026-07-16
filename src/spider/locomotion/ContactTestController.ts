import {
  TemporaryStrandContact,
  type MutableVec3,
  type StrandAddress,
  type StrandTraversal,
  type Vec3Like,
} from "../../traversal";
import type { WebNetwork } from "../../web/WebNetwork";

export interface ContactTestSnapshot {
  readonly address: StrandAddress | null;
  readonly position: MutableVec3;
  readonly velocity: MutableVec3;
  readonly force: MutableVec3;
  tension: number;
  valid: boolean;
  finite: boolean;
  message: string;
}

const EPSILON = 1e-9;

function mutableVector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

/**
 * A short-lived semantic probe. It deforms the two bracketing simulation
 * points through TemporaryStrandContact without becoming a web node or a
 * durable foot contact.
 */
export class ContactTestController {
  readonly contact: TemporaryStrandContact;
  readonly snapshot: ContactTestSnapshot = {
    address: null,
    position: mutableVector(),
    velocity: mutableVector(),
    force: mutableVector(),
    tension: 0,
    valid: false,
    finite: true,
    message: "Probe is idle.",
  };

  private addressValue: StrandAddress | null = null;

  constructor(
    network: WebNetwork,
    private readonly traversal: StrandTraversal,
  ) {
    this.contact = new TemporaryStrandContact(network);
  }

  begin(address: StrandAddress, supportUp: Vec3Like, forceMagnitude: number): boolean {
    this.release();
    if (!finiteVector(supportUp) || !Number.isFinite(forceMagnitude) || forceMagnitude < 0) {
      this.invalidate("Probe force or local support-up is non-finite.");
      return false;
    }
    const upLength = Math.hypot(supportUp.x, supportUp.y, supportUp.z);
    if (upLength <= EPSILON) {
      this.invalidate("Probe local support-up is degenerate.");
      return false;
    }
    try {
      this.contact
        .attach(address.strandId, address.t)
        .setForce(
          (-supportUp.x / upLength) * forceMagnitude,
          (-supportUp.y / upLength) * forceMagnitude,
          (-supportUp.z / upLength) * forceMagnitude,
        );
      this.addressValue = { strandId: address.strandId, t: address.t };
      (this.snapshot as { address: StrandAddress | null }).address = this.addressValue;
      this.contact.writeAppliedForce(this.snapshot.force);
      this.snapshot.valid = true;
      this.snapshot.finite = true;
      this.snapshot.message = "Probe attached at a continuous strand address.";
      return this.refresh();
    } catch (error) {
      this.invalidate(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  applyFixedStep(fixedDelta: number): boolean {
    if (!this.contact.isAttached) return false;
    const applied = this.contact.applyFixedStep(fixedDelta);
    if (!applied) this.invalidate("Probe target strand became unavailable.");
    return applied;
  }

  refresh(): boolean {
    const address = this.addressValue;
    if (!address || !this.contact.isAttached) {
      this.snapshot.valid = false;
      return false;
    }
    try {
      const state = this.traversal.getStrandState(address.strandId);
      this.contact.writeWorldPosition(this.snapshot.position);
      this.traversal.getLocalVelocity(address, this.snapshot.velocity);
      this.snapshot.tension = this.traversal.getApproximateLocalTension(address);
      this.snapshot.finite =
        finiteVector(this.snapshot.position) &&
        finiteVector(this.snapshot.velocity) &&
        finiteVector(this.snapshot.force) &&
        Number.isFinite(this.snapshot.tension);
      this.snapshot.valid = state.traversable && this.snapshot.finite;
      this.snapshot.message = this.snapshot.valid
        ? "Probe response is finite and the strand remains traversable."
        : state.traversable
          ? "Probe response became non-finite."
          : "Probe target strand is inactive or broken.";
      return this.snapshot.valid;
    } catch (error) {
      this.invalidate(error instanceof Error ? error.message : String(error));
      return false;
    }
  }

  release(): void {
    this.contact.release();
    this.addressValue = null;
    (this.snapshot as { address: StrandAddress | null }).address = null;
    this.snapshot.force.x = 0;
    this.snapshot.force.y = 0;
    this.snapshot.force.z = 0;
    this.snapshot.tension = 0;
    this.snapshot.valid = false;
    this.snapshot.finite = true;
    this.snapshot.message = "Probe is idle.";
  }

  private invalidate(message: string): void {
    this.contact.release();
    this.snapshot.valid = false;
    this.snapshot.finite = false;
    this.snapshot.message = message;
  }
}

