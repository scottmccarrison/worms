import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_AIR, MASK_SOLID, createWorld } from "../world";
import type { World } from "../world";
import { carveCavesPass } from "./carveCaves";

function setupWorld(seed: number, w: number, h: number, themeTag: string): World {
  const world = createWorld(seed, w, h, themeTag);
  world.theme = getTheme(themeTag);
  // Pre-populate heightmap and mask as if substrate passes had run.
  // For testing CarveCaves in isolation, set surface at midline and fill solid below.
  const surfaceY = Math.floor(h * 0.55);
  for (let x = 0; x < w; x++) world.heightmap[x] = surfaceY;
  for (let y = surfaceY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      world.mask[y * w + x] = MASK_SOLID;
    }
  }
  return world;
}

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

describe("carveCavesPass", () => {
  it("is deterministic: same seed produces same mask", () => {
    const w1 = setupWorld(42, 400, 300, "default");
    const w2 = setupWorld(42, 400, 300, "default");
    carveCavesPass.run(makeCtx(w1, 5));
    carveCavesPass.run(makeCtx(w2, 5));
    expect(Array.from(w1.mask)).toEqual(Array.from(w2.mask));
  });

  it("wantsCaves=false produces no mask changes", () => {
    const world = setupWorld(42, 400, 300, "default");
    // Override theme flag for this test. theme is non-null because setupWorld sets it.
    const theme = world.theme;
    if (!theme) throw new Error("setupWorld must set world.theme");
    world.theme = { ...theme, flags: { ...theme.flags, wantsCaves: false } };
    const before = Array.from(world.mask);
    carveCavesPass.run(makeCtx(world, 5));
    expect(Array.from(world.mask)).toEqual(before);
  });

  it("preserves the surface-buffer crust on non-void columns", () => {
    // Use a world tall enough that surfaceY (h*0.55) + surfaceBufferPx (80) < heightPx.
    // 400x300: surfaceY=165, 165+80=245 < 300.
    const world = setupWorld(42, 400, 300, "default");
    carveCavesPass.run(makeCtx(world, 5));
    // Sample column 50; the top surfaceBufferPx pixels of solid should remain solid.
    const surfY = world.heightmap[50] ?? 0;
    const buffer = tuning.caves.surfaceBufferPx;
    for (let y = surfY; y < surfY + buffer; y++) {
      expect(world.mask[y * 400 + 50]).toBe(MASK_SOLID);
    }
  });

  it("void columns (surfaceY === heightPx) leave the mask unchanged", () => {
    const world = setupWorld(42, 400, 300, "canyon");
    // Manually mark some columns as void after substrate setup
    for (let x = 80; x < 120; x++) {
      world.heightmap[x] = world.heightPx;
      // Clear the mask in those columns (as PaintSubstrateMask would)
      for (let y = 0; y < world.heightPx; y++) {
        world.mask[y * world.widthPx + x] = MASK_AIR;
      }
    }
    carveCavesPass.run(makeCtx(world, 5));
    // Void columns should remain entirely air after CarveCaves.
    for (let x = 80; x < 120; x++) {
      for (let y = 0; y < world.heightPx; y++) {
        expect(world.mask[y * world.widthPx + x]).toBe(MASK_AIR);
      }
    }
  });

  it("default theme on 600x500: at least some pixels become air below the surface buffer (caves carved)", () => {
    // World must have enough depth below the surface buffer for CA to carve caves.
    // 600x500: surfaceY = floor(500*0.55) = 275, buffer = 80, carveable = 500-355 = 145px ~= 6 cell rows.
    // With 6 rows of carveable cells insulated from the boundary, B5/S4 at fill=0.5 reliably carves chambers.
    const world = setupWorld(42, 600, 500, "default");
    carveCavesPass.run(makeCtx(world, 5));
    let airBelowBuffer = 0;
    for (let x = 0; x < 600; x++) {
      const surfY = world.heightmap[x] ?? 0;
      const bufferEnd = surfY + tuning.caves.surfaceBufferPx;
      for (let y = bufferEnd; y < 500; y++) {
        if (world.mask[y * 600 + x] === MASK_AIR) airBelowBuffer++;
      }
    }
    expect(airBelowBuffer).toBeGreaterThan(0);
  });

  it("throws on null theme", () => {
    const world = createWorld(42, 100, 100, "default");
    // Don't set world.theme - leave it null
    expect(() => carveCavesPass.run(makeCtx(world, 5))).toThrow(/DefineTheme must run first/);
  });
});
