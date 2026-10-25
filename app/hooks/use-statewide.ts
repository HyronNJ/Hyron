import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSusceptibility, type SusceptibilityData } from "@/lib/susceptibility";
import type { NJForecast as Forecast } from "@/lib/nj-model";
import { DETAIL_ZOOM, latticeIndex, tileKey, tilesInView } from "@/lib/nj";
import { decodeOverview, decodeTile, type StatewideIndex } from "@/lib/statewide";
import type { Block, Cell, Coord, WeatherGrid } from "@/lib/types";

export type MapView = { bounds: [number, number, number, number]; zoom: number };
export type TileScores = { key: string; cells: Cell[]; scores: Float32Array | null };
const OVERVIEW = "overview";

async function fetchBuffer(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error("Map data could not load. Refresh to reconnect.");
  return r.arrayBuffer();
}

/** Load map tiles and score them in a worker. */
export type Watched = Coord & { id: string };
const NO_WATCH: Watched[] = [];
export function useStatewide(
  weather: WeatherGrid | null,
  base: number,
  count: number,
  view: MapView | null,
  place: Coord,
  model: string,
  watch: Watched[] = NO_WATCH,
) {
  const persistent = model === "risk";
  const [risk, setRisk] = useState<SusceptibilityData | null>(null);
  const worker = useRef<Worker | null>(null),
    generation = useRef(0),
    ready = useRef(false);
  const tiles = useRef(new Map<string, Promise<Cell[]>>()),
    requested = useRef(new Set<string>());
  const [index, setIndex] = useState<StatewideIndex | null>(null),
    [blocks, setBlocks] = useState<Block[] | null>(null);
  const [loaded, setLoaded] = useState<Record<string, Cell[]>>({}),
    [scores, setScores] = useState<Record<string, Float32Array>>({});
  const [forecasts, setForecasts] = useState<Record<string, Forecast[]>>({}),
    [error, setError] = useState(""),
    [assetError, setAssetError] = useState(""),
    [run, setRun] = useState(0);
  const [cell, setCell] = useState<Cell | null>(null),
    [cellStatus, setCellStatus] = useState<"loading" | "ready" | "none">("loading");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch("/data/nj/index.json");
        if (!r.ok) throw new Error("Map data could not load. Refresh to reconnect.");
        const idx = (await r.json()) as StatewideIndex;
        const overview = decodeOverview(await fetchBuffer("/data/nj/overview.bin"), idx);
        if (!cancelled) {
          setIndex(idx);
          setBlocks(overview);
        }
      } catch (e) {
        if (!cancelled) setAssetError(e instanceof Error ? e.message : "Map data could not load.");
      }
    })();
    const w = new Worker("/forecast-worker.js", { type: "module" });
    worker.current = w;
    w.onmessage = (event) => {
      const data = event.data;
      if (data.generation !== generation.current) return;
      if (data.type === "ready") {
        ready.current = true;
        setRun((r) => r + 1);
      }
      if (data.type === "cells") setScores((old) => ({ ...old, [data.key]: data.scores }));
      if (data.type === "place") setForecasts((old) => ({ ...old, [data.id]: data.forecast }));
      if (data.type === "error") setError(data.message);
    };
    w.onerror = () => setError("The outlook could not load. Refresh to reconnect.");
    return () => {
      cancelled = true;
      w.terminate();
      worker.current = null;
    };
  }, []);

  useEffect(() => {
    if (!persistent || risk) return;
    let cancelled = false;
    loadSusceptibility()
      .then((data) => {
        if (!cancelled) setRisk(data);
      })
      .catch(() => {
        if (!cancelled) setError("Risk map could not load. Refresh to retry.");
      });
    return () => {
      cancelled = true;
    };
  }, [persistent, risk]);

  function loadTile(key: string): Promise<Cell[]> {
    if (!index) return Promise.resolve([]);
    let p = tiles.current.get(key);
    if (!p) {
      p = index.tiles.includes(key)
        ? fetchBuffer(`/data/nj/t/${key}.bin`).then((b) => decodeTile(b, key, index))
        : Promise.resolve([]);
      p.catch(() => tiles.current.delete(key));
      tiles.current.set(key, p);
    }
    return p;
  }

  // New weather, start hour or length: restart scoring.
  useEffect(() => {
    const g = ++generation.current;
    ready.current = false;
    requested.current.clear();
    setScores({});
    setForecasts({});
    setError("");
    if (!persistent && weather && count)
      worker.current?.postMessage({ type: "weather", generation: g, weather, base, count, model });
  }, [weather, base, count, model]);

  const detail = !!view && view.zoom >= DETAIL_ZOOM;
  const keys = useMemo(() => (detail && view ? tilesInView(view.bounds) : []), [detail, view]);
  const keyList = keys.join(",");

  useEffect(() => {
    if (!index) return;
    let cancelled = false;
    for (const key of keys)
      void loadTile(key)
        .then((cells) => {
          if (!cancelled) setLoaded((old) => (old[key] ? old : { ...old, [key]: cells }));
        })
        .catch(() => {
          if (!cancelled) setError("Some map areas could not load. Move the map to retry.");
        });
    return () => {
      cancelled = true;
    };
  }, [index, keyList]);

  // Rescore route cells when weather changes.
  const extra = useRef(new Map<string, Cell[]>()),
    [extraVersion, setExtraVersion] = useState(0);
  const scoreCells = useCallback((key: string, cells: Cell[]) => {
    extra.current.set(key, cells);
    requested.current.delete(key);
    setScores((old) => {
      if (!(key in old)) return old;
      const next = { ...old };
      delete next[key];
      return next;
    });
    setExtraVersion((v) => v + 1);
  }, []);
  // Score the state summary and any loaded tiles in view once per weather run.
  useEffect(() => {
    if (persistent ? !risk : !ready.current || !worker.current) return;
    const g = generation.current;
    const send = (key: string, cells: Cell[]) => {
      if (requested.current.has(key)) return;
      requested.current.add(key);
      if (persistent && risk) {
        const values = Float32Array.from(cells, (cell) => risk.scores.get(cell.id) ?? -1);
        setScores((old) => ({ ...old, [key]: values }));
        return;
      }
      worker.current!.postMessage({
        type: "cells",
        generation: g,
        key,
        cells: cells.map((c) => ({ static: c.static ?? null, lat: c.lat, lng: c.lng })),
      });
    };
    for (const [key, cells] of extra.current) send(key, cells);
    if (blocks)
      send(
        OVERVIEW,
        blocks.flatMap((b) => b.reps),
      );
    for (const key of keys) if (loaded[key]) send(key, loaded[key]);
  }, [run, blocks, loaded, keyList, extraVersion, risk, persistent]);
  /** Resolve points to map cells, loading tiles as needed. */
  const cellsAt = useCallback(
    async (points: Coord[]): Promise<(Cell | "outside" | "failed")[]> => {
      if (!index) return points.map(() => "failed" as const);
      const at = points.map((p) => latticeIndex(p)),
        keysNeeded = [...new Set(at.filter(Boolean).map((a) => tileKey(a!.col, a!.row)))];
      const tilesLoaded = Object.fromEntries(
        await Promise.all(
          keysNeeded.map(async (k) => [k, await loadTile(k).catch(() => null)] as const),
        ),
      );
      const lookup = new Map<string, Cell>();
      for (const cells of Object.values(tilesLoaded))
        for (const c of cells ?? []) lookup.set(c.id, c);
      return at.map((a) => {
        if (!a) return "outside";
        if (!tilesLoaded[tileKey(a.col, a.row)]) return "failed";
        const c = lookup.get(`${a.col}-${a.row}`);
        return c?.static ? c : "outside";
      });
    },
    [index],
  );

  // Resolve the selected place to its 280 m cell.
  useEffect(() => {
    const at = latticeIndex(place);
    if (!index || !at) {
      setCell(null);
      setCellStatus(index ? "none" : "loading");
      return;
    }
    let cancelled = false;
    setCellStatus("loading");
    setCell(null);
    void loadTile(tileKey(at.col, at.row))
      .then((cells) => {
        if (cancelled) return;
        const found = cells.find((c) => c.col === at.col && c.row === at.row) ?? null;
        setCell(found);
        setCellStatus(found ? "ready" : "none");
      })
      .catch(() => {
        if (!cancelled) {
          setCell(null);
          setCellStatus("none");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [index, place.lat, place.lng]);

  useEffect(() => {
    if (!persistent && ready.current && cell?.static && worker.current)
      worker.current.postMessage({
        type: "place",
        generation: generation.current,
        id: cell.id,
        cell: { static: cell.static, lat: cell.lat, lng: cell.lng },
      });
  }, [run, cell, persistent]);

  // Score saved-place cells for each weather run.
  const [watchCells, setWatchCells] = useState<Record<string, Cell | null>>({});
  const watchKey = watch.map((w) => `${w.id}:${w.lat.toFixed(5)},${w.lng.toFixed(5)}`).join("|");
  useEffect(() => {
    if (!index) return;
    let cancelled = false;
    for (const w of watch) {
      const at = latticeIndex(w);
      if (!at) continue;
      void loadTile(tileKey(at.col, at.row))
        .then((cells) => {
          if (cancelled) return;
          const found = cells.find((c) => c.col === at.col && c.row === at.row) ?? null;
          setWatchCells((o) => (o[w.id] === found ? o : { ...o, [w.id]: found }));
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [index, watchKey]);
  useEffect(() => {
    if (persistent || !ready.current || !worker.current) return;
    for (const w of watch) {
      const c = watchCells[w.id];
      if (c?.static)
        worker.current.postMessage({
          type: "place",
          generation: generation.current,
          id: c.id,
          cell: { static: c.static, lat: c.lat, lng: c.lng },
        });
    }
  }, [run, watchCells, watchKey]);
  const watchForecasts = useMemo(
    () =>
      Object.fromEntries(
        watch.map((w) => {
          const c = watchCells[w.id];
          return [w.id, c ? (forecasts[c.id] ?? null) : null];
        }),
      ) as Record<string, Forecast[] | null>,
    [watchKey, watchCells, forecasts],
  );

  const blockScores = useMemo(() => {
    const raw = scores[OVERVIEW];
    if (!raw || !blocks) return null;
    const reps = blocks.reduce((n, b) => n + b.reps.length, 0),
      out = new Float32Array(count * blocks.length).fill(-1);
    // Average the representative cell scores.
    for (let h = 0; h < count; h++) {
      let r = 0;
      blocks.forEach((b, i) => {
        let sum = 0,
          n = 0;
        for (let k = 0; k < b.reps.length; k++, r++) {
          const v = raw[h * reps + r];
          if (v >= 0) {
            sum += v;
            n++;
          }
        }
        out[h * blocks.length + i] = n ? sum / n : -1;
      });
    }
    return out;
  }, [scores, blocks, count]);
  const visible = useMemo<TileScores[]>(
    () =>
      keys
        .filter((k) => loaded[k])
        .map((k) => ({ key: k, cells: loaded[k], scores: scores[k] ?? null })),
    [keyList, loaded, scores],
  );
  const pending =
    (blocks && !blockScores ? 1 : 0) +
    (detail ? visible.filter((t) => !t.scores && t.cells.length).length : 0);
  const total = 1 + (detail ? visible.filter((t) => t.cells.length).length : 0);
  return {
    index,
    riskScore: persistent && cell ? (risk?.scores.get(cell.id) ?? null) : null,
    riskMetadata: risk?.metadata ?? null,
    blocks,
    blockScores,
    detail,
    tiles: visible,
    cell,
    cellStatus,
    forecast: cell ? (forecasts[cell.id] ?? null) : null,
    watchForecasts,
    scores,
    scoreCells,
    cellsAt,
    error: assetError || error,
    progress: weather && count ? 1 - pending / total : 0,
    scoring: persistent ? !risk || pending > 0 : !!weather && !!count && pending > 0,
  };
}
