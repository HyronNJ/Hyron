import type { Feature, LineString, MultiPolygon, Polygon } from "geojson";
import type { Coord, PublicPin } from "@/lib/types";
import { distance, levelRank, pinFade } from "@/lib/community";

/** Check route samples against conditions at arrival time. */
export type TravelMode = "auto" | "pedestrian";
export type RawRoute = { coords: [number, number][]; seconds: number; meters: number };
export type FlagKind = "report" | "river" | "signal-low" | "crossing" | "signal" | "low";
export type Flag = {
  kind: FlagKind;
  severity: 3 | 2 | 1;
  title: string;
  detail: string;
  at: [number, number];
  from: number;
  to: number;
  end?: "start" | "destination";
  active: boolean;
  hard: boolean;
};
/** Rain at a point (mm) in the hour being checked, the 3 hours and the 24 hours ending then. */
export type Rain = { last1: number; last3: number; last24: number };
/** Rainfall and signal thresholds for terrain flags. */
export const ACTIVE = {
  lowLast3: 6,
  lowLast1: 4,
  lowSignal: 15,
  crossingLast24: 20,
  crossingLast3: 12,
  crossingSignal: 38,
};
export const lowActive = (r: Rain | null, s: number | null) =>
  !r || (s ?? 0) >= ACTIVE.lowSignal || r.last3 >= ACTIVE.lowLast3 || r.last1 >= ACTIVE.lowLast1;
export const crossingActive = (r: Rain | null, s: number | null, riverHigh: boolean) =>
  !r ||
  riverHigh ||
  (s ?? 0) >= ACTIVE.crossingSignal ||
  r.last24 >= ACTIVE.crossingLast24 ||
  r.last3 >= ACTIVE.crossingLast3;
const inches = (mm: number) =>
  mm < 1.3 ? (mm < 0.25 ? "0 in" : "<0.05 in") : `${(mm / 25.4).toFixed(2)} in`;
/** Reasons a route sample is unchecked. */
export type Gap = "pending" | "failed" | "beyond" | "outside" | "river";
export type Coverage = {
  total: number;
  checked: number;
  gaps: Record<Gap, number>;
  reports: "ok" | "pending" | "failed";
  stretches: { from: number; to: number; why: Gap }[];
};
export type CheckStatus = "checking" | "complete" | "partial" | "unavailable";
export type CheckedRoute = RawRoute & {
  id: string;
  flags: Flag[];
  hard: number;
  high: number;
  medium: number;
  quiet: number;
  cost: number;
  detour?: boolean;
  coverage: Coverage;
  status: CheckStatus;
  points: [number, number][];
  rain: Rain | null;
  hours: number[];
  exposureMeters?: number;
  checkedMeters?: number;
};

const VALHALLA = "https://valhalla1.openstreetmap.de/route";
let lastCall = 0;
/** At most one routing request a second (FOSSGIS terms). */
async function throttle() {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
}

/** Valhalla's encoded polyline with 6 decimal places, to [lng, lat] pairs. */
export function decodePolyline6(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0,
    lat = 0,
    lng = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let shift = 0,
        result = 0,
        b: number;
      do {
        b = s.charCodeAt(i++) - 63;
        result |= (b & 31) << shift;
        shift += 5;
      } while (b >= 32 && i < s.length + 1);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d;
      else lng += d;
    }
    out.push([lng / 1e6, lat / 1e6]);
  }
  return out;
}
type ValhallaTrip = {
  trip: { legs: { shape: string }[]; summary: { time: number; length: number } };
};
export async function fetchRoutes(
  from: Coord,
  to: Coord,
  mode: TravelMode,
  avoid: [number, number][][] = [],
  alternates = 2,
  signal?: AbortSignal,
): Promise<RawRoute[]> {
  await throttle();
  const body = {
    locations: [
      { lat: from.lat, lon: from.lng },
      { lat: to.lat, lon: to.lng },
    ],
    costing: mode,
    alternates,
    directions_type: "none",
    units: "kilometers",
    ...(avoid.length ? { exclude_polygons: avoid } : {}),
  };
  const r = await fetch(`${VALHALLA}?json=${encodeURIComponent(JSON.stringify(body))}`, { signal });
  if (!r.ok) {
    const e = (await r.json().catch(() => null)) as { error?: string; error_code?: number } | null;
    throw new Error(
      e?.error_code === 442 || e?.error_code === 171
        ? "No route found between these places."
        : "Routing is unavailable right now. Try again in a minute.",
    );
  }
  const d = (await r.json()) as ValhallaTrip & { alternates?: ValhallaTrip[] };
  return [d, ...(d.alternates ?? [])].map((t) => ({
    coords: t.trip.legs.flatMap((l, i) => decodePolyline6(l.shape).slice(i ? 1 : 0)),
    seconds: t.trip.summary.time,
    meters: t.trip.summary.length * 1000,
  }));
}

