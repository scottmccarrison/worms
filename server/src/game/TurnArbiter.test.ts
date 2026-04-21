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

  broadcast(type: string, payload: unknown): void {
    this.broadcasts.push({ type, payload });
  }
  getConnectedSessionIds(): Set<string> {
    return this.connected;
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
});
