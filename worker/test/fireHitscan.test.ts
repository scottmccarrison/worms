/**
 * Unit tests for fireHitscan() multi-shot looping behavior.
 *
 * We avoid spinning up a full planck World + Terrain because the behavior
 * under test is "loop count" (does the function fire N pellets?), not
 * raycast accuracy. Instead we use a stubbed World whose rayCast always
 * invokes its callback with a fixed hit point so every shot hits, and a
 * minimal stub Terrain (cutCircle is a no-op for these tests).
 *
 * Test 3 (bazooka regression) does need a minimal real planck World to
 * produce a valid Body for the worm, but no rayCast is needed there since
 * bazooka is a projectile archetype.
 */

import { World } from "planck";
import type { Fixture } from "planck";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Terrain } from "../src/entities/terrain.js";
import type { Worm } from "../src/entities/worm.js";
import { toMeters } from "../src/physics/scale.js";
import { bazooka } from "../src/weapons/bazooka.js";
import { fire } from "../src/weapons/fire.js";
import type { FireContext } from "../src/weapons/fire.js";
import { minigun } from "../src/weapons/minigun.js";
import { shotgun } from "../src/weapons/shotgun.js";

// ---- Minimal stubs ----

/** A World stub whose rayCast always calls back with a fixed hit at (100px, 100px). */
function makeAlwaysHitWorld(): World {
  const world = new World();
  // Override rayCast to always invoke the callback once with a hit at a fixed point.
  // The stub fixture only needs getBody() returning null (not firer.body) so the
  // server-side raycastFirstHit() accepts the hit. We escape type-checking here
  // because we're only testing loop count, not planck fixture internals.
  (world as unknown as Pick<World, "rayCast">).rayCast = (
    _from: unknown,
    _to: unknown,
    callback: (
      fixture: Fixture,
      point: { x: number; y: number },
      normal: { x: number; y: number },
      fraction: number,
    ) => number,
  ) => {
    callback(
      { getBody: () => null } as unknown as Fixture,
      { x: toMeters(100), y: toMeters(100) },
      { x: -1, y: 0 },
      0.5,
    );
  };
  return world;
}

/** A World stub whose rayCast never invokes the callback (simulating no hit on any ray). */
function makeNeverHitWorld(): World {
  const world = new World();
  // Override rayCast to never call the callback; simulates no surface intersection.
  (world as unknown as Pick<World, "rayCast">).rayCast = (
    _from: unknown,
    _to: unknown,
    _callback: (
      fixture: Fixture,
      point: { x: number; y: number },
      normal: { x: number; y: number },
      fraction: number,
    ) => number,
  ) => {
    // No callback invocation; rayCast returns with no hits found.
  };
  return world;
}

/** Terrain stub - cutCircle is a no-op; consumeCutLog returns []. */
function makeFakeTerrain(): Terrain {
  return {
    cutCircle: () => {},
    consumeCutLog: () => [],
    widthPx: 1280,
    heightPx: 720,
  } as unknown as Terrain;
}

/** Build a minimal Worm-like object positioned at (200px, 300px). */
function makeFakeWorm(world: World): Worm {
  const body = world.createBody({
    type: "dynamic",
    position: { x: toMeters(200), y: toMeters(300) },
    fixedRotation: true,
  });
  return {
    id: "test-worm",
    teamId: "red",
    body,
    health: 100,
    alive: true,
    facing: 1,
    aimAngle: 0,
    aimPower: 1,
    radiusPx: 12,
    maxHp: 100,
  } as unknown as Worm;
}

// ---- Tests ----

describe("fireHitscan - shotgun (2 pellets, no spread)", () => {
  let world: World;
  let firer: Worm;

  beforeEach(() => {
    world = makeAlwaysHitWorld();
    firer = makeFakeWorm(new World()); // real planck World for the body
  });

  it("fires exactly 2 pellets and each produces an ExplodeResult", () => {
    const ctx: FireContext = {
      world,
      terrain: makeFakeTerrain(),
      worms: [],
      firer,
      weapon: shotgun,
      aimRadians: 0,
      aimPower01: 1,
      shotsFiredBefore: 0,
    };

    const result = fire(ctx);

    expect(result.explodeResults).toHaveLength(2);
    expect(result.turnEndsImmediately).toBe(true);
    expect(result.shotsRemaining).toBe(0);
    expect(result.spawn).toBeNull();
  });

  it("returns empty explodeResults when no rays hit", () => {
    const neverHitWorld = makeNeverHitWorld();
    const ctx: FireContext = {
      world: neverHitWorld,
      terrain: makeFakeTerrain(),
      worms: [],
      firer,
      weapon: shotgun,
      aimRadians: 0,
      aimPower01: 1,
      shotsFiredBefore: 0,
    };

    const result = fire(ctx);

    expect(result.explodeResults).toHaveLength(0);
    expect(result.turnEndsImmediately).toBe(true);
    expect(result.shotsRemaining).toBe(0);
  });
});

describe("fireHitscan - minigun (12 pellets, with spread)", () => {
  let world: World;
  let firer: Worm;

  beforeEach(() => {
    world = makeAlwaysHitWorld();
    firer = makeFakeWorm(new World());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires exactly 12 pellets when all rays hit terrain", () => {
    const ctx: FireContext = {
      world,
      terrain: makeFakeTerrain(),
      worms: [],
      firer,
      weapon: minigun,
      aimRadians: 0,
      aimPower01: 1,
      shotsFiredBefore: 0,
    };

    const result = fire(ctx);

    expect(result.explodeResults).toHaveLength(12);
    expect(result.turnEndsImmediately).toBe(true);
    expect(result.shotsRemaining).toBe(0);
  });

  it("applies distinct per-shot jitter when spread is set", () => {
    // Stub Math.random to return a deterministic sequence so we can verify
    // that jitter is re-sampled on each shot (not computed once and reused).
    let callCount = 0;
    const sequence = Array.from({ length: 12 }, (_, i) => i / 11); // 0..1 spread
    vi.spyOn(Math, "random").mockImplementation(() => sequence[callCount++ % sequence.length]);

    const ctx: FireContext = {
      world,
      terrain: makeFakeTerrain(),
      worms: [],
      firer,
      weapon: minigun,
      aimRadians: 0,
      aimPower01: 1,
      shotsFiredBefore: 0,
    };

    const result = fire(ctx);

    // Math.random must have been called twice per pellet (Bates-2 triangular
    // distribution: jitter = (rand - 0.5) + (rand - 0.5)) so 24 calls for 12 pellets.
    expect(callCount).toBe(24);
    // All 12 hits should be present.
    expect(result.explodeResults).toHaveLength(12);
  });
});

describe("fireHitscan - bazooka regression (projectile archetype)", () => {
  it("returns spawn non-null and explodeResults empty for projectile weapon", () => {
    const realWorld = new World();
    const firer = makeFakeWorm(realWorld);

    const ctx: FireContext = {
      world: realWorld,
      terrain: makeFakeTerrain(),
      worms: [],
      firer,
      weapon: bazooka,
      aimRadians: 0,
      aimPower01: 1,
      shotsFiredBefore: 0,
    };

    const result = fire(ctx);

    expect(result.explodeResults).toHaveLength(0);
    expect(result.spawn).not.toBeNull();
    expect(result.spawn?.weapon.id).toBe("bazooka");
  });
});
