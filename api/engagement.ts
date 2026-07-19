import { get, put } from "@vercel/blob";
import {
  createEmptyEngagementCounts,
  ENGAGEMENT_EVENT_SET,
  type EngagementCounts,
  type EngagementEvent,
} from "../src/analytics/engagementEvents.js";

const MAX_BODY_BYTES = 2_048;
const MAX_EVENTS_PER_BATCH = 16;
const WRITE_ATTEMPTS = 5;

interface DailyAggregate {
  readonly version: 1;
  readonly date: string;
  readonly updatedAt: string;
  readonly batches: number;
  readonly counts: EngagementCounts;
}

function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  return origin === new URL(request.url).origin && (!fetchSite || fetchSite === "same-origin");
}

function parseEvents(value: unknown): EngagementEvent[] | null {
  if (!value || typeof value !== "object") return null;
  const events = (value as { events?: unknown }).events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_BATCH) {
    return null;
  }
  const unique = new Set<EngagementEvent>();
  for (const event of events) {
    if (typeof event !== "string" || !ENGAGEMENT_EVENT_SET.has(event)) return null;
    unique.add(event as EngagementEvent);
  }
  return [...unique];
}

function parseAggregate(value: unknown, date: string): DailyAggregate {
  if (!value || typeof value !== "object") throw new Error("Invalid engagement aggregate");
  const aggregate = value as Partial<DailyAggregate>;
  if (
    aggregate.version !== 1 ||
    aggregate.date !== date ||
    typeof aggregate.updatedAt !== "string" ||
    typeof aggregate.batches !== "number" ||
    !aggregate.counts ||
    typeof aggregate.counts !== "object"
  ) {
    throw new Error("Invalid engagement aggregate");
  }
  const counts = createEmptyEngagementCounts();
  for (const event of Object.keys(counts) as EngagementEvent[]) {
    const count = aggregate.counts[event];
    // New event types must not invalidate daily files written by older builds.
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error("Invalid engagement count");
    counts[event] = count;
  }
  return { ...aggregate, counts } as DailyAggregate;
}

async function updateDailyAggregate(date: string, events: readonly EngagementEvent[]): Promise<void> {
  const pathname = `analytics/daily/${date}.json`;
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const currentBlob = await get(pathname, { access: "private", useCache: false });
    let current: DailyAggregate = {
      version: 1,
      date,
      updatedAt: new Date().toISOString(),
      batches: 0,
      counts: createEmptyEngagementCounts(),
    };
    if (currentBlob?.statusCode === 200) {
      const raw = await new Response(currentBlob.stream).json() as unknown;
      current = parseAggregate(raw, date);
    }

    const counts = { ...current.counts };
    for (const event of events) counts[event] += 1;
    const next: DailyAggregate = {
      version: 1,
      date,
      updatedAt: new Date().toISOString(),
      batches: current.batches + 1,
      counts,
    };

    try {
      await put(pathname, JSON.stringify(next), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: currentBlob !== null,
        ifMatch: currentBlob?.blob.etag,
        contentType: "application/json",
        cacheControlMaxAge: 60,
      });
      return;
    } catch (error) {
      if (attempt === WRITE_ATTEMPTS - 1) throw error;
      // Another request may have created or changed today's aggregate. A fresh
      // origin read on the next pass merges both visitors instead of losing one.
    }
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json({ error: "Method not allowed" }, 405, { allow: "POST" });
    }
    if (process.env.VERCEL_ENV !== "production") {
      return json({ accepted: true, stored: false }, 202);
    }
    if (!isSameOrigin(request)) return json({ error: "Same-origin requests only" }, 403);

    const contentLength = Number(request.headers.get("content-length") ?? "0");
    if (contentLength > MAX_BODY_BYTES) return json({ error: "Payload too large" }, 413);
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return json({ error: "Engagement storage is not configured" }, 503);
    }

    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const events = parseEvents(payload);
    if (!events) return json({ error: "Invalid engagement events" }, 400);

    await updateDailyAggregate(new Date().toISOString().slice(0, 10), events);
    return json({ accepted: true, stored: true }, 202);
  },
};
