import { get, list, type ListBlobResultBlob } from "@vercel/blob";
import {
  createEmptyEngagementCounts,
  ENGAGEMENT_EVENT_SET,
  type EngagementCounts,
  type EngagementEvent,
} from "../src/analytics/engagementEvents.js";

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
    headers: { "cache-control": "private, no-store", ...headers },
  });
}

function tokensMatch(actual: string, expected: string): boolean {
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let i = 0; i < actual.length; i += 1) {
    difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return difference === 0;
}

function authorized(request: Request): boolean {
  const expected = process.env.ANALYTICS_ADMIN_TOKEN;
  const header = request.headers.get("authorization");
  if (!expected || !header?.startsWith("Bearer ")) return false;
  return tokensMatch(header.slice(7), expected);
}

function parseAggregate(value: unknown): DailyAggregate | null {
  if (!value || typeof value !== "object") return null;
  const aggregate = value as Partial<DailyAggregate>;
  if (
    aggregate.version !== 1 ||
    typeof aggregate.date !== "string" ||
    typeof aggregate.updatedAt !== "string" ||
    typeof aggregate.batches !== "number" ||
    !aggregate.counts ||
    typeof aggregate.counts !== "object"
  ) {
    return null;
  }
  const counts = createEmptyEngagementCounts();
  for (const event of Object.keys(counts) as EngagementEvent[]) {
    const count = aggregate.counts[event];
    if (!Number.isSafeInteger(count) || count < 0 || !ENGAGEMENT_EVENT_SET.has(event)) return null;
    counts[event] = count;
  }
  return { ...aggregate, counts } as DailyAggregate;
}

async function readAggregate(blob: ListBlobResultBlob): Promise<DailyAggregate | null> {
  try {
    const result = await get(blob.pathname, { access: "private", useCache: false });
    if (!result || result.statusCode !== 200) return null;
    const raw = await new Response(result.stream).json() as unknown;
    return parseAggregate(raw);
  } catch {
    return null;
  }
}

async function listDailyBlobs(): Promise<ListBlobResultBlob[]> {
  const blobs: ListBlobResultBlob[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: "analytics/daily/", limit: 1_000, cursor });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor && blobs.length < 1_000);
  return blobs;
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405, { allow: "GET" });
    }
    if (!process.env.ANALYTICS_ADMIN_TOKEN) {
      return json({ error: "ANALYTICS_ADMIN_TOKEN is not configured" }, 503);
    }
    if (!authorized(request)) {
      return json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" });
    }
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      return json({ error: "Engagement storage is not configured" }, 503);
    }

    const url = new URL(request.url);
    const requestedDays = Number.parseInt(url.searchParams.get("days") ?? "30", 10);
    const days = Number.isFinite(requestedDays)
      ? Math.max(1, Math.min(90, requestedDays))
      : 30;
    const start = new Date();
    start.setUTCHours(0, 0, 0, 0);
    start.setUTCDate(start.getUTCDate() - days + 1);
    const firstDate = start.toISOString().slice(0, 10);

    const blobs = (await listDailyBlobs()).filter((blob) => {
      const match = /analytics\/daily\/(\d{4}-\d{2}-\d{2})\.json$/.exec(blob.pathname);
      return match ? match[1] >= firstDate : false;
    });
    const aggregates = (await Promise.all(blobs.map(readAggregate)))
      .filter((value): value is DailyAggregate => value !== null)
      .sort((left, right) => left.date.localeCompare(right.date));

    const totals = createEmptyEngagementCounts();
    let batches = 0;
    for (const aggregate of aggregates) {
      batches += aggregate.batches;
      for (const event of Object.keys(totals) as EngagementEvent[]) {
        totals[event] += aggregate.counts[event];
      }
    }

    return json({
      generatedAt: new Date().toISOString(),
      range: { days, from: firstDate },
      batches,
      totals,
      daily: aggregates.map(({ date, counts }) => ({ date, counts })),
    });
  },
};
