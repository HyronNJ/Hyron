import { readCache, writeCache } from "@/server/cache";
import { fetchJson } from "@/lib/http";
import { FORECAST_URL, parseGrid } from "@/lib/weather";
import type { WeatherGrid } from "@/lib/types";

// One statewide request (81 points) shared by every visitor, cached for 20 minutes.
const KEY = "weather-nj-v2/grid.json",
  FRESH = 20 * 60 * 1000;
async function refreshForecast(): Promise<WeatherGrid> {
  const payload = await fetchJson<Parameters<typeof parseGrid>[0]>(FORECAST_URL, 15000);
  const grid = parseGrid(payload);
  const hour = 60 * 60 * 1000;
  const now = Math.floor(Date.now() / hour) * hour;
  const current = grid.times.findIndex((time) => Date.parse(time) === now);
  if (current < 95 || current + 30 >= grid.times.length) {
    throw new Error("Outdated or incomplete forecast");
  }
  writeCache(KEY, grid);
  return grid;
}

export async function GET() {
  const cached = readCache<WeatherGrid>(KEY);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FRESH)
    return Response.json(cached, { headers: { "Cache-Control": "public, max-age=60" } });
  try {
    const result = await refreshForecast();
    return Response.json(result, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    console.warn(
      "Hyron live forecast fetch failed",
      error instanceof Error ? error.message : String(error),
    );
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 6 * 60 * 60 * 1000)
      return Response.json(
        { ...cached, stale: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(
      {
        error:
          "Live forecast is temporarily unavailable. Explore a historical storm while we reconnect.",
      },
      { status: 503 },
    );
  }
}
