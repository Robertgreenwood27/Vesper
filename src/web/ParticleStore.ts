/**
 * Dense physics storage shared by the entire web network.
 *
 * A main node owns one particle index, and every strand connected to that node
 * references the same index. That rule is what lets the Phase 2 junction
 * transmit forces without scripted coupling.
 */
export class ParticleStore {
  positions: Float32Array;
  previousPositions: Float32Array;
  forces: Float32Array;
  inverseMasses: Float32Array;
  dampingRates: Float32Array;
  count = 0;

  constructor(initialCapacity = 32) {
    this.positions = new Float32Array(initialCapacity * 3);
    this.previousPositions = new Float32Array(initialCapacity * 3);
    this.forces = new Float32Array(initialCapacity * 3);
    this.inverseMasses = new Float32Array(initialCapacity);
    this.dampingRates = new Float32Array(initialCapacity);
  }

  get capacity(): number {
    return this.inverseMasses.length;
  }

  allocate(
    x: number,
    y: number,
    z: number,
    inverseMass: number,
    dampingRate: number,
  ): number {
    this.ensureCapacity(this.count + 1);

    const index = this.count;
    const offset = index * 3;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;
    this.previousPositions[offset] = x;
    this.previousPositions[offset + 1] = y;
    this.previousPositions[offset + 2] = z;
    this.inverseMasses[index] = inverseMass;
    this.dampingRates[index] = dampingRate;
    this.count += 1;

    return index;
  }

  setPosition(index: number, x: number, y: number, z: number, resetVelocity = true): void {
    const offset = index * 3;
    this.positions[offset] = x;
    this.positions[offset + 1] = y;
    this.positions[offset + 2] = z;

    if (resetVelocity) {
      this.previousPositions[offset] = x;
      this.previousPositions[offset + 1] = y;
      this.previousPositions[offset + 2] = z;
    }
  }

  stopMotion(): void {
    this.previousPositions.set(this.positions.subarray(0, this.count * 3), 0);
    this.clearForces();
  }

  clearForces(): void {
    this.forces.fill(0, 0, this.count * 3);
  }

  setDampingRate(rate: number): void {
    for (let index = 0; index < this.count; index += 1) {
      if (this.inverseMasses[index] > 0) {
        this.dampingRates[index] = rate;
      }
    }
  }

  private ensureCapacity(required: number): void {
    if (required <= this.capacity) {
      return;
    }

    let nextCapacity = this.capacity;
    while (nextCapacity < required) {
      nextCapacity *= 2;
    }

    const positions = new Float32Array(nextCapacity * 3);
    const previousPositions = new Float32Array(nextCapacity * 3);
    const forces = new Float32Array(nextCapacity * 3);
    const inverseMasses = new Float32Array(nextCapacity);
    const dampingRates = new Float32Array(nextCapacity);

    positions.set(this.positions);
    previousPositions.set(this.previousPositions);
    forces.set(this.forces);
    inverseMasses.set(this.inverseMasses);
    dampingRates.set(this.dampingRates);

    this.positions = positions;
    this.previousPositions = previousPositions;
    this.forces = forces;
    this.inverseMasses = inverseMasses;
    this.dampingRates = dampingRates;
  }
}
