import type { World } from "planck";

export interface RaycastHit {
  pointMeters: { x: number; y: number };
  fraction: number;
}

/**
 * Cast a ray from `fromMeters` toward `dir` (normalized) up to `maxDistanceMeters`.
 * Returns first terrain-tagged fixture hit or null.
 *
 * World.rayCast callback:
 *   return fraction to clip the ray to the hit point (take closest)
 *   return 1.0 to ignore and continue
 *   return -1.0 to stop immediately (unused here - we want closest)
 */
export function raycastFirstTerrain(
  world: World,
  fromMeters: { x: number; y: number },
  dir: { x: number; y: number },
  maxDistanceMeters: number,
): RaycastHit | null {
  const p1 = { x: fromMeters.x, y: fromMeters.y };
  const p2 = {
    x: fromMeters.x + dir.x * maxDistanceMeters,
    y: fromMeters.y + dir.y * maxDistanceMeters,
  };

  let best: RaycastHit | null = null;

  world.rayCast(p1, p2, (fixture, point, _normal, fraction) => {
    const ud = fixture.getBody().getUserData() as { kind?: string } | null;
    if (ud?.kind !== "terrain") {
      // Ignore non-terrain fixtures - continue scanning
      return 1;
    }
    // Take closest hit
    if (best === null || fraction < best.fraction) {
      best = {
        pointMeters: { x: point.x, y: point.y },
        fraction,
      };
    }
    // Return fraction to clip ray - allows finding closer hits if any
    return fraction;
  });

  return best;
}
