import type { Pass } from "../pass";
import { MASK_AIR, MASK_SOLID } from "../world";

/**
 * Soft post-distribution validation. Emits one summary console.warn per
 * side on violated invariants and continues. Designed to surface issues
 * during local dev and playtests without blocking generation.
 *
 * Invariants checked:
 * - Each side has at least minPerTeam spawns.
 * - All spawn cells satisfy: heightmap[xPx] is in [1, heightPx) AND
 *   mask[heightmap[xPx]*widthPx+xPx] === MASK_SOLID AND
 *   mask[(heightmap[xPx]-1)*widthPx+xPx] === MASK_AIR.
 *
 * Throws on null theme.
 */
export const validateSpawnCoherencePass: Pass = {
  name: "ValidateSpawnCoherence",
  run: ({ world, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("ValidateSpawnCoherence: world.theme is null; DefineTheme must run first");
    }
    const minPerTeam = resolveParam("minSpawnsPerTeam", tuning.worldgen.spawn.minPerTeam);
    if (minPerTeam <= 0) return;

    const { widthPx, heightPx, heightmap, mask, spawnList } = world;
    const themeTag = world.theme.tag;

    if (spawnList.left.length < minPerTeam) {
      console.warn(
        `[ValidateSpawnCoherence] theme=${themeTag} left team has ${spawnList.left.length} spawns; minPerTeam=${minPerTeam}`,
      );
    }
    if (spawnList.right.length < minPerTeam) {
      console.warn(
        `[ValidateSpawnCoherence] theme=${themeTag} right team has ${spawnList.right.length} spawns; minPerTeam=${minPerTeam}`,
      );
    }

    for (const side of ["left", "right"] as const) {
      let failed = 0;
      for (const p of spawnList[side]) {
        const surfY = heightmap[p.xPx];
        const ok =
          surfY !== undefined &&
          surfY >= 1 &&
          surfY < heightPx &&
          mask[surfY * widthPx + p.xPx] === MASK_SOLID &&
          mask[(surfY - 1) * widthPx + p.xPx] === MASK_AIR;
        if (!ok) failed++;
      }
      if (failed > 0) {
        console.warn(
          `[ValidateSpawnCoherence] theme=${themeTag} side=${side}: ${failed} of ${spawnList[side].length} spawns failed surface invariant`,
        );
      }
    }
  },
};
