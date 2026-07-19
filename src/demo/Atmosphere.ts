import * as THREE from "three";
import type { WebNetwork } from "../web/WebNetwork";

/**
 * The habitat's weather: two rare, unannounced events that reward simply
 * leaving the window open.
 *
 * Dew — in the small hours the web is beaded with condensation. Each drop is
 * pinned to a live physics segment, so when the web moves the dew moves, and
 * when Vesper walks a line her weight shakes the beads. It condenses in, hangs
 * around, and quietly evaporates.
 *
 * A firefly — some nights something luminous crosses the room. It never lands;
 * it just passes through, pulsing, and is gone. Vesper watches.
 */

interface DewDrop {
  particleA: number;
  particleB: number;
  lerp: number;
}

const DEW_VERTEX = /* glsl */ `
  attribute float phase;
  attribute float scale;
  uniform float time;
  uniform float reveal;
  varying float vSparkle;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.72 + 0.28 * sin(time * 1.7 + phase * 6.28318);
    vSparkle = twinkle * reveal;
    gl_PointSize = scale * twinkle * reveal * (160.0 / max(0.5, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const DEW_FRAGMENT = /* glsl */ `
  varying float vSparkle;
  void main() {
    vec2 offset = gl_PointCoord - vec2(0.5);
    float radius = length(offset) * 2.0;
    if (radius > 1.0) discard;
    // A hard bright core inside a soft halo: reads as refraction, not glow.
    float core = smoothstep(0.34, 0.0, radius);
    float halo = pow(1.0 - radius, 2.4) * 0.32;
    float alpha = (core + halo) * vSparkle;
    gl_FragColor = vec4(vec3(0.82, 0.89, 1.0), alpha);
  }
