import * as THREE from 'three';

const EPSILON = 1e-8;
const DEFAULT_TOLERANCE = 1e-4;
const DEFAULT_MAX_ITERATIONS = 18;

export interface SpiderIKTarget {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface SpiderIKReach {
  readonly minimum: number;
  readonly comfortable: number;
  readonly maximum: number;
}

export interface SpiderIKAngleRange {
  readonly min: number;
  readonly max: number;
}

/**
 * Optional approximate joint limits, relative to the captured rest pose.
 * The axes match the rig contract: X=bend, Y=twist, Z=swing.
 */
export interface SpiderIKJointLimit {
  readonly bendX?: SpiderIKAngleRange;
  readonly twistY?: SpiderIKAngleRange;
  readonly swingZ?: SpiderIKAngleRange;
  readonly unit?: 'radians' | 'degrees';
}

export interface SpiderIKChainDefinition {
  readonly id: string;
  /** Ordered Coxa ... distal deform bone, FootTip. */
  readonly bones: readonly THREE.Bone[];
  readonly reach?: SpiderIKReach;
  /** One entry per driven bone. FootTip itself is not driven. */
  readonly jointLimits?: readonly (SpiderIKJointLimit | undefined)[];
}

export interface SpiderIKSolveOptions {
  readonly maxIterations?: number;
  readonly tolerance?: number;
  /** 0 disables the rest-pose pole bias; 1 applies the full correction. */
  readonly bendBias?: number;
  /** Limits are diagnostic-only unless explicitly enabled. */
  readonly enforceJointLimits?: boolean;
}

export type SpiderIKSolveStatus =
  | 'reached'
  | 'unreachable'
  | 'joint-limited'
  | 'invalid-target'
  | 'invalid-chain'
  | 'non-finite-result';

/** Mutable, allocation-stable diagnostics owned by the solver. */
export interface SpiderIKSolveResult {
  readonly chainId: string;
  status: SpiderIKSolveStatus;
  reached: boolean;
  targetValid: boolean;
  iterations: number;
  residual: number;
  rootDistance: number;
  solvedReach: number;
  totalLength: number;
  reachRatio: number;
  withinMinimumReach: boolean;
  withinComfortableReach: boolean;
  withinMaximumReach: boolean;
  jointClampCount: number;
  nonUniformScale: boolean;
  preferredBendDot: number;
  message: string;
  readonly requestedTarget: THREE.Vector3;
  readonly solvedFootPosition: THREE.Vector3;
}

interface RuntimeChain {
  readonly id: string;
  readonly bones: readonly THREE.Bone[];
  readonly drivenCount: number;
  readonly positions: Float64Array;
  readonly preferredPositions: Float64Array;
  readonly segmentLengths: Float64Array;
  readonly restOffsetsInRootParent: Float64Array;
  readonly childDirections: Float64Array;
  readonly restQuaternions: Float64Array;
  readonly previousQuaternions: Float64Array;
  readonly solvedQuaternions: Float64Array;
  readonly limits: Float64Array;
  readonly poleOffsetInRootParent: THREE.Vector3;
  readonly preferredPoleWorld: THREE.Vector3;
  readonly reach?: SpiderIKReach;
  readonly result: SpiderIKSolveResult;
  valid: boolean;
  invalidReason: string;
  poleJointIndex: number;
  currentUniformScale: number;
}

export interface SpiderIKSolverDefaults extends SpiderIKSolveOptions {}

/**
 * Allocation-stable FABRIK leg solver.
 *
 * Bone names are deliberately absent from this class. A loader resolves the
 * hierarchy once, then supplies ordered bone references. Rest-local rotations
 * and the neutral bend shape are captured once per chain, preserving the rig's
 * authored left/right mirror conventions.
 */
export class SpiderIKSolver {
  private readonly chains = new Map<string, RuntimeChain>();
  private readonly chainIds: string[] = [];
  private readonly defaults: Required<SpiderIKSolveOptions>;

  private readonly vectorA = new THREE.Vector3();
  private readonly vectorB = new THREE.Vector3();
  private readonly vectorC = new THREE.Vector3();
  private readonly vectorD = new THREE.Vector3();
  private readonly worldPosition = new THREE.Vector3();
  private readonly worldScale = new THREE.Vector3();
  private readonly matrix3 = new THREE.Matrix3();
  private readonly inverseMatrix = new THREE.Matrix4();
  private readonly quaternionA = new THREE.Quaternion();
  private readonly quaternionB = new THREE.Quaternion();
  private readonly quaternionC = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, 'XYZ');

  constructor(
    definitions: readonly SpiderIKChainDefinition[] = [],
    defaults: SpiderIKSolverDefaults = {},
  ) {
    this.defaults = {
      maxIterations: sanitizeIterations(defaults.maxIterations, DEFAULT_MAX_ITERATIONS),
      tolerance: sanitizePositive(defaults.tolerance, DEFAULT_TOLERANCE),
      bendBias: clampFinite(defaults.bendBias, 1, 0, 1),
      enforceJointLimits: defaults.enforceJointLimits ?? false,
    };

    for (const definition of definitions) this.addChain(definition);
  }

