import { ChevronDown } from "lucide-react";
import type { WeatherData } from "@/lib/types";
import { day, clock } from "@/lib/format";
import { recentRain } from "@/lib/rainfall";

type Props = { weather: WeatherData | null; now: number; units: "imperial" | "metric" };

export default function RecentRain({ weather, now, units }: Props) {
  const event = weather ? recentRain(weather.hours, now) : null;
  const amount = (mm: number) =>
    units === "imperial" ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`;
  return (
    <details className="summary-details recent-rain">
      <summary>
        <span>Recent rain</span>
        {event && <span className="rain-summary">{amount(event.total)}</span>}
        <ChevronDown size={14} />
      </summary>
      {!weather ? (
        <p>Weather unavailable.</p>
      ) : !event ? (
        <p>No rain in the available seven-day history.</p>
      ) : (
        <>
          <p>
            {day(event.start)} · {clock(event.start)}–
            {day(event.start) !== day(event.end) ? `${day(event.end)} ` : ""}
            {clock(event.end)}
          </p>
          <dl className="rain-statistics">
            <div>
              <dd>
                {event.partial ? "≥ " : ""}
                {amount(event.total)}
              </dd>
              <dt>Total</dt>
            </div>
            <div>
              <dd>{amount(event.peak)}</dd>
              <dt>Heaviest hour</dt>
            </div>
          </dl>
          {event.partial && <p className="quiet-note">Incomplete history</p>}
        </>
      )}
    </details>
  );
}
