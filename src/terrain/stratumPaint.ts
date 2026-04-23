/**
 * Depth-stratum paint pass.
 *
 * Scans each column of a terrain mask top-down for the first opaque
 * pixel (the surface), then paints each opaque pixel's RGB by its
 * depth from that surface: grass (0-5px), dirt (6-59px), stone (60+px).
 * Alpha is preserved, so destruction (destination-out) keeps working.
 *
 * Shared between the offline `Terrain` and networked `TerrainRenderer`
 * so both code paths produce the same Terraria-style look regardless
 * of whether the source mask came from a local generator or the server.
 */

const GRASS_R = 58;
const GRASS_G = 122;
const GRASS_B = 60;
const DIRT_R = 122;
const DIRT_G = 74;
const DIRT_B = 44;
const STONE_R = 90;
const STONE_G = 90;
const STONE_B = 90;
const GRASS_DEPTH_PX = 6;
const DIRT_DEPTH_PX = 60;

export function applyStratumPaint(
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
): void {
  const img = ctx.getImageData(0, 0, widthPx, heightPx);
  const data = img.data;
  for (let x = 0; x < widthPx; x++) {
    let surfaceY = -1;
    for (let y = 0; y < heightPx; y++) {
      const i = (y * widthPx + x) * 4;
      if (data[i + 3] === 0) continue;
      if (surfaceY === -1) surfaceY = y;
      const depth = y - surfaceY;
      let r: number;
      let g: number;
      let b: number;
      if (depth < GRASS_DEPTH_PX) {
        r = GRASS_R;
        g = GRASS_G;
        b = GRASS_B;
      } else if (depth < DIRT_DEPTH_PX) {
        r = DIRT_R;
        g = DIRT_G;
        b = DIRT_B;
      } else {
        r = STONE_R;
        g = STONE_G;
        b = STONE_B;
      }
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  ctx.putImageData(img, 0, 0);
}
