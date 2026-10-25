import type { Feature, LineString, Polygon } from "geojson";

/** Decode flow-path and low-spot tiles. */
export type WaterTile = {
  v: 1;
  o: [number, number];
  s: number;
  l: number[][];
  p: (number | number[])[][];
};
export type WaterFeatures = {
  lines: Feature<LineString, { c: number }>[];
  spots: Feature<Polygon, { k: number }>[];
};

function coords(o: [number, number], s: number, d: number[], from = 0): [number, number][] {
  const out: [number, number][] = [];
  let x = 0,
    y = 0;
  for (let i = from; i + 1 < d.length; i += 2) {
    x += d[i];
    y += d[i + 1];
    out.push([+(o[0] + x / s).toFixed(6), +(o[1] + y / s).toFixed(6)]);
  }
  return out;
}
export function decodeWaterTile(t: WaterTile): WaterFeatures {
  if (t.v !== 1 || !Array.isArray(t.o) || !(t.s > 0))
    throw new Error("Water path data is damaged.");
  const lines = t.l
    .map((l) => ({
      type: "Feature" as const,
      properties: { c: l[0] },
      geometry: { type: "LineString" as const, coordinates: coords(t.o, t.s, l, 1) },
    }))
    .filter((f) => f.geometry.coordinates.length >= 2);
  const spots = t.p
    .map((p) => ({
      type: "Feature" as const,
      properties: { k: p[0] as number },
      geometry: {
        type: "Polygon" as const,
        coordinates: (p.slice(1) as number[][]).map((r) => coords(t.o, t.s, r)),
      },
    }))
    .filter((f) => f.geometry.coordinates[0]?.length >= 4);
  return { lines, spots };
}

const cache = new Map<string, Promise<WaterFeatures>>();
export function loadWaterTile(key: string): Promise<WaterFeatures> {
  let p = cache.get(key);
  if (!p) {
    p = fetch(`/data/nj/w/${key}.json`)
      .then((r) => {
        if (r.status === 404) return { v: 1, o: [0, 0], s: 1, l: [], p: [] } as WaterTile;
        if (!r.ok) throw new Error("Water paths could not load.");
        return r.json() as Promise<WaterTile>;
      })
      .then((tile) => {
        const features = decodeWaterTile(tile);
        for (const kind of ["lines", "spots"] as const)
          features[kind].forEach((feature, i) => {
            feature.id = `${key}:${kind}:${i}`;
          });
        return features;
      });
    p.catch(() => cache.delete(key));
    cache.set(key, p);
  }
  return p;
}