  addChain(definition: SpiderIKChainDefinition): SpiderIKSolveResult {
    if (!definition.id) throw new Error('Spider IK chain IDs must be non-empty.');
    if (this.chains.has(definition.id)) {
      throw new Error(`Duplicate spider IK chain ID: ${definition.id}`);
    }

    const runtime = this.captureChain(definition);
    this.chains.set(runtime.id, runtime);
    this.chainIds.push(runtime.id);
    return runtime.result;
  }

  removeChain(chainId: string): boolean {
    const removed = this.chains.delete(chainId);
    if (!removed) return false;
    const index = this.chainIds.indexOf(chainId);
    if (index >= 0) this.chainIds.splice(index, 1);
    return true;
  }

  hasChain(chainId: string): boolean {
    return this.chains.has(chainId);
  }

  getChainIds(): readonly string[] {
    return this.chainIds;
  }

  getResult(chainId: string): SpiderIKSolveResult | undefined {
    return this.chains.get(chainId)?.result;
  }

  solve(
    chainId: string,
    target: SpiderIKTarget,
    options: SpiderIKSolveOptions = {},
  ): SpiderIKSolveResult {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`Unknown spider IK chain: ${chainId}`);

    const result = chain.result;
    result.requestedTarget.set(target.x, target.y, target.z);
    resetResult(result);

    if (!isFiniteVector(target)) {
      result.status = 'invalid-target';
      result.message = 'Target contains a non-finite component; the chain was left unchanged.';
      return result;
    }

    if (!chain.valid) {
      result.status = 'invalid-chain';
      result.message = chain.invalidReason;
      return result;
    }

    const maxIterations = sanitizeIterations(options.maxIterations, this.defaults.maxIterations);
    const tolerance = sanitizePositive(options.tolerance, this.defaults.tolerance);
    const bendBias = clampFinite(options.bendBias, this.defaults.bendBias, 0, 1);
    const enforceJointLimits = options.enforceJointLimits ?? this.defaults.enforceJointLimits;

    if (!this.readCurrentPose(chain)) {
      result.status = 'invalid-chain';
      result.message = 'A bone produced a non-finite transform or a zero-length segment.';
      return result;
    }

    this.captureCurrentQuaternions(chain);
    this.writePreferredPose(chain, target);

    const positions = chain.positions;
    const rootX = positions[0];
    const rootY = positions[1];
    const rootZ = positions[2];
    const targetDx = target.x - rootX;
    const targetDy = target.y - rootY;
    const targetDz = target.z - rootZ;
    const rootDistance = Math.hypot(targetDx, targetDy, targetDz);
    let totalLength = 0;
    for (let i = 0; i < chain.segmentLengths.length; i += 1) {
      totalLength += chain.segmentLengths[i];
    }

    result.rootDistance = rootDistance;
    result.totalLength = totalLength;
    const reachMaximum = scaledReachValue(chain.reach?.maximum, chain.currentUniformScale) ?? totalLength;
    const reachMinimum = scaledReachValue(chain.reach?.minimum, chain.currentUniformScale) ?? 0;
    const reachComfortable =
      scaledReachValue(chain.reach?.comfortable, chain.currentUniformScale) ?? reachMaximum;
    result.reachRatio = reachMaximum > EPSILON ? rootDistance / reachMaximum : Number.POSITIVE_INFINITY;
    result.withinMinimumReach = rootDistance + tolerance >= reachMinimum;
    result.withinComfortableReach = rootDistance <= reachComfortable + tolerance;
    result.withinMaximumReach = rootDistance <= Math.min(reachMaximum, totalLength) + tolerance;

    if (!Number.isFinite(rootDistance) || !Number.isFinite(totalLength) || totalLength <= EPSILON) {
      result.status = 'invalid-chain';
      result.message = 'The chain has no finite reach budget.';
      return result;
    }

    const reachable = rootDistance <= totalLength - tolerance;
    if (!reachable) {
      const inverseDistance = rootDistance > EPSILON ? 1 / rootDistance : 0;
      const directionX = targetDx * inverseDistance;
      const directionY = targetDy * inverseDistance;
      const directionZ = targetDz * inverseDistance;
      let distance = 0;
      for (let i = 1; i <= chain.drivenCount; i += 1) {
        distance += chain.segmentLengths[i - 1];
        const offset = i * 3;
        positions[offset] = rootX + directionX * distance;
        positions[offset + 1] = rootY + directionY * distance;
        positions[offset + 2] = rootZ + directionZ * distance;
      }
      result.iterations = 1;
    } else {
      this.seedTowardPreferredPose(chain, bendBias);
      result.iterations = this.solveReachable(
        chain,
        target,
        rootX,
        rootY,
        rootZ,
        maxIterations,
        tolerance,
        bendBias,
      );
    }

    if (!allFinite(positions)) {
      result.status = 'non-finite-result';
      result.message = 'FABRIK produced a non-finite point; the chain was left unchanged.';
      return result;
    }

    if (!this.applySolvedPose(chain, enforceJointLimits)) {
      this.restorePreviousPose(chain);
      result.status = 'non-finite-result';
      result.message = 'A solved bone quaternion was invalid; the previous pose was restored.';
      return result;
    }

    chain.bones[chain.drivenCount].getWorldPosition(result.solvedFootPosition);
    result.residual = result.solvedFootPosition.distanceTo(result.requestedTarget);

