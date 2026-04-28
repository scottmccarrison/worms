import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import {
  MASK_SOLID,
  MATERIAL_AIR,
  MATERIAL_DIRT,
  MATERIAL_ROCK,
  MATERIAL_STONE,
  type World,
  createWorld,
} from "../world";
import { paintMaterialBandsPass } from "./paintMaterialBands";

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

describe("paintMaterialBandsPass", () => {
  it("assigns DIRT, ROCK, STONE bands by depth", () => {
    // 1x100 world. Surface at y=10. Defaults: dirt 6, rock 60. So:
    // y in [10, 16): DIRT (depths 0..5)
    // y in [16, 76): ROCK (depths 6..65)
    // y in [76, 100): STONE (depths 66..89)
    const world = setupWorld(1, 100, "default");
    fillSolidColumn(world, 0, 10);
    paintMaterialBandsPass.run(makeCtx(world, 6));
    for (let y = 10; y < 16; y++) {
      expect(world.materialMap[y * 1 + 0]).toBe(MATERIAL_DIRT);
    }
    for (let y = 16; y < 76; y++) {
      expect(world.materialMap[y * 1 + 0]).toBe(MATERIAL_ROCK);
    }
    for (let y = 76; y < 100; y++) {
      expect(world.materialMap[y * 1 + 0]).toBe(MATERIAL_STONE);
    }
  });

  it("leaves air pixels as MATERIAL_AIR", () => {
    const world = setupWorld(1, 50, "default");
    world.heightmap[0] = 20;
    // Solid only from y=20 down; y in [0, 20) is air
    for (let y = 20; y < 50; y++) {
      world.mask[y] = MASK_SOLID;
    }
    paintMaterialBandsPass.run(makeCtx(world, 6));
    for (let y = 0; y < 20; y++) {
      expect(world.materialMap[y]).toBe(MATERIAL_AIR);
    }
  });

  it("skips void columns (surfaceY >= heightPx)", () => {
    const world = setupWorld(2, 50, "canyon");
    world.heightmap[0] = 20;
    world.heightmap[1] = world.heightPx; // void
    for (let y = 20; y < 50; y++) world.mask[y * 2 + 0] = MASK_SOLID;
    // Column 1 stays all air
    paintMaterialBandsPass.run(makeCtx(world, 6));
    // Column 0 has materials
    expect(world.materialMap[20 * 2 + 0]).toBe(MATERIAL_DIRT);
    // Column 1 has none (still all AIR)
    for (let y = 0; y < 50; y++) {
      expect(world.materialMap[y * 2 + 1]).toBe(MATERIAL_AIR);
    }
  });

  it("theme override of bandDirtDepthPx works", () => {
    const world = setupWorld(1, 100, "default");
    // Override dirt depth to 20 via theme param
    const baseTheme = world.theme;
    if (!baseTheme) throw new Error("theme not set");
    world.theme = {
      ...baseTheme,
      params: { ...baseTheme.params, bandDirtDepthPx: 20 },
    };
    fillSolidColumn(world, 0, 10);
    paintMaterialBandsPass.run(makeCtx(world, 6));
    // Now dirt is depths 0..19 -> y 10..29
    expect(world.materialMap[15]).toBe(MATERIAL_DIRT);
    expect(world.materialMap[29]).toBe(MATERIAL_DIRT);
    expect(world.materialMap[30]).toBe(MATERIAL_ROCK); // depth 20 -> ROCK
  });

  it("throws on null theme", () => {
    const world = createWorld(0, 1, 50, "default");
    expect(() => paintMaterialBandsPass.run(makeCtx(world, 6))).toThrow(
      /DefineTheme must run first/,
    );
  });
});
