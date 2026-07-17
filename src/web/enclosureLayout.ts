/**
 * The single source of truth for the enclosure's furniture.
 *
 * The web generator and the scene renderer both consume this: silk anchors have
 * to land on surfaces the keeper can actually see, and the sticks have to stand
 * where the silk claims they do. Everything is derived from the spider's
 * legspan, the same way the web itself is — a bigger spider gets a bigger jar.
 *
 * The enclosure is a cylinder: a tall glass terrarium with a mesh lid, a bed of
 * substrate, a few dead branches leaned at angles a widow would actually use,
 * and some rocks half-buried in the soil. The branches matter most — a cobweb
 * wants mid-air anchor points, and in a real enclosure those come from wood,
 * not from bare glass.
 */

export interface EnclosureStick {
  /** Where the wood meets the substrate, world units. */
  readonly base: readonly [number, number, number];
  /** The upper end, world units. */
  readonly tip: readonly [number, number, number];
  /** Radius at the base; sticks taper toward the tip. */
  readonly radius: number;
}

export interface EnclosureRock {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

export interface EnclosureLayout {
  /** Cylinder axis in the xz plane. The web predates the jar, so the jar is placed around it. */
  readonly centerX: number;
  readonly centerZ: number;
  readonly radius: number;
  /** Substrate is y = 0; the lid sits at this height. */
  readonly height: number;
  readonly sticks: readonly EnclosureStick[];
  readonly rocks: readonly EnclosureRock[];
}

export function createEnclosureLayout(legSpan: number): EnclosureLayout {
  const LS = legSpan;
  return {
    // Offset so the existing web tangle — which leans toward what used to be
    // the room corner — hangs comfortably inside the glass.
    centerX: -2 * LS,
    centerZ: -1.5 * LS,
    radius: 6.6 * LS,
    height: 9 * LS,
    sticks: [
      // The main climbing branch: substrate to near the lid, leaning across
      // the tangle so the web has honest mid-air wood to hold.
      { base: [1.5 * LS, 0, 3.0 * LS], tip: [-3.5 * LS, 7.8 * LS, -3.0 * LS], radius: 0.16 * LS },
      // A short fork on the bright side, where the crate's anchors used to be.
      { base: [3.4 * LS, 0, 2.4 * LS], tip: [2.2 * LS, 3.5 * LS, 1.3 * LS], radius: 0.13 * LS },
      // A stub leaned against the glass on the retreat side.
      { base: [-5.4 * LS, 0, -3.2 * LS], tip: [-6.0 * LS, 5.6 * LS, -5.0 * LS], radius: 0.14 * LS },
    ],
    rocks: [
      { x: 0.9 * LS, z: -2.6 * LS, radius: 0.85 * LS },
      { x: -3.1 * LS, z: 1.9 * LS, radius: 0.65 * LS },
      { x: 3.1 * LS, z: -0.4 * LS, radius: 0.5 * LS },
    ],
  };
}
