import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Feature, LineString, MultiPolygon, Polygon } from "geojson";
import {
  ArrowDownUp,
  Car,
  ExternalLink,
  Footprints,
  LoaderCircle,
  Route as RouteIcon,
  X,
} from "lucide-react";
import { tileKey, latticeIndex } from "@/lib/nj";
import { loadWaterTile } from "@/lib/waterpaths";
import {
  avoidAround,
  checkRoute,
  checkSusceptibilityRoute,
  exposureChoices,
  checkedShare,
  fetchRoutes,
  indexPolygons,
  inPolygon,
  kmOrMiles,
  minutes,
  rank,
  recommend,
  sample,
  summarizeRoute,
  type CheckedRoute,
  type Context,
  type Flag,
  type Gap,
  type Rain,
  type RawRoute,
  type RiverHour,
  type TravelMode,
} from "@/lib/route";
import { RIVER_BOUNDS } from "@/lib/rivers";
import type { Alert, Cell, Coord, PublicPin } from "@/lib/types";
import type { RouteOverlay } from "@/lib/types";
import EndInput from "@/components/routes/RoutePlaceInput";
import { buildRouteOverlay } from "@/lib/route-overlay";

type End = Coord & { label: string };
type RiverFeature = Feature<
  MultiPolygon,
  {
    stage: number;
    site: string;
    lid: string;
    source: string;
    level: number;
    when?: string;
    readAt?: string;
  }
>;
/** The brook and river levels for the hour being checked: the same ones the map shows. */
export type RouteRiver = {
  flood: RiverFeature[];
  /** Where the maps could show water but the level at this hour isn't known. */
  unknown: Feature<MultiPolygon, { pending: boolean }>[];
  /** Each site's widest mapped extent, with a line on the level used at this hour. */
  sites: { extent: Feature<MultiPolygon>; text: string }[];
  /** Mapped brooks whose gauge is at or above action stage at this hour. */
  high: Feature<MultiPolygon>[];
  scenario: boolean;
};
type Props = {
  selection: End;
  susceptibility?: boolean;
  units: "imperial" | "metric";
  now: number;
  /** Live: routes are checked from now, or a later hour you choose. Replays: at the timeline hour. */
  live: boolean;
  timelineHour: number;
  times: string[];
  /** Neighbor reports (live only; empty during replays), or whether they are loading or failed. */
  pins: PublicPin[] | "pending" | "failed";
  /** Brook and river levels for an hour (the same ones the map shows), and the words for a river flag. */
  riverFor: (time: string | undefined) => RouteRiver | "pending" | "failed";
  riverLabel: (f: RiverFeature, at: [number, number]) => string;
  /** Rain at a point for a timeline hour, from the same live or replay weather as the flood signal. */
  rainAt: (p: [number, number], hour: number) => Rain | null;
  /** Whether the forecast behind the flood signal is ready, loading or unavailable. */
  forecast: "ready" | "loading" | "failed";
  cellsAt: (points: Coord[]) => Promise<(Cell | "outside" | "failed")[]>;
  scoreCells: (key: string, cells: Cell[]) => void;
  scores: Record<string, Float32Array>;
  onDisplay: (overlay: RouteOverlay | null, fit?: [number, number, number, number]) => void;
  onClose: () => void;
  onFocusPoint: (p: Coord) => void;
};
const KEY = "route",
  STEP = 40;
const [W, S, E, N] = RIVER_BOUNDS;
const RIVER_AREA: Feature<MultiPolygon, { pending: boolean }>[] = [true, false].map((pending) => ({
  type: "Feature",
  properties: { pending },
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [W, S],
          [E, S],
          [E, N],
          [W, N],
          [W, S],
        ],
      ],
    ],
  },
}));
/** Rough length of a number of 40 m samples, for "about 300 ft". */
function about(n: number, units: "imperial" | "metric") {
  const m = n * STEP;
  if (units === "imperial")
    return m < 300
      ? `about ${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`
      : `about ${(m / 1609.34).toFixed(1)} mi`;
  return m < 1000
    ? `about ${Math.max(20, Math.round(m / 10) * 10)} m`
    : `about ${(m / 1000).toFixed(1)} km`;
}
const clock = (t: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(t));
const hourClock = (t: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "America/New_York" }).format(
    new Date(t),
  );
