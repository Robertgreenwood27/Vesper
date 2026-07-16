/**
 * Every tunable the illusion depends on, in one readable place.
 *
 * These are stage directions, not physical constants. If a number here makes the
 * spider look better and a biologist worse, the number wins.
 */
export interface ChoreographyConfig {
  /**
   * Lets the route drive the body while silk addresses merely suggest footfalls.
   * Intended for the pet showcase; the lab keeps strict contact locomotion.
   */
  cinematicLocomotion: boolean;
  /** Model units per second at full confidence on comfortable silk. */
  travelSpeed: number;
  /** How sharply travel speed ramps in and out. Higher settles faster. */
  speedResponse: number;

  /**
   * How far a planted foot may sit from its authored FootHome before the leg
   * wants to step. This is the entire "which foot moves" decision.
   *
   * Must be loose enough that a foot which merely landed on the nearest real
   * silk is not instantly unhappy — the web decides where feet go, not the rig.
   */
  stepTriggerDistance: number;
  /** A foot this far from home steps regardless of rhythm; it is falling behind. */
  stepUrgentDistance: number;
  /** Feet aim this far ahead along travel, so the spider walks into its stride. */
  stepLead: number;
  /**
   * Radius of the real silk search around a foot's ideal landing point.
   *
   * Bigger is safer than it sounds: the search always prefers silk nearest the
   * aim, so this only decides how far she will reach when there is nothing close.
   * Too small and she walks with three legs waving at empty air.
   */
  footholdSearchRadius: number;
  /**
   * Backstop only: widest angle off the leg's own coxa->FootHome direction at
   * which it will accept a foothold. Deliberately generous, because this is the
   * wrong tool for stopping leg crossing and a tight value is actively harmful.
   *
   * A leg's rest direction points out to the side, but a spider walking a single
   * long strand can only put her feet fore and aft along it — roughly 90 degrees
   * off rest. Tighten this to "prevent crossing" and the middle legs reject the
   * only silk in existence, and she walks a tightrope on three feet. Crossing is
   * a question about the *midline*, so `midlineTolerance` answers it instead.
   */
  legSweepDegrees: number;
  /**
   * How far past the body's midline a foot may plant, as a fraction of maximum
   * reach. This is what actually stops legs crossing through the body: a left
   * foot belongs on the left. Small but non-zero — real legs do reach slightly
   * under the body.
   */
  midlineTolerance: number;
  /**
   * Multiplier on the rig spec's authored joint limits. 0 disables enforcement.
   *
   * Off by default, and that is a finding rather than laziness. The spec's own
   * note calls its ranges "APPROXIMATE ... Validate/tune in engine". Enforced
   * verbatim, the solver clamps ~3.75 joints per solve and reports joint-limited
   * on 981 of 1011 solves; the feet then float an average of 0.19 model units off
   * the silk they claim to hold — worst case 0.98, most of a leg's reach. A foot
   * visibly not touching its strand is a worse lie than a leg bending oddly, so
   * this loses. Widening to 2.5x still detaches by 0.19 average.
   *
   * The limits are authored relative to the GLB bind pose, and a walking pose is
   * nowhere near it — that mismatch is rig work, not runtime work. Leg direction
   * is kept honest by `legSweepDegrees` instead, which costs no contact fidelity.
   * Set this above 0 once the limits have been re-authored against a real stance.
   */
  jointLimitScale: number;

  /** Seconds for one swing at nominal distance. Scaled by real distance. */
  swingDuration: number;
  /** Peak lift of the swing arc, along body-up. */
  swingLift: number;
  /** Never allow fewer than this many planted feet. The only balance rule. */
  minimumPlantedFeet: number;
  /** Never swing more than this many feet at once. */
  maximumSwingingFeet: number;

  /**
   * How far the body's intention may outrun its real support before it is held
   * back. This replaces every reach-budget controller: feet cannot keep up, so
   * the spider slows down, and it reads as caution.
   */
  maximumLeash: number;
  /** Standoff of the thorax from the support surface, along the support normal. */
  bodyStandoff: number;
  /** Critically-damped follow rate for body translation. */
  bodyFollowRate: number;
  /** Follow rate for body orientation. Slower than translation reads as weight. */
  bodyTurnRate: number;
  /** How far the body leans into acceleration. Pure theater. */
  bodyLean: number;
  /** Abdomen counter-rotation against acceleration. The strongest "alive" cue. */
  abdomenLag: number;

  /** Idle breathing amplitude, in model units. */
  breathAmplitude: number;
  /** Idle breathing rate, in hertz. */
  breathRate: number;

  /** Chance per second of a micro-pause while travelling. */
  pauseChancePerSecond: number;
  /** Range of a micro-pause, in seconds. */
  pauseDuration: { min: number; max: number };
  /** Seed for all deterministic "spontaneity". */
  randomSeed: number;

  /** Total body weight returned to the silk, in newtons. */
  bodyWeight: number;
}

export const DEFAULT_CHOREOGRAPHY: ChoreographyConfig = {
  cinematicLocomotion: false,
  travelSpeed: 0.42,
  speedResponse: 3.2,

  stepTriggerDistance: 0.4,
  stepUrgentDistance: 0.62,
  stepLead: 0.16,
  footholdSearchRadius: 0.7,
  legSweepDegrees: 115,
  midlineTolerance: 0.1,
  jointLimitScale: 0,

  swingDuration: 0.24,
  swingLift: 0.12,
  minimumPlantedFeet: 5,
  maximumSwingingFeet: 3,

  // Must stay comfortably larger than stepTriggerDistance. The body can only get
  // this far ahead of its feet, and that gap is the *only* thing that generates
  // step drift — squeeze it to the trigger distance and the spider reaches a
  // pose where no leg wants to move and nothing can ever unstick it.
  maximumLeash: 0.55,
  bodyStandoff: 0.17,
  bodyFollowRate: 6.5,
  bodyTurnRate: 4.0,
  bodyLean: 0.22,
  abdomenLag: 0.3,

  breathAmplitude: 0.006,
  breathRate: 0.55,

  pauseChancePerSecond: 0.28,
  pauseDuration: { min: 0.12, max: 0.55 },
  randomSeed: 0x5eed1a,

  bodyWeight: 2.4,
};

export function createChoreographyConfig(
  overrides: Partial<ChoreographyConfig> = {},
): ChoreographyConfig {
  return {
    ...DEFAULT_CHOREOGRAPHY,
    ...overrides,
    pauseDuration: { ...DEFAULT_CHOREOGRAPHY.pauseDuration, ...overrides.pauseDuration },
  };
}
