import {
  njForecast,
  njGate,
  njScore,
  claimsPer1000,
  fade,
  hoursSinceRain,
  rainFeatures,
  riverShare,
  type NJModel,
  type NJForecast,
} from "@/lib/nj-model";
import { GROUND_KEYS, weatherWeights } from "@/lib/statewide";
import type { WeatherGrid, WeatherHour } from "@/lib/types";

type CellInput = { static: (number | null)[] | null; lat: number; lng: number };
type Weather = {
  type: "weather";
  generation: number;
  weather: WeatherGrid;
  base: number;
  count: number;
  model: string;
};
type Cells = { type: "cells"; generation: number; key: string; cells: CellInput[] };
type Place = { type: "place"; generation: number; id: string; cell: CellInput };
let generation = 0,
  grid: WeatherGrid | null = null,
  base = 0,
  count = 0;
let model: NJModel | null = null,
  modelUrl = "",
  pick: number[] = [];
const places = new Map<string, NJForecast[]>(),
  loading = new Map<string, Promise<NJModel>>();
/** The live map uses the main model; each storm replay uses a model fit without that storm. */
function loadModel(url: string) {
  let p = loading.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new Error("The prediction model could not load.");
      return r.json() as Promise<NJModel>;
    });
    p.catch(() => loading.delete(url));
    loading.set(url, p);
  }
  return p;
}
function setModel(m: NJModel) {
  model = m;
  // Model inputs after the four rain features, located in the tiles' ground vector by name.
  pick = m.features.slice(4).map((f) => GROUND_KEYS.indexOf(f as (typeof GROUND_KEYS)[number]));
  if (pick.some((i) => i < 0))
    throw new Error("Map data and model do not match. Refresh to reload.");
}
const ground = (values: (number | null)[]) => pick.map((i) => values[i] ?? NaN);
/** Blend hourly weather at a point. */
function blended(cell: CellInput): WeatherHour[] {
  const { index, weight } = weatherWeights(grid!.points, cell);
  return grid!.times.map((time, h) => {
    let rain = 0,
      temperature = 0;
    for (let j = 0; j < index.length; j++) {
      const s = grid!.series[index[j]];
      rain += weight[j] * s.rain[h];
      temperature += weight[j] * s.temperature[h];
    }
    return { time, rain, temperature, probability: null, soilMoisture: null };
  });
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 0));
self.onmessage = async (event: MessageEvent<Weather | Cells | Place>) => {
  const request = event.data;
  try {
    if (request.type === "weather") {
      generation = request.generation;
      grid = request.weather;
      base = request.base;
      count = request.count;
      modelUrl = request.model;
      places.clear();
      model = null;
      const next = await loadModel(request.model);
      if (request.generation !== generation) return;
      setModel(next);
      if (request.generation === generation) self.postMessage({ type: "ready", generation });
      return;
    }
    const run = request.generation;
    if (run !== generation || !grid) return;
    if (!model) {
      const next = await loadModel(modelUrl);
      if (run !== generation) return;
      setModel(next);
    }
    const m = model!;
    if (request.type === "cells") {
      const cells = request.cells,
        n = cells.length,
        scores = new Float32Array(count * n);
      for (let i = 0; i < n; i++) {
        if (i % 300 === 0) {
          await pause();
          if (run !== generation) return;
        }
        const cell = cells[i];
        if (!cell.static) {
          for (let h = 0; h < count; h++) scores[h * n + i] = -1;
          continue;
        }
        const hours = blended(cell),
          g = ground(cell.static),
          river = riverShare(cell.static);
        for (let h = 0; h < count; h++) {
          const t = base + h;
          const gate = njGate(hours, t);
          if (gate) {
            scores[h * n + i] = gate === "cold" ? -1 : 0;
            continue;
          }
          const since = hoursSinceRain(hours, t),
            k = fade(m, since, river);
          scores[h * n + i] =
            k > 0
              ? njScore(
                  claimsPer1000(
                    m,
                    rainFeatures(hours, since > 0 && Number.isFinite(since) ? t - since : t),
                    g,
                  ) * k,
                  m.cuts,
                )
              : 0;
        }
      }
      self.postMessage(
        { type: "cells", generation: run, key: request.key, scores },
        { transfer: [scores.buffer] },
      );
    } else {
      let result = places.get(request.id);
      if (!result && request.cell.static) {
        const hours = blended(request.cell),
          g = ground(request.cell.static);
        result = Array.from({ length: count }, (_, h) =>
          njForecast(m, hours, base + h, g, riverShare(request.cell.static!)),
        );
        places.set(request.id, result);
      }
      self.postMessage({ type: "place", generation: run, id: request.id, forecast: result ?? [] });
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      generation: request.generation,
      message: error instanceof Error ? error.message : "The outlook could not be prepared.",
    });
  }
};
