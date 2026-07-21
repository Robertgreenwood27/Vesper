import { createEnclosureLayout } from "./enclosureLayout";
import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";
import type { WebStrand } from "./WebStrand";

/**
 * A taut, springy, irregular cobweb strung through a cylindrical enclosure.
 *
 * This is a *test fixture*, not the game's web builder — but it has to be the
 * right kind of silk, because the wrong kind flatters or breaks the spider for
 * reasons that have nothing to do with her.
 *
 * Everything is measured in **legspans**, and that is the whole point. A web is
 * built by a spider, so its scale is her scale: a widow strings lines many body
 * lengths long and walks them like tightropes, meeting a junction only now and
 * then. Build on an absolute grid instead and it is easy to end up with nodes
 * closer together than the spider is wide — she straddles six at once, every
 * foothold lands on a junction, and the IK spends its life resolving a knot. She
 * gets stuck in her own web.
 *
 * Long spans are also what keep it **bouncy**, which is the reason this project
 * exists. Tautness and bounce are not opposites — a guitar string is both. What
 * kills bounce is short segments, which ring too fast and too small to see. A
 * long pre-tensioned span sags a little under her weight, swings when she lands,
 * and carries the tremor to her other feet. She pulls on the web; the web pulls
 * back.
 */

/**
 * Distance across the spider, foot to opposite foot, in model units.
 *
 * Measured from the shipped rig (foot-home spread = 1.63; body length 0.91; max
 * reach 0.97). Passed in rather than hardcoded so the fixture rescales if the rig
 * ever does.
 */
export const DEFAULT_LEGSPAN = 1.63;

export interface CobwebOptions {
  readonly seed?: number;
  /** Everything below is expressed as a multiple of this. */
  readonly legSpan?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  /**
   * Rest length as a fraction of the span. Below 1 pre-tensions the strand,
   * which is the freshly-built state; toward 1 it goes slack, which is silk
   * aging into disrepair.
   */
  readonly tautness?: number;
  /** Segment length as a fraction of a legspan. Controls physics resolution. */
  readonly segmentsPerLegSpan?: number;
  /** Mass per unit length. See DEFAULT_LINEAR_DENSITY for why it is tiny. */
  readonly linearDensity?: number;
}

export interface Cobweb {
  readonly network: WebNetwork;
  readonly legSpan: number;
  /** A well-connected central strand: a good place to put her down. */
  readonly homeStrandId: string;
  /** The retreat knot, up in the corner. */
  readonly retreatNodeId: string;
  /** Far side of the web, for a long legible walk. */
  readonly farNodeId: string;
  /**
   * Relaxes one strand's rest lengths toward slack.
   *
   * Not the repair mechanic — just proof the model carries per-strand tension, so
   * the "silk sags, player commands a re-tension" loop has something to drive.
   */
  readonly setTautness: (strandId: string, tautness: number) => void;
}

interface Hub {
  readonly node: WebNode;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 0x100000000;
  }
  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }
}

/**
 * Mass per unit length of silk.
 *
 * Small, and it has to be. A widow weighs a great deal more than the web she
 * stands on; silk is nearly massless by comparison. The old value (0.14) was
 * tuned when spans were under a legspan long — stretched across a real room it
 * made every strand weigh ~4 N against a 2.4 N spider, so the web's own weight
 * set its tension, she was lighter than the thing she was standing on, and she
 * could not visibly stir it: silk near her moved 0.04 legspans while she walked.
 *
 * With silk this light her weight dominates, so she sags the span she is on,
 * swings it when she lands, and sends the tremor down it — the web answers back.
 */
export const DEFAULT_LINEAR_DENSITY = 0.012;

interface StrandBuild {
  slackFactor: number;
  stiffness: number;
  damping: number;
  segmentLength: number;
  linearDensity: number;
  bowX?: number;
  bowZ?: number;
}

/**
 * Lays a strand whose rest length is shorter than the gap it spans, so it is
 * under tension from the first frame rather than hanging in a catenary.
 */
