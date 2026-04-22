import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Unstable_DevWorker, unstable_dev } from "wrangler";
import WebSocket from "ws";

/**
 * Integration tests for the Room Durable Object via wrangler's
 * unstable_dev. Spins up a local worker with in-process Durable
 * Objects + isolated storage, drives the lobby through WebSockets,
 * and asserts on the broadcast stream.
 *
 * We use the `ws` npm package to open the WebSocket against the dev
 * worker's port directly; wrangler's internal fetch rejects the
 * Upgrade header so we go around it and talk to the bound port.
 */

let worker: Unstable_DevWorker;
let baseHttp: string;
let baseWs: string;

beforeAll(async () => {
  worker = await unstable_dev("src/index.ts", {
    experimental: { disableExperimentalWarning: true },
    local: true,
    config: "wrangler.toml",
    // Assets directory is configured to ../dist; we don't need real
    // static assets for these tests, a stub `dist/index.html` lives
    // in the repo root so wrangler can initialise the binding.
  });
  baseHttp = `http://${worker.address}:${worker.port}`;
  baseWs = `ws://${worker.address}:${worker.port}`;
}, 60_000);

afterAll(async () => {
  await worker.stop();
});

interface Message {
  type: string;
  [key: string]: unknown;
}

class TestClient {
  readonly ws: WebSocket;
  readonly messages: Message[] = [];
  private waiters: Array<{ match: (msg: Message) => boolean; resolve: (msg: Message) => void }> =
    [];
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
        // ignore
      }
    });
    this.opened = new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", (e) => reject(e));
    });
  }

  waitFor(match: (msg: Message) => boolean, timeoutMs = 5000): Promise<Message> {
    for (const m of this.messages) if (match(m)) return Promise.resolve(m);
    return new Promise<Message>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      this.waiters.push({
        match,
        resolve: (m) => {
          clearTimeout(t);
          resolve(m);
        },
      });
    });
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

async function createRoom(): Promise<string> {
  const res = await fetch(`${baseHttp}/api/room`, { method: "POST" });
  expect(res.ok).toBe(true);
  const body = (await res.json()) as { code?: string };
  expect(typeof body.code).toBe("string");
  expect(body.code).toMatch(/^[A-Z]{4}$/);
  return body.code as string;
}

async function joinRoom(
  code: string,
  nickname: string,
  color: string,
  resumeToken?: string,
): Promise<TestClient> {
  const params = new URLSearchParams({ nickname, color });
  if (resumeToken) params.set("resumeToken", resumeToken);
  const ws = new WebSocket(`${baseWs}/api/room/${code}?${params.toString()}`);
  const client = new TestClient(ws);
  await client.opened;
  return client;
}