    // Joint clamps change the foot position after FABRIK has finished, which is
    // exactly how limit enforcement used to detach feet from their silk. So when
    // a clamp fired and pushed the foot off target, re-run FABRIK *from the
    // clamped pose*: the unconstrained joints — chiefly the ball-and-socket coxa
    // — absorb the rotation the hinges refused, and the pose converges to one
    // that satisfies both the limits and the contact.
    if (enforceJointLimits && reachable) {
      for (
        let round = 0;
        round < 2 &&
        result.jointClampCount > 0 &&
        result.residual > tolerance * 4 &&
        this.readCurrentPose(chain);
        round += 1
      ) {
        result.iterations += this.solveReachable(
          chain,
          target,
          rootX,
          rootY,
          rootZ,
          maxIterations,
          tolerance,
          bendBias,
        );
        if (!allFinite(positions)) break;
        if (!this.applySolvedPose(chain, enforceJointLimits)) {
          this.restorePreviousPose(chain);
          result.status = 'non-finite-result';
          result.message = 'A refined bone quaternion was invalid; the previous pose was restored.';
          return result;
        }
        chain.bones[chain.drivenCount].getWorldPosition(result.solvedFootPosition);
        result.residual = result.solvedFootPosition.distanceTo(result.requestedTarget);
      }
    }
    result.solvedReach = result.solvedFootPosition.distanceTo(
      this.vectorA.set(rootX, rootY, rootZ),
    );
    result.preferredBendDot = this.measurePreferredBend(chain);

    if (!isFiniteVector(result.solvedFootPosition) || !Number.isFinite(result.residual)) {
      this.restorePreviousPose(chain);
      result.status = 'non-finite-result';
      result.message = 'The applied hierarchy became non-finite; the previous pose was restored.';
      return result;
    }

    if (result.jointClampCount > 0) {
      result.status = 'joint-limited';
      result.reached = result.residual <= tolerance;
      result.message = result.reached
        ? `Target reached with ${result.jointClampCount} approximate joint-limit clamp(s).`
        : `Joint limits prevented convergence (${formatResidual(result.residual)} residual).`;
    } else if (rootDistance > totalLength + tolerance || !result.withinMaximumReach) {
      result.status = 'unreachable';
      result.reached = false;
      result.message = `Target exceeds maximum reach by ${formatResidual(
        Math.max(rootDistance - Math.min(totalLength, reachMaximum), 0),
      )}.`;
    } else {
      result.status = result.residual <= tolerance ? 'reached' : 'unreachable';
      result.reached = result.residual <= tolerance;
      result.message = result.reached
        ? `Target reached in ${result.iterations} iteration(s).`
        : `Solver stopped with ${formatResidual(result.residual)} residual.`;
    }

