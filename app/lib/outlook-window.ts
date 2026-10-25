import type { NJForecast } from "@/lib/nj-model";

export type OutlookWindow = {
  start: string;
  end: string;
  peak: number;
  active: boolean;
  continues: boolean;
};

/** Find consecutive Moderate-or-higher outlook hours. */
export function nextOutlookWindow(forecast: NJForecast[], from = 0): OutlookWindow | null {
  const first = forecast.findIndex(
    (hour, index) => index >= from && !hour.gate && hour.score >= 38,
  );
  if (first < 0) return null;
  let last = first;
  while (last + 1 < forecast.length && !forecast[last + 1].gate && forecast[last + 1].score >= 38)
    last++;
  return {
    start: forecast[first].time,
    end: new Date(Date.parse(forecast[last].time) + 3_600_000).toISOString(),
    peak: Math.max(...forecast.slice(first, last + 1).map((hour) => hour.score)),
    active: first === from,
    continues: last === forecast.length - 1,
  };
}
