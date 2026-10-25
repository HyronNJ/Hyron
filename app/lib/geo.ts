import type { Coord } from "@/lib/types";
import { cleanTown } from "@/lib/contacts";

type Town = {
  name: string;
  county: string;
  bbox: [number, number, number, number];
  polygons: number[][][][];
};
function inRing(lng: number, lat: number, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i],
      b = ring[j];
    if (a[1] > lat !== b[1] > lat && lng < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
type Boundaries = {
  features: {
    properties: Record<string, string | null>;
    geometry: { type: string; coordinates: unknown };
  }[];
};
// Statewide boundaries (~200 KB compressed) load on demand instead of with the first page.
let source: Boundaries | null = null,
  towns: Town[] | null = null,
  pending: Promise<void> | null = null;
export function setBoundaries(data: Boundaries) {
  source = data;
  towns = null;
}
export function loadBoundaries(): Promise<void> {
  pending ??= import("@/data/municipalities.json")
    .then((m) => setBoundaries(((m as { default?: unknown }).default ?? m) as Boundaries))
    .catch((e) => {
      pending = null;
      throw e;
    });
  return pending;
}
function allTowns(): Town[] {
  if (!source) return [];
  towns ??= source.features.map((feature) => {
    const polygons = (
      feature.geometry.type === "MultiPolygon"
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates]
    ) as number[][][][];
    const bbox: Town["bbox"] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const polygon of polygons)
      for (const [x, y] of polygon[0]) {
        bbox[0] = Math.min(bbox[0], x);
        bbox[1] = Math.min(bbox[1], y);
        bbox[2] = Math.max(bbox[2], x);
        bbox[3] = Math.max(bbox[3], y);
      }
    const p = feature.properties;
    // "Hackensack City" is Hackensack, but Jersey City, Atlantic City and Gloucester City keep "City".
    const name = p.NAME?.endsWith(" City")
      ? p.NAME
      : cleanTown(p.MUN_LABEL ?? p.MUN ?? p.NAME ?? "New Jersey");
    return {
      name,
      county: titleCase((p.COUNTY ?? "Bergen").replace(/\s+county$/i, "")),
      bbox,
      polygons,
    };
  });
  return towns;
}
/** Municipality (and county) containing a point, from NJ OGIS municipal boundaries. */
export function townInfoAt({ lat, lng }: Coord): { name: string; county: string } | null {
  for (const town of allTowns()) {
    if (lng < town.bbox[0] || lng > town.bbox[2] || lat < town.bbox[1] || lat > town.bbox[3])
      continue;
    for (const polygon of town.polygons)
      if (inRing(lng, lat, polygon[0]) && !polygon.slice(1).some((ring) => inRing(lng, lat, ring)))
        return { name: town.name, county: town.county };
  }
  return null;
}
/** Town plus county, e.g. "Hackensack, Bergen County"; NJ has several same-named towns. */
export function municipalityAt(point: Coord): string | null {
  const t = townInfoAt(point);
  return t ? `${t.name}, ${t.county} County` : null;
}
