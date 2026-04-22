/**
 * Client-side reconnect backoff loop (Epic 10 + 13).
 *
 * Pre-Epic-13 this called `client.reconnect(token)` against Colyseus. With
 * Cloudflare Workers + Durable Objects we call `netClient.joinRoom(code,
 * nickname, color, resumeToken)` - the DO side of the protocol matches
 * the resume token against its storage and restores the player's session.
 *
 * Per-attempt flow:
 *   1. sleep(backoff[i])
 *   2. onAttempt(i + 1)
 *   3. try netClient.joinRoom(...). Success -> return { ok: true, room }.
 *   4. Failure -> keep looping.
 *
 * After all attempts fail, resolves { ok: false }. Caller decides whether
 * to drop the token + send the user home.
 *
 * Does NOT touch localStorage directly. Does NOT show UI. Pure network
 * choreography so it's trivially unit-testable and reusable across scenes.
 */

import type { NetClient } from "./client";
import type { RoomHandle } from "./wsClient";

/**
 * Default exponential-ish backoff used by LobbyScene + GameScene when an
 * unexpected disconnect fires. Totals ~62s which lines up with the server's
 * 60s allowReconnection grace window (DISCONNECT_GRACE_MS). If all attempts
 * fail we've exited the grace window anyway so the token is stale.
 */
export const DEFAULT_BACKOFFS_MS: readonly number[] = [
  // First attempt fires immediately - a dropped WebSocket often recovers
  // within a tick (wifi flicker, tab focus event) so there's no reason to
  // wait half a second before probing. Subsequent attempts ramp up toward
  // the 60s grace window.
  0, 500, 1000, 2000, 4000, 8000, 15000, 30000,
] as const;

export interface RunReconnectLoopParams {
  /** NetClient carrying bound joinRoom. */
  netClient: NetClient;
  /** 4-letter room code. */
  code: string;
  /** Nickname to send on reconnect. DO prefers the resume-token-backed
   *  stored nickname, so this is effectively a placeholder. */
  nickname: string;
  /** Color fallback; same placeholder caveat as nickname. */
  color: string;
  /** Resume token stashed on the initial join (clientStorage.readRoomToken). */
  resumeToken: string;
  /** Per-attempt backoff in ms. Defaults to DEFAULT_BACKOFFS_MS. */
  backoffs?: readonly number[];
  /** Called at the start of each attempt with 1-indexed attempt number. */
  onAttempt?: (attempt: number) => void;
  /**
   * Await helper. Default uses setTimeout + Promise. Injectable so tests
   * can resolve immediately instead of actually waiting.
   */
  sleep?: (ms: number) => Promise<void>;
}

export interface RunReconnectLoopResult {
  ok: boolean;
  /** The newly-joined RoomHandle on success. */
  room?: RoomHandle;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function runReconnectLoop(
  params: RunReconnectLoopParams,
): Promise<RunReconnectLoopResult> {
  const backoffs = params.backoffs ?? DEFAULT_BACKOFFS_MS;
  const sleep = params.sleep ?? defaultSleep;

  for (let i = 0; i < backoffs.length; i++) {
    const delay = backoffs[i];
    if (typeof delay === "number" && delay > 0) {
      await sleep(delay);
    }
    const attempt = i + 1;
    params.onAttempt?.(attempt);
    try {
      const room = await params.netClient.joinRoom(
        params.code,
        params.nickname,
        params.color,
        params.resumeToken,
      );
      return { ok: true, room };
    } catch {
      // Keep trying. A definitive "room gone" error still re-enters the
      // loop - that's fine because the next attempt will also fail fast
      // and we're bounded by the backoff schedule.
    }
  }
  return { ok: false };
}
