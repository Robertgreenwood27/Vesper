import type { Vec3Like } from "../traversal/index";
import { TemporaryStrandContact } from "../traversal/index";
import type { WebNetwork } from "../web/WebNetwork";
import type { SpiderFootContact, SpiderLegId } from "./SpiderFootContact";

export const SPIDER_LOAD_DISTRIBUTION_MODES = [
  "equal",
  "position-weighted",
] as const;

export type SpiderLoadDistributionMode =
  (typeof SPIDER_LOAD_DISTRIBUTION_MODES)[number];

export interface SpiderFootLoadDiagnostic {
  readonly legId: SpiderLegId;
  readonly strandId: string | null;
  readonly t: number | null;
  readonly weightFraction: number;
  readonly assignedLoadNewtons: number;
  readonly appliedLoadNewtons: number;
  readonly applied: boolean;
  /** Phase 7 participation multiplier; defaults to one for Phase 6 behavior. */
  readonly loadFactor: number;
}

export interface SpiderLoadDiagnostics {
  readonly mode: SpiderLoadDistributionMode;
  readonly totalSpiderWeightNewtons: number;
  readonly eligibleFootCount: number;
  readonly loadedFootCount: number;
  readonly meanLoadPerLoadedFootNewtons: number;
  readonly totalDistributedLoadNewtons: number;
  readonly totalAppliedWebLoadNewtons: number;
  /** Positive means some requested weight was not transferred to the web. */
  readonly distributionMismatchNewtons: number;
  readonly relativeMismatch: number;
  readonly allocations: readonly SpiderFootLoadDiagnostic[];
}

interface MutableFootLoadDiagnostic {
  legId: SpiderLegId;
  strandId: string | null;
  t: number | null;
  weightFraction: number;
  assignedLoadNewtons: number;
  appliedLoadNewtons: number;
  applied: boolean;
  loadFactor: number;
}

interface FootLoadBinding {
  foot: SpiderFootContact;
  webContact: TemporaryStrandContact;
  diagnostic: MutableFootLoadDiagnostic;
  rawWeight: number;
  eligible: boolean;
  loadFactor: number;
}

interface MutableLoadDiagnostics {
  mode: SpiderLoadDistributionMode;
  totalSpiderWeightNewtons: number;
  eligibleFootCount: number;
  loadedFootCount: number;
  meanLoadPerLoadedFootNewtons: number;
  totalDistributedLoadNewtons: number;
  totalAppliedWebLoadNewtons: number;
  distributionMismatchNewtons: number;
  relativeMismatch: number;
  allocations: MutableFootLoadDiagnostic[];
}

const DEFAULT_LOAD_DIRECTION: Vec3Like = Object.freeze({ x: 0, y: -1, z: 0 });

function isFiniteVector(value: Vec3Like): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

/**
 * Turns per-foot semantic contacts into web forces without exposing particles.
 * Call `applyFixedStep` from the web solver's external-force callback after all
 * SpiderFootContact instances have resolved their current frame.
 */
export class SpiderLoadDistributor {
  private bindings = new Map<SpiderLegId, FootLoadBinding>();
  private modeValue: SpiderLoadDistributionMode = "equal";
  private totalWeightNewtons = 0;
  private positionWeightBias = 0.15;
  private loadDirectionX = DEFAULT_LOAD_DIRECTION.x;
  private loadDirectionY = DEFAULT_LOAD_DIRECTION.y;
  private loadDirectionZ = DEFAULT_LOAD_DIRECTION.z;

  private readonly diagnosticsValue: MutableLoadDiagnostics = {
    mode: "equal",
    totalSpiderWeightNewtons: 0,
    eligibleFootCount: 0,
    loadedFootCount: 0,
    meanLoadPerLoadedFootNewtons: 0,
    totalDistributedLoadNewtons: 0,
    totalAppliedWebLoadNewtons: 0,
    distributionMismatchNewtons: 0,
    relativeMismatch: 0,
    allocations: [],
  };

  constructor(
    private network: WebNetwork,
    feet: Iterable<SpiderFootContact> = [],
  ) {
    for (const foot of feet) {
      this.registerFoot(foot);
    }
  }

