import { ParticleStore } from "./ParticleStore";
import { WebNode, type WebNodeMode } from "./WebNode";
import { WebStrand } from "./WebStrand";

export interface AddStrandOptions {
  id: string;
  startNode: WebNode;
  endNode: WebNode;
  initialPositions: Float32Array;
  restLengths: Float32Array;
  stiffness: number;
  damping: number;
  linearDensity: number;
}

export class WebNetwork {
  readonly particles = new ParticleStore();
  readonly nodes = new Map<string, WebNode>();
  readonly strands = new Map<string, WebStrand>();
  readonly nodeList: WebNode[] = [];
  readonly strandList: WebStrand[] = [];

  addNode(
    id: string,
    label: string,
    x: number,
    y: number,
    z: number,
    mode: WebNodeMode,
    mass = 1,
  ): WebNode {
    if (this.nodes.has(id)) {
      throw new Error(`Duplicate web node id: ${id}`);
    }

    if (mode === "dynamic" && (!Number.isFinite(mass) || mass <= 0)) {
      throw new Error(`Dynamic node ${id} requires a positive mass.`);
    }

    const particleIndex = this.particles.allocate(
      x,
      y,
      z,
      mode === "fixed" ? 0 : 1 / mass,
      0,
    );
    const node = new WebNode(id, particleIndex, mode, label, mode === "fixed" ? Infinity : mass);
    this.nodes.set(id, node);
    this.nodeList.push(node);
    return node;
  }

  addStrand(options: AddStrandOptions): WebStrand {
    if (this.strands.has(options.id)) {
      throw new Error(`Duplicate web strand id: ${options.id}`);
    }

    const pointCount = options.initialPositions.length / 3;
    if (!Number.isInteger(pointCount) || pointCount < 2) {
      throw new Error(`Invalid point data for strand ${options.id}.`);
    }
    if (
      this.nodes.get(options.startNode.id) !== options.startNode ||
      this.nodes.get(options.endNode.id) !== options.endNode
    ) {
      throw new Error(`Strand ${options.id} references nodes outside this network.`);
    }
    if (options.restLengths.length !== pointCount - 1) {
      throw new Error(`Rest-length count does not match strand ${options.id} topology.`);
    }
    for (let segment = 0; segment < options.restLengths.length; segment += 1) {
      if (!Number.isFinite(options.restLengths[segment]) || options.restLengths[segment] <= 0) {
        throw new Error(`Strand ${options.id} has an invalid rest length at segment ${segment}.`);
      }
    }
    if (!Number.isFinite(options.linearDensity) || options.linearDensity <= 0) {
      throw new Error(`Strand ${options.id} requires a positive linear density.`);
    }

    const particleIndices = new Uint32Array(pointCount);
    particleIndices[0] = options.startNode.particleIndex;
    particleIndices[pointCount - 1] = options.endNode.particleIndex;

    for (let point = 1; point < pointCount - 1; point += 1) {
      const offset = point * 3;
      const leftRest = options.restLengths[point - 1];
      const rightRest = options.restLengths[point] ?? leftRest;
      const mass = Math.max(1e-4, options.linearDensity * (leftRest + rightRest) * 0.5);
      particleIndices[point] = this.particles.allocate(
        options.initialPositions[offset],
        options.initialPositions[offset + 1],
        options.initialPositions[offset + 2],
        1 / mass,
        options.damping,
      );
    }

    const strand = new WebStrand(
      options.id,
      options.startNode,
      options.endNode,
      particleIndices,
      options.restLengths,
      options.stiffness,
      options.damping,
      options.linearDensity,
    );

    this.strands.set(strand.id, strand);
    this.strandList.push(strand);
    options.startNode.connect(strand.id);
    options.endNode.connect(strand.id);
    return strand;
  }

  get constraintCount(): number {
    let count = 0;
    for (const strand of this.strandList) {
      if (strand.active && !strand.broken) {
        count += strand.constraintCount;
      }
    }
    return count;
  }

  setNodeMass(node: WebNode, mass: number): void {
    if (this.nodes.get(node.id) !== node || node.isFixed) {
      throw new Error(`Only a dynamic node owned by this network can change mass.`);
    }
    if (!Number.isFinite(mass) || mass <= 0) {
      throw new Error(`Dynamic node ${node.id} requires a positive mass.`);
    }
    node.mass = mass;
    this.particles.inverseMasses[node.particleIndex] = 1 / mass;
  }

  /**
   * Resolves strand-owned damping onto shared particles. Interior particles
   * inherit their strand; a future junction receives the connected average.
   * This runs only when tuning/topology changes, never inside the frame loop.
   */
  syncParticleDamping(): void {
    const totals = new Float32Array(this.particles.count);
    const counts = new Uint16Array(this.particles.count);

    for (const strand of this.strandList) {
      if (!strand.active || strand.broken) {
        continue;
      }
      for (let point = 0; point < strand.pointCount; point += 1) {
        const particle = strand.particleIndices[point];
        totals[particle] += strand.damping;
        counts[particle] += 1;
      }
    }

    for (let particle = 0; particle < this.particles.count; particle += 1) {
      if (counts[particle] > 0) {
        this.particles.dampingRates[particle] = totals[particle] / counts[particle];
      }
    }
  }
}
