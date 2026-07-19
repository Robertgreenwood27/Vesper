import * as THREE from "three";
import { VESTIGE_BEATS } from "./VestigeBeatMap";

interface PerformanceWeather {
  setPerformanceMode(active: boolean): void;
}

export interface VestigeJamOptions {
  readonly scene: THREE.Scene;
  readonly habitat: HTMLElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly center: THREE.Vector3;
  readonly radius: number;
  readonly height: number;
  readonly ambient: THREE.AmbientLight;
  readonly key: THREE.DirectionalLight;
  readonly rim: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly redLamp: THREE.PointLight;
  readonly cornerLamp: THREE.PointLight;
  readonly warmWash: THREE.SpotLight;
  readonly warmFill: THREE.DirectionalLight;
  readonly weather: PerformanceWeather;
  readonly musicButton: HTMLButtonElement;
  readonly player: HTMLElement;
  readonly progress: HTMLElement;
  readonly elapsed: HTMLElement;
  readonly isRedWatch: () => boolean;
  readonly spiderName: () => string;
  readonly describe: (message: string) => void;
  readonly onStart: () => void;
  readonly onListened: () => void;
  readonly onBeat: (strength: number) => void;
  readonly onStop: (reason: "user" | "ended" | "error") => void;
}

type StoredQuery = {
  lightning: string | null;
  weather: string | null;
};

const AUDIO_URL = "/audio/vestige.mp3";
const MEANINGFUL_LISTEN_SECONDS = 10;
const NORMAL_COLORS = {
  ambient: new THREE.Color(0x2a3040),
  key: new THREE.Color(0xbfd4ff),
  rim: new THREE.Color(0xff7a5c),
  fill: new THREE.Color(0x6f86b8),
  fog: new THREE.Color(0x050504),
};
const JAM_COLORS = {
  ambient: new THREE.Color(0x160725),
  key: new THREE.Color(0x8f65ff),
  rim: new THREE.Color(0xe04dff),
  fill: new THREE.Color(0x5e21c8),
  fog: new THREE.Color(0x07020d),
};

/**
 * Plays the browser-sized Vestige mix and turns the drum stem's authored
 * transients into a violet lighting performance. The beat map is deliberately
 * generated from `Vestige/2 Drums.wav`, not inferred from the mastered mix.
 */
export class VestigeJamExperience {
  private readonly audio = new Audio(AUDIO_URL);
  private readonly violetWash: THREE.SpotLight;
  private readonly violetRim: THREE.PointLight;
  private readonly underglow: THREE.PointLight;
  private readonly lightning: THREE.SpotLight;
  private readonly reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  private activeValue = false;
  private visualMix = 0;
  private flash = 0;
  private beatGlow = 0;
  private nextBeatIndex = 0;
  private listenedReported = false;
  private lastLightAt = Number.NEGATIVE_INFINITY;
  private storedQuery: StoredQuery | null = null;
  private restorePending = false;
  private readonly backgroundColor = new THREE.Color();

  constructor(private readonly options: VestigeJamOptions) {
    const target = new THREE.Object3D();
    target.position.set(options.center.x, options.height * 0.54, options.center.z);
    options.scene.add(target);

    this.violetWash = new THREE.SpotLight(
      0x982bff,
      0,
      46,
      Math.PI * 0.29,
      0.86,
      1.3,
    );
    this.violetWash.position.set(
      options.center.x - options.radius * 2.1,
      options.height * 1.12,
      options.center.z + options.radius * 1.85,
    );
    this.violetWash.target = target;

    this.violetRim = new THREE.PointLight(0xe84dff, 0, 31, 1.55);
    this.violetRim.position.set(
      options.center.x + options.radius * 0.72,
      options.height * 0.7,
      options.center.z - options.radius * 0.82,
    );

    this.underglow = new THREE.PointLight(0x5415d8, 0, 24, 1.5);
    this.underglow.position.set(
      options.center.x,
      options.height * 0.16,
      options.center.z + options.radius * 0.16,
    );

    this.lightning = new THREE.SpotLight(
      0xe9cfff,
      0,
      72,
      Math.PI * 0.34,
      0.7,
      1.16,
    );
    this.lightning.position.set(
      options.center.x + options.radius * 3.1,
      options.height * 1.5,
      options.center.z + options.radius * 2.4,
    );
    this.lightning.target = target;
    options.scene.add(this.violetWash, this.violetRim, this.underglow, this.lightning);

    this.audio.preload = "metadata";
    this.audio.volume = 0.92;
    this.audio.addEventListener("ended", () => this.stop("ended"));
    this.audio.addEventListener("playing", () => options.habitat.classList.remove("jam-buffering"));
    this.audio.addEventListener("waiting", () => {
      if (this.activeValue) options.habitat.classList.add("jam-buffering");
    });
    this.audio.addEventListener("error", () => {
      if (!this.activeValue) return;
      this.stop("error");
    });
  }