`;

export class DewSystem {
  private readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;
  private readonly drops: DewDrop[] = [];
  private readonly positions: Float32Array;
  private reveal = 0;
  private target = 0;

  constructor(
    scene: THREE.Scene,
    private readonly network: WebNetwork,
    dropCount: number,
    seedRandom: () => number = Math.random,
  ) {
    const strands = network.strandList;
    const phases = new Float32Array(dropCount);
    const scales = new Float32Array(dropCount);
    this.positions = new Float32Array(dropCount * 3);

    for (let i = 0; i < dropCount; i += 1) {
      const strand = strands[Math.floor(seedRandom() * strands.length)];
      const segment = Math.floor(seedRandom() * (strand.particleIndices.length - 1));
      this.drops.push({
        particleA: strand.particleIndices[segment],
        particleB: strand.particleIndices[segment + 1],
        lerp: seedRandom(),
      });
      phases[i] = seedRandom();
      scales[i] = 2.2 + seedRandom() * 3.4;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    geometry.setAttribute("scale", new THREE.BufferAttribute(scales, 1));

    this.material = new THREE.ShaderMaterial({
      vertexShader: DEW_VERTEX,
      fragmentShader: DEW_FRAGMENT,
      uniforms: { time: { value: 0 }, reveal: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(geometry, this.material);
    this.points.renderOrder = 4;
    this.points.visible = false;
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  get visible(): boolean {
    return this.target > 0;
  }

  /** Condense (true) or evaporate (false). Both happen slowly. */
  setCondensed(on: boolean): void {
    this.target = on ? 1 : 0;
  }

  update(dt: number, time: number): void {
    // Condensing takes ~25 s; evaporating takes ~80 s.
    const rate = this.target > this.reveal ? dt / 25 : dt / 80;
    this.reveal = THREE.MathUtils.clamp(
      this.reveal + Math.sign(this.target - this.reveal) * rate,
      0,
      1,
    );
    this.points.visible = this.reveal > 0.004;
    if (!this.points.visible) return;

    this.material.uniforms.time.value = time;
    this.material.uniforms.reveal.value = this.reveal;

    const stored = this.network.particles.positions;
    for (let i = 0; i < this.drops.length; i += 1) {
      const drop = this.drops[i];
      const a = drop.particleA * 3;
      const b = drop.particleB * 3;
      this.positions[i * 3] = stored[a] + (stored[b] - stored[a]) * drop.lerp;
      this.positions[i * 3 + 1] = stored[a + 1] + (stored[b + 1] - stored[a + 1]) * drop.lerp;
      this.positions[i * 3 + 2] = stored[a + 2] + (stored[b + 2] - stored[a + 2]) * drop.lerp;
    }
    (this.points.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
  }
}

function paintFireflyGlow(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const glow = ctx.createRadialGradient(32, 32, 1, 32, 32, 30);
    glow.addColorStop(0, "rgba(236, 255, 190, 1)");
    glow.addColorStop(0.25, "rgba(206, 232, 108, 0.7)");
    glow.addColorStop(1, "rgba(160, 200, 60, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(canvas);
}

export class Firefly {
  private readonly group = new THREE.Group();
  private readonly sprite: THREE.Sprite;
  private readonly lamp: THREE.PointLight;
  private readonly from = new THREE.Vector3();
  private readonly to = new THREE.Vector3();
  private elapsed = 0;
  private duration = 0;
  private pulseOffset = 0;
  active = false;

  constructor(private readonly scene: THREE.Scene) {
    this.sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: paintFireflyGlow(),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.sprite.scale.setScalar(0.42);
    this.lamp = new THREE.PointLight(0xcbe86a, 0, 7, 2);
    this.group.add(this.sprite, this.lamp);
    this.group.visible = false;
    this.scene.add(this.group);
  }

  /** Sends the firefly on one crossing of the room. */
  launch(): void {
    const side = Math.random() < 0.5 ? -1 : 1;
    this.from.set(side * 14, 4 + Math.random() * 7, 10 + Math.random() * 4);
    this.to.set(-side * (10 + Math.random() * 5), 5 + Math.random() * 6, -6 - Math.random() * 4);
    this.duration = 26 + Math.random() * 14;
    this.elapsed = 0;
    this.pulseOffset = Math.random() * 10;
    this.active = true;
    this.group.visible = true;
  }

  get position(): THREE.Vector3 {
    return this.group.position;
  }

  update(dt: number, time: number): void {
    if (!this.active) return;
    this.elapsed += dt;
    const progress = this.elapsed / this.duration;
    if (progress >= 1) {
      this.active = false;
      this.group.visible = false;
      this.lamp.intensity = 0;
      return;
    }

    // A drifting line with wander laid over it — never a straight flight.
    this.group.position.lerpVectors(this.from, this.to, progress);
    this.group.position.x += Math.sin(time * 0.9 + this.pulseOffset) * 1.7;
    this.group.position.y += Math.sin(time * 1.3 + this.pulseOffset * 2) * 1.1;
    this.group.position.z += Math.cos(time * 0.7 + this.pulseOffset) * 1.4;

    // Real fireflies flash in slow deliberate pulses with dark gaps between.
    const pulse = Math.max(0, Math.sin(time * 1.15 + this.pulseOffset));
    const flash = Math.pow(pulse, 6);
    const fade = Math.min(1, progress * 8, (1 - progress) * 8);
    this.lamp.intensity = flash * 2.6 * fade;
    this.sprite.material.opacity = (0.06 + flash * 0.94) * fade;
    this.sprite.scale.setScalar(0.2 + flash * 0.34);
  }
}

export interface WeatherOverrides {
  readonly live: boolean;
  readonly clear: boolean;
  readonly clouds: boolean;
  readonly humidity: boolean;
  readonly rain: boolean;
  readonly storm: boolean;
}

interface WeatherReading {
  readonly temperature: number;
  readonly humidity: number;
  readonly dewPoint: number;
  readonly precipitation: number;
  readonly rain: number;
  readonly snowfall: number;
  readonly weatherCode: number;
  readonly cloudCover: number;
  readonly isDay: boolean;
}

interface WeatherResponse extends Partial<WeatherReading> {
  readonly available?: unknown;
}

const CONDENSATION_VERTEX = /* glsl */ `
  attribute float threshold;
  attribute float dropScale;
  uniform float reveal;
  varying float vVisible;
  void main() {
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vVisible = smoothstep(threshold, min(1.0, threshold + 0.18), reveal);
    gl_PointSize = dropScale * vVisible * (135.0 / max(0.5, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const CONDENSATION_FRAGMENT = /* glsl */ `
  varying float vVisible;
  void main() {
    vec2 p = gl_PointCoord - vec2(0.5);
    float radius = length(p) * 2.0;
    if (radius > 1.0 || vVisible < 0.01) discard;
    float body = smoothstep(1.0, 0.62, radius) * 0.11;
    float rim = smoothstep(1.0, 0.74, radius) - smoothstep(0.76, 0.48, radius);
    float glint = smoothstep(0.28, 0.0, length(p - vec2(-0.14, 0.17)));
    float shade = smoothstep(0.42, 0.0, length(p - vec2(0.15, -0.16))) * 0.05;
    float alpha = (body + rim * 0.2 + glint * 0.64 - shade) * vVisible;
    gl_FragColor = vec4(0.77, 0.86, 0.9, max(0.0, alpha));
  }
`;

function weatherReading(value: unknown): WeatherReading | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as WeatherResponse;
  const numbers = [
    candidate.temperature,
    candidate.humidity,
    candidate.dewPoint,
    candidate.precipitation,
    candidate.rain,
    candidate.snowfall,
    candidate.weatherCode,
    candidate.cloudCover,
  ];
  if (
    candidate.available !== true ||
    numbers.some((entry) => typeof entry !== "number" || !Number.isFinite(entry)) ||
    typeof candidate.isDay !== "boolean"
  ) {
    return null;
  }
  return candidate as WeatherReading;
}

/**
 * Lets the room outside the sealed habitat share the visitor's weather.
 * Nothing in this system renders precipitation or wind inside the jar. Wet
 * weather arrives as glass condensation and cool, cloud-softened daylight;
 * lightning is only an off-screen exterior source.
 */
export class LiveWeatherAtmosphere {
  private readonly condensation: THREE.Points;
  private readonly condensationMaterial: THREE.ShaderMaterial;
  private readonly skyLight: THREE.DirectionalLight;
  private readonly lightning: THREE.SpotLight;
  private reading: WeatherReading | null = null;
  private refreshing = false;
  private nextRefreshAt = 0;
  private reveal = 0;
  private condensationTarget = 0;
  private daylight = 0;
  private nextLightningAt = Number.POSITIVE_INFINITY;
  private lightningStartedAt = Number.NEGATIVE_INFINITY;
  private stormWasActive = false;

  constructor(
    scene: THREE.Scene,
    center: THREE.Vector3,
    radius: number,
    height: number,
    dropCount: number,
    private readonly overrides: WeatherOverrides,
  ) {
    const positions = new Float32Array(dropCount * 3);
    const thresholds = new Float32Array(dropCount);
    const scales = new Float32Array(dropCount);
    // A fixed seed keeps the droplets from rearranging themselves on reload.
    let seed = 0x6d2b79f5;
    const random = (): number => {
      seed = Math.imul(seed ^ (seed >>> 15), seed | 1);
      seed ^= seed + Math.imul(seed ^ (seed >>> 7), seed | 61);
      return ((seed ^ (seed >>> 14)) >>> 0) / 4_294_967_296;
    };
    for (let i = 0; i < dropCount; i += 1) {
      const angle = random() * Math.PI * 2;
      const y = 0.65 + Math.pow(random(), 0.82) * (height - 1.25);
      positions[i * 3] = center.x + Math.cos(angle) * (radius - 0.035);
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = center.z + Math.sin(angle) * (radius - 0.035);
      thresholds[i] = 0.12 + random() * 0.86;
      scales[i] = 0.34 + random() * random() * 0.92;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("threshold", new THREE.BufferAttribute(thresholds, 1));
    geometry.setAttribute("dropScale", new THREE.BufferAttribute(scales, 1));
    this.condensationMaterial = new THREE.ShaderMaterial({
      vertexShader: CONDENSATION_VERTEX,
      fragmentShader: CONDENSATION_FRAGMENT,
      uniforms: { reveal: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    });
    this.condensation = new THREE.Points(geometry, this.condensationMaterial);
    this.condensation.frustumCulled = false;
    this.condensation.renderOrder = 5;
    this.condensation.visible = false;
    scene.add(this.condensation);

    this.skyLight = new THREE.DirectionalLight(0x9bb6ca, 0);
    this.skyLight.position.set(center.x + radius * 1.8, height * 1.35, center.z + radius * 2.4);
    scene.add(this.skyLight);

    const lightningTarget = new THREE.Object3D();
    lightningTarget.position.set(center.x, height * 0.55, center.z);
    scene.add(lightningTarget);
    this.lightning = new THREE.SpotLight(0xcde6ff, 0, 70, Math.PI * 0.31, 0.72, 1.25);
    this.lightning.position.set(center.x - radius * 3.2, height * 1.45, center.z + radius * 2.5);
    this.lightning.target = lightningTarget;
    scene.add(this.lightning);

    if (this.overrides.live) void this.refresh();
  }

  get silkCondensed(): boolean {
    return this.condensationTarget >= 0.76;
  }

  get hasConditions(): boolean {
    return this.reading !== null ||
      this.overrides.clear ||
      this.overrides.clouds ||
      this.overrides.humidity ||
      this.overrides.rain ||
      this.overrides.storm;
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || !this.overrides.live) return;
    this.refreshing = true;
    try {
      const response = await fetch("/api/weather", {
        headers: { accept: "application/json" },
        cache: "default",
      });
      if (response.ok) this.reading = weatherReading(await response.json());
    } catch {
      // Weather is an ambient enhancement. Offline play remains unchanged.
    } finally {
      this.refreshing = false;
      this.nextRefreshAt = Date.now() + 15 * 60 * 1_000;
    }
  }

  private conditions(): WeatherReading | null {
    let current = this.reading;
    if (this.overrides.clear) {
      current = {
        temperature: current?.temperature ?? 20,
        humidity: 34,
        dewPoint: 3,
        precipitation: 0,
        rain: 0,
        snowfall: 0,
        weatherCode: 0,
        cloudCover: 0,
        isDay: true,
      };
    }
    if (this.overrides.clouds) {
      current = { ...(current ?? this.reviewBaseline()), cloudCover: 100, weatherCode: 3 };
    }
    if (this.overrides.humidity) {
      const base = current ?? this.reviewBaseline();
      current = { ...base, humidity: 99, dewPoint: base.temperature - 0.25 };
    }
    if (this.overrides.rain) {
      current = {
        ...(current ?? this.reviewBaseline()),
        humidity: 94,
        precipitation: 2.4,
        rain: 2.4,
        weatherCode: 63,
        cloudCover: 96,
      };
    }
    if (this.overrides.storm) {
      current = {
        ...(current ?? this.reviewBaseline()),
        humidity: 96,
        precipitation: 5.2,
        rain: 5.2,
        weatherCode: 95,
        cloudCover: 100,
      };
    }
    return current;
  }

  private reviewBaseline(): WeatherReading {
    return {
      temperature: 18,
      humidity: 55,
      dewPoint: 9,
      precipitation: 0,
      rain: 0,
      snowfall: 0,
      weatherCode: 1,
      cloudCover: 22,
      isDay: true,
    };
  }

  update(dt: number, time: number, redWatch: boolean): void {
    if (this.overrides.live && Date.now() >= this.nextRefreshAt) void this.refresh();
    const current = this.conditions();
    if (!current) return;

    const humidity = THREE.MathUtils.smoothstep(current.humidity, 72, 98);
    const dewSpread = Math.max(0, current.temperature - current.dewPoint);
    const nearDewPoint = 1 - THREE.MathUtils.smoothstep(dewSpread, 1.2, 6.5);
    const wetWeather = current.precipitation > 0.05 ? 0.56 : 0;
    this.condensationTarget = THREE.MathUtils.clamp(
      Math.max(wetWeather, humidity * 0.72 + nearDewPoint * 0.42),
      0,
      1,
    );
    const forcedWet = this.overrides.humidity || this.overrides.rain || this.overrides.storm;
    const condensationRate = this.condensationTarget > this.reveal
      ? dt / (forcedWet ? 5 : 38)
      : dt / 110;
    this.reveal = THREE.MathUtils.clamp(
      this.reveal + Math.sign(this.condensationTarget - this.reveal) * condensationRate,
      0,
      1,
    );
    this.condensationMaterial.uniforms.reveal.value = this.reveal;
    this.condensation.visible = this.reveal > 0.02;

    const cloud = current.cloudCover / 100;
    const daylightTarget = (current.isDay ? 0.34 : 0.045) * (1 - cloud * 0.56);
    this.daylight = THREE.MathUtils.damp(this.daylight, daylightTarget, 0.8, dt);
    this.skyLight.intensity = this.daylight * (redWatch ? 0.08 : 1);

    const stormActive = current.weatherCode >= 95;
    if (stormActive && !this.stormWasActive) {
      this.nextLightningAt = time + (this.overrides.storm ? 1.2 : 7 + Math.random() * 22);
    } else if (!stormActive) {
      this.nextLightningAt = Number.POSITIVE_INFINITY;
    }
    this.stormWasActive = stormActive;

    if (stormActive && time >= this.nextLightningAt) {
      this.lightningStartedAt = time;
      this.nextLightningAt = time + (this.overrides.storm ? 7 + Math.random() * 11 : 32 + Math.random() * 75);
    }
    const sinceFlash = time - this.lightningStartedAt;
    const pulse = (center: number, width: number): number =>
      Math.exp(-Math.pow((sinceFlash - center) / width, 2));
    const flash = sinceFlash >= 0 && sinceFlash < 0.9
      ? pulse(0.035, 0.024) + pulse(0.18, 0.045) * 0.48 + pulse(0.52, 0.08) * 0.72
      : 0;
    this.lightning.intensity = flash * 2_100;
  }
}
