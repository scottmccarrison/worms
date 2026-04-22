/**
 * Native-WebSocket transport for the Worms room protocol (Epic 13).
 *
 * Replaces colyseus.js' `Client` + `Room` classes with a thin hand-rolled
 * wrapper. The Cloudflare Worker + Durable Object backend speaks the JSON
 * protocol defined in `shared/protocol.ts`; this module is the browser-side
 * half of that contract.
 *
 * Design notes:
 * - Exactly one WebSocket per room. Reconnect opens a fresh socket.
 * - `createRoom` is a POST + joinRoom composition; `joinRoom` is the only
 *   path that actually opens the WebSocket.
 * - `state` is a live mutable snapshot that the caller can read at any time;
 *   subscribers registered via `onStateChange` fire on every `state`
 *   message from the server.
 * - `onMessage` dispatches typed server messages by their `type` discriminator.
 *   Returns an unsub function so listeners can be torn down on scene change.
 * - `send` only accepts well-typed ClientMsg values. Callers build the
 *   discriminated-union object and pass it; we stringify + send.
 * - `leave` sends a clean close (1000); `onClose` fires with the close code
 *   once the socket is actually closed (whether we initiated it or not).
 *
 * Offline mode contract: this module must NEVER be imported from the
 * offline path. BootScene short-circuits to GameScene on `?offline=1`
 * before any network code is touched; a test in `bootSceneOffline.test.ts`
 * codifies that invariant by spying on these entry points.
 */

import type { ClientMsg, LobbyState, ServerMsg } from "../../shared/protocol";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Narrow a ServerMsg to the variant whose `type` field equals `T`. */
type ServerMsgOf<T extends ServerMsg["type"]> = Extract<ServerMsg, { type: T }>;

/**
 * Live handle for a joined room.
 *
 * Callers treat this as an opaque object: read `state` for the latest
 * snapshot, subscribe via `onStateChange` / `onMessage` / `onClose`, send
 * client messages via `send`, and call `leave` when done.
 */
export interface RoomHandle {
  readonly sessionId: string;
  readonly code: string;
  readonly resumeToken: string;
  /** Latest LobbyState snapshot. Updated in place on every `state` message. */
  readonly state: LobbyState;
  /** Subscribe to state changes. Returns an unsub function. */
  onStateChange(cb: (state: LobbyState) => void): () => void;
  /** Subscribe to typed server messages by `type`. Returns an unsub function. */
  onMessage<T extends ServerMsg["type"]>(type: T, cb: (msg: ServerMsgOf<T>) => void): () => void;
  /** Send a client message. Silently drops if the socket is not open. */
  send(msg: ClientMsg): void;
  /** Cleanly close the WebSocket. `onClose` subscribers fire with code 1000. */
  leave(): void;
  /** Subscribe to the final close event. Returns an unsub function. */
  onClose(cb: (code: number) => void): () => void;
}

// ---------------------------------------------------------------------------
// createRoom / joinRoom
// ---------------------------------------------------------------------------

/**
 * Ask the matchmaker for a fresh room code, then join it. Single round-trip
 * from the caller's POV.
 *
 * Calls `POST ${httpBase}/api/room` with a JSON body `{nickname, color}`; the
 * worker generates a unique 4-letter code and returns `{code}`. We then open
 * a WebSocket to `/api/room/{code}` using the WS-protocol variant of the
 * same origin.
 */
