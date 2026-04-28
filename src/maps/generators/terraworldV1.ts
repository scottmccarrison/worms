import { applyThemeHeightmapModsPass } from "../passes/applyThemeHeightmapMods";
import { carveCavesPass } from "../passes/carveCaves";
import { defineThemePass } from "../passes/defineTheme";
import { finalizeMaskPass } from "../passes/finalizeMask";
import { generateHeightmapPass } from "../passes/generateHeightmap";
import { paintSubstrateMaskPass } from "../passes/paintSubstrateMask";
import { resetPass } from "../passes/reset";
import { Pipeline } from "../pipeline";
import type { MapGenerator } from "../types";
import { createWorld } from "../world";
import { paintMaskToContext } from "./paintMaskToContext";

const PASSES = [
  resetPass,
  defineThemePass,
  generateHeightmapPass,
  applyThemeHeightmapModsPass,
  paintSubstrateMaskPass,
  carveCavesPass,
  finalizeMaskPass,
];

/**
 * Pipeline-based world generator. Wires the v1 substrate + carving passes
 * (7 of 14 total per docs/guides/world-gen-passes-v1.md). Materializes the
 * resulting Uint8Array mask onto the canvas at the boundary.
 *
 * opts.themeTag selects the theme; defaults to "default" if absent. Accepts
 * any tag registered in src/maps/themes.ts (default, canyon, snow, jungle,
 * plateau, volcanic).
 *
 * Goal is architecture demonstration, not byte-parity with the legacy
 * terraworld map. Same seed produces a different mask because the pipeline
 * uses rngForPass per pass instead of a single shared cursor.
 */
export const terraworldV1Generator: MapGenerator = (ctx, widthPx, heightPx, opts) => {
  const themeTag = (opts.themeTag as string | undefined) ?? "default";
  const world = createWorld(opts.seed, widthPx, heightPx, themeTag);
  new Pipeline(PASSES).run(world);
  paintMaskToContext(ctx, world.mask, widthPx, heightPx);
};
