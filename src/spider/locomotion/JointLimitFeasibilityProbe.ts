import * as THREE from "three";
import {
  SpiderIKSolver,
  type SpiderIKChainDefinition,
  type SpiderIKSolveOptions,
} from "../SpiderIKSolver";
import type { SpiderLegId } from "../SpiderRigSpec";
import type { JointFeasibilityResult } from "./LocomotionTypes";

const EPSILON = 1e-8;

interface MirrorChain {
  readonly sourceBones: readonly THREE.Bone[];
  readonly mirrorParent: THREE.Object3D;
  readonly mirrorBones: readonly THREE.Bone[];
  readonly drivenCount: number;
}

export interface JointLimitFeasibilityProbeOptions extends SpiderIKSolveOptions {
  /** Residual span used only to normalize the diagnostic violation signal. */
  readonly violationResidualRatio?: number;
  /** Approximate constrained solve tolerance as a fraction of chain length. */
  readonly maximumFeasibleResidualRatio?: number;
}

/**
 * Runs the production IK implementation against detached mirror chains.
 *
 * Every query starts by copying the live chain's local pose and parent world
 * transform into its mirror. The constrained solve can therefore use the
 * rig's real per-joint limits without touching the rendered skeleton or the
 * animation solver's mutable diagnostics.
 */
export class JointLimitFeasibilityProbe {
  private readonly solver: SpiderIKSolver;
  private readonly chains = new Map<SpiderLegId, MirrorChain>();
  private readonly solveOptions: SpiderIKSolveOptions;
  private readonly violationResidualRatio: number;
  private readonly maximumFeasibleResidualRatio: number;

  constructor(
    definitions: readonly SpiderIKChainDefinition[],
    options: JointLimitFeasibilityProbeOptions = {},
  ) {
    const {
      violationResidualRatio = 0.42,
      maximumFeasibleResidualRatio = 0.42,
      maxIterations,
      tolerance,
      bendBias,
    } = options;
    this.violationResidualRatio = positive(violationResidualRatio, 0.42);
    this.maximumFeasibleResidualRatio = positive(maximumFeasibleResidualRatio, 0.42);
    this.solveOptions = {
      maxIterations,
      tolerance,
      bendBias,
      enforceJointLimits: true,
    };

    const mirrorDefinitions = definitions.map((definition) => {
      const legId = definition.id as SpiderLegId;
      const mirrorParent = new THREE.Object3D();
      mirrorParent.name = `${definition.id}-joint-feasibility-parent`;
      mirrorParent.matrixAutoUpdate = false;

      const mirrorBones = definition.bones.map((source) => {
        const mirror = new THREE.Bone();
        mirror.name = `${source.name}-joint-feasibility`;
        copyLocalTransform(mirror, source);
        return mirror;
      });
      mirrorParent.add(mirrorBones[0]);
      for (let index = 1; index < mirrorBones.length; index += 1) {
        mirrorBones[index - 1].add(mirrorBones[index]);
      }
      syncParentWorldTransform(mirrorParent, definition.bones[0].parent);

      this.chains.set(legId, {
        sourceBones: definition.bones,
        mirrorParent,
        mirrorBones,
        drivenCount: Math.max(0, mirrorBones.length - 1),
      });
      return {
        ...definition,
        bones: mirrorBones,
      };
    });

    this.solver = new SpiderIKSolver(mirrorDefinitions, this.solveOptions);
  }

  test(legId: SpiderLegId, worldPosition: THREE.Vector3Like): JointFeasibilityResult {
    const chain = this.chains.get(legId);
    if (!chain) {
      return {
        feasible: false,
        violation: 1,
        reason: `No joint-limit probe chain is registered for ${legId}.`,
      };
    }

    this.syncMirror(chain);
    const result = this.solver.solve(legId, worldPosition, this.solveOptions);
    const resultFinite =
      result.targetValid &&
      Number.isFinite(result.residual) &&
      result.status !== "invalid-chain" &&
      result.status !== "invalid-target" &&
      result.status !== "non-finite-result";
    // The detached probe is an approximate policy query, not the render-side
    // final solve. A millimetre-scale exact tolerance rejects almost every
    // continuous sample once authored joint clamps engage, so accept a small
    // chain-relative residual while still using the real constrained solver.
    const maximumFeasibleResidual = Math.max(
      this.solveOptions.tolerance ?? 0.001,
      result.totalLength * this.maximumFeasibleResidualRatio,
    );
    const feasible =
      resultFinite &&
      result.residual <= maximumFeasibleResidual &&
      result.withinMinimumReach &&
      result.withinMaximumReach;

    const clampViolation = chain.drivenCount > 0
      ? THREE.MathUtils.clamp(result.jointClampCount / chain.drivenCount, 0, 1)
      : 1;
    const residualSpan = Math.max(
      EPSILON,
      result.totalLength * this.violationResidualRatio,
    );
    const residualViolation = resultFinite
      ? THREE.MathUtils.clamp(result.residual / residualSpan, 0, 1)
      : 1;
    const violation = THREE.MathUtils.clamp(
      Math.max(clampViolation, residualViolation),
      0,
      1,
    );

    return {
      feasible,
      violation,
      reason: feasible
        ? undefined
        : `Constrained ${legId} IK rejected the foothold: ${result.message}`,
    };
  }

  private syncMirror(chain: MirrorChain): void {
    const sourceParent = chain.sourceBones[0].parent;
    sourceParent?.updateWorldMatrix(true, false);
    syncParentWorldTransform(chain.mirrorParent, sourceParent);
    for (let index = 0; index < chain.sourceBones.length; index += 1) {
      copyLocalTransform(chain.mirrorBones[index], chain.sourceBones[index]);
    }
    chain.mirrorBones[0].updateWorldMatrix(false, true);
  }
}

function copyLocalTransform(target: THREE.Object3D, source: THREE.Object3D): void {
  target.position.copy(source.position);
  target.quaternion.copy(source.quaternion);
  target.scale.copy(source.scale);
  target.updateMatrix();
}

function syncParentWorldTransform(
  mirrorParent: THREE.Object3D,
  sourceParent: THREE.Object3D | null,
): void {
  if (sourceParent) mirrorParent.matrix.copy(sourceParent.matrixWorld);
  else mirrorParent.matrix.identity();
  mirrorParent.matrixWorldNeedsUpdate = true;
  mirrorParent.updateWorldMatrix(false, true);
}

function positive(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : fallback;
}
