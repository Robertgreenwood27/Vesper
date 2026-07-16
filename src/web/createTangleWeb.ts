import { WebNetwork } from "./WebNetwork";
import type { WebNode } from "./WebNode";

/**
 * An irregular three-dimensional cobweb.
 *
 * A widow does not build an orb. She builds a tangle: a messy volume of support
 * lines under a fixed frame, with sticky gumfoot lines dropping to the ground and
 * a dense retreat in one corner. This generator makes that shape — not because
 * the topology is scientifically derived, but because a tangle gives the eye the
 * silhouette it expects and gives the spider somewhere real to put its feet.
 *
 * Everything here is ordinary `WebNetwork` topology. Strands meet at shared
 * nodes, so routes exist, forces travel, and the spider can reason about it.
 */

export interface TangleWebOptions {
  readonly seed?: number;
  readonly stiffness?: number;
  readonly damping?: number;
  /** Rest length as a multiple of straight-line span. Above 1 hangs slack. */
  readonly slack?: number;
  readonly pointsPerUnit?: number;
}

export interface TangleWeb {
  readonly network: WebNetwork;
  /** A good place to put the spider down: a well-connected central strand. */
  readonly homeStrandId: string;
  /** The retreat corner — where "retreat" intents should head. */
  readonly retreatNodeId: string;
  /** Far side of the tangle, for a long, legible walk. */
  readonly farNodeId: string;
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

const LINEAR_DENSITY = 0.14;

/**
 * Lays a strand between two nodes with a gravity-plausible sag, and takes its
 * rest lengths from the sagged shape so it starts settled instead of snapping.
 */
function addSaggingStrand(
  network: WebNetwork,
  id: string,
  a: Hub,
  b: Hub,
  options: {
    slack: number;
    stiffness: number;
    damping: number;
    pointsPerUnit: number;
    /** Lateral displacement at mid-span, for doubled lines. */
    bowX?: number;
    bowZ?: number;
  },
): string {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const span = Math.hypot(dx, dy, dz);
  const pointCount = Math.max(4, Math.min(14, Math.round(span * options.pointsPerUnit)));
  const positions = new Float32Array(pointCount * 3);

  // Sag is chosen so the polyline length lands near span * slack.
  const sag = span * Math.sqrt(Math.max(0, options.slack - 1)) * 1.35;
  for (let point = 0; point < pointCount; point += 1) {
    const t = point / (pointCount - 1);
    const bow = 4 * t * (1 - t);
    const offset = point * 3;
    positions[offset] = a.x + dx * t + (options.bowX ?? 0) * bow;
    positions[offset + 1] = a.y + dy * t - sag * bow;
    positions[offset + 2] = a.z + dz * t + (options.bowZ ?? 0) * bow;
  }

  const restLengths = new Float32Array(pointCount - 1);
  for (let segment = 0; segment < restLengths.length; segment += 1) {
    const i = segment * 3;
    restLengths[segment] = Math.max(
      1e-4,
      Math.hypot(
        positions[i + 3] - positions[i],
        positions[i + 4] - positions[i + 1],
        positions[i + 5] - positions[i + 2],
      ),
    );
  }

  network.addStrand({
    id,
    startNode: a.node,
    endNode: b.node,
    initialPositions: positions,
    restLengths,
    stiffness: options.stiffness,
    damping: options.damping,
    linearDensity: LINEAR_DENSITY,
  });
  return id;
}

export function createTangleWeb(options: TangleWebOptions = {}): TangleWeb {
  const rng = new Rng(options.seed ?? 0xc0bbe7);
  const stiffness = options.stiffness ?? 0.94;
  const damping = options.damping ?? 1.65;
  const slack = options.slack ?? 1.05;
  const pointsPerUnit = options.pointsPerUnit ?? 5;
  const network = new WebNetwork();

  const strandOptions = { slack, stiffness, damping, pointsPerUnit };
  const hubs: Hub[] = [];
  let strandSerial = 0;
  const nextStrandId = () => `silk-${String(strandSerial++).padStart(3, "0")}`;

  const addHub = (
    id: string,
    label: string,
    x: number,
    y: number,
    z: number,
    fixed: boolean,
  ): Hub => {
    const node = network.addNode(id, label, x, y, z, fixed ? "fixed" : "dynamic", 0.05);
    const hub: Hub = { node, x, y, z };
    hubs.push(hub);
    return hub;
  };

  // --- Fixed frame -----------------------------------------------------------
  // The tangle hangs from a rigid frame, exactly as a widow's does from a rafter,
  // a wood pile, or the underside of a step.
  const CEILING = 3.2;
  const SPAN = 3.4;
  const frame: Hub[] = [];
  for (let corner = 0; corner < 4; corner += 1) {
    const angle = (corner / 4) * Math.PI * 2 + Math.PI * 0.25;
    frame.push(
      addHub(
        `frame-${corner}`,
        `FRAME ${corner}`,
        Math.cos(angle) * SPAN,
        CEILING,
        Math.sin(angle) * SPAN,
        true,
      ),
    );
  }

  // --- Tangle hubs -----------------------------------------------------------
  // Two loose sheets of jittered hubs. Real spacing matters more than the exact
  // layout: the spider needs neighbouring silk within a leg's reach.
  const tangle: Hub[] = [];
  const LAYERS = [
    { y: 2.3, radius: 2.5, count: 7 },
    { y: 1.5, radius: 3.0, count: 8 },
    { y: 0.85, radius: 2.2, count: 6 },
  ];
  let hubSerial = 0;
  for (const layer of LAYERS) {
    for (let i = 0; i < layer.count; i += 1) {
      const angle = (i / layer.count) * Math.PI * 2 + rng.range(-0.25, 0.25);
      const radius = layer.radius * rng.range(0.45, 1);
      tangle.push(
        addHub(
          `hub-${hubSerial}`,
          `HUB ${hubSerial}`,
          Math.cos(angle) * radius,
          layer.y + rng.range(-0.3, 0.3),
          Math.sin(angle) * radius,
          false,
        ),
      );
      hubSerial += 1;
    }
  }

  // --- Ground anchors for the gumfoot lines ----------------------------------
  const ground: Hub[] = [];
  for (let i = 0; i < 5; i += 1) {
    const angle = (i / 5) * Math.PI * 2 + 0.4;
    ground.push(
      addHub(
        `ground-${i}`,
        `GROUND ${i}`,
        Math.cos(angle) * rng.range(1.2, 2.6),
        0,
        Math.sin(angle) * rng.range(1.2, 2.6),
        true,
      ),
    );
  }

  // --- Suspension: frame down into the tangle --------------------------------
  // Doubled like everything else the spider has to walk. A lone suspension line
  // is a tightrope with nothing beside it, and she stalls on it.
  const addSpan = (a: Hub, c: Hub): void => {
    addSaggingStrand(network, nextStrandId(), a, c, strandOptions);
    addSaggingStrand(network, nextStrandId(), a, c, {
      ...strandOptions,
      slack: slack + rng.range(0.01, 0.05),
      bowX: rng.range(-0.34, 0.34),
      bowZ: rng.range(-0.34, 0.34),
    });
  };

  for (const anchor of frame) {
    for (const hub of nearestOf(tangle, anchor, 2)) {
      addSpan(anchor, hub);
    }
  }

  // --- The tangle itself -----------------------------------------------------
  // Each hub links to a few near neighbours. The doubled lines are what let the
  // spider spread its feet across more than one strand while walking a span.
  const linked = new Set<string>();
  for (const hub of tangle) {
    for (const other of nearestOf(tangle, hub, 4)) {
      const key = pairKey(hub, other);
      if (linked.has(key)) {
        continue;
      }
      linked.add(key);
      addSaggingStrand(network, nextStrandId(), hub, other, strandOptions);

      // Every span is laid at least twice, with the copies bowed apart.
      //
      // This is what makes the tangle walkable. A single thread through open
      // space gives the middle legs nothing within reach on either side, and the
      // spider stalls with her feet grasping at air. Doubled, splayed lines mean
      // there is nearly always silk beside the silk — which is both what a real
      // tangle looks like and what the gait needs to spread its feet across.
      const copies = 1 + (rng.next() < 0.6 ? 1 : 0);
      for (let copy = 0; copy < copies; copy += 1) {
        addSaggingStrand(network, nextStrandId(), hub, other, {
          ...strandOptions,
          slack: slack + rng.range(0.01, 0.05),
          bowX: rng.range(-0.34, 0.34),
          bowZ: rng.range(-0.34, 0.34),
        });
      }
    }
  }

  // --- Gumfoot lines ---------------------------------------------------------
  // Taut vertical capture lines to the ground. These are the widow's signature,
  // and they give the tangle its unmistakable silhouette.
  for (const anchor of ground) {
    const nearest = nearestOf(tangle, anchor, 1);
    for (const hub of nearest) {
      addSaggingStrand(network, nextStrandId(), hub, anchor, {
        ...strandOptions,
        slack: 1.005,
      });
    }
  }

  // --- Retreat ---------------------------------------------------------------
  // A denser knot in one upper corner. The spider sits here when it has nothing
  // better to do, and runs here when startled.
  const retreat = tangle.reduce((best, hub) =>
    hub.y + hub.x * 0.3 > best.y + best.x * 0.3 ? hub : best,
  );
  for (const other of nearestOf(tangle, retreat, 4)) {
    const key = pairKey(retreat, other);
    if (linked.has(key)) {
      continue;
    }
    linked.add(key);
    addSpan(retreat, other);
  }

  const far = tangle.reduce((best, hub) =>
    distance(hub, retreat) > distance(best, retreat) ? hub : best,
  );

  network.syncParticleDamping();

  // Put the spider on the busiest strand we built — most feet options, least
  // chance the very first thing the player sees is a spider that cannot move.
  const homeStrandId = busiestStrandId(network, tangle);

  return {
    network,
    homeStrandId,
    retreatNodeId: retreat.node.id,
    farNodeId: far.node.id,
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
