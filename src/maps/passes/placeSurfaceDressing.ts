import type { Pass } from "../pass";
import { rngInt } from "../rng";

const DRESSING_SPRITE_BY_THEME: Record<string, string> = {
  default: "grass_tuft",
  canyon: "cactus",
  snow: "snow_drift",
  jungle: "grass_tuft",
  volcanic: "ash_pile",
};

/**
 * Places surface dressing features at uniform random columns along the
 * surface. Theme-gated by theme.flags.wantsSurfaceDressing. Sprite per theme.
 *
 * Terraria-style: attempt count = floor(widthPx / spacingPx), uniform
 * random x per attempt. Invalid columns (void, missing surface) no-op.
 *
 * RNG: 1 call per attempt.
 */
export const placeSurfaceDressingPass: Pass = {
  name: "PlaceSurfaceDressing",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("PlaceSurfaceDressing: world.theme is null; DefineTheme must run first");
    }
    if (!world.theme.flags.wantsSurfaceDressing) return;
    const sprite = DRESSING_SPRITE_BY_THEME[world.theme.tag];
    if (!sprite) return;

    const { widthPx, heightPx, heightmap } = world;
    const spacingPx = resolveParam(
      "surfaceDressingSpacingPx",
      tuning.worldgen.surfaceDressing.spacingPx,
    );
    if (spacingPx <= 0) return;
    const attempts = Math.max(4, Math.floor(widthPx / spacingPx));

    for (let i = 0; i < attempts; i++) {
      const cx = rngInt(rng, widthPx);
      const surfY = heightmap[cx];
      if (surfY === undefined || surfY < 0 || surfY >= heightPx) continue;
      const yPx = surfY - 1;
      if (yPx < 0) continue;
      world.surfaceDressing.push({ xPx: cx, yPx, sprite });
    }
  },
};
