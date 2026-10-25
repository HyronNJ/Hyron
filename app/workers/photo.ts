import { env, pipeline } from "@huggingface/transformers";
env.allowLocalModels = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.numThreads = 1;
  env.backends.onnx.wasm.wasmPaths = {
    mjs: new URL("/onnx/ort-wasm-simd-threaded.mjs", self.location.origin).href,
    wasm: new URL("/onnx/ort-wasm-simd-threaded.wasm", self.location.origin).href,
  };
}
const prompts = [
  "a photo of a storm drain blocked by leaves and litter",
  "a photo of a street covered by standing flood water",
  "a photo of debris obstructing a road or drain",
  "a photo of road erosion or washed out pavement",
  "a photo unrelated to street flooding or storm drains",
];
const categories = [
  "Blocked drain",
  "Street flooding",
  "Debris or obstruction",
  "Erosion or road damage",
  "Other",
];
self.onmessage = async (event) => {
  try {
    const classify = await pipeline(
      "zero-shot-image-classification",
      "Xenova/clip-vit-base-patch32",
      {
        revision: "d15189d7028b43f1d3e65039190477f6af591c2a",
        dtype: "q8",
        device: "wasm",
        progress_callback: (p) => {
          if ("progress" in p) self.postMessage({ type: "progress", progress: p.progress });
        },
      },
    );
    const result = await classify(event.data.image, prompts);
    const best = Array.isArray(result) ? result[0] : null;
    const category =
      best && "label" in best && "score" in best && Number(best.score) >= 0.35
        ? (categories[prompts.indexOf(String(best.label))] ?? "Other")
        : "Other";
    self.postMessage({ type: "result", category });
  } catch {
    self.postMessage({ type: "error" });
  }
};
