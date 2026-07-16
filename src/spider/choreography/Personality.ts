import type { ChoreographyConfig } from "./ChoreographyConfig";
import type { IntentMood } from "./Intent";

/** Small, fast, deterministic. Reproducible spontaneity is still spontaneity. */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  next(): number {
    // xorshift32
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

  /** Symmetric jitter in [-amount, amount]. */
  jitter(amount: number): number {
    return (this.next() * 2 - 1) * amount;
  }
}

/**
 * The part of the spider that is entirely invented.
 *
 * None of this is biology. It exists because a creature that moves at a perfectly
 * constant speed reads as a machine, and a creature that occasionally stops for a
 * quarter of a second reads as one that was thinking about something.
 */
export class Personality {
  readonly rng: Rng;

  /** 0..1, eased toward the current intent's mood. Drives posture and step height. */
  confidence = 0.8;
  /** Seconds remaining in the current micro-pause. */
  private pauseRemaining = 0;
  /** Seconds until the next pause may even be considered. */
  private pauseCooldown = 1.5;
  private breathPhase = 0;

  constructor(private readonly config: ChoreographyConfig) {
    this.rng = new Rng(config.randomSeed);
    this.breathPhase = this.rng.next() * Math.PI * 2;
  }

  get isPaused(): boolean {
    return this.pauseRemaining > 0;
  }

  /** Subtle vertical breathing offset. Only really visible when standing still. */
  get breath(): number {
    return Math.sin(this.breathPhase) * this.config.breathAmplitude;
  }

  update(dt: number, mood: IntentMood, moving: boolean): void {
    // Confidence eases rather than snaps, so posture changes read as a decision.
    this.confidence += (mood.confidence - this.confidence) * Math.min(1, dt * 2.5);

    // Breathing slows as the spider settles and quickens when bold.
    this.breathPhase +=
      dt * Math.PI * 2 * this.config.breathRate * (0.7 + this.confidence * 0.6);

    if (this.pauseRemaining > 0) {
      this.pauseRemaining = Math.max(0, this.pauseRemaining - dt);
      return;
    }

    this.pauseCooldown = Math.max(0, this.pauseCooldown - dt);
    if (!moving || this.pauseCooldown > 0 || mood.hesitancy <= 0) {
      return;
    }

    const chance = this.config.pauseChancePerSecond * mood.hesitancy * dt;
    if (this.rng.next() < chance) {
      this.pauseRemaining = this.rng.range(
        this.config.pauseDuration.min,
        this.config.pauseDuration.max,
      );
      this.pauseCooldown = this.rng.range(0.8, 2.6);
    }
  }

  /** A pause is a full stop of intent, not a slow-down. Spiders stop dead. */
  speedScale(mood: IntentMood): number {
    return this.isPaused ? 0 : mood.speed;
  }
}
