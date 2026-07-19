import * as THREE from "three";
import {
  effectiveBendMaximumDegrees,
  type SpiderChoreographer,
} from "../spider/choreography/index";
import type { SpiderRig } from "../spider/SpiderRig";
import { SPIDER_LEG_IDS, type SpiderLegId } from "../spider/SpiderRigSpec";

type Severity = "ok" | "warning" | "limit";

interface JointReading {
  readonly name: string;
  readonly bend: number;
  readonly twist: number;
  readonly swing: number;
  readonly severity: Severity;
  readonly limits: {
    readonly bend: readonly [number, number];
    readonly twist: readonly [number, number];
    readonly swing: readonly [number, number];
  };
}

export interface LegDiagnosticReading {
  readonly legId: SpiderLegId;
  readonly reachRatio: number;
  readonly residual: number;
  readonly preferredBendDot: number;
  readonly bendFlips: number;
  readonly restBendFlips: number;
  readonly turnAngles: readonly number[];
  readonly restTurnAngles: readonly number[];
  readonly status: string;
  readonly severity: Severity;
  readonly joints: readonly JointReading[];
}

export interface RigDiagnosticControls {
  readonly onTogglePause: () => void;
  readonly onStep: () => void;
}

interface SegmentVisual {
  readonly legId: SpiderLegId;
  readonly jointIndex: number;
  readonly start: THREE.Bone;
  readonly end: THREE.Bone;
}

interface LegRow {
  readonly summary: HTMLElement;
  readonly joints: HTMLElement;
}

const COLORS: Record<Severity, THREE.Color> = {
  ok: new THREE.Color(0x54e18c),
  warning: new THREE.Color(0xffc857),
  limit: new THREE.Color(0xff4055),
};

const DEG = 180 / Math.PI;

/**
 * Query-gated rig instrumentation for diagnosing IK poses, never pet behavior.
 * It owns only helpers and DOM; the rig and choreographer remain authoritative.
 */
export class RigDiagnostics {
  private choreographer: SpiderChoreographer;
  private readonly rig: SpiderRig;
  private readonly panel: HTMLElement;
  private readonly pauseButton: HTMLButtonElement;
  private readonly stepButton: HTMLButtonElement;
  private readonly modeLabel: HTMLElement;
  private readonly rows = new Map<SpiderLegId, LegRow>();
  private readonly restRotations = new Map<string, THREE.Quaternion>();
  private readonly restPositions = new Map<string, THREE.Vector3>();
  private readonly segments: SegmentVisual[] = [];
  private readings: LegDiagnosticReading[] = [];
  private nextDomUpdate = 0;

  private readonly segmentPositions: Float32Array;
  private readonly segmentColors: Float32Array;
  private readonly segmentGeometry: THREE.BufferGeometry;
  private readonly segmentLines: THREE.LineSegments;
  private readonly targetPositions = new Float32Array(SPIDER_LEG_IDS.length * 2 * 3);
  private readonly targetColors = new Float32Array(SPIDER_LEG_IDS.length * 2 * 3);
  private readonly targetGeometry: THREE.BufferGeometry;
  private readonly targetLines: THREE.LineSegments;
  private readonly jointPositions: Float32Array;
  private readonly jointColors: Float32Array;
  private readonly jointGeometry: THREE.BufferGeometry;
  private readonly jointPoints: THREE.Points;

  private readonly relative = new THREE.Quaternion();
  private readonly restInverse = new THREE.Quaternion();
  private readonly euler = new THREE.Euler(0, 0, 0, "XYZ");
  private readonly worldA = new THREE.Vector3();
  private readonly worldB = new THREE.Vector3();

