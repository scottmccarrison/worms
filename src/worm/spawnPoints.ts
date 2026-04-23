export interface SurfacePoint {
  xPx: number;
  yPx: number; // top of terrain at this X (pixel coord)
}

export interface FindSpawnPointsOpts {
  rng?: () => number; // default: Math.random
  minSpacingPx?: number; // default: 200
  edgeMarginPx?: number; // default: 60
  alphaSolid?: number; // default: 255
}

/**
 * Find N spawn points on the terrain surface using a random + minimum-spacing
 * algorithm. Scans every column for surface candidates, shuffles via the
 * provided rng (seeded = deterministic), then greedy-picks with minimum
 * spacing. If not enough candidates satisfy the spacing, it retries at
 * progressively relaxed spacings until fallback (spacing 0).
 *
 * Returns however many points were found (may be fewer than count if the
 * terrain is very sparse or narrow).
 */
export function findSpawnPoints(
  data: Uint8ClampedArray,
  widthPx: number,
  heightPx: number,
  count: number,
  opts?: FindSpawnPointsOpts,
): SurfacePoint[] {
  if (count <= 0 || widthPx <= 0 || heightPx <= 0) return [];

  const rng = opts?.rng ?? Math.random;
  const minSpacingPx = opts?.minSpacingPx ?? 200;
  const edgeMarginPx = opts?.edgeMarginPx ?? 60;
  const alphaSolid = opts?.alphaSolid ?? 255;

  // Collect all valid surface candidates (skip edge margin columns)
  const candidates: SurfacePoint[] = [];
  for (let col = edgeMarginPx; col < widthPx - edgeMarginPx; col++) {
    const pt = scanColumnTopDown(data, widthPx, heightPx, col, alphaSolid);
    if (pt !== null) {
      candidates.push(pt);
    }
  }

  if (candidates.length === 0) return [];

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = candidates[i] as SurfacePoint;
    (candidates[i] as SurfacePoint) = candidates[j] as SurfacePoint;
    (candidates[j] as SurfacePoint) = tmp;
  }

  // Greedy-pick with spacing relaxation
  const spacingFactors = [1.0, 0.8, 0.6, 0.4, 0.2, 0];
  for (const factor of spacingFactors) {
    const currentSpacing = minSpacingPx * factor;
    const picked: SurfacePoint[] = [];

    for (const candidate of candidates) {
      if (picked.length >= count) break;
      const tooClose = picked.some((p) => Math.abs(p.xPx - candidate.xPx) < currentSpacing);
      if (!tooClose) {
        picked.push(candidate);
      }
    }

    if (picked.length >= count) {
      return picked.slice(0, count);
    }
  }

  // Return whatever we found at spacing 0 (all candidates up to count)
  return candidates.slice(0, count);
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