/** Points every `step` meters along a line, with their distance from the start. */
export function sample(
  coords: [number, number][],
  step = 40,
): { p: [number, number]; m: number }[] {
  const out: { p: [number, number]; m: number }[] = [];
  let walked = 0,
    next = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1],
      b = coords[i],
      len = distance({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
    while (next <= walked + len) {
      const t = len ? (next - walked) / len : 0;
      out.push({ p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], m: next });
      next += step;
    }
    walked += len;
  }
  const last = coords[coords.length - 1];
  if (last && (!out.length || out[out.length - 1].m < walked - 5)) out.push({ p: last, m: walked });
  return out;
}

function inRing([x, y]: [number, number], ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
export function inPolygon(p: [number, number], g: Polygon | MultiPolygon): boolean {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  return polys.some((poly) => inRing(p, poly[0]) && !poly.slice(1).some((h) => inRing(p, h)));
}
function bbox(g: Polygon | MultiPolygon): [number, number, number, number] {
  const b: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const poly of g.type === "Polygon" ? [g.coordinates] : g.coordinates)
    for (const [x, y] of poly[0]) {
      b[0] = Math.min(b[0], x);
      b[1] = Math.min(b[1], y);
      b[2] = Math.max(b[2], x);
      b[3] = Math.max(b[3], y);
    }
  return b;
}
export type Indexed<T> = { f: T; b: [number, number, number, number] }[];
export const indexPolygons = <T extends Feature<Polygon | MultiPolygon>>(fs: T[]): Indexed<T> =>
  fs.map((f) => ({ f, b: bbox(f.geometry) }));
const inside = <T extends Feature<Polygon | MultiPolygon>>(
  { f, b }: Indexed<T>[number],
  p: [number, number],
) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3] && inPolygon(p, f.geometry);
const hit = <T extends Feature<Polygon | MultiPolygon>>(idx: Indexed<T>, p: [number, number]) =>
  idx.find((x) => inside(x, p))?.f ?? null;
/** Every feature containing the point, for overlapping areas that can say different things. */
const hits = <T extends Feature<Polygon | MultiPolygon>>(idx: Indexed<T>, p: [number, number]) =>
  idx.filter((x) => inside(x, p)).map((x) => x.f);
/** The most serious of several reports, the newest among equals. */
const worst = (ps: PublicPin[]) =>
  ps.reduce<PublicPin | null>(
    (m, x) =>
      !m ||
      levelRank(x.waterLevel) > levelRank(m.waterLevel) ||
      (levelRank(x.waterLevel) === levelRank(m.waterLevel) &&
        Date.parse(x.createdAt) > Date.parse(m.createdAt))
        ? x
        : m,
    null,
  );
/** True if segment ab crosses segment cd. */
function crosses(a: number[], b: number[], c: number[], d: number[]) {
  const o = (p: number[], q: number[], r: number[]) =>
    Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  return o(a, b, c) !== o(a, b, d) && o(c, d, a) !== o(c, d, b);
}

