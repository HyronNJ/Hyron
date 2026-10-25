import { useCallback, useEffect, useMemo, useState } from "react";
import { request } from "@/lib/api";
import {
  depthRange,
  depthWords,
  depthsAt,
  floodNear,
  loadDepth,
  type DepthIndex,
} from "@/lib/depth";
import {
  feet,
  loadRivers,
  maxExtent,
  riverAt,
  riverStateText,
  type GaugeData,
  type RiversData,
} from "@/lib/rivers";
import type { RouteRiver } from "@/components/routes/RoutePlanner";
import type { Coord, WeatherHour } from "@/lib/types";

type Options = {
  wanted: boolean;
  mode: string;
  hours: WeatherHour[];
  now: number;
  selection: Coord;
  units: "imperial" | "metric";
};
const clock = (time: string) =>
  new Date(time).toLocaleTimeString("en-US", { hour: "numeric", timeZone: "America/New_York" });

export function useRivers(options: Options) {
  const { wanted, mode, hours, now, selection, units } = options;
  const [data, setData] = useState<RiversData | null>(null);
  const [gauges, setGauges] = useState<GaugeData | null>(null);
  const [depth, setDepth] = useState<DepthIndex | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    loadRivers()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError("");
        }
      })
      .catch(() => {
        if (!cancelled) setError("River maps could not load.");
      });
    loadDepth()
      .then((result) => {
        if (!cancelled) setDepth(result);
      })
      .catch(() => {
        if (!cancelled) setError("Water depth maps could not load.");
      });
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  useEffect(() => {
    if (!wanted || mode !== "live") return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const result = await request<GaugeData>("/api/gauges", { signal: controller.signal });
        setGauges(result);
      } catch {
        if (!controller.signal.aborted)
          setGauges((previous) => ({
            fetchedAt: new Date().toISOString(),
            gauges: previous?.gauges ?? {},
            unavailable: true,
          }));
      }
    }
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 600_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [wanted, mode]);

  const atTime = useCallback(
    (time?: string) =>
      data?.sites.map((site) =>
        riverAt(site, {
          live: mode === "live",
          gauges,
          replay: mode,
          scenario: null,
          hourTime: time,
          now,
        }),
      ) ?? [],
    [data, gauges, mode, now],
  );

  const timeline = useMemo(
    () => hours.map((item) => ({ time: item.time, states: atTime(item.time) })),
    [hours, atTime],
  );
  const pointDepth = useMemo(
    () =>
      depth
        ? {
            here: depthsAt(depth, selection.lng, selection.lat),
            near: floodNear(depth, selection.lng, selection.lat, 50),
          }
        : null,
    [depth, selection.lat, selection.lng],
  );

  const forRoute = useCallback(
    (time?: string): RouteRiver | "pending" | "failed" => {
      if (!data) return error ? "failed" : "pending";
      const riverStates = atTime(time);
      const flood = data.sites.flatMap((site, index) => {
        const state = riverStates[index];
        const feature = site.flood.features.find((item) => item.properties.stage === state.stage);
        if (!feature || !state.source) return [];
        return [
          {
            ...feature,
            properties: {
              stage: feature.properties.stage,
              site: site.short,
              lid: site.lid,
              source: state.source,
              level: state.level!,
              when: time ? clock(time) : "",
              readAt: state.source === "observed" && state.time ? state.time : "",
            },
          },
        ];
      });
      return {
        flood,
        unknown: data.sites.flatMap((site, index) =>
          riverStates[index].source
            ? []
            : [
                {
                  ...maxExtent(site),
                  properties: { pending: riverStates[index].why === "loading" },
                },
              ],
        ),
        high: data.sites.flatMap((site, index) =>
          (riverStates[index].level ?? -Infinity) >= site.categories.action
            ? [maxExtent(site)]
            : [],
        ),
        sites: data.sites.map((site, index) => ({
          extent: maxExtent(site),
          text: riverStateText(
            riverStates[index],
            time ? clock(time) : "this hour",
            mode === "live",
          ),
        })),
        scenario: riverStates.some((state) => state.source === "scenario"),
      };
    },
    [data, error, atTime, mode],
  );

  const routeLabel = useCallback(
    (feature: RouteRiver["flood"][number], point: [number, number]) => {
      const { site, lid, stage, level, source, when } = feature.properties;
      const sample = depth
        ? depthsAt(depth, point[0], point[1]).find((item) => item.lid === lid)
        : null;
      const range = sample ? depthRange(sample, level) : null;
      const modeled =
        range && !range.dry && !range.aboveMaps
          ? ` · modeled depth ${depthWords(range, units)}`
          : "";
      const origin =
        source === "scenario"
          ? "Scenario"
          : source === "forecast"
            ? "NWS forecast"
            : source === "replay"
              ? "Replay gauge"
              : "Gauge";
      return `${site} · ${origin} ${feet(level)}${when ? ` (${when})` : ""} · USGS map ${feet(stage)}${modeled}`;
    },
    [depth, units],
  );

  return {
    depth,
    error,
    timeline,
    pointDepth,
    forRoute,
    routeLabel,
  };
}
