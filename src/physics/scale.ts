export const PX_PER_M = 30;
export const M_PER_PX = 1 / PX_PER_M;

export function toMeters(px: number): number {
  return px * M_PER_PX;
}

export function toPixels(m: number): number {
  return m * PX_PER_M;
}
