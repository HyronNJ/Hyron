import { LATTICE } from "@/lib/nj";

export type RiskProfile = {
  storm: string;
  end: string;
  features: number[];
  millimeters: {
    rain24h: number;
    peak1h: number;
    peak3h: number;
    antecedent72h: number;
  };
  points: number;
};

export type RiskMetadata = {
  version: string;
  builtAt: string;
  cells: number;
  profileCount: number;
  profileFeatures: string[];
  profiles: RiskProfile[];
  percentileAnchors: number[];
  scoreAnchors: number[];
  referenceRateQuantiles: number[];
};

export type SusceptibilityData = {
  scores: Map<string, number>;
  metadata: RiskMetadata;
};

/** Read the permanent map: HYR1, record count, then col/row/score records. */
export function decodeRisk(buffer: ArrayBuffer): Map<string, number> {
  const view = new DataView(buffer);
  if (view.byteLength < 8 || new TextDecoder().decode(buffer.slice(0, 4)) !== "HYR1") {
    throw new Error("The flood map data is damaged.");
  }
  const count = view.getUint32(4, true);
  if (count === 0 || count > LATTICE.cols * LATTICE.rows || view.byteLength !== 8 + count * 8) {
    throw new Error("The flood map data is incomplete.");
  }
  const scores = new Map<string, number>();
  for (let index = 0; index < count; index += 1) {
    const offset = 8 + index * 8;
    const col = view.getUint16(offset, true);
    const row = view.getUint16(offset + 2, true);
    const score = view.getFloat32(offset + 4, true);
    const id = `${col}-${row}`;
    if (
      col >= LATTICE.cols ||
      row >= LATTICE.rows ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 100 ||
      scores.has(id)
    ) {
      throw new Error("The flood map contains an invalid area.");
    }
    scores.set(id, score);
  }
  return scores;
}

let pending: Promise<SusceptibilityData> | null = null;

/** The same scores are reused across places, timeline hours and weather refreshes. */
export function loadSusceptibility(): Promise<SusceptibilityData> {
  if (!pending) {
    pending = Promise.all([fetch("/data/nj/risk/scores.bin"), fetch("/data/nj/risk/metadata.json")])
      .then(async ([binary, description]) => {
        if (!binary.ok || !description.ok)
          throw new Error("The flood map could not load. Try again.");
        const scores = decodeRisk(await binary.arrayBuffer());
        const metadata = (await description.json()) as RiskMetadata;
        if (
          metadata.version !== "hyron-susceptibility-v1" ||
          metadata.cells !== scores.size ||
          metadata.profileCount !== metadata.profiles?.length
        ) {
          throw new Error("The flood map and its description do not match.");
        }
        return { scores, metadata };
      })
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}
