import type { FeatureCollection, MultiPolygon } from "geojson";
import type { Coord } from "@/lib/types";

/** River flood extents, gauge readings and replay levels. */
export type RiverSite = {
  usgs: string;
  lid: string;
  short: string;
  name: string;
  reach: string;
  lat: number;
  lng: number;
  report: { title: string; url: string; series: string };
  categories: { action: number; minor: number; moderate: number; major: number };
  impacts: { stage: number; statement: string }[];
  crests: { stage: number; time: string }[];
  stages: number[];
  flood: FeatureCollection<MultiPolygon, { stage: number }>;
  replays: Record<string, { start: string; hourly: (number | null)[] }>;
};
export type RiversData = {
  v: 1;
  builtAt: string;
  sites: RiverSite[];
  sources: Record<string, string>;
};

export type GaugeForecast = {
  crest: number;
  time: string;
  issued: string;
  points?: [string, number][];
};
export type GaugeReading = {
  stage: number;
  time: string;
  trend: number | null;
  forecast: GaugeForecast | null;
};
export type GaugeData = {
  fetchedAt: string;
  gauges: Record<string, GaugeReading>;
  unavailable?: boolean;
};

export const FRESH_MS = 2 * 3600000,
  STALE_MS = 24 * 3600000,
  SKEW_MS = 10 * 60000;
export type Freshness = "fresh" | "stale" | "unavailable";
export function freshness(r: GaugeReading | null | undefined, now = Date.now()): Freshness {
  if (!r || typeof r.stage !== "number" || !Number.isFinite(r.stage)) return "unavailable";
  const t = Date.parse(r.time);
  if (!Number.isFinite(t) || t > now + SKEW_MS) return "unavailable";
  return now - t <= FRESH_MS ? "fresh" : now - t <= STALE_MS ? "stale" : "unavailable";
}

type Point = { validTime: string; primary: number };
function points(data: Point[] | undefined, now: number) {
  return (data ?? [])
    .map((d) => ({ t: Date.parse(d.validTime), v: d.primary }))
    .filter(
      (d) => Number.isFinite(d.t) && typeof d.v === "number" && Number.isFinite(d.v) && d.v > -900,
    )
    .sort((a, b) => a.t - b.t)
    .filter((d) => now === Infinity || d.t <= now + SKEW_MS);
}
/** Select the latest reading and its three-hour trend. */
export function latestObservation(
  data: Point[] | undefined,
  now = Date.now(),
): { stage: number; time: string; trend: number | null } | null {
  const obs = points(data, now),
    last = obs[obs.length - 1];
  if (!last) return null;
  const target = last.t - 3 * 3600000;
  let before: { t: number; v: number } | null = null;
  for (const d of obs)
    if (
      Math.abs(d.t - target) <= 45 * 60000 &&
      (!before || Math.abs(d.t - target) < Math.abs(before.t - target))
    )
      before = d;
  return {
    stage: last.v,
    time: new Date(last.t).toISOString(),
    trend: before ? Math.round((last.v - before.v) * 100) / 100 : null,
  };
}
/** An official forecast hydrograph issued in the last 36 hours, from now on, with its crest. */
export function currentForecast(
  series: { issuedTime?: string; data?: Point[] } | undefined,
  now = Date.now(),
): GaugeForecast | null {
  const issued = Date.parse(series?.issuedTime ?? "");
  if (!Number.isFinite(issued) || issued > now + SKEW_MS || now - issued > 36 * 3600000)
    return null;
  const fc = points(series?.data, Infinity).filter(
    (d) => d.t >= now - 3600000 && d.t <= now + 7 * 864e5,
  );
  if (!fc.length) return null;
  const crest = fc.reduce((a, b) => (b.v > a.v ? b : a));
  return {
    crest: crest.v,
    time: new Date(crest.t).toISOString(),
    issued: new Date(issued).toISOString(),
    points: fc.map((d) => [new Date(d.t).toISOString(), d.v]),
  };
}
/** The forecast level at a time, interpolated between forecast points; null outside the forecast. */
export function forecastAt(f: GaugeForecast | null | undefined, t: number): number | null {
  const p = (f?.points ?? [])
    .map(([time, v]) => [Date.parse(time), v] as const)
    .filter(([x]) => Number.isFinite(x));
  if (!p.length || t < p[0][0] - 3600000 || t > p[p.length - 1][0]) return null;
  if (t <= p[0][0]) return p[0][1];
  for (let i = 1; i < p.length; i++)
    if (t <= p[i][0]) {
      const [x0, y0] = p[i - 1],
        [x1, y1] = p[i];
      return x1 === x0 ? y1 : y0 + ((y1 - y0) * (t - x0)) / (x1 - x0);
    }
  return null;
}

/** Where the maps are: around Ridgewood, Ho-Ho-Kus, Waldwick and Paramus. */
export const RIVER_BOUNDS: [number, number, number, number] = [-74.131, 40.95, -74.087, 41.016];
export const nearRivers = ({ lat, lng }: Coord, pad = 0.01) =>
  lng >= RIVER_BOUNDS[0] - pad &&
  lng <= RIVER_BOUNDS[2] + pad &&
  lat >= RIVER_BOUNDS[1] - pad &&
  lat <= RIVER_BOUNDS[3] + pad;

