import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Servi sous /eval par le serveur MCP → base "/eval/".
// Build → ../web-dist (servi en statique par src/index.ts).
// Dev : Vite :5173, proxy /api/* → serveur Express local :3001.
export default defineConfig({
  base: "/eval/",
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Regex (pas un préfixe) sinon /api.ts (module front) part au proxy.
      "^/api/": "http://localhost:3001",
    },
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
});
