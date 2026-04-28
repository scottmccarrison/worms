import type { Theme } from "./themes";

/** Per-pixel material code in the World.materialMap. */
export const MATERIAL_AIR = 0;
export const MATERIAL_DIRT = 1;
export const MATERIAL_ROCK = 2;
export const MATERIAL_STONE = 3;
/** Theme-specific surface crust (grass, snow, sand, scorched, etc.). Color comes from theme.palette.surface at render time. */
export const MATERIAL_CRUST = 4;

/** Mask byte values. */
export const MASK_AIR = 0;
export const MASK_SOLID = 1;

/** Sentinel value for an uninitialized heightmap column.
 *  Distinguishable from "surface at top" (0) and "no surface" (>= worldHeight).
 *  Passes that read the heightmap should never observe this; it indicates a
 *  pass that should have written this column did not. */
export const HEIGHTMAP_UNINIT = -2147483648; // INT32_MIN

/** Maximum widthPx * heightPx for createWorld. ~100M pixels = 200MB across the
 *  mask + materialMap pair. Anything larger is almost certainly a bug; the raw
 *  Uint8Array allocation would either OOM or fail with a cryptic RangeError. */
export const MAX_PIXEL_COUNT = 100_000_000;

export interface SpawnPoint {
  xPx: number;
  yPx: number;
}

export interface SpawnList {
  /** Left-side spawns, sorted by xPx ascending. */
  left: SpawnPoint[];
  /** Right-side spawns, sorted by xPx ascending. */
  right: SpawnPoint[];
}

export interface AmbientFeature {
  xPx: number;
  yPx: number;
  type: string;
}

export interface DressingFeature {
  xPx: number;
  yPx: number;
  sprite: string;
}

/**
 * The shared mutable state passed through the pipeline. Always-allocated;
 * no nullables for buffers. Pre-populated by `createWorld` so passes never
 * face "is this initialized" branching. The `theme` field is the single
 * exception: it is populated by `DefineTheme` (typically pass 2). For
 * convenience, callers can pre-set theme via `createWorld` to avoid that.
 */
export interface World {
  readonly widthPx: number;
  readonly heightPx: number;
  readonly seed: number;
  readonly themeTag: string;
  theme: Theme | null;

  /** Per-column surface Y. surfaceY >= heightPx means void column (no solid). */
  heightmap: Int32Array;

  /** Pixel mask, 1 byte per pixel. 0 = air, 1 = solid. Length = widthPx * heightPx. */
  mask: Uint8Array;

  /** Per-pixel material. 0 = air, 1 = dirt, 2 = rock, 3 = stone, etc. */
  materialMap: Uint8Array;

  spawnList: SpawnList;
  caveAmbient: AmbientFeature[];
  surfaceDressing: DressingFeature[];
}

/**
 * Allocates a World ready for pipeline execution.
 *
 * - Validates seed range (must be a non-negative integer less than 2^32).
 * - Heightmap filled with HEIGHTMAP_UNINIT sentinel.
 * - Mask and materialMap zero-filled (all air).
 * - Theme remains null; DefineTheme pass resolves it via getTheme(themeTag).
 */
export function createWorld(
  seed: number,
  widthPx: number,
  heightPx: number,
  themeTag: string,
): World {
  if (!Number.isInteger(seed) || seed < 0 || seed >= 2 ** 32) {
    throw new Error(`createWorld: seed must be a non-negative integer < 2^32, got ${seed}`);
  }
  if (!Number.isInteger(widthPx) || widthPx <= 0) {
    throw new Error(`createWorld: widthPx must be a positive integer, got ${widthPx}`);
  }
  if (!Number.isInteger(heightPx) || heightPx <= 0) {
    throw new Error(`createWorld: heightPx must be a positive integer, got ${heightPx}`);
  }
  const pixelCount = widthPx * heightPx;
  if (pixelCount > MAX_PIXEL_COUNT) {
    throw new Error(
      `createWorld: widthPx * heightPx (${pixelCount}) exceeds the allocation cap of ${MAX_PIXEL_COUNT}. Worlds beyond this size are likely a bug.`,
    );
  }
  const heightmap = new Int32Array(widthPx);
  heightmap.fill(HEIGHTMAP_UNINIT);
  return {
    widthPx,
    heightPx,
    seed,
    themeTag,
    theme: null,
    heightmap,
    mask: new Uint8Array(pixelCount),
    materialMap: new Uint8Array(pixelCount),
    spawnList: { left: [], right: [] },
    caveAmbient: [],
    surfaceDressing: [],
  };
}
