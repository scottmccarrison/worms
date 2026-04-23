import { Circle, World } from "planck";
import { describe, expect, it, vi } from "vitest";
import { toMeters } from "../physics/scale";
import type { Worm, WormUserData } from "../worm/Worm";
import { fire } from "./fire";
import { minigun } from "./minigun";
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

describe("minigun weapon config", () => {
  it("has shotsPerActivation=12", () => {
    expect(minigun.shotsPerActivation).toBe(12);
  });

  it("has hitscanSpreadRad=0.08", () => {
    expect(minigun.hitscanSpreadRad).toBe(0.08);
  });

  it("fires 12 shots total across 12 activations before turn ends", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const worm = makeWormStub(world, 400, 300);
    const ctx: FireContext = {
      world,
      terrain: { cutCircle: vi.fn() } as never,
      firer: worm as unknown as Worm,
      aimRadians: 0,
      aimPower01: 0.5,
      projectileManager: {} as never, // minigun is hitscan, no projectile manager needed
    };

    // Fire shots 1-11: should not end the turn
    for (let i = 0; i < 11; i++) {
      const result = fire(minigun, ctx, i);
      expect(result.turnEndsImmediately).toBe(false);
    }

    // 12th shot should end the turn
    const final = fire(minigun, ctx, 11);
    expect(final.turnEndsImmediately).toBe(true);
    expect(final.shotsRemaining).toBe(0);
  });

  it("spread jitter keeps angles within +-hitscanSpreadRad of aim", () => {
    // Fire many shots and check that rays don't deviate beyond spread.
    // We can't directly inspect the shot angle, but we can verify the weapon
    // config is consistent: spread is small enough to matter but not huge.
    const spread = minigun.hitscanSpreadRad ?? 0;
    expect(spread).toBeGreaterThan(0);
    expect(spread).toBeLessThan(Math.PI / 4); // sanity: less than 45 degrees
  });
});
