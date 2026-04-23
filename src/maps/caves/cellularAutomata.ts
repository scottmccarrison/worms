/**
 * Cellular-automata cave carver.
 *
 * Subdivides the carving region into cellSizePx x cellSizePx cells.
 * Each cell starts solid with probability initialFillRatio (rng-seeded).
 *
 * Smoothing uses the classic "B5/S4" rule (birth if void with >=5 solid
 * neighbors, survive if solid with >=4 solid neighbors). This stabilizes
 * toward coherent cave chambers rather than collapsing to all-void
 * (which the bare >=5 rule does at 0.45 initial fill).
 *
 * Out-of-bounds neighbors count as solid so walls don't erode at the
 * edges of the region.
 *
 * After iterations, every "void" cell has its pixel block's alpha set
 * to 0. A per-column surface buffer keeps the top N pixels below the
 * surface untouched so caves don't punch skylights through the
 * grass+dirt crust.
 */

export interface CarveCavesOpts {
  cellSizePx: number;
  initialFillRatio: number;
  iterations: number;
  rng: () => number;
  /** width-long; surfaceByColumn[x] = first opaque y in column x (from the heightmap paint). */
  surfaceByColumn: Int32Array;
  /** Keep this many px of crust solid below each column's surface. */
  surfaceBufferPx: number;
}

export function carveCaves(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  opts: CarveCavesOpts,
): void {
  const { cellSizePx, initialFillRatio, iterations, rng, surfaceByColumn, surfaceBufferPx } = opts;

  // 1. Cell grid dims
  const cols = Math.ceil(widthPx / cellSizePx);
  const rows = Math.ceil(heightPx / cellSizePx);
  const total = cols * rows;

  // Helper: is cell (cx, cy) above the surface buffer?
  const isCellAboveSurfaceBuffer = (cx: number, cy: number): boolean => {
    const cellCenterX = Math.min(Math.floor(cx * cellSizePx + cellSizePx / 2), widthPx - 1);
    const cellCenterY = Math.floor(cy * cellSizePx + cellSizePx / 2);
    const surfY = surfaceByColumn[cellCenterX] ?? 0;
    return cellCenterY < surfY + surfaceBufferPx;
  };

  // 2. Build initial cells Uint8Array (1=solid, 0=void)
  let cells = new Uint8Array(total);
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (isCellAboveSurfaceBuffer(cx, cy)) {
        cells[idx] = 1; // force solid in crust region
      } else {
        cells[idx] = rng() < initialFillRatio ? 1 : 0;
      }
    }
  }

  // 3. Iterate `iterations` times
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Uint8Array(total);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx;

        // Re-apply surface-buffer force-solid every iteration
        if (isCellAboveSurfaceBuffer(cx, cy)) {
          next[idx] = 1;
          continue;
        }

        // Count 8 neighbors; out-of-bounds count as solid
        let solidCount = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
              // Out-of-bounds: count as solid (prevents edge erosion)
              solidCount++;
            } else {
              solidCount += cells[ny * cols + nx] ?? 0;
            }
          }
        }

        // B5/S4 rule: survive if already solid with >=4 solid neighbors,
        // birth if void with >=5 solid neighbors. Stabilizes into coherent
        // chambers instead of collapsing toward all-void.
        const wasSolid = cells[idx] === 1;
        next[idx] = solidCount >= 5 || (wasSolid && solidCount >= 4) ? 1 : 0;
      }
    }
    cells = next;
  }

  // 4. Apply to canvas
  const imageData = ctx.getImageData(0, 0, widthPx, heightPx);
  const data = imageData.data;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if ((cells[idx] ?? 1) === 0) {
        // Void cell: set alpha=0 for each pixel in the block, but only for pixels
        // past the per-column surface buffer (prevents crust bleed)
        const pixelX0 = cx * cellSizePx;
        const pixelY0 = cy * cellSizePx;
        const pixelX1 = Math.min(pixelX0 + cellSizePx, widthPx);
        const pixelY1 = Math.min(pixelY0 + cellSizePx, heightPx);

        for (let py = pixelY0; py < pixelY1; py++) {
          for (let px = pixelX0; px < pixelX1; px++) {
            const surfY = surfaceByColumn[px] ?? 0;
            if (py >= surfY + surfaceBufferPx) {
              const dataIdx = (py * widthPx + px) * 4;
              data[dataIdx + 3] = 0;
            }
          }
        }
      }
    }
  }

  ctx.putImageData(imageData, 0, 0);
}
