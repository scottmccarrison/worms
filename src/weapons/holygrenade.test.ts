import { Circle, World } from "planck";
import { describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Team } from "../worm/Team";
import type { Worm, WormUserData } from "../worm/Worm";
import type { ProjectileManager } from "./ProjectileManager";
import { WeaponManager } from "./WeaponManager";
import { fire } from "./fire";
import { holyGrenade } from "./holygrenade";
import { defaultAmmoForMatch } from "./registry";
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

function makeTeam(id: string): Team {
  return {
    id,
    name: id,
    color: 0xff0000,
    worms: [],
    addWorm: () => {},
    isEliminated: () => false,
  } as unknown as Team;
}

describe("holyGrenade weapon config", () => {
  it("has ammoPerMatch=2", () => {
    expect(holyGrenade.ammoPerMatch).toBe(2);
  });

  it("has fuseMs=4000", () => {
    expect(holyGrenade.fuseMs).toBe(4000);
  });

  it("has huge explosion radius (damageRadiusPx >= 100)", () => {
    expect(holyGrenade.explosion.damageRadiusPx).toBeGreaterThanOrEqual(100);
  });

  it("fires 2 times successfully", () => {
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

    fire(holyGrenade, ctx, 0);
    fire(holyGrenade, ctx, 0);

    expect(pm.spawns.length).toBe(2);
  });

  it("3rd fire rejected by WeaponManager (out of ammo)", () => {
    const team = makeTeam("red");
    const ammo = defaultAmmoForMatch();
    const manager = new WeaponManager(team, ammo);

    // Select holy grenade
    manager.select("holygrenade");
    expect(manager.getSelected().id).toBe("holygrenade");

    // Consume both shots
    manager.consumeOne("holygrenade");
    manager.consumeOne("holygrenade");

    // Third consume brings it to 0; select should fail
    manager.consumeOne("holygrenade");
    expect(manager.ammoFor("holygrenade")).toBe(0);

    // Selecting again with 0 ammo should fail
    // (first switch away, then back)
    manager.select("bazooka");
    const result = manager.select("holygrenade");
    expect(result).toBe(false);
  });
});
