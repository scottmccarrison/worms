/**
 * Reconnection token persistence for Colyseus rooms.
 *
 * Epic 10: when a client joins a room we stash
 * {roomId, reconnectionToken} in localStorage keyed by the 4-letter room code.
 * On cold boot (page reload / tab crash), BootScene looks up the cached token
 * and calls `client.reconnect(roomId, token)` to slide back into the running
 * room inside the server-side 60s grace window.
 *
 * Design notes:
 * - Single JSON blob under `worms.roomTokens.v1` rather than one key per code,
 *   so pruning stale entries is a single read-modify-write.
 * - Entries older than 10 minutes are pruned on every save. The server's grace
 *   is 60s but we keep extra slack so a quick browser-crash-then-reload still
 *   finds a token even if it's just outside grace (the reconnect attempt will
 *   fail cleanly and we fall back to home).
 * - Every localStorage access is wrapped in try/catch because private browsing,
 *   storage quota exceeded, and sandboxed iframes can all throw.
 * - All keys are uppercased on write and read so the on-disk format is
 *   case-stable regardless of how the room code shows up in a URL.
 * - Colyseus 0.15's `room.reconnectionToken` is already a composite
 *   "roomId:token" string, so the `token` field below is the full opaque
 *   string we pass to `client.reconnect()` and `roomId` is stored alongside
 *   purely for diagnostics / logging. Callers should pass `token` to
 *   `client.reconnect(token)` (NOT roomId + token).
 */

const KEY = "worms.roomTokens.v1";
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export interface StoredToken {
  code: string;
  roomId: string;
  token: string;
  ts: number;
}

type StoredTokenMap = Record<string, StoredToken>;

/**
 * Returns a handle to a Storage-like object, or null if it's not accessible
 * (Node test environment, private mode, sandboxed iframe). Caller is
 * expected to no-op on null.
 */
function getStorage(): Storage | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    return ls;
  } catch {
    return null;
  }
}

function readAll(): StoredTokenMap {
  const ls = getStorage();
  if (!ls) return {};
  try {
    const raw = ls.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as StoredTokenMap;
    }
    return {};
  } catch {
    return {};
  }
}

function writeAll(all: StoredTokenMap): void {
  const ls = getStorage();
  if (!ls) return;
  try {
    ls.setItem(KEY, JSON.stringify(all));
  } catch {
    // Quota exceeded / private mode write-blocked / sandboxed iframe.
    // Reconnect will fall back to a full rejoin; dropping the write is fine.
  }
}

/**
 * Persist the reconnection token for a room code. Prunes entries older than
 * 10 minutes as a side effect so the stored blob stays small.
 * No-op (swallows errors) when localStorage is unavailable.
 */
export function saveRoomToken(code: string, roomId: string, token: string): void {
  const all = readAll();
  const key = code.toUpperCase();
  all[key] = { code: key, roomId, token, ts: Date.now() };
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of Object.entries(all)) {
    if (!v || typeof v.ts !== "number" || v.ts < cutoff) {
      delete all[k];
    }
  }
  writeAll(all);
}

/**
 * Read a previously saved reconnection token.
 * Returns null when:
 * - the code has never been saved
 * - the stored entry has expired (> 10 minutes old)
 * - localStorage is unavailable
 * - the stored blob is malformed
 */
export function readRoomToken(code: string): StoredToken | null {
  const all = readAll();
  const key = code.toUpperCase();
  const entry = all[key];
  if (!entry) return null;
  if (typeof entry.ts !== "number" || Date.now() - entry.ts > MAX_AGE_MS) return null;
  if (typeof entry.roomId !== "string" || typeof entry.token !== "string") return null;
  return entry;
}

/**
 * Remove the stored entry for a code. Safe to call when no entry exists.
 */
export function clearRoomToken(code: string): void {
  const all = readAll();
  const key = code.toUpperCase();
  if (!(key in all)) return;
  delete all[key];
  writeAll(all);
}
