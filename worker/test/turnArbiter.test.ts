import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LobbyState } from "../src/messages.js";
import {
  type AliveCountsProvider,
  type ArbiterRoomAdapter,
  SETTLE_GRACE_MS,
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
  deadWorms = new Set<string>();
  settled = true;
  aliveWormsByTeam(): Map<string, number> {
    return new Map(this.counts);
  }
  isWormAlive(wormId: string): boolean {
    return !this.deadWorms.has(wormId);
  }
  isAllSettled(_velThresholdMps: number): boolean {
    return this.settled;
  }
}

class StubRoom implements ArbiterRoomAdapter {
  state = makeState();
  code = "TEST";
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
  it("start() resets all per-match state when called twice", () => {
    const room = new StubRoom();
    const arbiter = new TurnArbiter(room);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    room.connected.add("alice");
    room.connected.add("bob");

    // Game 1: dirty per-match state.
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);
    arbiter.onFireCommitted();
    arbiter.onOwnerDisconnected("alice");

    const dirty = arbiter as unknown as {
      settleHoldMs: number;
      pausedRemainingMs: number | null;
      pendingAdvance: boolean;
      hasFiredThisTurn: boolean;
      turnDurationMs: number;
    };
    expect(dirty.hasFiredThisTurn).toBe(true);
    expect(dirty.pausedRemainingMs).not.toBe(null);

    // Start game 2.
    arbiter.start(["blue", "red"], rosters, TURN_DURATION_MS);

    const clean = arbiter as unknown as {
      settleHoldMs: number;
      pausedRemainingMs: number | null;
      pendingAdvance: boolean;
      hasFiredThisTurn: boolean;
      turnDurationMs: number;
    };
    expect(clean.settleHoldMs).toBe(0);
    expect(clean.pausedRemainingMs).toBe(null);
    expect(clean.pendingAdvance).toBe(false);
    expect(clean.hasFiredThisTurn).toBe(false);
    expect(clean.turnDurationMs).toBe(TURN_DURATION_MS);

    expect(room.state.turnSeq).toBe(1);
    expect(room.state.turnEndsAt).toBeGreaterThan(Date.now() + TURN_DURATION_MS - 1000);
    expect(room.state.currentTeamId).toBe("blue");
  });

  it("onWormDied advances turn immediately when the active worm dies (no onTick needed)", () => {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);

    // Capture the active worm before the call.
    const dyingWormId = room.state.currentWormId;
    expect(dyingWormId).toBe("red-0");

    // Mark the worm dead in the provider so alive counts reflect reality.
    room.provider.deadWorms.add(dyingWormId);
    room.provider.counts.set("red", 1); // one worm left on red

    // Call onWormDied once - do NOT call onTick after.
    arbiter.onWormDied(dyingWormId);

    // Turn must have advanced without any onTick call.
    expect(room.state.currentWormId).not.toBe(dyingWormId);
    expect(room.state.currentTeamId).toBe("blue");

    // pendingAdvance must not be the gating factor - advance already happened.
    expect((arbiter as unknown as { pendingAdvance: boolean }).pendingAdvance).toBe(false);
  });

  it("start() resets gameOver when a second match follows a completed game", () => {
    const room = new StubRoom();
    const arbiter = new TurnArbiter(room);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    room.connected.add("alice");
    room.connected.add("bob");

    // Game 1: start, kill all red worms to end the match.
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);
    room.provider.counts.set("red", 0);
    room.provider.deadWorms.add("red-0");
    room.provider.deadWorms.add("red-1");
    arbiter.onWormDied("red-1");
    arbiter.onTick(50);

    expect(arbiter.isGameOver()).toBe(true);

    // Game 2.
    setAllAlive(room.provider, rosters);
    room.provider.deadWorms.clear();
    arbiter.start(["blue", "red"], rosters, TURN_DURATION_MS);

    expect(arbiter.isGameOver()).toBe(false);
    expect(room.state.turnSeq).toBe(1);
    expect(room.state.turnEndsAt).toBeGreaterThan(Date.now() + TURN_DURATION_MS - 1000);
  });
});

