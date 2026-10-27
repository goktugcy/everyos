import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget =
  process.env.EVERYOS_API_URL ?? process.env.OTUKEN_API_URL ?? "http://127.0.0.1:7470";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      // Keep the browser's Host/Origin so the API's same-origin checks apply as in production.
      "/api": { target: apiTarget, changeOrigin: false, ws: true },
      // Installed app documents, modules, locales and icons are served by the API too.
      "/app-runtime": { target: apiTarget, changeOrigin: false },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 600,
  },
});
