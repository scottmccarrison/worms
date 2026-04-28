import type { Pass } from "../pass";
import { HEIGHTMAP_UNINIT, MASK_SOLID } from "../world";

/**
 * Rasterizes the heightmap into the alpha mask. For each column x,
 * paints MASK_SOLID for y in [surfaceY, heightPx). Void columns
 * (surfaceY === heightPx) produce zero solid pixels naturally.
 *
 * Validates that GenerateHeightmap has populated every column. UNINIT or
 * out-of-range surfaceY throws with a clear error rather than silently
 * corrupting the mask.
 */
export const paintSubstrateMaskPass: Pass = {
  name: "PaintSubstrateMask",
  run: ({ world }) => {
    const { widthPx, heightPx } = world;
    for (let x = 0; x < widthPx; x++) {
      const surfaceY = world.heightmap[x];
      if (surfaceY === HEIGHTMAP_UNINIT) {
        throw new Error(
          `PaintSubstrateMask: heightmap[${x}] is uninitialized; GenerateHeightmap must run first`,
        );
      }
      if (surfaceY < 0 || surfaceY > heightPx) {
        throw new Error(
          `PaintSubstrateMask: heightmap[${x}] = ${surfaceY} is out of range [0, ${heightPx}]`,
        );
      }
      for (let y = surfaceY; y < heightPx; y++) {
        world.mask[y * widthPx + x] = MASK_SOLID;
      }
    }
  },
};
