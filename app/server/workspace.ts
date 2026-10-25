import { z, ZodError } from "zod";
import { categories, emailDraft, stripJpegMetadata } from "@/lib/reports";
import { loadBoundaries, municipalityAt } from "@/lib/geo";
import type { Place, PublicPin, Report } from "@/lib/types";

type Result<T> = T | Promise<T>;
export interface WorkspaceStore {
  listReports(owner: string): Result<Report[]>;
  findReport(owner: string, id: string): Result<Report | null>;
  saveReport(owner: string, report: Report): Result<unknown>;
  deleteReport(owner: string, id: string): Result<unknown>;
  listPlaces(owner: string): Result<Place[]>;
  savePlace(owner: string, place: Place): Result<unknown>;
  deletePlace(owner: string, id: string): Result<unknown>;
  communityPins(): Result<PublicPin[]>;
  readPhoto(id: string): Promise<ArrayBuffer | Uint8Array | null>;
  writePhoto(id: string, photo: Uint8Array): Promise<unknown>;
  deletePhoto(id: string): Promise<unknown>;
}

const locationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().trim().min(1).max(200),
});
const placeSchema = locationSchema.extend({ label: z.string().trim().min(1).max(80) });
const reportSchema = locationSchema.extend({
  category: z.enum(categories as [(typeof categories)[number], ...(typeof categories)[number][]]),
  description: z.string().trim().min(5).max(1500),
  publicPin: z.boolean(),
  safeLocation: z.literal(true),
  locationConfirmed: z.literal(true),
  waterLevel: z.enum(["puddles", "over-curb", "lane-covered", "impassable"]).nullable().optional(),
});
const draftSchema = z
  .object({
    status: z.enum(["draft_ready", "marked_sent", "resolved"]).optional(),
    recipient: z.string().email().max(200).nullable().optional(),
    emailSubject: z.string().trim().min(1).max(220).optional(),
    emailBody: z.string().trim().min(1).max(5000).optional(),
  })
  .refine((input) => Object.keys(input).length > 0);

class RequestError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new RequestError(status, message);
}

async function body(request: Request) {
  const limit = request.headers.get("content-type")?.startsWith("multipart/form-data")
    ? 3_200_000
    : 102_400;
  if (Number(request.headers.get("content-length")) > limit)
    fail(413, "That request is too large.");
  const reader = request.body?.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        fail(413, "That request is too large.");
      }
      chunks.push(new Uint8Array(value).buffer);
    }
  }
  return new Response(new Blob(chunks), { headers: request.headers });
}

