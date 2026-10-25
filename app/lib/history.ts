/** Neighborhood flood-claim history. */
export type StormInfo = { start: string; end: string; name: string | null; claims: number };
export type ClaimsData = {
  v: 1;
  storms: StormInfo[];
  claims: Record<string, [number, number][]>;
  before2016: Record<string, number>;
  source: string;
};
export type StormClaims = { storm: StormInfo; claims: number };

let pending: Promise<ClaimsData> | null = null;
export function loadClaims(): Promise<ClaimsData> {
  pending ??= fetch("/data/nj/claims.json").then((r) => {
    if (!r.ok) throw new Error("Flood history could not load.");
    return r.json() as Promise<ClaimsData>;
  });
  return pending.catch((error) => {
    pending = null;
    throw error;
  });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Sep 1–3, 2021", "Jul 10, 2020", "Aug 29 – Sep 1, 2021". */
export function stormDates(s: Pick<StormInfo, "start" | "end">): string {
  const [y0, m0, d0] = s.start.split("-").map(Number),
    [y1, m1, d1] = s.end.split("-").map(Number);
  if (s.start === s.end) return `${MONTHS[m0 - 1]} ${d0}, ${y0}`;
  if (y0 === y1 && m0 === m1) return `${MONTHS[m0 - 1]} ${d0}–${d1}, ${y0}`;
  if (y0 === y1) return `${MONTHS[m0 - 1]} ${d0} – ${MONTHS[m1 - 1]} ${d1}, ${y0}`;
  return `${MONTHS[m0 - 1]} ${d0}, ${y0} – ${MONTHS[m1 - 1]} ${d1}, ${y1}`;
}
/** Short label for a storm: its name when it has one, otherwise its month and year. */
export function stormName(s: StormInfo): string {
  const [y, m] = s.start.split("-").map(Number);
  return s.name ?? `${MONTHS[m - 1]} ${y} storm`;
}

/** Claims in each tested storm for one block group, newest first, plus its claims before 2016. */
export function neighborhoodHistory(
  data: ClaimsData,
  blockGroup: number | null,
): { storms: StormClaims[]; before2016: number } {
  if (blockGroup === null) return { storms: [], before2016: 0 };
  const rows = data.claims[String(blockGroup)] ?? [];
  const storms = rows
    .map(([k, claims]) => ({ storm: data.storms[k], claims }))
    .filter((r) => r.storm && r.claims >= 0.5);
  storms.sort((a, b) => b.storm.start.localeCompare(a.storm.start));
  return { storms, before2016: data.before2016[String(blockGroup)] ?? 0 };
}

/** Claim counts are allocated from older Census areas, so they can be fractional: show whole numbers. */
export function claimCount(v: number): string {
  const n = Math.max(1, Math.round(v));
  return `${n.toLocaleString("en-US")} ${n === 1 ? "claim" : "claims"}`;
}
