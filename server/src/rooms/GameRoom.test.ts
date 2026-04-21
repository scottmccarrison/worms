import { Server } from "@colyseus/core";
import { type ColyseusTestServer, boot } from "@colyseus/testing";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ALLOWED_COLORS } from "../state/LobbyState.js";
import { GameRoom, __setReconnectionGraceSecondsForTests } from "./GameRoom.js";

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

  it("auto-assigns a free color when requested is taken", async () => {
    const alice = await colyseus.sdk.joinOrCreate("game", {
      nickname: "Alice",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const code = (alice.state as any).code as string;

    const bob = await colyseus.sdk.joinOrCreate("game", {
      code,
      nickname: "Bob",
      color: ALLOWED_COLORS[0], // same as Alice
    });
    await tick();

    const players = (bob.state as any).players;
    const bobPlayer = players.get(bob.sessionId);
    expect(bobPlayer).toBeDefined();
    expect(bobPlayer.color).not.toBe(ALLOWED_COLORS[0]);
    expect(ALLOWED_COLORS).toContain(bobPlayer.color);

    await alice.leave();
    await bob.leave();
  });

  it("strips bidi + zero-width chars from nicknames", async () => {
    const room = await colyseus.sdk.joinOrCreate("game", {
      nickname: "‮evil‬​",
      color: ALLOWED_COLORS[0],
    });
    await tick();
    const me = (room.state as any).players.get(room.sessionId);
    expect(me.nickname).toBe("evil");
    await room.leave();
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

  // ---- Epic 9: turn arbiter integration ----

  /**
   * Spin up two players and start the game. Returns both rooms plus
   * the `game_started` payload so Epic 9 tests can read team owners /
   * current active team without duplicating 40 lines of setup.
   */
  async function setupStartedGame(): Promise<{
    alice: Awaited<ReturnType<typeof colyseus.sdk.joinOrCreate>>;
    bob: Awaited<ReturnType<typeof colyseus.sdk.joinOrCreate>>;
    payload: any;
  }> {
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

    bob.send("set_ready", { ready: true });
    await tick(60);

    const starts: any[] = [];
    alice.onMessage("game_started", (p) => starts.push(p));

    alice.send("start_game", {});
    await tick(150);

    return { alice, bob, payload: starts[0] };
  }

  it("start_game assigns team owners deterministically from player join order", async () => {
    const { alice, bob, payload } = await setupStartedGame();

    // Player 0 (Alice, first joiner) gets team 0 ("red"); Bob gets "blue".
    expect(payload.teams[0].id).toBe("red");
    expect(payload.teams[0].ownerSessionId).toBe(alice.sessionId);
    expect(payload.teams[1].id).toBe("blue");
    expect(payload.teams[1].ownerSessionId).toBe(bob.sessionId);

    // And ownership is mirrored onto the replicated LobbyPlayer rows so
    // clients can do the lookup without reparsing the teams array.
    const alicePlayer = (alice.state as any).players.get(alice.sessionId);
    const bobPlayer = (alice.state as any).players.get(bob.sessionId);
    expect(alicePlayer.ownerOfTeamId).toBe("red");
    expect(bobPlayer.ownerOfTeamId).toBe("blue");

    await alice.leave();
    await bob.leave();
  });

  it("drops input_walk from the non-active player silently", async () => {
    const { alice, bob } = await setupStartedGame();

    // Whichever one is non-active sends input_walk; it must not reach
    // the other. Determine active via currentTeamId -> owner mapping.
    const activeTeamId = (alice.state as any).currentTeamId as string;
    const nonActive = activeTeamId === "red" ? bob : alice;
    const other = activeTeamId === "red" ? alice : bob;

    const walkReceived: any[] = [];
    other.onMessage("input_walk", (p) => walkReceived.push(p));

    nonActive.send("input_walk", { dir: 1, seq: 1 });
    await tick(100);

    expect(walkReceived).toHaveLength(0);

    await alice.leave();
    await bob.leave();
  });

  it("relays input_walk from the active player to the other client only", async () => {
    const { alice, bob } = await setupStartedGame();

    const activeTeamId = (alice.state as any).currentTeamId as string;
    const active = activeTeamId === "red" ? alice : bob;
    const spectator = activeTeamId === "red" ? bob : alice;

    const activeWalkSelfEcho: any[] = [];
    const spectatorWalk: any[] = [];
    active.onMessage("input_walk", (p) => activeWalkSelfEcho.push(p));
    spectator.onMessage("input_walk", (p) => spectatorWalk.push(p));

    active.send("input_walk", { dir: -1, seq: 7 });
    await tick(100);

    // Server re-broadcasts with { except: sender } so the active
    // player's own client does NOT receive an echo back.
    expect(activeWalkSelfEcho).toHaveLength(0);
    expect(spectatorWalk).toHaveLength(1);
    expect(spectatorWalk[0]).toMatchObject({ dir: -1, seq: 7 });

    await alice.leave();
    await bob.leave();
  });

  it("broadcasts turn_resolved to all clients on turn_snapshot from the active player", async () => {
    const { alice, bob } = await setupStartedGame();

    const activeTeamId = (alice.state as any).currentTeamId as string;
    const active = activeTeamId === "red" ? alice : bob;

    const aliceResolved: any[] = [];
    const bobResolved: any[] = [];
    alice.onMessage("turn_resolved", (p) => aliceResolved.push(p));
    bob.onMessage("turn_resolved", (p) => bobResolved.push(p));

    active.send("turn_snapshot", {
      worms: [
        { id: "red-0", x: 10, y: 20, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 30, y: 20, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 50, y: 20, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-1", x: 70, y: 20, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [{ x: 100, y: 100, r: 40, seq: 1 }],
    });
    await tick(150);

    // Both clients (including the sender) receive turn_resolved since
    // the server broadcasts to everyone, not just spectators.
    expect(aliceResolved).toHaveLength(1);
    expect(bobResolved).toHaveLength(1);
    expect(typeof aliceResolved[0].turnSeq).toBe("number");
    expect(aliceResolved[0].turnSeq).toBeGreaterThanOrEqual(2);

    await alice.leave();
    await bob.leave();
  });

  it("advances state.currentTeamId to the next team after turn_resolved", async () => {
    const { alice, bob } = await setupStartedGame();

    const firstTeamId = (alice.state as any).currentTeamId as string;
    const active = firstTeamId === "red" ? alice : bob;

    active.send("turn_snapshot", {
      worms: [
        { id: "red-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [],
    });
    await tick(150);

    const secondTeamId = (alice.state as any).currentTeamId as string;
    expect(secondTeamId).not.toBe("");
    expect(secondTeamId).not.toBe(firstTeamId);

    await alice.leave();
    await bob.leave();
  });

  it("consented leave by the active player forfeits their team (2p -> game_over)", async () => {
    const { alice, bob } = await setupStartedGame();

    const firstTeamId = (alice.state as any).currentTeamId as string;
    const active = firstTeamId === "red" ? alice : bob;
    const spectator = firstTeamId === "red" ? bob : alice;

    const gameOvers: any[] = [];
    spectator.onMessage("game_over", (p) => gameOvers.push(p));

    // `room.leave()` without args is consented; arbiter forfeits the
    // active team which in a 2-player game leaves one team alive and
    // triggers game_over.
    await active.leave();
    await tick(200);

    expect(gameOvers).toHaveLength(1);
    expect(gameOvers[0].winnerTeamId).not.toBe(firstTeamId);
    expect(gameOvers[0].winnerTeamId).not.toBe(null);
    expect((spectator.state as any).currentTeamId).toBe("");

    await spectator.leave();
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

  // ---- Epic 10: reconnection + grace window ----

  it("unexpected disconnect flags player as disconnected and preserves the slot; reconnect clears the flag", async () => {
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

    const bobSessionId = bob.sessionId;
    const bobToken = bob.reconnectionToken;

    // Non-consented leave (simulates a TCP / network drop).
    await bob.leave(false);
    // Give the server a moment to run onLeave + flag the schema row.
    await tick(150);

    // Bob's LobbyPlayer should still be in the map with disconnected=true.
    const players = (alice.state as any).players;
    const bobRow = players.get(bobSessionId);
    expect(bobRow).toBeDefined();
    expect(bobRow.disconnected).toBe(true);
    expect(bobRow.disconnectGraceEndsAt).toBeGreaterThan(Date.now());

    // Now reconnect. `state + listeners` are preserved; onJoin should
    // NOT re-fire on the server side (we assert indirectly by checking
    // Bob's color / nickname are the originals, not auto-assigned).
    const bobAgain = await colyseus.sdk.reconnect(bobToken);
    await tick(150);

    const bobRowAfter = (alice.state as any).players.get(bobAgain.sessionId);
    expect(bobRowAfter).toBeDefined();
    expect(bobRowAfter.disconnected).toBe(false);
    expect(bobRowAfter.disconnectGraceEndsAt).toBe(0);
    expect(bobRowAfter.nickname).toBe("Bob");
    expect(bobRowAfter.color).toBe(ALLOWED_COLORS[1]);
    // sessionId is preserved across reconnects (that's the whole point).
    expect(bobAgain.sessionId).toBe(bobSessionId);

    await alice.leave();
    await bobAgain.leave();
  });

  it("active-owner disconnect pauses the turn timer; reconnect resumes with the same remaining time", async () => {
    const { alice, bob } = await setupStartedGame();

    const firstTeamId = (alice.state as any).currentTeamId as string;
    const active = firstTeamId === "red" ? alice : bob;
    const spectator = firstTeamId === "red" ? bob : alice;
    const activeToken = active.reconnectionToken;

    // Grab the remaining time before the drop so we can assert the
    // resume clock matches within a small tolerance.
    const turnEndsAtBefore = (spectator.state as any).turnEndsAt as number;
    const remainingBefore = turnEndsAtBefore - Date.now();
    expect(remainingBefore).toBeGreaterThan(0);

    await active.leave(false);
    await tick(150);

    // While paused the sentinel pushes turnEndsAt way into the future;
    // Number.MAX_SAFE_INTEGER - Date.now() > 10 years is a trivially
    // safe lower bound that distinguishes "paused" from "unpaused".
    const turnEndsAtPaused = (spectator.state as any).turnEndsAt as number;
    expect(turnEndsAtPaused - Date.now()).toBeGreaterThan(10 * 365 * 24 * 60 * 60 * 1000);

    // Reconnect mid-grace.
    const activeAgain = await colyseus.sdk.reconnect(activeToken);
    await tick(150);

    const turnEndsAtResumed = (spectator.state as any).turnEndsAt as number;
    const remainingAfter = turnEndsAtResumed - Date.now();
    // The turnEndsAt field is no longer the sentinel.
    expect(turnEndsAtResumed).toBeLessThan(Number.MAX_SAFE_INTEGER);
    // Resume remaining should be within ~500ms of pre-drop remaining
    // (test latency + tick delays).
    expect(Math.abs(remainingAfter - remainingBefore)).toBeLessThan(500);

    await activeAgain.leave();
    await spectator.leave();
  });

  it("grace expiry forfeits the active team (2p -> game_over)", async () => {
    // Shrink the grace to ~1s so the test completes in under ~2s of
    // real time. Restored in a finally block.
    __setReconnectionGraceSecondsForTests(1);
    try {
      const { alice, bob } = await setupStartedGame();

      const firstTeamId = (alice.state as any).currentTeamId as string;
      const active = firstTeamId === "red" ? alice : bob;
      const spectator = firstTeamId === "red" ? bob : alice;

      const gameOvers: any[] = [];
      spectator.onMessage("game_over", (p) => gameOvers.push(p));

      // Non-consented leave so onLeave actually awaits allowReconnection.
      await active.leave(false);
      // Wait past the 1s grace + a bit for bookkeeping.
      await tick(1500);

      // The remaining team won by forfeit.
      expect(gameOvers).toHaveLength(1);
      expect(gameOvers[0].winnerTeamId).not.toBe(firstTeamId);
      expect(gameOvers[0].winnerTeamId).not.toBe(null);
      expect((spectator.state as any).currentTeamId).toBe("");

      await spectator.leave();
    } finally {
      __setReconnectionGraceSecondsForTests(60);
    }
  });

  it("host disconnect + reconnect preserves isHost", async () => {
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

    expect((alice.state as any).hostSessionId).toBe(alice.sessionId);
    const aliceToken = alice.reconnectionToken;

    await alice.leave(false);
    await tick(150);

    // During the grace window host stays on Alice's slot; the LobbyPlayer
    // is flagged disconnected but still host.
    const aliceRow = (bob.state as any).players.get(alice.sessionId);
    expect(aliceRow).toBeDefined();
    expect(aliceRow.disconnected).toBe(true);
    expect(aliceRow.isHost).toBe(true);
    expect((bob.state as any).hostSessionId).toBe(alice.sessionId);

    const aliceAgain = await colyseus.sdk.reconnect(aliceToken);
    await tick(150);

    const aliceRowAfter = (bob.state as any).players.get(aliceAgain.sessionId);
    expect(aliceRowAfter).toBeDefined();
    expect(aliceRowAfter.isHost).toBe(true);
    expect(aliceRowAfter.disconnected).toBe(false);
    expect((bob.state as any).hostSessionId).toBe(aliceAgain.sessionId);

    await aliceAgain.leave();
    await bob.leave();
  });
});
