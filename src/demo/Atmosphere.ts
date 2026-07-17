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
