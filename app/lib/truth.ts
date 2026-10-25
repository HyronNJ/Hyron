/** Replay metrics and claim locations. */
export type LevelStats = {
  neighborhoodsWithClaimsFlagged: number;
  claimsInFlagged: number;
  homesFlagged: number;
  per1000Flagged: number;
  per1000Rest: number;
};
/** Claims in the share of homes the replay ranked highest (fixed shares: 1%, 5%, 10%). */
export type TopShare = { homes: number; claims: number; per1000Top: number; per1000Rest: number };
/** [lng, lat, claims, homes, block group]. */
export type TruthDot = [number, number, number, number, number];
export type ReplayStats = {
  independent: { auc: number; top: TopShare[] };
  liveScale: { moderate: LevelStats; strong: LevelStats };
  calibrationWithoutStorm: { moderate: LevelStats; strong: LevelStats; topPer1000: number };
  expectedClaims: {
    actual: number;
    model: number;
    liveCalibration: number;
    calibrationWithoutStorm: number;
  };
};
export type ReplayTruth = {
  storm: string;
  end: string;
  claims: number;
  neighborhoodsWithClaims: number;
  neighborhoods: number;
  model: string;
  stats: ReplayStats;
  dots: TruthDot[];
  times: [string, string];
};
export type LevelRow = {
  level: "Quiet" | "Faint" | "Moderate" | "Strong";
  blockGroupStorms: number;
  observedPer1000: number;
  shareWithClaims: number;
  shareOfAllClaims: number;
};
export type TruthData = {
  v: 2;
  replays: Record<string, ReplayTruth>;
  calibrationCheck: { inSample: LevelRow[]; crossFitted: LevelRow[] };
};

let pending: Promise<TruthData> | null = null;
export function loadTruth(): Promise<TruthData> {
  pending ??= fetch("/data/nj/truth.json").then((r) => {
    if (!r.ok) throw new Error("Storm records could not load.");
    return r.json() as Promise<TruthData>;
  });
  return pending.catch((error) => {
    pending = null;
    throw error;
  });
}
