import { useEffect, useState } from "react";
import { loadLiveWeather, WEATHER_POINTS } from "@/lib/weather";
import type { WeatherGrid } from "@/lib/types";
import { request } from "@/lib/api";

export type WeatherMode = "live" | "ida" | "september-2023";

export function useWeather(mode: WeatherMode, enabled = true) {
  const [live, setLive] = useState<WeatherGrid | null>(null);
  const [replays, setReplays] = useState<Record<string, WeatherGrid>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!enabled || mode !== "live") return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    loadLiveWeather(refresh, controller.signal)
      .then(setLive)
      .catch((reason) => {
        if (controller.signal.aborted) return;
        setError(reason.message);
        setLive((previous) =>
          previous && Date.now() - Date.parse(previous.fetchedAt) < 6 * 3_600_000
            ? { ...previous, stale: true }
            : null,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh, mode, enabled]);

  useEffect(() => {
    const controller = new AbortController();
    if (enabled && mode !== "live" && !replays[mode]) {
      request<(WeatherGrid & { id: string })[]>("/data/nj/replays.json", {
        signal: controller.signal,
      })
        .then((list) => {
          const grids = Object.fromEntries(
            list.map((grid) => [grid.id, { ...grid, points: WEATHER_POINTS }]),
          );
          setReplays(grids);
        })
        .catch(() => {
          if (!controller.signal.aborted) setError("The storm replay could not load. Try again.");
        });
    }
    return () => controller.abort();
  }, [mode, replays, refresh, enabled]);

  useEffect(() => {
    let lastHour = Math.floor(Date.now() / 3_600_000);
    function tick() {
      setNow(Date.now());
      const hour = Math.floor(Date.now() / 3_600_000);
      if (hour !== lastHour) {
        lastHour = hour;
        setRefresh((value) => value + 1);
      }
    }
    const timer = setInterval(tick, 60_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  return {
    grid: !enabled ? null : mode === "live" ? live : (replays[mode] ?? null),
    loading: enabled && (mode === "live" ? loading : !replays[mode] && !error),
    error: mode === "live" || !replays[mode] ? error : "",
    now,
    refresh: () => setRefresh((value) => value + 1),
  };
}
