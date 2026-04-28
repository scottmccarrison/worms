import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { HEIGHTMAP_UNINIT, createWorld } from "../world";
import { applyThemeHeightmapModsPass } from "./applyThemeHeightmapMods";

function makeCtx(world: ReturnType<typeof createWorld>, passIndex: number): PassContext {
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

describe("applyThemeHeightmapModsPass", () => {
  it("default theme: heightmap unchanged", () => {
    const world = createWorld(42, 100, 200, "default");
    world.theme = getTheme("default");
    // Pre-populate heightmap with sentinel values
    for (let x = 0; x < world.widthPx; x++) {
      world.heightmap[x] = 50 + (x % 10);
    }
    const before = new Int32Array(world.heightmap);
    applyThemeHeightmapModsPass.run(makeCtx(world, 3));
    expect(world.heightmap).toEqual(before);
  });

  it("canyon theme: produces a contiguous gap", () => {
    const widthPx = 200;
    const heightPx = 100;
    const world = createWorld(123, widthPx, heightPx, "canyon");
    world.theme = getTheme("canyon");
    // Pre-populate heightmap to a non-void value so we can detect gap columns
    for (let x = 0; x < widthPx; x++) {
      world.heightmap[x] = 50;
    }
    applyThemeHeightmapModsPass.run(makeCtx(world, 3));

    // Collect void columns (surfaceY === heightPx)
    const voidCols: number[] = [];
    for (let x = 0; x < widthPx; x++) {
      if (world.heightmap[x] === heightPx) {
        voidCols.push(x);
      }
    }

    // Must have at least some void columns
    expect(voidCols.length).toBeGreaterThan(0);

    // Must form a contiguous range
    for (let i = 1; i < voidCols.length; i++) {
      expect(voidCols[i]).toBe(voidCols[i - 1] + 1);
    }

    // Gap width must be in [floor(widthPx * 0.22), ceil(widthPx * 0.32)]
    const gapWidth = voidCols.length;
    expect(gapWidth).toBeGreaterThanOrEqual(Math.floor(widthPx * 0.22));
    expect(gapWidth).toBeLessThanOrEqual(Math.ceil(widthPx * 0.32));

    // Gap center must be within +-10% of world center
    const gapCenter = (voidCols[0] + voidCols[voidCols.length - 1]) / 2;
    const worldCenter = widthPx / 2;
    expect(Math.abs(gapCenter - worldCenter)).toBeLessThanOrEqual(widthPx * 0.1);
  });

  it("determinism: same seed + canyon = same gap edges", () => {
    const widthPx = 300;
    const heightPx = 150;

    const runAndCollect = (seed: number): number[] => {
      const world = createWorld(seed, widthPx, heightPx, "canyon");
      world.theme = getTheme("canyon");
      for (let x = 0; x < widthPx; x++) {
        world.heightmap[x] = 60;
      }
      applyThemeHeightmapModsPass.run(makeCtx(world, 3));
      const voids: number[] = [];
      for (let x = 0; x < widthPx; x++) {
        if (world.heightmap[x] === heightPx) voids.push(x);
      }
      return voids;
    };

    const run1 = runAndCollect(999);
    const run2 = runAndCollect(999);
    expect(run1).toEqual(run2);
    // Different seed should produce different (or possibly same by chance, but
    // with different seeds the rng stream is different, so use a seed far apart)
    const run3 = runAndCollect(1);
    // At minimum the first run is deterministic (already asserted); different
    // seeds are not guaranteed to differ so we only assert same-seed equality.
    expect(run1).toEqual(run2);
    // Suppress unused-variable lint by referencing run3
    expect(Array.isArray(run3)).toBe(true);
  });

  it("widthPx = 1 + canyon: clamps without out-of-bounds writes", () => {
    const world = createWorld(7, 1, 100, "canyon");
    world.theme = getTheme("canyon");
    world.heightmap[0] = 50;
    // Should not throw and should not write beyond index 0
    expect(() => applyThemeHeightmapModsPass.run(makeCtx(world, 3))).not.toThrow();
    // heightmap length must still be 1
    expect(world.heightmap.length).toBe(1);
  });

  it("throws on null theme", () => {
    const world = createWorld(1, 100, 200, "default");
    // theme remains null (not set)
    expect(() => applyThemeHeightmapModsPass.run(makeCtx(world, 3))).toThrow(
      "ApplyThemeHeightmapMods: world.theme is null",
    );
  });

  it("snow theme: heightmap unchanged (no-op)", () => {
    const world = createWorld(55, 100, 200, "snow");
    world.theme = getTheme("snow");
    for (let x = 0; x < world.widthPx; x++) {
      world.heightmap[x] = 80;
    }
    const before = new Int32Array(world.heightmap);
    applyThemeHeightmapModsPass.run(makeCtx(world, 3));
    expect(world.heightmap).toEqual(before);
  });

  it("HEIGHTMAP_UNINIT sentinel values survive default theme pass", () => {
    const world = createWorld(77, 50, 100, "default");
    world.theme = getTheme("default");
    // Leave heightmap at HEIGHTMAP_UNINIT (createWorld fills it with that)
    const before = new Int32Array(world.heightmap);
    applyThemeHeightmapModsPass.run(makeCtx(world, 3));
    // Should be unchanged since default is a no-op
    expect(world.heightmap).toEqual(before);
    expect(world.heightmap[0]).toBe(HEIGHTMAP_UNINIT);
  });
});