describe("TurnArbiter - early-settle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeSettleRoom(settled: boolean): { room: StubRoom; arbiter: TurnArbiter } {
    const room = new StubRoom();
    room.connected = new Set(["alice", "bob"]);
    const rosters = [rosterFor("red", "alice"), rosterFor("blue", "bob")];
    setAllAlive(room.provider, rosters);
    room.provider.settled = settled;
    const arbiter = new TurnArbiter(room);
    arbiter.start(["red", "blue"], rosters, TURN_DURATION_MS);
    return { room, arbiter };
  }

  it("advances turn within ~500ms of ticks when sim is settled after turnEndsAt", () => {
    const { room, arbiter } = makeSettleRoom(true);

    // Expire the turn timer.
    vi.setSystemTime(room.state.turnEndsAt + 100);

    // Accumulate 10 ticks at 50ms each = 500ms. Should trigger advance.
    let advanced = false;
    const turnSeqBefore = room.state.turnSeq;
    for (let i = 0; i < 10; i++) {
      arbiter.onTick(50);
      if (room.state.turnSeq !== turnSeqBefore) {
        advanced = true;
        break;
      }
    }
    expect(advanced).toBe(true);
    // Should NOT have taken the full 6s safety cap.
    expect(Date.now()).toBeLessThan(room.state.turnEndsAt + SETTLE_GRACE_MS);
  });

  it("does NOT advance early when sim is not settled; safety cap still fires at 6s", () => {
    const { room, arbiter } = makeSettleRoom(false);

    // Expire the turn timer but not yet the 6s grace.
    vi.setSystemTime(room.state.turnEndsAt + 100);
    const turnSeqBefore = room.state.turnSeq;

    // Tick 9 times (450ms) - not settled, so hold counter stays 0.
    for (let i = 0; i < 9; i++) arbiter.onTick(50);
    // Turn should NOT have advanced yet.
    expect(room.state.turnSeq).toBe(turnSeqBefore);

    // Advance past the 6s safety cap.
    vi.setSystemTime(room.state.turnEndsAt + SETTLE_GRACE_MS + 100);
    arbiter.onTick(50);
    expect(room.state.turnSeq).toBeGreaterThan(turnSeqBefore);
  });

  it("dtMs guard: zero and negative ticks do not advance turn or make settleHoldMs go negative", () => {
    const { room, arbiter } = makeSettleRoom(true);

    // Expire the turn timer.
    vi.setSystemTime(room.state.turnEndsAt + 100);
    const turnSeqBefore = room.state.turnSeq;

    // Feed zero and negative ticks several times.
    arbiter.onTick(0);
    arbiter.onTick(-5);
    arbiter.onTick(0);
    arbiter.onTick(-100);
    arbiter.onTick(0);

    // Turn should NOT have advanced - zero/negative ticks add 0 so 500ms
    // hold is never reached.
    expect(room.state.turnSeq).toBe(turnSeqBefore);

    // settleHoldMs should be exactly 0 (never went negative).
    expect((arbiter as unknown as { settleHoldMs: number }).settleHoldMs).toBe(0);
  });

  it("resets settleHoldMs when sim un-settles mid-wait", () => {
    const { room, arbiter } = makeSettleRoom(true);

    // Expire the turn timer.
    vi.setSystemTime(room.state.turnEndsAt + 100);
    const turnSeqBefore = room.state.turnSeq;

    // Accumulate 4 ticks (200ms) while settled.
    for (let i = 0; i < 4; i++) arbiter.onTick(50);
    expect(room.state.turnSeq).toBe(turnSeqBefore); // not yet at 500ms

    // Sim becomes un-settled (explosion mid-settle) - resets the counter.
    room.provider.settled = false;
    arbiter.onTick(50);

    // Sim settles again; we need a fresh 500ms (10 ticks) accumulation.
    room.provider.settled = true;
    // 9 ticks = only 450ms since reset - should NOT advance yet.
    for (let i = 0; i < 9; i++) arbiter.onTick(50);
    expect(room.state.turnSeq).toBe(turnSeqBefore);

    // 10th tick crosses the 500ms hold and triggers advance.
    arbiter.onTick(50);
    expect(room.state.turnSeq).toBeGreaterThan(turnSeqBefore);
  });

  it("pause resume resets settleHoldMs so the full 500ms hold is required post-resume", () => {
    const { room, arbiter } = makeSettleRoom(true);

    // Expire the turn timer so early-settle accumulation can begin.
    vi.setSystemTime(room.state.turnEndsAt + 100);
    const turnSeqBefore = room.state.turnSeq;

    // Accumulate 300ms of settled ticks (6 x 50ms).
    for (let i = 0; i < 6; i++) arbiter.onTick(50);
    expect(room.state.turnSeq).toBe(turnSeqBefore); // not yet at 500ms

    // Pause the turn (owner disconnects).
    arbiter.onOwnerDisconnected("alice");

    // Resume - settleHoldMs should be reset to 0.
    arbiter.onOwnerReconnected("alice");
    expect((arbiter as unknown as { settleHoldMs: number }).settleHoldMs).toBe(0);

    // Now the new turnEndsAt is in the future (pause restored remaining time).
    // Push time past it so early-settle logic can fire.
    vi.setSystemTime(room.state.turnEndsAt + 100);

    // 9 ticks = only 450ms since resume - should NOT advance yet.
    for (let i = 0; i < 9; i++) arbiter.onTick(50);
    expect(room.state.turnSeq).toBe(turnSeqBefore);

    // 10th tick brings holdMs to 500ms - should advance now.
    arbiter.onTick(50);
    expect(room.state.turnSeq).toBeGreaterThan(turnSeqBefore);
  });
});
