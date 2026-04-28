import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { type World, createWorld } from "../world";
import { placeSurfaceDressingPass } from "./placeSurfaceDressing";

function makeCtx(world: World, passIndex: number, spacingOverride?: number): PassContext {
  return {
    world,
    rng: rngForPass(world.seed, passIndex),
    passIndex,
    tuning,
    resolveParam: (key, fb) => {
      if (key === "surfaceDressingSpacingPx" && spacingOverride !== undefined) {
        return spacingOverride;
      }
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

/** Fill a column with a valid surface at surfY. */
function fillColumn(world: World, x: number, surfY: number): void {
  world.heightmap[x] = surfY;
}

describe("placeSurfaceDressingPass", () => {
  it("plateau theme (wantsSurfaceDressing=false) returns early; surfaceDressing stays empty", () => {
    const world = setupWorld(400, 200, "plateau");
    // Fill all columns with a valid surface at y=100
    for (let x = 0; x < 400; x++) fillColumn(world, x, 100);
    placeSurfaceDressingPass.run(makeCtx(world, 10));
    expect(world.surfaceDressing).toHaveLength(0);
  });

  it("default theme produces grass_tuft features", () => {
    const world = setupWorld(400, 200, "default");
    // Fill all columns with a valid surface
    for (let x = 0; x < 400; x++) fillColumn(world, x, 50);
    placeSurfaceDressingPass.run(makeCtx(world, 10));
    // Should have produced some features
    expect(world.surfaceDressing.length).toBeGreaterThan(0);
    for (const feat of world.surfaceDressing) {
      expect(feat.sprite).toBe("grass_tuft");
    }
  });

  it("all produced features have yPx === heightmap[xPx] - 1 and a valid surface", () => {
    const world = setupWorld(800, 300, "default");
    // Give each column a distinct surface height to detect any mapping errors
    for (let x = 0; x < 800; x++) {
      // Surface between y=10 and y=200, varies by x
      fillColumn(world, x, 10 + (x % 50));
    }
    placeSurfaceDressingPass.run(makeCtx(world, 10));
    expect(world.surfaceDressing.length).toBeGreaterThan(0);
    for (const feat of world.surfaceDressing) {
      const surfY = world.heightmap[feat.xPx];
      // surfY must be a valid surface (not -1, not >= heightPx)
      expect(surfY).toBeGreaterThanOrEqual(0);
      expect(surfY).toBeLessThan(world.heightPx);
      // yPx must be exactly surfY - 1
      expect(feat.yPx).toBe(surfY - 1);
    }
  });

  it("same seed produces the same surfaceDressing list (determinism)", () => {
    function runOnce(seed: number): typeof world1.surfaceDressing {
      const w = createWorld(seed, 400, 200, "default");
      w.theme = getTheme("default");
      for (let x = 0; x < 400; x++) w.heightmap[x] = 80;
      placeSurfaceDressingPass.run({
        world: w,
        rng: rngForPass(w.seed, 10),
        passIndex: 10,
        tuning,
        resolveParam: (key, fb) => {
          const v = w.theme?.params[key];
          return typeof v === "number" ? v : fb;
        },
      });
      return w.surfaceDressing;
    }
    const world1 = createWorld(42, 400, 200, "default"); // needed for type only
    const run1 = runOnce(42);
    const run2 = runOnce(42);
    expect(run1).toEqual(run2);
  });

  it("theme.params.surfaceDressingSpacingPx override changes the produced count", () => {
    // Run with tight spacing (spacingPx=10) and loose spacing (spacingPx=200)
    // and verify the tight run produces more attempts (and thus more features
    // given enough valid surface columns).
    const makeTightWorld = () => {
      const world = setupWorld(400, 200, "default");
      for (let x = 0; x < 400; x++) fillColumn(world, x, 100);
      return world;
    };

    const worldTight = makeTightWorld();
    placeSurfaceDressingPass.run(makeCtx(worldTight, 10, 10));

    const worldLoose = makeTightWorld();
    placeSurfaceDressingPass.run(makeCtx(worldLoose, 10, 200));

    // Tight spacing = more attempts = more features placed on average.
    // With widthPx=400: tight attempts = max(4, floor(400/10)) = 40
    //                   loose attempts = max(4, floor(400/200)) = 4
    expect(worldTight.surfaceDressing.length).toBeGreaterThan(worldLoose.surfaceDressing.length);
  });

  it("throws if world.theme is null", () => {
    const world = createWorld(0, 100, 100, "default");
    // theme is null by default from createWorld
    expect(() => placeSurfaceDressingPass.run(makeCtx(world, 10))).toThrow(
      /DefineTheme must run first/,
    );
  });
});