export async function workspace(request: Request, store: WorkspaceStore): Promise<Response> {
  const url = new URL(request.url);
  const owner =
    request.headers
      .get("cookie")
      ?.match(
        /(?:^|;\s*)hyron_device=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:;|$)/,
      )?.[1] ?? crypto.randomUUID();
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  headers.set(
    "Set-Cookie",
    `hyron_device=${owner}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${url.protocol === "https:" ? "; Secure" : ""}`,
  );
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
  try {
    const origin = request.headers.get("origin");
    if (request.method !== "GET" && origin) {
      let sameHost = false;
      try {
        const source = new URL(origin);
        sameHost = ["http:", "https:"].includes(source.protocol) && source.host === url.host;
      } catch {
        /* Invalid origin. */
      }
      if (!sameHost) fail(403, "Request origin is not allowed.");
    }
    const path = url.pathname;
    const method = request.method;
    if (method === "GET" && path === "/api/workspace") {
      const [reports, places, community] = await Promise.all([
        store.listReports(owner),
        store.listPlaces(owner),
        store.communityPins(),
      ]);
      return json({ reports, places, community });
    }
    if (method === "GET" && path === "/api/community")
      return json({ community: await store.communityPins() });
    if (method === "POST" && path === "/api/places") {
      const input = placeSchema.parse(await (await body(request)).json());
      await loadBoundaries();
      if (!municipalityAt(input)) fail(400, "Choose a place in New Jersey.");
      const places = await store.listPlaces(owner);
      const duplicate = places.find(
        (place) =>
          Math.abs(place.lat - input.lat) < 0.0003 && Math.abs(place.lng - input.lng) < 0.0003,
      );
      if (!duplicate && places.length >= 30) fail(400, "You can save up to 30 places.");
      const place = { id: duplicate?.id ?? crypto.randomUUID(), ...input };
      await store.savePlace(owner, place);
      return json({ place }, duplicate ? 200 : 201);
    }
    if (method === "DELETE" && path === "/api/places") {
      const id = url.searchParams.get("id");
      if (!id) fail(400, "Select a place.");
      await store.deletePlace(owner, id);
      return json({ ok: true });
    }
    if (method === "POST" && path === "/api/reports") {
      const form = await (await body(request)).formData();
      const data = form.get("data");
      if (
        typeof data !== "string" ||
        data.length > 100_000 ||
        form.getAll("data").length !== 1 ||
        form.getAll("photo").length > 1 ||
        [...form.keys()].some((key) => key !== "data" && key !== "photo")
      )
        fail(400, "Check the information and try again.");
      const input = reportSchema.parse(JSON.parse(data));
      await loadBoundaries();
      const municipality = municipalityAt(input);
      if (!municipality) fail(400, "Choose a location in New Jersey.");
      const recent = (await store.listReports(owner)).filter(
        (report) => Date.parse(report.createdAt) > Date.now() - 3_600_000,
      );
      if (recent.length >= 12) fail(429, "Please wait before creating another report.");
      const photo = form.get("photo");
      if (
        photo &&
        (typeof photo === "string" || photo.type !== "image/jpeg" || photo.size > 3_000_000)
      )
        fail(400, "Use a JPEG photo smaller than 3 MB.");
      const id = crypto.randomUUID();
      const waterLevel = input.category === "Street flooding" ? (input.waterLevel ?? null) : null;
      const now = new Date().toISOString();
      const report: Report = {
        id,
        category: input.category,
        description: input.description,
        lat: input.lat,
        lng: input.lng,
        address: input.address,
        municipality,
        publicPin: input.publicPin,
        waterLevel,
        hasPhoto: !!photo,
        status: "draft_ready",
        createdAt: now,
        updatedAt: now,
        ...emailDraft({ ...input, municipality, hasPhoto: !!photo, waterLevel }),
      };
      try {
        if (photo instanceof File)
          await store.writePhoto(id, stripJpegMetadata(new Uint8Array(await photo.arrayBuffer())));
        await store.saveReport(owner, report);
      } catch (error) {
        await store.deletePhoto(id);
        throw error;
      }
      return json({ report }, 201);
    }
    const match = path.match(/^\/api\/reports\/([0-9a-f-]+)(\/photo)?$/);
    if (match) {
      const report = await store.findReport(owner, match[1]);
      if (!report) fail(404, "Report not found.");
      if (method === "GET" && match[2]) {
        const photo = report.hasPhoto ? await store.readPhoto(report.id) : null;
        if (!photo) fail(404, "Photo not found.");
        headers.set("Content-Type", "image/jpeg");
        if (url.searchParams.has("download"))
          headers.set(
            "Content-Disposition",
            `attachment; filename="hyron-${report.id.slice(0, 8)}.jpg"`,
          );
        return new Response(photo instanceof ArrayBuffer ? photo : new Uint8Array(photo).buffer, {
          headers,
        });
      }
      if (method === "PATCH" && !match[2]) {
        const changes = draftSchema.parse(await (await body(request)).json());
        const updated = { ...report, ...changes, updatedAt: new Date().toISOString() };
        if (updated.status === "resolved") updated.publicPin = false;
        await store.saveReport(owner, updated);
        return json({ report: updated });
      }
      if (method === "DELETE" && !match[2]) {
        await store.deletePhoto(report.id);
        await store.deleteReport(owner, report.id);
        return json({ ok: true });
      }
    }
    return json({ error: "API route not found." }, 404);
  } catch (error) {
    if (error instanceof RequestError) return json({ error: error.message }, error.status);
    if (error instanceof ZodError || error instanceof SyntaxError || error instanceof TypeError)
      return json({ error: "Check the information and try again." }, 400);
    if (error instanceof Error && /photo|JPEG/i.test(error.message))
      return json({ error: "Choose a JPEG photo smaller than 3 MB." }, 400);
    console.error(error);
    return json({ error: "That action could not be completed. Please try again." }, 500);
  }
}
