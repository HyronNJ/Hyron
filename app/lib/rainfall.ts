import type { WeatherHour } from "@/lib/types";

export type RainEvent = {
  start: string;
  end: string;
  total: number;
  peak: number;
  ongoing: boolean;
  partial: boolean;
};

/** Separate rain events with six dry hours. Past weather is an estimate from the weather provider. */
export function recentRain(hours: WeatherHour[], now: number): RainEvent | null {
  const history = hours.filter(
    (hour) => Date.parse(hour.time) < Math.floor(now / 3_600_000) * 3_600_000,
  );
  let last = history.length - 1;
  while (last >= 0 && history[last].rain < 0.1) last--;
  if (last < 0) return null;

  let first = last;
  let dryHours = 0;
  for (let index = last - 1; index >= 0; index--) {
    if (history[index].rain < 0.1) dryHours++;
    else {
      dryHours = 0;
      first = index;
    }
    if (dryHours >= 6) break;
  }

  const event = history.slice(first, last + 1);
  return {
    start: history[first].time,
    end: new Date(Date.parse(history[last].time) + 3_600_000).toISOString(),
    total: event.reduce((sum, hour) => sum + hour.rain, 0),
    peak: Math.max(...event.map((hour) => hour.rain)),
    ongoing: history.length - 1 - last < 6,
    partial: first < 6,
  };
}
