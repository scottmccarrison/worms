import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_SOLID, MATERIAL_DIRT, type World, createWorld } from "../world";
import { paintSurfaceCrustPass } from "./paintSurfaceCrust";

// MATERIAL_CRUST = 4 (added by WS-A; hardcoded here for in-isolation testing)
const MATERIAL_CRUST_VAL = 4;

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

function fillSolidColumn(world: World, x: number, surfY: number): void {
  world.heightmap[x] = surfY;
  for (let y = surfY; y < world.heightPx; y++) {
    world.mask[y * world.widthPx + x] = MASK_SOLID;
  }
}

describe("paintSurfaceCrustPass", () => {
  it("overwrites top crustDepthPx pixels with MATERIAL_CRUST", () => {
    // Default theme: crustDepthPx = 3.
    const world = setupWorld(1, 50, "default");
    fillSolidColumn(world, 0, 10);
    // Pre-populate as if PaintMaterialBands ran: all DIRT
    for (let y = 10; y < 50; y++) world.materialMap[y] = MATERIAL_DIRT;
    paintSurfaceCrustPass.run(makeCtx(world, 9));
    // Top 3 px (y=10,11,12) should be CRUST
    expect(world.materialMap[10]).toBe(MATERIAL_CRUST_VAL);
    expect(world.materialMap[11]).toBe(MATERIAL_CRUST_VAL);
    expect(world.materialMap[12]).toBe(MATERIAL_CRUST_VAL);
    // y=13 onward stays DIRT
    expect(world.materialMap[13]).toBe(MATERIAL_DIRT);
  });

  it("skips columns where surfaceY >= heightPx (void)", () => {
    const world = setupWorld(2, 50, "canyon");
    world.heightmap[0] = 20;
    world.heightmap[1] = world.heightPx; // void
    fillSolidColumn(world, 0, 20);
    paintSurfaceCrustPass.run(makeCtx(world, 9));
    // Column 1 stays untouched (no MATERIAL_CRUST writes)
    for (let y = 0; y < 50; y++) {
      expect(world.materialMap[y * 2 + 1]).not.toBe(MATERIAL_CRUST_VAL);
    }
  });

  it("wantsSurfaceCrust=false is a no-op", () => {
    const world = setupWorld(1, 50, "default");
    const baseTheme = world.theme;
    if (!baseTheme) throw new Error("setupWorld must set theme");
    world.theme = {
      ...baseTheme,
      flags: { ...baseTheme.flags, wantsSurfaceCrust: false },
    };
    fillSolidColumn(world, 0, 10);
    for (let y = 10; y < 50; y++) world.materialMap[y] = MATERIAL_DIRT;
    paintSurfaceCrustPass.run(makeCtx(world, 9));
    // No CRUST written; everything stays DIRT
    for (let y = 10; y < 50; y++) {
      expect(world.materialMap[y]).toBe(MATERIAL_DIRT);
    }
  });

  it("theme override of crustDepthPx works", () => {
    const world = setupWorld(1, 50, "default");
    const baseTheme = world.theme;
    if (!baseTheme) throw new Error("setupWorld must set theme");
    world.theme = {
      ...baseTheme,
      params: { ...baseTheme.params, crustDepthPx: 7 },
    };
    fillSolidColumn(world, 0, 10);
    for (let y = 10; y < 50; y++) world.materialMap[y] = MATERIAL_DIRT;
    paintSurfaceCrustPass.run(makeCtx(world, 9));
    // Top 7 px should be CRUST
    for (let y = 10; y < 17; y++) {
      expect(world.materialMap[y]).toBe(MATERIAL_CRUST_VAL);
    }
    expect(world.materialMap[17]).toBe(MATERIAL_DIRT);
  });

  it("does not overwrite air pixels above the surface", () => {
    const world = setupWorld(1, 50, "default");
    fillSolidColumn(world, 0, 10);
    paintSurfaceCrustPass.run(makeCtx(world, 9));
    // Above surface (y < 10): no CRUST
    for (let y = 0; y < 10; y++) {
      expect(world.materialMap[y]).not.toBe(MATERIAL_CRUST_VAL);
    }
  });

  it("throws on null theme", () => {
    const world = createWorld(0, 1, 50, "default");
    expect(() => paintSurfaceCrustPass.run(makeCtx(world, 9))).toThrow(
      /DefineTheme must run first/,
    );
  });
});
