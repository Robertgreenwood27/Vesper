import type { WebNetwork } from "../web/WebNetwork";
import type { WebStrand } from "../web/WebStrand";

export interface SolverSettings {
  gravityY: number;
  iterations: number;
  maximumStrain: number;
}

/**
 * Fixed-step Verlet integration with XPBD distance constraints.
 *
 * XPBD keeps the stiffness response much less sensitive to frame rate and
 * iteration count than a raw spring chain. The visible ribbon is deliberately
 * absent from this class: the particle arrays are always the source of truth.
 */
export class WebPhysicsSolver {
  constructor(
    private network: WebNetwork,
    readonly settings: SolverSettings,
  ) {}

  setNetwork(network: WebNetwork): void {
    this.network = network;
  }

  step(fixedDelta: number, addExternalForces?: (fixedDelta: number) => void): void {
    const store = this.network.particles;
    store.clearForces();
    addExternalForces?.(fixedDelta);

    const positions = store.positions;
    const previous = store.previousPositions;
    const forces = store.forces;
    const inverseMasses = store.inverseMasses;
    const dampingRates = store.dampingRates;
    const deltaSquared = fixedDelta * fixedDelta;

    for (let particle = 0; particle < store.count; particle += 1) {
      const offset = particle * 3;
      const inverseMass = inverseMasses[particle];

      if (inverseMass === 0) {
        // Fixed anchors are kinematic: synchronizing previous state guarantees
        // that moving one later will not inject accidental velocity.
        previous[offset] = positions[offset];
        previous[offset + 1] = positions[offset + 1];
        previous[offset + 2] = positions[offset + 2];
        continue;
      }

      const x = positions[offset];
      const y = positions[offset + 1];
      const z = positions[offset + 2];
      const velocityDecay = Math.exp(-dampingRates[particle] * fixedDelta);
      const velocityX = (x - previous[offset]) * velocityDecay;
      const velocityY = (y - previous[offset + 1]) * velocityDecay;
      const velocityZ = (z - previous[offset + 2]) * velocityDecay;

      previous[offset] = x;
      previous[offset + 1] = y;
      previous[offset + 2] = z;
      positions[offset] = x + velocityX + forces[offset] * inverseMass * deltaSquared;
      positions[offset + 1] =
        y +
        velocityY +
        (this.settings.gravityY + forces[offset + 1] * inverseMass) * deltaSquared;
      positions[offset + 2] = z + velocityZ + forces[offset + 2] * inverseMass * deltaSquared;
    }

    for (const strand of this.network.strandList) {
      strand.resetConstraintState();
    }

    // Two forward/reverse pairs are the minimum supported solve. They remove
    // single-sweep ordering bias and keep the strict strain guard practical at
    // the exposed 24-point maximum without changing traversal order per frame.
    const iterationCount = Math.max(4, Math.round(this.settings.iterations));
    for (let iteration = 0; iteration < iterationCount; iteration += 1) {
      const solveForward = iteration % 2 === 0;
      const strandCount = this.network.strandList.length;
      for (let strandPass = 0; strandPass < strandCount; strandPass += 1) {
        const strandIndex = solveForward ? strandPass : strandCount - 1 - strandPass;
        const strand = this.network.strandList[strandIndex];
        if (!strand.active || strand.broken) {
          continue;
        }
        this.solveStrand(strand, fixedDelta, solveForward);
      }
    }

    // Finish with unilateral strain projections only. Applying this guard
    // inline is insufficient because a later neighboring constraint can
    // re-stretch an edge that was already visited. Alternating final passes
    // make the small-strain limit hold even at the lowest supported pass count.
    for (let safetyPass = 0; safetyPass < 1024; safetyPass += 1) {
      const solveForward = safetyPass % 2 === 0;
      let correctedAnySegment = false;
      const strandCount = this.network.strandList.length;
      for (let strandPass = 0; strandPass < strandCount; strandPass += 1) {
        const strandIndex = solveForward ? strandPass : strandCount - 1 - strandPass;
        const strand = this.network.strandList[strandIndex];
        if (!strand.active || strand.broken) {
          continue;
        }
        correctedAnySegment =
          this.solveMaximumStrainPass(strand, solveForward) || correctedAnySegment;
      }
      if (!correctedAnySegment) {
        break;
      }
    }

    this.updateMetrics(fixedDelta);
    store.clearForces();
  }

  stopMotion(): void {
    this.network.particles.stopMotion();
    for (const strand of this.network.strandList) {
      // Lambdas are substep-local, but the last measured stretch/tension stay
      // available so a reset performed while paused still shows its loaded state.
      strand.lambdas.fill(0);
    }
  }

