import { LATTICE, cellCenter } from "@/lib/nj";
import type { Block, Cell, Coord, WeatherData, WeatherGrid, WeatherHour } from "@/lib/types";

/** Index of the prepared statewide map assets. */
export type StatewideIndex = {
  version: string;
  builtAt: string;
  municipalities: [string, string][];
  weatherPoints: [number, number][];
  tiles: string[];
  soil?: Record<string, [number | null, number]>;
  counts: Record<string, number>;
};

/** Ground inputs in the order tiles store them; the model picks its features by name. */
export const GROUND_KEYS = [
  "sfha",
  "x500",
  "hand_lt1",
  "hand_lt3",
  "hand_p10",
  "dep_share",
  "flow_share",
  "stream",
  "paved",
  "slope",
  "elev",
  "claims_before_2016",
] as const;
// HYT3 records, little-endian, 25 bytes after the position fields:
// municipality u16 | elevation u16 (m+10)*100 | paved u8 % | 100-yr zone u8 /16 | 500-yr zone u8 /16
// near-drainage <1 m u8 /255 | <3 m u8 /255 | 10th pct height above drainage u16 /100 m
// low-spot share u8 /255 | flow-path share u8 /255 | log1p upstream u16 /1000 | slope u16 /100
// claims per 1,000 homes before 2016 u16 /10 | FEMA claims since 1978 u16 | homes u16
// | Census block group index u16 (65535 = none; keys public/data/nj/claims.json)
const PAYLOAD = 25,
  NO_BLOCK_GROUP = 65535;
function readCell(
  view: DataView,
  at: number,
  col: number,
  row: number,
  index: StatewideIndex,
): Cell {
  const u8 = (o: number) => view.getUint8(at + o),
    u16 = (o: number) => view.getUint16(at + o, true);
  const m = u16(0),
    elevation = u16(2) / 100 - 10,
    paved = u8(4),
    sfha = u8(5) / 16,
    x500 = u8(6) / 16,
    slope = u16(15) / 100;
  const [municipality, county] = index.municipalities[m] ?? ["New Jersey", ""];
  return {
    id: `${col}-${row}`,
    col,
    row,
    ...cellCenter(col, row),
    municipality,
    county,
    water: false,
    elevation,
    slope,
    lowPoint: 0,
    impervious: paved,
    static: [
      sfha,
      x500,
      u8(7) / 255,
      u8(8) / 255,
      u16(9) / 100,
      u8(11) / 255,
      u8(12) / 255,
      u16(13) / 1000,
      paved,
      slope,
      elevation,
      u16(17) / 10,
    ],
    record: {
      floodplain: sfha,
      floodplain500: x500,
      claims: u16(19),
      homes: u16(21),
      lowGround: u16(9) / 100,
      blockGroup: u16(23) === NO_BLOCK_GROUP ? null : u16(23),
    },
  };
}
function checkMagic(view: DataView, magic: string) {
  if (
    view.byteLength < 6 ||
    String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)) !==
      magic
  )
    throw new Error("Map data is damaged. Refresh to reload it.");
}
export function decodeTile(buffer: ArrayBuffer, key: string, index: StatewideIndex): Cell[] {
  const view = new DataView(buffer);
  checkMagic(view, "HYT3");
  const [tx, ty] = key.split("-").map(Number),
    n = view.getUint16(4, true),
    cells: Cell[] = [];
  for (let i = 0, at = 6; i < n; i++, at += 2 + PAYLOAD) {
    const local = view.getUint16(at, true);
    cells.push(
      readCell(
        view,
        at + 2,
        tx * LATTICE.tile + (local % LATTICE.tile),
        ty * LATTICE.tile + Math.floor(local / LATTICE.tile),
        index,
      ),
    );
  }
  return cells;
}
export function decodeOverview(buffer: ArrayBuffer, index: StatewideIndex): Block[] {
  const view = new DataView(buffer);
  checkMagic(view, "HYO3");
  const n = view.getUint32(4, true),
    blocks: Block[] = [];
  let at = 8;
  for (let i = 0; i < n; i++) {
    const col = view.getUint16(at, true),
      row = view.getUint16(at + 2, true),
      elevation = view.getUint16(at + 4, true) / 10 - 10,
      m = view.getUint16(at + 6, true),
      k = view.getUint8(at + 8);
    at += 9;
    const reps: Cell[] = [];
    for (let j = 0; j < k; j++, at += 4 + PAYLOAD)
      reps.push(
        readCell(view, at + 4, view.getUint16(at, true), view.getUint16(at + 2, true), index),
      );
    const [municipality, county] = index.municipalities[m] ?? ["New Jersey", ""];
    const center = {
      lng: +(LATTICE.lng0 + LATTICE.dLng * LATTICE.block * (col + 0.5)).toFixed(5),
      lat: +(LATTICE.lat0 + LATTICE.dLat * LATTICE.block * (row + 0.5)).toFixed(5),
    };
    blocks.push({
      id: `b${col}-${row}`,
      col,
      row,
      ...center,
      elevation,
      municipality,
      county,
      reps,
    });
  }
  return blocks;
}

