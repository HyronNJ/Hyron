import { fetchJson } from "@/lib/http";
import { censusUrl, formatCensus, formatPhoton, looksLikeAddress, photonUrl } from "@/lib/search";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const query = params.get("q")?.trim() ?? "",
    source = params.get("source") ?? "photon";
  if (query.length < 2 || query.length > 160) return Response.json({ results: [] });
  const lat = Number(params.get("lat")),
    lng = Number(params.get("lng"));
  const near =
    params.has("lat") &&
    params.has("lng") &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
      ? { lat, lng }
      : undefined;
  try {
    if (source === "census") {
      const results = looksLikeAddress(query)
        ? formatCensus(await fetchJson(censusUrl(query), 6000), query)
        : [];
      return Response.json({ results }, { headers: { "Cache-Control": "public, max-age=86400" } });
    }
    const data = await fetchJson<{ features: Parameters<typeof formatPhoton>[0] }>(
      photonUrl(query, near),
      6000,
    );
    return Response.json(
      { results: formatPhoton(data.features) },
      { headers: { "Cache-Control": "public, max-age=3600" } },
    );
  } catch {
    return Response.json(
      {
        results: [],
        error: "Address search is temporarily unavailable. Select a point on the map.",
      },
      { status: 503 },
    );
  }
}