  get mode(): SpiderLoadDistributionMode {
    return this.modeValue;
  }

  get diagnostics(): SpiderLoadDiagnostics {
    return this.diagnosticsValue;
  }

  setMode(mode: SpiderLoadDistributionMode): this {
    if (!SPIDER_LOAD_DISTRIBUTION_MODES.includes(mode)) {
      throw new Error(`Unknown spider load distribution mode: ${mode}.`);
    }
    this.modeValue = mode;
    this.diagnosticsValue.mode = mode;
    return this;
  }

  setTotalWeight(totalWeightNewtons: number): this {
    if (!Number.isFinite(totalWeightNewtons) || totalWeightNewtons < 0) {
      throw new Error("Spider weight must be finite and non-negative.");
    }
    this.totalWeightNewtons = totalWeightNewtons;
    this.diagnosticsValue.totalSpiderWeightNewtons = totalWeightNewtons;
    return this;
  }

  setTotalMass(massKilograms: number, gravityMagnitude = 9.81): this {
    if (!Number.isFinite(massKilograms) || massKilograms < 0) {
      throw new Error("Spider mass must be finite and non-negative.");
    }
    if (!Number.isFinite(gravityMagnitude) || gravityMagnitude < 0) {
      throw new Error("Gravity magnitude must be finite and non-negative.");
    }
    return this.setTotalWeight(massKilograms * gravityMagnitude);
  }

  setLoadDirection(direction: Vec3Like): this {
    if (!isFiniteVector(direction)) {
      throw new Error("Spider load direction must be finite.");
    }
    const length = Math.sqrt(
      direction.x * direction.x + direction.y * direction.y + direction.z * direction.z,
    );
    if (length <= 1e-10) {
      throw new Error("Spider load direction cannot be zero.");
    }
    this.loadDirectionX = direction.x / length;
    this.loadDirectionY = direction.y / length;
    this.loadDirectionZ = direction.z / length;
    return this;
  }

  /** Softens inverse-distance weighting near the support center, in world units. */
  setPositionWeightBias(bias: number): this {
    if (!Number.isFinite(bias) || bias <= 0) {
      throw new Error("Position weight bias must be finite and positive.");
    }
    this.positionWeightBias = bias;
    return this;
  }

  registerFoot(foot: SpiderFootContact): this {
    const existing = this.bindings.get(foot.legId);
    if (existing) {
      if (existing.foot !== foot) {
        throw new Error(`A different contact is already registered for leg ${foot.legId}.`);
      }
      return this;
    }

    const diagnostic: MutableFootLoadDiagnostic = {
      legId: foot.legId,
      strandId: null,
      t: null,
      weightFraction: 0,
      assignedLoadNewtons: 0,
      appliedLoadNewtons: 0,
      applied: false,
      loadFactor: 1,
    };
    this.bindings.set(foot.legId, {
      foot,
      webContact: new TemporaryStrandContact(this.network),
      diagnostic,
      rawWeight: 0,
      eligible: false,
      loadFactor: 1,
    });
    this.diagnosticsValue.allocations.push(diagnostic);
    return this;
  }

  unregisterFoot(legId: SpiderLegId): boolean {
    const binding = this.bindings.get(legId);
    if (!binding) {
      return false;
    }
    binding.webContact.release();
    binding.foot.setCarriedLoad(0);
    this.bindings.delete(legId);
    const diagnosticIndex = this.diagnosticsValue.allocations.indexOf(binding.diagnostic);
    if (diagnosticIndex >= 0) {
      this.diagnosticsValue.allocations.splice(diagnosticIndex, 1);
    }
    return true;
  }

  /** Rebinds all internal transient loads after a web-network rebuild. */
  setNetwork(network: WebNetwork): void {
    this.network = network;
    for (const binding of this.bindings.values()) {
      binding.webContact.setNetwork(network);
    }
  }

  /** Releases only the physical load; it does not erase the foot's semantic address. */
  releaseFootLoad(legId: SpiderLegId): boolean {
    const binding = this.bindings.get(legId);
    if (!binding) {
      return false;
    }
    this.clearBindingLoad(binding);
    return true;
  }

