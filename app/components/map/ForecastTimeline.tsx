import { Pause, Play, RefreshCw } from "lucide-react";
import type { WeatherHour } from "@/lib/types";
import type { WeatherMode } from "@/hooks/use-weather";
import { clock, day } from "@/lib/format";
import { usePlayhead, type Playhead } from "@/lib/playhead";

type Props = {
  hideSource?: boolean;
  mode: WeatherMode;
  onMode: (mode: WeatherMode) => void;
  hours: WeatherHour[];
  hour: number;
  playhead: Playhead;
  onHour: (hour: number) => void;
  playing: boolean;
  onPlay: () => void;
  error: string;
  loading: boolean;
  onRefresh: () => void;
  signal?: number[];
  stale?: boolean;
};
export default function ForecastTimeline(props: Props) {
  const { hours, hour, onHour } = props;
  const position = usePlayhead(props.playhead);
  const maximum = Math.max(1, ...hours.map((item) => item.rain));
  const ticks = [
    ...new Set([
      0,
      Math.round((hours.length - 1) / 4),
      Math.round((hours.length - 1) / 2),
      Math.round(((hours.length - 1) * 3) / 4),
      hours.length - 1,
    ]),
  ].filter((index) => index >= 0 && index < hours.length);
  const selected = hours[hour];

  return (
    <section className="forecast-timeline" aria-label="Hourly outlook">
      <div className="timeline-toolbar">
        <div className="timeline-source">
          <button
            className="play-button icon-button"
            aria-label={props.playing ? "Pause timeline" : "Play timeline"}
            disabled={!hours.length}
            onClick={props.onPlay}
          >
            {props.playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          {!props.hideSource && (
            <select
              aria-label="Weather source"
              value={props.mode}
              onChange={(event) => props.onMode(event.target.value as WeatherMode)}
            >
              <option value="live">Next 24 hours</option>
              <option value="ida">Ida · 2021</option>
              <option value="september-2023">September 2023</option>
            </select>
          )}
        </div>
        <span className="timeline-selected">
          {selected
            ? props.mode === "live"
              ? hour === 0
                ? "Now"
                : `+${hour} h · ${clock(selected.time)}`
              : `${day(selected.time)} · ${clock(selected.time)}`
            : "Loading…"}
        </span>
        <button
          className="icon-button"
          aria-label="Refresh weather"
          disabled={props.loading}
          onClick={props.onRefresh}
        >
          <RefreshCw size={15} className={props.loading ? "spin" : ""} />
        </button>
      </div>
      {props.error ? (
        <div className="inline-error">
          <span>{props.error}</span>
          <button onClick={props.onRefresh}>Retry</button>
        </div>
      ) : (
        <>
          <div className="rainfall-chart" aria-hidden="true">
            {hours.map((item, index) => (
              <div key={item.time} className={index === hour ? "selected" : ""}>
                <span style={{ height: `${Math.max(3, (item.rain / maximum) * 100)}%` }} />
                <i style={{ opacity: Math.max(0.06, (props.signal?.[index] ?? 0) / 100) }} />
              </div>
            ))}
          </div>
          <input
            className="hour-slider"
            type="range"
            min={0}
            max={Math.max(0, hours.length - 1)}
            step="any"
            aria-label="Forecast hour"
            aria-valuetext={selected ? `${day(selected.time)} ${clock(selected.time)}` : "Loading"}
            disabled={!hours.length}
            value={Math.min(position, Math.max(0, hours.length - 1))}
            onChange={(event) => onHour(Number(event.target.value))}
            onKeyDown={(event) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              onHour(
                Math.max(
                  0,
                  Math.min(hours.length - 1, hour + (event.key === "ArrowRight" ? 1 : -1)),
                ),
              );
            }}
          />
          <div className="hour-labels">
            {ticks.map((index) => (
              <button key={index} onClick={() => onHour(index)}>
                {index === 0 && props.mode === "live" ? "Now" : clock(hours[index].time)}
              </button>
            ))}
          </div>
          <div className="timeline-key">
            <span>
              <i />
              Hourly rain
            </span>
            {props.signal && (
              <span>
                <i />
                Flood outlook
              </span>
            )}
            {props.stale && <span>Delayed weather</span>}
          </div>
        </>
      )}
    </section>
  );
}
