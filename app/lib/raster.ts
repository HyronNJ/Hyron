import { LATTICE } from "@/lib/nj";
import type { Block, Cell } from "@/lib/types";

/** Paint map scores into a raster. */
export type ScoreSet = { scores: Float32Array | null; n: number; ground: Float32Array };
export type Raster = {
  width: number;
  height: number;
  coordinates: [[number, number], [number, number], [number, number], [number, number]];
  set: Int16Array;
  item: Int32Array;
  sets: ScoreSet[];
  inputs: (Cell[] | Block[])[];
  version: number;
};

type Stop = [number, [number, number, number], number];
function ramp(stops: Stop[]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(101 * 4);
  for (let v = 0; v <= 100; v++) {
    let i = 0;
    while (i < stops.length - 2 && v > stops[i + 1][0]) i++;
    const [a, ca, aa] = stops[i],
      [b, cb, ab] = stops[i + 1],
      f = Math.max(0, Math.min(1, (v - a) / (b - a || 1)));
    for (let c = 0; c < 3; c++) out[v * 4 + c] = ca[c] + (cb[c] - ca[c]) * f;
    out[v * 4 + 3] = 255 * (aa + (ab - aa) * f);
  }
  return out;
}
// Pale means quiet; gray means unavailable.
export const FLOOD_RAMP = ramp([
  [0, [173, 199, 230], 0.16],
  [8, [150, 214, 236], 0.2],
  [15, [128, 200, 233], 0.26],
  [38, [62, 151, 220], 0.42],
  [65, [47, 91, 211], 0.56],
  [100, [52, 33, 148], 0.7],
]);
export const GROUND_RAMP = ramp([
  [0, [214, 228, 219], 0.55],
  [50, [146, 176, 158], 0.55],
  [100, [70, 102, 86], 0.6],
]);
// Dark-theme score palette.
export const FLOOD_RAMP_DARK = ramp([
  [0, [90, 190, 230], 0],
  [8, [90, 190, 230], 0.12],
  [15, [80, 190, 235], 0.3],
  [38, [70, 140, 245], 0.48],
  [65, [110, 120, 255], 0.62],
  [100, [170, 130, 255], 0.78],
]);
export const GROUND_RAMP_DARK = ramp([
  [0, [52, 82, 68], 0.55],
  [50, [104, 146, 121], 0.55],
  [100, [176, 210, 188], 0.6],
]);
// Ground height on a log scale so both coastal and highland areas show variation.
export const groundScore = (elevation: number) =>
  Math.min(100, Math.max(0, (100 * Math.log1p(Math.max(0, elevation))) / Math.log1p(300)));

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const latOf = (y: number) => ((2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180) / Math.PI;

/** A raster over a block of lattice cells; rows follow Web Mercator so pixels land on their areas. */
function build(
  col0: number,
  row0: number,
  cols: number,
  rows: number,
  dLng: number,
  dLat: number,
  at:
    ((col: number, row: number) => [number, number] | null) | { set: Int16Array; item: Int32Array },
  sets: ScoreSet[],
): Raster {
  const west = LATTICE.lng0 + col0 * dLng,
    east = west + cols * dLng,
    south = LATTICE.lat0 + row0 * dLat,
    north = south + rows * dLat;
  const yN = mercY(north),
    yS = mercY(south),
    set = new Int16Array(cols * rows).fill(-1),
    item = new Int32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const lat = latOf(yN + ((yS - yN) * (j + 0.5)) / rows),
      r = Math.min(rows - 1, Math.max(0, Math.floor((lat - south) / dLat)));
    if (typeof at !== "function") {
      set.set(at.set.subarray(r * cols, (r + 1) * cols), j * cols);
      item.set(at.item.subarray(r * cols, (r + 1) * cols), j * cols);
      continue;
    }
    for (let c = 0; c < cols; c++) {
      const hit = at(col0 + c, row0 + r);
      if (hit) {
        set[j * cols + c] = hit[0];
        item[j * cols + c] = hit[1];
      }
    }
  }
  return {
    width: cols,
    height: rows,
    coordinates: [
      [west, north],
      [east, north],
      [east, south],
      [west, south],
    ],
    set,
    item,
    sets,
    inputs: [],
    version: 0,
  };
}
export function overviewRaster(
  blocks: Block[],
  scores: Float32Array | null,
  previous?: Raster | null,
): Raster {
  if (previous?.inputs[0] === blocks) {
    if (previous.sets[0].scores !== scores) {
      previous.sets[0].scores = scores;
      previous.version++;
    }
    return previous;
  }
  const index = new Map<number, number>();
  let c0 = Infinity,
    r0 = Infinity,
    c1 = -Infinity,
    r1 = -Infinity;
  blocks.forEach((b, i) => {
    index.set(b.row * 4096 + b.col, i);
    c0 = Math.min(c0, b.col);
    r0 = Math.min(r0, b.row);
    c1 = Math.max(c1, b.col);
    r1 = Math.max(r1, b.row);
  });
  const ground = Float32Array.from(blocks, (b) => groundScore(b.elevation));
  const raster = build(
    c0,
    r0,
    c1 - c0 + 1,
    r1 - r0 + 1,
    LATTICE.dLng * LATTICE.block,
    LATTICE.dLat * LATTICE.block,
    (c, r) => {
      const i = index.get(r * 4096 + c);
      return i === undefined ? null : [0, i];
    },
    [{ scores, n: blocks.length, ground }],
  );
  raster.inputs = [blocks];
  return raster;
}
export function detailRaster(
  tiles: { cells: Cell[]; scores: Float32Array | null }[],
  previous?: Raster | null,
): Raster | null {
  if (
    previous &&
    previous.inputs.length === tiles.length &&
    tiles.every((tile, i) => tile.cells === previous.inputs[i])
  ) {
    for (let i = 0; i < tiles.length; i++) {
      if (previous.sets[i].scores !== tiles[i].scores) {
        previous.sets[i].scores = tiles[i].scores;
        previous.version++;
      }
    }
    return previous;
  }
  let c0 = Infinity,
    r0 = Infinity,
    c1 = -Infinity,
    r1 = -Infinity;
  tiles.forEach((t) =>
    t.cells.forEach((cell) => {
      const c = cell.col!,
        r = cell.row!;
      c0 = Math.min(c0, c);
      r0 = Math.min(r0, r);
      c1 = Math.max(c1, c);
      r1 = Math.max(r1, r);
    }),
  );
  if (!Number.isFinite(c0)) return null;
  const cols = c1 - c0 + 1,
    rows = r1 - r0 + 1;
  const set = new Int16Array(cols * rows).fill(-1),
    item = new Int32Array(cols * rows);
  tiles.forEach((tile, s) =>
    tile.cells.forEach((cell, i) => {
      const p = (cell.row! - r0) * cols + cell.col! - c0;
      set[p] = s;
      item[p] = i;
    }),
  );
  const sets = tiles.map((t) => ({
    scores: t.scores,
    n: t.cells.length,
    ground: Float32Array.from(t.cells, (c) => groundScore(c.elevation)),
  }));
  const raster = build(c0, r0, cols, rows, LATTICE.dLng, LATTICE.dLat, { set, item }, sets);
  raster.inputs = tiles.map((tile) => tile.cells);
  return raster;
}

