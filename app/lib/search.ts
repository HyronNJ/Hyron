import towns from "@/data/towns.json";
import { NJ_BOUNDS, inNJ } from "@/lib/nj";
import type { Coord } from "@/lib/types";

export type SearchKind = "address" | "street" | "business" | "place" | "landmark";
export type SearchResult = Coord & { label: string; address: string; kind: SearchKind };
type PhotonFeature = {
  geometry: { coordinates: number[] };
  properties: {
    name?: string;
    street?: string;
    housenumber?: string;
    postcode?: string;
    city?: string;
    town?: string;
    village?: string;
    district?: string;
    locality?: string;
    county?: string;
    state?: string;
    countrycode?: string;
    osm_key?: string;
    osm_value?: string;
    type?: string;
  };
};
type CensusMatch = {
  matchedAddress: string;
  coordinates: { x: number; y: number };
  addressComponents: { city?: string; state?: string; zip?: string };
};

// Sources
/** Photon (OpenStreetMap): streets, businesses, landmarks and places, biased toward the area on screen. */
export function photonUrl(query: string, near?: Coord) {
  const params = new URLSearchParams({
    q: query,
    limit: "15",
    lang: "en",
    bbox: NJ_BOUNDS.join(","),
  });
  if (near && Number.isFinite(near.lat) && Number.isFinite(near.lng)) {
    params.set("lat", near.lat.toFixed(4));
    params.set("lon", near.lng.toFixed(4));
    params.set("location_bias_scale", "0.3");
  }
  return `https://photon.komoot.io/api/?${params}`;
}
/** A query that starts with a house number, like "530 Fairfield Ave". */
export const looksLikeAddress = (q: string) => /^\d+[a-z]?(-\d+)?\s+\S{3,}/i.test(q.trim());
/** Build a Census address query. */
export function censusUrl(query: string) {
  const q = /\b(nj|new jersey|\d{5})\b/i.test(query) ? query : `${query}, NJ`;
  return `https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${new URLSearchParams({ address: q, benchmark: "Public_AR_Current", format: "json" })}`;
}

// Formatting
const title = (s: string) =>
  s
    .toLowerCase()
    .replace(/(^|[\s\-/])([a-z])/g, (_, a: string, b: string) => a + b.toUpperCase())
    .replace(/\b(Nj|Us)\b/g, (m) => m.toUpperCase());
