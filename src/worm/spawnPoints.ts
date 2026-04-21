export interface SurfacePoint {
  xPx: number;
  yPx: number; // top of terrain at this X (pixel coord)
}

/**
 * Find N spawn points evenly distributed across the terrain's surface.
 * Scans each selected column top-down for the first opaque pixel.
 * Returns however many points were found (may be fewer than count if some slots had no terrain).
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

  return results; // May return fewer than `count` if some slots had no terrain
}

function scanColumnTopDown(
  data: Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  col: number,
  alphaSolid: number,
): SurfacePoint | null {
  // Walk top-down through [optional-ceiling][air][ground-top].
  // Skip any opaque region at the top (a ceiling), then find the next opaque pixel
  // (the ground surface). If no ceiling, the first loop is a no-op.
  let row = 0;
  const isOpaque = (r: number): boolean => data[(r * widthPx + col) * 4 + 3] >= alphaSolid;
  while (row < heightPx && isOpaque(row)) row++;
  while (row < heightPx && !isOpaque(row)) row++;
  if (row < heightPx) return { xPx: col, yPx: row };
  return null;
}