  addForceAtLocation(
    strand: WebStrand,
    segmentIndex: number,
    t: number,
    forceX: number,
    forceY: number,
    forceZ: number,
  ): void {
    const segment = Math.max(0, Math.min(strand.constraintCount - 1, segmentIndex));
    const localT = Math.max(0, Math.min(1, t));
    const indexA = strand.particleIndices[segment];
    const indexB = strand.particleIndices[segment + 1];
    const weightA = 1 - localT;
    const weightB = localT;
    const forces = this.network.particles.forces;
    const offsetA = indexA * 3;
    const offsetB = indexB * 3;

    forces[offsetA] += forceX * weightA;
    forces[offsetA + 1] += forceY * weightA;
    forces[offsetA + 2] += forceZ * weightA;
    forces[offsetB] += forceX * weightB;
    forces[offsetB + 1] += forceY * weightB;
    forces[offsetB + 2] += forceZ * weightB;
  }

  /**
   * Adds a constant-energy pluck. Scaling impulse by the contact's effective
   * inverse mass keeps injected kinetic energy far more resolution-independent
   * than equal nodal impulse or equal contact velocity. Movable participation
   * fades both energy and node velocity naturally beside fixed anchors.
   */
  applyContactEnergyImpulse(
    strand: WebStrand,
    segmentIndex: number,
    t: number,
    energySpeedX: number,
    energySpeedY: number,
    energySpeedZ: number,
    fixedDelta: number,
  ): void {
    const segment = Math.max(0, Math.min(strand.constraintCount - 1, segmentIndex));
    const localT = Math.max(0, Math.min(1, t));
    const particleA = strand.particleIndices[segment];
    const particleB = strand.particleIndices[segment + 1];
    const weightA = 1 - localT;
    const weightB = localT;
    const inverseMassA = this.network.particles.inverseMasses[particleA];
    const inverseMassB = this.network.particles.inverseMasses[particleB];
    const effectiveInverseMass =
      weightA * weightA * inverseMassA + weightB * weightB * inverseMassB;
    if (effectiveInverseMass < 1e-8) {
      return;
    }

    const movableParticipation =
      (inverseMassA > 0 ? weightA : 0) + (inverseMassB > 0 ? weightB : 0);
    const impulseScale = movableParticipation / Math.sqrt(effectiveInverseMass);

    this.applyParticleImpulse(
      particleA,
      weightA,
      energySpeedX * impulseScale,
      energySpeedY * impulseScale,
      energySpeedZ * impulseScale,
      fixedDelta,
    );
    this.applyParticleImpulse(
      particleB,
      weightB,
      energySpeedX * impulseScale,
      energySpeedY * impulseScale,
      energySpeedZ * impulseScale,
      fixedDelta,
    );

  }

  private applyParticleImpulse(
    particle: number,
    weight: number,
    impulseX: number,
    impulseY: number,
    impulseZ: number,
    fixedDelta: number,
  ): void {
    const store = this.network.particles;
    const inverseMass = store.inverseMasses[particle];
    if (inverseMass === 0 || weight === 0) {
      return;
    }

    const offset = particle * 3;
    const velocityScale = weight * inverseMass * fixedDelta;
    store.previousPositions[offset] -= impulseX * velocityScale;
    store.previousPositions[offset + 1] -= impulseY * velocityScale;
    store.previousPositions[offset + 2] -= impulseZ * velocityScale;
  }

  private solveStrand(strand: WebStrand, fixedDelta: number, forward: boolean): void {
    const store = this.network.particles;
    const positions = store.positions;
    const inverseMasses = store.inverseMasses;
    // A strand's axial compliance is distributed in proportion to segment
    // rest length. Whole compliance also grows with total rest length, as it
    // does for a uniform material, so short and long branches have comparable
    // strain under equal tension while point-count changes remain neutral.
    const strandCompliance =
      Math.pow(1 - Math.max(0, Math.min(1, strand.stiffness)), 2) *
      (0.4 / 10.08) *
      strand.totalRestLength;
    const constraintCount = strand.constraintCount;

    for (let pass = 0; pass < constraintCount; pass += 1) {
      const segment = forward ? pass : constraintCount - 1 - pass;
      const particleA = strand.particleIndices[segment];
      const particleB = strand.particleIndices[segment + 1];
      const inverseMassA = inverseMasses[particleA];
      const inverseMassB = inverseMasses[particleB];
      const weightSum = inverseMassA + inverseMassB;
      if (weightSum === 0) {
        continue;
      }

      const offsetA = particleA * 3;
      const offsetB = particleB * 3;
      const dx = positions[offsetB] - positions[offsetA];
      const dy = positions[offsetB + 1] - positions[offsetA + 1];
      const dz = positions[offsetB + 2] - positions[offsetA + 2];
      const length = Math.hypot(dx, dy, dz);
      if (!Number.isFinite(length) || length < 1e-8) {
        continue;
      }

      const inverseLength = 1 / length;
      const constraint = length - strand.restLengths[segment];
      const segmentCompliance =
        strandCompliance * (strand.restLengths[segment] / strand.totalRestLength);
      const alpha = segmentCompliance / (fixedDelta * fixedDelta);
      const previousLambda = strand.lambdas[segment];
      const deltaLambda = (-constraint - alpha * previousLambda) / (weightSum + alpha);
      strand.lambdas[segment] = previousLambda + deltaLambda;

      const correctionX = dx * inverseLength * deltaLambda;
      const correctionY = dy * inverseLength * deltaLambda;
      const correctionZ = dz * inverseLength * deltaLambda;
      positions[offsetA] -= inverseMassA * correctionX;
      positions[offsetA + 1] -= inverseMassA * correctionY;
      positions[offsetA + 2] -= inverseMassA * correctionZ;
      positions[offsetB] += inverseMassB * correctionX;
      positions[offsetB + 1] += inverseMassB * correctionY;
      positions[offsetB + 2] += inverseMassB * correctionZ;

    }
  }

