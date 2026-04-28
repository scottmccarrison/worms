import { describe, expect, it } from "vitest";
import { Pipeline } from "../pipeline";
import { HEIGHTMAP_UNINIT, MASK_SOLID, createWorld } from "../world";
import { applyThemeHeightmapModsPass } from "./applyThemeHeightmapMods";
import { defineThemePass } from "./defineTheme";
import { generateHeightmapPass } from "./generateHeightmap";
import { paintSubstrateMaskPass } from "./paintSubstrateMask";
import { resetPass } from "./reset";

/**
 * Smoke test for the substrate stage of the v1 pipeline. Wires all 5 passes
 * end-to-end and asserts the post-conditions documented in the v1 doc:
 * - Every column has a populated heightmap (no UNINIT remains)
 * - GenerateHeightmap clamps to [0, heightPx - 1] (never writes the void
 *   sentinel; only ApplyThemeHeightmapMods is licensed to)
 * - For default-themed worlds, every column produces at least one solid
 *   pixel in the mask
 * - For canyon-themed worlds, at least one column has surfaceY === heightPx
 *   (the gap exists)
 * - Same seed produces byte-identical world state across two runs
 */

const SUBSTRATE_PASSES = [
  resetPass,
  defineThemePass,
  generateHeightmapPass,
  applyThemeHeightmapModsPass,
  paintSubstrateMaskPass,
];

describe("substrate-stage pipeline integration", () => {
  it("default theme: heightmap fully populated, mask has at least one solid pixel per column", () => {
    const world = createWorld(42, 200, 100, "default");
    new Pipeline(SUBSTRATE_PASSES).run(world);

    for (let x = 0; x < world.widthPx; x++) {
      const surfaceY = world.heightmap[x];
      expect(surfaceY).not.toBe(HEIGHTMAP_UNINIT);
      expect(surfaceY).toBeGreaterThanOrEqual(0);
      expect(surfaceY).toBeLessThan(world.heightPx);
    }

    for (let x = 0; x < world.widthPx; x++) {
      let solidInColumn = 0;
      for (let y = 0; y < world.heightPx; y++) {
        if (world.mask[y * world.widthPx + x] === MASK_SOLID) solidInColumn++;
      }
      expect(solidInColumn).toBeGreaterThan(0);
    }
  });

  it("canyon theme: produces at least one void column (gap exists)", () => {
    const world = createWorld(42, 200, 100, "canyon");
    new Pipeline(SUBSTRATE_PASSES).run(world);

    let voidColumns = 0;
    for (let x = 0; x < world.widthPx; x++) {
      if (world.heightmap[x] === world.heightPx) voidColumns++;
    }
    expect(voidColumns).toBeGreaterThan(0);

    for (let x = 0; x < world.widthPx; x++) {
      if (world.heightmap[x] === world.heightPx) {
        for (let y = 0; y < world.heightPx; y++) {
          expect(world.mask[y * world.widthPx + x]).not.toBe(MASK_SOLID);
        }
      }
    }
  });

  it("determinism: same seed produces byte-identical world state across runs", () => {
    const w1 = createWorld(12345, 200, 100, "default");
    const w2 = createWorld(12345, 200, 100, "default");
    new Pipeline(SUBSTRATE_PASSES).run(w1);
    new Pipeline(SUBSTRATE_PASSES).run(w2);

    expect(Array.from(w1.heightmap)).toEqual(Array.from(w2.heightmap));
    expect(Array.from(w1.mask)).toEqual(Array.from(w2.mask));
    expect(w1.theme?.tag).toBe(w2.theme?.tag);
  });

  it("different themes at same seed produce different heightmaps", () => {
    const wDefault = createWorld(99, 200, 100, "default");
    const wCanyon = createWorld(99, 200, 100, "canyon");
    new Pipeline(SUBSTRATE_PASSES).run(wDefault);
    new Pipeline(SUBSTRATE_PASSES).run(wCanyon);
    expect(Array.from(wDefault.heightmap)).not.toEqual(Array.from(wCanyon.heightmap));
  });
});
