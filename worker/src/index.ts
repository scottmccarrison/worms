/**
 * worms-api fetch handler.
 *
 * Routes (relative to PATH_PREFIX; default "/worms"):
 *   POST /api/room              create a room, return {code}
 *   GET  /api/room/{CODE}       WebSocket upgrade -> Room DO
 *   *                           static asset (env.ASSETS.fetch)
 *
 * The bare-prefix redirect (`/worms` -> `/worms/`) matches mini-golf's
 * pattern so relative asset URLs inside index.html resolve cleanly.
 */

export { Room } from "./room.js";

import { generateCode } from "./codegen.js";

interface Env {
  PATH_PREFIX?: string;
  ROOMS: DurableObjectNamespace;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

const CODE_CLAIM_MAX_ATTEMPTS = 10;

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const prefix = env.PATH_PREFIX ?? "/worms";

    // Bare-prefix redirect.
    if (url.pathname === prefix) {
      return Response.redirect(`${url.origin}${prefix}/`, 301);
    }

    // Strip the configured prefix so internal routes see paths like
    // "/api/room" regardless of deployment target.
    let path = url.pathname;
    if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length) || "/";

    // POST /api/room -> create a fresh room, return its code.
    if (path === "/api/room" && request.method === "POST") {
      const code = await claimFreshRoom(env);
      if (!code) {
        return json({ error: "no_code_available" }, 503);
      }
      return json({ code });
    }

    // GET /api/room/{CODE} with WebSocket upgrade -> route to the DO.
    // Match the codegen alphabet exactly (no I, no O). Using [A-Z]{4}
    // would accept codes the generator never produces and let an
    // attacker squat DO slots at predictable ids.
    const roomMatch = path.match(/^\/api\/room\/([ABCDEFGHJKLMNPQRSTUVWXYZ]{4})$/);
    if (roomMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket", { status: 426 });
      }
      const code = roomMatch[1];
      const id = env.ROOMS.idFromName(code);
      const stub = env.ROOMS.get(id);
      return stub.fetch(request);
    }

    // Static asset path: rewrite the URL so the asset bundle (which
    // is keyed off the unprefixed paths like /assets/index-XYZ.js)
    // receives the stripped request.
    const assetUrl = new URL(request.url);
    assetUrl.pathname = path;
    return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
  },
};

/**
 * Pick a random 4-letter code, ask the corresponding DO to claim it,
 * and retry on collision. idFromName is deterministic so two requests
 * with the same code land on the same DO; the DO's /init handler
 * rejects with 409 if another code already claimed that slot.
 */
async function claimFreshRoom(env: Env): Promise<string | null> {
  for (let i = 0; i < CODE_CLAIM_MAX_ATTEMPTS; i++) {
    const code = generateCode();
    const id = env.ROOMS.idFromName(code);
    const stub = env.ROOMS.get(id);
    const res = await stub.fetch("https://room/init", {
      method: "POST",
      body: JSON.stringify({ code, claim: true }),
      headers: { "content-type": "application/json" },
    });
    if (res.ok) return code;
    // 409 means the DO already has a different code claimed; keep
    // trying. Any other non-2xx is a hard error.
    if (res.status !== 409) return null;
  }
  return null;
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
