import * as THREE from "three";

export type RearLegSide = "left" | "right";
export type RearLegAction = "searching" | "grabbing" | "pulling" | "releasing" | "resetting";

export interface RearLegWorkPose {
  readonly activeSide: RearLegSide;
  readonly action: RearLegAction;
  /** Extension of the working hind leg, from its resting pose to the prey. */
  readonly reach: number;
  /** Return stroke which rolls the prey against the front legs. */
  readonly pull: number;
  /** Whether the leg is currently holding the silk shuttle. */
  readonly grip: number;
}

export interface PreyWrapAttachments {
  readonly leftSpinneret: THREE.Vector3;
  readonly rightSpinneret: THREE.Vector3;
  readonly leftHindFoot: THREE.Vector3;
  readonly rightHindFoot: THREE.Vector3;
}

export interface PreyWrappingOptions {
  /** Fallback local-space half extents of the loose cocoon. */
  readonly radii: THREE.Vector3;
  /**
   * Overlapping, optionally rotated ellipsoids approximating the actual prey.
   * Rays are solved against their union, letting silk follow wings, thorax,
   * and abdomen instead of floating on one mathematically clean oval.
   */
  readonly surfaceLobes?: readonly PreySurfaceLobe[];
  /** Approximate time to solve the coverage problem, before time scaling. */
  readonly targetDuration: number;
  /** Relative resistance to leg-driven rotation. */
  readonly rotationalInertia?: number;
  readonly mobile?: boolean;
}

export interface PreySurfaceLobe {
  readonly center: THREE.Vector3;
  readonly radii: THREE.Vector3;
  readonly rotation?: THREE.Quaternion;
}

export interface PreyWrapSnapshot {
  readonly coverage: number;
  readonly leastCovered: number;
  readonly passCount: number;
  readonly complete: boolean;
  readonly leg: RearLegWorkPose;
}

