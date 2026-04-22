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
  },
});
