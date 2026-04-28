/**
 * Theme registry for the world-gen v1 pipeline.
 *
 * Per the v1 pass list (`docs/guides/world-gen-passes-v1.md`), themes are
 * read by passes via flag and param checks, never by string-matching the
 * tag. The schema below is the contract every theme-conditional pass
 * relies on.
 */

export interface ThemeFlags {
  wantsPeaks: boolean;
  wantsCaves: boolean;
  noFloor: boolean;
  wantsSurfaceCrust: boolean;
  wantsCaveAmbient: boolean;
}

export interface ThemeParams {
  cellSizePx?: number;
  initialFillRatio?: number;
  caveIterations?: number;
  surfaceBufferPx?: number;
  mountainAmplitude?: number;
  crustDepthPx?: number;
  maskHygieneThresholdPx?: number;
  spawnDensity?: number;
  minSpawnsPerTeam?: number;
  bandDirtDepthPx?: number;
  bandRockDepthPx?: number;
  caveAmbientAttemptFactor?: number;
}

export interface ThemePalette {
  /** Top crust color (RGB hex, e.g., 0x3a7a3c). */
  surface: number;
  /** Dirt band. */
  mid: number;
  /** Rock band (between dirt and stone). */
  rock: number;
  /** Stone band (deep). */
  deep: number;
}

export interface Theme {
  tag: string;
  flags: ThemeFlags;
  params: ThemeParams;
  palette: ThemePalette;
}

export const THEMES: Record<string, Theme> = {
  default: {
    tag: "default",
    flags: {
      wantsPeaks: true,
      wantsCaves: true,
      noFloor: false,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: false,
    },
    params: {},
    palette: { surface: 0x3a7a3c, mid: 0x7a4a2c, rock: 0x6a4f24, deep: 0x5a5a5a },
  },
  canyon: {
    tag: "canyon",
    flags: {
      wantsPeaks: false,
      wantsCaves: true,
      noFloor: true,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: false,
    },
    params: {},
    palette: { surface: 0xb05c3a, mid: 0x8a4523, rock: 0x7a3c1c, deep: 0x6a3010 },
  },
  snow: {
    tag: "snow",
    flags: {
      wantsPeaks: true,
      wantsCaves: true,
      noFloor: false,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: true,
    },
    params: {},
    palette: { surface: 0xf5f7fa, mid: 0x6a7a8a, rock: 0x5a6a78, deep: 0x4a5a6a },
  },
  jungle: {
    tag: "jungle",
    flags: {
      wantsPeaks: true,
      wantsCaves: true,
      noFloor: false,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: true,
    },
    params: {},
    palette: { surface: 0x2a8a3a, mid: 0x4a3a1a, rock: 0x3a2812, deep: 0x3a2a0a },
  },
  plateau: {
    tag: "plateau",
    flags: {
      wantsPeaks: false,
      wantsCaves: true,
      noFloor: false,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: false,
    },
    params: {},
    palette: { surface: 0x8a7a5a, mid: 0x6a5a3a, rock: 0x5a4828, deep: 0x4a3a2a },
  },
  volcanic: {
    tag: "volcanic",
    flags: {
      wantsPeaks: true,
      wantsCaves: true,
      noFloor: false,
      wantsSurfaceCrust: true,
      wantsCaveAmbient: true,
    },
    params: {},
    palette: { surface: 0x3a1a0a, mid: 0x5a2a0a, rock: 0x4a1a05, deep: 0x2a0a00 },
  },
};

export function getTheme(tag: string): Theme {
  const theme = THEMES[tag];
  if (!theme) {
    const known = Object.keys(THEMES).join(", ");
    throw new Error(`Unknown theme tag: "${tag}". Known themes: ${known}`);
  }
  return theme;
}