type RiverProps = {
  stage: number;
  site: string;
  lid: string;
  source: string;
  level: number;
  when?: string;
  readAt?: string;
};
/** River extents and level availability for one hour. */
export type RiverHour = {
  flood: Indexed<Feature<MultiPolygon, RiverProps>>;
  unknown: Indexed<Feature<MultiPolygon, { pending: boolean }>>;
  high: Indexed<Feature<MultiPolygon>>;
};
export type Context = {
  /** Flood signal score (0-100) at a point for a timeline hour, or why it's unknown. */
  signal: (p: [number, number], hour: number) => number | Gap;
  /** Rain at a point for a timeline hour, or null when the weather isn't available. */
  rain: (p: [number, number], hour: number) => Rain | null;
  /** Departure: the timeline hour, seconds already past its start, and the last hour with data. */
  depart: { hour: number; offset: number; last: number };
  /** Whether the "Where water goes" tile for a point loaded (true), or why not. */
  terrain: (p: [number, number]) => true | Gap;
  spots: Indexed<Feature<Polygon, { k: number }>>;
  streams: Feature<LineString, { c: number }>[];
  /** Brook and river conditions for a timeline hour (the hour each point is reached). */
  river: (hour: number) => RiverHour;
  /** Neighbor reports, or whether they are still loading or failed to load. */
  pins: PublicPin[] | "pending" | "failed";
  now: number;
  hourLabel: string;
  riverLabel: (f: Feature<MultiPolygon, RiverProps>, at: [number, number]) => string;
};
const FLAG_INFO: Record<FlagKind, { severity: 3 | 2 | 1; title: string }> = {
  report: { severity: 3, title: "Reported flooding" },
  river: { severity: 3, title: "Flood-map overlap" },
  "signal-low": { severity: 3, title: "Elevated risk · low ground" },
  crossing: { severity: 2, title: "Stream crossing" },
  signal: { severity: 2, title: "Elevated flood risk" },
  low: { severity: 1, title: "Low spot" },
};
const GAP_ORDER: Gap[] = ["pending", "failed", "beyond", "outside", "river"];

