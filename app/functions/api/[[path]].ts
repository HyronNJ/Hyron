import { workspace } from "@/server/workspace";
import { cloudflareStore } from "@/server/cloudflare";
import { GET as weather } from "@/server/providers/weather";
import { GET as alerts } from "@/server/providers/alerts";
import { GET as gauges } from "@/server/providers/gauges";
import { GET as search } from "@/server/providers/search";

const providers: Record<string, (request: Request) => Promise<Response>> = {
  weather,
  alerts,
  gauges,
  search,
};

export async function onRequest({ request, env }: { request: Request; env: Env }) {
  const name = new URL(request.url).pathname.slice("/api/".length);
  const provider = Object.hasOwn(providers, name) ? providers[name] : undefined;
  if (request.method === "GET" && provider) return provider(request);
  return workspace(request, cloudflareStore(env));
}
