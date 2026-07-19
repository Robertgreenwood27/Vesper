/**
 * Silk Lab choreography — the layer that makes the spider believable.
 *
 * Portable by design: it depends only on the rig, the semantic web, and the
 * physical contact/IK/load layer. It imports nothing from the debug lab, so it
 * can be lifted into the game as-is.
 *
 * The one rule it keeps: fake decisions, never fake contact.
 */
export {
  effectiveBendMaximumDegrees,
  L1_PATELLA_MAX_EXTENSION_DEGREES,
  PAIR_II_METATARSUS_MAX_EXTENSION_DEGREES,
  PAIR_III_METATARSUS_MAX_EXTENSION_DEGREES,
  SpiderChoreographer,
} from "./SpiderChoreographer";
export type { ChoreographerOptions, ChoreographerState } from "./SpiderChoreographer";
export {
  DEFAULT_CHOREOGRAPHY,
  createChoreographyConfig,
  type ChoreographyConfig,
} from "./ChoreographyConfig";
export { destinationOf, moodFor, type IntentMood, type SpiderIntent } from "./Intent";
export { FootholdSearch, type Foothold, type FootholdRequest } from "./FootholdSearch";
export { Gait, type GaitPermission, type LegDesire } from "./Gait";
export { Personality, Rng } from "./Personality";
export { RouteFollower } from "./RouteFollower";
export { Swing } from "./StepMotion";
