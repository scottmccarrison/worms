import type { Pass } from "../pass";
import { MASK_SOLID, MATERIAL_DIRT, MATERIAL_ROCK, MATERIAL_STONE } from "../world";

/**
 * Assigns material codes (DIRT, ROCK, STONE) to each solid pixel based on
 * depth below the column's surface.
 *
 * - depth 0..(bandDirtDepthPx - 1): DIRT
 * - depth bandDirtDepthPx..(bandDirtDepthPx + bandRockDepthPx - 1): ROCK
 * - depth >= (bandDirtDepthPx + bandRockDepthPx): STONE
 *
 * Reads world.heightmap[x] for the surface line. Skips columns where
 * surfaceY >= heightPx (void columns) and pixels where mask is air.
 *
 * Throws if world.theme is null. Reads bandDirtDepthPx and bandRockDepthPx
 * via resolveParam with tuning.worldgen.materialBands fallbacks.
 *
 * No RNG used. Hard transitions for v1 (soft-transition dithering deferred).
 */
export const paintMaterialBandsPass: Pass = {
  name: "PaintMaterialBands",
  run: ({ world, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("PaintMaterialBands: world.theme is null; DefineTheme must run first");
    }
    const { widthPx, heightPx, mask, materialMap, heightmap } = world;
    const bandDirt = resolveParam("bandDirtDepthPx", tuning.worldgen.materialBands.dirtDepthPx);
    const bandRock = resolveParam("bandRockDepthPx", tuning.worldgen.materialBands.rockDepthPx);

    for (let x = 0; x < widthPx; x++) {
      const surfY = heightmap[x];
      // Skip undefined, void columns (>= heightPx), or pre-validation negatives.
      // GenerateHeightmap clamps to [0, heightPx-1]; defend against invariant breaks.
      if (surfY === undefined || surfY < 0 || surfY >= heightPx) continue;
      for (let y = surfY; y < heightPx; y++) {
        const idx = y * widthPx + x;
        if (mask[idx] !== MASK_SOLID) continue;
        const depth = y - surfY;
        if (depth < bandDirt) {
          materialMap[idx] = MATERIAL_DIRT;
        } else if (depth < bandDirt + bandRock) {
          materialMap[idx] = MATERIAL_ROCK;
        } else {
          materialMap[idx] = MATERIAL_STONE;
        }
      }
    }
  },
};
