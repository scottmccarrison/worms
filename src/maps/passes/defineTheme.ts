import type { Pass } from "../pass";
import { getTheme } from "../themes";

/**
 * Reads world.themeTag (set by createWorld from lobby config), resolves to a
 * Theme via the registry, assigns to world.theme. After this pass, theme is
 * non-null for all subsequent passes.
 *
 * In v1 this is a thin slot wrapping getTheme. It exists per the design doc
 * to keep the architecture symmetric (every world-state field is populated
 * by a named pass, not by createWorld). Future PRs may derive per-theme
 * parameters here (flavor variants, seed-based tweaks).
 */
export const defineThemePass: Pass = {
  name: "DefineTheme",
  run: ({ world }) => {
    world.theme = getTheme(world.themeTag);
  },
};
