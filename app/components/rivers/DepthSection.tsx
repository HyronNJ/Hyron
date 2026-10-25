import { ChevronDown } from "lucide-react";
import {
  deepest,
  depthRange,
  depthWords,
  nearestWater,
  type DepthRange,
  type DepthValidation,
  type NearCell,
  type PointDepths,
} from "@/lib/depth";
import { feet, type RiverState } from "@/lib/rivers";

const clock = (t: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", timeZone: "America/New_York" }).format(
    new Date(t),
  );
const dayClock = (t: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    hour: "numeric",
    timeZone: "America/New_York",
  }).format(new Date(t));
const clockMin = (t: string) =>
  new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "America/New_York",
  }).format(new Date(t));
type Hour = { time: string; states: RiverState[] };
type Here = { range: DepthRange; state: RiverState } | { range: null; state: RiverState | null };

/** Resolve point depth for one hour. */
function atHour(here: PointDepths[], nearSites: string[], states: RiverState[]): Here {
  let best: { range: DepthRange; state: RiverState } | null = null,
    unknown: RiverState | null = null;
  if (!here.length) {
    for (const lid of nearSites) {
      const st = states.find((s) => s.lid === lid);
      if (!st || st.level === null) unknown ??= st ?? null;
      else best ??= { range: DRY, state: st };
    }
    return unknown ? { range: null, state: unknown } : (best ?? { range: null, state: null });
  }
  for (const p of here) {
    const st = states.find((s) => s.lid === p.lid);
    if (!st || st.level === null) {
      unknown ??= st ?? null;
      continue;
    }
    const range = depthRange(p, st.level);
    if (!best || deepest([best.range, range]) === range) best = { range, state: st };
  }

  if (best && (!best.range.dry || !unknown)) return best;
  return { range: null, state: unknown };
}
const DRY: DepthRange = {
  lo: 0,
  hi: 0,
  dry: true,
  exact: false,
  belowMaps: false,
  aboveMaps: false,
  topStage: 0,
};
function source(st: RiverState, hourLabel: string) {
  if (st.source === "scenario") return `What-if · ${st.short} ${feet(st.level!)}`;
  if (st.source === "observed") return `${st.short} · gauge ${clockMin(st.time!)}`;
  if (st.source === "replay") return `${st.short} · replay ${hourLabel}`;
  return `${st.short} · NWS forecast ${hourLabel}`;
}