describe("Room integration", () => {
  it("POST /api/room returns a 4-letter code", async () => {
    const code = await createRoom();
    expect(code).toMatch(/^[A-Z]{4}$/);
    expect(code).not.toMatch(/[IO]/);
  });

  it("a client can join a created room and receives a welcome", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    const welcome = await alice.waitFor((m) => m.type === "welcome");
    expect(welcome.type).toBe("welcome");
    expect(typeof welcome.sessionId).toBe("string");
    expect(typeof welcome.resumeToken).toBe("string");
    const state = welcome.state as { players: Record<string, unknown>; hostSessionId: string };
    expect(state.hostSessionId).toBe(welcome.sessionId);
    expect(Object.keys(state.players)).toHaveLength(1);
    alice.close();
  });

  it("broadcasts full state when a second player joins", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    await alice.waitFor((m) => m.type === "welcome");

    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");

    const stateMsg = await alice.waitFor(
      (m) =>
        m.type === "state" &&
        Object.keys((m.state as { players: Record<string, unknown> }).players).length === 2,
    );
    const state = stateMsg.state as { players: Record<string, { nickname: string }> };
    const nicknames = Object.values(state.players)
      .map((p) => p.nickname)
      .sort();
    expect(nicknames).toEqual(["Alice", "Bob"]);
    alice.close();
    bob.close();
  });

  it("broadcasts state when a player toggles ready", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    await alice.waitFor((m) => m.type === "welcome");
    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");

    await alice.waitFor(
      (m) =>
        m.type === "state" &&
        Object.keys((m.state as { players: Record<string, unknown> }).players).length === 2,
    );

    bob.send({ type: "set_ready", ready: true });

    const readyState = await alice.waitFor((m) => {
      if (m.type !== "state") return false;
      const players = (m.state as { players: Record<string, { ready: boolean; nickname: string }> })
        .players;
      return Object.values(players).some((p) => p.nickname === "Bob" && p.ready === true);
    });
    const players = (
      readyState.state as {
        players: Record<string, { nickname: string; ready: boolean; isHost: boolean }>;
      }
    ).players;
    const aliceRow = Object.values(players).find((p) => p.nickname === "Alice");
    expect(aliceRow?.ready).toBe(false);
    expect(aliceRow?.isHost).toBe(true);
    alice.close();
    bob.close();
  });

  it("resume token restores the same sessionId on reconnect", async () => {
    const code = await createRoom();
    const alice1 = await joinRoom(code, "Alice", "#ff4444");
    const welcome1 = (await alice1.waitFor((m) => m.type === "welcome")) as unknown as {
      sessionId: string;
      resumeToken: string;
    };
    const originalSessionId = welcome1.sessionId;
    const originalToken = welcome1.resumeToken;
    alice1.close();

    // Let the close handler land + flag the player disconnected.
    await new Promise((r) => setTimeout(r, 200));

    const alice2 = await joinRoom(code, "Alice", "#ff4444", originalToken);
    const welcome2 = (await alice2.waitFor((m) => m.type === "welcome")) as unknown as {
      sessionId: string;
      resumeToken: string;
      state: { players: Record<string, { disconnected: boolean }> };
    };
    expect(welcome2.sessionId).toBe(originalSessionId);
    expect(welcome2.resumeToken).not.toBe(originalToken);
    const row = welcome2.state.players[originalSessionId];
    expect(row).toBeDefined();
    expect(row.disconnected).toBe(false);
    alice2.close();
  });

  it("rejects WebSocket upgrade against an uninitialised room code", async () => {
    // HIGH 3 regression: Room DOs are addressed by idFromName(code), so
    // any 4-letter code deterministically maps to a DO slot even when
    // the Worker never /init'd it. Without the guard, an attacker could
    // open wss://.../api/room/ZZZZ and squat a phantom lobby.
    const params = new URLSearchParams({ nickname: "Mallory", color: "#ff4444" });
    const ws = new WebSocket(`${baseWs}/api/room/ZZZZ?${params.toString()}`);
    let unexpectedResponse: { statusCode: number } | undefined;
    await new Promise<void>((resolve) => {
      ws.on("unexpected-response", (_req, res) => {
        unexpectedResponse = { statusCode: res.statusCode ?? 0 };
        resolve();
      });
      ws.on("error", () => resolve());
      ws.on("close", () => resolve());
      ws.on("open", () => resolve());
    });
    expect(ws.readyState === ws.OPEN ? "open" : "not-open").toBe("not-open");
    if (unexpectedResponse) expect(unexpectedResponse.statusCode).toBe(404);
  });

  it("rejects invalid nicknames on join", async () => {
    const code = await createRoom();
    const params = new URLSearchParams({ nickname: "", color: "#ff4444" });
    // Opening the WS against the bad URL should close/fail quickly.
    const ws = new WebSocket(`${baseWs}/api/room/${code}?${params.toString()}`);
    await new Promise<void>((resolve) => {
      ws.on("error", () => resolve());
      ws.on("unexpected-response", () => resolve());
      ws.on("close", () => resolve());
      ws.on("open", () => resolve());
    });
    // The upgrade should have been rejected; in the ws client a 400
    // surfaces as `unexpected-response` (or close/error depending on
    // timing). Our assertion is just: we did not end up with a live
    // open socket holding a welcome message.
    expect(ws.readyState === ws.OPEN ? "open" : "not-open").toBe("not-open");
  });

  it("non-host clients cannot start the game", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    await alice.waitFor((m) => m.type === "welcome");
    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");

    bob.send({ type: "start_game" });

    const err = await bob.waitFor((m) => m.type === "error");
    expect((err as unknown as { code: string }).code).toBe("not_host");

    alice.close();
    bob.close();
  });

  it("allows the host to start the game and broadcasts game_started", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    await alice.waitFor((m) => m.type === "welcome");
    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");
    await alice.waitFor(
      (m) =>
        m.type === "state" &&
        Object.keys((m.state as { players: Record<string, unknown> }).players).length === 2,
    );

    bob.send({ type: "set_ready", ready: true });
    await alice.waitFor((m) => {
      if (m.type !== "state") return false;
      const players = (m.state as { players: Record<string, { ready: boolean; nickname: string }> })
        .players;
      return Object.values(players).some((p) => p.nickname === "Bob" && p.ready === true);
    });

    alice.send({ type: "start_game" });

    const gameStarted = await alice.waitFor((m) => m.type === "game_started");
    expect(gameStarted.type).toBe("game_started");
    const teams = (gameStarted as unknown as { teams: Array<{ id: string; wormNames: string[] }> })
      .teams;
    expect(teams.length).toBe(2);
    expect(teams.map((t) => t.id).sort()).toEqual(["blue", "red"]);

    const playingState = await alice.waitFor(
      (m) => m.type === "state" && (m.state as { phase: string }).phase === "playing",
    );
    expect((playingState.state as { currentTeamId: string }).currentTeamId).not.toBe("");

    alice.close();
    bob.close();
  });

  it("turn_snapshot from active player cannot mark opponent worms dead", async () => {
    // HIGH 1 regression: an active player used to be able to flip
    // `alive: false` on opponent worm entries and trigger instant win.
    // The room should filter snapshot entries to the sender's own team.
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    const aliceWelcome = (await alice.waitFor((m) => m.type === "welcome")) as unknown as {
      sessionId: string;
    };
    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");
    await alice.waitFor(
      (m) =>
        m.type === "state" &&
        Object.keys((m.state as { players: Record<string, unknown> }).players).length === 2,
    );

    bob.send({ type: "set_ready", ready: true });
    await alice.waitFor((m) => {
      if (m.type !== "state") return false;
      const players = (m.state as { players: Record<string, { ready: boolean; nickname: string }> })
        .players;
      return Object.values(players).some((p) => p.nickname === "Bob" && p.ready === true);
    });

    alice.send({ type: "start_game" });
    const gameStarted = (await alice.waitFor((m) => m.type === "game_started")) as unknown as {
      teams: Array<{ id: string; wormNames: string[]; ownerSessionId: string }>;
    };
    const playing = await alice.waitFor(
      (m) => m.type === "state" && (m.state as { phase: string }).phase === "playing",
    );
    const currentTeam = (playing.state as { currentTeamId: string }).currentTeamId;
    const activeTeam = gameStarted.teams.find((t) => t.id === currentTeam);
    const passiveTeam = gameStarted.teams.find((t) => t.id !== currentTeam);
    expect(activeTeam).toBeDefined();
    expect(passiveTeam).toBeDefined();

    const active = activeTeam?.ownerSessionId === aliceWelcome.sessionId ? alice : bob;

    // Malicious payload: mark BOTH opponent worms dead while leaving
    // own worms alive. Pre-fix, arbiter would see 0 alive opponents
    // and broadcast game_over.
    const malicious = {
      type: "turn_snapshot",
      worms: [
        ...(activeTeam?.wormNames ?? []).map((id) => ({
          id,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          hp: 100,
          alive: true,
        })),
        ...(passiveTeam?.wormNames ?? []).map((id) => ({
          id,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
          hp: 0,
          alive: false,
        })),
      ],
      terrainCuts: [],
    };
    active.send(malicious);

    // Expect turn to advance to the opponent, NOT a game_over.
    const resolved = await alice.waitFor((m) => m.type === "turn_resolved");
    expect((resolved as unknown as { nextTeamId: string }).nextTeamId).toBe(passiveTeam?.id);
    const gameOver = alice.messages.find((m) => m.type === "game_over");
    expect(gameOver).toBeUndefined();

    alice.close();
    bob.close();
  });

  it("relays input_walk from the active player to other sockets", async () => {
    const code = await createRoom();
    const alice = await joinRoom(code, "Alice", "#ff4444");
    const aliceWelcome = (await alice.waitFor((m) => m.type === "welcome")) as unknown as {
      sessionId: string;
    };
    const bob = await joinRoom(code, "Bob", "#4488ff");
    await bob.waitFor((m) => m.type === "welcome");
    await alice.waitFor(
      (m) =>
        m.type === "state" &&
        Object.keys((m.state as { players: Record<string, unknown> }).players).length === 2,
    );

    bob.send({ type: "set_ready", ready: true });
    await alice.waitFor((m) => {
      if (m.type !== "state") return false;
      const players = (m.state as { players: Record<string, { ready: boolean; nickname: string }> })
        .players;
      return Object.values(players).some((p) => p.nickname === "Bob" && p.ready === true);
    });

    alice.send({ type: "start_game" });
    const playing = await alice.waitFor(
      (m) => m.type === "state" && (m.state as { phase: string }).phase === "playing",
    );
    const currentTeam = (playing.state as { currentTeamId: string }).currentTeamId;

    const playersRow = (
      playing.state as {
        players: Record<string, { ownerOfTeamId: string }>;
      }
    ).players;
    const activeSession = Object.entries(playersRow).find(
      ([, p]) => p.ownerOfTeamId === currentTeam,
    )?.[0];
    expect(activeSession).toBeDefined();

    const active = activeSession === aliceWelcome.sessionId ? alice : bob;
    const spectator = active === alice ? bob : alice;

    active.send({ type: "input_walk", dir: 1 });
    const relay = await spectator.waitFor((m) => m.type === "input_walk");
    expect((relay as unknown as { from: string; dir: number }).from).toBe(activeSession);
    expect((relay as unknown as { from: string; dir: number }).dir).toBe(1);

    alice.close();
    bob.close();
  });
});