/** Check and merge hazards along a sampled route. */
export function checkRoute(
  route: RawRoute,
  ctx: Context,
): { flags: Flag[]; coverage: Coverage; rain: Rain | null; hours: number[] } {
  const pts = sample(route.coords),
    raw: {
      kind: FlagKind;
      detail: string;
      title?: string;
      i: number;
      active: boolean;
      hard: boolean;
    }[] = [];
  const pins = Array.isArray(ctx.pins)
    ? ctx.pins.filter((p) => p.category === "Street flooding" && pinFade(p.createdAt, ctx.now) > 0)
    : [];
  const gaps: Record<Gap, number> = { pending: 0, failed: 0, beyond: 0, outside: 0, river: 0 },
    missing: (Gap | null)[] = [];
  const total = pts.length ? pts[pts.length - 1].m : 0;
  // Use each sample's arrival hour.
  const hours = pts.map(
    ({ m }) =>
      ctx.depart.hour +
      Math.floor((ctx.depart.offset + (total ? (route.seconds * m) / total : 0)) / 3600),
  );
  const beyond = (i: number) => hours[i] > ctx.depart.last;
  const riverCache = new Map<number, RiverHour>(),
    riverAt = (h: number) => {
      let r = riverCache.get(h);
      if (!r) riverCache.set(h, (r = ctx.river(h)));
      return r;
    };
  const rains = pts.map(({ p }, i) => (beyond(i) ? null : ctx.rain(p, hours[i]))),
    scores = pts.map(({ p }, i): number | Gap => (beyond(i) ? "beyond" : ctx.signal(p, hours[i])));
  let wettest: Rain | null = null;
  for (const r of rains)
    if (
      r &&
      (!wettest ||
        r.last3 > wettest.last3 ||
        (r.last3 === wettest.last3 && r.last24 > wettest.last24))
    )
      wettest = r;
  pts.forEach(({ p }, i) => {
    const here = { lng: p[0], lat: p[1] },
      s = scores[i],
      t = ctx.terrain(p),
      rh = beyond(i) ? null : riverAt(hours[i]),
      unknownRiver = rh ? hits(rh.unknown, p) : [],
      rain = rains[i];

    const why =
      GAP_ORDER.find(
        (g) =>
          s === g ||
          t === g ||
          (g === "river" && unknownRiver.length > 0) ||
          (g === "pending" && unknownRiver.some((f) => f.properties.pending)),
      ) ?? null;
    missing.push(why);
    if (why) gaps[why]++;
    // Prefer a closed low spot over nearby low ground.
    const spots = t === true && rh ? hits(ctx.spots, p) : [],
      score = typeof s === "number" ? s : null,
      spot = spots.find((f) => f.properties.k === 1) ?? spots[0] ?? null;
    // Keep the strongest nearby hazard.
    const pin = worst(pins.filter((x) => distance(x, here) <= 70));
    if (pin) {
      const blocked = levelRank(pin.waterLevel) >= 4;
      raw.push({
        kind: "report",
        title: blocked ? "Reported impassable" : undefined,
        detail: blocked
          ? "Neighbor report · impassable · past 24 h"
          : levelRank(pin.waterLevel) >= 3
            ? "Neighbor report · water covering a lane"
            : "Neighbor report · past 24 h",
        i,
        active: true,
        hard: blocked,
      });
    }
    if (!rh) return; // beyond the data: unchecked, nothing more to say
    const rv = hit(rh.flood, p);
    if (rv) {
      raw.push({
        kind: "river",
        detail: ctx.riverLabel(rv, p),
        title: rv.properties.source === "scenario" ? "Flood-map overlap · scenario" : undefined,
        i,
        active: true,
        hard: true,
      });
      return;
    } // hard: nothing softer here matters
    if (spot && score !== null && score >= 38) {
      raw.push({
        kind: "signal-low",
        detail: `${score >= 65 ? "High" : "Moderate"} risk · ${spot.properties.k === 1 ? "low spot" : "streamside low ground"} · ${ctx.hourLabel}`,
        i,
        active: true,
        hard: false,
      });
      return;
    }
    if (score !== null && score >= 38)
      raw.push({
        kind: "signal",
        detail: `${score >= 65 ? "High" : "Moderate"} risk · ${ctx.hourLabel}`,
        i,
        active: true,
        hard: false,
      });
    else if (spot?.properties.k === 1) {
      const active = lowActive(rain, score);
      raw.push({
        kind: "low",
        active,
        hard: false,
        i,
        detail: active
          ? `Closed depression${rain ? ` · 3 h rain: ${inches(rain.last3)}` : " · rain unavailable"}`
          : `Quiet now · 3 h rain: ${inches(rain!.last3)}`,
      });
    }
  });
  // Stream crossings: where the route meets a stream or drainage channel (25 ha or more upstream).
  for (let i = 1; i < pts.length; i++) {
    if (beyond(i)) continue;
    const a = pts[i - 1].p,
      b = pts[i].p;
    for (const s of ctx.streams) {
      const c = s.geometry.coordinates;
      let found = false;
      for (let k = 1; k < c.length && !found; k++) if (crosses(a, b, c[k - 1], c[k])) found = true;
      if (!found) continue;
      const rain = rains[i],
        score = typeof scores[i] === "number" ? (scores[i] as number) : null,
        high = !!hit(riverAt(hours[i]).high, b),
        active = crossingActive(rain, score, high);
      const what = s.properties.c === 3 ? "Stream" : "Drainage channel";
      raw.push({
        kind: "crossing",
        active,
        hard: false,
        i,
        detail: active
          ? `${what}${high ? " · gauge at action stage or above" : rain ? ` · 24 h rain: ${inches(rain.last24)}` : " · rain unavailable"}`
          : `${what} · Quiet now · 24 h rain: ${inches(rain!.last24)}`,
      });
      break;
    }
  }
  raw.sort((x, y) => x.i - y.i);
  // Merge nearby flags by severity.
  const flags: Flag[] = [],
    weight = (hard: boolean, active: boolean, sev: number) =>
      (hard ? 20 : 0) + (active ? 10 : 0) + sev;
  for (const r of raw) {
    const info = FLAG_INFO[r.kind],
      last = flags[flags.length - 1],
      title = r.title ?? info.title;
    if (last && r.i - last.to <= 3) {
      last.to = r.i;
      const w = weight(r.hard, r.active, info.severity),
        lw = weight(last.hard, last.active, last.severity);
      if (w > lw || (w === lw && r.kind !== last.kind && r.kind === "report"))
        Object.assign(last, {
          kind: r.kind,
          severity: info.severity,
          title,
          detail: r.detail,
          at: pts[r.i].p,
          active: r.active,
          hard: r.hard,
        });
      continue;
    }
    flags.push({
      kind: r.kind,
      severity: info.severity,
      title,
      detail: r.detail,
      at: pts[r.i].p,
      from: r.i,
      to: r.i,
      active: r.active,
      hard: r.hard,
    });
  }
  // Mark hazards at route endpoints.
  for (const f of flags) {
    if (f.to >= pts.length - 3) {
      f.end = "destination";
      f.title = `At your destination: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`;
    } else if (f.from <= 2) {
      f.end = "start";
      f.title = `At your start: ${f.title.charAt(0).toLowerCase()}${f.title.slice(1)}`;
    }
  }
  // Unchecked stretches, for the map.
  const stretches: Coverage["stretches"] = [];
  missing.forEach((why, i) => {
    const last = stretches[stretches.length - 1];
    if (!why) return;
    if (last && last.why === why && last.to === i - 1) last.to = i;
    else stretches.push({ from: i, to: i, why });
  });
  const reports = Array.isArray(ctx.pins) ? "ok" : ctx.pins;
  return {
    flags,
    coverage: {
      total: pts.length,
      checked: missing.filter((m) => !m).length,
      gaps,
      reports,
      stretches,
    },
    rain: wettest,
    hours: [...new Set(hours.filter((_, i) => !beyond(i)))].sort((x, y) => x - y),
  };
}

