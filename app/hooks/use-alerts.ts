import { useEffect, useState } from "react";
import { request } from "@/lib/api";
import type { Alert, Coord } from "@/lib/types";

export function useAlerts(place: Coord) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAlerts([]);
    function refresh() {
      if (document.visibilityState !== "visible") return;
      request<{ alerts: Alert[]; unavailable: boolean }>(
        `/api/alerts?lat=${place.lat}&lng=${place.lng}`,
        { signal: controller.signal },
      )
        .then((result) => {
          setAlerts(result.alerts);
          setUnavailable(result.unavailable);
        })
        .catch(() => {
          if (!controller.signal.aborted) {
            setAlerts([]);
            setUnavailable(true);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }
    const timer = setTimeout(refresh, 300);
    const interval = setInterval(refresh, 300_000);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", refresh);
      controller.abort();
    };
  }, [place.lat, place.lng]);
  return { alerts, unavailable, loading };
}
