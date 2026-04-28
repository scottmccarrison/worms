import type { Pass } from "../pass";
import { HEIGHTMAP_UNINIT } from "../world";

/**
 * Resets the World to its just-created state. For freshly-created Worlds via
 * createWorld, this is functionally a no-op. Required as the first pass for
 * future re-run scenarios where the same World struct is recycled across
 * multiple pipeline executions (e.g., seed regeneration in the lobby).
 */
export const resetPass: Pass = {
  name: "Reset",
  run: ({ world }) => {
    world.heightmap.fill(HEIGHTMAP_UNINIT);
    world.mask.fill(0);
    world.materialMap.fill(0);
    world.theme = null;
    world.spawnList.left.length = 0;
    world.spawnList.right.length = 0;
    world.caveAmbient.length = 0;
    world.surfaceDressing.length = 0;
  },
};