export function statusOf(c: Coverage): CheckStatus {
  if (c.gaps.pending || c.reports === "pending") return "checking";
  if (c.checked === c.total && c.reports === "ok") return "complete";
  return c.checked === 0 ? "unavailable" : "partial";
}
/** Detour penalties in seconds, by severity. */
export const DETOUR_SECONDS: Record<1 | 2 | 3, number> = { 3: 900, 2: 300, 1: 120 };
export function summarizeRoute(
  route: RawRoute,
  result: { flags: Flag[]; coverage: Coverage; rain?: Rain | null; hours?: number[] },
  id: string,
  detour = false,
): CheckedRoute {
  const { flags, coverage } = result,
    soft = flags.filter((f) => f.active && !f.hard);
  const cost =
    route.seconds + soft.filter((f) => !f.end).reduce((t, f) => t + DETOUR_SECONDS[f.severity], 0);
  return {
    ...route,
    id,
    flags,
    coverage,
    status: statusOf(coverage),
    points: sample(route.coords).map((s) => s.p),
    hard: flags.filter((f) => f.hard).length,
    high: soft.filter((f) => f.severity === 3).length,
    medium: soft.filter((f) => f.severity === 2).length,
    quiet: flags.filter((f) => !f.active).length,
    cost,
    detour,
    rain: result.rain ?? null,
    hours: result.hours ?? [],
  };
}
const ORDER: Record<CheckStatus, number> = { complete: 0, partial: 1, checking: 2, unavailable: 3 };
/** Rank routes by hazards, coverage and cost. */
export const rank = (a: CheckedRoute, b: CheckedRoute) =>
  Number(a.hard > 0) - Number(b.hard > 0) ||
  ORDER[a.status] - ORDER[b.status] ||
  a.cost - b.cost ||
  a.seconds - b.seconds;
/** Choose a route or return the blocking reason. */
export function recommend(routes: CheckedRoute[]): {
  route: CheckedRoute | null;
  why: "hard" | "checking" | "unchecked" | null;
} {
  const sorted = [...routes].sort(rank);
  if (sorted.some((r) => r.status === "checking")) return { route: null, why: "checking" };
  const ok = sorted.find(
    (r) => r.hard === 0 && (r.status === "complete" || r.status === "partial"),
  );
  if (ok) return { route: ok, why: null };
  return {
    route: null,
    why: sorted.length && sorted.every((r) => r.hard > 0) ? "hard" : "unchecked",
  };
}
/** Share of the route checked, as a whole percent, never rounded up to 100 unless it is complete. */
export const checkedShare = (c: Coverage) =>
  c.checked === c.total ? 100 : Math.min(99, Math.round((100 * c.checked) / Math.max(1, c.total)));