    return result;
  }

  resetChain(chainId: string): void {
    const chain = this.chains.get(chainId);
    if (!chain) throw new Error(`Unknown spider IK chain: ${chainId}`);
    for (let i = 0; i < chain.drivenCount; i += 1) {
      const q = i * 4;
      chain.bones[i].quaternion.set(
        chain.restQuaternions[q],
        chain.restQuaternions[q + 1],
        chain.restQuaternions[q + 2],
        chain.restQuaternions[q + 3],
      );
    }
    chain.bones[0].updateWorldMatrix(true, true);
  }

  resetAll(): void {
    for (const id of this.chainIds) this.resetChain(id);
  }

  private captureChain(definition: SpiderIKChainDefinition): RuntimeChain {
    const bones = [...definition.bones];
    const drivenCount = Math.max(0, bones.length - 1);
    const pointCount = bones.length;
    const result = createResult(definition.id);
    const runtime: RuntimeChain = {
      id: definition.id,
      bones,
      drivenCount,
      positions: new Float64Array(pointCount * 3),
      preferredPositions: new Float64Array(pointCount * 3),
      segmentLengths: new Float64Array(drivenCount),
      restOffsetsInRootParent: new Float64Array(pointCount * 3),
      childDirections: new Float64Array(drivenCount * 3),
      restQuaternions: new Float64Array(drivenCount * 4),
      previousQuaternions: new Float64Array(drivenCount * 4),
      solvedQuaternions: new Float64Array(drivenCount * 4),
      limits: new Float64Array(drivenCount * 6),
      poleOffsetInRootParent: new THREE.Vector3(),
      preferredPoleWorld: new THREE.Vector3(),
      reach: normalizeReach(definition.reach),
      result,
      valid: true,
      invalidReason: '',
      poleJointIndex: Math.max(1, Math.floor(drivenCount * 0.5)),
      currentUniformScale: 1,
    };
    runtime.limits.fill(Number.NaN);

    if (bones.length < 3) {
      runtime.valid = false;
      runtime.invalidReason = 'A leg chain requires at least one root, one joint, and one FootTip.';
      result.status = 'invalid-chain';
      result.message = runtime.invalidReason;
      return runtime;
    }

    for (let i = 0; i < bones.length; i += 1) {
      if (!(bones[i] instanceof THREE.Bone)) {
        runtime.valid = false;
        runtime.invalidReason = `Chain entry ${i} is not a THREE.Bone.`;
        result.status = 'invalid-chain';
        result.message = runtime.invalidReason;
        return runtime;
      }
      if (i > 0 && bones[i].parent !== bones[i - 1]) {
        runtime.valid = false;
        runtime.invalidReason = `Bone ${bones[i].name || i} is not the direct child of the preceding chain bone.`;
        result.status = 'invalid-chain';
        result.message = runtime.invalidReason;
        return runtime;
      }
    }

    bones[0].updateWorldMatrix(true, true);
    const rootParent = bones[0].parent;
    if (rootParent) {
      rootParent.updateWorldMatrix(true, false);
      this.inverseMatrix.copy(rootParent.matrixWorld).invert();
    } else {
      this.inverseMatrix.identity();
    }

    bones[0].getWorldPosition(this.vectorA).applyMatrix4(this.inverseMatrix);
    const rootParentX = this.vectorA.x;
    const rootParentY = this.vectorA.y;
    const rootParentZ = this.vectorA.z;

    for (let i = 0; i < pointCount; i += 1) {
      bones[i].getWorldPosition(this.vectorA).applyMatrix4(this.inverseMatrix);
      const p = i * 3;
      runtime.restOffsetsInRootParent[p] = this.vectorA.x - rootParentX;
      runtime.restOffsetsInRootParent[p + 1] = this.vectorA.y - rootParentY;
      runtime.restOffsetsInRootParent[p + 2] = this.vectorA.z - rootParentZ;

      if (i >= drivenCount) continue;
      const q = i * 4;
      const localQuaternion = bones[i].quaternion;
      runtime.restQuaternions[q] = localQuaternion.x;
      runtime.restQuaternions[q + 1] = localQuaternion.y;
      runtime.restQuaternions[q + 2] = localQuaternion.z;
      runtime.restQuaternions[q + 3] = localQuaternion.w;

      const childDirection = this.vectorB.copy(bones[i + 1].position);
      if (!isFiniteVector(childDirection) || childDirection.lengthSq() <= EPSILON * EPSILON) {
        runtime.valid = false;
        runtime.invalidReason = `Bone ${bones[i + 1].name || i + 1} has no finite local segment translation.`;
        result.status = 'invalid-chain';
        result.message = runtime.invalidReason;
        return runtime;
      }
      childDirection.normalize();
      const d = i * 3;
      runtime.childDirections[d] = childDirection.x;
      runtime.childDirections[d + 1] = childDirection.y;
      runtime.childDirections[d + 2] = childDirection.z;
      this.captureLimit(runtime, i, definition.jointLimits?.[i]);
    }

    this.capturePreferredPole(runtime);
    if (!this.readCurrentPose(runtime)) {
      runtime.valid = false;
      runtime.invalidReason = 'The captured rest pose contains a zero-length or non-finite segment.';
      result.status = 'invalid-chain';
      result.message = runtime.invalidReason;
    } else {
      result.message = 'Chain captured from its neutral rest pose.';
    }
    return runtime;
  }

  private captureLimit(
    chain: RuntimeChain,
    jointIndex: number,
    limit: SpiderIKJointLimit | undefined,
  ): void {
    if (!limit) return;
    const factor = limit.unit === 'degrees' ? Math.PI / 180 : 1;
    const offset = jointIndex * 6;
    writeLimit(chain.limits, offset, limit.bendX, factor);
    writeLimit(chain.limits, offset + 2, limit.twistY, factor);
    writeLimit(chain.limits, offset + 4, limit.swingZ, factor);
  }

  private capturePreferredPole(chain: RuntimeChain): void {
    const offsets = chain.restOffsetsInRootParent;
    const end = chain.drivenCount * 3;
    this.vectorA.set(offsets[end], offsets[end + 1], offsets[end + 2]);
    const endLengthSq = this.vectorA.lengthSq();
    let bestLengthSq = 0;

    if (endLengthSq > EPSILON * EPSILON) {
      for (let i = 1; i < chain.drivenCount; i += 1) {
        const p = i * 3;
        this.vectorB.set(offsets[p], offsets[p + 1], offsets[p + 2]);
        const projection = this.vectorB.dot(this.vectorA) / endLengthSq;
        this.vectorB.addScaledVector(this.vectorA, -projection);
        const lengthSq = this.vectorB.lengthSq();
        if (lengthSq > bestLengthSq) {
          bestLengthSq = lengthSq;
          chain.poleJointIndex = i;
          chain.poleOffsetInRootParent.copy(this.vectorB);
        }
      }
    }

    if (bestLengthSq <= EPSILON * EPSILON) {
      this.vectorA.normalize();
      chooseLeastAlignedAxis(this.vectorA, chain.poleOffsetInRootParent);
      chain.poleOffsetInRootParent.addScaledVector(
        this.vectorA,
        -chain.poleOffsetInRootParent.dot(this.vectorA),
      );
    }
    chain.poleOffsetInRootParent.normalize();
  }

  private readCurrentPose(chain: RuntimeChain): boolean {
    chain.bones[0].updateWorldMatrix(true, true);
    const positions = chain.positions;
    for (let i = 0; i < chain.bones.length; i += 1) {
      chain.bones[i].getWorldPosition(this.worldPosition);
      if (!isFiniteVector(this.worldPosition)) return false;
      const p = i * 3;
      positions[p] = this.worldPosition.x;
      positions[p + 1] = this.worldPosition.y;
      positions[p + 2] = this.worldPosition.z;
      if (i === 0) continue;
      const previous = p - 3;
      const length = Math.hypot(
        positions[p] - positions[previous],
        positions[p + 1] - positions[previous + 1],
        positions[p + 2] - positions[previous + 2],
      );
      if (!Number.isFinite(length) || length <= EPSILON) return false;
      chain.segmentLengths[i - 1] = length;
    }

    chain.bones[0].getWorldScale(this.worldScale);
    const minimumScale = Math.min(
      Math.abs(this.worldScale.x),
      Math.abs(this.worldScale.y),
      Math.abs(this.worldScale.z),
    );
    const maximumScale = Math.max(
      Math.abs(this.worldScale.x),
      Math.abs(this.worldScale.y),
      Math.abs(this.worldScale.z),
    );
    chain.result.nonUniformScale =
      minimumScale <= EPSILON || maximumScale / minimumScale > 1.001;
    chain.currentUniformScale = minimumScale > EPSILON
      ? (Math.abs(this.worldScale.x) + Math.abs(this.worldScale.y) + Math.abs(this.worldScale.z)) / 3
      : 1;
    return true;
  }

  private captureCurrentQuaternions(chain: RuntimeChain): void {
    for (let i = 0; i < chain.drivenCount; i += 1) {
      const q = i * 4;
      const quaternion = chain.bones[i].quaternion;
      chain.previousQuaternions[q] = quaternion.x;
      chain.previousQuaternions[q + 1] = quaternion.y;
      chain.previousQuaternions[q + 2] = quaternion.z;
      chain.previousQuaternions[q + 3] = quaternion.w;
    }
  }

  private writePreferredPose(chain: RuntimeChain, target: SpiderIKTarget): void {
    const rootParent = chain.bones[0].parent;
    if (rootParent) {
      rootParent.updateWorldMatrix(true, false);
      this.matrix3.setFromMatrix4(rootParent.matrixWorld);
    } else {
      this.matrix3.identity();
    }

    const positions = chain.positions;
    const preferred = chain.preferredPositions;
    const offsets = chain.restOffsetsInRootParent;
    const end = chain.drivenCount * 3;
    const rootX = positions[0];
    const rootY = positions[1];
    const rootZ = positions[2];

    this.vectorA.set(offsets[end], offsets[end + 1], offsets[end + 2]).applyMatrix3(this.matrix3);
    const restEndLength = this.vectorA.length();
    this.vectorB.set(target.x - rootX, target.y - rootY, target.z - rootZ);
    const targetDistance = this.vectorB.length();

    if (restEndLength <= EPSILON) this.vectorA.set(0, 1, 0);
    else this.vectorA.multiplyScalar(1 / restEndLength);
    if (targetDistance <= EPSILON) this.vectorB.copy(this.vectorA);
    else this.vectorB.multiplyScalar(1 / targetDistance);

    this.vectorC.copy(chain.poleOffsetInRootParent).applyMatrix3(this.matrix3);
    this.vectorC.addScaledVector(this.vectorA, -this.vectorC.dot(this.vectorA));
    if (this.vectorC.lengthSq() <= EPSILON * EPSILON) {
      chooseLeastAlignedAxis(this.vectorA, this.vectorC);
      this.vectorC.addScaledVector(this.vectorA, -this.vectorC.dot(this.vectorA));
    }
    this.vectorC.normalize();
    setStableFromUnitVectors(
      this.vectorA,
      this.vectorB,
      this.vectorC,
      this.quaternionA,
    );

    let poleDistance = 0;
    for (let i = 0; i < chain.segmentLengths.length; i += 1) {
      poleDistance += chain.segmentLengths[i];
    }
    this.vectorC.applyQuaternion(this.quaternionA).normalize();
    chain.preferredPoleWorld
      .set(rootX, rootY, rootZ)
      .addScaledVector(this.vectorC, Math.max(poleDistance, restEndLength, EPSILON));

    const longitudinalScale = restEndLength > EPSILON
      ? clampFinite(targetDistance / restEndLength, 1, 0.2, 1.4)
      : 1;
    const perpendicularScale = clampFinite(0.72 + longitudinalScale * 0.28, 1, 0.55, 1.12);

    for (let i = 0; i <= chain.drivenCount; i += 1) {
      const p = i * 3;
      this.vectorD.set(offsets[p], offsets[p + 1], offsets[p + 2]).applyMatrix3(this.matrix3);
      const longitudinal = this.vectorD.dot(this.vectorA);
      this.vectorD.addScaledVector(this.vectorA, -longitudinal);
      this.vectorD.multiplyScalar(perpendicularScale);
      this.vectorD.addScaledVector(this.vectorA, longitudinal * longitudinalScale);
      this.vectorD.applyQuaternion(this.quaternionA);
      preferred[p] = rootX + this.vectorD.x;
      preferred[p + 1] = rootY + this.vectorD.y;
      preferred[p + 2] = rootZ + this.vectorD.z;
    }
    preferred[0] = rootX;
    preferred[1] = rootY;
    preferred[2] = rootZ;
    preferred[end] = target.x;
    preferred[end + 1] = target.y;
    preferred[end + 2] = target.z;
  }

  private seedTowardPreferredPose(chain: RuntimeChain, bendBias: number): void {
    if (bendBias <= 0) return;
    const seedStrength = Math.min(0.18, bendBias * 0.22);
    const positions = chain.positions;
    const preferred = chain.preferredPositions;
    for (let i = 1; i < chain.drivenCount; i += 1) {
      const p = i * 3;
      positions[p] += (preferred[p] - positions[p]) * seedStrength;
      positions[p + 1] += (preferred[p + 1] - positions[p + 1]) * seedStrength;
      positions[p + 2] += (preferred[p + 2] - positions[p + 2]) * seedStrength;
    }
  }

  private solveReachable(
    chain: RuntimeChain,
    target: SpiderIKTarget,
    rootX: number,
    rootY: number,
    rootZ: number,
    maxIterations: number,
    tolerance: number,
    bendBias: number,
  ): number {
    const positions = chain.positions;
    const lengths = chain.segmentLengths;
    const endIndex = chain.drivenCount;
    const endOffset = endIndex * 3;
    let iterations = 0;

    for (; iterations < maxIterations; iterations += 1) {
      positions[endOffset] = target.x;
      positions[endOffset + 1] = target.y;
      positions[endOffset + 2] = target.z;

      for (let i = endIndex - 1; i >= 0; i -= 1) {
        placeAtDistance(positions, i, i + 1, lengths[i]);
      }

      positions[0] = rootX;
      positions[1] = rootY;
      positions[2] = rootZ;
      for (let i = 0; i < endIndex; i += 1) {
        placeAtDistance(positions, i + 1, i, lengths[i]);
      }

      if (bendBias > 0) this.applyPreferredBend(chain, bendBias);

      const residual = Math.hypot(
        positions[endOffset] - target.x,
        positions[endOffset + 1] - target.y,
        positions[endOffset + 2] - target.z,
      );
      if (residual <= tolerance) return iterations + 1;
    }
    return iterations;
  }

  private applyPreferredBend(chain: RuntimeChain, bendBias: number): void {
    const positions = chain.positions;
    const i = THREE.MathUtils.clamp(chain.poleJointIndex, 1, chain.drivenCount - 1);
    const previous = (i - 1) * 3;
    const current = i * 3;
    const next = (i + 1) * 3;

    this.vectorA.set(
      positions[next] - positions[previous],
      positions[next + 1] - positions[previous + 1],
      positions[next + 2] - positions[previous + 2],
    );
    const axisLengthSq = this.vectorA.lengthSq();
    if (axisLengthSq <= EPSILON * EPSILON) return;
    this.vectorA.multiplyScalar(1 / Math.sqrt(axisLengthSq));

    this.vectorB.set(
      positions[current] - positions[previous],
      positions[current + 1] - positions[previous + 1],
      positions[current + 2] - positions[previous + 2],
    );
    const axialDistance = this.vectorB.dot(this.vectorA);
    this.vectorB.addScaledVector(this.vectorA, -axialDistance);

    this.vectorC.copy(chain.preferredPoleWorld).sub(
      this.vectorD.set(
        positions[previous],
        positions[previous + 1],
        positions[previous + 2],
      ),
    );
    this.vectorC.addScaledVector(this.vectorA, -this.vectorC.dot(this.vectorA));

    if (
      this.vectorB.lengthSq() <= EPSILON * EPSILON ||
      this.vectorC.lengthSq() <= EPSILON * EPSILON
    ) return;
    this.vectorB.normalize();
    this.vectorC.normalize();
    this.vectorD.crossVectors(this.vectorB, this.vectorC);
    const sine = this.vectorA.dot(this.vectorD);
    const cosine = THREE.MathUtils.clamp(this.vectorB.dot(this.vectorC), -1, 1);
    const angle = Math.atan2(sine, cosine) * bendBias;
    this.quaternionA.setFromAxisAngle(this.vectorA, angle);

    const radialLength = Math.sqrt(
      Math.max(
        0,
        distanceSquaredAt(positions, current, previous) - axialDistance * axialDistance,
      ),
    );
    this.vectorB.applyQuaternion(this.quaternionA).multiplyScalar(radialLength);
    positions[current] = positions[previous] + this.vectorA.x * axialDistance + this.vectorB.x;
    positions[current + 1] = positions[previous + 1] + this.vectorA.y * axialDistance + this.vectorB.y;
    positions[current + 2] = positions[previous + 2] + this.vectorA.z * axialDistance + this.vectorB.z;
  }

  private applySolvedPose(chain: RuntimeChain, enforceLimits: boolean): boolean {
    const positions = chain.positions;
    let clamps = 0;

    for (let i = 0; i < chain.drivenCount; i += 1) {
      const p = i * 3;
      this.vectorA.set(
        positions[p + 3] - positions[p],
        positions[p + 4] - positions[p + 1],
        positions[p + 5] - positions[p + 2],
      );
      if (!isFiniteVector(this.vectorA) || this.vectorA.lengthSq() <= EPSILON * EPSILON) {
        return false;
      }
      this.vectorA.normalize();

      const parent = chain.bones[i].parent;
      if (parent) {
        parent.getWorldQuaternion(this.quaternionA).invert();
        this.vectorA.applyQuaternion(this.quaternionA).normalize();
      }

      const d = i * 3;
      this.vectorB
        .set(
          chain.childDirections[d],
          chain.childDirections[d + 1],
          chain.childDirections[d + 2],
        );
      const q = i * 4;
      this.quaternionB.set(
        chain.restQuaternions[q],
        chain.restQuaternions[q + 1],
        chain.restQuaternions[q + 2],
        chain.restQuaternions[q + 3],
      );
      this.vectorB.applyQuaternion(this.quaternionB).normalize();
      setStableFromUnitVectors(
        this.vectorB,
        this.vectorA,
        this.vectorC.set(0, 0, 1),
        this.quaternionA,
      );
      this.quaternionC.copy(this.quaternionA).multiply(this.quaternionB).normalize();

      if (enforceLimits && hasLimits(chain.limits, i * 6)) {
        this.quaternionA.copy(this.quaternionB).invert().multiply(this.quaternionC).normalize();
        this.euler.setFromQuaternion(this.quaternionA, 'XYZ');
        const limitOffset = i * 6;
        const originalX = this.euler.x;
        const originalY = this.euler.y;
        const originalZ = this.euler.z;
        this.euler.x = clampIfLimited(this.euler.x, chain.limits, limitOffset);
        this.euler.y = clampIfLimited(this.euler.y, chain.limits, limitOffset + 2);
        this.euler.z = clampIfLimited(this.euler.z, chain.limits, limitOffset + 4);
        if (
          Math.abs(this.euler.x - originalX) > 1e-7 ||
          Math.abs(this.euler.y - originalY) > 1e-7 ||
          Math.abs(this.euler.z - originalZ) > 1e-7
        ) clamps += 1;
        this.quaternionA.setFromEuler(this.euler);
        this.quaternionC.copy(this.quaternionB).multiply(this.quaternionA).normalize();
      }

      if (!isFiniteQuaternion(this.quaternionC)) return false;
      chain.solvedQuaternions[q] = this.quaternionC.x;
      chain.solvedQuaternions[q + 1] = this.quaternionC.y;
      chain.solvedQuaternions[q + 2] = this.quaternionC.z;
      chain.solvedQuaternions[q + 3] = this.quaternionC.w;

      chain.bones[i].quaternion.copy(this.quaternionC);
      chain.bones[i].updateWorldMatrix(false, false);
    }

    chain.bones[0].updateWorldMatrix(true, true);
    chain.result.jointClampCount = clamps;
    return true;
  }

  private restorePreviousPose(chain: RuntimeChain): void {
    for (let i = 0; i < chain.drivenCount; i += 1) {
      const q = i * 4;
      chain.bones[i].quaternion.set(
        chain.previousQuaternions[q],
        chain.previousQuaternions[q + 1],
        chain.previousQuaternions[q + 2],
        chain.previousQuaternions[q + 3],
      );
    }
    chain.bones[0].updateWorldMatrix(true, true);
  }

  private measurePreferredBend(chain: RuntimeChain): number {
    if (chain.drivenCount < 2) return 1;
    const positions = chain.positions;
    const i = THREE.MathUtils.clamp(chain.poleJointIndex, 1, chain.drivenCount - 1);
    const previous = (i - 1) * 3;
    const current = i * 3;
    const next = (i + 1) * 3;
    this.vectorA.set(
      positions[next] - positions[previous],
      positions[next + 1] - positions[previous + 1],
      positions[next + 2] - positions[previous + 2],
    );
    const axisLengthSq = this.vectorA.lengthSq();
    if (axisLengthSq <= EPSILON * EPSILON) return 1;
    this.vectorA.normalize();
    this.vectorB.set(
      positions[current] - positions[previous],
      positions[current + 1] - positions[previous + 1],
      positions[current + 2] - positions[previous + 2],
    );
    this.vectorB.addScaledVector(this.vectorA, -this.vectorB.dot(this.vectorA));
    this.vectorC.set(
      chain.preferredPoleWorld.x - positions[previous],
      chain.preferredPoleWorld.y - positions[previous + 1],
      chain.preferredPoleWorld.z - positions[previous + 2],
    );
    this.vectorC.addScaledVector(this.vectorA, -this.vectorC.dot(this.vectorA));
    if (
      this.vectorB.lengthSq() <= EPSILON * EPSILON ||
      this.vectorC.lengthSq() <= EPSILON * EPSILON
    ) return 1;
    return THREE.MathUtils.clamp(this.vectorB.normalize().dot(this.vectorC.normalize()), -1, 1);
  }
}

