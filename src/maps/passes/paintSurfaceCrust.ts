import type { Pass } from "../pass";
import { MASK_SOLID, MATERIAL_CRUST } from "../world";

/**
 * Overwrites the top crustDepthPx pixels of solid in each column with
 * MATERIAL_CRUST. The CRUST material's color is theme.palette.surface
 * at render time; this pass only writes the material code.
 *
 * Gated by theme.flags.wantsSurfaceCrust. Themes with crust=false are
 * a no-op (e.g., a future raw-rock plateau theme).
 *
 * Reads crustDepthPx via resolveParam with tuning.worldgen.crust.depthPx
 * fallback. Skips void columns (surfaceY >= heightPx).
 *
 * Runs AFTER PaintMaterialBands and after FinalizeMask, per the v1 pass
 * list (this is pass 9 of the full 14-pass sequence). Overwrites the top
 * of the DIRT band with CRUST.
 *
 * Throws if world.theme is null.
 */
export const paintSurfaceCrustPass: Pass = {
  name: "PaintSurfaceCrust",
  run: ({ world, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("PaintSurfaceCrust: world.theme is null; DefineTheme must run first");
    }
    if (!world.theme.flags.wantsSurfaceCrust) return;

    const { widthPx, heightPx, mask, materialMap, heightmap } = world;
    const crustDepth = resolveParam("crustDepthPx", tuning.worldgen.crust.depthPx);

    for (let x = 0; x < widthPx; x++) {
      const surfY = heightmap[x];
      if (surfY === undefined || surfY >= heightPx) continue;
      const crustEnd = Math.min(surfY + crustDepth, heightPx);
      for (let y = surfY; y < crustEnd; y++) {
        const idx = y * widthPx + x;
        if (mask[idx] === MASK_SOLID) materialMap[idx] = MATERIAL_CRUST;
      }
    }
  },
};
