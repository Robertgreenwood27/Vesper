import { SPIDER_LEG_IDS, type SpiderLegId } from "../SpiderRigSpec";

export interface LegDesire {
  readonly legId: SpiderLegId;
  /** 1 means "this foot has drifted far enough from home to want a step". */
  readonly desire: number;
  /** True if this foot is about to be dragged past its usable reach. */
  readonly urgent: boolean;
}

export interface GaitPermission {
  readonly plantedCount: number;
  readonly swinging: ReadonlySet<SpiderLegId>;
  readonly minimumPlanted: number;
  readonly maximumSwinging: number;
}

interface LegAnatomy {
  readonly side: "left" | "right";
  readonly index: number;
}

const ANATOMY: Record<SpiderLegId, LegAnatomy> = Object.fromEntries(
  SPIDER_LEG_IDS.map((id) => [
    id,
    { side: id[0] === "L" ? "left" : "right", index: Number(id[1]) },
  ]),
) as Record<SpiderLegId, LegAnatomy>;

/**
 * Decides which foot moves next — and this is a decision we are happy to fake.
 *
 * There is no scoring pass, no candidate enumeration, no history model, and no
 * gait table. Instead:
 *
 *   desire     comes from real geometry — how far a foot has drifted from the
 *              body's authored FootHome as the body advanced without it.
 *   permission comes from two anatomical rules a spider obeys anyway: never lift
 *              a neighbour of a leg already in the air, and always leave enough
 *              feet down.
 *
 * Desire rises continuously and permission gates it, so the alternating tetrapod
 * pattern falls out on its own, and it falls out *irregularly* — because drift
 * depends on real terrain, the spider never repeats a fixed leg order. That is
 * the exact property the old scoring architecture spent thousands of lines
 * trying to manufacture, and here it is a side effect of doing less.
 */
export class Gait {
  /**
   * Returns the legs that should begin a step this frame, best first.
   * The caller still has to find each one a real foothold, and may get none.
   */
  select(desires: readonly LegDesire[], permission: GaitPermission): SpiderLegId[] {
    const swingRoom = permission.maximumSwinging - permission.swinging.size;
    const liftRoom = permission.plantedCount - permission.minimumPlanted;
    let budget = Math.min(swingRoom, liftRoom);
    if (budget <= 0) {
      return [];
    }

    const ranked = desires
      .filter((entry) => entry.desire >= 1 && !permission.swinging.has(entry.legId))
      // An urgent leg jumps the queue: it is being dragged and looks wrong.
      .sort((a, b) => Number(b.urgent) - Number(a.urgent) || b.desire - a.desire);

    const chosen: SpiderLegId[] = [];
    const inFlight = new Set(permission.swinging);

    for (const entry of ranked) {
      if (budget <= 0) {
        break;
      }
      if (this.blockedByNeighbour(entry.legId, inFlight)) {
        continue;
      }
      chosen.push(entry.legId);
      inFlight.add(entry.legId);
      budget -= 1;
    }

    return chosen;
  }

  /** Only prevent a same-side neighbour from joining a leg already in flight. */
  private blockedByNeighbour(legId: SpiderLegId, inFlight: ReadonlySet<SpiderLegId>): boolean {
    const self = ANATOMY[legId];
    for (const other of inFlight) {
      const neighbour = ANATOMY[other];
      if (neighbour.side === self.side && Math.abs(neighbour.index - self.index) <= 1) {
        return true;
      }
      // Opposite legs in the same anatomical pair may now overlap briefly. With
      // four or more other supports down this is visually stable, and removing
      // the extra prohibition gives the gait room to escape sparse geometry.
    }
    return false;
  }
}
