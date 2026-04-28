import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import type { Theme } from "../themes";
import { MASK_AIR, MASK_SOLID, createWorld } from "../world";
import type { World } from "../world";
import { finalizeMaskPass } from "./finalizeMask";

function makeCtx(world: World, passIndex: number): PassContext {
  return {
    world,
    rng: rngForPass(world.seed, passIndex),
    passIndex,
    tuning,
    resolveParam: (key, fb) => {
      const v = world.theme?.params[key];
      return typeof v === "number" ? v : fb;
    },
  };
}

function setupWorld(w: number, h: number, themeTag: string): World {
  const world = createWorld(0, w, h, themeTag);
  world.theme = getTheme(themeTag);
  return world;
}

/** Return a copy of a theme with maskHygieneThresholdPx overridden. */
function withThreshold(base: Theme, px: number): Theme {
  return { ...base, params: { ...base.params, maskHygieneThresholdPx: px } };
}

describe("finalizeMaskPass", () => {
  it("removes a small orphan island below threshold while preserving large main", () => {
    // 100x100 world. Big main component on the right half (50*100=5000 px).
    // Small island at top-left (5x5 = 25 px).
    const world = setupWorld(100, 100, "default");
    // Override threshold via theme param for predictable test
    world.theme = withThreshold(getTheme("default"), 50);
    // Big main: x in [50, 100), y in [0, 100)
    for (let y = 0; y < 100; y++) {
      for (let x = 50; x < 100; x++) world.mask[y * 100 + x] = MASK_SOLID;
    }
    // Small island: x in [10, 15), y in [10, 15)
    for (let y = 10; y < 15; y++) {
      for (let x = 10; x < 15; x++) world.mask[y * 100 + x] = MASK_SOLID;
    }
    finalizeMaskPass.run(makeCtx(world, 7));
    // Small island removed
    for (let y = 10; y < 15; y++) {
      for (let x = 10; x < 15; x++) {
        expect(world.mask[y * 100 + x]).toBe(MASK_AIR);
      }
    }
    // Main intact (sample a few)
    expect(world.mask[0 * 100 + 50]).toBe(MASK_SOLID);
    expect(world.mask[50 * 100 + 75]).toBe(MASK_SOLID);
    expect(world.mask[99 * 100 + 99]).toBe(MASK_SOLID);
  });

  it("is deterministic: identical mask in produces identical mask out", () => {
    const w1 = setupWorld(50, 50, "default");
    const w2 = setupWorld(50, 50, "default");
    // Pre-populate identical patterns
    for (let i = 0; i < 50 * 50; i++) {
      const v: 0 | 1 = i % 7 === 0 ? 1 : 0;
      w1.mask[i] = v;
      w2.mask[i] = v;
    }
    finalizeMaskPass.run(makeCtx(w1, 7));
    finalizeMaskPass.run(makeCtx(w2, 7));
    expect(Array.from(w1.mask)).toEqual(Array.from(w2.mask));
  });

  it("threshold = 0 is a no-op (early return)", () => {
    const world = setupWorld(20, 20, "default");
    world.theme = withThreshold(getTheme("default"), 0);
    // Single isolated solid pixel
    world.mask[10 * 20 + 10] = MASK_SOLID;
    finalizeMaskPass.run(makeCtx(world, 7));
    expect(world.mask[10 * 20 + 10]).toBe(MASK_SOLID);
  });

  it("theme threshold override beats tuning default", () => {
    const world = setupWorld(20, 20, "default");
    // Solid component of size 10
    for (let i = 0; i < 10; i++) world.mask[i] = MASK_SOLID;
    // tuning.worldgen.hygiene.thresholdPx default after this PR is 1024;
    // but we override via theme param to 100. Component (10) < threshold (100): removed.
    world.theme = withThreshold(getTheme("default"), 100);
    finalizeMaskPass.run(makeCtx(world, 7));
    for (let i = 0; i < 10; i++) expect(world.mask[i]).toBe(MASK_AIR);
  });

  it("preserves a component exactly at the threshold", () => {
    const world = setupWorld(20, 20, "default");
    // Solid component of size 100
    for (let i = 0; i < 100; i++) world.mask[i] = MASK_SOLID;
    world.theme = withThreshold(getTheme("default"), 100);
    finalizeMaskPass.run(makeCtx(world, 7));
    // 100 >= threshold 100, so component is preserved
    for (let i = 0; i < 100; i++) expect(world.mask[i]).toBe(MASK_SOLID);
  });

  it("uses 4-connectivity (diagonal pixels are not connected)", () => {
    const world = setupWorld(20, 20, "default");
    world.theme = withThreshold(getTheme("default"), 5);
    // Two solid pixels at (5,5) and (6,6) - diagonal neighbors only
    world.mask[5 * 20 + 5] = MASK_SOLID;
    world.mask[6 * 20 + 6] = MASK_SOLID;
    finalizeMaskPass.run(makeCtx(world, 7));
    // Both should be removed: each is its own 1-pixel component, 1 < 5
    expect(world.mask[5 * 20 + 5]).toBe(MASK_AIR);
    expect(world.mask[6 * 20 + 6]).toBe(MASK_AIR);
  });

  it("throws on null theme", () => {
    const world = createWorld(0, 20, 20, "default");
    // Leave world.theme null
    expect(() => finalizeMaskPass.run(makeCtx(world, 7))).toThrow(/DefineTheme must run first/);
  });
});
