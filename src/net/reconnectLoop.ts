import type { Client, Room } from "colyseus.js";

/**
 * Default exponential-ish backoff used by LobbyScene + GameScene when an
 * unexpected disconnect fires. Totals ~62s which lines up with the server's
 * 60s allowReconnection grace window (DISCONNECT_GRACE_MS). If all attempts
 * fail we've exited the grace window anyway so the token is stale.
 */
export const DEFAULT_BACKOFFS_MS: readonly number[] = [
  500, 1000, 2000, 4000, 8000, 16000, 30000,
] as const;

export interface RunReconnectLoopParams {
  /** Colyseus Client used for the reconnect RPC. */
  client: Client;
  /** The cached `room.reconnectionToken` (Colyseus 0.15 composite string). */
  token: string;
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

export interface RunReconnectLoopResult<S> {
  ok: boolean;
  /** The newly-reconnected Room on success. */
  room?: Room<S>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drive the client-side reconnect backoff loop.
 *
 * Per-attempt flow:
 *   1. sleep(backoff[i])
 *   2. onAttempt(i + 1)
 *   3. try client.reconnect(token). Success -> return { ok: true, room }.
 *   4. Failure -> keep looping.
 *
 * After all attempts fail, resolves { ok: false }. Caller decides whether
 * to drop the token + send the user home.
 *
 * Does NOT touch localStorage directly. Does NOT show UI. Pure network
 * choreography so it's trivially unit-testable and reusable across scenes.
 */
export async function runReconnectLoop<S>(
  params: RunReconnectLoopParams,
): Promise<RunReconnectLoopResult<S>> {
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
      const room = await params.client.reconnect<S>(params.token);
      return { ok: true, room };
    } catch {
      // Keep trying. A definitive "room gone" error still re-enters the
      // loop - that's fine because the next attempt will also fail fast
      // and we're bounded by the backoff schedule.
    }
  }
  return { ok: false };
}