const LEAVE = [0, 1, 2, 3, 6, 12];
function exposureDistance(meters: number, units: "imperial" | "metric") {
  if (units === "imperial" && meters < 160) return `${Math.round(meters * 3.28084)} ft`;
  if (units === "metric" && meters < 1000) return `${Math.round(meters)} m`;
  return kmOrMiles(meters, units);
}

function rainWords(mm: number, units: "imperial" | "metric") {
  if (mm < 0.25) return units === "imperial" ? "0 in" : "0 mm";
  return units === "imperial"
    ? mm < 1.3
      ? "<0.05 in"
      : `${(mm / 25.4).toFixed(2)} in`
    : `${mm.toFixed(mm < 10 ? 1 : 0)} mm`;
}
const bboxOf = (cs: [number, number][]) =>
  cs.reduce<[number, number, number, number]>(
    (b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

/** Route search, comparison and display. */
export default function RoutePlanner(p: Props) {
  const [from, setFrom] = useState<End | null>(null),
    [to, setTo] = useState<End | null>(p.selection),
    [mode, setMode] = useState<TravelMode>("auto");
  const [raw, setRaw] = useState<{ route: RawRoute; detour: boolean }[]>([]),
    [cellIndex, setCellIndex] = useState<Map<string, number> | null>(null),
    [pointCells, setPointCells] = useState<Map<string, string>>(new Map());
  const [water, setWater] = useState<{
    spots: Feature<Polygon, { k: number }>[];
    streams: Feature<LineString, { c: number }>[];
    failed: Set<string>;
  } | null>(null);
  const [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [focus, setFocus] = useState<string | null>(null),
    [leave, setLeave] = useState(0);
  const [alerts, setAlerts] = useState<Alert[] | "failed" | null>(null);
  const run = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const displayedOverlay = useRef("");

  useEffect(() => {
    // Changing the trip clears the previous result and cancels its outstanding requests.
    run.current += 1;
    abort.current?.abort();
    setRaw([]);
    setFocus(null);
    setBusy("");
    setError("");
    displayedOverlay.current = "";
    p.onDisplay(null);
  }, [from?.lat, from?.lng, to?.lat, to?.lng, mode, p.susceptibility]);
  useEffect(
    () => () => {
      run.current += 1;
      abort.current?.abort();
      p.onDisplay(null);
    },
    [],
  );

  // Departure: live checks start now (or a later hour you pick); replays follow the timeline.
  const last = Math.max(0, p.times.length - 1),
    depHour = Math.min(p.live ? leave : p.timelineHour, last),
    depTime = p.times[depHour];
  const offset =
    p.live && depHour === 0 && depTime
      ? Math.min(3599, Math.max(0, (p.now - Date.parse(depTime)) / 1000))
      : 0;
  useEffect(() => {
    // A different departure gets a fresh recommendation.
    setFocus(null);
  }, [depTime, p.live]);
  const depLabel = !depTime
    ? "at this hour"
    : p.live
      ? depHour === 0
        ? "now"
        : `at ${hourClock(depTime)}`
      : `at ${hourClock(depTime)} in this replay`;

  /** Load route terrain, scores and flow paths. */
  async function prepare(list: { route: RawRoute; detour: boolean }[], id: number) {
    const pts = list.flatMap((r) => sample(r.route.coords).map((s) => s.p));
    const cells = await p.cellsAt(pts.map(([lng, lat]) => ({ lng, lat })));
    if (id !== run.current) return false;
    const unique = new Map<string, Cell>();
    cells.forEach((c) => {
      if (typeof c !== "string") unique.set(c.id, c);
    });
    const order = [...unique.values()];
    setCellIndex(new Map(order.map((c, i) => [c.id, i])));
    p.scoreCells(KEY, order);
    setPointCells(
      new Map(
        pts.map((q, i) => {
          const c = cells[i];
          return [`${q[0].toFixed(6)},${q[1].toFixed(6)}`, typeof c === "string" ? c : c.id];
        }),
      ),
    );
    if (p.susceptibility) {
      setWater({ spots: [], streams: [], failed: new Set() });
      return true;
    }
    const keys = [
      ...new Set(
        pts
          .map(([lng, lat]) => latticeIndex({ lng, lat }))
          .filter(Boolean)
          .map((a) => tileKey(a!.col, a!.row)),
      ),
    ];
    const tiles = await Promise.all(keys.map((k) => loadWaterTile(k).catch(() => null)));
    if (id !== run.current) return false;
    const b = bboxOf(list.flatMap((r) => r.route.coords)),
      pad = 0.003;
    const inBox = (cs: number[][]) =>
      cs.some(([x, y]) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad);
    setWater({
      spots: tiles.flatMap((t) => t?.spots ?? []) as Feature<Polygon, { k: number }>[],
      streams: tiles
        .flatMap((t) => t?.lines ?? [])
        .filter((l) => l.properties.c >= 2 && inBox(l.geometry.coordinates)) as Feature<
        LineString,
        { c: number }
      >[],
      failed: new Set(keys.filter((_, i) => !tiles[i])),
    });
    return true;
  }
  /** Official flood alerts in effect at the start, the middle and the destination (live only). */
  async function loadAlerts(route: RawRoute, id: number, signal: AbortSignal) {
    const c = route.coords,
      pts = [c[0], c[Math.floor(c.length / 2)], c[c.length - 1]];
    try {
      const lists = await Promise.all(
        pts.map(([lng, lat]) =>
          fetch(`/api/alerts?lat=${lat.toFixed(3)}&lng=${lng.toFixed(3)}`, { signal }).then(
            (r) => r.json() as Promise<{ alerts: Alert[]; unavailable?: boolean }>,
          ),
        ),
      );
      if (id !== run.current) return;
      if (lists.every((l) => l.unavailable)) {
        setAlerts("failed");
        return;
      }
      const seen = new Map<string, Alert>();
      for (const l of lists)
        for (const a of l.alerts) if (/flood/i.test(a.event)) seen.set(a.id, a);
      setAlerts([...seen.values()]);
    } catch {
      if (id === run.current && !signal.aborted) setAlerts("failed");
    }
  }
  async function check() {
    if (!from || !to) return;
    const id = ++run.current;
    abort.current?.abort();
    const c = new AbortController();
    abort.current = c;
    setError("");
    setBusy("Finding routes…");
    setRaw([]);
    setFocus(null);
    setWater(null);
    setCellIndex(null);
    setAlerts(null);
    displayedOverlay.current = "";
    p.onDisplay(null);
    try {
      const routes = (await fetchRoutes(from, to, mode, [], 2, c.signal)).map((route) => ({
        route,
        detour: false,
      }));
      if (id !== run.current) return;
      if (!routes.length) throw new Error("No route found between these places.");
      setBusy("Checking flood data…");
      if (!(await prepare(routes, id))) return;
      setRaw(routes);
      setBusy("");
      const all = routes.flatMap((r) => r.route.coords);
      p.onDisplay(null, bboxOf(all));
    } catch (e) {
      if (id === run.current && !c.signal.aborted) {
        setError(e instanceof Error ? e.message : "Routing is unavailable right now.");
        setBusy("");
      }
    }
  }

  const firstRoute = raw[0]?.route;
  useEffect(() => {
    if (p.susceptibility || !p.live || !firstRoute) return;
    const controller = new AbortController();
    setAlerts(null);
    void loadAlerts(firstRoute, run.current, controller.signal);
    return () => controller.abort();
  }, [p.susceptibility, p.live, firstRoute]);

  const scored = p.scores[KEY] ?? null;
  // River conditions for every timeline hour, so each point can use the hour it is reached.
  const { riverFor, times } = p;
  const riverHours = useMemo(
    () =>
      p.susceptibility
        ? []
        : times.map((t): RiverHour => {
            const rr = riverFor(t);
            return typeof rr === "string"
              ? {
                  flood: [],
                  unknown: indexPolygons([rr === "pending" ? RIVER_AREA[0] : RIVER_AREA[1]]),
                  high: [],
                }
              : {
                  flood: indexPolygons(rr.flood),
                  unknown: indexPolygons(rr.unknown),
                  high: indexPolygons(rr.high),
                };
          }),
    [riverFor, times, p.susceptibility],
  );
  const riverHour = useCallback(
    (h: number): RiverHour =>
      riverHours[h] ?? { flood: [], unknown: indexPolygons([RIVER_AREA[1]]), high: [] },
    [riverHours],
  );
  const spots = useMemo(() => (water ? indexPolygons(water.spots) : []), [water]);
  const routes = useMemo<CheckedRoute[]>(() => {
    if (!raw.length || !cellIndex || !water) return [];
    const n = cellIndex.size;
    // Unknown is never zero: a point without a score says why.
    const signal = ([x, y]: [number, number], h: number): number | Gap => {
      const id = pointCells.get(`${x.toFixed(6)},${y.toFixed(6)}`);
      if (id === undefined) return "pending";
      if (id === "outside" || id === "failed") return id;
      const i = cellIndex.get(id);
      if (i === undefined) return "outside";
      if (!scored || scored.length < (h + 1) * n)
        return p.forecast === "failed" ? "failed" : "pending";
      const v = scored[h * n + i];
      return v >= 0 ? v : "outside";
    };
    const terrain = ([x, y]: [number, number]): true | Gap => {
      const a = latticeIndex({ lng: x, lat: y });
      return !a ? "outside" : water.failed.has(tileKey(a.col, a.row)) ? "failed" : true;
    };
    if (p.susceptibility) {
      return raw
        .map((item, index) =>
          checkSusceptibilityRoute(item.route, (point) => signal(point, 0), terrain, `r${index}`),
        )
        .sort((a, b) => a.cost - b.cost);
    }
    const ctx: Context = {
      signal,
      terrain,
      rain: p.rainAt,
      depart: { hour: depHour, offset, last },
      spots,
      streams: water.streams,
      river: riverHour,
      pins: p.pins,
      now: p.now,
      hourLabel: depLabel,
      riverLabel: p.riverLabel,
    };
    return raw
      .map((r, i) =>
        summarizeRoute(r.route, checkRoute(r.route, ctx), r.detour ? "detour" : `r${i}`, r.detour),
      )
      .sort(rank);
  }, [
    raw,
    cellIndex,
    pointCells,
    water,
    scored,
    depHour,
    offset,
    last,
    p.forecast,
    p.rainAt,
    spots,
    riverHour,
    p.pins,
    p.now,
    depLabel,
    p.riverLabel,
    p.susceptibility,
  ]);
  const choices = exposureChoices(routes);
  const staticSuggestion =
    choices.lower && choices.direct && choices.lower.cost < choices.direct.cost
      ? choices.lower
      : choices.direct;
  const best = routes[0] ?? null,
    suggestion = p.susceptibility ? { route: staticSuggestion, why: null } : recommend(routes),
    focused = routes.find((r) => r.id === focus) ?? suggestion.route ?? best;

  // Look for a way around once per check when the best route still passes an active serious risk.
  const tried = useRef(-1);
  useEffect(() => {
    if (
      !best ||
      !from ||
      !to ||
      best.status === "checking" ||
      !best.flags.some(
        (f) => (f.hard || f.active) && f.severity >= (p.susceptibility ? 2 : 3) && !f.end,
      ) ||
      raw.some((r) => r.detour) ||
      tried.current === run.current
    )
      return;
    tried.current = run.current;
    const id = run.current;
    void (async () => {
      setBusy("Finding a detour…");
      try {
        const [d] = await fetchRoutes(
          from,
          to,
          mode,
          avoidAround(best.flags),
          0,
          abort.current?.signal,
        );
        if (id !== run.current || !d) return;
        const list = [...raw, { route: d, detour: true }];
        if (await prepare(list, id)) setRaw(list);
      } catch {
        /* no detour: the routes found are shown as they are */
      } finally {
        if (id === run.current) setBusy("");
      }
    })();
  }, [best, scored]);

  useEffect(() => {
    if (!routes.length) return;
    const visibleRoutes = p.susceptibility
      ? routes.filter(
          (route) =>
            route.id === choices.direct?.id ||
            route.id === choices.lower?.id ||
            route.id === focused?.id,
        )
      : routes;
    const overlay = buildRouteOverlay(visibleRoutes, focused, p.susceptibility);
    const content = JSON.stringify(overlay);

    if (content === displayedOverlay.current) return;
    displayedOverlay.current = content;
    p.onDisplay(overlay);
  }, [routes, focused?.id, p.onDisplay, p.susceptibility]);

  const fastest = routes.length ? routes.reduce((a, b) => (b.seconds < a.seconds ? b : a)) : null;
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  function verdict(r: CheckedRoute) {
    if (p.susceptibility) {
      if (r.status === "checking") return "Checking exposure…";
      if (r.status === "unavailable") return "Exposure unavailable";
      return `${exposureDistance(r.exposureMeters ?? 0, p.units)} exposed${r.status === "partial" ? ` · ${checkedShare(r.coverage)}% checked` : ""}`;
    }
    if (r.status === "checking") return "Checking…";
    if (r.status === "unavailable") return "Data unavailable";
    if (r.hard)
      return `${count(r.hard, "flood hazard", "flood hazards")}${r.status === "partial" ? ` · ${checkedShare(r.coverage)}% checked` : ""}`;
    const found = r.high
      ? count(r.high, "serious risk", "serious risks")
      : r.medium
        ? `${count(r.medium, "risk", "risks")} to watch`
        : "";
    if (r.status === "complete") return found || "No active risks detected";
    return found
      ? `${found} · ${checkedShare(r.coverage)}% checked`
      : `No risks detected · ${checkedShare(r.coverage)}% checked`;
  }
  const tone = (r: CheckedRoute) =>
    r.hard
      ? "hard"
      : r.high
        ? "high"
        : r.medium
          ? "medium"
          : r.status === "complete"
            ? "clear"
            : "unknown";
  function title(r: CheckedRoute, i: number) {
    if (p.susceptibility) {
      if (r.id === choices.direct?.id) return "Direct";
      if (r.id === choices.lower?.id) return "Lower exposure";
      return `Alternative ${i + 1}`;
    }
    if (r.hard) return "Not recommended";
    if (r.id === suggestion.route?.id) return "Suggested";
    if (r.id === fastest?.id) return "Fastest";
    return r.detour ? "Detour" : `Option ${i + 1}`;
  }

  /** Why parts of a route weren't checked, in plain words. */
  function gapNotes(r: CheckedRoute): string[] {
    const g = r.coverage.gaps,
      out: string[] = [];
    if (g.failed)
      out.push(
        !p.susceptibility && p.forecast === "failed"
          ? `Forecast missing · ${about(g.failed, p.units)}`
          : `Flood data missing · ${about(g.failed, p.units)}`,
      );
    if (g.beyond)
      out.push(
        `Past ${p.times[last] ? hourClock(new Date(Date.parse(p.times[last]) + 3600000).toISOString()) : "available hours"} · ${about(g.beyond, p.units)} unchecked`,
      );
    if (g.outside) out.push(`Outside NJ · ${about(g.outside, p.units)}`);
    if (g.river) out.push(`River level unknown · ${about(g.river, p.units)}`);
    if (r.coverage.reports === "failed") out.push("Neighbor reports unavailable");
    return out;
  }

  let scenario = false;
  if (focused && !p.susceptibility)
    for (const h of focused.hours.length ? focused.hours : [depHour]) {
      const rr = p.riverFor(p.times[h]);
      if (typeof rr === "string") continue;
      const intersects = rr.sites.some((site) =>
        focused.points.some((point) => inPolygon(point, site.extent.geometry as MultiPolygon)),
      );
      if (intersects && rr.scenario) scenario = true;
    }
  const hardAt = (r: CheckedRoute) => r.flags.filter((f) => f.hard);
  const allFlagged =
    suggestion.route && routes.every((r) => r.hard > 0 || r.high > 0) && suggestion.route.high > 0;
  const active = focused
      ? [...focused.flags]
          .filter((f) => f.active)
          .sort((a, b) => Number(b.hard) - Number(a.hard) || a.from - b.from)
      : [],
    quiet = focused
      ? [...focused.flags].filter((f) => !f.active).sort((a, b) => a.from - b.from)
      : [];
  const extra =
    focused &&
    fastest &&
    suggestion.route &&
    focused.id === suggestion.route.id &&
    focused.id !== fastest.id
      ? focused.seconds - fastest.seconds
      : 0;
  const endOnly = suggestion.why === "hard" && routes.every((r) => hardAt(r).every((f) => f.end));
  const endWhere =
    endOnly && routes[0]
      ? hardAt(routes[0]).some((f) => f.end === "destination")
        ? "destination"
        : "starting point"
      : "";
  /** What a route's hard hazards are, in words: a neighbor's impassable report, the river map, or both. */
  const hardWords = (fs: Flag[]) => {
    const rep = fs.some((f) => f.kind === "report"),
      riv = fs.some((f) => f.kind === "river");
    return rep && riv
      ? "impassable reports or mapped river flooding"
      : rep
        ? "impassable reports"
        : "mapped river flooding";
  };
  function routeCard(r: CheckedRoute) {
    const i = routes.indexOf(r);
    return (
      <button
        key={r.id}
        className={`route-option ${r.id === focused?.id ? "focused" : ""} ${tone(r)}`}
        aria-pressed={r.id === focused?.id}
        onClick={() => setFocus(r.id)}
      >
        <span className="route-title">
          <strong>{title(r, i)}</strong>
          <span>
            {minutes(r.seconds)}
            {fastest && r.seconds > fastest.seconds + 30
              ? ` (+${minutes(r.seconds - fastest.seconds)})`
              : ""}{" "}
            · {kmOrMiles(r.meters, p.units)}
          </span>
        </span>
        <span className="route-verdict">
          {r.status === "checking" && <LoaderCircle size={12} className="spin" />}
          {verdict(r)}
        </span>
      </button>
    );
  }
  const mainRoutes = p.susceptibility
    ? [choices.direct, choices.lower].filter((route): route is CheckedRoute => route !== null)
    : focused
      ? [focused]
      : [];
  const alternatives = routes.filter((route) => {
    if (mainRoutes.some((main) => main.id === route.id)) return false;
    if (!p.susceptibility) return true;
    const direct = choices.direct;
    return (
      direct?.status === "complete" &&
      route.status === "complete" &&
      (route.exposureMeters ?? 0) <= (direct.exposureMeters ?? 0) - 80 &&
      route.seconds <= direct.seconds + Math.min(600, direct.seconds * 0.5)
    );
  });

  const hardFlags = active.filter((flag) => flag.hard);
  const softFlags = active.filter((flag) => !flag.hard);
  function flagItem(flag: Flag, index: number) {
    return (
      <li key={index} className={`sev${flag.severity} ${flag.hard ? "hard" : ""}`}>
        <button onClick={() => p.onFocusPoint({ lng: flag.at[0], lat: flag.at[1] })}>
          <strong>{flag.title}</strong>
          <small>{flag.detail}</small>
        </button>
      </li>
    );
  }
  const rain = focused?.rain ?? null;
  return (
    <section className="route-card" aria-label="Route checker">
      <div className="route-head">
        <RouteIcon size={16} />
        <span>
          <strong>Directions</strong>
          {!p.susceptibility && !p.live && (
            <small>Replay · {depTime ? hourClock(depTime) : "Selected hour"}</small>
          )}
        </span>
        <button className="icon-button" aria-label="Close route checker" onClick={p.onClose}>
          <X size={15} />
        </button>
      </div>
      <div className="route-form">
        <EndInput
          label="From"
          value={from}
          onChange={setFrom}
          near={to ?? p.selection}
          selection={p.selection}
          placeholder="Starting point"
        />
        <button
          className="route-swap icon-button"
          aria-label="Swap start and destination"
          onClick={() => {
            setFrom(to);
            setTo(from);
          }}
        >
          <ArrowDownUp size={14} />
        </button>
        <EndInput
          label="To"
          value={to}
          onChange={setTo}
          near={from ?? p.selection}
          selection={p.selection}
          placeholder="Destination"
        />
        <details className="route-conditions route-options-panel">
          <summary>
            {mode === "auto" ? "Drive" : "Walk"}
            {!p.susceptibility &&
              ` · ${p.live ? (leave === 0 ? "Now" : `In ${leave} h`) : "Replay"}`}
          </summary>
          {!p.susceptibility && p.live && (
            <label className="route-leave">
              <span>Leaving</span>
              <select value={leave} onChange={(e) => setLeave(Number(e.target.value))}>
                {LEAVE.filter((h) => h <= last).map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? "Now" : `In ${h} ${h === 1 ? "hour" : "hours"}`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <div className="route-actions">
            <div className="segmented" role="group" aria-label="Travel mode">
              <button
                className={mode === "auto" ? "active" : ""}
                aria-pressed={mode === "auto"}
                onClick={() => setMode("auto")}
              >
                <Car size={13} />
                Drive
              </button>
              <button
                className={mode === "pedestrian" ? "active" : ""}
                aria-pressed={mode === "pedestrian"}
                onClick={() => setMode("pedestrian")}
              >
                <Footprints size={13} />
                Walk
              </button>
            </div>
          </div>
        </details>
        <div className="route-actions">
          <button
            className="primary-button"
            disabled={!from || !to || !!busy}
            onClick={() => void check()}
          >
            {busy ? <LoaderCircle size={14} className="spin" /> : <RouteIcon size={14} />}
            {raw.length ? "Check again" : "Find route"}
          </button>
        </div>
      </div>
      {busy && (
        <p className="route-status" role="status">
          {busy}
        </p>
      )}
      {error && <p className="route-error">{error}</p>}
      {routes.length > 0 && (
        <div className="route-results">
          {p.susceptibility && <h3 className="route-exposure-title">Flood exposure</h3>}
          {mainRoutes.map(routeCard)}
          {p.susceptibility && choices.direct && choices.lower && (
            <p className="route-why">
              {exposureDistance(
                (choices.direct.exposureMeters ?? 0) - (choices.lower.exposureMeters ?? 0),
                p.units,
              )}{" "}
              less exposure ·{" "}
              {choices.lower.seconds - choices.direct.seconds < 30
                ? "same travel time"
                : `+${minutes(choices.lower.seconds - choices.direct.seconds)}`}
            </p>
          )}
          {alternatives.length > 0 && (
            <details className="route-conditions route-alternatives">
              <summary>Alternatives ({alternatives.length})</summary>
              {alternatives.map(routeCard)}
            </details>
          )}
          {suggestion.why === "hard" && (
            <p className="route-warning route-blocked">
              {endOnly
                ? `No route recommended: ${endWhere} overlaps ${hardWords(hardAt(routes[0]))}.`
                : `No route recommended: all routes cross ${hardWords(routes.flatMap(hardAt))}.`}
            </p>
          )}
          {!p.susceptibility && extra > 30 && (
            <p className="route-why">
              +{minutes(extra)} · avoids{" "}
              {fastest!.hard
                ? hardWords(hardAt(fastest!))
                : `${count(fastest!.high + fastest!.medium, "active risk", "active risks")}`}
            </p>
          )}
          {scenario && <p className="route-scenario">River scenario active</p>}
          {hardFlags.length > 0 && <ol className="route-flags">{hardFlags.map(flagItem)}</ol>}
          {softFlags.length > 0 && (
            <details className="route-quiet">
              <summary>
                Risk {softFlags.length === 1 ? "area" : "areas"} ({softFlags.length})
              </summary>
              <ol className="route-flags">{softFlags.map(flagItem)}</ol>
            </details>
          )}
          {quiet.length > 0 && (
            <details className="route-quiet">
              <summary>{count(quiet.length, "inactive risk", "inactive risks")}</summary>
              <ol className="route-flags">
                {quiet.map((f: Flag, i) => (
                  <li key={i} className="quiet">
                    <button onClick={() => p.onFocusPoint({ lng: f.at[0], lat: f.at[1] })}>
                      <strong>{f.title}</strong>
                      <small>{f.detail}</small>
                    </button>
                  </li>
                ))}
              </ol>
            </details>
          )}
          {focused && (focused.status === "partial" || focused.status === "unavailable") && (
            <details className="route-coverage">
              <summary>
                {focused.status === "partial"
                  ? `${100 - checkedShare(focused.coverage)}% not checked`
                  : "What couldn’t be checked"}
              </summary>
              {gapNotes(focused).map((t, i) => (
                <p key={i}>{t}</p>
              ))}
              <p className="route-coverage-key">
                <i aria-hidden="true" />
                Dashed = unchecked
              </p>
            </details>
          )}
          {!p.susceptibility && allFlagged && (
            <p className="route-warning">Serious risks on every route. Consider delaying.</p>
          )}
          {!p.susceptibility && (
            <details className="route-conditions">
              <summary>Conditions</summary>
              <strong>
                Departure {depLabel === "now" ? clock(new Date(p.now).toISOString()) : depLabel}
              </strong>
              <p>
                {rain
                  ? `3 h: ${rainWords(rain.last3, p.units)} · 24 h: ${rainWords(rain.last24, p.units)}`
                  : "Rain data unavailable."}
              </p>
              {p.live && (
                <p>
                  {alerts === null ? (
                    "Checking NWS warnings…"
                  ) : alerts === "failed" ? (
                    "NWS warnings unavailable."
                  ) : alerts.length ? (
                    <>NWS: {alerts.map((a) => a.event).join(", ")}.</>
                  ) : (
                    "NWS: no flood warnings."
                  )}
                </p>
              )}
            </details>
          )}
        </div>
      )}
      <details className="route-credit">
        <summary>Map credits</summary>
        <p>
          Routes:{" "}
          <a href="https://valhalla.github.io/valhalla/" target="_blank" rel="noreferrer">
            Valhalla
          </a>{" "}
          · FOSSGIS · ©{" "}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{" "}
          ·{" "}
          <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">
            Fix the map <ExternalLink size={9} />
          </a>
        </p>
      </details>
    </section>
  );
}
