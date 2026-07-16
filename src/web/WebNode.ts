export type WebNodeMode = "fixed" | "dynamic";

/** A semantic web anchor/intersection backed by one shared physics particle. */
export class WebNode {
  readonly connectedStrandIds = new Set<string>();

  constructor(
    readonly id: string,
    readonly particleIndex: number,
    readonly mode: WebNodeMode,
    readonly label: string,
    public mass: number,
  ) {}

  get isFixed(): boolean {
    return this.mode === "fixed";
  }

  connect(strandId: string): void {
    this.connectedStrandIds.add(strandId);
  }
}
