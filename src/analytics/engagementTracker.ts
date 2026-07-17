import type { EngagementEvent } from "./engagementEvents";

const ENDPOINT = "/api/engagement";
const REPORTED_KEY = "vesper.analytics.reported.v1";
const VISITED_KEY = "vesper.analytics.visited.v1";
const FLUSH_DELAY_MS = 8_000;
const globalPrivacyControl = (navigator as Navigator & { globalPrivacyControl?: boolean })
  .globalPrivacyControl;
const trackingAllowed =
  import.meta.env.PROD && navigator.doNotTrack !== "1" && globalPrivacyControl !== true;

const reported = new Set<EngagementEvent>();
const pending = new Set<EngagementEvent>();
const inFlight = new Set<EngagementEvent>();
let flushTimer: number | null = null;
let initialized = false;

function readReportedEvents(): void {
  try {
    const value = JSON.parse(sessionStorage.getItem(REPORTED_KEY) ?? "[]") as unknown;
    if (!Array.isArray(value)) return;
    for (const event of value) {
      if (typeof event === "string") reported.add(event as EngagementEvent);
    }
  } catch {
    // Session storage is an optimization; tracking still works without it.
  }
}

function saveReportedEvents(): void {
  try {
    sessionStorage.setItem(REPORTED_KEY, JSON.stringify([...reported]));
  } catch {
    // Privacy modes may disable session storage.
  }
}

function acknowledge(events: readonly EngagementEvent[]): void {
  for (const event of events) {
    inFlight.delete(event);
    reported.add(event);
  }
  saveReportedEvents();
}

function restore(events: readonly EngagementEvent[]): void {
  for (const event of events) {
    inFlight.delete(event);
    if (!reported.has(event)) pending.add(event);
  }
}

async function flushWithFetch(): Promise<void> {
  flushTimer = null;
  if (!trackingAllowed || pending.size === 0) return;
  const events = [...pending];
  pending.clear();
  for (const event of events) inFlight.add(event);

  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      credentials: "same-origin",
      keepalive: true,
    });
    if (!response.ok) throw new Error(`Engagement endpoint returned ${response.status}`);
    acknowledge(events);
  } catch {
    restore(events);
  }
}

function scheduleFlush(): void {
  if (!trackingAllowed || flushTimer !== null) return;
  flushTimer = window.setTimeout(() => void flushWithFetch(), FLUSH_DELAY_MS);
}

function flushWithBeacon(): void {
  if (!trackingAllowed || pending.size === 0) return;
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  const events = [...pending];
  const body = new Blob([JSON.stringify({ events })], { type: "application/json" });
  if (navigator.sendBeacon?.(ENDPOINT, body)) {
    pending.clear();
    acknowledge(events);
  }
}

function queue(event: EngagementEvent, marksEngagement: boolean): void {
  if (reported.has(event) || pending.has(event) || inFlight.has(event)) return;
  pending.add(event);
  if (
    marksEngagement &&
    event !== "engaged" &&
    !reported.has("engaged") &&
    !pending.has("engaged") &&
    !inFlight.has("engaged")
  ) {
    pending.add("engaged");
  }
  scheduleFlush();
}

/** Records a meaningful action at most once per browser tab. */
export function trackEngagement(event: EngagementEvent): void {
  queue(event, event !== "return_visit" && !event.startsWith("stayed_") && event !== "load_failed");
}

function initializeReturnVisit(): void {
  try {
    if (localStorage.getItem(VISITED_KEY) === "1") queue("return_visit", false);
    localStorage.setItem(VISITED_KEY, "1");
  } catch {
    // A return visit cannot be inferred when local storage is unavailable.
  }
}

function initializeVisibleTimeMilestones(): void {
  const milestones = [
    { milliseconds: 30_000, event: "stayed_30_seconds" },
    { milliseconds: 120_000, event: "stayed_2_minutes" },
    { milliseconds: 300_000, event: "stayed_5_minutes" },
  ] as const;
  let visibleMilliseconds = 0;
  let visibleSince = document.hidden ? null : performance.now();

  const updateVisibleTime = (): void => {
    const now = performance.now();
    const elapsed = visibleSince === null ? 0 : now - visibleSince;
    const total = visibleMilliseconds + elapsed;
    for (const milestone of milestones) {
      if (total >= milestone.milliseconds) queue(milestone.event, false);
    }
  };

  document.addEventListener("visibilitychange", () => {
    const now = performance.now();
    if (document.hidden) {
      if (visibleSince !== null) visibleMilliseconds += now - visibleSince;
      visibleSince = null;
      updateVisibleTime();
      flushWithBeacon();
    } else {
      visibleSince = now;
    }
  });
  window.setInterval(updateVisibleTime, 1_000);
}

export function initializeEngagementTracking(): void {
  if (initialized || !trackingAllowed) return;
  initialized = true;
  readReportedEvents();
  initializeReturnVisit();
  initializeVisibleTimeMilestones();
  window.addEventListener("pagehide", flushWithBeacon);
}
