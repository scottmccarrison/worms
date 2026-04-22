/**
 * Resume-token persistence for Cloudflare Durable Object rooms (Epic 13).
 *
 * When the client joins a room the server sends a `welcome` message with a
 * `resumeToken`. We stash `{code, resumeToken, ts}` in localStorage keyed
 * by the room code. On cold boot (page reload / tab crash / network drop)
 * BootScene + scene-level reconnect loops look up the cached token and
 * call `joinRoom(wsBase, code, nick, color, resumeToken)`; the DO matches
 * the token against its storage and restores the player's sessionId +
 * color + team.
 *
 * Pre-Epic-13 shape had `{code, roomId, token, ts}` - roomId was a
 * Colyseus concept. With DOs, the code IS the DO's name (via
 * `idFromName(code)`), so storage simplifies to `{code, resumeToken, ts}`.
 *
 * Design notes:
 * - Single JSON blob under `worms.roomTokens.v1` so prune-on-write is one
 *   read-modify-write.
 * - Entries older than 10 minutes are pruned on every save. The server's
 *   grace is 60s but we keep slack so a quick reload after a 30s network
 *   hiccup still finds a token.
 * - Every localStorage access wrapped in try/catch (private browsing,
 *   quota exceeded, sandboxed iframes all throw).
 * - Keys uppercased on read + write so on-disk format is case-stable.
 */

const KEY = "worms.roomTokens.v1";
const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

export interface StoredToken {
  code: string;
  resumeToken: string;
  ts: number;
}

type StoredTokenMap = Record<string, StoredToken>;

/**
 * Storage handle or null if unavailable (Node test env, private mode,
 * sandboxed iframe). Caller is expected to no-op on null.
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
    // Quota / private mode / sandboxed iframe. Reconnect will fall back
    // to a full rejoin; dropping the write is fine.
  }
}

/**
 * Persist the resume token for a room code. Prunes entries older than
 * 10 minutes as a side effect so the stored blob stays small.
 * No-op (swallows errors) when localStorage is unavailable.
 */
export function saveRoomToken(code: string, resumeToken: string): void {
  const all = readAll();
  const key = code.toUpperCase();
  all[key] = { code: key, resumeToken, ts: Date.now() };
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of Object.entries(all)) {
    if (!v || typeof v.ts !== "number" || v.ts < cutoff) {
      delete all[k];
    }
  }
  writeAll(all);
}

/**
 * Read a previously saved resume token.
 * Returns null when:
 * - the code has never been saved
 * - the stored entry has expired (> 10 minutes old)
 * - localStorage is unavailable
 * - the stored blob is malformed (including pre-Epic-13 `{roomId, token}` shape)
 */
export function readRoomToken(code: string): StoredToken | null {
  const all = readAll();
  const key = code.toUpperCase();
  const entry = all[key];
  if (!entry) return null;
  if (typeof entry.ts !== "number" || Date.now() - entry.ts > MAX_AGE_MS) return null;
  if (typeof entry.resumeToken !== "string") return null;
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