/** Small squares (about 120 m) around flagged spots, for asking the router to go around them. */
export function avoidAround(flags: Flag[], limit = 12): [number, number][][] {
  return flags
    .filter((f) => f.active && f.severity >= 2 && !f.end)
    .slice(0, limit)
    .map(({ at: [x, y] }) => {
      const dy = 0.00055,
        dx = dy / Math.cos((y * Math.PI) / 180);
      return [
        [x - dx, y - dy],
        [x + dx, y - dy],
        [x + dx, y + dy],
        [x - dx, y + dy],
        [x - dx, y - dy],
      ];
    });
}
export const minutes = (s: number) =>
  s < 3600
    ? `${Math.max(1, Math.round(s / 60))} min`
    : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
export const kmOrMiles = (m: number, units: "imperial" | "metric") =>
  units === "imperial"
    ? `${(m / 1609.34).toFixed(m < 16000 ? 1 : 0)} mi`
    : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;

/** Persistent exposure along a route, sampled every 40 m; this does not describe current flooding. */
export function checkSusceptibilityRoute(
  route: RawRoute,
  signal: (point: [number, number]) => number | Gap,
  terrain: (point: [number, number]) => true | Gap,
  id: string,
): CheckedRoute {
  const points = sample(route.coords);
  const gaps: Coverage["gaps"] = { pending: 0, failed: 0, beyond: 0, outside: 0, river: 0 };
  const stretches: Coverage["stretches"] = [];
  const flags: Flag[] = [];
  let checked = 0;
  let exposureMeters = 0;
  let checkedMeters = 0;
  const geometryMeters = points[points.length - 1]?.m ?? 0;
  const lengthScale = geometryMeters > 0 ? route.meters / geometryMeters : 0;
  for (let i = 0; i < points.length; i++) {
    const { p, m } = points[i];
    const score = signal(p);
    const ground = terrain(p);
    const gap = GAP_ORDER.find((reason) => score === reason || ground === reason);
    if (gap) {
      gaps[gap] += 1;
      const previous = stretches[stretches.length - 1];
      if (previous && previous.why === gap && previous.to === i - 1) previous.to = i;
      else stretches.push({ from: i, to: i, why: gap });
      continue;
    }
    checked += 1;
    const length = i > 0 ? (m - points[i - 1].m) * lengthScale : 0;
    checkedMeters += length;
    if (typeof score !== "number" || score < 38) continue;
    exposureMeters += length;
    const previous = flags[flags.length - 1];
    if (previous && previous.to === i - 1) {
      previous.to = i;
      if (score >= 65 && previous.severity < 3) {
        previous.severity = 3;
        previous.detail = "High susceptibility";
        previous.at = p;
      }
      continue;
    }
    flags.push({
      kind: "signal",
      severity: score >= 65 ? 3 : 2,
      title: "Flood exposure",
      detail: score >= 65 ? "High susceptibility" : "Elevated susceptibility",
      at: p,
      from: i,
      to: i,
      active: true,
      hard: false,
    });
  }
  for (const flag of flags) {
    if (flag.to >= points.length - 3) flag.end = "destination";
    else if (flag.from <= 2) flag.end = "start";
  }
  const coverage: Coverage = { total: points.length, checked, gaps, reports: "ok", stretches };
  return {
    ...route,
    id,
    coverage,
    flags,
    points: points.map((point) => point.p),
    status: statusOf(coverage),
    hard: 0,
    high: flags.filter((flag) => flag.severity === 3).length,
    medium: flags.filter((flag) => flag.severity === 2).length,
    quiet: 0,
    // Exposure penalty: 180 seconds per kilometre.
    cost: route.seconds + exposureMeters * 0.18,
    rain: null,
    hours: [],
    exposureMeters,
    checkedMeters,
  };
}

/** Only compare complete exposure measurements, with at least two samples of improvement. */
export function exposureChoices(routes: CheckedRoute[]) {
  const direct = [...routes].sort((a, b) => a.seconds - b.seconds)[0] ?? null;
  if (!direct || direct.status !== "complete") return { direct, lower: null };
  const lower =
    [...routes]
      .filter(
        (route) =>
          route.id !== direct.id &&
          route.status === "complete" &&
          (route.exposureMeters ?? 0) <= (direct.exposureMeters ?? 0) - 80 &&
          route.seconds <= direct.seconds + Math.min(600, direct.seconds * 0.5),
      )
      .sort((a, b) => a.cost - b.cost || a.seconds - b.seconds)[0] ?? null;
  return { direct, lower };
}