  get active(): boolean {
    return this.activeValue;
  }

  /** Song-relative time keeps the camera orbit paused whenever audio buffers. */
  get playbackProgress(): number {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 284.68;
    return THREE.MathUtils.clamp(this.audio.currentTime / duration, 0, 1);
  }

  /** Begins loading metadata early without violating browser autoplay rules. */
  prepare(): void {
    if (this.audio.readyState === HTMLMediaElement.HAVE_NOTHING) this.audio.load();
  }

  async start(): Promise<void> {
    if (this.activeValue) return;
    this.activeValue = true;
    this.restorePending = false;
    this.nextBeatIndex = 0;
    this.listenedReported = false;
    this.lastLightAt = Number.NEGATIVE_INFINITY;
    this.audio.currentTime = 0;
    const spiderName = this.options.spiderName();
    this.options.musicButton.setAttribute("aria-pressed", "true");
    this.options.musicButton.setAttribute("aria-label", `Stop jamming out with ${spiderName}`);
    this.options.musicButton.title = `Stop jamming out with ${spiderName}`;
    this.options.habitat.classList.add("jam-active", "jam-buffering");
    this.options.player.hidden = false;
    this.options.weather.setPerformanceMode(true);
    this.setPerformanceQuery();
    this.options.describe(`The room goes violet. ${spiderName} holds the silk while Vestige calls in the storm.`);
    this.options.onStart();

    try {
      await this.audio.play();
    } catch {
      if (this.activeValue) this.stop("error");
    }
  }

  stop(reason: "user" | "ended" | "error" = "user"): void {
    if (!this.activeValue && !this.restorePending) return;
    this.activeValue = false;
    this.restorePending = true;
    this.audio.pause();
    if (reason !== "ended") this.audio.currentTime = 0;
    const spiderName = this.options.spiderName();
    this.options.musicButton.setAttribute("aria-pressed", "false");
    this.options.musicButton.setAttribute("aria-label", `Jam out with ${spiderName}`);
    this.options.musicButton.title = `Jam out with ${spiderName}`;
    this.options.habitat.classList.remove("jam-buffering");
    this.options.player.hidden = true;

    if (reason === "ended") {
      this.options.describe(`Vestige spends its final note. The violet afterimage lingers on ${spiderName}'s silk.`);
    } else if (reason === "error") {
      this.options.describe("Vestige could not reach the speakers. The room settles back into its own quiet.");
    } else {
      this.options.describe(`The storm folds inward, leaving ${spiderName} with the last vibration in the silk.`);
    }
    this.options.onStop(reason);
  }

  update(dt: number): void {
    const targetMix = this.activeValue ? 1 : 0;
    this.visualMix = THREE.MathUtils.damp(this.visualMix, targetMix, targetMix ? 2.8 : 1.7, dt);

    if (this.activeValue) {
      const currentTime = this.audio.currentTime;
      if (!this.listenedReported && currentTime >= MEANINGFUL_LISTEN_SECONDS) {
        this.listenedReported = true;
        this.options.onListened();
      }
      while (
        this.nextBeatIndex < VESTIGE_BEATS.length &&
        VESTIGE_BEATS[this.nextBeatIndex][0] <= currentTime + 0.028
      ) {
        const [beatAt, strength] = VESTIGE_BEATS[this.nextBeatIndex];
        if (beatAt >= currentTime - 0.09) this.triggerBeat(currentTime, strength);
        this.nextBeatIndex += 1;
      }

      this.updatePlayer(currentTime);
    }

    this.flash *= Math.exp(-dt * (this.reducedMotion ? 24 : 17));
    this.beatGlow *= Math.exp(-dt * 5.2);
    this.paintLighting();

    if (!this.activeValue && this.restorePending && this.visualMix < 0.002) {
      this.visualMix = 0;
      this.restorePending = false;
      this.options.habitat.classList.remove("jam-active");
      this.options.weather.setPerformanceMode(false);
      this.restorePerformanceQuery();
      this.paintLighting();
    }
  }

