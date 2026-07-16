import * as THREE from "three";
import type { StrandAddress, StrandTraversal, Vec3Like } from "../../traversal/index";

export interface FootholdRequest {
  /** Where the foot would ideally land, already biased ahead along travel. */
  readonly aim: Vec3Like;
  /** The coxa head. Reach is measured from here, exactly as the rig spec defines. */
  readonly reachOrigin: Vec3Like;
  readonly reach: { readonly min: number; readonly comfortable: number; readonly max: number };
  readonly searchRadius: number;
  /** Addresses currently claimed by other feet, so we do not stack them. */
  readonly occupied: readonly StrandAddress[];
  /**
   * The direction this leg naturally points, coxa -> FootHome, in world space.
   * Candidates are confined to a generous cone around it as a backstop.
   */
  readonly restDirection: Vec3Like;
  /** Cosine of the widest angle off `restDirection` a foothold may sit at. */
  readonly sweepCos: number;
  /** The body's centre — the midline runs through it. */
  readonly bodyCentre: Vec3Like;
  /** Unit vector pointing away from the midline, on this leg's side. */
  readonly outward: Vec3Like;
  /** How far past the midline a foot may plant, in model units. */
  readonly midlineTolerance: number;
}

export interface Foothold {
  readonly address: StrandAddress;
  readonly position: THREE.Vector3;
  /** Distance from the aim point. Smaller is a tidier stride. */
  readonly offset: number;
  /** Distance from the coxa, in model units. */
  readonly reachDistance: number;
}

/**
 * Everything here is in **model units, not normalized t**, and converted per
 * strand. `t` is a fraction of one strand's length, so a fixed t is a different
 * real distance on every strand — and silently wrong the moment strand lengths
 * change. When spans grew from under a legspan to several, a "0.075 t" foot
 * spacing became half a unit of dead zone, her feet crowded each other off the
 * only silk there was, and she walked a long span on four legs.
 */

/** Two feet closer together than this along one strand look like a mistake. */
const MINIMUM_SEPARATION_UNITS = 0.12;
/** How many distinct nearby strands a leg will consider before giving up. */
const MAX_STRANDS = 4;
/** How far along the strand to look, either way, from the closest point. */
const SLIDE_UNITS = [0, 0.08, -0.08, 0.16, -0.16, 0.28, -0.28, 0.45, -0.45, 0.7, -0.7];

/**
 * Finds a real place to put a real foot.
 *
 * This is the one part of the choreography that is not allowed to invent anything.
 * The aim point is a guess and the search is deliberately shallow, but whatever
 * comes back is a genuine `{ strandId, t }` on genuine silk, at a genuine
 * reachable distance. If there is nowhere to stand, this returns null and the
 * spider deals with it — it never conjures a foothold to keep the gait tidy.
 */
export class FootholdSearch {
  private readonly probe = new THREE.Vector3();
  private readonly allowed = new Set<string>();

  constructor(private readonly traversal: StrandTraversal) {}

  /**
   * Considers the nearest few strands, not just the nearest one.
   *
   * Taking only the closest strand looks reasonable and quietly cripples the
   * spider: if that one thread happens to be out of the reach window or already
   * occupied, the leg reports "nowhere to stand" while perfectly good silk sits a
   * few centimetres further out. In a tangle — which is nearly all neighbours —
   * that is the difference between walking and standing there waving a leg.
   */
  find(request: FootholdRequest): Foothold | null {
    this.allowed.clear();
    for (const strand of this.traversal.source.strands.values()) {
      this.allowed.add(strand.id);
    }

    for (let attempt = 0; attempt < MAX_STRANDS; attempt += 1) {
      const hit = this.traversal.findClosestPoint(request.aim, {
        maximumDistance: request.searchRadius,
        traversableOnly: true,
        strandIds: this.allowed,
      });
      if (!hit) {
        return null;
      }
      const foothold = this.evaluate(hit.address.strandId, hit.address.t, request);
      if (foothold) {
        return foothold;
      }
      // That strand offers nothing usable; ask what else is nearby.
      this.allowed.delete(hit.address.strandId);
    }
    return null;
  }