  releaseAllLoads(): void {
    for (const binding of this.bindings.values()) {
      this.clearBindingLoad(binding);
    }
    this.resetAggregateDiagnostics();
  }

  /**
   * Scales one foot's participation before distribution is normalized.
   * A factor of zero keeps a planted semantic contact unloaded; one restores
   * the validated Phase 6 behavior. This never changes the configured total.
   */
  setFootLoadFactor(legId: SpiderLegId, factor: number): this {
    if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
      throw new Error("Spider foot load factor must be finite and between zero and one.");
    }
    const binding = this.bindings.get(legId);
    if (!binding) {
      throw new Error(`Cannot set load factor for unregistered leg ${legId}.`);
    }
    binding.loadFactor = factor;
    binding.diagnostic.loadFactor = factor;
    if (factor === 0) this.clearBindingLoad(binding);
    return this;
  }

  getFootLoadFactor(legId: SpiderLegId): number | undefined {
    return this.bindings.get(legId)?.loadFactor;
  }

  resetFootLoadFactors(): this {
    for (const binding of this.bindings.values()) {
      binding.loadFactor = 1;
      binding.diagnostic.loadFactor = 1;
    }
    return this;
  }

  /**
   * Distributes and applies the configured weight for one simulation step.
   * Position-weighted mode uses a bounded inverse distance to the supplied body
   * support center; without one it uses the centroid of valid planted contacts.
   */
  applyFixedStep(fixedDelta: number, supportCenter?: Vec3Like): SpiderLoadDiagnostics {
    if (!Number.isFinite(fixedDelta) || fixedDelta < 0) {
      throw new Error("Spider load fixed delta must be finite and non-negative.");
    }
    if (supportCenter && !isFiniteVector(supportCenter)) {
      throw new Error("Spider support center must be finite.");
    }

    let eligibleCount = 0;
    let centerX = supportCenter?.x ?? 0;
    let centerY = supportCenter?.y ?? 0;
    let centerZ = supportCenter?.z ?? 0;

    for (const binding of this.bindings.values()) {
      const address = binding.foot.address;
      binding.diagnostic.strandId = address?.strandId ?? null;
      binding.diagnostic.t = address?.t ?? null;
      binding.diagnostic.weightFraction = 0;
      binding.diagnostic.assignedLoadNewtons = 0;
      binding.diagnostic.appliedLoadNewtons = 0;
      binding.diagnostic.applied = false;
      binding.diagnostic.loadFactor = binding.loadFactor;
      binding.rawWeight = 0;
      binding.eligible = Boolean(
        address &&
          binding.foot.acceptsLoad &&
          binding.loadFactor > 0 &&
          this.isTraversable(address.strandId),
      );

      if (binding.eligible) {
        eligibleCount += 1;
        if (!supportCenter) {
          centerX += binding.foot.worldPosition.x;
          centerY += binding.foot.worldPosition.y;
          centerZ += binding.foot.worldPosition.z;
        }
      } else {
        this.clearBindingLoad(binding);
      }
    }

    if (!supportCenter && eligibleCount > 0) {
      const inverseCount = 1 / eligibleCount;
      centerX *= inverseCount;
      centerY *= inverseCount;
      centerZ *= inverseCount;
    }

    let rawWeightTotal = 0;
    for (const binding of this.bindings.values()) {
      if (!binding.eligible) {
        continue;
      }
      if (this.modeValue === "equal") {
        binding.rawWeight = binding.loadFactor;
      } else {
        const dx = binding.foot.worldPosition.x - centerX;
        const dy = binding.foot.worldPosition.y - centerY;
        const dz = binding.foot.worldPosition.z - centerZ;
        const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        binding.rawWeight = binding.loadFactor / (this.positionWeightBias + distance);
      }
      rawWeightTotal += binding.rawWeight;
    }

    let loadedFootCount = 0;
    let totalDistributedLoad = 0;
    let totalAppliedLoad = 0;
    if (rawWeightTotal > 0 && this.totalWeightNewtons > 0) {
      for (const binding of this.bindings.values()) {
        if (!binding.eligible) {
          continue;
        }
        const weightFraction = binding.rawWeight / rawWeightTotal;
        const assignedLoad = this.totalWeightNewtons * weightFraction;
        binding.diagnostic.weightFraction = weightFraction;
        binding.diagnostic.assignedLoadNewtons = assignedLoad;
        totalDistributedLoad += assignedLoad;

        if (!this.bindAndApply(binding, assignedLoad, fixedDelta)) {
          binding.foot.setCarriedLoad(0);
          continue;
        }

        binding.foot.setCarriedLoad(assignedLoad);
        binding.diagnostic.applied = true;
        binding.diagnostic.appliedLoadNewtons = assignedLoad;
        loadedFootCount += 1;
        totalAppliedLoad += assignedLoad;
      }
    } else {
      for (const binding of this.bindings.values()) {
        if (binding.eligible) {
          this.clearBindingLoad(binding);
        }
      }
    }

    const rawMismatch = this.totalWeightNewtons - totalAppliedLoad;
    const mismatch = Math.abs(rawMismatch) <= 1e-12 ? 0 : rawMismatch;
    this.diagnosticsValue.mode = this.modeValue;
    this.diagnosticsValue.totalSpiderWeightNewtons = this.totalWeightNewtons;
    this.diagnosticsValue.eligibleFootCount = eligibleCount;
    this.diagnosticsValue.loadedFootCount = loadedFootCount;
    this.diagnosticsValue.meanLoadPerLoadedFootNewtons =
      loadedFootCount > 0 ? totalAppliedLoad / loadedFootCount : 0;
    this.diagnosticsValue.totalDistributedLoadNewtons = totalDistributedLoad;
    this.diagnosticsValue.totalAppliedWebLoadNewtons = totalAppliedLoad;
    this.diagnosticsValue.distributionMismatchNewtons = mismatch;
    this.diagnosticsValue.relativeMismatch =
      this.totalWeightNewtons > 0 ? mismatch / this.totalWeightNewtons : 0;
    return this.diagnosticsValue;
  }

  private bindAndApply(
    binding: FootLoadBinding,
    assignedLoad: number,
    fixedDelta: number,
  ): boolean {
    const address = binding.foot.address;
    if (!address || !this.isTraversable(address.strandId)) {
      binding.webContact.release();
      return false;
    }

    if (binding.webContact.strandId !== address.strandId) {
      binding.webContact.release();
      binding.webContact.attach(address.strandId, address.t);
    } else if (binding.webContact.t !== address.t) {
      binding.webContact.moveTo(address.t);
    }

    binding.webContact
      .setWeight(0)
      .setForce(
        this.loadDirectionX * assignedLoad,
        this.loadDirectionY * assignedLoad,
        this.loadDirectionZ * assignedLoad,
      );
    return binding.webContact.applyFixedStep(fixedDelta);
  }

  private isTraversable(strandId: string): boolean {
    const strand = this.network.strands.get(strandId);
    return Boolean(strand && strand.active && !strand.broken);
  }

  private clearBindingLoad(binding: FootLoadBinding): void {
    binding.webContact.clearForce();
    binding.webContact.setWeight(0);
    binding.webContact.release();
    binding.foot.setCarriedLoad(0);
    binding.diagnostic.weightFraction = 0;
    binding.diagnostic.assignedLoadNewtons = 0;
    binding.diagnostic.appliedLoadNewtons = 0;
    binding.diagnostic.applied = false;
  }

  private resetAggregateDiagnostics(): void {
    this.diagnosticsValue.eligibleFootCount = 0;
    this.diagnosticsValue.loadedFootCount = 0;
    this.diagnosticsValue.meanLoadPerLoadedFootNewtons = 0;
    this.diagnosticsValue.totalDistributedLoadNewtons = 0;
    this.diagnosticsValue.totalAppliedWebLoadNewtons = 0;
    this.diagnosticsValue.distributionMismatchNewtons = this.totalWeightNewtons;
    this.diagnosticsValue.relativeMismatch = this.totalWeightNewtons > 0 ? 1 : 0;
  }
}
