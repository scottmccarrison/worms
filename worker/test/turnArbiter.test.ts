import { describe, expect, it } from "vitest";
import type { LobbyState } from "../src/messages.js";
import {
  type AliveCountsProvider,
  type ArbiterRoomAdapter,
  TURN_DURATION_MS,
  type TeamRoster,
  TurnArbiter,
} from "../src/turnArbiter.js";

/**
 * Minimal in-memory adapter so TurnArbiter can run without a DO + a
 * full Simulation. The StubAliveCountsProvider lets tests drive dead
 * vs alive counts per team directly.
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

class StubAliveCountsProvider implements AliveCountsProvider {
  counts = new Map<string, number>();
  aliveWormsByTeam(): Map<string, number> {
    return new Map(this.counts);
  }
}

class StubRoom implements ArbiterRoomAdapter {
  state = makeState();
  broadcasts: Array<{ type: string; payload: unknown }> = [];
  connected = new Set<string>();
  disconnectedPlayers = new Set<string>();
  provider = new StubAliveCountsProvider();
  turnStartCount = 0;

  broadcast(type: string, payload: unknown): void {
    this.broadcasts.push({ type, payload });
  }
  getConnectedSessionIds(): Set<string> {
    return this.connected;
  }
  getPlayerDisconnected(sessionId: string): boolean {
    return this.disconnectedPlayers.has(sessionId);
  }
  getAliveCountsProvider(): AliveCountsProvider | null {
    return this.provider;
  }
  onTurnStart(): void {
    this.turnStartCount += 1;
  }
}

function rosterFor(id: string, ownerSessionId: string, wormCount = 2): TeamRoster {
  const wormIds: string[] = [];
  for (let i = 0; i < wormCount; i++) wormIds.push(`${id}-${i}`);
  return { id, ownerSessionId, wormIds };
}

function setAllAlive(provider: StubAliveCountsProvider, rosters: TeamRoster[]): void {
  provider.counts.clear();
  for (const r of rosters) provider.counts.set(r.id, r.wormIds.length);
}

describe("TurnArbiter", () => {
  it("start picks the first team as current", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);

    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");
    expect(room.state.currentWormId).toBe("red-0");
    expect(room.state.turnSeq).toBe(1);
  });

  it("declares game_over when only one team has alive worms", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);

    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // All of blue dies in the sim.
    room.provider.counts.set("blue", 0);
    arbiter.onWormDied("blue-0");

    const gameOver = room.broadcasts.find((b) => b.type === "game_over");
    expect(gameOver).toBeDefined();
    expect((gameOver?.payload as { winnerTeamId: string | null }).winnerTeamId).toBe("red");
    expect(arbiter.isGameOver()).toBe(true);
    expect(room.state.currentTeamId).toBe("");
  });

  it("onOwnerDisconnected pauses turnEndsAt for the active team; onOwnerReconnected restores remaining", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");
    const beforeRemaining = room.state.turnEndsAt - Date.now();
    expect(beforeRemaining).toBeGreaterThan(0);

    arbiter.onOwnerDisconnected("alice");
    expect(room.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    arbiter.onOwnerReconnected("alice");
    const afterRemaining = room.state.turnEndsAt - Date.now();
    expect(Math.abs(afterRemaining - beforeRemaining)).toBeLessThan(50);
  });

  it("onOwnerDisconnected is a no-op for a non-active owner", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    const endsAtBefore = room.state.turnEndsAt;
    arbiter.onOwnerDisconnected("bob");
    expect(room.state.turnEndsAt).toBe(endsAtBefore);
  });

  it("onTeamForfeit flips alive to 0 and ends the game when only one team survives", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    arbiter.onTeamForfeit("red");

    const gameOver = room.broadcasts.find((b) => b.type === "game_over");
    expect(gameOver).toBeDefined();
    expect((gameOver?.payload as { winnerTeamId: string | null }).winnerTeamId).toBe("blue");
  });

  it("onTeamForfeit advances turn when >1 team still has alive worms", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob", "carol"]);
    const rosters = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    expect(room.state.currentTeamId).toBe("red");
    // Blue forfeits; red is current, so turn should NOT advance (red stays);
    // game should continue.
    arbiter.onTeamForfeit("blue");
    expect(arbiter.isGameOver()).toBe(false);
    expect(room.state.currentTeamId).toBe("red");
    // Now red forfeits as well. Only green has alive worms -> game over.
    arbiter.onTeamForfeit("red");
    expect(arbiter.isGameOver()).toBe(true);
  });

  it("advanceTurn skips teams whose owner is flagged disconnected", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob", "carol"]);
    room.disconnectedPlayers.add("bob");
    const rosters = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    // Force the timer to elapse so onTick advances.
    room.state.turnEndsAt = Date.now() - 10_000;
    arbiter.onTick(50);

    // Should skip "bob"/blue and jump to "carol"/green.
    expect(room.state.currentTeamId).toBe("green");
  });

  it("toJSON / fromState round-trips currentTeamIdx + pause", () => {
    const room1 = new StubRoom();
    room1.connected = new Set(["alice", "bob", "carol"]);
    const rosters = [
      rosterFor("red", "alice"),
      rosterFor("blue", "bob"),
      rosterFor("green", "carol"),
    ];
    setAllAlive(room1.provider, rosters);
    const arbiter1 = new TurnArbiter(room1);
    arbiter1.start(["red", "blue", "green"], rosters, TURN_DURATION_MS);

    // Pause on red.
    arbiter1.onOwnerDisconnected("alice");
    expect(room1.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    const persisted = JSON.parse(JSON.stringify(arbiter1.toJSON()));

    const room2 = new StubRoom();
    room2.state = room1.state;
    room2.connected = room1.connected;
    setAllAlive(room2.provider, rosters);

    const arbiter2 = TurnArbiter.fromState(room2, rosters, persisted);
    expect(arbiter2.isGameOver()).toBe(false);

    arbiter2.onOwnerReconnected("alice");
    expect(room2.state.turnEndsAt).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(room2.state.turnEndsAt).toBeGreaterThan(Date.now());
  });

  it("isGameOver reflects declareGameOver path", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);
    expect(arbiter.isGameOver()).toBe(false);
    arbiter.onTeamForfeit("red");
    expect(arbiter.isGameOver()).toBe(true);
  });

  it("onTurnStart fires once on start() and once per advanceTurn()", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);

    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);
    // start() fires onTurnStart once.
    expect(room.turnStartCount).toBe(1);

    // Force timer elapsed, trigger advance.
    room.state.turnEndsAt = Date.now() - 10_000;
    arbiter.onTick(50);
    // advanceTurn() fires onTurnStart again.
    expect(room.turnStartCount).toBe(2);
  });

  it("onFireCommitted shortens turnEndsAt to +5s", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    const before = room.state.turnEndsAt;
    // turnEndsAt starts at now + 45s; +5s retreat window should shorten it.
    arbiter.onFireCommitted();
    const after = room.state.turnEndsAt;
    expect(after).toBeLessThan(before); // shortened
    expect(after - Date.now()).toBeLessThanOrEqual(5000 + 50); // within 5s window (+tolerance)
  });

  it("onFireCommitted is a no-op when paused", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // Pause via owner disconnect; turnEndsAt becomes MAX_SAFE_INTEGER.
    arbiter.onOwnerDisconnected("alice");
    expect(room.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);

    // onFireCommitted must not stomp the sentinel.
    arbiter.onFireCommitted();
    expect(room.state.turnEndsAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("onFireCommitted does not extend an already-short turnEndsAt", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // Manually set turnEndsAt to 1s from now (already short).
    room.state.turnEndsAt = Date.now() + 1_000;
    const shortened = room.state.turnEndsAt;

    arbiter.onFireCommitted();
    // Should NOT have extended it - 1s < 5s so retreat window would extend it,
    // but the guard prevents extension.
    expect(room.state.turnEndsAt).toBe(shortened);
  });
});
