export const SPIDER_STEP_STATES = [
  "idle",
  "planning",
  "lifting",
  "swinging",
  "testing",
  "planting",
  "loading",
  "body-advance",
  "complete",
  "failed",
] as const;

export type SpiderStepState = (typeof SPIDER_STEP_STATES)[number];

export type SpiderStepFailureReason =
  | "none"
  | "rig-not-ready"
  | "invalid-intent"
  | "no-valid-candidate"
  | "support-below-minimum"
  | "target-strand-unavailable"
  | "target-unreachable"
  | "swing-clearance-blocked"
  | "ik-non-finite"
  | "probe-response-non-finite"
  | "body-advance-overextends-support"
  | "restoration-failed"
  | "cancelled";

export interface SpiderStepTransition {
  readonly from: SpiderStepState;
  readonly to: SpiderStepState;
  readonly elapsedSeconds: number;
  readonly reason: string;
}
