/** Pure aim angle helpers (radians; 0 = aim right/horizontal, -PI/2 = up, +PI/2 = down). */

export const AIM_MIN = -Math.PI / 2;
export const AIM_MAX = Math.PI / 2;

/** Clamp an angle to the aim range. */
export function clampAim(angle: number): number {
  return Math.max(AIM_MIN, Math.min(AIM_MAX, angle));
}

/**
 * Step an angle toward a direction.
 * @param current current angle (radians)
 * @param direction -1 = rotate up, +1 = rotate down, 0 = no change
 * @param speed radians/sec
 * @param dtSeconds time step
 */
export function stepAim(
  current: number,
  direction: -1 | 0 | 1,
  speed: number,
  dtSeconds: number,
): number {
  if (direction === 0) return current;
  return clampAim(current + direction * speed * dtSeconds);
}
