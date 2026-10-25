import outline from "@/data/nj-outline.json";
import type { Coord } from "@/lib/types";

export const NJ_BOUNDS = [-75.5603, 38.9282, -73.8949, 41.3576] as const;
// Wide enough that a wide or tall screen can still zoom out to the whole state.
export const MAP_LIMITS = [-79.6, 37.4, -69.9, 42.9] as const;
export const LATTICE = {
  lng0: -75.6021,
  lat0: 38.9,
  dLng: 0.0033,
  dLat: 0.0025,
  cols: 522,
  rows: 988,
  tile: 40,
  block: 8,
} as const;
export const TILE_COLS = Math.ceil(LATTICE.cols / LATTICE.tile),
  TILE_ROWS = Math.ceil(LATTICE.rows / LATTICE.tile);
// Zoom at which the map switches from statewide area summaries to individual 280 m areas.
export const DETAIL_ZOOM = 11.5;

const ring = (outline as { coordinates: number[][][] }).coordinates[0];
function inRing(lng: number, lat: number, points: number[][]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i],
      b = points[j];
    if (a[1] > lat !== b[1] > lat && lng < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0])
      inside = !inside;
  }
  return inside;
}
function edgeDistance(lng: number, lat: number) {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j],
      [bx, by] = ring[i],
      k = 0.76;
    const dx = (bx - ax) * k,
      dy = by - ay,
      px = (lng - ax) * k,
      py = lat - ay;
    const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(px - t * dx, py - t * dy));
  }
  return best;
}

export function inNJ({ lat, lng }: Coord, margin = 0.005) {
  if (
    lng < NJ_BOUNDS[0] - margin ||
    lng > NJ_BOUNDS[2] + margin ||
    lat < NJ_BOUNDS[1] - margin ||
    lat > NJ_BOUNDS[3] + margin
  )
    return false;
  return inRing(lng, lat, ring) || edgeDistance(lng, lat) <= margin;
}
export const njOutline = ring;

export function latticeIndex({ lat, lng }: Coord) {
  const col = Math.floor((lng - LATTICE.lng0) / LATTICE.dLng),
    row = Math.floor((lat - LATTICE.lat0) / LATTICE.dLat);
  return col >= 0 && row >= 0 && col < LATTICE.cols && row < LATTICE.rows ? { col, row } : null;
}
export const cellCenter = (col: number, row: number): Coord => ({
  lng: +(LATTICE.lng0 + LATTICE.dLng * (col + 0.5)).toFixed(5),
  lat: +(LATTICE.lat0 + LATTICE.dLat * (row + 0.5)).toFixed(5),
});
export const tileKey = (col: number, row: number) =>
  `${Math.floor(col / LATTICE.tile)}-${Math.floor(row / LATTICE.tile)}`;
export function tilesInView(bounds: [number, number, number, number], limit = 12): string[] {
  const [w, s, e, n] = bounds;
  const c0 = Math.max(0, Math.floor((w - LATTICE.lng0) / LATTICE.dLng / LATTICE.tile)),
    c1 = Math.min(TILE_COLS - 1, Math.floor((e - LATTICE.lng0) / LATTICE.dLng / LATTICE.tile));
  const r0 = Math.max(0, Math.floor((s - LATTICE.lat0) / LATTICE.dLat / LATTICE.tile)),
    r1 = Math.min(TILE_ROWS - 1, Math.floor((n - LATTICE.lat0) / LATTICE.dLat / LATTICE.tile));
  const cx = (c0 + c1) / 2,
    cy = (r0 + r1) / 2,
    keys: [number, string][] = [];
  for (let c = c0; c <= c1; c++)
    for (let r = r0; r <= r1; r++) keys.push([(c - cx) ** 2 + (r - cy) ** 2, `${c}-${r}`]);
  return keys
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map((k) => k[1]);
}
