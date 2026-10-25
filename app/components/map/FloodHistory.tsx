import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  claimCount,
  loadClaims,
  neighborhoodHistory,
  stormDates,
  stormName,
  type ClaimsData,
} from "@/lib/history";
import type { FloodRecord } from "@/lib/types";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const SHOWN = 4;

/** Show neighborhood claim history. */
export default function FloodHistory({
  record,
  units,
  replayStorm,
}: {
  record: FloodRecord;
  units: "imperial" | "metric";
  replayStorm?: string;
}) {
  const [data, setData] = useState<ClaimsData | null>(null),
    [failed, setFailed] = useState(false),
    [all, setAll] = useState(false);
  useEffect(() => {
    let live = true;
    loadClaims()
      .then((d) => {
        if (live) setData(d);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  const history = data ? neighborhoodHistory(data, record.blockGroup) : null;
  const shown = history ? (all ? history.storms : history.storms.slice(0, SHOWN)) : [];
  const low = record.lowGround;
  const lowText =
    low < 0.3
      ? "Near stream level"
      : `About ${units === "imperial" ? `${Math.max(1, Math.round(low * 3.281))} ft` : `${low < 2 ? low.toFixed(1) : Math.round(low)} m`} above nearby drainage`;
  const zone =
    record.floodplain >= 0.05
      ? `${pct(record.floodplain)} in FEMA’s 100-year flood zone.`
      : record.floodplain500 >= 0.05
        ? `${pct(record.floodplain500)} in FEMA’s 500-year flood zone.`
        : "Outside FEMA’s mapped flood zones.";
  return (
    <section className="panel-section history-section" aria-label="Past flooding">
      <div className="history-headline">
        <strong>{record.claims.toLocaleString("en-US")}</strong>
        <span>FEMA flood insurance {record.claims === 1 ? "claim" : "claims"} since 1978</span>
      </div>
      {failed ? (
        <p className="panel-note">Storm history unavailable.</p>
      ) : !history ? (
        <div className="panel-skeleton compact" aria-label="Loading flood history">
          <span />
          <span />
        </div>
      ) : history.storms.length ? (
        <>
          <ol className="storm-list" aria-label="Claims in recent storms">
            {shown.map(({ storm, claims }) => (
              <li key={storm.start} className={replayStorm === storm.start ? "current" : ""}>
                <span className="storm-name">
                  {stormName(storm)}
                  {replayStorm === storm.start && <em>This replay</em>}
                </span>
                <span className="storm-date">{stormDates(storm)}</span>
                <span className="storm-claims">{claimCount(claims)}</span>
              </li>
            ))}
          </ol>
          {history.storms.length > SHOWN && (
            <button className="text-button history-more" onClick={() => setAll((v) => !v)}>
              {all ? "Show fewer storms" : `Show all ${history.storms.length} storms`}
            </button>
          )}
        </>
      ) : (
        <p className="history-empty">No claims in the listed 2017–2025 storms.</p>
      )}
      <details>
        <summary className="text-button">
          Sources and details <ChevronDown size={12} />
        </summary>
        <dl className="record-list">
          <div>
            <dt>Flood zone</dt>
            <dd>{zone}</dd>
          </div>
          <div>
            <dt>Lowest ground</dt>
            <dd>{lowText}</dd>
          </div>
          <div>
            <dt>Claims source</dt>
            <dd>FEMA · Census block group</dd>
          </div>
          {record.homes > 0 && (
            <div>
              <dt>Neighborhood homes</dt>
              <dd>{record.homes.toLocaleString("en-US")}</dd>
            </div>
          )}
          <div>
            <dt>Not counted</dt>
            <dd>Uninsured flooding</dd>
          </div>
          <div>
            <dt>Few claims</dt>
            <dd>Does not establish a dry street</dd>
          </div>
        </dl>
      </details>
    </section>
  );
}
