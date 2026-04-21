import { describe, expect, it } from "vitest";
import { LobbyState } from "../state/LobbyState.js";
import { TURN_DURATION_MS } from "../state/constants.js";
import {
  type ArbiterRoomAdapter,
  type TeamRoster,
  TurnArbiter,
  type TurnSnapshot,
} from "./TurnArbiter.js";

/**
 * Minimal in-memory adapter so TurnArbiter can run without a Colyseus
 * Room. Captures broadcasts so tests can assert on them.
 */
class StubRoom implements ArbiterRoomAdapter {
  state = new LobbyState();
  broadcasts: Array<{ type: string; payload: unknown }> = [];
  connected = new Set<string>();
  disconnectedPlayers = new Set<string>();

  broadcast(type: string, payload: unknown): void {
    this.broadcasts.push({ type, payload });
  }
  getConnectedSessionIds(): Set<string> {
    return this.connected;
  }
  getPlayerDisconnected(sessionId: string): boolean {
    return this.disconnectedPlayers.has(sessionId);
  }
}

function rosterFor(id: string, ownerSessionId: string, wormCount = 2): TeamRoster {
  const wormIds: string[] = [];
  for (let i = 0; i < wormCount; i++) wormIds.push(`${id}-${i}`);
  return { id, ownerSessionId, wormIds };
}