function createResult(chainId: string): SpiderIKSolveResult {
  return {
    chainId,
    status: 'invalid-chain',
    reached: false,
    targetValid: true,
    iterations: 0,
    residual: Number.POSITIVE_INFINITY,
    rootDistance: 0,
    solvedReach: 0,
    totalLength: 0,
    reachRatio: 0,
    withinMinimumReach: true,
    withinComfortableReach: true,
    withinMaximumReach: true,
    jointClampCount: 0,
    nonUniformScale: false,
    preferredBendDot: 1,
    message: '',
    requestedTarget: new THREE.Vector3(),
    solvedFootPosition: new THREE.Vector3(),
  };
}

function resetResult(result: SpiderIKSolveResult): void {
  result.status = 'invalid-chain';
  result.reached = false;
  result.targetValid = isFiniteVector(result.requestedTarget);
  result.iterations = 0;
  result.residual = Number.POSITIVE_INFINITY;
  result.rootDistance = 0;
  result.solvedReach = 0;
  result.totalLength = 0;
  result.reachRatio = 0;
  result.withinMinimumReach = true;
  result.withinComfortableReach = true;
  result.withinMaximumReach = true;
  result.jointClampCount = 0;
  result.preferredBendDot = 1;
  result.message = '';
}

function normalizeReach(reach: SpiderIKReach | undefined): SpiderIKReach | undefined {
  if (!reach) return undefined;
  if (
    !Number.isFinite(reach.minimum) ||
    !Number.isFinite(reach.comfortable) ||
    !Number.isFinite(reach.maximum) ||
    reach.minimum < 0 ||
    reach.comfortable < reach.minimum ||
    reach.maximum < reach.comfortable
  ) {
    throw new Error('Spider IK reach must satisfy 0 <= minimum <= comfortable <= maximum.');
  }
  return reach;
}

