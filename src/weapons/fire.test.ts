import { Circle, World } from "planck";
import { describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import type { ProjectileManager } from "./ProjectileManager";
import { bazooka } from "./bazooka";
import { fire } from "./fire";
import { handGrenade } from "./handgrenade";
import { shotgun } from "./shotgun";
import type { FireContext } from "./types";

// ---------------------------------------------------------------------------
// Minimal worm stub with xPx, yPx, facing, body, aimPower01
// ---------------------------------------------------------------------------
function makeWormStub(
  world: ReturnType<typeof World>,
  xPx: number,
  yPx: number,
): {
  worm: Pick<Worm, "xPx" | "yPx" | "facing" | "body" | "aimPower01" | "takeDamage">;
  body: ReturnType<World["createBody"]>;
} {
  const body = world.createBody({
    type: "dynamic",
    position: { x: toMeters(xPx), y: toMeters(yPx) },
  });
  body.createFixture({ shape: new Circle(toMeters(12)) });

  const worm = {
    xPx,
    yPx,
    facing: 1 as -1 | 1,
    aimPower01: 0.5,
    body,
    takeDamage: vi.fn(),
  };
  const ud: WormUserData = { kind: "worm", worm: worm as unknown as Worm };
  body.setUserData(ud);

  return { worm, body };
}

// ---------------------------------------------------------------------------
// Minimal ProjectileManager spy
// ---------------------------------------------------------------------------
function makeProjectileManagerSpy() {
  const spawns: Parameters<ProjectileManager["spawn"]>[0][] = [];
  return {
    spawn: vi.fn((args: Parameters<ProjectileManager["spawn"]>[0]) => {
      spawns.push(args);
    }),
    spawns,
    get count() {
      return spawns.length;
    },
  } as unknown as ProjectileManager & { spawns: typeof spawns };
}

// ---------------------------------------------------------------------------
// Minimal Terrain double
// ---------------------------------------------------------------------------
function makeTerrainDouble() {
  return {
    cutCircle: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fire() - hitscan (Shotgun)", () => {
  it("first shot with shotsPerActivation=2 returns turnEndsImmediately=false", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const { worm } = makeWormStub(world, 400, 300);
    const ctx: FireContext = {
      world,
      terrain: makeTerrainDouble() as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.5,
      projectileManager: makeProjectileManagerSpy(),
    };

    const result = fire(shotgun, ctx, 0);
    expect(result.turnEndsImmediately).toBe(false);
    expect(result.shotsRemaining).toBe(1);
  });

  it("second shot with shotsPerActivation=2 returns turnEndsImmediately=true", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const { worm } = makeWormStub(world, 400, 300);
    const ctx: FireContext = {
      world,
      terrain: makeTerrainDouble() as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.5,
      projectileManager: makeProjectileManagerSpy(),
    };

    // First shot (shotsFiredBefore=0 returned false; now call with 1)
    fire(shotgun, ctx, 0);
    const result = fire(shotgun, ctx, 1);
    expect(result.turnEndsImmediately).toBe(true);
    expect(result.shotsRemaining).toBe(0);
  });
});

describe("fire() - projectile (Bazooka)", () => {
  it("spawns one projectile in ProjectileManager with fuseMs=null", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const { worm } = makeWormStub(world, 400, 300);
    const pm = makeProjectileManagerSpy();
    const ctx: FireContext = {
      world,
      terrain: makeTerrainDouble() as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.8,
      projectileManager: pm,
    };

    const result = fire(bazooka, ctx, 0);

    expect(pm.spawn).toHaveBeenCalledOnce();
    expect(pm.spawns[0]?.fuseMs).toBeNull();
    expect(result.turnEndsImmediately).toBe(true);
    expect(result.shotsRemaining).toBe(0);
  });
});

describe("fire() - throwable (HandGrenade)", () => {
  it("spawns one projectile with fuseMs matching weapon config", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const { worm } = makeWormStub(world, 400, 300);
    const pm = makeProjectileManagerSpy();
    const ctx: FireContext = {
      world,
      terrain: makeTerrainDouble() as never,
      firer: worm as unknown as Worm,
      aimRadians: -Math.PI / 4,
      aimPower01: 0.6,
      projectileManager: pm,
    };

    const result = fire(handGrenade, ctx, 0);

    expect(pm.spawn).toHaveBeenCalledOnce();
    expect(pm.spawns[0]?.fuseMs).toBe(handGrenade.fuseMs);
    expect(result.turnEndsImmediately).toBe(true);
  });
});
