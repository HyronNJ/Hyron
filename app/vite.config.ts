import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { PREFS_SCRIPT } from "./lib/prefs";

export default defineConfig({
  plugins: [
    react(),
    {
      // Apply saved preferences before the first paint.
      name: "hyron-prefs",
      transformIndexHtml: () => [
        { tag: "script", children: PREFS_SCRIPT, injectTo: "head-prepend" },
        {
          tag: "style",
          children: ':root[data-theme="dark"]{color-scheme:dark;background:#0d131d}',
          injectTo: "head-prepend",
        },
      ],
    },
  ],
  resolve: { alias: { "@": fileURLToPath(new URL(".", import.meta.url)) } },
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    // Preserve the page origin through the API proxy.
    proxy: { "/api": { target: "http://127.0.0.1:3001", changeOrigin: false } },
  },
});
