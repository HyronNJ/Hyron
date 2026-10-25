import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

// Bundle browser workers and copy their runtimes.
fs.mkdirSync("public/maplibre", { recursive: true });
for (const name of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"])
  fs.copyFileSync(
    path.join("node_modules/maplibre-gl/dist", name),
    path.join("public/maplibre", name),
  );
fs.copyFileSync("node_modules/maplibre-gl/LICENSE.txt", "public/maplibre/LICENSE.txt");
fs.mkdirSync("public/onnx", { recursive: true });
for (const name of ["ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"])
  fs.copyFileSync(
    path.join("node_modules/onnxruntime-web/dist", name),
    path.join("public/onnx", name),
  );
await build({
  entryPoints: ["workers/photo.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "public/photo-worker.js",
  alias: { "onnxruntime-web/webgpu": "onnxruntime-web/wasm" },
  legalComments: "eof",
  define: { "process.env.NODE_ENV": '"production"' },
});
await build({
  entryPoints: ["workers/forecast.ts"],
  bundle: true,
  minify: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "public/forecast-worker.js",
  legalComments: "eof",
});
console.log("Prepared self-hosted map, forecast and photo workers.");
