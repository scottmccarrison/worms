/**
 * NetworkedSimAdapter unit tests.
 *
 * The adapter sits between the Colyseus-ish RoomHandle and the renderer.
 * These tests use a fake RoomHandle that records `send` calls and lets us
 * drive `onMessage` subscriptions directly so we can assert:
 *
 *   1. sim_state frames land in the two-frame buffer (prev + curr shift
 *      correctly).
 *   2. Render state lerps between prev and curr based on wall-clock time.
 *   3. Event messages (terrain_cut, damage_event, worm_died, game_over)
 *      flow to the right subscribers.
 *   4. Input methods forward to room.send with properly incrementing seq.
 *   5. Aim updates are coalesced to 20Hz and flushed on fire().
 *   6. Rope / jetpack warn but don't crash (plan #65).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ClientMsg,
  DamageEventMessage,
  LobbyState,
  ServerMsg,
  SimStateMessage,
  TeamInit,
  TerrainCutMessage,
  WormDiedMessage,
} from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { NetworkedSimAdapter } from "./NetworkedSimAdapter";
import type { SimEvent } from "./SimAdapter";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeRoom extends RoomHandle {
  sent: ClientMsg[];
  dispatch<T extends ServerMsg["type"]>(msg: Extract<ServerMsg, { type: T }>): void;
}

function makeFakeRoom(): FakeRoom {
  const sent: ClientMsg[] = [];
  const messageSubs = new Map<string, Set<(msg: ServerMsg) => void>>();
  const closeSubs = new Set<(code: number) => void>();
  const stateSubs = new Set<(state: LobbyState) => void>();
  void stateSubs; // state is not exercised in these tests; adapter only
  // subscribes to individual messages.

  const state: LobbyState = {
    code: "TEST",
    phase: "playing",
    hostSessionId: "s-host",
    selectedMapId: "flat",
    players: {},
    teamOrder: ["red", "blue"],
    currentTeamId: "red",
    currentWormId: "red-1",
    turnSeq: 0,
    turnEndsAt: Date.now() + 30000,
  };

  const room: FakeRoom = {
    sessionId: "s-host",
    code: "TEST",
    resumeToken: "tok",
    state,
    sent,
    onStateChange(cb) {
      stateSubs.add(cb);
      return () => {
        stateSubs.delete(cb);
      };
    },
    onMessage<T extends ServerMsg["type"]>(
      type: T,
      cb: (msg: Extract<ServerMsg, { type: T }>) => void,
    ) {
      let set = messageSubs.get(type);
      if (!set) {
        set = new Set();
        messageSubs.set(type, set);
      }
      const wrapped = cb as (msg: ServerMsg) => void;
      set.add(wrapped);
      return () => {
        set?.delete(wrapped);
      };
    },
    send(msg: ClientMsg) {
      sent.push(msg);
    },
    leave() {
      // no-op
    },
    onClose(cb) {
      closeSubs.add(cb);
      return () => {
        closeSubs.delete(cb);
      };
    },
    dispatch(msg) {
      const set = messageSubs.get(msg.type);
      if (!set) return;
      for (const sub of set) sub(msg);
    },
  };
  return room;
}

function makeTeams(): TeamInit[] {
  return [
    {
      id: "red",
      name: "Team Red",
      color: "#ff4444",
      wormNames: ["red-1", "red-2"],
      ownerSessionId: "s-host",
    },
    {
      id: "blue",
      name: "Team Blue",
      color: "#4488ff",
      wormNames: ["blue-1", "blue-2"],
      ownerSessionId: "s-other",
    },
  ];
}

function makeSimState(overrides: Partial<SimStateMessage> = {}): SimStateMessage {
  return {
    type: "sim_state",
    tick: 0,
    worms: [
      {
        id: "red-1",
        x: 100,
        y: 200,
        vx: 0,
        vy: 0,
        facing: 1,
        aimAngle: 0,
        aimPower: 0.5,
        hp: 100,
        alive: true,
        activeWeapon: "bazooka",
        ammoLeft: -1,
      },
    ],
    projectiles: [],
    activeTeamId: "red",
    activeWormId: "red-1",
    turnEndsAt: Date.now() + 30000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NetworkedSimAdapter", () => {
  let originalNow: () => number;

  beforeEach(() => {
    originalNow = Date.now;
  });

  afterEach(() => {
    Date.now = originalNow;
  });

  it("exposes teams + worms from the TeamInit[]", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      expect(sim.teams).toHaveLength(2);
      expect(sim.teams[0]?.id).toBe("red");
      expect(sim.allWorms.map((w) => w.id)).toEqual(["red-1", "red-2", "blue-1", "blue-2"]);
    } finally {
      sim.destroy();
    }
  });

  it("ingests sim_state and reports active team + worm", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      const frame = makeSimState();
      room.dispatch(frame);
      expect(sim.getActiveTeamId()).toBe("red");
      expect(sim.getActiveWormId()).toBe("red-1");
    } finally {
      sim.destroy();
    }
  });

  it("fires onTurnChanged when activeTeamId flips across frames", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    const calls: Array<[string, string]> = [];
    sim.onTurnChanged((t, w) => calls.push([t, w]));
    try {
      room.dispatch(makeSimState());
      room.dispatch(makeSimState({ activeTeamId: "blue", activeWormId: "blue-1" }));
      expect(calls).toEqual([
        ["red", "red-1"],
        ["blue", "blue-1"],
      ]);
    } finally {
      sim.destroy();
    }
  });

  it("two-frame lerp: alpha=0.5 between two sim_states puts worm at midpoint", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({
      room,
      teams: makeTeams(),
      frameIntervalMs: 50,
    });
    try {
      // Freeze time so the alpha math is deterministic.
      let fakeNow = 10_000;
      Date.now = () => fakeNow;

      // First frame at x=100.
      room.dispatch(
        makeSimState({
          worms: [
            {
              id: "red-1",
              x: 100,
              y: 200,
              vx: 0,
              vy: 0,
              facing: 1,
              aimAngle: 0,
              aimPower: 0,
              hp: 100,
              alive: true,
              activeWeapon: "bazooka",
              ammoLeft: -1,
            },
          ],
        }),
      );

      // Advance 50ms so frame 1 is "fully committed" per the lerp horizon.
      fakeNow += 50;

      // Second frame at x=200. receivedAt = 10_050.
      room.dispatch(
        makeSimState({
          worms: [
            {
              id: "red-1",
              x: 200,
              y: 220,
              vx: 0,
              vy: 0,
              facing: 1,
              aimAngle: 0,
              aimPower: 0,
              hp: 100,
              alive: true,
              activeWeapon: "bazooka",
              ammoLeft: -1,
            },
          ],
        }),
      );

      // Advance 25ms: we're halfway through the 50ms window toward the curr
      // frame, so alpha = 0.5 between prev (100) and curr (200).
      fakeNow += 25;
      sim.update(16);
      const worm = sim.allWorms.find((w) => w.id === "red-1");
      expect(worm?.xPx).toBeCloseTo(150); // midpoint
      expect(worm?.yPx).toBeCloseTo(210); // 200 + (220-200)*0.5
    } finally {
      sim.destroy();
    }
  });

  it("alpha clamps to 1 when the server pauses (no runaway extrapolation)", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({
      room,
      teams: makeTeams(),
      frameIntervalMs: 50,
    });
    try {
      let fakeNow = 10_000;
      Date.now = () => fakeNow;

      room.dispatch(
        makeSimState({
          worms: [
            {
              id: "red-1",
              x: 100,
              y: 200,
              vx: 0,
              vy: 0,
              facing: 1,
              aimAngle: 0,
              aimPower: 0,
              hp: 100,
              alive: true,
              activeWeapon: "bazooka",
              ammoLeft: -1,
            },
          ],
        }),
      );
      fakeNow += 50;
      room.dispatch(
        makeSimState({
          worms: [
            {
              id: "red-1",
              x: 200,
              y: 200,
              vx: 0,
              vy: 0,
              facing: 1,
              aimAngle: 0,
              aimPower: 0,
              hp: 100,
              alive: true,
              activeWeapon: "bazooka",
              ammoLeft: -1,
            },
          ],
        }),
      );

      // Advance 5000ms - if extrapolation ran unbounded, xPx would land far
      // past 200. Clamping to alpha=1 keeps it pinned at the curr frame.
      fakeNow += 5000;
      sim.update(16);
      const worm = sim.allWorms.find((w) => w.id === "red-1");
      expect(worm?.xPx).toBeCloseTo(200);
    } finally {
      sim.destroy();
    }
  });

  it("projectiles lerp between prev and curr frames", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({
      room,
      teams: makeTeams(),
      frameIntervalMs: 50,
    });
    try {
      let fakeNow = 10_000;
      Date.now = () => fakeNow;

      room.dispatch(
        makeSimState({
          projectiles: [
            {
              id: "p1",
              ownerId: "Red-1",
              x: 300,
              y: 100,
              vx: 10,
              vy: 0,
              type: "bazooka",
              fuseRemainingMs: null,
            },
          ],
        }),
      );
      fakeNow += 50;
      room.dispatch(
        makeSimState({
          projectiles: [
            {
              id: "p1",
              ownerId: "Red-1",
              x: 500,
              y: 100,
              vx: 10,
              vy: 0,
              type: "bazooka",
              fuseRemainingMs: null,
            },
          ],
        }),
      );
      fakeNow += 25;
      sim.update(16);
      const projs = sim.getProjectiles();
      expect(projs).toHaveLength(1);
      expect(projs[0]?.xPx).toBeCloseTo(400); // midpoint between 300 and 500
    } finally {
      sim.destroy();
    }
  });

  it("dispatches terrain_cut / damage_event / worm_died to onEvent subscribers", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    const events: SimEvent[] = [];
    const unsub = sim.onEvent((ev) => events.push(ev));

    try {
      const cut: TerrainCutMessage = { type: "terrain_cut", x: 50, y: 60, r: 25, seq: 1 };
      const dmg: DamageEventMessage = {
        type: "damage_event",
        wormId: "red-1",
        amount: 30,
        fromProjectileId: "proj-1",
        impact: { x: 100, y: 200 },
      };
      const died: WormDiedMessage = { type: "worm_died", wormId: "red-1" };

      room.dispatch(cut);
      room.dispatch(dmg);
      room.dispatch(died);

      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({ type: "terrain_cut", x: 50, y: 60, r: 25, seq: 1 });
      expect(events[1]).toMatchObject({ type: "damage_event", wormId: "red-1", amount: 30 });
      expect(events[2]).toMatchObject({ type: "worm_died", wormId: "red-1" });

      // Unsub silences further dispatches.
      unsub();
      room.dispatch(cut);
      expect(events).toHaveLength(3);
    } finally {
      sim.destroy();
    }
  });

  it("forwards game_over to onGameOver subscribers with winnerTeamId", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    const winners: Array<string | null> = [];
    sim.onGameOver((w) => winners.push(w));
    try {
      room.dispatch({ type: "game_over", winnerTeamId: "red" });
      expect(winners).toEqual(["red"]);
    } finally {
      sim.destroy();
    }
  });

  it("fire() sends input_fire to the room with monotonic seq", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      sim.fire();
      sim.fire();
      const fires = room.sent.filter((m) => m.type === "input_fire");
      expect(fires).toHaveLength(2);
      // Second fire should have a larger seq than the first.
      const seqs = fires.map((m) => (m as { seq: number }).seq);
      expect(seqs[1] ?? 0).toBeGreaterThan(seqs[0] ?? 0);
    } finally {
      sim.destroy();
    }
  });

  it("walk() dedupes same-direction calls (transition-only send)", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      sim.walk(1);
      sim.walk(1);
      sim.walk(1);
      sim.walk(0);
      const walks = room.sent.filter((m) => m.type === "input_walk");
      // 1 -> 0 is two transitions; the duplicated walk(1) calls are dropped.
      expect(walks).toHaveLength(2);
      expect((walks[0] as { dir: number }).dir).toBe(1);
      expect((walks[1] as { dir: number }).dir).toBe(0);
    } finally {
      sim.destroy();
    }
  });

  it("aim updates coalesce to ~20Hz and fire() flushes the pending pair", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      let fakeNow = 10_000;
      Date.now = () => fakeNow;

      // First setAimAngle flushes immediately (lastAimSendMs = 0).
      // The following setAimPower runs inside the 50ms window so it is
      // coalesced (pendingAimPower stays set; no send yet).
      sim.setAimAngle(0.1);
      sim.setAimPower(0.2);
      // Further aim updates within the window keep replacing pending.
      fakeNow += 10;
      sim.setAimAngle(0.3);
      sim.setAimPower(0.4);
      const pairsBeforeFire = room.sent.filter(
        (m) => m.type === "input_aim_angle" || m.type === "input_aim_power",
      );
      // Only the first angle went out pre-fire; the power flush was
      // throttled (same 50ms window after the angle landed).
      expect(pairsBeforeFire).toHaveLength(1);
      expect((pairsBeforeFire[0] as { angleRad: number }).angleRad).toBeCloseTo(0.1);

      // fire() flushes the latest pending pair AND sends input_fire.
      sim.fire();
      const fires = room.sent.filter((m) => m.type === "input_fire");
      expect(fires).toHaveLength(1);
      const pairsAfterFire = room.sent.filter(
        (m) => m.type === "input_aim_angle" || m.type === "input_aim_power",
      );
      // Pre-fire: 1 angle. Fire flush: 1 more angle (the pending) + 1 power.
      expect(pairsAfterFire).toHaveLength(3);
      const lastAngle = pairsAfterFire.filter((m) => m.type === "input_aim_angle").pop();
      const lastPower = pairsAfterFire.filter((m) => m.type === "input_aim_power").pop();
      expect((lastAngle as { angleRad: number }).angleRad).toBeCloseTo(0.3);
      expect((lastPower as { power: number }).power).toBeCloseTo(0.4);
    } finally {
      sim.destroy();
    }
  });

  it("rope + jetpack warn but do not crash (plan #65 disabled in networked mode)", () => {
    const room = makeFakeRoom();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    try {
      sim.toggleRope();
      sim.toggleJetPack();
      expect(warn).toHaveBeenCalledTimes(2);
      // No room.send for either call.
      expect(room.sent.filter((m) => m.type.startsWith("input_rope")).length).toBe(0);
    } finally {
      sim.destroy();
      warn.mockRestore();
    }
  });

  it("destroy() tears down subscriptions: no further events leak to subscribers", () => {
    const room = makeFakeRoom();
    const sim = new NetworkedSimAdapter({ room, teams: makeTeams() });
    const events: SimEvent[] = [];
    sim.onEvent((ev) => events.push(ev));
    sim.destroy();
    room.dispatch({ type: "terrain_cut", x: 1, y: 1, r: 1, seq: 1 });
    expect(events).toHaveLength(0);
  });
});