  constructor(
    scene: THREE.Scene,
    host: HTMLElement,
    rig: SpiderRig,
    choreographer: SpiderChoreographer,
    controls: RigDiagnosticControls,
  ) {
    this.rig = rig;
    this.choreographer = choreographer;
    rig.rootObject.updateMatrixWorld(true);

    for (const legId of SPIDER_LEG_IDS) {
      const leg = rig.legs[legId];
      for (const bone of leg.chain) {
        this.restPositions.set(bone.uuid, bone.getWorldPosition(new THREE.Vector3()));
      }
      for (let jointIndex = 0; jointIndex < leg.joints.length; jointIndex += 1) {
        const joint = leg.joints[jointIndex];
        this.restRotations.set(joint.uuid, joint.quaternion.clone());
        this.segments.push({
          legId,
          jointIndex,
          start: joint,
          end: leg.chain[jointIndex + 1],
        });
      }
    }

    this.segmentPositions = new Float32Array(this.segments.length * 2 * 3);
    this.segmentColors = new Float32Array(this.segments.length * 2 * 3);
    this.segmentGeometry = dynamicGeometry(this.segmentPositions, this.segmentColors);
    this.segmentLines = new THREE.LineSegments(
      this.segmentGeometry,
      new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.96,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.segmentLines.frustumCulled = false;
    this.segmentLines.renderOrder = 40;
    scene.add(this.segmentLines);

    this.targetGeometry = dynamicGeometry(this.targetPositions, this.targetColors);
    this.targetLines = new THREE.LineSegments(
      this.targetGeometry,
      new THREE.LineDashedMaterial({
        vertexColors: true,
        dashSize: 0.045,
        gapSize: 0.025,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.targetLines.frustumCulled = false;
    this.targetLines.renderOrder = 41;
    scene.add(this.targetLines);

    this.jointPositions = new Float32Array(this.segments.length * 3);
    this.jointColors = new Float32Array(this.segments.length * 3);
    this.jointGeometry = dynamicGeometry(this.jointPositions, this.jointColors);
    this.jointPoints = new THREE.Points(
      this.jointGeometry,
      new THREE.PointsMaterial({
        size: 0.052,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
      }),
    );
    this.jointPoints.frustumCulled = false;
    this.jointPoints.renderOrder = 42;
    scene.add(this.jointPoints);

    this.panel = document.createElement("section");
    this.panel.className = "rig-debug-panel";
    this.panel.setAttribute("aria-label", "Rig diagnostics");
    this.panel.innerHTML = `
      <header>
        <span>RIG DIAGNOSTICS</span>
        <strong data-rig-mode>RUNNING</strong>
      </header>
      <div class="rig-debug-controls">
        <button type="button" data-rig-pause>Pause <kbd>P</kbd></button>
        <button type="button" data-rig-step>Step <kbd>.</kbd></button>
      </div>
      <p class="rig-debug-help">bend° from rest · line = solved bone · dash = foot error</p>
      <div class="rig-debug-legs" data-rig-legs></div>
      <footer><i class="ok"></i>safe <i class="warning"></i>near limit <i class="limit"></i>outside</footer>
    `;
    host.append(this.panel);

    this.pauseButton = this.requireElement<HTMLButtonElement>("[data-rig-pause]");
    this.stepButton = this.requireElement<HTMLButtonElement>("[data-rig-step]");
    this.modeLabel = this.requireElement<HTMLElement>("[data-rig-mode]");
    this.pauseButton.addEventListener("click", controls.onTogglePause);
    this.stepButton.addEventListener("click", controls.onStep);

    const legs = this.requireElement<HTMLElement>("[data-rig-legs]");
    for (const legId of SPIDER_LEG_IDS) {
      const row = document.createElement("div");
      row.className = "rig-debug-leg";
      row.innerHTML = `
        <strong>${legId}</strong>
        <span class="rig-debug-summary"></span>
        <span class="rig-debug-joints"></span>
      `;
      legs.append(row);
      this.rows.set(legId, {
        summary: row.querySelector<HTMLElement>(".rig-debug-summary")!,
        joints: row.querySelector<HTMLElement>(".rig-debug-joints")!,
      });
    }
  }

  setChoreographer(choreographer: SpiderChoreographer): void {
    this.choreographer = choreographer;
  }

  setPaused(paused: boolean): void {
    this.modeLabel.textContent = paused ? "PAUSED" : "RUNNING";
    this.modeLabel.classList.toggle("paused", paused);
    this.pauseButton.childNodes[0].textContent = paused ? "Resume " : "Pause ";
    this.stepButton.disabled = !paused;
  }

  snapshot(): readonly LegDiagnosticReading[] {
    return this.readings;
  }

  update(now = performance.now()): void {
    this.rig.rootObject.updateMatrixWorld(true);
    this.readings = SPIDER_LEG_IDS.map((legId) => this.readLeg(legId));
    this.updateLines();
    if (now >= this.nextDomUpdate) {
      this.nextDomUpdate = now + 100;
      this.updatePanel();
    }
  }

  private readLeg(legId: SpiderLegId): LegDiagnosticReading {
    const leg = this.rig.legs[legId];
    const solve = this.choreographer.ik.getResult(legId);
    const points = leg.chain.map((bone) => bone.getWorldPosition(new THREE.Vector3()));
    const restPoints = leg.chain.map(
      (bone) => this.restPositions.get(bone.uuid)?.clone() ?? bone.getWorldPosition(new THREE.Vector3()),
    );
    const turnShape = measureTurnShape(points);
    const restTurnShape = measureTurnShape(restPoints);
    const joints = leg.joints.map((bone, jointIndex): JointReading => {
      const rest = this.restRotations.get(bone.uuid) ?? bone.quaternion;
      this.restInverse.copy(rest).invert();
      this.relative.copy(this.restInverse).multiply(bone.quaternion).normalize();
      this.euler.setFromQuaternion(this.relative, "XYZ");
      const bend = this.euler.x * DEG;
      const twist = this.euler.y * DEG;
      const swing = this.euler.z * DEG;
      const limit = leg.jointLimits[jointIndex];
      const scale = Math.max(0.01, this.choreographer.config.jointLimitScale || 1);
      const bendMax = effectiveBendMaximumDegrees(
        legId,
        leg.segmentNames[jointIndex],
        limit.bend_x[1] * scale,
      );
      const limits = {
        bend: [limit.bend_x[0] * scale, bendMax] as const,
        twist: [limit.twist_y[0] * scale, limit.twist_y[1] * scale] as const,
        swing: [limit.swing_z[0] * scale, limit.swing_z[1] * scale] as const,
      };
      const severity = worstSeverity(
        rangeSeverity(bend, limits.bend),
        rangeSeverity(twist, limits.twist),
        rangeSeverity(swing, limits.swing),
      );
      return {
        name: leg.segmentNames[jointIndex],
        bend,
        twist,
        swing,
        severity,
        limits,
      };
    });

    const reachRatio = solve?.reachRatio ?? 0;
    const reachSeverity: Severity = reachRatio > 0.93 ? "limit" : reachRatio > 0.84 ? "warning" : "ok";
    const bendSeverity: Severity = (solve?.preferredBendDot ?? 1) < 0 ? "limit" : "ok";
    const stairSeverity: Severity = turnShape.flips > restTurnShape.flips
      ? turnShape.flips > restTurnShape.flips + 1 ? "limit" : "warning"
      : "ok";
    const severity = worstSeverity(
      reachSeverity,
      bendSeverity,
      stairSeverity,
      ...joints.map((joint) => joint.severity),
    );
    return {
      legId,
      reachRatio,
      residual: solve?.residual ?? 0,
      preferredBendDot: solve?.preferredBendDot ?? 1,
      bendFlips: turnShape.flips,
      restBendFlips: restTurnShape.flips,
      turnAngles: turnShape.angles,
      restTurnAngles: restTurnShape.angles,
      status: solve?.status ?? "not-solved",
      severity,
      joints,
    };
  }

  private updateLines(): void {
    let segmentOffset = 0;
    let jointOffset = 0;
    for (const segment of this.segments) {
      const reading = this.readings.find((item) => item.legId === segment.legId)!;
      const color = COLORS[reading.joints[segment.jointIndex].severity];
      segment.start.getWorldPosition(this.worldA);
      segment.end.getWorldPosition(this.worldB);
      writeVector(this.segmentPositions, segmentOffset, this.worldA);
      writeVector(this.segmentPositions, segmentOffset + 3, this.worldB);
      writeColor(this.segmentColors, segmentOffset, color);
      writeColor(this.segmentColors, segmentOffset + 3, color);
      segmentOffset += 6;
      writeVector(this.jointPositions, jointOffset, this.worldA);
      writeColor(this.jointColors, jointOffset, color);
      jointOffset += 3;
    }

    for (let index = 0; index < SPIDER_LEG_IDS.length; index += 1) {
      const legId = SPIDER_LEG_IDS[index];
      const leg = this.rig.legs[legId];
      const solve = this.choreographer.ik.getResult(legId);
      const reading = this.readings[index];
      const offset = index * 6;
      leg.footTip.getWorldPosition(this.worldA);
      this.worldB.copy(this.worldA);
      if (solve?.targetValid) this.worldB.copy(solve.requestedTarget);
      writeVector(this.targetPositions, offset, this.worldA);
      writeVector(this.targetPositions, offset + 3, this.worldB);
      writeColor(this.targetColors, offset, COLORS[reading.severity]);
      writeColor(this.targetColors, offset + 3, COLORS[reading.severity]);
    }

    markDynamic(this.segmentGeometry);
    markDynamic(this.targetGeometry);
    markDynamic(this.jointGeometry);
    this.targetLines.computeLineDistances();
  }

  private updatePanel(): void {
    for (const reading of this.readings) {
      const row = this.rows.get(reading.legId)!;
      row.summary.className = `rig-debug-summary ${reading.severity}`;
      row.summary.textContent =
        `reach ${(reading.reachRatio * 100).toFixed(0)}% · err ${formatResidual(reading.residual)} · flips ${reading.bendFlips}/${reading.restBendFlips}`;
      row.summary.title =
        `world turn angles: ${reading.turnAngles.map((angle) => `${angle.toFixed(0)}°`).join(" · ")}; `
        + `rest: ${reading.restTurnAngles.map((angle) => `${angle.toFixed(0)}°`).join(" · ")}`;
      row.joints.replaceChildren(
        ...reading.joints.map((joint) => {
          const item = document.createElement("span");
          item.className = joint.severity;
          item.textContent = `${jointAbbreviation(joint.name)} ${signed(joint.bend)}°`;
          item.title =
            `${joint.name}: bend ${signed(joint.bend)}° [${joint.limits.bend.join(", ")}], ` +
            `twist ${signed(joint.twist)}° [${joint.limits.twist.join(", ")}], ` +
            `swing ${signed(joint.swing)}° [${joint.limits.swing.join(", ")}]`;
          return item;
        }),
      );
    }
  }

  private requireElement<T extends Element>(selector: string): T {
    const element = this.panel.querySelector<T>(selector);
    if (!element) throw new Error(`Rig diagnostics is missing ${selector}.`);
    return element;
  }
}

function dynamicGeometry(positions: Float32Array, colors: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3).setUsage(THREE.DynamicDrawUsage));
  return geometry;
}

function markDynamic(geometry: THREE.BufferGeometry): void {
  geometry.getAttribute("position").needsUpdate = true;
  geometry.getAttribute("color").needsUpdate = true;
}

function writeVector(target: Float32Array, offset: number, value: THREE.Vector3): void {
  target[offset] = value.x;
  target[offset + 1] = value.y;
  target[offset + 2] = value.z;
}

function writeColor(target: Float32Array, offset: number, value: THREE.Color): void {
  target[offset] = value.r;
  target[offset + 1] = value.g;
  target[offset + 2] = value.b;
}

function rangeSeverity(value: number, range: readonly [number, number]): Severity {
  if (!Number.isFinite(value)) return "limit";
  if (value < range[0] || value > range[1]) return "limit";
  const span = Math.max(1e-4, range[1] - range[0]);
  const margin = Math.min(value - range[0], range[1] - value);
  return margin / span < 0.14 ? "warning" : "ok";
}

function measureTurnShape(points: readonly THREE.Vector3[]): { flips: number; angles: number[] } {
  const incoming = new THREE.Vector3();
  const outgoing = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const previousNormal = new THREE.Vector3();
  const angles: number[] = [];
  let hasPreviousNormal = false;
  let flips = 0;

  for (let pointIndex = 1; pointIndex < points.length - 1; pointIndex += 1) {
    incoming.copy(points[pointIndex]).sub(points[pointIndex - 1]).normalize();
    outgoing.copy(points[pointIndex + 1]).sub(points[pointIndex]).normalize();
    const angle = Math.acos(THREE.MathUtils.clamp(incoming.dot(outgoing), -1, 1)) * DEG;
    angles.push(angle);
    normal.crossVectors(incoming, outgoing);
    if (angle < 4 || normal.lengthSq() < 1e-8) continue;
    normal.normalize();
    if (hasPreviousNormal && previousNormal.dot(normal) < -0.25) flips += 1;
    previousNormal.copy(normal);
    hasPreviousNormal = true;
  }

  return { flips, angles };
}

function worstSeverity(...values: Severity[]): Severity {
  if (values.includes("limit")) return "limit";
  if (values.includes("warning")) return "warning";
  return "ok";
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return `${rounded >= 0 ? "+" : ""}${rounded}`;
}

function formatResidual(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value < 0.001 ? value.toExponential(1) : value.toFixed(3);
}

function jointAbbreviation(name: string): string {
  switch (name) {
    case "Coxa": return "C";
    case "Femur": return "F";
    case "Patella": return "P";
    case "Tibia": return "Ti";
    case "Metatarsus": return "M";
    case "Tarsus": return "Ta";
    default: return name.slice(0, 2);
  }
}