  private triggerBeat(time: number, strength: number): void {
    this.options.onBeat(strength);
    const softened = this.reducedMotion ? strength * 0.28 : strength;

    // Physical web impulses follow every drum transient, but visible light
    // peaks stay at most 2.5 per second. A warning is useful context; this
    // cadence cap is the actual protection against a rapid strobe.
    if (softened < 0.28 || time - this.lastLightAt < 0.4) return;
    this.lastLightAt = time;
    this.beatGlow = Math.max(this.beatGlow, 0.12 + softened * 0.72);
    if (softened < 0.58) return;
    const strike = 0.18 + Math.pow(softened, 1.65) * 0.9;
    this.flash = Math.max(this.flash, strike);
  }

  private paintLighting(): void {
    const mix = this.visualMix;
    const redWatch = this.options.isRedWatch();
    const normalExposure = redWatch ? 0.72 : 0.88;
    const lightning = this.flash * mix;
    const pulse = this.beatGlow * mix;

    this.options.ambient.color.copy(NORMAL_COLORS.ambient).lerp(JAM_COLORS.ambient, mix);
    this.options.key.color.copy(NORMAL_COLORS.key).lerp(JAM_COLORS.key, mix);
    this.options.rim.color.copy(NORMAL_COLORS.rim).lerp(JAM_COLORS.rim, mix);
    this.options.fill.color.copy(NORMAL_COLORS.fill).lerp(JAM_COLORS.fill, mix);

    this.options.ambient.intensity = THREE.MathUtils.lerp(redWatch ? 0.18 : 0.43, 0.07, mix);
    this.options.key.intensity = THREE.MathUtils.lerp(redWatch ? 0.42 : 2.2, 0.17, mix);
    this.options.rim.intensity = THREE.MathUtils.lerp(1.4, 0.1, mix);
    this.options.fill.intensity = THREE.MathUtils.lerp(redWatch ? 0.16 : 0.7, 0.055, mix);
    this.options.redLamp.intensity = THREE.MathUtils.lerp(redWatch ? 3.2 : 0, 0, mix);
    this.options.cornerLamp.intensity = THREE.MathUtils.lerp(redWatch ? 0.25 : 55, 0.35, mix);
    this.options.warmWash.intensity = THREE.MathUtils.lerp(redWatch ? 0 : 620, 0, mix);
    this.options.warmFill.intensity = THREE.MathUtils.lerp(redWatch ? 0.04 : 1.15, 0.015, mix);

    this.violetWash.intensity = mix * (420 + pulse * 760 + lightning * 820);
    this.violetRim.intensity = mix * (30 + pulse * 72 + lightning * 115);
    this.underglow.intensity = mix * (18 + pulse * 52);
    this.lightning.intensity = lightning * 2_900;
    this.options.renderer.toneMappingExposure = THREE.MathUtils.lerp(normalExposure, 0.58, mix)
      + lightning * (this.reducedMotion ? 0.05 : 0.22);

    const fog = this.options.scene.fog;
    if (fog) fog.color.copy(NORMAL_COLORS.fog).lerp(JAM_COLORS.fog, mix);
    this.backgroundColor.copy(NORMAL_COLORS.fog).lerp(JAM_COLORS.fog, mix);
    this.options.renderer.setClearColor(this.backgroundColor, 1);
    this.options.habitat.style.setProperty("--jam-flash", lightning.toFixed(3));
    this.options.habitat.style.setProperty("--jam-pulse", pulse.toFixed(3));
  }

  private updatePlayer(currentTime: number): void {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 284.68;
    const progress = THREE.MathUtils.clamp(currentTime / duration, 0, 1);
    this.options.progress.style.transform = `scaleX(${progress.toFixed(5)})`;
    this.options.elapsed.textContent = `${this.formatTime(currentTime)} / ${this.formatTime(duration)}`;
  }

  private formatTime(seconds: number): string {
    const whole = Math.max(0, Math.floor(seconds));
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
  }

  private setPerformanceQuery(): void {
    const url = new URL(window.location.href);
    if (!this.storedQuery) {
      this.storedQuery = {
        lightning: url.searchParams.get("lightning"),
        weather: url.searchParams.get("weather"),
      };
    }
    url.searchParams.set("lightning", "1");
    url.searchParams.set("weather", "0");
    window.history.replaceState(window.history.state, "", url);
  }

  private restorePerformanceQuery(): void {
    if (!this.storedQuery) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries(this.storedQuery)) {
      if (value === null) url.searchParams.delete(key);
      else url.searchParams.set(key, value);
    }
    window.history.replaceState(window.history.state, "", url);
    this.storedQuery = null;
  }
}
