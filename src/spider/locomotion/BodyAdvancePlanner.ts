import type { MutableVec3, StrandAddress, Vec3Like } from "../../traversal/index";

const EPSILON = 1e-10;

export interface HeldContactReachEstimate {
  readonly id: string;
  readonly address: StrandAddress;
  readonly contactWorldPosition: Vec3Like;
  /** Coxa/reach origin before this proposed body displacement. */
  readonly reachOriginWorldPosition: Vec3Like;
  readonly maximumReach: number;
  readonly minimumReach?: number;
  readonly valid?: boolean;
  readonly held?: boolean;
}

export interface BodyAdvancePlannerConfig {
  readonly maximumStepDistance: number;
  /** Fraction of each maximum reach available to planning. Defaults to 0.96. */
  readonly maximumReachSafetyFactor?: number;
  readonly arrivalTolerance?: number;
  readonly minimumProgressDistance?: number;
}

export interface BodyAdvanceInput {
  readonly currentBodyPosition: Vec3Like;
  readonly destinationWorldPosition: Vec3Like;
  readonly heldContacts: readonly HeldContactReachEstimate[];
}

export type BodyAdvanceFailureReason =
  | "none"
  | "non-finite-input"
  | "no-held-contacts"
  | "invalid-contact"
  | "contact-already-out-of-reach"
  | "maximum-reach-blocked"
  | "minimum-reach-blocked";

export type BodyAdvanceReachConstraint = "maximum" | "minimum" | null;

export interface BodyAdvancePlan {
  readonly displacement: MutableVec3;
  readonly targetBodyPosition: MutableVec3;
  success: boolean;
  failureReason: BodyAdvanceFailureReason;
  requestedDistance: number;
  plannedDistance: number;
  remainingDistance: number;
  clampedByMaximumStep: boolean;
  clampedByReach: boolean;
  anotherStepRequired: boolean;
  limitingContactId: string | null;
  limitingContactAddress: StrandAddress | null;
  limitingConstraint: BodyAdvanceReachConstraint;
  maximumPredictedReachRatio: number;
  heldContactCount: number;
}