function addStrand(network: WebNetwork, id: string, a: Hub, b: Hub, options: StrandBuild): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const span = Math.hypot(dx, dy, dz);
  const pointCount = Math.max(3, Math.min(24, Math.round(span / options.segmentLength) + 1));
  const positions = new Float32Array(pointCount * 3);

  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const bow = 4 * t * (1 - t);
    const offset = point * 3;
    positions[offset] = a.x + dx * t + (options.bowX ?? 0) * bow;
    positions[offset + 1] = a.y + dy * t;
    positions[offset + 2] = a.z + dz * t + (options.bowZ ?? 0) * bow;
  }

  const restLengths = new Float32Array(pointCount - 1);
  for (let segment = 0; segment < restLengths.length; segment += 1) {
    const i = segment * 3;
    const laid = Math.hypot(
      positions[i + 3] - positions[i],
      positions[i + 4] - positions[i + 1],
      positions[i + 5] - positions[i + 2],
    );
    restLengths[segment] = Math.max(1e-4, laid * options.slackFactor);
  }

  network.addStrand({
    id,
    startNode: a.node,
    endNode: b.node,
    initialPositions: positions,
    restLengths,
    stiffness: options.stiffness,
    damping: options.damping,
    linearDensity: options.linearDensity,
  });
}

