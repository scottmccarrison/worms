export interface SurfacePoint {
  xPx: number;
  yPx: number; // top of terrain at this X (pixel coord)
}

/**
 * Find N spawn points evenly distributed across the terrain's surface.
 * Scans each selected column top-down for the first opaque pixel.
 * Returns [] if fewer than N columns have terrain.
 */
export function findSpawnPoints(
  data: Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  count: number,
  alphaSolid = 255,
): SurfacePoint[] {
  if (count <= 0 || widthPx <= 0 || heightPx <= 0) return [];

  const results: SurfacePoint[] = [];

  // Divide width into `count` equal slots; scan near the center of each slot
  for (let slot = 0; slot < count; slot++) {
    const slotStart = Math.floor((slot * widthPx) / count);
    const slotEnd = Math.floor(((slot + 1) * widthPx) / count);
    const slotCenter = Math.floor((slotStart + slotEnd) / 2);

    // Try columns near the center of this slot
    const columnsToTry = [slotCenter, slotCenter - 1, slotCenter + 1, slotStart, slotEnd - 1];

    let found: SurfacePoint | null = null;
    for (const col of columnsToTry) {
      if (col < 0 || col >= widthPx) continue;
      const pt = scanColumnTopDown(data, widthPx, heightPx, col, alphaSolid);
      if (pt !== null) {
        found = pt;
        break;
      }
    }

    if (found !== null) {
      results.push(found);
    }
  }

  return results.length === count ? results : [];
}

function scanColumnTopDown(
  data: Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  col: number,
  alphaSolid: number,
): SurfacePoint | null {
  for (let row = 0; row < heightPx; row++) {
    const idx = (row * widthPx + col) * 4;
    if (data[idx + 3] >= alphaSolid) {
      return { xPx: col, yPx: row };
    }
  }
  return null;
}
