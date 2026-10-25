import { fetchJson } from "@/lib/http";
import { inNJ } from "@/lib/nj";
import type { Alert } from "@/lib/types";
// Official NWS alerts for the selected place (any New Jersey point).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const lat = Number(params.get("lat") ?? 40.8867),
    lng = Number(params.get("lng") ?? -74.0442);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !inNJ({ lat, lng }))
    return Response.json(
      { alerts: [], unavailable: true, error: "Choose a place in New Jersey." },
      { status: 400 },
    );
  try {
    const response = await fetchJson<{
      features: {
        id: string;
        properties: {
          event: string;
          headline: string;
          description: string;
          severity: string;
          expires: string;
          web?: string;
        };
      }[];
    }>(`https://api.weather.gov/alerts/active?point=${lat.toFixed(3)},${lng.toFixed(3)}`, 10000);
    const fallback = `https://forecast.weather.gov/MapClick.php?lat=${lat.toFixed(3)}&lon=${lng.toFixed(3)}`;
    const alerts: Alert[] = response.features
      .filter((f) => /flood|rain|storm|hurricane/i.test(f.properties.event))
      .map((f) => ({
        id: f.id,
        event: f.properties.event,
        headline: f.properties.headline,
        description: f.properties.description,
        severity: f.properties.severity,
        expires: f.properties.expires,
        sourceUrl: f.properties.web || fallback,
      }));
    return Response.json(
      { alerts, fetchedAt: new Date().toISOString(), unavailable: false },
      { headers: { "Cache-Control": "public, max-age=120" } },
    );
  } catch {
    return Response.json(
      { alerts: [], unavailable: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
