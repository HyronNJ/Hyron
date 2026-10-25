import points from "@/data/weather-points.json";
import type { Coord, WeatherData, WeatherGrid } from "@/lib/types";
/** Statewide hourly weather sample points (0.2 degree grid over New Jersey). */
export const WEATHER_POINTS: Coord[] = (points as [number, number][]).map(([lat, lng]) => ({
  lat,
  lng,
}));
const HOURLY =
  "hourly=precipitation,temperature_2m,precipitation_probability&past_days=7&forecast_days=3&timezone=GMT";
export const FORECAST_URL = `https://api.open-meteo.com/v1/forecast?latitude=${WEATHER_POINTS.map((p) => p.lat).join(",")}&longitude=${WEATHER_POINTS.map((p) => p.lng).join(",")}&${HOURLY}`;
type HourlyPayload = {
  hourly?: {
    time?: string[];
    precipitation?: (number | null)[];
    temperature_2m?: (number | null)[];
    precipitation_probability?: (number | null)[];
  };
};
export function parseForecast(data: HourlyPayload, lat = 40.9, lng = -74.06): WeatherData {
  const h = data.hourly;
  if (
    !h?.time ||
    !h.precipitation ||
    !h.temperature_2m ||
    !h.precipitation_probability ||
    h.time.length > 240
  )
    throw new Error("Incomplete hourly forecast");
  const result: WeatherData = {
    fetchedAt: new Date().toISOString(),
    source: "Open-Meteo hourly forecast",
    sourceUrl: "https://open-meteo.com/en/docs",
    stale: false,
    location: { lat, lng },
    mode: "live",
    hours: [],
  };
  for (let i = 0; i < h.time.length; i++) {
    const rain = h.precipitation[i],
      temperature = h.temperature_2m[i],
      probability = h.precipitation_probability[i];
    const time = h.time[i] + ":00Z";
    if (
      rain === null ||
      temperature === null ||
      !Number.isFinite(rain) ||
      !Number.isFinite(temperature) ||
      Number(rain) < 0 ||
      !Number.isFinite(Date.parse(time))
    )
      continue;
    result.hours.push({
      time,
      rain: rain!,
      temperature: temperature!,
      probability:
        typeof probability === "number" && probability >= 0 && probability <= 100
          ? probability
          : null,
      soilMoisture: null,
    });
  }
  if (
    result.hours.length < 126 ||
    result.hours.some(
      (h, i) => i > 0 && Date.parse(h.time) - Date.parse(result.hours[i - 1].time) !== 3600000,
    )
  )
    throw new Error("Incomplete hourly forecast");
  return result;
}
/** Parse a multi-location Open-Meteo response into one grid on a shared hourly time axis. */
export function parseGrid(data: HourlyPayload | HourlyPayload[]): WeatherGrid {
  const list = Array.isArray(data) ? data : [data];
  if (list.length !== WEATHER_POINTS.length) throw new Error("Incomplete statewide forecast");
  const parsed = list.map((d, i) => parseForecast(d, WEATHER_POINTS[i].lat, WEATHER_POINTS[i].lng));
  const times = parsed[0].hours.map((h) => h.time);
  for (const p of parsed)
    if (p.hours.length !== times.length || p.hours.some((h, i) => h.time !== times[i]))
      throw new Error("Statewide forecast hours do not line up");
  return {
    points: WEATHER_POINTS,
    times,
    series: parsed.map((p) => ({
      rain: p.hours.map((h) => h.rain),
      temperature: p.hours.map((h) => h.temperature),
      probability: p.hours.map((h) => h.probability),
    })),
    fetchedAt: parsed[0].fetchedAt,
    source: "Open-Meteo hourly forecast",
    sourceUrl: "https://open-meteo.com/en/docs",
    stale: false,
    mode: "live",
  };
}
export async function loadLiveWeather(refresh: number, signal: AbortSignal): Promise<WeatherGrid> {
  try {
    const r = await fetch(`/api/weather?refresh=${refresh}`, { signal });
    if (!r.ok) throw new Error("Shared weather service unavailable");
    return (await r.json()) as WeatherGrid;
  } catch (error) {
    if (signal.aborted) throw error;
    // Fall back to a direct request when the proxy is throttled.
    const fallback = new AbortController();
    const cancel = () => fallback.abort();
    signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(cancel, 15000);
    try {
      const r = await fetch(FORECAST_URL, { signal: fallback.signal });
      if (!r.ok) throw new Error("Provider unavailable");
      const result = parseGrid(await r.json());
      const now = Math.floor(Date.now() / 3600000) * 3600000;
      const current = result.times.findIndex((t) => Date.parse(t) === now);
      if (current < 71 || current + 30 >= result.times.length)
        throw new Error("Outdated or incomplete forecast");
      return result;
    } catch (error) {
      if (signal.aborted) throw error;
      throw new Error(
        "Live forecast is temporarily unavailable. Explore a storm replay while we reconnect.",
      );
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    }
  }
}
