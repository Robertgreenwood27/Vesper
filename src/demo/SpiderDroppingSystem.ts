import * as THREE from "three";

export type GroundHeightAt = (worldX: number, worldZ: number) => number;

const DROP_RADIUS = 0.022;
const GRAVITY = 3.8;

/**
 * A deliberately tiny, infrequent habitat detail. One pale drop leaves the
 * live spinneret marker, falls to the substrate, remains briefly, then fades.
 * The system owns no behavior state and never changes the spider's pose.
 */
export class SpiderDroppingSystem {
  private readonly material = new THREE.MeshStandardMaterial({
    color: 0xf1eee6,
    roughness: 0.88,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });
  private readonly drop = new THREE.Mesh(
    new THREE.SphereGeometry(DROP_RADIUS, 10, 7),
    this.material,
  );
  private readonly velocity = new THREE.Vector3();
  private active = false;
  private landed = false;
  private phaseTime = 0;
  private lingerSeconds = 0;
  private fadeSeconds = 0;
  private nextDropSeconds: number;

  constructor(
    scene: THREE.Scene,
    private readonly groundHeightAt: GroundHeightAt,
    private readonly random: () => number = Math.random,
  ) {
    this.drop.name = "spider-dropping";
    this.drop.visible = false;
    this.drop.castShadow = true;
    scene.add(this.drop);
    // Let the first sighting happen a little sooner; later events are rarer.
    this.nextDropSeconds = 45 + this.random() * 75;
  }

  get isActive(): boolean {
    return this.active;
  }

  get snapshot(): Readonly<{
    active: boolean;
    landed: boolean;
    position: readonly [number, number, number];
    opacity: number;
  }> {
    return {
      active: this.active,
      landed: this.landed,
      position: [this.drop.position.x, this.drop.position.y, this.drop.position.z],
      opacity: this.material.opacity,
    };
  }

  /** Immediate test seam. Returns false while the previous drop still exists. */
  dropNow(spinneret: THREE.Object3D): boolean {
    if (this.active) return false;

    spinneret.getWorldPosition(this.drop.position);
    const driftAngle = this.random() * Math.PI * 2;
    const driftSpeed = 0.008 + this.random() * 0.018;
    this.velocity.set(
      Math.cos(driftAngle) * driftSpeed,
      -0.045 - this.random() * 0.035,
      Math.sin(driftAngle) * driftSpeed,
    );
    this.drop.scale.set(0.72, 1.25, 0.72);
    this.drop.rotation.set(0, this.random() * Math.PI * 2, 0);
    this.material.opacity = 1;
    this.drop.visible = true;
    this.active = true;
    this.landed = false;
    this.phaseTime = 0;
    this.lingerSeconds = 14 + this.random() * 12;
    this.fadeSeconds = 4 + this.random() * 2;
    this.nextDropSeconds = 120 + this.random() * 180;
    return true;
  }

  /** Always advances an existing drop; `canSpawn` only gates new events. */
  update(dt: number, spinneret: THREE.Object3D | null, canSpawn = true): void {
    if (this.active) {
      this.updateActiveDrop(dt);
      return;
    }
    if (!spinneret || !canSpawn) return;

    this.nextDropSeconds -= dt;
    if (this.nextDropSeconds <= 0) this.dropNow(spinneret);
  }

  private updateActiveDrop(dt: number): void {
    this.phaseTime += dt;
    if (!this.landed) {
      const drag = Math.exp(-0.7 * dt);
      this.velocity.x *= drag;
      this.velocity.z *= drag;
      this.velocity.y -= GRAVITY * dt;
      this.drop.position.addScaledVector(this.velocity, dt);

      const ground = this.groundHeightAt(this.drop.position.x, this.drop.position.z);
      const restingCenterY = ground + DROP_RADIUS * 0.16;
      if (this.drop.position.y <= restingCenterY) {
        this.drop.position.y = restingCenterY;
        this.drop.scale.set(1.18, 0.16, 1.02);
        this.landed = true;
        this.phaseTime = 0;
      }
      return;
    }

    if (this.phaseTime <= this.lingerSeconds) return;
    const fadeProgress = (this.phaseTime - this.lingerSeconds) / this.fadeSeconds;
    this.material.opacity = 1 - THREE.MathUtils.smoothstep(fadeProgress, 0, 1);
    if (fadeProgress < 1) return;

    this.drop.visible = false;
    this.material.opacity = 1;
    this.active = false;
    this.landed = false;
    this.phaseTime = 0;
  }
}
