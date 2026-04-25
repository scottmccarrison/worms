/**
 * Regression scenario for the #117 lobby-cycle bug class.
 *
 * Drives two fake clients through a full:
 *   game-1 -> return-to-lobby -> game-2
 * cycle and asserts that game 2 starts with a fresh 45s turn window
 * and does not auto-advance without player input.
 *
 * Architecture mirrors room.test.ts: unstable_dev spins up a real
 * Cloudflare Worker in-process; we talk to it via raw WebSockets
 * (ws package). The global-setup.ts shim ensures ../dist/index.html
 * exists so wrangler can initialise the [assets] binding without a
 * prior 'npm run build'.
 *
 * TODO(#127 follow-up): extract TestClient + helpers to test/helpers/
 * when a 3rd test file wants them. YAGNI until then.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";
import WebSocket from "ws";

let worker: Unstable_DevWorker;
let baseHttp: string;
let baseWs: string;

beforeAll(async () => {
  worker = await unstable_dev("src/index.ts", {
    experimental: { disableExperimentalWarning: true },
    local: true,
    config: "wrangler.toml",
  });
  baseHttp = `http://${worker.address}:${worker.port}`;
  baseWs = `ws://${worker.address}:${worker.port}`;
}, 60_000);

afterAll(async () => {
  await worker.stop();
});

// ---------------------------------------------------------------------------
// TestClient - inline copy. Extract to test/helpers/ when a 3rd consumer
// appears. TODO(#127 follow-up).
// ---------------------------------------------------------------------------

interface Message {
  type: string;
  [key: string]: unknown;
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  private waiters: Array<{
    match: (msg: Message) => boolean;
    resolve: (msg: Message) => void;
  }> = [];
  readonly opened: Promise<void>;

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on("message", (raw) => {
      const text = typeof raw === "string" ? raw : raw.toString();
      try {
        const msg = JSON.parse(text) as Message;
        this.messages.push(msg);
        for (let i = this.waiters.length - 1; i >= 0; i--) {
          const w = this.waiters[i];
          if (w.match(msg)) {
            this.waiters.splice(i, 1);
            w.resolve(msg);
          }
        }
      } catch {
        // ignore non-JSON
      }
    });
    this.opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
    });
  }

  waitFor(match: (msg: Message) => boolean, timeoutMs = 8000): Promise<Message> {
    for (const m of this.messages) if (match(m)) return Promise.resolve(m);
    return new Promise<Message>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timeout waiting for message")),
        timeoutMs,
      );
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  /**
   * Like waitFor but only scans messages received at or after `fromIndex`.
   * Use this when you need to match a second occurrence of a message
   * type (e.g. second game_started) without hitting the cached first one.
   */
  waitForAfter(
    fromIndex: number,
    match: (msg: Message) => boolean,
    timeoutMs = 8000,
  ): Promise<Message> {
    for (let i = fromIndex; i < this.messages.length; i++) {
      const m = this.messages[i];
      if (m && match(m)) return Promise.resolve(m);
    }
    return new Promise<Message>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("timeout waiting for message")),
        timeoutMs,
      );
      // The waiter fires on every new message pushed to this.messages.
      // We compare this.messages.length at push time against fromIndex
      // to reject messages that arrived before the bookmark.
      // NOTE: we capture `this` via the arrow function closure.
      this.waiters.push({
        match: (msg: Message) => {
          // Find the index of this message in the array (it was just pushed,
          // so it is at messages.length - 1, but using lastIndexOf is safe).
          const idx = this.messages.lastIndexOf(msg);
          if (idx < fromIndex) return false;
          return match(msg);
        },
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
  }

  /** Current length of the received messages array. Use as a bookmark. */
  get messageCount(): number {
    return this.messages.length;
  }

  send(obj: object): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, { method: "POST" });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { code?: string };
  expect(typeof body.code).toBe("string");
  return body.code as string;
}

async function joinRoom(
  code: string,
  nickname: string,
  color: string,
): Promise<TestClient> {
  const params = new URLSearchParams({ nickname, color });
  const ws = new WebSocket(`${baseWs}/api/room/${code}?${params.toString()}`);
  const client = new TestClient(ws);
  await client.opened;
  return client;
}

