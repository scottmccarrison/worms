import type { Pass } from "../pass";
import { MASK_AIR } from "../world";
import type { SpawnPoint } from "../world";

/**
 * Final hygiene sweep. Three idempotent operations:
 *
 * 1. Trim caveAmbient features whose mask cell is no longer AIR (defensive;
 *    PlaceCaveAmbient guards this on insert, so this catches drift if any
 *    later pass were to mutate the mask).
 * 2. Trim surfaceDressing features whose column heightmap is invalid
 *    (negative or beyond the canvas height).
 * 3. Sort and de-dupe spawnList.left and spawnList.right by xPx, in place.
 *
 * No throw paths beyond the standard null-theme check. No flood-fill or
 * reachability validation - those would be a separate pass.
 */
export const finalCleanupPass: Pass = {
  name: "FinalCleanup",
  run: ({ world }) => {
    if (!world.theme) {
      throw new Error("FinalCleanup: world.theme is null; DefineTheme must run first");
    }
    const { widthPx, heightPx, heightmap, mask, caveAmbient, surfaceDressing, spawnList } = world;

    const ambientKept = caveAmbient.filter((f) => mask[f.yPx * widthPx + f.xPx] === MASK_AIR);
    caveAmbient.length = 0;
    caveAmbient.push(...ambientKept);

    const dressingKept = surfaceDressing.filter((f) => {
      const surfY = heightmap[f.xPx];
      return surfY !== undefined && surfY >= 0 && surfY < heightPx;
    });
    surfaceDressing.length = 0;
    surfaceDressing.push(...dressingKept);

    const dedupedLeft = dedupeSorted(spawnList.left);
    spawnList.left.length = 0;
    spawnList.left.push(...dedupedLeft);

    const dedupedRight = dedupeSorted(spawnList.right);
    spawnList.right.length = 0;
    spawnList.right.push(...dedupedRight);
  },
};

// xPx-only dedupe is sufficient because the v1 heightmap is single-y-per-column,
// so any two spawns at the same xPx must also share yPx. If overhang support is
// added later, change the dedupe key to (xPx, yPx).
function dedupeSorted(points: SpawnPoint[]): SpawnPoint[] {
  const sorted = points.slice().sort((a, b) => a.xPx - b.xPx);
  const out: SpawnPoint[] = [];
  let lastX: number | null = null;
  for (const p of sorted) {
    if (lastX === null || p.xPx !== lastX) {
      out.push(p);
      lastX = p.xPx;
    }
  }
  return out;
}