/** Display river depth across the timeline. */
export default function DepthSection({
  here,
  near,
  hours,
  hour,
  onHour,
  units,
  live,
  validation,
}: {
  here: PointDepths[];
  near: NearCell[];
  hours: Hour[];
  hour: number;
  onHour: (h: number) => void;
  units: "imperial" | "metric";
  live: boolean;
  validation?: DepthValidation;
}) {
  if (!hours.length) return null;
  const h = Math.min(hour, hours.length - 1),
    sel = hours[h],
    hourLabel = clock(sel.time);
  const levelOf = (states: RiverState[]) => (lid: string) =>
    states.find((s) => s.lid === lid)?.level ?? null;
  const nearSites = [...new Set(near.map((c) => c.lid))],
    series = hours.map((x) => atHour(here, nearSites, x.states));
  const cur = series[h],
    nearNow = !cur.range || cur.range.dry ? nearestWater(near, levelOf(sel.states)) : null;

  const nearSeries = here.length ? null : hours.map((x) => nearestWater(near, levelOf(x.states)));
  const bars = hours.map((_, i) =>
    nearSeries
      ? series[i].range === null
        ? null
        : (nearSeries[i]?.range ?? DRY)
      : series[i].range,
  );
  const top = Math.max(2, ...bars.map((b) => (b ? (b.hi ?? b.lo + 1) : 0)));
  const unit = units === "imperial" ? "ft" : "m",
    topLabel =
      units === "imperial" ? `${Math.ceil(top)} ft` : `${Math.ceil(top * 0.3048 * 10) / 10} m`;
  const unknownLater = live && bars.slice(h + 1).some((b) => b === null);
  const check = validation?.rows.find(
    (r) => r.observedAboveGround > 0 && r.modeled && r.modeled[1] !== null,
  );
  const diff = check
    ? Math.round(((check.modeled[0] + check.modeled[1]!) / 2 - check.observedAboveGround) * 2) / 2
    : null;
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const headline = cur.range
    ? cur.range.dry
      ? "No mapped water"
      : cap(depthWords(cur.range, units))
    : "Unavailable";
  const above = cur.range?.aboveMaps
    ? `Above the highest map (${feet(cur.range.topStage)}); deeper water is unmodeled.`
    : null;
  const unavailable =
    cur.state?.why === "not-forecast"
      ? `No river forecast for ${hourLabel}`
      : cur.state?.why === "stale"
        ? "Gauge reading outdated"
        : live
          ? "River level unavailable"
          : "No gauge record for this hour";
  return (
    <section className="panel-section depth-section" aria-label="Modeled water depth">
      <div className={`depth-now ${cur.range && !cur.range.dry ? "wet" : ""}`}>
        <strong>{headline}</strong>
        <span>{cur.state ? (cur.range ? source(cur.state, hourLabel) : unavailable) : ""}</span>
      </div>
      {above && <p className="depth-near">{above}</p>}
      {nearNow && (
        <p className="depth-near">
          Modeled water · about{" "}
          {units === "imperial"
            ? `${Math.max(10, Math.round((nearNow.meters * 3.28084) / 10) * 10)} ft`
            : `${Math.max(5, Math.round(nearNow.meters / 5) * 5)} m`}{" "}
          away
          {nearNow.range.aboveMaps
            ? "; depth beyond mapped range."
            : ` · ${depthWords(nearNow.range, units)} deep`}
        </p>
      )}
      <div
        className="depth-strip"
        role="group"
        aria-label={
          nearSeries
            ? "Modeled depth of the nearest flood water, by hour"
            : "Modeled depth here, by hour"
        }
      >
        <svg viewBox={`0 0 ${hours.length * 10} 60`} preserveAspectRatio="none" aria-hidden="true">
          <line x1="0" x2={hours.length * 10} y1="4" y2="4" className="depth-grid" />
          <line x1="0" x2={hours.length * 10} y1="56" y2="56" className="depth-base" />
          {bars.map((b, i) => {
            if (b === null)
              return (
                <rect
                  key={i}
                  x={i * 10 + 2}
                  y="51"
                  width="6"
                  height="5"
                  className="depth-unknown"
                />
              );
            if (b.dry)
              return (
                <rect
                  key={i}
                  x={i * 10 + 3}
                  y="54.5"
                  width="4"
                  height="1.5"
                  className="depth-dry"
                />
              );
            const y = (v: number) => 56 - (52 * Math.min(v, top)) / top,
              hi = b.hi ?? top;
            // Solid to the shallower map's depth, lighter up to the deeper one: the range between the two maps.
            return (
              <g key={i} className={i === h ? "selected" : ""}>
                <rect
                  x={i * 10 + 2}
                  y={y(b.lo)}
                  width="6"
                  height={56 - y(b.lo)}
                  className="depth-bar"
                />
                <rect
                  x={i * 10 + 2}
                  y={y(hi)}
                  width="6"
                  height={Math.max(1, y(b.lo) - y(hi))}
                  className={`depth-range ${b.hi === null ? "open" : ""}`}
                />
              </g>
            );
          })}
          <rect x={h * 10} y="0" width="10" height="60" className="depth-cursor" />
        </svg>
        <span className="depth-top">{topLabel}</span>
        <div className="depth-hits">
          {hours.map((x, i) => (
            <button
              key={x.time}
              tabIndex={-1}
              aria-label={`${clock(x.time)}: ${bars[i] ? (bars[i]!.dry ? "dry" : depthWords(bars[i]!, units)) : "unavailable"}`}
              onClick={() => onHour(i)}
            />
          ))}
        </div>
        <div className="depth-scale">
          <span>{dayClock(hours[0].time)}</span>
          <span>{dayClock(hours[hours.length - 1].time)}</span>
        </div>
      </div>
      {unknownLater && <p className="panel-note">Some future river levels are unavailable.</p>}
      <details>
        <summary className="text-button">
          How depth is estimated <ChevronDown size={12} />
        </summary>
        <dl className="input-list">
          <div>
            <dt>Source</dt>
            <dd>USGS river maps · 2014</dd>
          </div>
          <div>
            <dt>River level</dt>
            <dd>{live ? "Gauge / NWS forecast" : "Recorded gauge"}</dd>
          </div>
          <div>
            <dt>Depth range</dt>
            <dd>Adjacent maps; not statistical</dd>
          </div>
          <div>
            <dt>Lighter bars</dt>
            <dd>Range between maps</dd>
          </div>
          <div>
            <dt>Not modeled</dt>
            <dd>Street drainage / rain pooling</dd>
          </div>
          {nearSeries && (
            <div>
              <dt>Chart location</dt>
              <dd>Nearest modeled water within 50 m</dd>
            </div>
          )}
          {diff !== null && diff >= 0.5 && (
            <div>
              <dt>Ida spot check</dt>
              <dd>
                {unit === "ft" ? `${diff} ft` : `${(diff * 0.3048).toFixed(1)} m`} too deep · one
                surveyed mark
              </dd>
            </div>
          )}
        </dl>
      </details>
    </section>
  );
}
