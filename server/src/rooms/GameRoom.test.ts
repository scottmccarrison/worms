import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { ColyseusTestServer, boot } from "@colyseus/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_COLORS } from "../state/LobbyState.js";
import { GameRoom } from "./GameRoom.js";

let colyseus: ColyseusTestServer;

beforeAll(async () => {
  const server = new Server({
    transport: new WebSocketTransport(),
  });
  server.define("game", GameRoom).filterBy(["code"]);
  colyseus = await boot(server);
});

afterAll(async () => {
  await colyseus.shutdown();
});

beforeEach(async () => {
  await colyseus.cleanup();
});

// Small helper: wait a microtask tick for state sync to propagate.
const tick = (ms = 50) => new Promise<void>((r) => setTimeout(r, ms));

describe("GameRoom lobby", () => {
  it("assigns the first joiner as host and generates a 4-letter code", async () => {
    const room = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });

    await tick();

    const code = (room.state as any).code as string;
    const hostSessionId = (room.state as any).hostSessionId as string;
    expect(code).toMatch(/^[A-HJ-NP-Z]{4}$/);
    expect(hostSessionId).toBe(room.sessionId);

    const players = (room.state as any).players;
    const alice = players.get(room.sessionId);
    expect(alice).toBeDefined();
    expect(alice.isHost).toBe(true);
    expect(alice.nickname).toBe("Alice");

    await room.leave();
  });

  it("rejects a duplicate color at join time", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const code = (alice.state as any).code as string;

    await expect(
      colyseus.sdk.joinOrCreate("game", {
        code,
        nickname: "Bob",
        color: ALLOWED_COLORS[0], // same colour
      }),
    ).rejects.toBeDefined();

    await alice.leave();
  });

  it("rejects a nickname longer than 16 characters", async () => {
    await expect(
      colyseus.sdk.joinOrCreate("game", {
        nickname: "A".repeat(17),
        color: ALLOWED_COLORS[0],
      }),
    ).rejects.toBeDefined();
  });

  it("rejects an empty nickname", async () => {
    await expect(
      colyseus.sdk.joinOrCreate("game", {
        nickname: "   ",
        color: ALLOWED_COLORS[0],
      }),
    ).rejects.toBeDefined();
  });

  it("promotes the earliest-joined remaining player when the host leaves", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const code = (alice.state as any).code as string;

    const bob = await colyseus.sdk.joinOrCreate("game", {
      code,
      nickname: "Bob",
      color: ALLOWED_COLORS[1],
    });
    await tick();

    const carol = await colyseus.sdk.joinOrCreate("game", {
      code,
      nickname: "Carol",
      color: ALLOWED_COLORS[2],
    });
    await tick();

    // Alice (the host) leaves. Bob joined before Carol, so Bob should inherit.
    await alice.leave();
    await tick(150);

    const hostSessionIdBob = (bob.state as any).hostSessionId as string;
    expect(hostSessionIdBob).toBe(bob.sessionId);

    const bobPlayer = (bob.state as any).players.get(bob.sessionId);
    expect(bobPlayer.isHost).toBe(true);

    await bob.leave();
    await carol.leave();
  });

  it("rejects select_map from a non-host client", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const code = (alice.state as any).code as string;

    const bob = await colyseus.sdk.joinOrCreate("game", {
      code,
      nickname: "Bob",
      color: ALLOWED_COLORS[1],
    });
    await tick();

    const bobErrors: any[] = [];
    bob.onMessage("error", (payload) => bobErrors.push(payload));

    bob.send("select_map", { mapId: "hills" });
    await tick(100);

    expect(bobErrors.map((e) => e.code)).toContain("not_host");
    // Map should not have changed.
    expect((bob.state as any).selectedMapId).toBe("flat");

    await alice.leave();
    await bob.leave();
  });

  it("rejects start_game with fewer than 2 players", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();

    const errors: any[] = [];
    alice.onMessage("error", (p) => errors.push(p));

    alice.send("start_game", {});
    await tick(100);

    expect(errors.map((e) => e.code)).toContain("not_enough_players");
    expect((alice.state as any).phase).toBe("lobby");

    await alice.leave();
  });

  it("start_game happy path broadcasts game_started and flips phase to playing", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const code = (alice.state as any).code as string;

    const bob = await colyseus.sdk.joinOrCreate("game", {
      code,
      nickname: "Bob",
      color: ALLOWED_COLORS[1],
    });
    await tick();

    // Bob marks ready (Alice is host, not required to be ready).
    bob.send("set_ready", { ready: true });
    await tick(60);

    // Collect game_started on both clients.
    const aliceStarts: any[] = [];
    const bobStarts: any[] = [];
    alice.onMessage("game_started", (p) => aliceStarts.push(p));
    bob.onMessage("game_started", (p) => bobStarts.push(p));

    alice.send("start_game", {});
    await tick(150);

    expect(aliceStarts).toHaveLength(1);
    expect(bobStarts).toHaveLength(1);

    const payload = aliceStarts[0];
    expect(payload.mapId).toBe("flat");
    expect(typeof payload.seed).toBe("number");
    expect(Array.isArray(payload.teams)).toBe(true);
    expect(payload.teams.length).toBeGreaterThanOrEqual(2);

    expect((alice.state as any).phase).toBe("playing");

    await alice.leave();
    await bob.leave();
  });

  it("select_map from host updates selectedMapId; rejects unknown map ids", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();

    alice.send("select_map", { mapId: "hills" });
    await tick(80);
    expect((alice.state as any).selectedMapId).toBe("hills");

    const errors: any[] = [];
    alice.onMessage("error", (p) => errors.push(p));
    alice.send("select_map", { mapId: "bogus" });
    await tick(80);
    expect(errors.map((e) => e.code)).toContain("invalid_map");
    expect((alice.state as any).selectedMapId).toBe("hills");

    await alice.leave();
  });
});
