// Stub fetch handler. Real matchmaking + routing lands in commit 7.
// Room DO is exported here so wrangler.toml's binding resolves.

export { Room } from "./room.js";

export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
};
