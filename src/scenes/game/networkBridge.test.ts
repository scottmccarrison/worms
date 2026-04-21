import { describe, expect, it, vi } from "vitest";
import { toMeters, toPixels } from "../../physics/scale";
import type { CircleCut, WormSnapshot } from "../../net/types";
import {
  type TeamLike,
  type WormLike,
  type WormSnapshotApplyTarget,
  type WormSnapshotSource,
  applyRemoteInput,
  buildTurnSnapshot,
  setWormFromSnapshot,
} from "./networkBridge";

// ---------------------------------------------------------------------------
// Mocks: plain objects shaped like the duck-typed interfaces. No Phaser, no
// planck. Keeps this file pure-unit, no test setup required.
// ---------------------------------------------------------------------------

function makeMockWormLike() {
  return {
    walk: vi.fn<(dir: -1 | 0 | 1) => void>(),
    jump: vi.fn<() => void>(),
    backflip: vi.fn<() => void>(),
    setAimAngle: vi.fn<(rad: number) => void>(),
    setAimPower: vi.fn<(p: number) => void>(),
    setFacing: vi.fn<(dir: -1 | 1) => void>(),
  } satisfies WormLike;
}

function makeSourceWorm(opts: {
  name: string;
  xPx: number;
  yPx: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
}): WormSnapshotSource {
  return {
    name: opts.name,
    health: opts.hp,
    isAlive: opts.alive,
    body: {
      getPosition: () => ({ x: toMeters(opts.xPx), y: toMeters(opts.yPx) }),
      getLinearVelocity: () => ({ x: opts.vx, y: opts.vy }),
    },
  };
}

// ---------------------------------------------------------------------------
// applyRemoteInput
// ---------------------------------------------------------------------------

describe("applyRemoteInput", () => {
  it('maps "walk" with dir=-1 to worm.walk(-1)', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "walk", { dir: -1, seq: 1 });
    expect(worm.walk).toHaveBeenCalledTimes(1);
    expect(worm.walk).toHaveBeenCalledWith(-1);
  });

  it('maps "jump" to worm.jump()', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "jump", { seq: 2 });
    expect(worm.jump).toHaveBeenCalledTimes(1);
  });

  it('maps "backflip" to worm.backflip()', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "backflip", { seq: 3 });
    expect(worm.backflip).toHaveBeenCalledTimes(1);
  });

  it('maps "aim_angle" to worm.setAimAngle(angleRad)', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "aim_angle", { angleRad: 1.5, seq: 4 });
    expect(worm.setAimAngle).toHaveBeenCalledTimes(1);
    expect(worm.setAimAngle).toHaveBeenCalledWith(1.5);
  });

  it('maps "aim_power" to worm.setAimPower(power)', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "aim_power", { power: 0.7, seq: 5 });
    expect(worm.setAimPower).toHaveBeenCalledTimes(1);
    expect(worm.setAimPower).toHaveBeenCalledWith(0.7);
  });

  it('"fire" is a no-op on the worm (handled at GameScene level)', () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "fire", { seq: 6 });
    expect(worm.walk).not.toHaveBeenCalled();
    expect(worm.jump).not.toHaveBeenCalled();
    expect(worm.backflip).not.toHaveBeenCalled();
    expect(worm.setAimAngle).not.toHaveBeenCalled();
    expect(worm.setAimPower).not.toHaveBeenCalled();
    expect(worm.setFacing).not.toHaveBeenCalled();
  });

  it("unknown types are silently ignored (forward-compat)", () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "some_future_input", { seq: 99 });
    expect(worm.walk).not.toHaveBeenCalled();
    expect(worm.jump).not.toHaveBeenCalled();
    expect(worm.backflip).not.toHaveBeenCalled();
  });

  it("accepts the full message-type prefix (input_*)", () => {
    const worm = makeMockWormLike();
    applyRemoteInput(worm, "input_walk", { dir: 1, seq: 1 });
    expect(worm.walk).toHaveBeenCalledWith(1);
  });
});

// ---------------------------------------------------------------------------
// buildTurnSnapshot
// ---------------------------------------------------------------------------

describe("buildTurnSnapshot", () => {
  it("serializes all worms across all teams with pixel positions", () => {
    const red: TeamLike = {
      id: "red",
      worms: [
        makeSourceWorm({ name: "red-0", xPx: 100, yPx: 200, vx: 1, vy: -2, hp: 100, alive: true }),
        makeSourceWorm({ name: "red-1", xPx: 110, yPx: 210, vx: 0, vy: 0, hp: 50, alive: true }),
      ],
    };
    const blue: TeamLike = {
      id: "blue",
      worms: [
        makeSourceWorm({ name: "blue-0", xPx: 400, yPx: 205, vx: 0, vy: 0, hp: 0, alive: false }),
      ],
    };
    const cuts: CircleCut[] = [{ x: 50, y: 60, r: 30, seq: 1 }];

    const snap = buildTurnSnapshot([red, blue], cuts);

    expect(snap.worms).toHaveLength(3);
    expect(snap.worms[0]).toEqual({
      id: "red-0",
      x: 100,
      y: 200,
      vx: 1,
      vy: -2,
      hp: 100,
      alive: true,
    });
    expect(snap.worms[2]).toEqual({
      id: "blue-0",
      x: 400,
      y: 205,
      vx: 0,
      vy: 0,
      hp: 0,
      alive: false,
    });
    // Terrain cuts round-tripped unchanged.
    expect(snap.terrainCuts).toEqual(cuts);
    // Defensive copy: mutating the outgoing array does not affect the input.
    snap.terrainCuts.push({ x: 0, y: 0, r: 0, seq: 99 });
    expect(cuts).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// setWormFromSnapshot
// ---------------------------------------------------------------------------

describe("setWormFromSnapshot", () => {
  it("snaps body position + velocity, sets hp/alive, wakes body", () => {
    const setPosition = vi.fn();
    const setLinearVelocity = vi.fn();
    const setAwake = vi.fn();

    const target: WormSnapshotApplyTarget = {
      name: "red-0",
      health: 100,
      isAlive: true,
      body: { setPosition, setLinearVelocity, setAwake },
    };

    const snap: WormSnapshot = {
      id: "red-0",
      x: 300,
      y: 150,
      vx: 5,
      vy: -3,
      hp: 42,
      alive: false,
    };

    setWormFromSnapshot(target, snap);

    // Position arrives in pixels, body is in meters - assert conversion.
    expect(setPosition).toHaveBeenCalledTimes(1);
    const posArg = setPosition.mock.calls[0]?.[0] as { x: number; y: number };
    expect(posArg.x).toBeCloseTo(toMeters(300));
    expect(posArg.y).toBeCloseTo(toMeters(150));
    expect(toPixels(posArg.x)).toBeCloseTo(300);

    // Velocity is already in m/s; no conversion.
    expect(setLinearVelocity).toHaveBeenCalledWith({ x: 5, y: -3 });

    // Body woken so the new velocity takes effect.
    expect(setAwake).toHaveBeenCalledWith(true);

    // Health + alive flipped.
    expect(target.health).toBe(42);
    expect(target.isAlive).toBe(false);
  });
});
