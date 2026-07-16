import {
  ContactFrameTracker,
  createContactFrame,
  type ContactFrame,
  type MutableVec3,
  type StrandAddress,
  type StrandTraversal,
  type Vec3Like,
} from "../traversal/index";
import {
  SPIDER_LEG_IDS,
  type SpiderLegId,
  type SpiderReachSpec,
} from "./SpiderRigSpec";

/** Compatibility-friendly descriptive alias; the canonical order comes from the rig contract. */
export const BLACK_WIDOW_LEG_IDS = SPIDER_LEG_IDS;
export type { SpiderLegId } from "./SpiderRigSpec";

/**
 * The complete contact lifecycle is explicit even though Phase 6 only drives
 * unassigned, planted, loaded, and clean release behavior.
 */
export const SPIDER_FOOT_CONTACT_STATES = [
  "unassigned",
  "seeking",
  "approaching",
  "planted",
  "loaded",
  "releasing",
  "released",
  "invalid",
] as const;

export type SpiderFootContactState = (typeof SPIDER_FOOT_CONTACT_STATES)[number];

export type SpiderFootContactInvalidReason =
  | "none"
  | "unassigned"
  | "strand-unavailable"
  | "invalid-home-position"
  | "invalid-reach-origin"
  | "invalid-reach-scale"
  | "resolution-failed"
  | "non-finite-contact"
  | "compressed-reach"
  | "extended-reach";

export type SpiderFootReachStatus =
  | "unknown"
  | "comfortable"
  | "strained"
  | "too-close"
  | "too-far"
  | "invalid";

/** Reach distances are model-space values read from SPIDER_RIG_SPEC.json. */
export type SpiderLegReach = SpiderReachSpec;

export interface SpiderFootContactUpdate {
  /** Current world-space position of the rig's FootHome reference. */
  readonly footHomeWorldPosition: Vec3Like;
  /** Current world-space coxa head (the origin used by the rig reach values). */
  readonly reachOriginWorldPosition: Vec3Like;
  /** World/model scale applied to the rig. Defaults to one. */
  readonly reachScale?: number;
  /** Phase-specific hard floor multiplier for minimum reach. Defaults to one. */
  readonly minimumReachScale?: number;
  /** Usually the spider's current dorsal direction. Defaults to world +Y. */
  readonly referenceUp?: Vec3Like;
}

interface StoredStrandAddress {
  strandId: string;
  t: number;
}

const DEFAULT_REFERENCE_UP: Vec3Like = Object.freeze({ x: 0, y: 1, z: 0 });
const LOAD_EPSILON = 1e-9;

function createMutableVec3(): MutableVec3 {
  return { x: 0, y: 0, z: 0 };
}

function copyVector(target: MutableVec3, source: Vec3Like): void {
  target.x = source.x;
  target.y = source.y;
  target.z = source.z;
}

function clearVector(target: MutableVec3): void {
  target.x = 0;
  target.y = 0;
  target.z = 0;
}

function isFiniteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

