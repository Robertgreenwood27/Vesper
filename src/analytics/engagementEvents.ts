export const ENGAGEMENT_EVENTS = [
  "engaged",
  "stayed_30_seconds",
  "stayed_2_minutes",
  "stayed_5_minutes",
  "return_visit",
  "info_panel_used",
  "care_panel_used",
  "strand_destination_chosen",
  "web_touched",
  "moth_offered",
  "moth_meal_completed",
  "retreat_used",
  "camera_follow_used",
  "observation_light_used",
  "vesper_renamed",
  "vestige_listened",
  "load_failed",
] as const;

export type EngagementEvent = (typeof ENGAGEMENT_EVENTS)[number];
export type EngagementCounts = Record<EngagementEvent, number>;

export const ENGAGEMENT_EVENT_SET: ReadonlySet<string> = new Set(ENGAGEMENT_EVENTS);

export function createEmptyEngagementCounts(): EngagementCounts {
  return Object.fromEntries(ENGAGEMENT_EVENTS.map((event) => [event, 0])) as EngagementCounts;
}