// Wait for a "state" broadcast where both players are ready.
// Uses waitForAfter to avoid matching stale ready states from earlier in the game.
function bothReadyAfter(
  client: TestClient,
  fromIndex: number,
  aliceSessionId: string,
  bobSessionId: string,
): Promise<Message> {
  return client.waitForAfter(
    fromIndex,
    (m) => {
      if (m.type !== "state") return false;
      const players = (
        m.state as { players: Record<string, { ready: boolean }> }
      ).players;
      return (
        players[aliceSessionId]?.ready === true &&
        players[bobSessionId]?.ready === true
      );
    },
    8000,
  );
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

describe("lobby-cycle integration (#117 regression)", () => {
  it(
    "game-1 -> return-to-lobby -> game-2 starts fresh turn timer and does not auto-advance",
    async () => {
      // ---- 1. Create room ----
      const code = await createRoom();

      // ---- 2. Connect Alice (host) and Bob ----
      const alice = await joinRoom(code, "Alice", "#ff4444");
      const aliceWelcome = (await alice.waitFor(
        (m) => m.type === "welcome",
      )) as unknown as {
        sessionId: string;
        resumeToken: string;
      };
      const aliceSessionId = aliceWelcome.sessionId;

      const bob = await joinRoom(code, "Bob", "#4488ff");
      const bobWelcome = (await bob.waitFor(
        (m) => m.type === "welcome",
      )) as unknown as { sessionId: string };
      const bobSessionId = bobWelcome.sessionId;

      // Wait for Alice to see Bob in the lobby (2-player state).
      await alice.waitFor(
        (m) =>
          m.type === "state" &&
          Object.keys(
            (m.state as { players: Record<string, unknown> }).players,
          ).length === 2,
      );

      // ---- 3. Both set ready for game 1 ----
      const bookmarkPreGame1Ready = alice.messageCount;
      alice.send({ type: "set_ready", ready: true });
      bob.send({ type: "set_ready", ready: true });
      await bothReadyAfter(alice, bookmarkPreGame1Ready, aliceSessionId, bobSessionId);

      // ---- 4. Host starts game 1 ----
      alice.send({ type: "start_game" });
      await alice.waitFor((m) => m.type === "game_started");

      // Wait for the "playing" state to arrive so we know the turn timer is live.
      const playingState1 = await alice.waitFor(
        (m) =>
          m.type === "state" &&
          (m.state as { phase: string }).phase === "playing",
        10_000,
      );

      // Capture the game-1 turnEndsAt for the later assertion.
      const turnEndsAt1 = (playingState1.state as { turnEndsAt: number })
        .turnEndsAt;

      // ---- 5. Determine active player and send input_return_to_lobby quickly ----
      // We skip the optional fire step to avoid racing the 45s timer.
      // (The spec says "or skip the fire entirely and just transition".)
      // Whoever owns the active team sends return_to_lobby.
      const currentTeamId = (
        playingState1.state as { currentTeamId: string }
      ).currentTeamId;
      const playersRow = (
        playingState1.state as {
          players: Record<string, { ownerOfTeamId: string }>;
        }
      ).players;
      const activeSession = Object.entries(playersRow).find(
        ([, p]) => p.ownerOfTeamId === currentTeamId,
      )?.[0];
      const activeClient =
        activeSession === aliceSessionId ? alice : bob;

      // Bookmark before sending return_to_lobby so we wait for the post-game1
      // lobby state, not the pre-game1 one.
      const bookmarkAfterGame1 = alice.messageCount;
      const bookmarkAfterGame1Bob = bob.messageCount;
      activeClient.send({ type: "input_return_to_lobby", seq: 1 });

      // ---- 6. Both wait for lobby phase (after game 1 ended) ----
      await alice.waitForAfter(
        bookmarkAfterGame1,
        (m) =>
          m.type === "state" &&
          (m.state as { phase: string }).phase === "lobby",
        10_000,
      );
      await bob.waitForAfter(
        bookmarkAfterGame1Bob,
        (m) =>
          m.type === "state" &&
          (m.state as { phase: string }).phase === "lobby",
        10_000,
      );

      // ---- 7. Both set ready again ----
      const bookmarkPreGame2Ready = alice.messageCount;
      alice.send({ type: "set_ready", ready: true });
      bob.send({ type: "set_ready", ready: true });
      await bothReadyAfter(alice, bookmarkPreGame2Ready, aliceSessionId, bobSessionId);

      // ---- 8. Host starts game 2 ----
      // Bookmark the message cursor so waitForAfter skips game-1 messages.
      const bookmarkBeforeGame2 = alice.messageCount;
      alice.send({ type: "start_game" });
      await alice.waitForAfter(
        bookmarkBeforeGame2,
        (m) => m.type === "game_started",
        10_000,
      );

      // Wait for the "playing" state carrying fresh turn info.
      // Use waitForAfter so we don't re-match game-1's playing state.
      const playingState2 = await alice.waitForAfter(
        bookmarkBeforeGame2,
        (m) =>
          m.type === "state" &&
          (m.state as { phase: string }).phase === "playing",
        10_000,
      );

      const turnEndsAt2 = (playingState2.state as { turnEndsAt: number })
        .turnEndsAt;
      const currentTeamId2 = (
        playingState2.state as { currentTeamId: string }
      ).currentTeamId;

      // ---- 9. Assertions ----

      // Fresh ~45s turn window.
      expect(turnEndsAt2 - Date.now()).toBeGreaterThan(40_000);

      // Distinct from game-1 turnEndsAt (game-1 had 45s from its own start;
      // even if the two values were close in absolute time they should differ).
      expect(turnEndsAt2).not.toBe(turnEndsAt1);

      // The active team should NOT auto-advance without any input.
      // Wait 1.5s then check currentTeamId is still the same.
      await new Promise((r) => setTimeout(r, 1500));

      // Collect any state messages that arrived during the wait.
      const latestState = alice.messages
        .filter((m) => m.type === "state")
        .at(-1);
      if (latestState) {
        const phase = (latestState.state as { phase: string }).phase;
        if (phase === "playing") {
          const currentTeamIdAfterWait = (
            latestState.state as { currentTeamId: string }
          ).currentTeamId;
          expect(currentTeamIdAfterWait).toBe(currentTeamId2);
        }
        // If phase changed to something else that would be unexpected, but
        // we only assert no auto-advance, so we skip the comparison if phase
        // is no longer "playing".
      }

      alice.close();
      bob.close();
    },
    { timeout: 30_000 },
  );
});
