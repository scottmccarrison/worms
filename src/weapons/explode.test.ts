import { Circle, World } from "planck";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import { explode } from "./explode";
import type { ExplosionConfig } from "./types";

// ---------------------------------------------------------------------------
// Minimal Terrain double - records cutCircle calls without rendering
// ---------------------------------------------------------------------------
function makeTerrainDouble() {
  return {
    cutCircle: vi.fn((_x: number, _y: number, _r: number) => {
      // no-op in tests
    }),
  };
}

// ---------------------------------------------------------------------------
// Minimal Worm double - enough for explode() to detect and damage it
// ---------------------------------------------------------------------------
function makeWormAt(world: ReturnType<typeof World>, xPx: number, yPx: number) {
  const body = world.createBody({
    type: "dynamic",
    position: { x: toMeters(xPx), y: toMeters(yPx) },
  });
  body.createFixture({ shape: new Circle(toMeters(6)) });

  let damage = 0;
  const worm = {
    body,
    isAlive: true, // required by explode() to process damage
    takeDamage(amount: number) {
      damage += amount;
    },
    get totalDamage() {
      return damage;
    },
  };

  const ud: WormUserData = { kind: "worm", worm: worm as unknown as Worm };
  body.setUserData(ud);

  return worm;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("explode()", () => {
  let world: ReturnType<typeof World>;
  let terrain: ReturnType<typeof makeTerrainDouble>;
  const config: ExplosionConfig = {
    terrainRadiusPx: 40,
    damageRadiusPx: 60,
    maxDamage: 100,
    impulseMag: 50,
  };

  beforeEach(() => {
    world = World({ gravity: { x: 0, y: 10 } });
    terrain = makeTerrainDouble();
  });

  it("calls terrain.cutCircle with correct radius", () => {
    const center = { x: 200, y: 200 };
    explode({
      world,
      terrain: terrain as never,
      centerPx: center,
      config,
      firedBy: null,
    });
    expect(terrain.cutCircle).toHaveBeenCalledOnce();
    expect(terrain.cutCircle).toHaveBeenCalledWith(center.x, center.y, config.terrainRadiusPx);
  });

  it("worm at explosion center takes maxDamage", () => {
    const centerPx = { x: 400, y: 300 };
    const worm = makeWormAt(world, centerPx.x, centerPx.y);

    explode({ world, terrain: terrain as never, centerPx, config, firedBy: null });

    expect(worm.totalDamage).toBe(config.maxDamage);
  });

  it("worm at damageRadius boundary takes 0 damage", () => {
    const centerPx = { x: 400, y: 300 };
    // Worm at exactly damageRadius away
    const worm = makeWormAt(world, centerPx.x + config.damageRadiusPx, centerPx.y);

    const result = explode({ world, terrain: terrain as never, centerPx, config, firedBy: null });

    // At the edge falloff = max(0, 1 - 1) = 0 -> round(0) = 0
    expect(result.damagedWorms).toHaveLength(0);
    expect(worm.totalDamage).toBe(0);
  });

  it("tracks self-damage when firedBy is the damaged worm", () => {
    const centerPx = { x: 400, y: 300 };
    // Place firer 10px from center (well within radius)
    const firer = makeWormAt(world, centerPx.x + 10, centerPx.y);

    const result = explode({
      world,
      terrain: terrain as never,
      centerPx,
      config,
      firedBy: firer as never,
    });

    expect(result.selfDamageTaken).toBeGreaterThan(0);
    expect(result.damagedWorms).toHaveLength(1);
    expect(result.selfDamageTaken).toBe(result.damagedWorms[0]?.amount ?? 0);
  });

  it("worm far outside radius is untouched", () => {
    const centerPx = { x: 400, y: 300 };
    // Place worm 3x damageRadius away
    const worm = makeWormAt(world, centerPx.x + config.damageRadiusPx * 3, centerPx.y);

    const result = explode({ world, terrain: terrain as never, centerPx, config, firedBy: null });

    expect(result.damagedWorms).toHaveLength(0);
    expect(worm.totalDamage).toBe(0);
  });
});