export function createCobweb(options: CobwebOptions = {}): Cobweb {
  const rng = new Rng(options.seed ?? 0xc0bbe7);
  const LS = options.legSpan ?? DEFAULT_LEGSPAN;
  // Taut but alive. These three fight each other, and bounce has to win ties —
  // a web that does not answer back is the one thing this project cannot ship.
  //
  // Pre-tension is kept light on purpose. Deflection under a point load goes as
  // W*L/(4*T), so heavy pre-tension makes the silk beautifully straight and
  // completely dead: at 2.5% pre-strain her whole body weight moved a span by
  // ~0.04 units and she could not stir her own web. Low damping lets it ring
  // afterwards instead of swallowing the tremor in a few frames.
  const stiffness = options.stiffness ?? 0.78;
  const damping = options.damping ?? 0.45;
  const tautness = options.tautness ?? 0.992;
  const segmentLength = LS / (options.segmentsPerLegSpan ?? 2.2);
  const network = new WebNetwork();

  const build: StrandBuild = {
    slackFactor: tautness,
    stiffness,
    damping,
    segmentLength,
    linearDensity: options.linearDensity ?? DEFAULT_LINEAR_DENSITY,
  };
  let strandSerial = 0;
  const nextStrandId = () => `silk-${String(strandSerial++).padStart(3, "0")}`;

  // --- Enclosure, in legspans ------------------------------------------------
  // A cylindrical terrarium ~13 legspans across. A widow's web is a good
  // fraction of the space it is in, and she is small in it.
  const enclosure = createEnclosureLayout(LS);
  const FLOOR = 0;
  const CEILING = enclosure.height;

  const anchors: Hub[] = [];
  const tangle: Hub[] = [];
  let nodeSerial = 0;

  const addHub = (label: string, x: number, y: number, z: number, fixed: boolean): Hub => {
    const id = `${fixed ? "anchor" : "hub"}-${nodeSerial++}`;
    const node = network.addNode(id, label, x, y, z, fixed ? "fixed" : "dynamic", 0.05);
    const hub: Hub = { node, x, y, z };
    (fixed ? anchors : tangle).push(hub);
    return hub;
  };

  /** Pulls an xz point radially inside the glass, leaving a margin. */
  const insideGlass = (x: number, z: number, margin: number): [number, number] => {
    const dx = x - enclosure.centerX;
    const dz = z - enclosure.centerZ;
    const r = Math.hypot(dx, dz);
    const limit = enclosure.radius - margin;
    if (r <= limit) return [x, z];
    const scale = limit / r;
    return [enclosure.centerX + dx * scale, enclosure.centerZ + dz * scale];
  };

  // --- Anchors on real surfaces ---------------------------------------------
  // Deliberately lopsided: the whole web leans toward the retreat side of the
  // jar, the way a real widow claims one corner of an enclosure.

  // Lid anchors — silk hooked into the mesh above the tangle.
  for (let i = 0; i < 16; i += 1) {
    const [x, z] = insideGlass(rng.range(-6 * LS, 3 * LS), rng.range(-6 * LS, 3 * LS), 0.7 * LS);
    addHub("LID", x, CEILING, z, true);
  }

  // Glass anchors — on the curved wall, clustered around the retreat side.
  // (Silk does hold on clean glass; it just holds better on everything else.)
  // Still lopsided toward the retreat, but the spread is wider now: with this
  // many lines, keeping them all in one arc reads as a fan rather than a web.
  const retreatAzimuth = Math.atan2(-5.5 * LS, -5 * LS);
  for (let i = 0; i < 22; i += 1) {
    const theta = retreatAzimuth + rng.range(-1.7, 1.7);
    addHub(
      "GLASS",
      enclosure.centerX + Math.cos(theta) * (enclosure.radius - 0.03),
      rng.range(1.4 * LS, CEILING - 0.4 * LS),
      enclosure.centerZ + Math.sin(theta) * (enclosure.radius - 0.03),
      true,
    );
  }

  // Stick anchors — the mid-air wood is what a cobweb actually wants. A couple
  // of holds along each branch, biased toward the upper half.
  for (const stick of enclosure.sticks) {
    const holds = stick === enclosure.sticks[0] ? 3 : 2;
    for (let i = 0; i < holds; i += 1) {
      const t = rng.range(0.35, 0.95);
      addHub(
        "STICK",
        stick.base[0] + (stick.tip[0] - stick.base[0]) * t,
        stick.base[1] + (stick.tip[1] - stick.base[1]) * t,
        stick.base[2] + (stick.tip[2] - stick.base[2]) * t,
        true,
      );
    }
  }

  // Ground anchors for the gumfoot lines: rock tops and open substrate.
  const floorAnchors: Hub[] = [];
  for (const rock of enclosure.rocks) {
    // Two holds per stone rather than one. A gumfoot line pulls hard and a real
    // widow does not trust a whole trap to a single point of contact.
    for (let i = 0; i < 2; i += 1) {
      floorAnchors.push(
        addHub(
          "ROCK",
          rock.x + rng.range(-0.5, 0.5) * rock.radius,
          rock.radius * 1.1,
          rock.z + rng.range(-0.5, 0.5) * rock.radius,
          true,
        ),
      );
    }
  }
  for (let i = 0; i < 14; i += 1) {
    const [x, z] = insideGlass(rng.range(-5 * LS, 4 * LS), rng.range(-5 * LS, 3.5 * LS), 1.2 * LS);
    floorAnchors.push(addHub("SUBSTRATE", x, FLOOR, z, true));
  }

  // --- Tangle hubs -----------------------------------------------------------
  // Few and far apart. Neighbours land 2.5-5 legspans away, so the spider walks a
  // real stretch of silk between junctions instead of tripping over one every step.
  const CLUSTERS = [
    { x: -5.2, y: 7.0, z: -5.0, spread: 1.15, count: 6 }, // retreat corner
    { x: -2.6, y: 5.4, z: -2.0, spread: 1.9, count: 7 },
    { x: 0.6, y: 3.4, z: 0.8, spread: 1.9, count: 7 },
    { x: -3.4, y: 2.6, z: 2.0, spread: 1.65, count: 6 },
  ];
  // No two hubs closer than this. Without the rule, cluster jitter happily drops
  // junctions less than a legspan apart, and the spider straddles both at once —
  // which is the fishing-net failure this whole scale rework exists to avoid.
  const MINIMUM_HUB_GAP = 1.05 * LS;
  for (const cluster of CLUSTERS) {
    for (let i = 0; i < cluster.count; i += 1) {
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const [x, z] = insideGlass(
          (cluster.x + rng.range(-cluster.spread, cluster.spread)) * LS,
          (cluster.z + rng.range(-cluster.spread, cluster.spread)) * LS,
          0.5 * LS,
        );
        const y = Math.min(
          CEILING - LS,
          Math.max(1.5 * LS, (cluster.y + rng.range(-0.8, 0.8)) * LS),
        );
        const tooClose = tangle.some(
          (hub) => Math.hypot(hub.x - x, hub.y - y, hub.z - z) < MINIMUM_HUB_GAP,
        );
        if (!tooClose || attempt === 23) {
          if (!tooClose) {
            addHub("HUB", x, y, z, false);
          }
          break;
        }
      }
    }
  }

  // --- Wiring ----------------------------------------------------------------
  const linked = new Set<string>();

  /**
   * Lays a span as a bundle of near-parallel lines rather than one thread.
   *
   * The copies bow apart by a fraction of a legspan — inside her reach — because
   * a lone thread through open space leaves the middle legs nothing to hold on
   * either side. Real tangle lines run in loose bundles; this is both truer and
   * what the gait needs.
   */
  const addSpan = (a: Hub, b: Hub): void => {
    const key = pairKey(a, b);
    if (linked.has(key)) {
      return;
    }
    linked.add(key);
    addStrand(network, nextStrandId(), a, b, build);
  };

  for (const hub of tangle) {
    for (const other of nearestOf(tangle, hub, 6)) {
      addSpan(hub, other);
    }
    for (const anchor of nearestOf(anchors, hub, 7)) {
      addSpan(hub, anchor);
    }
  }

  // Long independent chords turn the compact tangle into a widow's web rather
  // than a cellular net. They cross at unrelated angles without inventing a
  // semantic junction everywhere two bright lines happen to overlap.
  for (let i = 0; i < tangle.length * 4; i += 1) {
    const a = tangle[Math.floor(rng.next() * tangle.length)];
    const b = tangle[Math.floor(rng.next() * tangle.length)];
    const span = a && b ? distance(a, b) : 0;
    if (a && b && a !== b && span > 2.2 * LS && span < 9 * LS) {
      addSpan(a, b);
    }
  }

  // --- Gumfoot lines ---------------------------------------------------------
  // Taut verticals to the floor: the widow's signature and her trap.
  for (const anchor of floorAnchors) {
    for (const hub of nearestOf(tangle, anchor, 2)) {
      addStrand(network, nextStrandId(), hub, anchor, { ...build, slackFactor: tautness - 0.008 });
    }
  }

  // --- Retreat ---------------------------------------------------------------
  const retreat = tangle.reduce((best, hub) =>
    hub.y - hub.x - hub.z > best.y - best.x - best.z ? hub : best,
  );
  for (const other of nearestOf(tangle, retreat, 4)) {
    addSpan(retreat, other);
  }
  const far = tangle.reduce((best, hub) =>
    distance(hub, retreat) > distance(best, retreat) ? hub : best,
  );

  network.syncParticleDamping();

  const strandsById = new Map<string, WebStrand>(network.strandList.map((s) => [s.id, s]));
  const baseRest = new Map<string, Float32Array>(
    network.strandList.map((s) => [s.id, Float32Array.from(s.restLengths)]),
  );

  return {
    network,
    legSpan: LS,
    homeStrandId: busiestStrandId(network, tangle),
    retreatNodeId: retreat.node.id,
    farNodeId: far.node.id,
    setTautness(strandId: string, next: number): void {
      const strand = strandsById.get(strandId);
      const base = baseRest.get(strandId);
      if (!strand || !base) {
        return;
      }
      const factor = Math.max(0.9, Math.min(1.4, next)) / tautness;
      for (let i = 0; i < strand.restLengths.length; i += 1) {
        strand.restLengths[i] = base[i] * factor;
      }
    },
  };
}

function distance(a: Hub, b: Hub): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function pairKey(a: Hub, b: Hub): string {
  return a.node.id < b.node.id ? `${a.node.id}|${b.node.id}` : `${b.node.id}|${a.node.id}`;
}

function nearestOf(candidates: readonly Hub[], from: Hub, count: number): Hub[] {
  return candidates
    .filter((hub) => hub !== from)
    .map((hub) => ({ hub, d: distance(hub, from) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, count)
    .map((entry) => entry.hub);
}

/** The strand whose endpoints have the highest combined connectivity. */
function busiestStrandId(network: WebNetwork, tangle: readonly Hub[]): string {
  const inTangle = new Set(tangle.map((hub) => hub.node.id));
  let best = network.strandList[0];
  let bestScore = -1;
  for (const strand of network.strandList) {
    if (!inTangle.has(strand.startNode.id) || !inTangle.has(strand.endNode.id)) {
      continue;
    }
    const score =
      strand.startNode.connectedStrandIds.size + strand.endNode.connectedStrandIds.size;
    if (score > bestScore) {
      bestScore = score;
      best = strand;
    }
  }
  return best.id;
}
