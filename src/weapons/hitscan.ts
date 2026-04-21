import type { Body, Fixture } from "planck";
import type { World } from "planck";
import { toMeters, toPixels } from "../physics/scale";

export interface RaycastHit {
  fixture: Fixture;
  pointPx: { x: number; y: number };
  normal: { x: number; y: number };
}

/**
 * Fire a raycast from fromPx to toPx. Returns the closest hit, or null if
 * nothing is intersected. Excludes the firer's own body from results.
 */
export function raycastFirstHit(
  world: World,
  fromPx: { x: number; y: number },
  toPx: { x: number; y: number },
  excludeBody?: Body | null,
): RaycastHit | null {
  let closest: RaycastHit | null = null;
  let closestFrac = 1;

  world.rayCast(
    { x: toMeters(fromPx.x), y: toMeters(fromPx.y) },
    { x: toMeters(toPx.x), y: toMeters(toPx.y) },
    (fixture, point, normal, fraction) => {
      // Skip the firer's own body to prevent self-hit
      if (excludeBody && fixture.getBody() === excludeBody) {
        return -1; // skip and continue
      }

      if (fraction < closestFrac) {
        closestFrac = fraction;
        closest = {
          fixture,
          pointPx: { x: toPixels(point.x), y: toPixels(point.y) },
          normal: { x: normal.x, y: normal.y },
        };
      }
      return fraction; // clip and keep searching for closer
    },
  );

  return closest;
}