/** Paint a raster at a fractional hour: each area's signal is blended between the two nearest hours. */
export function paint(raster: Raster, image: ImageData, t: number, ground: boolean, dark = false) {
  const data = image.data,
    h0 = Math.max(0, Math.floor(t)),
    f = Math.max(0, t - h0),
    lut = ground ? (dark ? GROUND_RAMP_DARK : GROUND_RAMP) : dark ? FLOOD_RAMP_DARK : FLOOD_RAMP;
  for (let p = 0; p < raster.set.length; p++) {
    const s = raster.set[p],
      o = p * 4;
    if (s < 0) {
      data[o + 3] = 0;
      continue;
    }
    const S = raster.sets[s],
      k = raster.item[p];
    let v: number;
    if (ground) v = S.ground[k];
    else {
      if (!S.scores) {
        data[o + 3] = 0;
        continue;
      }
      const hours = S.scores.length / S.n,
        a0 = Math.min(h0, hours - 1),
        a = S.scores[a0 * S.n + k],
        b = S.scores[Math.min(a0 + 1, hours - 1) * S.n + k];
      v = a < 0 || b < 0 ? Math.max(a, b) : a + (b - a) * f;
      if (v < 0) {
        data[o] = 169;
        data[o + 1] = 175;
        data[o + 2] = 185;
        data[o + 3] = 64;
        continue;
      }
    }
    const q = Math.round(Math.min(100, Math.max(0, v))) * 4;
    data[o] = lut[q];
    data[o + 1] = lut[q + 1];
    data[o + 2] = lut[q + 2];
    data[o + 3] = lut[q + 3];
  }
}
