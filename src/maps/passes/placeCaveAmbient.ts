import type { Pass } from "../pass";
import { rngInt } from "../rng";
import { MASK_AIR } from "../world";

const AMBIENT_TYPE_BY_THEME: Record<string, string> = {
  snow: "frost",
  jungle: "moss",
  volcanic: "glow",
};

/**
 * Places ambient decoration features inside cave cavities. Theme-gated by
 * theme.flags.wantsCaveAmbient. Type per theme: "frost" (snow), "moss"
 * (jungle), "glow" (volcanic). Other themes return early.
 *
 * Uses Terraria's attempt-count density convention: attempts scale with
 * world area (widthPx * heightPx * factor). Each attempt picks uniform
 * random (x, y) and validates; invalid attempts no-op. Many attempts will
 * not land in cave interior; that is expected and matches shipped procgen.
 *
 * RNG: 2 calls per attempt (rngInt for x and y).
 */
export const placeCaveAmbientPass: Pass = {
  name: "PlaceCaveAmbient",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("PlaceCaveAmbient: world.theme is null; DefineTheme must run first");
    }
    if (!world.theme.flags.wantsCaveAmbient) return;
    const type = AMBIENT_TYPE_BY_THEME[world.theme.tag];
    if (!type) return;

    const { widthPx, heightPx, mask, heightmap } = world;
    const factor = resolveParam(
      "caveAmbientAttemptFactor",
      tuning.worldgen.caveAmbient.attemptFactor,
    );
    if (factor <= 0) return;
    const attempts = Math.max(8, Math.floor(widthPx * heightPx * factor));

    for (let i = 0; i < attempts; i++) {
      const cx = rngInt(rng, widthPx);
      const cy = rngInt(rng, heightPx);
      const surfY = heightmap[cx];
      if (surfY === undefined || surfY >= heightPx) continue;
      if (cy <= surfY) continue;
      if (mask[cy * widthPx + cx] !== MASK_AIR) continue;
      world.caveAmbient.push({ xPx: cx, yPx: cy, type });
    }
  },
};
