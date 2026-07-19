import * as THREE from "three";
import type { PlannedRoute, StrandAddress, StrandTraversal } from "../../traversal/index";

interface Span {
  readonly strandId: string;
  readonly fromT: number;
  readonly toT: number;
  readonly length: number;
  /** Route distance at the start of this span. */
  readonly offset: number;
}

/**
 * A cursor that walks a planned route.
 *
 * The cursor is not a point in space — it is a semantic `{ strandId, t }` that
 * happens to be somewhere along the route. That matters: when the web sags under
 * the spider's weight, the spider's own idea of "where I am going" sags with it,
 * for free, because the address resolves against the live silk every frame.
 */
export class RouteFollower {
  private spans: Span[] = [];
  private total = 0;
  private distance = 0;
  /** A valid plan whose filtered material distance is already zero. */
  private zeroDistanceArrival = false;

  readonly cursorAddress: { strandId: string; t: number } = { strandId: "", t: 0 };

  get hasRoute(): boolean {
    return this.spans.length > 0;
  }

  get routeLength(): number {
    return this.total;
  }

  get travelled(): number {
    return this.distance;
  }

  get remaining(): number {
    return Math.max(0, this.total - this.distance);
  }

  get arrived(): boolean {
    return this.zeroDistanceArrival || (this.hasRoute && this.remaining <= 1e-3);
  }

  setRoute(route: PlannedRoute): void {
    this.spans = [];
    this.total = 0;
    this.zeroDistanceArrival = false;
    for (const leg of route.legs) {
      const length = Math.abs(leg.materialDistance);
      if (length <= 1e-6) {
        continue;
      }
      this.spans.push({
        strandId: leg.strandId,
        fromT: leg.fromT,
        toT: leg.toT,
        length,
        offset: this.total,
      });
      this.total += length;
    }
    this.distance = 0;
    this.zeroDistanceArrival = this.spans.length === 0;
  }

  clear(): void {
    this.spans = [];
    this.total = 0;
    this.distance = 0;
    this.zeroDistanceArrival = false;
  }

  /** Moves the cursor forward, never past the end of the route. */
  advance(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance + delta, 0, this.total);
  }

  /** Pulls the cursor back — used when the feet cannot keep up. */
  hold(delta: number): void {
    this.distance = THREE.MathUtils.clamp(this.distance - delta, 0, this.total);
  }

  /** The route address `lookahead` metres beyond the cursor, clamped to the end. */
  addressAt(lookahead = 0): StrandAddress | null {
    if (this.spans.length === 0) {
      return null;
    }
    const target = THREE.MathUtils.clamp(this.distance + lookahead, 0, this.total);
    const span = this.spanAt(target);
    const local = span.length > 0 ? (target - span.offset) / span.length : 0;
    const t = span.fromT + (span.toT - span.fromT) * THREE.MathUtils.clamp(local, 0, 1);
    this.cursorAddress.strandId = span.strandId;
    this.cursorAddress.t = t;
    return this.cursorAddress;
  }

  /** Resolves a route address to a live world position. Returns false if the silk is gone. */
  positionAt(traversal: StrandTraversal, lookahead: number, out: THREE.Vector3): boolean {
    const address = this.addressAt(lookahead);
    if (!address) {
      return false;
    }
    try {
      traversal.getWorldPosition(address, out);
    } catch {
      return false;
    }
    return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z);
  }

  private spanAt(distance: number): Span {
    // Routes are a handful of spans; a scan is cheaper than anything cleverer.
    for (let i = this.spans.length - 1; i >= 0; i -= 1) {
      if (distance >= this.spans[i].offset) {
        return this.spans[i];
      }
    }
    return this.spans[0];
  }
}
