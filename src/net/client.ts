/**
 * Net-client bootstrap (Epic 13).
 *
 * Replaces the old Colyseus `createNetClient` factory. The WebSocket
 * transport is provided by `wsClient.ts`; this file just computes the
 * right ws:// / http:// base URLs for the current page and re-exports
 * the room factories so callers have a single import site.
 *
 * In dev (Vite :5173), the worker runs on the same host under `npx
 * wrangler dev --local` at :8787; Vite is configured with a proxy so
 * API + WebSocket traffic goes to the same origin the page was served
 * from. In prod we're served under `mccarrison.me/worms/` so same-origin
 * is the only sensible default.
 */

import { createRoom, joinRoom } from "./wsClient";
import type { RoomHandle } from "./wsClient";

export type { RoomHandle } from "./wsClient";
export { createRoom, joinRoom } from "./wsClient";

/**
 * Vite's configured base path, with the trailing slash trimmed so it
 * concatenates cleanly with /api paths. Prod deploys under
 * `mccarrison.me/worms/` so BASE_URL = "/worms/"; the trimmed value is
 * "/worms" and API calls go to "/worms/api/room". In dev this is still
 * "/worms/" (see vite.config.ts base), and Vite's proxy rewrites it to
 * the worker's unprefixed path on :8787.
 */
function basePath(): string {
  const raw = import.meta.env.BASE_URL ?? "/";
  return raw.replace(/\/$/, "");
}

/**
 * WebSocket base URL (`ws://` or `wss://`) derived from the page origin
 * plus Vite's configured base path. The Worker is mounted at
 * `mccarrison.me/worms/*` so WebSocket upgrades must target
 * `wss://mccarrison.me/worms/api/room/...` - not the bare origin.
 */
export function wsBaseUrl(): string {
  const { protocol, host } = window.location;
  const wsProto = protocol === "https:" ? "wss" : "ws";
  return `${wsProto}://${host}${basePath()}`;
}

/**
 * HTTP(S) base URL derived from the page origin + Vite base path. Used
 * for `POST /api/room` matchmaking + any future REST-shaped endpoints.
 */
export function httpBaseUrl(): string {
  const { protocol, host } = window.location;
  return `${protocol}//${host}${basePath()}`;
}

/**
 * Convenience bundle: both base URLs in one call.
 * Dev shortcut for callers that want to pass both sides to room factories.
 */
export function netBaseUrl(): { http: string; ws: string } {
  return { http: httpBaseUrl(), ws: wsBaseUrl() };
}

/**
 * Stable handle returned by `createNetClient`. Scenes hold this to re-use
 * the computed base URLs across multiple room operations (create / join /
 * reconnect) without re-reading `window.location` every time.
 */
export interface NetClient {
  readonly httpBase: string;
  readonly wsBase: string;
  createRoom(nickname: string, color: string): Promise<RoomHandle>;
  joinRoom(
    code: string,
    nickname: string,
    color: string,
    resumeToken?: string,
  ): Promise<RoomHandle>;
}

/**
 * Build a NetClient tied to the current page origin. Pure function; no
 * network calls happen until `createRoom` / `joinRoom` is invoked.
 */
export function createNetClient(): NetClient {
  const httpBase = httpBaseUrl();
  const wsBase = wsBaseUrl();
  return {
    httpBase,
    wsBase,
    createRoom: (nickname, color) => createRoom(httpBase, nickname, color),
    joinRoom: (code, nickname, color, resumeToken) =>
      joinRoom(wsBase, code, nickname, color, resumeToken),
  };
}
