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
export const ALPHA_SOLID = 255;
export const MIN_RUN_PX = 2;

/**
 * Scans a pixel mask for horizontal runs of opaque pixels and returns
 * BoxSpec descriptors for each run. Pure function; no side effects.
 *
 * @param data  - RGBA pixel data (length = width * height * 4)
 * @param width - canvas width in pixels
 * @param height - canvas height in pixels
 * @param region - if provided, only rows in [yMin, yMax) are scanned
 * @param rowHeight - vertical resolution of each scan row (default 5)
 * @param minRunPx - minimum run length to emit (default 2)
 */
export function scanMaskForBoxes(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  region?: ScanRegion | null,
  rowHeight?: number,
  minRunPx?: number,
): BoxSpec[] {
  const rh = rowHeight ?? TERRAIN_ROW_HEIGHT;
  const minRun = minRunPx ?? MIN_RUN_PX;

  // Determine the y range to scan
  let yStart: number;
  let yEnd: number;
  if (region != null) {
    // Snap yMin DOWN and yMax UP to rowHeight grid, clamp to [0, height)
    yStart = Math.max(0, Math.floor(region.yMin / rh) * rh);
    yEnd = Math.min(height, Math.ceil(region.yMax / rh) * rh);
  } else {
    yStart = 0;
    yEnd = height;
  }

  const boxes: BoxSpec[] = [];

  for (let rowY = yStart; rowY < yEnd; rowY += rh) {
    const scanY = rowY + Math.floor(rh / 2); // center of row
    if (scanY >= height) continue;

    let runStart = -1;

    for (let x = 0; x < width; x++) {
      const idx = (scanY * width + x) * 4 + 3; // alpha channel
      const solid = data[idx] >= ALPHA_SOLID;

      if (solid && runStart < 0) {
        runStart = x;
      } else if (!solid && runStart >= 0) {
        // End of run
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

    // Flush open run at row-end
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
