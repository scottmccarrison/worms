import type { Pass } from "../pass";
import { rngInt } from "../rng";
import { MASK_AIR, MASK_SOLID } from "../world";
import type { SpawnPoint } from "../world";

const RELAXATION_FACTORS = [1.0, 0.8, 0.6, 0.4, 0.2, 0] as const;

/**
 * Populates world.spawnList.left and world.spawnList.right with valid
 * surface positions partitioned by xPx midline. Reads world.heightmap as
 * the authoritative per-column surface y; validates that the surface cell
 * is solid and the cell above is air (worm-fits invariant).
 *
 * Algorithm mirrors legacy findSpawnPoints (src/worm/spawnPoints.ts):
 * shuffle valid columns deterministically, then greedy-pick with
 * progressive minSpacing relaxation to fill the per-side count.
 *
 * Honors edgeMarginPx (skip columns near canvas edges) and densityPx
 * (min horizontal spacing between accepted spawns). Per-team count target
 * comes from minPerTeam tuning (or per-theme override).
 *
 * Throws on null theme. Returns early on degenerate dimensions.
 *
 * RNG: O(validColumns) calls for the Fisher-Yates shuffle.
 */
export const distributeSpawnPointsPass: Pass = {
  name: "DistributeSpawnPoints",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("DistributeSpawnPoints: world.theme is null; DefineTheme must run first");
    }
    const { widthPx, heightPx, heightmap, mask, spawnList } = world;
    if (widthPx <= 0 || heightPx <= 0) return;

    const densityPx = resolveParam("spawnDensity", tuning.worldgen.spawn.densityPx);
    const minPerTeam = resolveParam("minSpawnsPerTeam", tuning.worldgen.spawn.minPerTeam);
    if (densityPx <= 0 || minPerTeam <= 0) return;

    const edgeMarginPx = Math.min(60, Math.floor(widthPx / 8));
    const midX = Math.floor(widthPx / 2);

    const leftCandidates: SpawnPoint[] = [];
    const rightCandidates: SpawnPoint[] = [];
    for (let cx = edgeMarginPx; cx < widthPx - edgeMarginPx; cx++) {
      const surfY = heightmap[cx];
      // Skip degenerate columns and canvas-top surfaces (need >= 1 row of
      // air above for worm clearance).
      if (surfY === undefined || surfY < 1 || surfY >= heightPx) continue;
      if (mask[surfY * widthPx + cx] !== MASK_SOLID) continue;
      if (mask[(surfY - 1) * widthPx + cx] !== MASK_AIR) continue;
      const point: SpawnPoint = { xPx: cx, yPx: surfY - 1 };
      if (cx < midX) leftCandidates.push(point);
      else rightCandidates.push(point);
    }

    spawnList.left.push(...pickWithRelaxation(leftCandidates, minPerTeam, densityPx, rng));
    spawnList.right.push(...pickWithRelaxation(rightCandidates, minPerTeam, densityPx, rng));
    spawnList.left.sort((a, b) => a.xPx - b.xPx);
    spawnList.right.sort((a, b) => a.xPx - b.xPx);
  },
};

function pickWithRelaxation(
  candidates: SpawnPoint[],
  target: number,
  densityPx: number,
  rng: () => number,
): SpawnPoint[] {
  if (candidates.length === 0) return [];
  const shuffled = candidates.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rngInt(rng, i + 1);
    const tmp = shuffled[i];
    if (tmp === undefined) continue;
    const swap = shuffled[j];
    if (swap === undefined) continue;
    shuffled[i] = swap;
    shuffled[j] = tmp;
  }
  for (const factor of RELAXATION_FACTORS) {
    const minSpacing = densityPx * factor;
    const picked: SpawnPoint[] = [];
    for (const p of shuffled) {
      if (picked.every((q) => Math.abs(q.xPx - p.xPx) >= minSpacing)) {
        picked.push(p);
        if (picked.length >= target) return picked;
      }
    }
    if (picked.length >= target) return picked;
  }
  return shuffled.slice(0, target);
}