  /** Slides along one strand looking for a spot that is reachable and uncrowded. */
  private evaluate(strandId: string, nearestT: number, request: FootholdRequest): Foothold | null {
    let best: Foothold | null = null;
    let bestScore = Infinity;

    // Real distances only mean something once we know how long this strand is.
    const length = this.traversal.getStrand(strandId)?.totalRestLength ?? 0;
    if (length <= 1e-6) {
      return null;
    }
    const separationT = MINIMUM_SEPARATION_UNITS / length;

    for (const slide of SLIDE_UNITS) {
      const t = nearestT + slide / length;
      if (t < 0 || t > 1) {
        continue;
      }
      const address: StrandAddress = { strandId, t };
      if (this.isCrowded(address, request.occupied, separationT)) {
        continue;
      }

      try {
        this.traversal.getWorldPosition(address, this.probe);
      } catch {
        continue;
      }
      if (!Number.isFinite(this.probe.x) || !Number.isFinite(this.probe.y) || !Number.isFinite(this.probe.z)) {
        continue;
      }

      const reachDistance = distanceTo(this.probe, request.reachOrigin);
      // Stay off both hard limits; a foot planted at the edge of its reach has
      // nowhere to go when the web moves, and the contact will invalidate.
      if (reachDistance < request.reach.min * 1.08 || reachDistance > request.reach.max * 0.92) {
        continue;
      }

      // A left foot belongs on the left.
      //
      // Reach distance is direction-blind, so silk on the far side of the body
      // reads as perfectly reachable and the leg takes it — which is how a leg
      // ends up folded through the abdomen. Testing the midline rather than the
      // leg's rest direction forbids exactly that and nothing else, leaving her
      // free to reach fore and aft along a strand, which is all a spider walking
      // a single line can do.
      const lateral =
        (this.probe.x - request.bodyCentre.x) * request.outward.x +
        (this.probe.y - request.bodyCentre.y) * request.outward.y +
        (this.probe.z - request.bodyCentre.z) * request.outward.z;
      if (lateral < -request.midlineTolerance) {
        continue;
      }

      // Backstop against a leg folding completely back on itself.
      if (reachDistance > 1e-6) {
        const sweep =
          ((this.probe.x - request.reachOrigin.x) * request.restDirection.x +
            (this.probe.y - request.reachOrigin.y) * request.restDirection.y +
            (this.probe.z - request.reachOrigin.z) * request.restDirection.z) /
          reachDistance;
        if (sweep < request.sweepCos) {
          continue;
        }
      }

      // Prefer silk near the aim, then prefer a natural stance.
      //
      // The stance term has to be symmetric. Penalising only reach *beyond*
      // comfortable looks right and is quietly biased: of two candidates the same
      // distance from the aim, the one tucked in under the body scores free while
      // the one properly extended pays — so every foot creeps inward and she
      // walks permanently crouched, legs bunched under her. The rig authors
      // FootHome at exactly the comfortable reach, so deviation either way is
      // equally wrong.
      const offsetFromAim = distanceTo(this.probe, request.aim);
      const stance = Math.abs(reachDistance - request.reach.comfortable);
      const score = offsetFromAim + stance * 0.35;
      if (score < bestScore) {
        bestScore = score;
        best = {
          address,
          position: this.probe.clone(),
          offset: offsetFromAim,
          reachDistance,
        };
      }
    }

    return best;
  }

  private isCrowded(
    address: StrandAddress,
    occupied: readonly StrandAddress[],
    separationT: number,
  ): boolean {
    for (const other of occupied) {
      if (other.strandId === address.strandId && Math.abs(other.t - address.t) < separationT) {
        return true;
      }
    }
    return false;
  }
}

function distanceTo(a: Vec3Like, b: Vec3Like): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
