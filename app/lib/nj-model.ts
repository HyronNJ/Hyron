import type { WeatherHour } from "@/lib/types";

/** NJ flood-claim model: rainfall and whole-area terrain produce a relative map signal. */
type Head = { initial: number; trees: (number | string)[][][] };
export function treePredict(head: Head, x: number[]): number {
  let value = head.initial;
  for (const nodes of head.trees) {
    let i = 0;
    while (!nodes[i][5]) {
      const n = nodes[i],
        feature = Number(n[1]);
      i = !Number.isFinite(x[feature])
        ? Number(n[6] ? n[3] : n[4])
        : Number(x[feature] <= Number(n[2]) ? n[3] : n[4]);
    }
    value += Number(nodes[i][0]);
  }
  return value;
}

export type NJModel = {
  version: string;
  builtAt: string;
  features: string[];
  link: "exp";
  model: Head;
  /** Calibration knots: predicted and observed claims per 1,000 homes. */
  calibration: { log10Predicted: number[]; observedPer1000: number[] };
  /** Claims per 1,000 homes where the map turns Faint, Moderate and Strong. */
  cuts: [number, number, number];
  /** Street and river fade windows, in hours. */
  afterRain: { street: [number, number]; river: [number, number] };
  evaluation: {
    storms: number;
    meanAUC: number;
    meanCapture10: number;
    areaMeanAUC: number;
    areaMeanCapture10: number;
    nycMeanAUC?: number;
    nycMeanCapture10?: number;
    period: string;
    claims: number;
  };
  ranges: number[][];
};
/** Hours of history the rain features need before the first scored hour. */
export const HISTORY_HOURS = 95;

/** Storm rain at hour t, from an hourly series in mm. */
export function rainFeatures(hours: WeatherHour[], t: number): number[] {
  let total = 0,
    peak = 0,
    peak3 = 0,
    before = 0;
  const lo = Math.max(0, t - 23);
  for (let i = lo; i <= t; i++) {
    const r = hours[i].rain;
    total += r;
    if (r > peak) peak = r;
    if (i >= lo + 2) {
      const s = hours[i].rain + hours[i - 1].rain + hours[i - 2].rain;
      if (s > peak3) peak3 = s;
    }
  }
  if (t - lo < 2) peak3 = peak;
  for (let i = Math.max(0, t - 95); i < Math.max(0, t - 23); i++) before += hours[i].rain;
  return [Math.log1p(total), Math.log1p(peak), Math.log1p(peak3), Math.log1p(before)];
}

/** Hours since the last hour with at least 0.5 mm of rain (up to and including t + 1). */
export function hoursSinceRain(hours: WeatherHour[], t: number): number {
  for (let i = Math.min(t + 1, hours.length - 1), k = t + 1 - i; i >= 0 && k <= 48; i--, k++)
    if (hours[i].rain >= 0.5) return Math.max(0, t - i);
  return Infinity;
}

export type NJGate = "cold" | "dry" | null;
/** Skip cold and dry hours. */
export function njGate(hours: WeatherHour[], t: number): NJGate {
  if (hours[t].temperature < 4) return "cold";
  let wet = 0;
  for (let i = Math.max(0, t - 23); i <= Math.min(t + 1, hours.length - 1); i++)
    wet += hours[i].rain;
  return wet < 0.25 ? "dry" : null;
}

/** Expected flood claims per 1,000 homes for one area and hour, before display fading. */
export function claimsPer1000(model: NJModel, rain: number[], ground: number[]): number {
  const raw = Math.log10(
    Math.max(1e-6, 1000 * Math.exp(treePredict(model.model, [...rain, ...ground]))),
  );
  const { log10Predicted: k, observedPer1000: v } = model.calibration;
  if (raw <= k[0]) return v[0];
  if (raw >= k[k.length - 1]) return v[v.length - 1];
  let i = 1;
  while (k[i] < raw) i++;
  return v[i - 1] + ((v[i] - v[i - 1]) * (raw - k[i - 1])) / (k[i] - k[i - 1]);
}

/** Map claims per 1,000 homes to display scores. */
export function njScore(per1000: number, cuts: NJModel["cuts"]): number {
  const [f, m, s] = cuts;
  if (!(per1000 > f / 4)) return 0;
  const seg = (v: number, a: number, b: number, lo: number, hi: number) =>
    lo + ((hi - lo) * Math.log(v / a)) / Math.log(b / a);
  if (per1000 < f) return seg(per1000, f / 4, f, 0, 15);
  if (per1000 < m) return seg(per1000, f, m, 15, 38);
  if (per1000 < s) return seg(per1000, m, s, 38, 65);
  return Math.min(100, seg(per1000, s, s * 4, 65, 100));
}

/** Blend street and river fade windows by floodplain share. */
export function fade(model: NJModel, since: number, river = 0): number {
  const k = Math.min(1, Math.max(0, river)),
    {
      street: [s0, s1],
      river: [r0, r1],
    } = model.afterRain;
  const a = s0 + (r0 - s0) * k,
    b = s1 + (r1 - s1) * k;
  return since <= a ? 1 : since >= b ? 0 : 1 - (since - a) / (b - a);
}
/** River share for fade(): the larger of the 100-year flood zone share and the near-drainage share. */
export const riverShare = (ground: (number | null)[]) =>
  Math.max(Number(ground[0] ?? 0), Number(ground[2] ?? 0));

export type NJForecast = {
  time: string;
  score: number;
  per1000: number;
  gate: NJGate;
  faded: boolean;
  inputs: { rain24h: number; peakHour: number; rainBefore: number };
};
/** Fade from the last rainy hour. */
export function njForecast(
  model: NJModel,
  hours: WeatherHour[],
  t: number,
  ground: number[],
  river = 0,
): NJForecast {
  const rain = rainFeatures(hours, t),
    gate = njGate(hours, t);
  const inputs = {
    rain24h: Math.expm1(rain[0]),
    peakHour: Math.expm1(rain[1]),
    rainBefore: Math.expm1(rain[3]),
  };
  if (gate) return { time: hours[t].time, score: 0, per1000: 0, gate, faded: false, inputs };
  const since = hoursSinceRain(hours, t),
    k = fade(model, since, river);
  const per1000 =
    claimsPer1000(
      model,
      since > 0 && Number.isFinite(since) ? rainFeatures(hours, t - since) : rain,
      ground,
    ) * k;
  return {
    time: hours[t].time,
    score: njScore(per1000, model.cuts),
    per1000,
    gate: null,
    faded: k < 1,
    inputs,
  };
}

/** Model file for each outlook mode. */
export const MODEL_FOR: Record<string, string> = {
  live: "/data/model-nj-v1.json",
  ida: "/data/model-nj-v1-without-2021-09-01.json",
  "september-2023": "/data/model-nj-v1-without-2023-09-29.json",
};
/** First day of each replay's storm in FEMA's records (claims.json, truth.json). */
export const REPLAY_STORM: Record<string, string> = {
  ida: "2021-09-01",
  "september-2023": "2023-09-29",
};
