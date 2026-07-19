interface OpenMeteoCurrent {
  readonly time?: unknown;
  readonly temperature_2m?: unknown;
  readonly relative_humidity_2m?: unknown;
  readonly dew_point_2m?: unknown;
  readonly precipitation?: unknown;
  readonly rain?: unknown;
  readonly snowfall?: unknown;
  readonly weather_code?: unknown;
  readonly cloud_cover?: unknown;
  readonly is_day?: unknown;
}

interface OpenMeteoResponse {
  readonly current?: OpenMeteoCurrent;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function coordinate(request: Request, header: string, minimum: number, maximum: number): number | null {
  const value = Number(request.headers.get(header));
  return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      // The browser may reuse its own nearby reading, but shared edge caches
      // must never serve one visitor's local weather to another visitor.
      "cache-control": "private, max-age=600, stale-while-revalidate=1800",
    },
  });
}

export default {
  async fetch(request: Request): Promise<Response> {
    if (request.method !== "GET") {
      return json({ error: "Method not allowed" }, 405);
    }

    // Vercel derives these coarse coordinates from the incoming IP. They stay
    // server-side: the habitat receives conditions only, never a location.
    const latitude = coordinate(request, "x-vercel-ip-latitude", -90, 90);
    const longitude = coordinate(request, "x-vercel-ip-longitude", -180, 180);
    if (latitude === null || longitude === null) {
      return json({ available: false });
    }

    const endpoint = new URL("https://api.open-meteo.com/v1/forecast");
    endpoint.searchParams.set("latitude", latitude.toFixed(2));
    endpoint.searchParams.set("longitude", longitude.toFixed(2));
    endpoint.searchParams.set(
      "current",
      [
        "temperature_2m",
        "relative_humidity_2m",
        "dew_point_2m",
        "precipitation",
        "rain",
        "snowfall",
        "weather_code",
        "cloud_cover",
        "is_day",
      ].join(","),
    );
    endpoint.searchParams.set("forecast_days", "1");

    try {
      const response = await fetch(endpoint, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(4_500),
      });
      if (!response.ok) return json({ available: false }, 502);

      const payload = await response.json() as OpenMeteoResponse;
      const current = payload.current;
      if (!current) return json({ available: false }, 502);

      const temperature = finite(current.temperature_2m);
      const humidity = finite(current.relative_humidity_2m);
      const dewPoint = finite(current.dew_point_2m);
      const precipitation = finite(current.precipitation);
      const rain = finite(current.rain);
      const snowfall = finite(current.snowfall);
      const weatherCode = finite(current.weather_code);
      const cloudCover = finite(current.cloud_cover);
      const isDay = finite(current.is_day);
      if (
        temperature === null ||
        humidity === null ||
        dewPoint === null ||
        precipitation === null ||
        rain === null ||
        snowfall === null ||
        weatherCode === null ||
        cloudCover === null ||
        isDay === null
      ) {
        return json({ available: false }, 502);
      }

      return json({
        available: true,
        observedAt: typeof current.time === "string" ? current.time : null,
        temperature,
        humidity: Math.min(100, Math.max(0, humidity)),
        dewPoint,
        precipitation: Math.max(0, precipitation),
        rain: Math.max(0, rain),
        snowfall: Math.max(0, snowfall),
        weatherCode: Math.round(weatherCode),
        cloudCover: Math.min(100, Math.max(0, cloudCover)),
        isDay: isDay >= 0.5,
      });
    } catch {
      return json({ available: false }, 502);
    }
  },
};
