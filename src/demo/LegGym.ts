import * as THREE from "three";
import type { SpiderIKSolver } from "../spider/SpiderIKSolver";
import type { SpiderRig } from "../spider/SpiderRig";
import { SPIDER_LEG_IDS } from "../spider/SpiderRigSpec";

/**
 * The leg gym: a deterministic stress bench for the leg solver, run inside the
 * real app behind `?legGym=1`.
 *
 * The body is left frozen where she settled and every foot is driven through a
 * scripted trajectory that concentrates on the two known failure modes:
 * targets sweeping close to the coxa (the "curl" that makes FABRIK fold a
 * chain double) and fast direction changes (which expose roll discontinuity as
 * mesh whipping about the leg's own axis). Because the body never moves and no
 * web addresses are involved, anything that reproduces here is the solver's
 * fault alone — momentum and silk are eliminated as suspects.
 *
 * Metrics accumulate continuously and read out through `__silklab.gym()`:
 *  - whip: worst per-bone frame-to-frame rotation, plus a count of frames
 *    where a bone jumped more than 45° — a solid leg should never do that
 *    faster than its target moves.
 *  - folds: frames where adjacent segments bend past 110°, the point where
 *    the skinned joint visibly dislocates.
 */
export class LegGym {
  private time = 0;
  private samples = 0;
  private foldEvents = 0;
  private whipEvents = 0;
  private worstWhipDegrees = 0;
  private worstFoldDegrees = 0;
  private readonly phase: Record<string, number> = {};
  private readonly previousQuats = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly coxa = new THREE.Vector3();
  private readonly restDirection = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly axisSide = new THREE.Vector3();
  private readonly axisUp = new THREE.Vector3(0, 1, 0);
  private readonly scratchA = new THREE.Vector3();
  private readonly scratchB = new THREE.Vector3();
  private readonly scratchQuat = new THREE.Quaternion();

  constructor(
    private readonly rig: SpiderRig,
    private readonly ik: SpiderIKSolver,
  ) {
    for (let i = 0; i < SPIDER_LEG_IDS.length; i += 1) {
      this.phase[SPIDER_LEG_IDS[i]] = (i / SPIDER_LEG_IDS.length) * Math.PI * 2;
    }
  }

  update(dt: number): void {
    this.time += dt;
    this.samples += 1;

    for (const legId of SPIDER_LEG_IDS) {
      const leg = this.rig.legs[legId];
      leg.chain[0].getWorldPosition(this.coxa);
      leg.footHome.getWorldPosition(this.restDirection);
      this.restDirection.sub(this.coxa);
      const restLength = this.restDirection.length();
      if (restLength < 1e-5) continue;
      this.restDirection.divideScalar(restLength);

      // A curl cycle: radius breathes between deep-crouch and near-full
      // extension while the aim swings through the leg's working sector.
      const t = this.time + this.phase[legId];
      const radius = leg.reach.max * (0.62 + 0.32 * Math.sin(t * 0.9));
      const azimuth = Math.sin(t * 0.67) * 0.65;
      const elevation = Math.sin(t * 1.13) * 0.45;

      this.axisSide.crossVectors(this.restDirection, this.axisUp);
      if (this.axisSide.lengthSq() < 1e-8) this.axisSide.set(1, 0, 0);
      this.axisSide.normalize();

      this.scratchA
        .copy(this.restDirection)
        .applyAxisAngle(this.axisUp, azimuth)
        .applyAxisAngle(this.axisSide, elevation)
        .normalize();
      this.target.copy(this.coxa).addScaledVector(this.scratchA, radius);
      this.ik.solve(legId, this.target);
    }

    this.measure(dt);
  }

  private measure(dt: number): void {
    for (const legId of SPIDER_LEG_IDS) {
      const chain = this.rig.legs[legId].chain;

      // Whip: per-bone rotation since last step.
      for (let i = 0; i < chain.length - 1; i += 1) {
        const bone = chain[i];
        const previous = this.previousQuats.get(bone);
        if (previous) {
          const dot = Math.min(1, Math.abs(previous.dot(bone.quaternion)));
          const degrees = (2 * Math.acos(dot) * 180) / Math.PI;
          if (degrees > this.worstWhipDegrees) this.worstWhipDegrees = degrees;
          if (degrees > 45) this.whipEvents += 1;
        }
        this.previousQuats.set(bone, (previous ?? new THREE.Quaternion()).copy(bone.quaternion));
      }

      // Folds: direction reversal between consecutive segments.
      let previousDir: THREE.Vector3 | null = null;
      for (let i = 0; i < chain.length - 1; i += 1) {
        chain[i].getWorldPosition(this.scratchA);
        chain[i + 1].getWorldPosition(this.scratchB);
        this.scratchB.sub(this.scratchA);
        if (this.scratchB.lengthSq() < 1e-10) continue;
        this.scratchB.normalize();
        if (previousDir && i >= 2) {
          const turn = (Math.acos(THREE.MathUtils.clamp(previousDir.dot(this.scratchB), -1, 1)) * 180) / Math.PI;
          if (turn > this.worstFoldDegrees) this.worstFoldDegrees = turn;
          if (turn > 110) this.foldEvents += 1;
        }
        previousDir = (previousDir ?? new THREE.Vector3()).copy(this.scratchB);
      }
    }
    void dt;
    void this.scratchQuat;
  }

  metrics(): Record<string, number> {
    return {
      seconds: Number(this.time.toFixed(1)),
      samples: this.samples,
      whipEvents: this.whipEvents,
      worstWhipDegreesPerStep: Number(this.worstWhipDegrees.toFixed(1)),
      foldEvents: this.foldEvents,
      worstFoldDegrees: Number(this.worstFoldDegrees.toFixed(1)),
    };
  }

  reset(): void {
    this.samples = 0;
    this.foldEvents = 0;
    this.whipEvents = 0;
    this.worstWhipDegrees = 0;
    this.worstFoldDegrees = 0;
  }
}
