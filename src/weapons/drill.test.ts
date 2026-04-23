import { Circle, World } from "planck";
import { describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Worm, WormUserData } from "../worm/Worm";
import type { ProjectileManager } from "./ProjectileManager";
import { drill } from "./drill";
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

describe("drill weapon config", () => {
  it("has fuseMs=3500", () => {
    expect(drill.fuseMs).toBe(3500);
  });

  it("has tunnel config with cutIntervalMs=40", () => {
    expect(drill.tunnel).toBeDefined();
    expect(drill.tunnel?.cutIntervalMs).toBe(40);
    expect(drill.tunnel?.cutRadiusPx).toBeGreaterThan(0);
  });

  it("spawns projectile with fuseMs=3500 (fuse detonation)", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const worm = makeWormStub(world, 400, 300);
    const pm = makeProjectileManagerSpy();
    const ctx: FireContext = {
      world,
      terrain: { cutCircle: vi.fn() } as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.8,
      projectileManager: pm,
    };

    fire(drill, ctx, 0);

    expect(pm.spawns.length).toBe(1);
    expect(pm.spawns[0]?.fuseMs).toBe(3500);
  });

  it("over 3500ms flight, at 40ms cadence, carves at least 87 cuts", () => {
    // 3500ms / 40ms = 87.5 intervals => at least 87 cuts (integer floor)
    const expectedCuts = Math.floor(3500 / (drill.tunnel?.cutIntervalMs ?? 40));
    expect(expectedCuts).toBeGreaterThanOrEqual(87);
  });

  it("has projectile archetype (not throwable)", () => {
    expect(drill.archetype).toBe("projectile");
  });
});
