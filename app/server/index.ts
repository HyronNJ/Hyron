import express, { type ErrorRequestHandler } from "express";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { workspace } from "@/server/workspace";
import * as database from "@/server/database";
import { GET as weather } from "@/server/providers/weather";
import { GET as alerts } from "@/server/providers/alerts";
import { GET as gauges } from "@/server/providers/gauges";
import { GET as search } from "@/server/providers/search";

const app = express();
app.disable("x-powered-by");
app.use((_request, response, next) => {
  response.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

// Provider handlers use standard Request/Response objects, independently of Express.
const providers = { weather, alerts, gauges, search };
for (const [name, handler] of Object.entries(providers)) {
  app.get(`/api/${name}`, async (request, response) => {
    const url = new URL(request.originalUrl, "http://localhost");
    const result = await handler(new Request(url));
    result.headers.forEach((value, key) => response.setHeader(key, value));
    response.status(result.status).send(Buffer.from(await result.arrayBuffer()));
  });
}

app.use("/api", express.raw({ type: () => true, limit: 3_200_000 }), async (request, response) => {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  const url = new URL(request.originalUrl, `${request.protocol}://${request.get("host")}`);
  const result = await workspace(
    new Request(url, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method)
        ? undefined
        : new Uint8Array(request.body ?? []),
    }),
    database,
  );
  result.headers.forEach((value, key) => response.setHeader(key, value));
  response.status(result.status).send(Buffer.from(await result.arrayBuffer()));
});

if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_request, response) => response.sendFile(resolve("dist/index.html")));
}

const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  if (error.type === "entity.too.large") {
    response.status(413).json({ error: "That request is too large." });
    return;
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    response.status(400).json({ error: "Check the information and try again." });
    return;
  }
  if (/photo|JPEG/i.test(error.message ?? "")) {
    response.status(400).json({ error: "Choose a JPEG photo smaller than 3 MB." });
    return;
  }
  console.error(error);
  response.status(500).json({ error: "That action could not be completed. Please try again." });
};
app.use(handleError);

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? "127.0.0.1";
app.listen(port, host, () => console.log(`Hyron API: http://${host}:${port}`));
