import { useEffect, useMemo, useState } from "react";
import type { FeatureCollection } from "geojson";
import { tilesInView } from "@/lib/nj";
import { loadWaterTile, type WaterFeatures } from "@/lib/waterpaths";
import type { MapView } from "@/hooks/use-statewide";

/** Zoom from which the water paths load and draw; zoomed farther out they would be a tangle. */
export const WATER_ZOOM = 12;
const fc = (features: FeatureCollection["features"]): FeatureCollection => ({
  type: "FeatureCollection",
  features,
});

/** Loads the "Where water goes" tiles for the area in view while the layer is on. */
export function useWaterPaths(enabled: boolean, view: MapView | null, available: string[] | null) {
  const [loaded, setLoaded] = useState<Record<string, WaterFeatures>>({}),
    [failed, setFailed] = useState<string[]>([]);
  const keys = useMemo(
    () =>
      enabled && view && view.zoom >= WATER_ZOOM
        ? tilesInView(view.bounds, 9).filter((k) => !available || available.includes(k))
        : [],
    [enabled, view, available],
  );
  const keyList = keys.join(",");
  useEffect(() => {
    let live = true;
    for (const k of keys)
      void loadWaterTile(k)
        .then((f) => {
          if (live) setLoaded((o) => (o[k] ? o : { ...o, [k]: f }));
        })
        .catch(() => {
          if (live) setFailed((o) => (o.includes(k) ? o : [...o, k]));
        });
    return () => {
      live = false;
    };
  }, [keyList]);
  const data = useMemo(() => {
    const lines: FeatureCollection["features"] = [],
      spots: FeatureCollection["features"] = [];
    for (const k of keys) {
      const t = loaded[k];
      if (t) {
        lines.push(...t.lines);
        spots.push(...t.spots);
      }
    }
    return { lines: fc(lines), spots: fc(spots) };
  }, [keyList, loaded]);
  return {
    ...data,
    active: keys.length > 0,
    loading: keys.some((k) => !loaded[k] && !failed.includes(k)),
    error: keys.some((k) => failed.includes(k)),
    zoomTooFar: enabled && !!view && view.zoom < WATER_ZOOM,
  };
}
