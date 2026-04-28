import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_SOLID, createWorld } from "../world";
import type { World } from "../world";
import { finalCleanupPass } from "./finalCleanup";

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

describe("finalCleanupPass", () => {
  it("throws on null theme", () => {
    const world = createWorld(0, 40, 40, "default");
    // theme is null by default after createWorld
    expect(() => finalCleanupPass.run(makeCtx(world, 10))).toThrow(/DefineTheme must run first/);
  });

  it("empty world: all arrays remain empty after pass", () => {
    const world = setupWorld(100, 100, "default");
    finalCleanupPass.run(makeCtx(world, 10));
    expect(world.caveAmbient).toHaveLength(0);
    expect(world.surfaceDressing).toHaveLength(0);
    expect(world.spawnList.left).toHaveLength(0);
    expect(world.spawnList.right).toHaveLength(0);
  });

  it("trims caveAmbient features whose mask cell is now SOLID", () => {
    const world = setupWorld(100, 100, "default");
    const { widthPx } = world;
    // Insert an ambient feature at (10, 50) and mark that cell SOLID
    world.caveAmbient.push({ xPx: 10, yPx: 50, type: "frost" });
    // Also insert a valid feature at (20, 50) that stays AIR
    world.caveAmbient.push({ xPx: 20, yPx: 50, type: "frost" });
    world.mask[50 * widthPx + 10] = MASK_SOLID;
    // mask[50 * widthPx + 20] stays MASK_AIR (zero-filled by createWorld)
    finalCleanupPass.run(makeCtx(world, 10));
    // The SOLID-masked feature should be removed
    expect(world.caveAmbient.some((f) => f.xPx === 10 && f.yPx === 50)).toBe(false);
    // The AIR-masked feature should survive
    expect(world.caveAmbient.some((f) => f.xPx === 20 && f.yPx === 50)).toBe(true);
  });

  it("trims surfaceDressing features whose column heightmap is invalid", () => {
    const world = setupWorld(100, 100, "default");
    const { heightPx } = world;
    // Invalid: negative heightmap value
    world.heightmap[20] = -1;
    world.surfaceDressing.push({ xPx: 20, yPx: 10, sprite: "bush" });
    // Invalid: heightmap >= heightPx
    world.heightmap[30] = heightPx;
    world.surfaceDressing.push({ xPx: 30, yPx: 10, sprite: "bush" });
    // Valid: heightmap in range
    world.heightmap[40] = 50;
    world.surfaceDressing.push({ xPx: 40, yPx: 10, sprite: "bush" });
    finalCleanupPass.run(makeCtx(world, 10));
    // Both invalid entries should be removed
    expect(world.surfaceDressing.some((f) => f.xPx === 20)).toBe(false);
    expect(world.surfaceDressing.some((f) => f.xPx === 30)).toBe(false);
    // Valid entry should survive
    expect(world.surfaceDressing.some((f) => f.xPx === 40)).toBe(true);
  });

  it("spawn arrays end up sorted ascending by xPx even when input was unsorted", () => {
    const world = setupWorld(100, 100, "default");
    world.spawnList.left.push({ xPx: 50, yPx: 100 }, { xPx: 10, yPx: 100 }, { xPx: 30, yPx: 100 });
    finalCleanupPass.run(makeCtx(world, 10));
    expect(world.spawnList.left).toEqual([
      { xPx: 10, yPx: 100 },
      { xPx: 30, yPx: 100 },
      { xPx: 50, yPx: 100 },
    ]);
  });

  it("spawn de-dupe by xPx removes duplicate x entries", () => {
    const world = setupWorld(100, 100, "default");
    world.spawnList.right.push({ xPx: 10, yPx: 100 }, { xPx: 10, yPx: 100 }, { xPx: 30, yPx: 100 });
    finalCleanupPass.run(makeCtx(world, 10));
    expect(world.spawnList.right).toEqual([
      { xPx: 10, yPx: 100 },
      { xPx: 30, yPx: 100 },
    ]);
  });
});
