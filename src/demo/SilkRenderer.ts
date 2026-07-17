import * as THREE from "three";
import { DynamicRibbon } from "../rendering/DynamicRibbon";
import type { WebNetwork } from "../web/WebNetwork";

/**
 * Draws silk and nothing else.
 *
 * No labels, no gizmos, no tension heatmap, no candidate markers. The lab needed
 * all of that; the illusion needs none of it. Silk is nearly invisible in life —
 * it reads as a catch of light, so it is drawn as a thin bright core inside a
 * soft additive glow, and the eye fills in the rest.
 */
export class SilkRenderer {
  private readonly group = new THREE.Group();
  private readonly glows: DynamicRibbon[] = [];
  private readonly cores: DynamicRibbon[] = [];

  // Additive blending stacks, and a cobweb puts a lot of strands behind each
  // other — so what reads as a tasteful glow on one thread turns the middle of a
  // dense tangle into a solid white mass. These are deliberately fainter than
  // they look like they should be.
  private readonly glowMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.3, 0.42, 0.58),
    transparent: true,
    opacity: 0.055,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  private readonly coreMaterial = new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.8, 0.87, 1),
    transparent: true,
    opacity: 0.5,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });

  constructor(
    scene: THREE.Scene,
    private readonly network: WebNetwork,
  ) {
    scene.add(this.group);
    for (const strand of network.strandList) {
      const glow = new DynamicRibbon(strand.particleIndices, this.glowMaterial);
      const core = new DynamicRibbon(strand.particleIndices, this.coreMaterial);
      glow.mesh.renderOrder = 2;
      core.mesh.renderOrder = 3;
      this.glows.push(glow);
      this.cores.push(core);
      this.group.add(glow.mesh, core.mesh);
    }
  }

  update(camera: THREE.Camera): void {
    const store = this.network.particles;
    const { x, y, z } = camera.position;
    for (let i = 0; i < this.glows.length; i += 1) {
      // Real silk is microns wide and read almost entirely as caught light, so
      // the ribbons stay near the one-pixel floor: a whisper of halo around a
      // bright hairline core. Interaction picking is screen-space and does not
      // depend on these widths. The tiny camera offset keeps the core ribbon
      // from z-fighting its glow.
      this.glows[i].update(store, 0.0036, x, y, z, 0);
      this.cores[i].update(store, 0.0007, x, y, z, 0.001);
    }
  }

  dispose(): void {
    for (const ribbon of [...this.glows, ...this.cores]) {
      ribbon.dispose();
    }
    this.glowMaterial.dispose();
    this.coreMaterial.dispose();
  }
}