function vector(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function finiteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function finiteAddress(address: StrandAddress): boolean {
  return Boolean(address.strandId) && Number.isFinite(address.t) && address.t >= 0 && address.t <= 1;
}

/**
 * Plans one finite body translation while every held semantic contact remains
 * fixed. Reach origins are assumed to translate one-for-one with the body;
 * articulation and contact selection remain controller/IK responsibilities.
 */
export class BodyAdvancePlanner {
  private readonly maximumStepDistance: number;
  private readonly maximumReachSafetyFactor: number;
  private readonly arrivalTolerance: number;
  private readonly minimumProgressDistance: number;

  constructor(config: BodyAdvancePlannerConfig) {
    if (!Number.isFinite(config.maximumStepDistance) || config.maximumStepDistance < 0) {
      throw new Error("Body advance maximum step distance must be finite and non-negative.");
    }
    const safetyFactor = config.maximumReachSafetyFactor ?? 0.96;
    if (!Number.isFinite(safetyFactor) || safetyFactor <= 0 || safetyFactor > 1) {
      throw new Error("Body advance maximum reach safety factor must be in (0, 1].");
    }
    const arrivalTolerance = config.arrivalTolerance ?? 1e-4;
    const minimumProgress = config.minimumProgressDistance ?? 1e-5;
    if (!Number.isFinite(arrivalTolerance) || arrivalTolerance < 0) {
      throw new Error("Body advance arrival tolerance must be finite and non-negative.");
    }
    if (!Number.isFinite(minimumProgress) || minimumProgress < 0) {
      throw new Error("Body advance minimum progress must be finite and non-negative.");
    }
    this.maximumStepDistance = config.maximumStepDistance;
    this.maximumReachSafetyFactor = safetyFactor;
    this.arrivalTolerance = arrivalTolerance;
    this.minimumProgressDistance = minimumProgress;
  }

  plan(input: BodyAdvanceInput): BodyAdvancePlan {
    const plan = this.createPlan(input.currentBodyPosition);
    if (!finiteVector(input.currentBodyPosition) || !finiteVector(input.destinationWorldPosition)) {
      return this.fail(plan, "non-finite-input");
    }

    const dx = input.destinationWorldPosition.x - input.currentBodyPosition.x;
    const dy = input.destinationWorldPosition.y - input.currentBodyPosition.y;
    const dz = input.destinationWorldPosition.z - input.currentBodyPosition.z;
    const requestedDistance = Math.hypot(dx, dy, dz);
    plan.requestedDistance = requestedDistance;
    plan.remainingDistance = requestedDistance;
    if (!Number.isFinite(requestedDistance)) {
      return this.fail(plan, "non-finite-input");
    }
    if (requestedDistance <= this.arrivalTolerance) {
      plan.success = true;
      plan.remainingDistance = 0;
      return plan;
    }

    const held = input.heldContacts.filter((contact) => contact.held !== false);
    plan.heldContactCount = held.length;
    if (held.length === 0) {
      return this.fail(plan, "no-held-contacts");
    }

    const inverseDistance = 1 / requestedDistance;
    const directionX = dx * inverseDistance;
    const directionY = dy * inverseDistance;
    const directionZ = dz * inverseDistance;
    const desiredStep = Math.min(requestedDistance, this.maximumStepDistance);
    plan.clampedByMaximumStep = requestedDistance > this.maximumStepDistance;
    let allowedStep = desiredStep;

    for (const contact of held) {
      if (
        contact.valid === false ||
        !contact.id ||
        !finiteAddress(contact.address) ||
        !finiteVector(contact.contactWorldPosition) ||
        !finiteVector(contact.reachOriginWorldPosition) ||
        !Number.isFinite(contact.maximumReach) ||
        contact.maximumReach <= 0 ||
        (contact.minimumReach !== undefined &&
          (!Number.isFinite(contact.minimumReach) ||
            contact.minimumReach < 0 ||
            contact.minimumReach > contact.maximumReach))
      ) {
        return this.fail(plan, "invalid-contact");
      }

      const reachX = contact.contactWorldPosition.x - contact.reachOriginWorldPosition.x;
      const reachY = contact.contactWorldPosition.y - contact.reachOriginWorldPosition.y;
      const reachZ = contact.contactWorldPosition.z - contact.reachOriginWorldPosition.z;
      const reachSquared = reachX * reachX + reachY * reachY + reachZ * reachZ;
      const maximumReach = contact.maximumReach * this.maximumReachSafetyFactor;
      if (reachSquared > maximumReach * maximumReach + EPSILON) {
        plan.limitingContactId = contact.id;
        plan.limitingContactAddress = {
          strandId: contact.address.strandId,
          t: contact.address.t,
        };
        plan.limitingConstraint = "maximum";
        return this.fail(plan, "contact-already-out-of-reach");
      }

      const along = reachX * directionX + reachY * directionY + reachZ * directionZ;
      const perpendicularSquared = Math.max(0, reachSquared - along * along);
      const maximumDiscriminant = maximumReach * maximumReach - perpendicularSquared;
      if (maximumDiscriminant < -EPSILON) {
        return this.limitFailure(plan, contact, "maximum", "maximum-reach-blocked");
      }
      const maximumExit = along + Math.sqrt(Math.max(0, maximumDiscriminant));
      if (maximumExit < allowedStep) {
        allowedStep = Math.max(0, maximumExit);
        this.setLimiter(plan, contact, "maximum");
      }

      const minimumReach = contact.minimumReach ?? 0;
      if (minimumReach > 0 && reachSquared + EPSILON < minimumReach * minimumReach) {
        this.setLimiter(plan, contact, "minimum");
        return this.fail(plan, "contact-already-out-of-reach");
      }
      if (minimumReach > 0 && perpendicularSquared < minimumReach * minimumReach) {
        const minimumEntry = along - Math.sqrt(minimumReach * minimumReach - perpendicularSquared);
        if (minimumEntry >= 0 && minimumEntry < allowedStep) {
          allowedStep = Math.max(0, minimumEntry);
          this.setLimiter(plan, contact, "minimum");
        }
      }
    }

    plan.clampedByReach = allowedStep + EPSILON < desiredStep;
    if (allowedStep < this.minimumProgressDistance && requestedDistance > this.arrivalTolerance) {
      return this.fail(
        plan,
        plan.limitingConstraint === "minimum"
          ? "minimum-reach-blocked"
          : "maximum-reach-blocked",
      );
    }

    plan.displacement.x = directionX * allowedStep;
    plan.displacement.y = directionY * allowedStep;
    plan.displacement.z = directionZ * allowedStep;
    plan.targetBodyPosition.x = input.currentBodyPosition.x + plan.displacement.x;
    plan.targetBodyPosition.y = input.currentBodyPosition.y + plan.displacement.y;
    plan.targetBodyPosition.z = input.currentBodyPosition.z + plan.displacement.z;
    plan.plannedDistance = allowedStep;
    plan.remainingDistance = Math.max(0, requestedDistance - allowedStep);
    plan.anotherStepRequired = plan.remainingDistance > this.arrivalTolerance;

    let maximumRatio = 0;
    for (const contact of held) {
      const nextOriginX = contact.reachOriginWorldPosition.x + plan.displacement.x;
      const nextOriginY = contact.reachOriginWorldPosition.y + plan.displacement.y;
      const nextOriginZ = contact.reachOriginWorldPosition.z + plan.displacement.z;
      const nextDistance = Math.hypot(
        contact.contactWorldPosition.x - nextOriginX,
        contact.contactWorldPosition.y - nextOriginY,
        contact.contactWorldPosition.z - nextOriginZ,
      );
      maximumRatio = Math.max(maximumRatio, nextDistance / contact.maximumReach);
    }
    plan.maximumPredictedReachRatio = maximumRatio;
    plan.success =
      finiteVector(plan.displacement) &&
      finiteVector(plan.targetBodyPosition) &&
      Number.isFinite(maximumRatio);
    if (!plan.success) {
      return this.fail(plan, "non-finite-input");
    }
    return plan;
  }

  private createPlan(currentBodyPosition: Vec3Like): BodyAdvancePlan {
    return {
      displacement: vector(),
      targetBodyPosition: finiteVector(currentBodyPosition)
        ? { ...currentBodyPosition }
        : vector(),
      success: false,
      failureReason: "none",
      requestedDistance: 0,
      plannedDistance: 0,
      remainingDistance: 0,
      clampedByMaximumStep: false,
      clampedByReach: false,
      anotherStepRequired: false,
      limitingContactId: null,
      limitingContactAddress: null,
      limitingConstraint: null,
      maximumPredictedReachRatio: 0,
      heldContactCount: 0,
    };
  }

  private setLimiter(
    plan: BodyAdvancePlan,
    contact: HeldContactReachEstimate,
    constraint: Exclude<BodyAdvanceReachConstraint, null>,
  ): void {
    plan.limitingContactId = contact.id;
    plan.limitingContactAddress = {
      strandId: contact.address.strandId,
      t: contact.address.t,
    };
    plan.limitingConstraint = constraint;
  }

  private limitFailure(
    plan: BodyAdvancePlan,
    contact: HeldContactReachEstimate,
    constraint: Exclude<BodyAdvanceReachConstraint, null>,
    reason: BodyAdvanceFailureReason,
  ): BodyAdvancePlan {
    this.setLimiter(plan, contact, constraint);
    return this.fail(plan, reason);
  }

  private fail(plan: BodyAdvancePlan, reason: BodyAdvanceFailureReason): BodyAdvancePlan {
    plan.success = false;
    plan.failureReason = reason;
    plan.anotherStepRequired = false;
    return plan;
  }
}