function scaledReachValue(value: number | undefined, scale: number): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0
    ? value * scale
    : undefined;
}

function writeLimit(
  target: Float64Array,
  offset: number,
  range: SpiderIKAngleRange | undefined,
  factor: number,
): void {
  if (!range) return;
  const minimum = range.min * factor;
  const maximum = range.max * factor;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) {
    throw new Error('Spider IK joint limits require a finite min <= max.');
  }
  target[offset] = minimum;
  target[offset + 1] = maximum;
}

function hasLimits(limits: Float64Array, offset: number): boolean {
  return (
    Number.isFinite(limits[offset]) ||
    Number.isFinite(limits[offset + 2]) ||
    Number.isFinite(limits[offset + 4])
  );
}

function clampIfLimited(value: number, limits: Float64Array, offset: number): number {
  return Number.isFinite(limits[offset])
    ? THREE.MathUtils.clamp(value, limits[offset], limits[offset + 1])
    : value;
}

function placeAtDistance(
  positions: Float64Array,
  movingIndex: number,
  fixedIndex: number,
  distance: number,
): void {
  const moving = movingIndex * 3;
  const fixed = fixedIndex * 3;
  let dx = positions[moving] - positions[fixed];
  let dy = positions[moving + 1] - positions[fixed + 1];
  let dz = positions[moving + 2] - positions[fixed + 2];
  let currentDistance = Math.hypot(dx, dy, dz);
  if (currentDistance <= EPSILON || !Number.isFinite(currentDistance)) {
    dx = 0;
    dy = 1;
    dz = 0;
    currentDistance = 1;
  }
  const scale = distance / currentDistance;
  positions[moving] = positions[fixed] + dx * scale;
  positions[moving + 1] = positions[fixed + 1] + dy * scale;
  positions[moving + 2] = positions[fixed + 2] + dz * scale;
}

