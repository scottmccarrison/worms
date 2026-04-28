import type { AmbientFeature, DressingFeature } from "../world";

const AMBIENT_COLORS: Record<string, string> = {
  moss: "#2a5a1a",
  frost: "#caf0ff",
  glow: "#ff7a00",
};

const DRESSING_COLORS: Record<string, string> = {
  grass_tuft: "#3a8a3a",
  cactus: "#4a7a3a",
  snow_drift: "#f5f7fa",
  ash_pile: "#1a1a1a",
};

/**
 * Renders cave ambient and surface dressing features onto a canvas via
 * procedural shapes. Runs after paintWorldToContext (which paints the
 * substrate + materials). Out-of-bounds features are clipped by the canvas.
 *
 * Cave ambient: 2x2 filled square at (xPx, yPx). Color from AMBIENT_COLORS
 * keyed by feature.type.
 *
 * Surface dressing: 2x3 filled rect anchored at (xPx, yPx) extending
 * upward (y - 2 to y + 1) so the dressing sits ON the surface. Color from
 * DRESSING_COLORS keyed by feature.sprite.
 *
 * Unknown type or sprite strings are silently skipped (Terraria
 * PlaceTile no-op-on-invalid convention).
 */
export function paintDecorationToContext(
  ctx: CanvasRenderingContext2D,
  ambient: readonly AmbientFeature[],
  dressing: readonly DressingFeature[],
): void {
  for (const f of ambient) {
    const color = AMBIENT_COLORS[f.type];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(f.xPx, f.yPx, 2, 2);
  }
  for (const f of dressing) {
    const color = DRESSING_COLORS[f.sprite];
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(f.xPx, f.yPx - 2, 2, 3);
  }
}
