import { World } from "planck";
import { Circle } from "planck";
import { describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import type { ProjectileManager } from "./ProjectileManager";
import { dynamite } from "./dynamite";
import { fire } from "./fire";
import type { FireContext } from "./types";

function makeWormStub(world: ReturnType<typeof World>, xPx: number, yPx: number) {
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
  return worm;
}

function makeProjectileManagerSpy() {
  const spawns: Parameters<ProjectileManager["spawn"]>[0][] = [];
  return {
    spawn: vi.fn((args: Parameters<ProjectileManager["spawn"]>[0]) => {
      spawns.push(args);
    }),
    spawns,
  } as unknown as ProjectileManager & { spawns: typeof spawns };
}

describe("dynamite weapon config", () => {
  it("has fuseMs=5000", () => {
    expect(dynamite.fuseMs).toBe(5000);
  });

  it("has powerCapMps <= 2 (drops at feet)", () => {
    expect(dynamite.powerCapMps ?? 0).toBeLessThanOrEqual(2);
  });

  it("has large explosion radius (terrainRadiusPx >= 60)", () => {
    expect(dynamite.explosion.terrainRadiusPx).toBeGreaterThanOrEqual(60);
  });

  it("fires with low initial speed - projectile velocity < 3 mps at full power", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const worm = makeWormStub(world, 400, 300);
    const pm = makeProjectileManagerSpy();
    const ctx: FireContext = {
      world,
      terrain: { cutCircle: vi.fn() } as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 1.0, // full power
      projectileManager: pm,
    };

    fire(dynamite, ctx, 0);

    expect(pm.spawns.length).toBe(1);
    const spawn = pm.spawns[0];
    if (!spawn) throw new Error("Expected a spawn");
    const speed = Math.sqrt(spawn.velocityMps.x ** 2 + spawn.velocityMps.y ** 2);
    expect(speed).toBeLessThan(3);
  });

  it("spawns with fuseMs=5000 (throwable archetype)", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const worm = makeWormStub(world, 400, 300);
    const pm = makeProjectileManagerSpy();
    const ctx: FireContext = {
      world,
      terrain: { cutCircle: vi.fn() } as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.5,
      projectileManager: pm,
    };

    fire(dynamite, ctx, 0);

    expect(pm.spawns[0]?.fuseMs).toBe(5000);
  });
});