function isFiniteFrame(frame: ContactFrame): boolean {
  return (
    isFiniteVector(frame.tangent) &&
    isFiniteVector(frame.normal) &&
    isFiniteVector(frame.binormal)
  );
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assertReach(reach: SpiderLegReach): void {
  if (
    !Number.isFinite(reach.min) ||
    !Number.isFinite(reach.comfortable) ||
    !Number.isFinite(reach.max) ||
    reach.min < 0 ||
    reach.comfortable < reach.min ||
    reach.max < reach.comfortable ||
    reach.max <= 0
  ) {
    throw new Error("Spider leg reach must satisfy 0 <= min <= comfortable <= max.");
  }
}

/**
 * Renderer- and locomotion-independent state for one semantic foot contact.
 *
 * A contact never exposes a simulation particle. Its durable identity is one
 * `{ strandId, t }`, while all world data is resolved afresh from the current
 * web shape. Keep one instance per leg so its ContactFrameTracker can preserve
 * roll continuity as both the body and silk move.
 */
export class SpiderFootContact {
  readonly frameTracker = new ContactFrameTracker();
  readonly worldPosition = createMutableVec3();
  readonly frame = createContactFrame();
  readonly localStrandVelocity = createMutableVec3();
  readonly preferredFootHomeWorldPosition = createMutableVec3();
  readonly reachOriginWorldPosition = createMutableVec3();

  private storedAddress: StoredStrandAddress = { strandId: "", t: 0 };
  private hasAddress = false;
  private stateValue: SpiderFootContactState = "unassigned";
  private stateBeforeInvalid: Exclude<SpiderFootContactState, "invalid"> = "unassigned";
  private plantedValue = false;

  approximateLocalTension = 0;
  carriedLoadNewtons = 0;
  currentReachDistance = 0;
  currentReachRatio = 0;
  contactValid = false;
  hasResolvedWorldPosition = false;
  reachStatus: SpiderFootReachStatus = "unknown";
  invalidReason: SpiderFootContactInvalidReason = "unassigned";
  resolutionError: string | null = null;

  constructor(
    readonly legId: SpiderLegId,
    readonly reach: SpiderLegReach,
  ) {
    assertReach(reach);
  }

  get state(): SpiderFootContactState {
    return this.stateValue;
  }

  get address(): StrandAddress | null {
    return this.hasAddress ? this.storedAddress : null;
  }

  get strandId(): string | null {
    return this.hasAddress ? this.storedAddress.strandId : null;
  }

  get t(): number | null {
    return this.hasAddress ? this.storedAddress.t : null;
  }

  /** True while a foot still claims its address, including its releasing frame. */
  get isPlanted(): boolean {
    return this.plantedValue;
  }

  /** Seeking and approaching feet are also physically released from the web. */
  get isReleased(): boolean {
    return !this.plantedValue;
  }

  /** Only a resolved, stable planted state may receive a web load. */
  get acceptsLoad(): boolean {
    return (
      this.plantedValue &&
      this.contactValid &&
      (this.stateValue === "planted" || this.stateValue === "loaded")
    );
  }

  beginSeeking(): this {
    this.clearAssignment("seeking");
    return this;
  }

  approach(address: StrandAddress): this {
    this.assignAddress(address);
    this.plantedValue = false;
    this.setState("approaching");
    this.contactValid = false;
    return this;
  }

  plant(address?: StrandAddress): this {
    if (address) {
      this.assignAddress(address);
    }
    if (!this.hasAddress) {
      throw new Error(`Cannot plant foot ${this.legId} without a strand address.`);
    }

    this.plantedValue = true;
    this.setState(this.carriedLoadNewtons > LOAD_EPSILON ? "loaded" : "planted");
    return this;
  }

  /** Rebinds a candidate or planted foot without introducing a web particle ID. */
  setAddress(address: StrandAddress): this {
    this.assignAddress(address);
    if (this.plantedValue) {
      this.setState(this.carriedLoadNewtons > LOAD_EPSILON ? "loaded" : "planted");
    } else if (this.stateValue !== "seeking") {
      this.setState("approaching");
    }
    this.contactValid = false;
    return this;
  }

  /** Changes material distance on the same strand while preserving frame history. */
  moveTo(t: number): this {
    if (!this.hasAddress) {
      throw new Error(`Cannot move unassigned foot ${this.legId}.`);
    }
    if (!Number.isFinite(t)) {
      throw new Error(`Foot ${this.legId} contact t must be finite.`);
    }
    this.storedAddress.t = clamp01(t);
    this.contactValid = false;
    return this;
  }

  beginRelease(): this {
    if (!this.hasAddress) {
      return this.release();
    }
    this.carriedLoadNewtons = 0;
    this.setState("releasing");
    return this;
  }

  release(): this {
    this.clearAssignment("released");
    return this;
  }

  reset(): this {
    this.clearAssignment("unassigned");
    return this;
  }

  /** Called by SpiderLoadDistributor; units are force (newtons), not mass. */
  setCarriedLoad(loadNewtons: number): void {
    if (!Number.isFinite(loadNewtons) || loadNewtons < 0) {
      throw new Error(`Foot ${this.legId} load must be finite and non-negative.`);
    }

    this.carriedLoadNewtons = this.plantedValue ? loadNewtons : 0;
    if (
      this.stateValue !== "invalid" &&
      this.stateValue !== "releasing" &&
      this.plantedValue
    ) {
      this.setState(this.carriedLoadNewtons > LOAD_EPSILON ? "loaded" : "planted");
    }
  }

  /**
   * Resolves all web-relative and reach data for this frame without allocating.
   * Invalid data is isolated to this foot and reported instead of being thrown
   * into the skeleton/IK update.
   */
  update(traversal: StrandTraversal, input: SpiderFootContactUpdate): boolean {
    if (!isFiniteVector(input.footHomeWorldPosition)) {
      return this.markInvalid("invalid-home-position", "invalid");
    }
    copyVector(this.preferredFootHomeWorldPosition, input.footHomeWorldPosition);

    if (!isFiniteVector(input.reachOriginWorldPosition)) {
      return this.markInvalid("invalid-reach-origin", "invalid");
    }
    copyVector(this.reachOriginWorldPosition, input.reachOriginWorldPosition);

    const reachScale = input.reachScale ?? 1;
    if (!Number.isFinite(reachScale) || reachScale <= 0) {
      return this.markInvalid("invalid-reach-scale", "invalid");
    }
    const minimumReachScale = input.minimumReachScale ?? 1;
    if (!Number.isFinite(minimumReachScale) || minimumReachScale <= 0) {
      return this.markInvalid("invalid-reach-scale", "invalid");
    }

    if (!this.hasAddress) {
      this.contactValid = false;
      this.hasResolvedWorldPosition = false;
      this.reachStatus = "unknown";
      this.invalidReason = "unassigned";
      this.approximateLocalTension = 0;
      clearVector(this.localStrandVelocity);
      return false;
    }

    const strand = traversal.getStrand(this.storedAddress.strandId);
    if (!strand || !strand.active || strand.broken) {
      return this.markInvalid("strand-unavailable", "invalid");
    }

    try {
      traversal.getWorldPosition(this.storedAddress, this.worldPosition);
      traversal.getContactFrame(
        this.storedAddress,
        this.frame,
        this.frameTracker,
        input.referenceUp && isFiniteVector(input.referenceUp)
          ? input.referenceUp
          : DEFAULT_REFERENCE_UP,
      );
      traversal.getLocalVelocity(this.storedAddress, this.localStrandVelocity);
      this.approximateLocalTension = Math.max(
        0,
        traversal.getApproximateLocalTension(this.storedAddress),
      );
    } catch (error) {
      this.resolutionError = error instanceof Error ? error.message : String(error);
      return this.markInvalid("resolution-failed", "invalid");
    }

    if (
      !isFiniteVector(this.worldPosition) ||
      !isFiniteFrame(this.frame) ||
      !isFiniteVector(this.localStrandVelocity) ||
      !Number.isFinite(this.approximateLocalTension)
    ) {
      return this.markInvalid("non-finite-contact", "invalid");
    }

    this.hasResolvedWorldPosition = true;
    const dx = this.worldPosition.x - this.reachOriginWorldPosition.x;
    const dy = this.worldPosition.y - this.reachOriginWorldPosition.y;
    const dz = this.worldPosition.z - this.reachOriginWorldPosition.z;
    this.currentReachDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const minimumReach = this.reach.min * reachScale * minimumReachScale;
    const comfortableReach = this.reach.comfortable * reachScale;
    const maximumReach = this.reach.max * reachScale;
    this.currentReachRatio = this.currentReachDistance / maximumReach;

    if (!Number.isFinite(this.currentReachDistance) || !Number.isFinite(this.currentReachRatio)) {
      return this.markInvalid("non-finite-contact", "invalid");
    }
    if (this.currentReachDistance < minimumReach) {
      return this.markInvalid("compressed-reach", "too-close", true);
    }
    if (this.currentReachDistance > maximumReach) {
      return this.markInvalid("extended-reach", "too-far", true);
    }

    this.contactValid = true;
    this.invalidReason = "none";
    this.resolutionError = null;
    this.reachStatus =
      this.currentReachDistance <= comfortableReach ? "comfortable" : "strained";
    this.restoreResolvedState();
    return true;
  }

  private assignAddress(address: StrandAddress): void {
    if (!address.strandId) {
      throw new Error(`Foot ${this.legId} requires a non-empty strand ID.`);
    }
    if (!Number.isFinite(address.t)) {
      throw new Error(`Foot ${this.legId} contact t must be finite.`);
    }

    const strandChanged = !this.hasAddress || this.storedAddress.strandId !== address.strandId;
    if (strandChanged) {
      // A previous public readonly address remains a truthful historical value
      // after release/rebind; steady-state updates still allocate nothing.
      this.storedAddress = { strandId: address.strandId, t: clamp01(address.t) };
    } else {
      this.storedAddress.t = clamp01(address.t);
    }
    this.hasAddress = true;
    if (strandChanged) {
      this.frameTracker.reset();
    }
  }

  private clearAssignment(
    state: Exclude<SpiderFootContactState, "invalid">,
  ): void {
    this.hasAddress = false;
    this.plantedValue = false;
    this.carriedLoadNewtons = 0;
    this.contactValid = false;
    this.hasResolvedWorldPosition = false;
    this.approximateLocalTension = 0;
    this.currentReachDistance = 0;
    this.currentReachRatio = 0;
    this.reachStatus = "unknown";
    this.invalidReason = "unassigned";
    this.resolutionError = null;
    clearVector(this.localStrandVelocity);
    this.frameTracker.reset();
    this.setState(state);
  }

  private setState(state: Exclude<SpiderFootContactState, "invalid">): void {
    this.stateValue = state;
    this.stateBeforeInvalid = state;
  }

  private restoreResolvedState(): void {
    if (this.stateValue !== "invalid") {
      return;
    }
    if (this.stateBeforeInvalid === "releasing") {
      this.setState("releasing");
    } else if (this.plantedValue) {
      this.setState(this.carriedLoadNewtons > LOAD_EPSILON ? "loaded" : "planted");
    } else if (this.stateBeforeInvalid === "approaching") {
      this.setState("approaching");
    } else {
      this.setState(this.stateBeforeInvalid);
    }
  }

  private markInvalid(
    reason: SpiderFootContactInvalidReason,
    reachStatus: SpiderFootReachStatus,
    preserveResolvedData = false,
  ): false {
    if (this.stateValue !== "invalid") {
      this.stateBeforeInvalid = this.stateValue;
    }
    this.stateValue = "invalid";
    this.contactValid = false;
    this.invalidReason = reason;
    if (reason !== "resolution-failed") {
      this.resolutionError = null;
    }
    this.reachStatus = reachStatus;
    if (!preserveResolvedData) {
      this.hasResolvedWorldPosition = false;
      this.approximateLocalTension = 0;
      this.currentReachDistance = 0;
      this.currentReachRatio = 0;
      clearVector(this.localStrandVelocity);
    }
    return false;
  }
}

/** Creates the eight required per-foot state objects in anatomical spec order. */
export function createBlackWidowFootContacts(
  reachByLeg: Readonly<Record<SpiderLegId, SpiderLegReach>>,
): Map<SpiderLegId, SpiderFootContact> {
  const contacts = new Map<SpiderLegId, SpiderFootContact>();
  for (const legId of BLACK_WIDOW_LEG_IDS) {
    contacts.set(legId, new SpiderFootContact(legId, reachByLeg[legId]));
  }
  return contacts;
}
