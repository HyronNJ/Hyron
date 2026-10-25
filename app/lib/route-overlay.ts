import type { FeatureCollection } from "geojson";
import type { RouteOverlay } from "@/lib/types";
import type { CheckedRoute } from "@/lib/route";

/** Convert checked routes to the lines and markers drawn on the map. */
export function buildRouteOverlay(
  routes: CheckedRoute[],
  focused: CheckedRoute | null,
  persistent = false,
): RouteOverlay {
  const lines: FeatureCollection = {
    type: "FeatureCollection",
    features: routes.map((route, index) => ({
      type: "Feature",
      properties: {
        focus: route.id === focused?.id,
        flagged: !persistent && route.hard + route.high + route.medium > 0,
        order: route.id === focused?.id ? 100 : 50 - index,
      },
      geometry: { type: "LineString", coordinates: route.coords },
    })),
  };

  // Each sample represents about 40 m. Unknown stretches remain visible as dashed lines.
  if (focused && focused.status !== "checking") {
    for (const stretch of focused.coverage.stretches) {
      const points = focused.points;
      const start = Math.max(0, stretch.from - (stretch.to + 1 >= points.length ? 1 : 0));
      const end = Math.min(points.length, stretch.to + 2);
      if (end - start < 2) continue;
      lines.features.push({
        type: "Feature",
        properties: { gap: true, why: stretch.why },
        geometry: { type: "LineString", coordinates: points.slice(start, end) },
      });
    }
  }

  const flags: FeatureCollection = {
    type: "FeatureCollection",
    features: (focused?.flags ?? []).map((flag) => ({
      type: "Feature",
      properties: {
        kind: flag.kind === "report" ? "report" : flag.kind === "river" ? "river" : "flag",
        quiet: !flag.active,
        title: flag.active ? flag.title : `${flag.title} (inactive)`,
        detail: flag.detail,
      },
      geometry: { type: "Point", coordinates: flag.at },
    })),
  };
  return { lines, flags };
}
