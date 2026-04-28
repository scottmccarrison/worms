import type { Pass } from "../pass";
import { MASK_AIR } from "../world";

/**
 * Cellular-automata cave carver, byte-mask edition. Replicates the algorithm
 * in src/maps/caves/cellularAutomata.ts but operates on world.mask: Uint8Array
 * directly instead of CanvasRenderingContext2D. The CA cell grid (cols * rows
 * of 1=solid/0=void) is a temporary internal Uint8Array; only the final
 * void-cell pixel writes touch world.mask.
 *
 * Theme params:
 * - cellSizePx (default tuning.caves.cellSizePx = 24): cell granularity
 * - initialFillRatio (default tuning.caves.initialFillRatio = 0.5): probability solid
 * - caveIterations (default tuning.caves.iterations = 4): CA iteration count.
 *   Note: theme key is `caveIterations`; tuning key is `iterations`.
 * - surfaceBufferPx (default tuning.caves.surfaceBufferPx = 80): pixels of crust
 *
 * Surface source: world.heightmap[x] (Int32Array populated by GenerateHeightmap).
 * Void columns (heightmap[x] === heightPx) naturally have surfY+bufferPx > heightPx,
 * so all cells in those columns force-solid; no carving applied; mask unchanged
 * (was already all-air from PaintSubstrateMask).
 *
 * Per-pass RNG count is deterministic for given (widthPx, heightPx, cellSizePx,
 * initialFillRatio, surfaceBuffer state): exactly one rng() call per non-buffer
 * cell during initial fill. CA iterations consume zero rng.
 */
export const carveCavesPass: Pass = {
  name: "CarveCaves",
  run: ({ world, rng, tuning, resolveParam }) => {
    if (!world.theme) {
      throw new Error("CarveCaves: world.theme is null; DefineTheme must run first");
    }
    if (!world.theme.flags.wantsCaves) return;

    const { widthPx, heightPx, mask, heightmap } = world;
    const cellSizePx = resolveParam("cellSizePx", tuning.caves.cellSizePx);
    const initialFillRatio = resolveParam("initialFillRatio", tuning.caves.initialFillRatio);
    const iterations = resolveParam("caveIterations", tuning.caves.iterations);
    const surfaceBufferPx = resolveParam("surfaceBufferPx", tuning.caves.surfaceBufferPx);

    const cols = Math.ceil(widthPx / cellSizePx);
    const rows = Math.ceil(heightPx / cellSizePx);
    const total = cols * rows;

    const isCellAboveSurfaceBuffer = (cx: number, cy: number): boolean => {
      const cellCenterX = Math.min(Math.floor(cx * cellSizePx + cellSizePx / 2), widthPx - 1);
      const cellCenterY = Math.floor(cy * cellSizePx + cellSizePx / 2);
      const surfY = heightmap[cellCenterX] ?? 0;
      return cellCenterY < surfY + surfaceBufferPx;
    };

    let cells = new Uint8Array(total);
    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx;
        if (isCellAboveSurfaceBuffer(cx, cy)) {
          cells[idx] = 1;
        } else {
          cells[idx] = rng() < initialFillRatio ? 1 : 0;
        }
      }
    }

    for (let iter = 0; iter < iterations; iter++) {
      const next = new Uint8Array(total);
      for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
          const idx = cy * cols + cx;
          if (isCellAboveSurfaceBuffer(cx, cy)) {
            next[idx] = 1;
            continue;
          }
          let solidCount = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              const ny = cy + dy;
              if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) {
                solidCount++;
              } else {
                solidCount += cells[ny * cols + nx] ?? 0;
              }
            }
          }
          const wasSolid = cells[idx] === 1;
          next[idx] = solidCount >= 5 || (wasSolid && solidCount >= 4) ? 1 : 0;
        }
      }
      cells = next;
    }

    for (let cy = 0; cy < rows; cy++) {
      for (let cx = 0; cx < cols; cx++) {
        const idx = cy * cols + cx;
        if ((cells[idx] ?? 1) !== 0) continue;
        const pixelX0 = cx * cellSizePx;
        const pixelY0 = cy * cellSizePx;
        const pixelX1 = Math.min(pixelX0 + cellSizePx, widthPx);
        const pixelY1 = Math.min(pixelY0 + cellSizePx, heightPx);
        for (let py = pixelY0; py < pixelY1; py++) {
          for (let px = pixelX0; px < pixelX1; px++) {
            const surfY = heightmap[px] ?? 0;
            if (py >= surfY + surfaceBufferPx) {
              mask[py * widthPx + px] = MASK_AIR;
            }
          }
        }
      }
    }
  },
};
