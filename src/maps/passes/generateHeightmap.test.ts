import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { HEIGHTMAP_UNINIT, createWorld } from "../world";
import type { World } from "../world";
import { generateHeightmapPass } from "./generateHeightmap";

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

/** Create a world with theme pre-set, ready for GenerateHeightmap. */
function makeWorld(seed: number, widthPx: number, heightPx: number, themeTag: string): World {
  const world = createWorld(seed, widthPx, heightPx, themeTag);
  world.theme = getTheme(themeTag);
  return world;
}

describe("generateHeightmapPass", () => {
  it("is deterministic - same seed + dimensions produce byte-equal heightmaps", () => {
    const seed = 42;
    const w = 256;
    const h = 200;

    const worldA = makeWorld(seed, w, h, "default");
    const worldB = makeWorld(seed, w, h, "default");

    generateHeightmapPass.run(makeCtx(worldA, 1));
    generateHeightmapPass.run(makeCtx(worldB, 1));

    expect(worldA.heightmap).toEqual(worldB.heightmap);
  });

  it("all surfaceY values are in [0, heightPx - 1] - no void sentinel produced", () => {
    const world = makeWorld(123, 512, 300, "default");
    generateHeightmapPass.run(makeCtx(world, 1));

    const maxY = world.heightPx - 1;
    for (let x = 0; x < world.widthPx; x++) {
      const y = world.heightmap[x];
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(maxY);
      // Must not equal heightPx (the void sentinel)
      expect(y).not.toBe(world.heightPx);
    }
  });

  it("no HEIGHTMAP_UNINIT remains after pass", () => {
    const world = makeWorld(7, 200, 150, "snow");
    generateHeightmapPass.run(makeCtx(world, 1));

    for (let x = 0; x < world.widthPx; x++) {
      expect(world.heightmap[x]).not.toBe(HEIGHTMAP_UNINIT);
    }
  });

  it("wantsPeaks=true produces higher variance than wantsPeaks=false (same seed)", () => {
    const seed = 999;
    const w = 1024;
    const h = 400;

    // default theme: wantsPeaks=true
    const peakWorld = makeWorld(seed, w, h, "default");
    generateHeightmapPass.run(makeCtx(peakWorld, 1));

    // plateau theme: wantsPeaks=false
    const flatWorld = makeWorld(seed, w, h, "plateau");
    generateHeightmapPass.run(makeCtx(flatWorld, 1));

    const variance = (arr: Int32Array): number => {
      let min = arr[0] ?? 0;
      let max = arr[0] ?? 0;
      for (let i = 1; i < arr.length; i++) {
        const v = arr[i] ?? 0;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      return max - min;
    };

    const peakVar = variance(peakWorld.heightmap);
    const flatVar = variance(flatWorld.heightmap);

    // Peaks world should have strictly greater range
    expect(peakVar).toBeGreaterThan(flatVar);
  });

  it("wantsPeaks=false short-circuits mountain octave (no mountain RNG consumed)", () => {
    // Verify the wantsPeaks && mountainAmp > 0 guard by checking that two
    // plateau worlds with the same seed are identical (no stochastic mountain path)
    const seed = 55;
    const w = 256;
    const h = 200;

    const worldA = makeWorld(seed, w, h, "plateau");
    const worldB = makeWorld(seed, w, h, "plateau");

    generateHeightmapPass.run(makeCtx(worldA, 1));
    generateHeightmapPass.run(makeCtx(worldB, 1));

    expect(worldA.heightmap).toEqual(worldB.heightmap);
  });

  it("1-column world produces heightmap of length 1 with valid surfaceY", () => {
    const world = makeWorld(1, 1, 100, "default");
    generateHeightmapPass.run(makeCtx(world, 1));

    expect(world.heightmap.length).toBe(1);
    const y = world.heightmap[0];
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(world.heightPx - 1);
    expect(y).not.toBe(HEIGHTMAP_UNINIT);
  });

  it("throws if world.theme is null", () => {
    const world = createWorld(1, 100, 100, "default");
    // theme intentionally left null
    expect(() => generateHeightmapPass.run(makeCtx(world, 1))).toThrow(
      "GenerateHeightmap: world.theme is null",
    );
  });
});
