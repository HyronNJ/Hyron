/** Read and sample USGS river-depth grids. */
export type DepthSite = {
  lid: string;
  short: string;
  stages: number[];
  skipped: { stage: number; grid: string; why: string }[];
  x0: number;
  y0: number;
  cols: number;
  rows: number;
  runs: string;
  depth: string;
  cells: number;
};
export type DepthValidation = {
  storm: string;
  marks: number;
  rows: {
    mark: string;
    site: string;
    level: number;
    observedAboveGround: number;
    modeled: [number, number | null];
  }[];
};
export type DepthData = {
  v: 1;
  cell: number;
  sites: DepthSite[];
  validation?: DepthValidation;
};
type Run = [number, number, number];
export type DepthIndex = {
  cell: number;
  sites: { site: DepthSite; rows: Map<number, Run[]>; depth: Uint8Array }[];
  validation?: DepthValidation;
};

function bytes(b64: string): Uint8Array {
  const s = atob(b64),
    out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
export function decodeDepth(d: DepthData): DepthIndex {
  if (d.v !== 1 || !(d.cell > 0) || !Array.isArray(d.sites))
    throw new Error("Depth data is damaged.");
  return {
    cell: d.cell,
    validation: d.validation,
    sites: d.sites.map((site) => {
      const r = bytes(site.runs),
        depth = bytes(site.depth),
        view = new DataView(r.buffer),
        rows = new Map<number, Run[]>();
      let offset = 0;
      for (let i = 0; i + 6 <= r.length; i += 6) {
        const row = view.getUint16(i, true),
          c0 = view.getUint16(i + 2, true),
          len = view.getUint16(i + 4, true);
        let list = rows.get(row);
        if (!list) rows.set(row, (list = []));
        list.push([c0, len, offset]);
        offset += len;
      }
      if (offset !== site.cells || depth.length !== site.cells * site.stages.length)
        throw new Error("Depth data is damaged.");
      return { site, rows, depth };
    }),
  };
}

let pending: Promise<DepthIndex> | null = null;
export function loadDepth(): Promise<DepthIndex> {
  pending ??= fetch("/data/nj/depth.json")
    .then((r) => {
      if (!r.ok) throw new Error("Depth maps could not load.");
      return r.json() as Promise<DepthData>;
    })
    .then(decodeDepth);
  return pending.catch((error) => {
    pending = null;
    throw error;
  });
}

const R = 20037508.34;
const merc = (lng: number, lat: number): [number, number] => [
  (lng * R) / 180,
  ((Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * R) / 180,
];

/** Depth by mapped stage, in feet; 0 is dry. */
export type PointDepths = { lid: string; short: string; stages: number[]; depths: number[] };
export function depthsAt(idx: DepthIndex, lng: number, lat: number): PointDepths[] {
  const [x, y] = merc(lng, lat),
    out: PointDepths[] = [];
  for (const { site, rows, depth } of idx.sites) {
    const col = Math.floor((x - site.x0) / idx.cell),
      row = Math.floor((site.y0 - y) / idx.cell);
    const run = rows.get(row)?.find(([c0, len]) => col >= c0 && col < c0 + len);
    if (!run) continue;
    const at = (run[2] + col - run[0]) * site.stages.length;
    out.push({
      lid: site.lid,
      short: site.short,
      stages: site.stages,
      depths: site.stages.map((_, i) => depth[at + i] / 10),
    });
  }
  return out;
}

/** Bracket depth at a river level, in feet. */
export type DepthRange = {
  lo: number;
  hi: number | null;
  dry: boolean;
  exact: boolean;
  belowMaps: boolean;
  aboveMaps: boolean;
  topStage: number;
};
export function depthRange(p: PointDepths, level: number): DepthRange {
  const n = p.stages.length,
    top = p.stages[n - 1],
    at = p.stages.findIndex((s) => Math.abs(s - level) <= 1e-6);
  if (at >= 0) {
    const d = p.depths[at];
    return {
      lo: d,
      hi: d,
      dry: d === 0,
      exact: true,
      belowMaps: false,
      aboveMaps: false,
      topStage: top,
    };
  }
  if (level > top)
    return {
      lo: p.depths[n - 1],
      hi: null,
      dry: false,
      exact: false,
      belowMaps: false,
      aboveMaps: true,
      topStage: top,
    };
  let a = -1;
  for (let i = 0; i < n; i++) if (p.stages[i] < level) a = i;
  const lo0 = a >= 0 ? p.depths[a] : 0,
    hi0 = p.depths[a + 1];
  // Neighboring maps disagree slightly in a few cells; the range covers both.
  const lo = Math.min(lo0, hi0),
    hi = Math.max(lo0, hi0);
  return { lo, hi, dry: hi === 0, exact: false, belowMaps: a < 0, aboveMaps: false, topStage: top };
}
/** Select the deepest site range. */
export function deepest(ranges: DepthRange[]): DepthRange | null {
  return ranges.reduce<DepthRange | null>(
    (m, r) =>
      !m ||
      (r.hi ?? Infinity) > (m.hi ?? Infinity) ||
      ((r.hi ?? Infinity) === (m.hi ?? Infinity) && r.lo > m.lo)
        ? r
        : m,
    null,
  );
}

/** Format a depth range in the selected units. */
export function depthWords(r: DepthRange, units: "imperial" | "metric"): string {
  if (r.dry) return "Dry";
  const step = units === "imperial" ? 0.5 : 0.1,
    k = units === "imperial" ? 1 : 0.3048,
    unit = units === "imperial" ? "ft" : "m";
  const f = (v: number) => (Math.round(v * 10) / 10).toString();
  const lo = Math.floor((r.lo * k) / step + 1e-9) * step;
  if (r.hi === null) return lo > 0 ? `at least ${f(lo)} ${unit}` : "above the mapped range";
  const hi = Math.ceil((r.hi * k) / step - 1e-9) * step;
  if (lo === 0) return `under ${f(Math.max(hi, step))} ${unit}`;
  return lo === hi ? `about ${f(lo)} ${unit}` : `${f(lo)}–${f(hi)} ${unit}`;
}

/** Nearby cells that flood above the lowest mapped stage. */
export type NearCell = PointDepths & { meters: number };
export function floodNear(idx: DepthIndex, lng: number, lat: number, meters = 50): NearCell[] {
  const [x, y] = merc(lng, lat),
    scale = Math.cos((lat * Math.PI) / 180),
    cell = idx.cell,
    reach = Math.ceil(meters / scale / cell) + 1,
    out: NearCell[] = [];
  for (const { site, rows, depth } of idx.sites) {
    const c0 = Math.floor((x - site.x0) / cell),
      r0 = Math.floor((site.y0 - y) / cell),
      n = site.stages.length;
    for (let r = r0 - reach; r <= r0 + reach; r++)
      for (const [start, len, offset] of rows.get(r) ?? []) {
        for (let c = Math.max(start, c0 - reach); c <= Math.min(start + len - 1, c0 + reach); c++) {
          const m =
              Math.hypot(site.x0 + (c + 0.5) * cell - x, site.y0 - (r + 0.5) * cell - y) * scale,
            at = (offset + c - start) * n;
          if (m > meters || depth[at] > 0) continue;
          out.push({
            lid: site.lid,
            short: site.short,
            stages: site.stages,
            depths: site.stages.map((_, i) => depth[at + i] / 10),
            meters: m,
          });
        }
      }
  }
  return out.sort((a, b) => a.meters - b.meters);
}
/** The nearest of those cells under water at its site's level, with its depth range; null if none. */
export function nearestWater(
  cells: NearCell[],
  levelOf: (lid: string) => number | null,
): { meters: number; range: DepthRange; short: string } | null {
  for (const c of cells) {
    const level = levelOf(c.lid);
    if (level === null) continue;
    const range = depthRange(c, level);
    if (!range.dry) return { meters: c.meters, range, short: c.short };
  }
  return null;
}

/** Map colors for modeled depth (feet): light under half a foot, darkest over 5 ft. */