  private solveMaximumStrainPass(strand: WebStrand, forward: boolean): boolean {
    let correctedAnySegment = false;
    for (let pass = 0; pass < strand.constraintCount; pass += 1) {
      const segment = forward ? pass : strand.constraintCount - 1 - pass;
      correctedAnySegment =
        this.enforceMaximumStrain(
          strand,
          segment,
          strand.particleIndices[segment],
          strand.particleIndices[segment + 1],
        ) || correctedAnySegment;
    }
    return correctedAnySegment;
  }

  private enforceMaximumStrain(
    strand: WebStrand,
    segment: number,
    particleA: number,
    particleB: number,
  ): boolean {
    const store = this.network.particles;
    const positions = store.positions;
    const inverseMassA = store.inverseMasses[particleA];
    const inverseMassB = store.inverseMasses[particleB];
    const weightSum = inverseMassA + inverseMassB;
    if (weightSum === 0) {
      return false;
    }

    const offsetA = particleA * 3;
    const offsetB = particleB * 3;
    const positionAX = positions[offsetA];
    const positionAY = positions[offsetA + 1];
    const positionAZ = positions[offsetA + 2];
    const positionBX = positions[offsetB];
    const positionBY = positions[offsetB + 1];
    const positionBZ = positions[offsetB + 2];
    const dx = positionBX - positionAX;
    const dy = positionBY - positionAY;
    const dz = positionBZ - positionAZ;
    const length = Math.hypot(dx, dy, dz);
    // Particle positions are Float32. Reserve a microscopic margin below the
    // public limit so the nearest representable coordinate cannot round above
    // it, then stop iterating once a requested correction changes no value.
    const float32StrainMargin = 8e-6;
    const guardedStrain = Math.max(0, this.settings.maximumStrain - float32StrainMargin);
    const maximumLength = strand.restLengths[segment] * (1 + guardedStrain);
    const tolerance = maximumLength * 1e-6;
    if (!Number.isFinite(length) || length <= maximumLength + tolerance || length < 1e-8) {
      return false;
    }

    const excess = length - maximumLength;
    // The unilateral guard is a convergence/safety projection, not the
    // material response. Mild over-relaxation resolves long connected chains
    // far faster. Capping at the rest length keeps this correction itself
    // from projecting even a pathologically displaced edge into compression.
    const correctionDistance = Math.min(
      excess * 1.5,
      Math.max(0, length - strand.restLengths[segment]),
    );
    const scale = correctionDistance / (length * weightSum);
    const correctionX = dx * scale;
    const correctionY = dy * scale;
    const correctionZ = dz * scale;
    positions[offsetA] = positionAX + correctionX * inverseMassA;
    positions[offsetA + 1] = positionAY + correctionY * inverseMassA;
    positions[offsetA + 2] = positionAZ + correctionZ * inverseMassA;
    positions[offsetB] = positionBX - correctionX * inverseMassB;
    positions[offsetB + 1] = positionBY - correctionY * inverseMassB;
    positions[offsetB + 2] = positionBZ - correctionZ * inverseMassB;
    return (
      positions[offsetA] !== positionAX ||
      positions[offsetA + 1] !== positionAY ||
      positions[offsetA + 2] !== positionAZ ||
      positions[offsetB] !== positionBX ||
      positions[offsetB + 1] !== positionBY ||
      positions[offsetB + 2] !== positionBZ
    );
  }

  private updateMetrics(fixedDelta: number): void {
    const positions = this.network.particles.positions;
    const inverseDeltaSquared = 1 / (fixedDelta * fixedDelta);

    for (const strand of this.network.strandList) {
      if (!strand.active || strand.broken) {
        continue;
      }

      let maximumStretch = 0;
      let maximumTension = 0;
      for (let segment = 0; segment < strand.constraintCount; segment += 1) {
        const offsetA = strand.particleIndices[segment] * 3;
        const offsetB = strand.particleIndices[segment + 1] * 3;
        const length = Math.hypot(
          positions[offsetB] - positions[offsetA],
          positions[offsetB + 1] - positions[offsetA + 1],
          positions[offsetB + 2] - positions[offsetA + 2],
        );
        const stretch = Math.max(0, length / strand.restLengths[segment] - 1);
        const tension = Math.max(0, -strand.lambdas[segment]) * inverseDeltaSquared;
        strand.segmentTensions[segment] = tension;
        maximumStretch = Math.max(maximumStretch, stretch);
        maximumTension = Math.max(maximumTension, tension);
      }

      strand.maximumStretch = maximumStretch;
      strand.approximateTension = maximumTension;
    }
  }
}
