import * as THREE from "three";
import type { StrandAddress, StrandTraversal } from "../../traversal/index";
import type { SpiderLegId } from "../SpiderRigSpec";

/** Nominal swing distance the configured duration is authored against. */
const NOMINAL_DISTANCE = 0.3;

/**
 * One leg in flight.
 *
 * The target is a semantic address, not a frozen point. It is re-resolved from
 * the live web on every frame, so a foot reaching for a strand that is swaying
 * under the spider's own weight will track it and land on it. That tracking is
 * the single cheapest source of "it knows what it's doing" in the whole system.
 */
export class Swing {
  readonly legId: SpiderLegId;
  readonly target: StrandAddress;

  private readonly from = new THREE.Vector3();
  private readonly live = new THREE.Vector3();
  private readonly output = new THREE.Vector3();
  private readonly lift = new THREE.Vector3();

  private elapsed = 0;
  private readonly duration: number;
  private readonly liftHeight: number;
  private failed = false;

  constructor(options: {
    legId: SpiderLegId;
    target: StrandAddress;
    from: THREE.Vector3;
    to: THREE.Vector3;
    up: THREE.Vector3;
    baseDuration: number;
    liftHeight: number;
  }) {
    this.legId = options.legId;
    this.target = options.target;
    this.from.copy(options.from);
    this.live.copy(options.to);
    this.lift.copy(options.up).normalize();

    const distance = this.from.distanceTo(options.to);
    // Longer reaches take longer, but sub-linearly — a spider hurrying a long
    // step still looks quick, it just looks like it meant it.
    const scale = Math.sqrt(Math.max(distance, 1e-3) / NOMINAL_DISTANCE);
    this.duration = Math.max(0.08, options.baseDuration * THREE.MathUtils.clamp(scale, 0.6, 1.9));
    this.liftHeight = options.liftHeight * THREE.MathUtils.clamp(scale, 0.7, 1.6);
  }

  get progress(): number {
    return Math.min(1, this.elapsed / this.duration);
  }

  get landed(): boolean {
    return this.elapsed >= this.duration;
  }

  /** True if the silk we were reaching for disappeared mid-flight. */
  get lost(): boolean {
    return this.failed;
  }

  /**
   * Advances the swing and returns where the foot should be right now.
   * The returned vector is reused; copy it if you need to keep it.
   */
  advance(dt: number, traversal: StrandTraversal): THREE.Vector3 {
    this.elapsed += dt;

    // Follow the target address as the real silk moves beneath it.
    try {
      traversal.getWorldPosition(this.target, this.live);
      if (!isFinite(this.live.x) || !isFinite(this.live.y) || !isFinite(this.live.z)) {
        this.failed = true;
      }
    } catch {
      this.failed = true;
    }

    const p = this.progress;
    this.output.copy(this.from).lerp(this.live, horizontalEase(p));
    this.output.addScaledVector(this.lift, arcHeight(p) * this.liftHeight);
    return this.output;
  }
}

/**
 * Front-loaded ease. The foot leaves quickly and arrives slowly, which reads as
 * precision — the spider looks like it is placing the foot rather than dropping it.
 */
function horizontalEase(p: number): number {
  const c = THREE.MathUtils.clamp(p, 0, 1);
  return 1 - Math.pow(1 - c, 2.4);
}

/**
 * Arc with a flat top. A pure sine peaks for an instant; this hangs briefly at
 * the apex, which is what makes the step look considered instead of flicked.
 */
function arcHeight(p: number): number {
  const c = THREE.MathUtils.clamp(p, 0, 1);
  return Math.pow(Math.sin(Math.PI * c), 0.7);
}