let pending: Promise<RiversData> | null = null;
export function loadRivers(): Promise<RiversData> {
  pending ??= fetch("/data/nj/rivers.json").then((r) => {
    if (!r.ok) throw new Error("River maps could not load.");
    return r.json() as Promise<RiversData>;
  });
  return pending.catch((error) => {
    pending = null;
    throw error;
  });
}

export type Category = "normal" | "action" | "minor" | "moderate" | "major";
/** Highest mapped stage at or below a reading. */
export function mappedStage(site: RiverSite, level: number | null): number | null {
  if (level === null || !Number.isFinite(level)) return null;
  let best: number | null = null;
  for (const s of site.stages) if (s <= level + 1e-6) best = s;
  return best;
}
/** A replay's gauge reading at an hour (the hour's highest 15-minute value). */
export function replayLevel(
  site: RiverSite,
  replay: string,
  time: string | undefined,
): number | null {
  const r = site.replays[replay];
  if (!r || !time) return null;
  const k = Math.floor((Date.parse(time) - Date.parse(r.start)) / 3600000);
  return k >= 0 && k < r.hourly.length ? r.hourly[k] : null;
}
export const feet = (v: number) => `${v.toFixed(1)} ft`;

/** Resolve the river level for one hour. */
export type RiverSource = "scenario" | "replay" | "observed" | "forecast";
export type RiverWhy = "loading" | "no-reading" | "stale" | "not-forecast";
export type RiverState = {
  lid: string;
  short: string;
  source: RiverSource | null;
  level: number | null;
  stage: number | null;
  time: string | null;
  why: RiverWhy | null;
};
export const OBSERVED_AHEAD_MS = 90 * 60000;
export function riverAt(
  site: RiverSite,
  o: {
    live: boolean;
    gauges: GaugeData | null;
    replay?: string;
    scenario: number | null;
    hourTime: string | undefined;
    now: number;
  },
): RiverState {
  const base = { lid: site.lid, short: site.short };
  if (o.scenario !== null)
    return {
      ...base,
      source: "scenario",
      level: o.scenario,
      stage: o.scenario,
      time: null,
      why: null,
    };
  if (!o.live) {
    const level = o.replay ? replayLevel(site, o.replay, o.hourTime) : null;
    return level === null
      ? {
          ...base,
          source: null,
          level: null,
          stage: null,
          time: o.hourTime ?? null,
          why: "no-reading",
        }
      : {
          ...base,
          source: "replay",
          level,
          stage: mappedStage(site, level),
          time: o.hourTime ?? null,
          why: null,
        };
  }
  if (!o.gauges)
    return { ...base, source: null, level: null, stage: null, time: null, why: "loading" };
  const g = o.gauges.gauges[site.lid],
    fresh = freshness(g, o.now),
    hour = Date.parse(o.hourTime ?? ""),
    t = Number.isFinite(hour) ? hour : o.now;
  // A reading describes the river now; it is used for the hour it falls in and the next one.
  if (fresh === "fresh" && t <= Date.parse(g.time) + OBSERVED_AHEAD_MS)
    return {
      ...base,
      source: "observed",
      level: g.stage,
      stage: mappedStage(site, g.stage),
      time: g.time,
      why: null,
    };
  const fc =
      g?.forecast && o.now - Date.parse(g.forecast.issued) <= 36 * 3600000 ? g.forecast : null,
    f = forecastAt(fc, t + 1800000);
  if (f !== null)
    return {
      ...base,
      source: "forecast",
      level: f,
      stage: mappedStage(site, f),
      time: fc!.issued,
      why: null,
    };
  return {
    ...base,
    source: null,
    level: null,
    stage: null,
    time: g?.time ?? null,
    why: fresh === "fresh" ? "not-forecast" : fresh === "stale" ? "stale" : "no-reading",
  };
}
/** The highest mapped extent at a site: everywhere its official maps can show water. */
export const maxExtent = (site: RiverSite) =>
  site.flood.features.reduce((a, b) => (b.properties.stage > a.properties.stage ? b : a));
const clockET = (t: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(t));
const dayClockET = (t: string) =>
  new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(t));
/** One line on the level used for a site at an hour, and where it comes from. */
export function riverStateText(s: RiverState, hourLabel: string, live: boolean): string {
  if (s.source === "scenario")
    return `${s.short}: scenario of ${feet(s.level!)} that you set on the river card. A what-if, not a forecast.`;
  if (s.source === "observed")
    return `${s.short}: ${feet(s.level!)}, gauge reading at ${clockET(s.time!)}.`;
  if (s.source === "forecast")
    return `${s.short}: ${feet(s.level!)} at ${hourLabel}, from the National Weather Service forecast issued ${clockET(s.time!)}.`;
  if (s.source === "replay")
    return `${s.short}: ${feet(s.level!)}, recorded by the gauge at this hour.`;
  if (s.why === "loading") return `${s.short}: loading the latest gauge reading.`;
  if (s.why === "not-forecast")
    return `${s.short}: no official forecast for ${hourLabel}. A gauge reading only describes the river now, so the level at ${hourLabel} is unknown.`;
  if (s.why === "stale")
    return `${s.short}: the latest gauge reading${s.time ? ` (${dayClockET(s.time)})` : ""} is more than 2 hours old, so the current level is unknown.`;
  return live
    ? `${s.short}: no gauge reading is available right now.`
    : `${s.short}: no gauge record for this hour.`;
}
