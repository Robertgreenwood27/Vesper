export type AdaptiveQualityLevel = 0 | 1 | 2;

export interface AdaptiveQualityDecision {
  readonly level: AdaptiveQualityLevel;
  readonly averageFrameMs: number;
  readonly slowFrameRatio: number;
  readonly direction: "down" | "up";
}

interface AdaptiveQualityOptions {
  readonly warmupMs: number;
  readonly sampleWindowMs: number;
  readonly longFrameMs: number;
  readonly slowAverageMs: number;
  readonly severeAverageMs: number;
  readonly fastAverageMs: number;
  readonly slowRatio: number;
  readonly severeSlowRatio: number;
  readonly fastSlowRatio: number;
  readonly slowWindowsBeforeDrop: number;
  readonly fastWindowsBeforeRecovery: number;
  readonly changeCooldownMs: number;
}

const DEFAULT_OPTIONS: AdaptiveQualityOptions = {
  // Shader compilation and model setup can make the opening seconds look much
  // worse than steady state. Do not punish a device for that one-time work.
  warmupMs: 5_000,
  sampleWindowMs: 4_000,
  longFrameMs: 24,
  slowAverageMs: 22,
  severeAverageMs: 30,
  fastAverageMs: 18,
  slowRatio: 0.35,
  severeSlowRatio: 0.65,
  fastSlowRatio: 0.12,
  slowWindowsBeforeDrop: 2,
  fastWindowsBeforeRecovery: 4,
  changeCooldownMs: 20_000,
};

/**
 * Watches real animation cadence and recommends one careful quality step at a
 * time. Device labels are deliberately absent: a fast phone should keep the
 * full mobile presentation, while an overloaded desktop can still get help.
 */
export class AdaptiveQualityController {
  private readonly options: AdaptiveQualityOptions;
  private level: AdaptiveQualityLevel = 0;
  private startedAt: number | null = null;
  private previousAt: number | null = null;
  private cooldownUntil = 0;
  private sampleDuration = 0;
  private sampleFrameTime = 0;
  private sampleFrames = 0;
  private sampleSlowFrames = 0;
  private slowWindows = 0;
  private fastWindows = 0;

  constructor(options: Partial<AdaptiveQualityOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get currentLevel(): AdaptiveQualityLevel {
    return this.level;
  }

  /**
   * Feed one requestAnimationFrame timestamp. Long gaps are ignored because
   * they usually mean a background tab, breakpoint, or suspended browser.
   */
  observe(timestamp: number, suspended = false): AdaptiveQualityDecision | null {
    if (this.startedAt === null) {
      this.startedAt = timestamp;
      this.previousAt = timestamp;
      return null;
    }

    if (suspended) {
      this.previousAt = timestamp;
      this.resetSample();
      return null;
    }

    const previousAt = this.previousAt ?? timestamp;
    const frameMs = timestamp - previousAt;
    this.previousAt = timestamp;

    if (
      timestamp - this.startedAt < this.options.warmupMs ||
      timestamp < this.cooldownUntil ||
      frameMs <= 0 ||
      frameMs > 250
    ) {
      return null;
    }

    this.sampleDuration += frameMs;
    this.sampleFrameTime += frameMs;
    this.sampleFrames += 1;
    if (frameMs > this.options.longFrameMs) this.sampleSlowFrames += 1;

    if (this.sampleDuration < this.options.sampleWindowMs) return null;

    const averageFrameMs = this.sampleFrameTime / Math.max(1, this.sampleFrames);
    const slowFrameRatio = this.sampleSlowFrames / Math.max(1, this.sampleFrames);
    const severe =
      averageFrameMs >= this.options.severeAverageMs ||
      slowFrameRatio >= this.options.severeSlowRatio;
    const slow =
      averageFrameMs >= this.options.slowAverageMs ||
      slowFrameRatio >= this.options.slowRatio;
    const fast =
      averageFrameMs <= this.options.fastAverageMs &&
      slowFrameRatio <= this.options.fastSlowRatio;

    this.resetSample();

    if (slow) {
      this.slowWindows += 1;
      this.fastWindows = 0;
      if (this.level < 2 && (severe || this.slowWindows >= this.options.slowWindowsBeforeDrop)) {
        this.level = (this.level + 1) as AdaptiveQualityLevel;
        this.slowWindows = 0;
        this.cooldownUntil = timestamp + this.options.changeCooldownMs;
        return { level: this.level, averageFrameMs, slowFrameRatio, direction: "down" };
      }
      return null;
    }

    if (fast) {
      this.fastWindows += 1;
      this.slowWindows = 0;
      if (this.level > 0 && this.fastWindows >= this.options.fastWindowsBeforeRecovery) {
        this.level = (this.level - 1) as AdaptiveQualityLevel;
        this.fastWindows = 0;
        this.cooldownUntil = timestamp + this.options.changeCooldownMs;
        return { level: this.level, averageFrameMs, slowFrameRatio, direction: "up" };
      }
      return null;
    }

    this.slowWindows = 0;
    this.fastWindows = 0;
    return null;
  }

  private resetSample(): void {
    this.sampleDuration = 0;
    this.sampleFrameTime = 0;
    this.sampleFrames = 0;
    this.sampleSlowFrames = 0;
  }
}
