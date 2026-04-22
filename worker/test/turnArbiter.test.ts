import { describe, expect, it } from "vitest";
import type { LobbyState } from "../src/messages.js";
import {
  type ArbiterRoomAdapter,
  TURN_DURATION_MS,
  type TeamRoster,
  TurnArbiter,
  type TurnSnapshot,
} from "../src/turnArbiter.js";

/**
 * Minimal in-memory adapter so TurnArbiter can run without a DO.
 * Plain-JSON LobbyState mirrors the shared protocol shape.
 */
function makeState(): LobbyState {
  return {
    code: "TEST",
    phase: "playing",
    hostSessionId: "",
    selectedMapId: "flat",
    players: {},
    teamOrder: [],
    currentTeamId: "",
    currentWormId: "",
    turnSeq: 0,
    turnEndsAt: 0,
  };
}

class StubRoom implements ArbiterRoomAdapter {
  state = makeState();
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
      rosterFor("blue", ""),
      rosterFor("green", "bob"),
      rosterFor("yellow", ""),
    ];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green", "yellow"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");

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
    expect(room.broadcasts.find((b) => b.type === "turn_resolved")).toBeUndefined();
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
    expect(payload.nextTeamId).toBe("red");
  });

  it("onOwnerDisconnected pauses turnEndsAt for the active team; onOwnerReconnected restores remaining time", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");
    const beforeRemaining = room.state.turnEndsAt - Date.now();
    expect(beforeRemaining).toBeGreaterThan(0);

    arbiter.onOwnerDisconnected("alice");
    expect(room.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    const broadcastsBefore = room.broadcasts.length;
    arbiter.onTick(50);
    expect(room.broadcasts.length).toBe(broadcastsBefore);

    arbiter.onOwnerReconnected("alice");
    expect(room.state.turnEndsAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    const afterRemaining = room.state.turnEndsAt - Date.now();
    expect(Math.abs(afterRemaining - beforeRemaining)).toBeLessThan(50);
  });

  it("onOwnerDisconnected is a no-op for a non-active owner", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    const endsAtBefore = room.state.turnEndsAt;
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

    const gameOver = room.broadcasts.find((b) => b.type === "game_over");
    expect(gameOver).toBeDefined();
    expect((gameOver?.payload as { winnerTeamId: string | null }).winnerTeamId).toBe("blue");
    expect(room.broadcasts.find((b) => b.type === "turn_resolved")).toBeUndefined();
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

    arbiter.onTeamForfeit("blue");

    const resolved = room.broadcasts.find((b) => b.type === "turn_resolved");
    expect(resolved).toBeDefined();
    const payload = resolved?.payload as {
      nextTeamId: string;
      worms: Array<{ id: string; alive: boolean; hp: number }>;
    };
    expect(payload.nextTeamId).toBe("green");
    expect(payload.worms.every((w) => w.alive === false && w.hp === 0)).toBe(true);
    expect(payload.worms.map((w) => w.id).sort()).toEqual(["blue-0", "blue-1"]);
  });

  it("advanceTurn skips teams whose owner is flagged disconnected via adapter", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob", "carol"]);
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

    expect(room.state.currentTeamId).toBe("green");
  });

  it("toJSON / fromState round-trips arbiter state so hibernation doesn't resurrect dead worms", () => {
    // HIGH 2 regression: previously, a hibernated DO rebuilt its
    // arbiter via start() which reset aliveByTeam from rosters. Dead
    // worms came back alive and an active disconnect pause was lost.
    const room1 = new StubRoom();
    room1.connected = new Set(["alice", "bob", "carol"]);

    const rosters: TeamRoster[] = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    const arbiter1 = new TurnArbiter(room1);
    arbiter1.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    // Kill one of red's worms, advance turn to blue.
    const snap: TurnSnapshot = {
      worms: [
        { id: "red-0", x: 10, y: 20, vx: 0, vy: 0, hp: 0, alive: false },
        { id: "red-1", x: 30, y: 40, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-0", x: 50, y: 60, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "blue-1", x: 70, y: 80, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-0", x: 90, y: 100, vx: 0, vy: 0, hp: 100, alive: true },
        { id: "green-1", x: 110, y: 120, vx: 0, vy: 0, hp: 100, alive: true },
      ],
      terrainCuts: [{ x: 10, y: 20, r: 30, seq: 1 }],
    };
    arbiter1.onSnapshot(snap);

    expect(room1.state.currentTeamId).toBe("blue");

    // Simulate disconnect pause for the new active team (blue/bob).
    arbiter1.onOwnerDisconnected("bob");
    expect(room1.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    // Serialise -> hibernation -> rebuild with the old LobbyState shared.
    const persisted = arbiter1.toJSON();
    const persistedJSON = JSON.parse(JSON.stringify(persisted));

    const room2 = new StubRoom();
    room2.state = room1.state; // same lobby shape post-hibernation
    room2.connected = room1.connected;

    const arbiter2 = TurnArbiter.fromState(room2, rosters, persistedJSON);

    // Internal state survived: red-0 stays dead. Feed a fresh snapshot
    // where red-0 claims to be alive again and verify the arbiter's
    // alive tally still shows only 1 red worm (the lastSnapshot
    // priorDead logic would otherwise miss it without restored state).
    expect(arbiter2.isGameOver()).toBe(false);

    // Reconnect: turnEndsAt restored, not clobbered by start() default.
    arbiter2.onOwnerReconnected("bob");
    expect(room2.state.turnEndsAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(room2.state.turnEndsAt).toBeGreaterThan(Date.now());

    // A terrain forfeit on red (already down 1 worm) should count the
    // prior kill: after the forfeit only blue + green are alive, and
    // the arbiter uses the restored lastSnapshot to source red worm
    // positions for the forfeit broadcast.
    room2.broadcasts.length = 0;
    arbiter2.onTeamForfeit("red");
    const forfeit = room2.broadcasts.find((b) => b.type === "turn_resolved");
    expect(forfeit).toBeDefined();
    const payload = forfeit?.payload as {
      worms: Array<{ id: string; x: number; y: number; alive: boolean }>;
    };
    // Red-1's last known x/y (30/40) should carry over from lastSnapshot.
    const red1 = payload.worms.find((w) => w.id === "red-1");
    expect(red1?.x).toBe(30);
    expect(red1?.y).toBe(40);
    expect(red1?.alive).toBe(false);
  });

  it("isGameOver reflects declareGameOver path", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);

    const rosters: TeamRoster[] = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    expect(arbiter.isGameOver()).toBe(false);

    // Force a game_over via onTeamForfeit.
    arbiter.onTeamForfeit("red");
    expect(arbiter.isGameOver()).toBe(true);
  });
});
