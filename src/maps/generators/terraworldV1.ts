import { applyThemeHeightmapModsPass } from "../passes/applyThemeHeightmapMods";
import { carveCavesPass } from "../passes/carveCaves";
import { defineThemePass } from "../passes/defineTheme";
import { distributeSpawnPointsPass } from "../passes/distributeSpawnPoints";
import { finalCleanupPass } from "../passes/finalCleanup";
import { finalizeMaskPass } from "../passes/finalizeMask";
import { generateHeightmapPass } from "../passes/generateHeightmap";
import { paintMaterialBandsPass } from "../passes/paintMaterialBands";
import { paintSubstrateMaskPass } from "../passes/paintSubstrateMask";
import { paintSurfaceCrustPass } from "../passes/paintSurfaceCrust";
import { placeCaveAmbientPass } from "../passes/placeCaveAmbient";
import { placeSurfaceDressingPass } from "../passes/placeSurfaceDressing";
import { resetPass } from "../passes/reset";
import { validateSpawnCoherencePass } from "../passes/validateSpawnCoherence";
import { Pipeline } from "../pipeline";
import type { MapGenerator } from "../types";
import { createWorld } from "../world";
import { paintDecorationToContext } from "./paintDecorationToContext";
import { paintWorldToContext } from "./paintWorldToContext";

/**
 * v1 pipeline pass order (14 of 14 passes; spec complete):
 *  1. Reset
 *  2. DefineTheme
 *  3. GenerateHeightmap
 *  4. ApplyThemeHeightmapMods
 *  5. PaintSubstrateMask
 *  6. PaintMaterialBands         (PR 4)
 *  7. CarveCaves
 *  8. FinalizeMask
 *  9. PaintSurfaceCrust          (PR 4)
 * 10. PlaceCaveAmbient           (PR 5)
 * 11. PlaceSurfaceDressing       (PR 5)
 * 12. DistributeSpawnPoints      (PR 6)
 * 13. ValidateSpawnCoherence     (PR 6)
 * 14. FinalCleanup               (PR 6)
 */
const PASSES = [
  resetPass,
  defineThemePass,
  generateHeightmapPass,
  applyThemeHeightmapModsPass,
  paintSubstrateMaskPass,
  paintMaterialBandsPass,
  carveCavesPass,
  finalizeMaskPass,
  paintSurfaceCrustPass,
  placeCaveAmbientPass,
  placeSurfaceDressingPass,
  distributeSpawnPointsPass,
  validateSpawnCoherencePass,
  finalCleanupPass,
];

/**
 * Pipeline-based world generator. Wires 9 of the 14 v1 passes
 * (substrate + materials + carving + crust). Materializes the resulting
 * (mask, materialMap) pair onto the canvas via paintWorldToContext, which
 * paints alpha from the mask and RGB from the material codes via the
 * theme palette.
 *
 * opts.themeTag selects the theme; defaults to "default". Accepts any tag
 * registered in src/maps/themes.ts (default, canyon, snow, jungle, plateau,
 * volcanic).
 *
 * The generated canvas is "pre-painted" - already has final RGB. Registry
 * entries that use this generator must set prePainted: true so renderers
 * (TerrainRenderer, Terrain) skip the legacy stratumPaint call.
 *
 * Goal is architecture demonstration, not byte-parity with the legacy
 * terraworld map.
 */
export const terraworldV1Generator: MapGenerator = (ctx, widthPx, heightPx, opts) => {
  const themeTag = (opts.themeTag as string | undefined) ?? "default";
  const world = createWorld(opts.seed, widthPx, heightPx, themeTag);
  new Pipeline(PASSES).run(world);
  if (!world.theme) {
    throw new Error(
      "terraworldV1: theme is null after pipeline run; DefineTheme should have populated it",
    );
  }
  paintWorldToContext(ctx, world.mask, world.materialMap, world.theme.palette, widthPx, heightPx);
  paintDecorationToContext(ctx, world.caveAmbient, world.surfaceDressing);
  return { spawnList: world.spawnList, materialMap: world.materialMap };
};
