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
      // Les routes /eval/auth/* (login, callback, logout) vivent côté serveur
      // Express, pas côté SPA. Sans ce proxy, Vite intercepte ces URLs et
      // renvoie l'index.html du SPA, le handler n'est jamais atteint.
      "^/eval/auth": "http://localhost:3001",
    },
  },
  build: {
    outDir: "../web-dist",
    emptyOutDir: true,
  },
});
