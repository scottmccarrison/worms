// Stub entry. Real fetch handler lands in commit 7.
// Room DO class re-export also lands later; keep the placeholder
// so wrangler.toml's DO binding has a referenced class.

export class Room {
  constructor(_state: DurableObjectState, _env: unknown) {
    // placeholder
  }
  async fetch(_request: Request): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  }
}

export default {
  async fetch(_request: Request, _env: unknown, _ctx: ExecutionContext): Promise<Response> {
    return new Response("not implemented", { status: 501 });
  },
};
