import { readCache, writeCache } from "@/server/cache";
import { fetchJson } from "@/lib/http";
import {
  currentForecast,
  freshness,
  latestObservation,
  type GaugeData,
  type GaugeReading,
} from "@/lib/rivers";

const GAUGES = [
  { lid: "HOHN4", usgs: "01391000" },
  { lid: "RWDN4", usgs: "01390500" },
];
const KEY = "gauges-ridgewood-v2.json",
  FRESH = 10 * 60 * 1000;
type Series = { issuedTime?: string; data?: { validTime: string; primary: number }[] };
type StageFlow = { observed?: Series; forecast?: Series };

async function nwps(lid: string): Promise<GaugeReading> {
  // National Water Prediction Service: observed gauge height and, during events, an official forecast.
  const sf = await fetchJson<StageFlow>(
    `https://api.water.noaa.gov/nwps/v1/gauges/${lid}/stageflow`,
    10000,
  );
  const now = Date.now(),
    last = latestObservation(sf.observed?.data, now);
  if (!last) throw new Error("No observations");
  return { ...last, forecast: currentForecast(sf.forecast, now) };
}
async function usgs(site: string): Promise<GaugeReading> {
  // Fallback: the latest USGS reading only.
  const d = await fetchJson<{ features: { properties: { time: string; value: string } }[] }>(
    `https://api.waterdata.usgs.gov/ogcapi/v0/collections/latest-continuous/items?monitoring_location_id=USGS-${site}&parameter_code=00065&f=json`,
    10000,
  );
  const last = latestObservation(
    (d.features ?? []).map((f) => ({
      validTime: f.properties?.time,
      primary: Number(f.properties?.value),
    })),
  );
  if (!last) throw new Error("No observations");
  return { ...last, trend: null, forecast: null };
}
/** Choose the freshest reading and retain the NWS forecast. */
async function reading(g: { lid: string; usgs: string }): Promise<GaugeReading> {
  const a = await nwps(g.lid).catch(() => null);
  if (a && freshness(a) === "fresh") return a;
  const b = await usgs(g.usgs).catch(() => null);
  if (!a && !b) throw new Error("No observations");
  if (!a) return b!;
  if (!b || Date.parse(a.time) >= Date.parse(b.time)) return a;
  return { ...b, forecast: a.forecast };
}
export async function GET() {
  const cached = readCache<GaugeData>(KEY);
  if (cached && Date.now() - Date.parse(cached.fetchedAt) < FRESH)
    return Response.json(cached, { headers: { "Cache-Control": "public, max-age=120" } });
  const gauges: Record<string, GaugeReading> = {};

  await Promise.all(
    GAUGES.map(async (g) => {
      try {
        gauges[g.lid] = await reading(g);
      } catch {
        if (cached?.gauges[g.lid]) gauges[g.lid] = cached.gauges[g.lid];
      }
    }),
  );
  if (!Object.keys(gauges).length) {
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < 6 * 3600000)
      return Response.json(
        { ...cached, unavailable: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    return Response.json(
      { fetchedAt: new Date().toISOString(), gauges: {}, unavailable: true } satisfies GaugeData,
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const result: GaugeData = { fetchedAt: new Date().toISOString(), gauges };
  writeCache(KEY, result);
  return Response.json(result, { headers: { "Cache-Control": "public, max-age=120" } });
}