describe("TurnArbiter", () => {
  it("advanceTurn skips ownerless teams", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [
      rosterFor("red", "alice"),
      rosterFor("blue", ""), // ownerless; must be skipped
      rosterFor("green", "bob"),
      rosterFor("yellow", ""), // ownerless
    ];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green", "yellow"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");

    // Full-alive snapshot so no game_over triggers.
    const snap: TurnSnapshot = {
      worms: [
        { id: "red-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "yellow-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "yellow-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [],
    };
    arbiter.onSnapshot(snap);

    // Should have skipped "blue" (ownerless) and landed on "green".
    expect(room.state.currentTeamId).toBe("green");
    const resolved = room.broadcasts.find((b) => b.type === "turn_resolved");
    expect(resolved).toBeDefined();
    expect((resolved?.payload as { nextTeamId: string }).nextTeamId).toBe("green");
  });

  it("declares game_over when only one team has alive worms", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // All blue worms dead; red fully alive.
    const snap: TurnSnapshot = {
      worms: [
        { id: "red-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 0, y: 0, vx: 0, vy: 0, hp: 0, alive: false },
        { id: "blue-1", x: 0, y: 0, vx: 0, vy: 0, hp: 0, alive: false },
      ],
      terrainCuts: [],
    };
    arbiter.onSnapshot(snap);

    const gameOver = room.broadcasts.find((b) => b.type === "game_over");
    expect(gameOver).toBeDefined();
    expect((gameOver?.payload as { winnerTeamId: string | null }).winnerTeamId).toBe("red");
    // No turn_resolved should be emitted on game_over.
    expect(room.broadcasts.find((b) => b.type === "turn_resolved")).toBeUndefined();
    // Turn state is zeroed out so clients stop running timers.
    expect(room.state.currentTeamId).toBe("");
    expect(room.state.currentWormId).toBe("");
    expect(room.state.turnEndsAt).toBe(0);
  });

  it("forceAdvance uses last known snapshot", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // First turn: red fires a snapshot establishing positions.
    const snap1: TurnSnapshot = {
      worms: [
        { id: "red-0", x: 100, y: 200, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 120, y: 200, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 300, y: 200, vx: 0, vy: 0, hp: 90, alive: true },
        { id: "blue-1", x: 320, y: 200, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [{ x: 150, y: 150, r: 30, seq: 1 }],
    };
    arbiter.onSnapshot(snap1);

    // Now blue's turn. Before blue sends a snapshot, timeout forces
    // an advance. Resolution must use snap1's positions and NO cuts.
    room.broadcasts.length = 0;
    arbiter.forceAdvance();

    const resolved = room.broadcasts.find((b) => b.type === "turn_resolved");
    expect(resolved).toBeDefined();
    const payload = resolved?.payload as {
      worms: Array<{ id: string; x: number }>;
      terrainCuts: unknown[];
      nextTeamId: string;
    };
    expect(payload.worms.find((w) => w.id === "red-0")?.x).toBe(100);
    expect(payload.terrainCuts).toHaveLength(0);
    // Cycled back to red since blue never acted.
    expect(payload.nextTeamId).toBe("red");
  });

  // ---- Epic 10 ----

  it("onOwnerDisconnected pauses turnEndsAt for the active team; onOwnerReconnected restores remaining time", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");
    const beforeRemaining = room.state.turnEndsAt - Date.now();
    expect(beforeRemaining).toBeGreaterThan(0);

    // Active owner drops.
    arbiter.onOwnerDisconnected("alice");
    // Sentinel used so the client HUD stops counting down.
    expect(room.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    // onTick must not force-advance while paused even if a lot of time
    // "passes" (we call forceAdvance's precondition indirectly via tick).
    const broadcastsBefore = room.broadcasts.length;
    arbiter.onTick(50);
    expect(room.broadcasts.length).toBe(broadcastsBefore);

    // Reconnect.
    arbiter.onOwnerReconnected("alice");
    expect(room.state.turnEndsAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    const afterRemaining = room.state.turnEndsAt - Date.now();
    // Should be close to the remaining time at pause (small tolerance for
    // the Date.now() gap between pause and resume within a single test).
    expect(Math.abs(afterRemaining - beforeRemaining)).toBeLessThan(50);
  });

  it("onOwnerDisconnected is a no-op for a non-active owner", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    const endsAtBefore = room.state.turnEndsAt;
    // Bob is NOT active; dropping him must not freeze the timer.
    arbiter.onOwnerDisconnected("bob");
    expect(room.state.turnEndsAt).toBe(endsAtBefore);
  });

  it("onTeamForfeit flips aliveByTeam to 0 and ends the game when only one team survives", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    arbiter.onTeamForfeit("red");

    // 2-player forfeit = immediate game_over with blue winning.
    const gameOver = room.broadcasts.find((b) => b.type === "game_over");
    expect(gameOver).toBeDefined();
    expect((gameOver?.payload as { winnerTeamId: string | null }).winnerTeamId).toBe("blue");
    // No turn_resolved should land on the final forfeit-to-gameover path.
    expect(room.broadcasts.find((b) => b.type === "turn_resolved")).toBeUndefined();
    // Arbiter is a no-op after game over.
    expect(room.state.currentTeamId).toBe("");
  });

  it("onTeamForfeit advances the turn when more than one team still has alive worms", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob", "carol"]);

    const rosters: TeamRoster[] = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    // Bob (blue) forfeits; red is still active so this is a non-active
    // forfeit. Red and green both have alive worms so the arbiter must
    // synthesize a turn_resolved (marking blue's worms dead) and advance
    // past blue in the rotation.
    arbiter.onTeamForfeit("blue");

    const resolved = room.broadcasts.find((b) => b.type === "turn_resolved");
    expect(resolved).toBeDefined();
    const payload = resolved?.payload as {
      nextTeamId: string;
      worms: Array<{ id: string; alive: boolean; hp: number }>;
    };
    // Next team should NOT be blue (forfeited) or red (just played).
    expect(payload.nextTeamId).toBe("green");
    // The synthetic worms shipped with the resolution are blue's worms,
    // all marked dead.
    expect(payload.worms.every((w) => w.alive === false && w.hp === 0)).toBe(true);
    expect(payload.worms.map((w) => w.id).sort()).toEqual(["blue-0", "blue-1"]);
  });

  it("advanceTurn skips teams whose owner is flagged disconnected via adapter", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob", "carol"]);
    // Bob is still physically connected (grace window), but flagged as
    // disconnected; advanceTurn must skip his team.
    room.disconnectedPlayers.add("bob");

    const rosters: TeamRoster[] = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    const snap: TurnSnapshot = {
      worms: [
        { id: "red-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "red-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-0", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-1", x: 0, y: 0, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [],
    };
    arbiter.onSnapshot(snap);

    // Skipped past blue to green despite blue having alive worms.
    expect(room.state.currentTeamId).toBe("green");
  });
});