export async function createRoom(
  baseUrl: string,
  nickname: string,
  color: string,
): Promise<RoomHandle> {
  const { http, ws } = splitBaseUrl(baseUrl);
  const res = await fetch(`${http}/api/room`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nickname, color }),
  });
  if (!res.ok) {
    throw new Error(`createRoom failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { code?: string };
  if (!body.code) {
    throw new Error("createRoom failed: worker returned no code");
  }
  return joinRoom(ws, body.code, nickname, color);
}

/**
 * Open a WebSocket to an existing room and wait for the initial `welcome`
 * message before resolving. The `welcome` carries our assigned sessionId,
 * resume token, and full LobbyState snapshot.
 *
 * If `resumeToken` is provided the server attempts to resume an existing
 * player slot (Epic 10 reconnect path). On match, it preserves our old
 * sessionId + color + team. On miss, we get a fresh slot as if joining
 * normally.
 *
 * `baseUrl` must be a ws:// or wss:// origin (no trailing slash).
 */
export async function joinRoom(
  baseUrl: string,
  code: string,
  nickname: string,
  color: string,
  resumeToken?: string,
): Promise<RoomHandle> {
  const { ws } = splitBaseUrl(baseUrl);
  const qs = new URLSearchParams();
  qs.set("nickname", nickname);
  qs.set("color", color);
  if (resumeToken) qs.set("resumeToken", resumeToken);
  const url = `${ws}/api/room/${encodeURIComponent(code.toUpperCase())}?${qs.toString()}`;

  const socket = new WebSocket(url);

  const stateSubs = new Set<(state: LobbyState) => void>();
  const messageSubs = new Map<string, Set<(msg: ServerMsg) => void>>();
  const closeSubs = new Set<(code: number) => void>();

  // Mutable reference: we swap the backing object after receiving `welcome`
  // and on every subsequent `state` message. Callers hold `handle.state` so
  // we replace the object's enumerable fields in place rather than the
  // reference itself (see updateStateInPlace below).
  let currentState: LobbyState | null = null;
  let sessionId = "";
  let resumeTokenOut = "";

  const dispatchMessage = (msg: ServerMsg): void => {
    const subs = messageSubs.get(msg.type);
    if (!subs) return;
    for (const cb of subs) {
      try {
        cb(msg);
      } catch (err) {
        // Don't let one listener's throw break the others.
        console.error("[wsClient] onMessage handler threw:", err);
      }
    }
  };

  const dispatchStateChange = (): void => {
    if (!currentState) return;
    for (const cb of stateSubs) {
      try {
        cb(currentState);
      } catch (err) {
        console.error("[wsClient] onStateChange handler threw:", err);
      }
    }
  };

  // We resolve the promise on the first `welcome` message. Anything else
  // (immediate close, error event, timeout) rejects.
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    const settleOk = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const settleErr = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    socket.addEventListener("open", () => {
      // WebSocket-level open isn't enough: we wait for the `welcome`
      // application-layer message before surfacing a usable handle.
    });

    socket.addEventListener("message", (ev: MessageEvent) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data as string) as ServerMsg;
      } catch (err) {
        console.error("[wsClient] malformed server message:", err);
        return;
      }
      if (!msg || typeof msg.type !== "string") return;

      if (msg.type === "welcome") {
        sessionId = msg.sessionId;
        resumeTokenOut = msg.resumeToken;
        currentState = msg.state;
        settleOk();
        // Welcome ALSO fires onStateChange so callers get a single code
        // path for "state arrived" regardless of first vs subsequent.
        dispatchStateChange();
        dispatchMessage(msg);
        return;
      }

      if (msg.type === "state") {
        // Replace the state reference. We do NOT mutate in place because
        // the public `RoomHandle.state` getter below reads `currentState`
        // every time, so swapping the inner variable is enough.
        currentState = msg.state;
        dispatchStateChange();
        // Also dispatch to raw onMessage("state", ...) subscribers for
        // symmetry with other server messages.
        dispatchMessage(msg);
        return;
      }

      dispatchMessage(msg);
    });

    socket.addEventListener("close", (ev: CloseEvent) => {
      settleErr(new Error(`WebSocket closed before welcome (code ${ev.code})`));
      for (const cb of closeSubs) {
        try {
          cb(ev.code);
        } catch (err) {
          console.error("[wsClient] onClose handler threw:", err);
        }
      }
    });

    socket.addEventListener("error", () => {
      // An error event typically precedes a close event; we let the close
      // handler finalize. Don't settleErr here because we'd double-settle.
    });
  });

  await ready;

  if (!currentState) {
    // Defensive: settleOk fires only after currentState is set, but the
    // type system can't see that. Belt + braces.
    throw new Error("joinRoom: welcome arrived without state");
  }

  const handle: RoomHandle = {
    get sessionId(): string {
      return sessionId;
    },
    get code(): string {
      return currentState?.code ?? code.toUpperCase();
    },
    get resumeToken(): string {
      return resumeTokenOut;
    },
    get state(): LobbyState {
      // We asserted above; non-null within the handle's lifetime.
      return currentState as LobbyState;
    },
    onStateChange(cb) {
      stateSubs.add(cb);
      return () => {
        stateSubs.delete(cb);
      };
    },
    onMessage(type, cb) {
      let set = messageSubs.get(type);
      if (!set) {
        set = new Set();
        messageSubs.set(type, set);
      }
      const wrapped = cb as (msg: ServerMsg) => void;
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    },
    send(msg) {
      if (socket.readyState !== WebSocket.OPEN) return;
      socket.send(JSON.stringify(msg));
    },
    leave() {
      try {
        socket.close(1000, "client leave");
      } catch {
        // Already closed / closing. The close listener will still fire.
      }
    },
    onClose(cb) {
      closeSubs.add(cb);
      return () => {
        closeSubs.delete(cb);
      };
    },
  };
  return handle;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Accept either an http(s) or ws(s) base URL and return both variants so
 * callers can hit the REST endpoint + WebSocket on the same origin.
 */
function splitBaseUrl(base: string): { http: string; ws: string } {
  const trimmed = base.replace(/\/+$/, "");
  if (trimmed.startsWith("ws://")) {
    return { http: `http://${trimmed.slice(5)}`, ws: trimmed };
  }
  if (trimmed.startsWith("wss://")) {
    return { http: `https://${trimmed.slice(6)}`, ws: trimmed };
  }
  if (trimmed.startsWith("http://")) {
    return { http: trimmed, ws: `ws://${trimmed.slice(7)}` };
  }
  if (trimmed.startsWith("https://")) {
    return { http: trimmed, ws: `wss://${trimmed.slice(8)}` };
  }
  throw new Error(`wsClient: unsupported base URL ${base}`);
}