// Weather points sit on a regular 0.2 degree grid (data/weather-points.json).
const WGRID = { lat0: 38.9, lng0: -75.6, step: 0.2 };
const keyCache = new WeakMap<Coord[], Map<string, number>>();
function pointKeys(points: Coord[]) {
  let keys = keyCache.get(points);
  if (!keys) {
    keys = new Map(
      points.map((p, i) => [
        `${Math.round((p.lat - WGRID.lat0) / WGRID.step)}:${Math.round((p.lng - WGRID.lng0) / WGRID.step)}`,
        i,
      ]),
    );
    keyCache.set(points, keys);
  }
  return keys;
}
/** Bilinear weather weights, normalized over available points. */
export function weatherWeights(points: Coord[], p: Coord): { index: number[]; weight: number[] } {
  const keys = pointKeys(points),
    fi = (p.lat - WGRID.lat0) / WGRID.step,
    fj = (p.lng - WGRID.lng0) / WGRID.step;
  const i0 = Math.floor(fi),
    j0 = Math.floor(fj),
    ti = fi - i0,
    tj = fj - j0,
    index: number[] = [],
    weight: number[] = [];
  for (const [di, dj, w] of [
    [0, 0, (1 - ti) * (1 - tj)],
    [1, 0, ti * (1 - tj)],
    [0, 1, (1 - ti) * tj],
    [1, 1, ti * tj],
  ] as const) {
    const k = keys.get(`${i0 + di}:${j0 + dj}`);
    if (k !== undefined && w > 1e-9) {
      index.push(k);
      weight.push(w);
    }
  }
  const total = weight.reduce((a, b) => a + b, 0);
  return total > 0
    ? { index, weight: weight.map((w) => w / total) }
    : { index: [nearestPoint(points, p)], weight: [1] };
}
/** Hourly weather at a place, blended from the surrounding grid points. */
export function blendHours(grid: WeatherGrid, p: Coord): WeatherHour[] {
  const { index, weight } = weatherWeights(grid.points, p);
  return grid.times.map((time, h) => {
    let rain = 0,
      temperature = 0,
      probability: number | null = 0;
    index.forEach((k, j) => {
      const s = grid.series[k];
      rain += weight[j] * s.rain[h];
      temperature += weight[j] * s.temperature[h];
      const q = s.probability[h];
      probability =
        probability === null || q === null || q === undefined ? null : probability + weight[j] * q;
    });
    return {
      time,
      rain,
      temperature,
      probability: probability === null ? null : Math.round(probability),
      soilMoisture: null,
    };
  });
}
export function placeWeather(grid: WeatherGrid, p: Coord): WeatherData {
  return {
    hours: blendHours(grid, p),
    fetchedAt: grid.fetchedAt,
    source: grid.source,
    sourceUrl: grid.sourceUrl,
    stale: grid.stale,
    location: p,
    mode: grid.mode,
    label: grid.label,
    timelineStart: grid.timelineStart,
  };
}
/** Nearest weather grid point for a place. */
export function nearestPoint(points: Coord[], p: Coord) {
  let best = 0,
    distance = Infinity;
  points.forEach((q, i) => {
    const d = (q.lat - p.lat) ** 2 + ((q.lng - p.lng) * 0.76) ** 2;
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}
