import type { Pass } from "../pass";

/**
 * Theme-specific heightmap shaping.
 *
 * v1 themes:
 * - canyon (theme.flags.noFloor): central gap via void-column sentinel
 *   (surfaceY = world.heightPx). Gap geometry replicates canyonBiome.ts:
 *   22-32% of width, +-4% center offset.
 * - default, snow, jungle, plateau, volcanic: no-op (specs deferred or use
 *   base rolling hills).
 *
 * Per Section 6 of the design doc, every pass always runs; theme conditionality
 * is internal to the pass. Themes without shaping return early.
 *
 * RNG call count: canyon uses exactly 2 rng() calls; other themes use 0.
 */
export const applyThemeHeightmapModsPass: Pass = {
  name: "ApplyThemeHeightmapMods",
  run: ({ world, rng }) => {
    if (!world.theme) {
      throw new Error("ApplyThemeHeightmapMods: world.theme is null; DefineTheme must run first");
    }
    if (!world.theme.flags.noFloor) return;

    const widthPx = world.widthPx;
    const gapWidth = Math.floor(widthPx * (0.22 + rng() * 0.1));
    const gapCenter = Math.floor(widthPx / 2 + (rng() - 0.5) * widthPx * 0.08);
    const leftEdge = Math.max(0, gapCenter - Math.floor(gapWidth / 2));
    const rightEdge = Math.min(widthPx, gapCenter + Math.ceil(gapWidth / 2));
    if (leftEdge >= rightEdge) return;

    for (let x = leftEdge; x < rightEdge; x++) {
      world.heightmap[x] = world.heightPx;
    }
  },
};