const SUFFIX: Record<string, string> = {
  avenue: "ave",
  av: "ave",
  street: "st",
  road: "rd",
  drive: "dr",
  boulevard: "blvd",
  lane: "ln",
  court: "ct",
  place: "pl",
  plaza: "plz",
  parkway: "pkwy",
  terrace: "ter",
  highway: "hwy",
  route: "rte",
  circle: "cir",
  turnpike: "tpke",
  square: "sq",
  north: "n",
  south: "s",
  east: "e",
  west: "w",
  saint: "st",
  mount: "mt",
};
const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[.,#]/g, " ")
    .split(/\s+/)
    .filter((w) => /[a-z]/.test(w) && !/^(nj|new|jersey)$/.test(w))
    .map((w) => SUFFIX[w] ?? w);
/** Filter Census matches against the query. */
export function formatCensus(
  data: { result?: { addressMatches?: CensusMatch[] } },
  query?: string,
): SearchResult[] {
  const typed = query ? words(query.replace(/^\s*\d+[a-z]?(-\d+)?\s+/i, "")) : [];
  return (data.result?.addressMatches ?? []).flatMap((m) => {
    const lat = m.coordinates?.y,
      lng = m.coordinates?.x,
      c = m.addressComponents ?? {};
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      (c.state && c.state !== "NJ") ||
      !inNJ({ lat, lng })
    )
      return [];
    const have = words(m.matchedAddress);
    if (
      !typed.every((w, i) =>
        have.some((h) => h === w || (i === typed.length - 1 && h.startsWith(w))),
      )
    )
      return [];
    const street = title(m.matchedAddress.split(",")[0] ?? "");
    return [
      {
        lat,
        lng,
        label: street,
        address: [c.city ? title(c.city) : "", `NJ${c.zip ? " " + c.zip : ""}`]
          .filter(Boolean)
          .join(", "),
        kind: "address" as const,
      },
    ];
  });
}
const PLACE = new Set([
  "city",
  "town",
  "village",
  "hamlet",
  "suburb",
  "neighbourhood",
  "quarter",
  "borough",
  "municipality",
  "county",
  "locality",
  "district",
]);
function kindOf(p: PhotonFeature["properties"]): SearchKind {
  if (
    p.osm_key === "place" ||
    p.type === "city" ||
    p.type === "district" ||
    p.type === "county" ||
    PLACE.has(p.osm_value ?? "")
  )
    return "place";
  if (p.osm_key === "highway" || p.type === "street") return "street";
  if (["shop", "amenity", "office", "craft", "healthcare"].includes(p.osm_key ?? ""))
    return "business";
  if (p.name && p.osm_key !== "building") return "landmark";
  return p.housenumber ? "address" : p.name ? "landmark" : "address";
}
export function formatPhoton(features: PhotonFeature[], limit = 8): SearchResult[] {
  const seen = new Set<string>(),
    out: SearchResult[] = [];
  for (const f of features) {
    const p = f.properties,
      [lng, lat] = f.geometry.coordinates;
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      (p.countrycode && p.countrycode !== "US") ||
      (p.state && p.state !== "New Jersey") ||
      !inNJ({ lat, lng })
    )
      continue;
    const kind = kindOf(p),
      street = [p.housenumber, p.street].filter(Boolean).join(" ");
    const locality = p.city ?? p.town ?? p.village ?? p.locality ?? p.district;
    const label = p.name ?? (street || locality || "Selected place");
    const parts =
      kind === "place"
        ? [p.county, "NJ"]
        : [p.name ? street : "", locality && locality !== label ? locality : "", "NJ", p.postcode];
    const address = parts
      .filter(Boolean)
      .join(", ")
      .replace(/, NJ, (\d{5})/, ", NJ $1");
    const key = `${label}|${address}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ lat, lng, label, address: address || "New Jersey", kind });
    if (out.length >= limit) break;
  }
  return out;
}

/** Instant, offline matches against New Jersey's 564 municipalities. */
export function townMatches(query: string, limit = 3): SearchResult[] {
  const q = query
    .trim()
    .toLowerCase()
    .replace(/\s+(nj|new jersey)$/, "");
  if (q.length < 2 || /^\d/.test(q)) return [];
  const scored: [number, SearchResult][] = [];
  for (const [name, county, lat, lng] of towns as [string, string, number, number][]) {
    const n = name.toLowerCase(),
      score =
        n === q ? 0 : n.startsWith(q) ? 1 : n.split(/[\s-]+/).some((w) => w.startsWith(q)) ? 2 : -1;
    if (score >= 0)
      scored.push([
        score * 1000 + n.length,
        { lat, lng, label: name, address: `${county} County, NJ`, kind: "place" },
      ]);
  }
  return scored
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map((s) => s[1]);
}

function merge(groups: SearchResult[][], limit = 8): SearchResult[] {
  const out: SearchResult[] = [];
  for (const r of groups.flat()) {
    const dup = out.some(
      (o) =>
        o.label.toLowerCase() === r.label.toLowerCase() &&
        (o.address.toLowerCase() === r.address.toLowerCase() ||
          Math.abs(o.lat - r.lat) + Math.abs(o.lng - r.lng) < 0.05),
    );
    if (!dup) out.push(r);
    if (out.length >= limit) break;
  }
  return out;
}

// Browser search
const cache = new Map<string, Promise<SearchResult[]>>();
function cached(key: string, load: () => Promise<SearchResult[]>) {
  let p = cache.get(key);
  if (!p) {
    p = load();
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    if (cache.size > 200) cache.delete(cache.keys().next().value!);
  }
  return p;
}
const abortable = <T>(p: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
    p.then(resolve, reject);
  });
async function server(query: string, source: "photon" | "census", near?: Coord) {
  const qs = new URLSearchParams({ q: query, source });
  if (near) {
    qs.set("lat", near.lat.toFixed(3));
    qs.set("lng", near.lng.toFixed(3));
  }
  const r = await fetch(`/api/search?${qs}`);
  const d = (await r.json()) as { results: SearchResult[]; error?: string };
  if (!r.ok) throw new Error(d.error ?? "Search unavailable");
  return d.results;
}
/** Stream town, address and place matches. */
export function searchPlaces(
  query: string,
  near: Coord | undefined,
  signal: AbortSignal,
  onResults: (results: SearchResult[], done: boolean) => void,
): Promise<SearchResult[]> {
  const q = query.trim(),
    address = looksLikeAddress(q),
    bias = near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : "";
  const local = townMatches(q, address ? 0 : 3);
  let census: SearchResult[] = [],
    osm: SearchResult[] = [];
  const current = () => merge(address ? [census, local, osm] : [local, osm]);
  onResults(current(), false);
  const census$ = address
    ? abortable(
        cached(`census|${q.toLowerCase()}`, () => server(q, "census")),
        signal,
      )
        .then((r) => {
          census = r;
          onResults(current(), false);
        })
        .catch((e) => {
          if (signal.aborted) throw e;
        })
    : Promise.resolve();
  const photon$ = abortable(
    cached(`osm|${q.toLowerCase()}|${bias}`, async () => {
      try {
        const r = await fetch(photonUrl(q, near));
        if (!r.ok) throw new Error();
        return formatPhoton(((await r.json()) as { features: PhotonFeature[] }).features);
      } catch {
        return server(q, "photon", near);
      }
    }),
    signal,
  )
    .then((r) => {
      osm = r;
      onResults(current(), false);
    })
    .catch((e) => {
      if (signal.aborted) throw e;
    });
  return Promise.all([census$, photon$]).then(() => {
    const r = current();
    onResults(r, true);
    return r;
  });
}
