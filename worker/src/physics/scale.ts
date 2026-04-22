/**
 * Pixel <-> meter conversion helpers. Copied verbatim from
 * src/physics/scale.ts so the server runs in the same coordinate
 * system as the client. PX_PER_M MUST match the client or bodies
 * spawn at the wrong positions.
 */

export const PX_PER_M = 30;
export const M_PER_PX = 1 / PX_PER_M;

export function toMeters(px: number): number {
  return px * M_PER_PX;
}

export function toPixels(m: number): number {
  return m * PX_PER_M;
}
