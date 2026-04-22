import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  publicDir: "public",
  // Epic 13: served from mccarrison.me/worms/ behind Cloudflare Workers.
  // Built asset URLs (`<script src="/worms/assets/...">`) need this prefix
  // so the page loads correctly under the subpath route. Dev server (:5173)
  // still serves at the root by default; `base` is a build-time transform.
  base: "/worms/",
  build: {
    outDir: "dist",
    target: "es2022",
    sourcemap: true,
  },
  server: {
    port: 5173,
    open: false,
    // Dev proxy: the client computes API paths relative to BASE_URL
    // (so "POST /worms/api/room" in both dev and prod). The worker
    // running under `wrangler dev --local` serves at :8787 without the
    // /worms prefix, so rewrite the path before proxying. WebSocket
    // upgrades are proxied identically with ws: true.
    proxy: {
      "/worms/api": {
        target: "http://localhost:8787",
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/worms/, ""),
      },
    },
  },
});
