import { ArrowRight, Bookmark, ChevronDown, Route, TriangleAlert } from "lucide-react";
import type { Alert, Cell, WeatherData } from "@/lib/types";
import type { NJForecast } from "@/lib/nj-model";
import { day, clock, riskLevel } from "@/lib/format";
import FloodHistory from "@/components/map/FloodHistory";
import RecentRain from "@/components/map/RecentRain";
import { nextOutlookWindow } from "@/lib/outlook-window";

type Props = {
  label: string;
  town: string;
  cell: Cell | null;
  forecast: NJForecast[] | null;
  hour: number;
  onHour: (hour: number) => void;
  weather: WeatherData | null;
  now: number;
  live: boolean;
  persistent?: boolean;
  susceptibilityScore?: number | null;
  loading: boolean;
  error: string;
  units: "imperial" | "metric";
  onSave: () => void;
  onReport: () => void;
  onRoute: () => void;
  saved: boolean;
  alerts: Alert[];
  alertsLoading: boolean;
  alertsUnavailable: boolean;
  children?: React.ReactNode;
  replayStorm?: string;
};

export default function LocationSummary(props: Props) {
  const persistent = props.persistent ?? false;
  const current = props.forecast?.[props.hour];
  const staticScore = props.susceptibilityScore;
  const staticLevel =
    staticScore != null && Number.isFinite(staticScore) && staticScore >= 0
      ? staticScore >= 65
        ? { band: "high", label: "High" }
        : staticScore >= 38
          ? { band: "moderate", label: "Moderate" }
          : { band: "low", label: "Lower" }
      : null;
  const level = persistent ? staticLevel : current ? riskLevel(current.score) : null;
  const upcoming = persistent ? null : nextOutlookWindow(props.forecast ?? [], props.hour);
  const floodAlerts = props.alerts.filter((alert) => /flood/i.test(alert.event));
  const ground = props.cell?.static;
  const [townName, county] = props.town.split(", ");
  const locationCaption =
    county && props.label.toLowerCase().includes(townName.toLowerCase()) ? county : props.town;
  const rainAmount = (mm: number) =>
    props.units === "imperial" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
  const cold = !persistent && current?.gate === "cold";
  function showUpcoming() {
    const index = props.forecast?.findIndex((hour) => hour.time === upcoming?.start) ?? -1;
    if (index >= 0) props.onHour(index);
  }

  return (
    <div className="location-summary">
      <header className="location-heading">
        <div>
          <h1>{props.label}</h1>
          <button
            className="icon-button"
            aria-label={props.saved ? "Place saved" : "Save place"}
            onClick={props.onSave}
          >
            <Bookmark size={18} fill={props.saved ? "currentColor" : "none"} />
          </button>
        </div>
        <p>{locationCaption}</p>
      </header>
      {(props.live || persistent) && (!persistent || floodAlerts.length > 0) && (
        <div className={`official-status ${floodAlerts.length ? "warning" : ""}`}>
          {floodAlerts.length ? (
            floodAlerts.map((alert) => (
              <a key={alert.id} href={alert.sourceUrl} target="_blank" rel="noreferrer">
                <TriangleAlert size={15} />
                <span>
                  {alert.event}
                  <small>NWS</small>
                </span>
                <ArrowRight size={13} />
              </a>
            ))
          ) : (
            <span>
              {props.alertsLoading
                ? "Checking official alerts…"
                : props.alertsUnavailable
                  ? "Official alerts unavailable"
                  : "No flood alerts"}
            </span>
          )}
        </div>
      )}
      <section className="outlook-summary">
        <span className="section-label">
          {persistent ? "Flood risk" : props.live ? "Flood outlook" : "Storm replay"}
        </span>
        {props.error ? (
          <p className="inline-error">{props.error}</p>
        ) : persistent ? (
          props.loading ? (
            <p role="status">Loading…</p>
          ) : (
            <div className={`outlook-level ${level?.band ?? "quiet"}`}>
              <i />
              <strong>{level?.label ?? "Unavailable"}</strong>
            </div>
          )
        ) : props.loading ? (
          <p role="status">Loading…</p>
        ) : (
          <>
            <div className={`outlook-level ${level?.band ?? "quiet"}`}>
              <i />
              <strong>{cold ? "Unavailable" : (level?.label ?? "Unavailable")}</strong>
              <span>{current ? clock(current.time) : "No data here"}</span>
            </div>
            {cold && <p>Rain-only model. Freezing conditions are outside its scope.</p>}
            {upcoming ? (
              <button className="upcoming-window" onClick={showUpcoming}>
                <span>{upcoming.active ? "Elevated outlook" : "Next elevated hours"}</span>
                <strong>
                  {day(upcoming.start)} ·{" "}
                  {upcoming.active
                    ? props.live && props.hour === 0
                      ? "Now"
                      : clock(upcoming.start)
                    : upcoming.continues
                      ? `From ${clock(upcoming.start)}`
                      : clock(upcoming.start)}
                  {upcoming.continues
                    ? ""
                    : `–${day(upcoming.start) !== day(upcoming.end) ? `${day(upcoming.end)} ` : ""}${clock(upcoming.end)}`}
                </strong>
                <ArrowRight size={14} />
              </button>
            ) : null}
          </>
        )}
        <button className="primary-button route-cta" onClick={props.onRoute}>
          <Route size={15} />
          Directions
          <ArrowRight size={14} />
        </button>
      </section>
      {props.live && !persistent && (
        <RecentRain weather={props.weather} now={props.now} units={props.units} />
      )}
      <details className="summary-details">
        <summary>
          {persistent ? "Area details" : "Details"}
          <ChevronDown size={14} />
        </summary>
        {persistent ? (
          <dl className="input-list">
            {ground && (
              <>
                <div>
                  <dt>Paved surface</dt>
                  <dd>{Math.round(ground[8] ?? 0)}%</dd>
                </div>
                <div>
                  <dt>Low spots</dt>
                  <dd>{Math.round((ground[5] ?? 0) * 100)}% of area</dd>
                </div>
              </>
            )}
            <div>
              <dt>Model</dt>
              <dd>19-storm susceptibility</dd>
            </div>
            <div>
              <dt>Scale</dt>
              <dd>Relative area risk</dd>
            </div>
            <div>
              <dt>Not a measure of</dt>
              <dd>Current water / probability</dd>
            </div>
          </dl>
        ) : (
          current && (
            <dl className="input-list">
              <div>
                <dt>Rain · past 24 h</dt>
                <dd>{rainAmount(current.inputs.rain24h)}</dd>
              </div>
              <div>
                <dt>Heaviest hour</dt>
                <dd>{rainAmount(current.inputs.peakHour)}</dd>
              </div>
              {ground && (
                <>
                  <div>
                    <dt>Paved surface</dt>
                    <dd>{Math.round(ground[8] ?? 0)}%</dd>
                  </div>
                  <div>
                    <dt>Low spots</dt>
                    <dd>{Math.round((ground[5] ?? 0) * 100)}% of area</dd>
                  </div>
                </>
              )}
            </dl>
          )
        )}
        {!persistent && <p>Neighborhood estimate, not street conditions.</p>}
        {!persistent && (
          <ul className="estimate-notes">
            <li>Elevated hours: Moderate or High signal.</li>
            <li>Timing is approximate.</li>
            {!props.live && <li>Replay uses reconstructed rain.</li>}
          </ul>
        )}
        {props.children}
        {props.cell?.record && (
          <details className="summary-details">
            <summary>
              Past flooding
              <ChevronDown size={14} />
            </summary>
            <FloodHistory
              record={props.cell.record}
              units={props.units}
              replayStorm={props.replayStorm}
            />
          </details>
        )}
      </details>
      <footer className="summary-footer">
        <button className="text-button" onClick={props.onReport}>
          Report an issue
          <ArrowRight size={13} />
        </button>
        <small>Never enter floodwater.</small>
      </footer>
    </div>
  );
}
