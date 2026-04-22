/**
 * Server-side port of src/terrain/terrainAlgorithm.ts.
 *
 * scanMaskForBoxes walks a pixel mask in horizontal strips and emits
 * rectangle descriptors for each run of solid pixels. Pure function -
 * no canvas, no Phaser, no DOM dependency - so it runs identically in
 * the Workers runtime.
 *
 * The client version walks RGBA data (width * height * 4) and checks
 * the alpha channel. The server stores its mask as a single-byte
 * Uint8Array for compactness (Workers has no Canvas2D), so this copy
 * reads from a 1-byte-per-pixel grid where any non-zero byte is solid.
 */

export interface BoxSpec {
  readonly cxPx: number;
  readonly cyPx: number;
  readonly wPx: number;
  readonly hPx: number;
}

export interface ScanRegion {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export const TERRAIN_ROW_HEIGHT = 5;
export const MIN_RUN_PX = 2;

/**
 * Scan a 1-byte-per-pixel mask and emit BoxSpec records for each run
 * of solid (non-zero) pixels. `data` is indexed as `y * width + x`.
 *
 * @param data - Uint8Array (length = width * height); non-zero = solid
 * @param width - mask width in pixels
 * @param height - mask height in pixels
 * @param region - optional Y-band to limit scanning (snapped to rowHeight)
 * @param rowHeight - vertical resolution of each scan row (default 5)
 * @param minRunPx - minimum run length to emit (default 2)
 */
export function scanMaskForBoxes(
  data: Uint8Array,
  width: number,
  height: number,
  region?: ScanRegion | null,
  rowHeight?: number,
  minRunPx?: number,
): BoxSpec[] {
  const rh = rowHeight ?? TERRAIN_ROW_HEIGHT;
  const minRun = minRunPx ?? MIN_RUN_PX;

  let yStart: number;
  let yEnd: number;
  if (region != null) {
    yStart = Math.max(0, Math.floor(region.yMin / rh) * rh);
    yEnd = Math.min(height, Math.ceil(region.yMax / rh) * rh);
  } else {
    yStart = 0;
    yEnd = height;
  }

  const boxes: BoxSpec[] = [];

  for (let rowY = yStart; rowY < yEnd; rowY += rh) {
    const scanY = rowY + Math.floor(rh / 2);
    if (scanY >= height) continue;

    let runStart = -1;

    for (let x = 0; x < width; x++) {
      const idx = scanY * width + x;
      const solid = data[idx] !== 0;

      if (solid && runStart < 0) {
        runStart = x;
      } else if (!solid && runStart >= 0) {
        const runLen = x - runStart;
        if (runLen >= minRun) {
          boxes.push({
            cxPx: runStart + runLen / 2,
            cyPx: rowY + rh / 2,
            wPx: runLen,
            hPx: rh,
          });
        }
        runStart = -1;
      }
    }

    if (runStart >= 0) {
      const runLen = width - runStart;
      if (runLen >= minRun) {
        boxes.push({
          cxPx: runStart + runLen / 2,
          cyPx: rowY + rh / 2,
          wPx: runLen,
          hPx: rh,
        });
      }
    }
  }

  return boxes;
}