function distanceSquaredAt(values: Float64Array, a: number, b: number): number {
  const dx = values[a] - values[b];
  const dy = values[a + 1] - values[b + 1];
  const dz = values[a + 2] - values[b + 2];
  return dx * dx + dy * dy + dz * dz;
}

function setStableFromUnitVectors(
  from: THREE.Vector3,
  to: THREE.Vector3,
  fallbackPerpendicular: THREE.Vector3,
  target: THREE.Quaternion,
): void {
  const dot = THREE.MathUtils.clamp(from.dot(to), -1, 1);
  if (dot < -0.999999) {
    fallbackPerpendicular.addScaledVector(
      from,
      -fallbackPerpendicular.dot(from),
    );
    if (fallbackPerpendicular.lengthSq() <= EPSILON * EPSILON) {
      chooseLeastAlignedAxis(from, fallbackPerpendicular);
      fallbackPerpendicular.addScaledVector(from, -fallbackPerpendicular.dot(from));
    }
    target.setFromAxisAngle(fallbackPerpendicular.normalize(), Math.PI);
  } else {
    target.setFromUnitVectors(from, to);
  }
}

function chooseLeastAlignedAxis(direction: THREE.Vector3, target: THREE.Vector3): void {
  const ax = Math.abs(direction.x);
  const ay = Math.abs(direction.y);
  const az = Math.abs(direction.z);
  if (ax <= ay && ax <= az) target.set(1, 0, 0);
  else if (ay <= az) target.set(0, 1, 0);
  else target.set(0, 0, 1);
}

function isFiniteVector(vector: SpiderIKTarget): boolean {
  return Number.isFinite(vector.x) && Number.isFinite(vector.y) && Number.isFinite(vector.z);
}

function isFiniteQuaternion(quaternion: THREE.Quaternion): boolean {
  return (
    Number.isFinite(quaternion.x) &&
    Number.isFinite(quaternion.y) &&
    Number.isFinite(quaternion.z) &&
    Number.isFinite(quaternion.w)
  );
}

function allFinite(values: Float64Array): boolean {
  for (let i = 0; i < values.length; i += 1) {
    if (!Number.isFinite(values[i])) return false;
  }
  return true;
}

function sanitizeIterations(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? THREE.MathUtils.clamp(Math.round(value as number), 1, 64) : fallback;
}

function sanitizePositive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : fallback;
}

function clampFinite(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  return Number.isFinite(value)
    ? THREE.MathUtils.clamp(value as number, minimum, maximum)
    : fallback;
}

function formatResidual(value: number): string {
  return Number.isFinite(value) ? value.toExponential(2) : 'non-finite';
}