interface SilkPass {
  readonly points: THREE.Vector3[];
  readonly normal: THREE.Vector3;
  readonly line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const COVERAGE_CELL_COUNT = 42;
const WRAP_PASS_COUNT = 27;
const POINTS_PER_PASS = 52;
const WORKING_SILK_POINT_COUNT = 11;

const hiddenLegPose: RearLegWorkPose = {
  activeSide: "left",
  action: "resetting",
  reach: 0,
  pull: 0,
  grip: 0,
};

function smoothstep(value: number): number {
  const t = THREE.MathUtils.clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * A prey-local weaving solver.
 *
 * It does not know about moth animations. It knows an ellipsoidal work volume,
 * which portions of that volume have silk, and a rear-leg shuttle.
 * Every pass is chosen through the least-covered region. The same solver can
 * therefore wrap a differently sized or shaped prey item by changing `radii`.
 */
export class PreyWrappingSystem {
  readonly root = new THREE.Group();

  private readonly scene: THREE.Scene;
  private readonly prey: THREE.Group;
  private readonly radii: THREE.Vector3;
  private readonly surfaceLobes: Array<Required<PreySurfaceLobe>>;
  private readonly filamentCount: number;
  private readonly rotationalInertia: number;
  private readonly coverageDirections: THREE.Vector3[] = [];
  private readonly coverage = new Float32Array(COVERAGE_CELL_COUNT);
  private readonly pointCoverageCells: number[] = [];
  private readonly cocoonPoints: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  private readonly cocoonPointColors: THREE.BufferAttribute;
  private readonly shell: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly workingSilk: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly workingSilkPositions = new Float32Array(WORKING_SILK_POINT_COUNT * 3);
  private readonly cycleDuration: number;
  private readonly angularVelocity = new THREE.Vector3();
  private readonly torqueAxis = new THREE.Vector3();
  private readonly rotationStep = new THREE.Quaternion();
  private readonly localContact = new THREE.Vector3();
  private readonly worldContact = new THREE.Vector3();
  private readonly scratch = new THREE.Vector3();
  private readonly envelopeDirection = new THREE.Vector3();
  private readonly envelopeOrigin = new THREE.Vector3();
  private readonly envelopeLocalDirection = new THREE.Vector3();
  private readonly envelopeLocalOrigin = new THREE.Vector3();
  private readonly inverseLobeRotation = new THREE.Quaternion();
  private readonly preyWorldCenter = new THREE.Vector3();
  private readonly leverArm = new THREE.Vector3();
  private readonly pullForce = new THREE.Vector3();
  private readonly workingControlBefore = new THREE.Vector3();
  private readonly workingControlAfter = new THREE.Vector3();
  private readonly silkColor = new THREE.Color(0xeee8dc);
  private activePass: SilkPass | null = null;
  private previousPassNormal: THREE.Vector3 | null = null;
  private cycleTime = 0;
  private currentPhase = 0;
  private elapsed = 0;
  private completedPasses = 0;
  private disposed = false;
  private workingSide: RearLegSide = "left";
  private legPose: RearLegWorkPose = hiddenLegPose;

  constructor(scene: THREE.Scene, prey: THREE.Group, options: PreyWrappingOptions) {
    this.scene = scene;
    this.prey = prey;
    this.radii = options.radii.clone();
    this.surfaceLobes = (options.surfaceLobes ?? []).map((lobe) => ({
      center: lobe.center.clone(),
      radii: lobe.radii.clone(),
      rotation: lobe.rotation?.clone() ?? new THREE.Quaternion(),
    }));
    this.filamentCount = options.mobile ? 2 : 3;
    this.rotationalInertia = Math.max(0.2, options.rotationalInertia ?? 1);
    this.cycleDuration = Math.max(0.18, options.targetDuration / WRAP_PASS_COUNT);

    this.root.name = "procedural-silk-wrap";
    this.root.visible = false;
    prey.add(this.root);

    for (let index = 0; index < COVERAGE_CELL_COUNT; index += 1) {
      const y = 1 - (2 * (index + 0.5)) / COVERAGE_CELL_COUNT;
      const radial = Math.sqrt(Math.max(0, 1 - y * y));
      const angle = index * GOLDEN_ANGLE;
      this.coverageDirections.push(
        new THREE.Vector3(Math.cos(angle) * radial, y, Math.sin(angle) * radial),
      );
    }

    const fuzzyPointCount = options.mobile ? 90 : 150;
    const fuzzyPositions = new Float32Array(fuzzyPointCount * 3);
    const fuzzyColors = new Float32Array(fuzzyPointCount * 4);
    for (let index = 0; index < fuzzyPointCount; index += 1) {
      const coverageCell = index % COVERAGE_CELL_COUNT;
      const direction = this.coverageDirections[coverageCell];
      const flutter = 1.015 + 0.035 * Math.sin(index * 12.9898 + 4.1414);
      this.projectToSurface(direction, this.scratch).multiplyScalar(flutter);
      fuzzyPositions[index * 3] = this.scratch.x;
      fuzzyPositions[index * 3 + 1] = this.scratch.y;
      fuzzyPositions[index * 3 + 2] = this.scratch.z;
      fuzzyColors[index * 4] = this.silkColor.r;
      fuzzyColors[index * 4 + 1] = this.silkColor.g;
      fuzzyColors[index * 4 + 2] = this.silkColor.b;
      fuzzyColors[index * 4 + 3] = 0;
      this.pointCoverageCells.push(coverageCell);
    }
    const pointGeometry = new THREE.BufferGeometry();
    pointGeometry.setAttribute("position", new THREE.BufferAttribute(fuzzyPositions, 3));
    // RGBA is intentional: uncovered fibers have alpha zero. Declaring this
    // as RGB shifts every fourth alpha into the next point's red channel,
    // producing the green/purple sparkle that used to flash at wrap start.
    this.cocoonPointColors = new THREE.BufferAttribute(fuzzyColors, 4);
    pointGeometry.setAttribute("color", this.cocoonPointColors);
    this.cocoonPoints = new THREE.Points(
      pointGeometry,
      new THREE.PointsMaterial({
        color: 0xffffff,
        size: options.mobile ? 0.013 : 0.011,
        transparent: true,
        opacity: 0.78,
        alphaTest: 0.01,
        vertexColors: true,
        depthWrite: false,
        sizeAttenuation: true,
      }),
    );
    this.cocoonPoints.name = "silk-density";
    this.root.add(this.cocoonPoints);

    const shellGeometry = new THREE.SphereGeometry(
      1,
      options.mobile ? 14 : 20,
      options.mobile ? 9 : 14,
    );
    const shellPositions = shellGeometry.getAttribute("position") as THREE.BufferAttribute;
    for (let index = 0; index < shellPositions.count; index += 1) {
      this.envelopeDirection.fromBufferAttribute(shellPositions, index).normalize();
      this.projectToSurface(this.envelopeDirection, this.scratch).multiplyScalar(1.012);
      shellPositions.setXYZ(index, this.scratch.x, this.scratch.y, this.scratch.z);
    }
    shellPositions.needsUpdate = true;
    shellGeometry.computeVertexNormals();
    this.shell = new THREE.Mesh(
      shellGeometry,
      new THREE.MeshStandardMaterial({
        color: 0xe6dfd2,
        roughness: 1,
        metalness: 0,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.FrontSide,
      }),
    );
    this.shell.name = "cocoon-density-shell";
    this.shell.visible = false;
    this.shell.renderOrder = 2;
    this.root.add(this.shell);

    const workingGeometry = new THREE.BufferGeometry();
    workingGeometry.setAttribute("position", new THREE.BufferAttribute(this.workingSilkPositions, 3));
    (workingGeometry.getAttribute("position") as THREE.BufferAttribute).setUsage(THREE.DynamicDrawUsage);
    this.workingSilk = new THREE.Line(
      workingGeometry,
      new THREE.LineBasicMaterial({
        color: 0xf5f0e6,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.workingSilk.name = "spinneret-shuttle-silk";
    this.workingSilk.frustumCulled = false;
    this.workingSilk.visible = false;
    this.workingSilk.renderOrder = 3;
    scene.add(this.workingSilk);
  }

  get snapshot(): PreyWrapSnapshot {
    let sum = 0;
    let leastCovered = 1;
    for (const amount of this.coverage) {
      sum += amount;
      leastCovered = Math.min(leastCovered, amount);
    }
    const coverage = sum / this.coverage.length;
    return {
      coverage,
      leastCovered,
      passCount: this.completedPasses,
      complete: this.completedPasses >= WRAP_PASS_COUNT || (coverage >= 0.72 && leastCovered >= 0.18),
      leg: this.legPose,
    };
  }

  /** Pinned prey still owns angular inertia; the legs add impulses instead of setting Euler angles. */
  updateSubduing(dt: number): void {
    if (this.disposed || dt <= 0) return;
    this.elapsed += dt;
    this.torqueAxis.set(
      Math.sin(this.elapsed * 7.7 + 0.8),
      Math.sin(this.elapsed * 9.1 + 2.3) * 0.72,
      Math.sin(this.elapsed * 6.3 + 4.1),
    ).normalize();
    const strugglePulse = 0.45 + 0.55 * Math.max(0, Math.sin(this.elapsed * 11.4));
    this.angularVelocity.addScaledVector(
      this.torqueAxis,
      (strugglePulse * 18 * dt) / this.rotationalInertia,
    );
    this.integrateRotation(dt, 1.85, 8.5);
  }

  /**
   * Advance the planner before presentation IK runs. This exposes this frame's
   * leg state and surface contact without yet sampling the working foot.
   */
  advanceWrapping(dt: number, attachments: PreyWrapAttachments): PreyWrapSnapshot {
    if (this.disposed || dt <= 0) return this.snapshot;
    this.root.visible = true;
    this.elapsed += dt;

    if (!this.activePass && !this.snapshot.complete) this.beginPass(attachments);
    this.cycleTime += dt;
    while (this.cycleTime >= this.cycleDuration && this.activePass) {
      this.cycleTime -= this.cycleDuration;
      this.finishPass();
      if (!this.snapshot.complete) this.beginPass(attachments);
    }

    this.currentPhase = THREE.MathUtils.clamp(this.cycleTime / this.cycleDuration, 0, 1);
    this.legPose = this.poseForPhase(this.currentPhase);
    this.updateGrowingPass(this.currentPhase);
    this.updateContactWorld(this.currentPhase);
    return this.snapshot;
  }

  /** Sample the solved foot, apply its real torque, and draw the live silk. */
  completeWrappingStep(dt: number, attachments: PreyWrapAttachments): PreyWrapSnapshot {
    if (this.disposed || dt <= 0) return this.snapshot;
    this.updateWorkingSilk(attachments);
    if (this.activePass && this.legPose.action === "pulling") {
      this.prey.getWorldPosition(this.preyWorldCenter);
      const activeFoot = this.legPose.activeSide === "left"
        ? attachments.leftHindFoot
        : attachments.rightHindFoot;
      this.leverArm.subVectors(this.worldContact, this.preyWorldCenter);
      this.pullForce.subVectors(activeFoot, this.worldContact).normalize();
      this.torqueAxis.crossVectors(this.leverArm, this.pullForce);
      const leverage = THREE.MathUtils.clamp(this.torqueAxis.length() / 0.11, 0.16, 1.35);
      if (this.torqueAxis.lengthSq() < 1e-6) {
        this.torqueAxis.copy(this.activePass.normal).applyQuaternion(this.prey.quaternion);
      }
      this.torqueAxis.normalize();
      const constraint = this.snapshot.coverage;
      const impulse = (
        (18 - constraint * 7)
        * leverage
        * (0.35 + this.legPose.grip * 0.65)
        * dt
      ) / this.rotationalInertia;
      this.angularVelocity.addScaledVector(this.torqueAxis, impulse);
    }
    const coverage = this.snapshot.coverage;
    this.integrateRotation(dt, 1.5 + coverage * 5.5, THREE.MathUtils.lerp(7.2, 2.1, coverage));
    // Torque changed the prey after the first contact sample. Re-resolve the
    // endpoint so the visible strand cannot lag behind the parcel by a frame.
    this.updateContactWorld(this.currentPhase);
    this.updateWorkingSilk(attachments);
    return this.snapshot;
  }

  getWorkingContactWorld(target: THREE.Vector3): boolean {
    if (!this.activePass) return false;
    target.copy(this.worldContact);
    return true;
  }

  /** Let the completed parcel keep only a trace of its remaining momentum. */
  settle(dt: number): void {
    if (this.disposed || dt <= 0) return;
    this.integrateRotation(dt, 8.5, 0.7);
    this.workingSilk.material.opacity = 0;
    this.workingSilk.visible = false;
  }

  /** Force the current partial pass closed for a clean transition into feeding. */
  seal(): void {
    if (this.disposed) return;
    if (this.activePass) this.finishPass();
    this.updateDensityVisuals();
    this.workingSilk.material.opacity = 0;
    this.workingSilk.visible = false;
    this.legPose = hiddenLegPose;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.workingSilk);
    this.workingSilk.geometry.dispose();
    this.workingSilk.material.dispose();
    this.root.removeFromParent();
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.root.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points)) return;
      geometries.add(object.geometry);
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) materials.add(material);
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
  }

  private beginPass(attachments: PreyWrapAttachments): void {
    const normal = this.choosePassNormal();
    const basisU = this.scratch.set(
      Math.abs(normal.x) < 0.72 ? 1 : 0,
      Math.abs(normal.x) < 0.72 ? 0 : 1,
      0,
    ).cross(normal).normalize().clone();
    const basisV = new THREE.Vector3().crossVectors(normal, basisU).normalize();
    let points: THREE.Vector3[] = [];
    for (let index = 0; index < POINTS_PER_PASS; index += 1) {
      const angle = (index / (POINTS_PER_PASS - 1)) * Math.PI * 2;
      const direction = new THREE.Vector3()
        .copy(basisU)
        .multiplyScalar(Math.cos(angle))
        .addScaledVector(basisV, Math.sin(angle))
        .normalize();
      const localCoverage = this.coverageNear(direction);
      const fiberLift = 0.0025 + localCoverage * 0.009;
      const irregularity = Math.sin(angle * 3 + this.completedPasses * 1.91) * 0.0022;
      points.push(
        this.projectToSurface(direction, new THREE.Vector3())
          .addScaledVector(direction, fiberLift + irregularity),
      );
    }
    // Start on whichever near-side point either working leg can reach most
    // naturally. This permits the same leg to work twice and avoids dragging a
    // foot around the hidden side of the prey just to satisfy alternation.
    this.prey.updateWorldMatrix(true, false);
    let nearestIndex = 0;
    let nearestDistance = Infinity;
    let nearestSide: RearLegSide = this.workingSide;
    for (let index = 0; index < points.length - 1; index += 1) {
      this.worldContact.copy(points[index]);
      this.prey.localToWorld(this.worldContact);
      const leftDistance = this.worldContact.distanceToSquared(attachments.leftHindFoot);
      const rightDistance = this.worldContact.distanceToSquared(attachments.rightHindFoot);
      if (leftDistance < nearestDistance) {
        nearestDistance = leftDistance;
        nearestIndex = index;
        nearestSide = "left";
      }
      if (rightDistance < nearestDistance) {
        nearestDistance = rightDistance;
        nearestIndex = index;
        nearestSide = "right";
      }
    }
    const openLoop = points.slice(0, -1);
    const orderedLoop = [...openLoop.slice(nearestIndex), ...openLoop.slice(0, nearestIndex)];
    // Most throws overlap rather than returning to their exact starting point.
    // Occasional closed turns hold the parcel together, while incomplete
    // passes prevent the result reading as a stack of toruses.
    const completeness = 0.78 + (this.completedPasses % 4) * 0.07;
    const keptPoints = Math.max(8, Math.floor(orderedLoop.length * Math.min(1, completeness)));
    points = orderedLoop.slice(0, keptPoints);
    if (completeness >= 0.98) points.push(points[0].clone());
    this.workingSide = nearestSide;
    const fiberPositions = new Float32Array(
      (points.length - 1) * this.filamentCount * 2 * 3,
    );
    let cursor = 0;
    for (let segment = 0; segment < points.length - 1; segment += 1) {
      for (let filament = 0; filament < this.filamentCount; filament += 1) {
        const offset = (filament - (this.filamentCount - 1) * 0.5) * 0.0024;
        for (const point of [points[segment], points[segment + 1]]) {
          fiberPositions[cursor] = point.x + normal.x * offset;
          fiberPositions[cursor + 1] = point.y + normal.y * offset;
          fiberPositions[cursor + 2] = point.z + normal.z * offset;
          cursor += 3;
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(fiberPositions, 3));
    geometry.setDrawRange(0, this.filamentCount * 2);
    const line = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({
        color: this.completedPasses % 3 === 0 ? 0xf7f2e8 : 0xe5ded1,
        transparent: true,
        opacity: 0.13 + (this.completedPasses % 4) * 0.018,
        depthWrite: false,
      }),
    );
    line.name = `weave-pass-${this.completedPasses + 1}`;
    line.renderOrder = 3;
    this.root.add(line);
    this.activePass = { points, normal, line };
  }

  private choosePassNormal(): THREE.Vector3 {
    let leastIndex = 0;
    for (let index = 1; index < this.coverage.length; index += 1) {
      if (this.coverage[index] < this.coverage[leastIndex]) leastIndex = index;
    }
    const target = this.coverageDirections[leastIndex];
    const tangent = new THREE.Vector3(
      Math.abs(target.y) < 0.78 ? 0 : 1,
      Math.abs(target.y) < 0.78 ? 1 : 0,
      0,
    ).cross(target).normalize();
    const bitangent = new THREE.Vector3().crossVectors(target, tangent).normalize();
    let bestNormal = tangent.clone();
    let bestScore = -Infinity;
    for (let candidate = 0; candidate < 14; candidate += 1) {
      const angle = (candidate / 14) * Math.PI + this.completedPasses * GOLDEN_ANGLE;
      const normal = tangent.clone().multiplyScalar(Math.cos(angle)).addScaledVector(bitangent, Math.sin(angle));
      let score = 0;
      for (let cell = 0; cell < this.coverage.length; cell += 1) {
        const planeDistance = Math.abs(this.coverageDirections[cell].dot(normal));
        const influence = Math.exp(-Math.pow(planeDistance / 0.28, 2));
        score += (1 - this.coverage[cell]) * influence;
      }
      if (this.previousPassNormal) score += Math.abs(normal.dot(this.previousPassNormal)) < 0.82 ? 1.4 : -1.2;
      if (score > bestScore) {
        bestScore = score;
        bestNormal = normal;
      }
    }
    return bestNormal.normalize();
  }

  private updateGrowingPass(phase: number): void {
    if (!this.activePass) return;
    const reveal = smoothstep((phase - 0.22) / 0.57);
    const visibleSegments = Math.max(
      1,
      Math.floor(1 + reveal * (this.activePass.points.length - 2)),
    );
    this.activePass.line.geometry.setDrawRange(0, visibleSegments * this.filamentCount * 2);
  }

  private finishPass(): void {
    if (!this.activePass) return;
    const fiberPosition = this.activePass.line.geometry.getAttribute("position");
    this.activePass.line.geometry.setDrawRange(0, fiberPosition.count);
    for (let index = 0; index < this.coverage.length; index += 1) {
      const planeDistance = Math.abs(this.coverageDirections[index].dot(this.activePass.normal));
      const pathCompleteness = this.activePass.points.length / POINTS_PER_PASS;
      const depositedSilk = Math.exp(-Math.pow(planeDistance / 0.3, 2))
        * 0.19
        * THREE.MathUtils.clamp(pathCompleteness, 0.7, 1);
      this.coverage[index] = Math.min(1, this.coverage[index] + depositedSilk);
    }
    this.previousPassNormal = this.activePass.normal.clone();
    this.activePass = null;
    this.completedPasses += 1;
    this.updateDensityVisuals();
  }

  private poseForPhase(phase: number): RearLegWorkPose {
    const activeSide = this.workingSide;
    if (phase < 0.18) {
      return { activeSide, action: "searching", reach: smoothstep(phase / 0.18), pull: 0, grip: 0 };
    }
    if (phase < 0.3) {
      return { activeSide, action: "grabbing", reach: 1, pull: 0, grip: smoothstep((phase - 0.18) / 0.12) };
    }
    if (phase < 0.76) {
      const pull = smoothstep((phase - 0.3) / 0.46);
      return { activeSide, action: "pulling", reach: 1 - pull * 0.58, pull, grip: 1 };
    }
    if (phase < 0.86) {
      return { activeSide, action: "releasing", reach: 0.42, pull: 1, grip: 1 - smoothstep((phase - 0.76) / 0.1) };
    }
    return { activeSide, action: "resetting", reach: 0.42 * (1 - smoothstep((phase - 0.86) / 0.14)), pull: 0, grip: 0 };
  }

  private updateContactWorld(phase: number): void {
    if (!this.activePass) return;
    const reveal = smoothstep((phase - 0.22) / 0.57);
    const contactIndex = Math.min(
      this.activePass.points.length - 1,
      Math.floor(reveal * (this.activePass.points.length - 1)),
    );
    this.localContact.copy(this.activePass.points[contactIndex]);
    this.worldContact.copy(this.localContact);
    this.prey.localToWorld(this.worldContact);
  }

  private updateWorkingSilk(attachments: PreyWrapAttachments): void {
    if (!this.activePass) {
      this.workingSilk.material.opacity = 0;
      this.workingSilk.visible = false;
      return;
    }
    const activeFoot = this.legPose.activeSide === "left" ? attachments.leftHindFoot : attachments.rightHindFoot;
    const activeSpinneret = this.legPose.activeSide === "left"
      ? attachments.leftSpinneret
      : attachments.rightSpinneret;

    this.scratch.subVectors(this.worldContact, activeSpinneret).normalize();
    this.workingControlBefore
      .copy(activeFoot)
      .addScaledVector(this.scratch, -activeFoot.distanceTo(activeSpinneret) * 0.28);
    this.workingControlAfter
      .copy(activeFoot)
      .addScaledVector(this.scratch, activeFoot.distanceTo(this.worldContact) * 0.28);
    let pointIndex = 0;
    for (let index = 0; index <= 5; index += 1) {
      this.writeQuadraticSilkPoint(
        pointIndex,
        activeSpinneret,
        this.workingControlBefore,
        activeFoot,
        index / 5,
      );
      pointIndex += 1;
    }
    for (let index = 1; index <= 5; index += 1) {
      this.writeQuadraticSilkPoint(
        pointIndex,
        activeFoot,
        this.workingControlAfter,
        this.worldContact,
        index / 5,
      );
      pointIndex += 1;
    }
    const position = this.workingSilk.geometry.getAttribute("position") as THREE.BufferAttribute;
    position.needsUpdate = true;
    this.workingSilk.visible = this.legPose.action !== "resetting";
    this.workingSilk.material.opacity = this.legPose.grip > 0
      ? 0.64
      : 0.16 * smoothstep((this.currentPhase - 0.08) / 0.1);
  }

  private writeQuadraticSilkPoint(
    index: number,
    start: THREE.Vector3,
    control: THREE.Vector3,
    end: THREE.Vector3,
    t: number,
  ): void {
    const inverse = 1 - t;
    const a = inverse * inverse;
    const b = 2 * inverse * t;
    const c = t * t;
    this.workingSilkPositions[index * 3] = start.x * a + control.x * b + end.x * c;
    this.workingSilkPositions[index * 3 + 1] = start.y * a + control.y * b + end.y * c;
    this.workingSilkPositions[index * 3 + 2] = start.z * a + control.z * b + end.z * c;
  }

  private updateDensityVisuals(): void {
    const colorArray = this.cocoonPointColors.array as Float32Array;
    for (let index = 0; index < this.pointCoverageCells.length; index += 1) {
      const amount = smoothstep((this.coverage[this.pointCoverageCells[index]] - 0.08) / 0.82);
      colorArray[index * 4 + 3] = amount;
    }
    this.cocoonPointColors.needsUpdate = true;
    const coverage = this.snapshot.coverage;
    this.shell.material.opacity = smoothstep((coverage - 0.34) / 0.54) * 0.2;
    this.shell.visible = this.shell.material.opacity > 0.003;
    this.shell.scale.setScalar(1 + coverage * 0.018);
  }

  private coverageNear(direction: THREE.Vector3): number {
    let nearestIndex = 0;
    let nearestDot = -Infinity;
    for (let index = 0; index < this.coverageDirections.length; index += 1) {
      const dot = direction.dot(this.coverageDirections[index]);
      if (dot > nearestDot) {
        nearestDot = dot;
        nearestIndex = index;
      }
    }
    return this.coverage[nearestIndex];
  }

  /** Find the furthest positive ray exit from the union of prey surface lobes. */
  private projectToSurface(direction: THREE.Vector3, target: THREE.Vector3): THREE.Vector3 {
    this.envelopeDirection.copy(direction).normalize();
    const fallbackDenominator =
      Math.pow(this.envelopeDirection.x / this.radii.x, 2)
      + Math.pow(this.envelopeDirection.y / this.radii.y, 2)
      + Math.pow(this.envelopeDirection.z / this.radii.z, 2);
    let furthestDistance = 1 / Math.sqrt(Math.max(1e-8, fallbackDenominator));

    for (const lobe of this.surfaceLobes) {
      this.inverseLobeRotation.copy(lobe.rotation).invert();
      this.envelopeLocalDirection.copy(this.envelopeDirection).applyQuaternion(this.inverseLobeRotation);
      this.envelopeOrigin.copy(lobe.center).multiplyScalar(-1);
      this.envelopeLocalOrigin.copy(this.envelopeOrigin).applyQuaternion(this.inverseLobeRotation);
      const dx = this.envelopeLocalDirection.x / lobe.radii.x;
      const dy = this.envelopeLocalDirection.y / lobe.radii.y;
      const dz = this.envelopeLocalDirection.z / lobe.radii.z;
      const ox = this.envelopeLocalOrigin.x / lobe.radii.x;
      const oy = this.envelopeLocalOrigin.y / lobe.radii.y;
      const oz = this.envelopeLocalOrigin.z / lobe.radii.z;
      const a = dx * dx + dy * dy + dz * dz;
      const b = 2 * (ox * dx + oy * dy + oz * dz);
      const c = ox * ox + oy * oy + oz * oz - 1;
      const discriminant = b * b - 4 * a * c;
      if (discriminant < 0 || a <= 1e-8) continue;
      const exit = (-b + Math.sqrt(discriminant)) / (2 * a);
      if (exit > furthestDistance) furthestDistance = exit;
    }
    return target.copy(this.envelopeDirection).multiplyScalar(furthestDistance);
  }

  private integrateRotation(dt: number, damping: number, maximumSpeed: number): void {
    this.angularVelocity.multiplyScalar(Math.exp(-damping * dt));
    const speed = this.angularVelocity.length();
    if (speed > maximumSpeed) this.angularVelocity.multiplyScalar(maximumSpeed / speed);
    const angularStep = this.angularVelocity.length() * dt;
    if (angularStep <= 1e-5) return;
    this.torqueAxis.copy(this.angularVelocity).normalize();
    this.rotationStep.setFromAxisAngle(this.torqueAxis, angularStep);
    this.prey.quaternion.premultiply(this.rotationStep).normalize();
    this.prey.updateWorldMatrix(true, false);
  }
}
