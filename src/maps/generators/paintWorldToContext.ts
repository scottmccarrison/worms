import type { ThemePalette } from "../themes";
import { MASK_SOLID, MATERIAL_CRUST, MATERIAL_DIRT, MATERIAL_ROCK, MATERIAL_STONE } from "../world";

interface Rgb {
  r: number;
  g: number;
  b: number;
}

function unpackRgb(hex: number): Rgb {
  return {
    r: (hex >> 16) & 0xff,
    g: (hex >> 8) & 0xff,
    b: hex & 0xff,
  };
}

/**
 * Materializes a (mask, materialMap) pair into a fully-painted canvas:
 * alpha from mask, RGB from material code via the theme palette.
 *
 * Material -> palette mapping:
 *   AIR    -> alpha 0 (transparent; RGB stays 0 from createImageData)
 *   DIRT   -> palette.mid
 *   ROCK   -> palette.rock
 *   STONE  -> palette.deep
 *   CRUST  -> palette.surface
 *
 * For solid pixels with material = AIR or unknown (defensive fallback):
 * uses palette.mid as the dirt color so the world doesn't render as
 * black holes if the pipeline produced unspecified material codes.
 *
 * Replaces stratumPaint for v1 pipeline maps. Legacy maps continue using
 * stratumPaint (their generators don't write a materialMap).
 */
export function paintWorldToContext(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  materialMap: Uint8Array,
  palette: ThemePalette,
  widthPx: number,
  heightPx: number,
): void {
  const expectedLen = widthPx * heightPx;
  if (mask.length !== expectedLen) {
    throw new Error(
      `paintWorldToContext: mask.length (${mask.length}) !== widthPx * heightPx (${expectedLen})`,
    );
  }
  if (materialMap.length !== expectedLen) {
    throw new Error(
      `paintWorldToContext: materialMap.length (${materialMap.length}) !== widthPx * heightPx (${expectedLen})`,
    );
  }

  const dirt = unpackRgb(palette.mid);
  const rock = unpackRgb(palette.rock);
  const stone = unpackRgb(palette.deep);
  const crust = unpackRgb(palette.surface);

  const imageData = ctx.createImageData(widthPx, heightPx);
  const data = imageData.data;

  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== MASK_SOLID) continue; // air: leave at default 0/0/0/0
    const dataIdx = i * 4;
    const m = materialMap[i];
    let rgb: Rgb;
    switch (m) {
      case MATERIAL_DIRT:
        rgb = dirt;
        break;
      case MATERIAL_ROCK:
        rgb = rock;
        break;
      case MATERIAL_STONE:
        rgb = stone;
        break;
      case MATERIAL_CRUST:
        rgb = crust;
        break;
      default:
        rgb = dirt; // defensive: unspecified material codes render as dirt
    }
    data[dataIdx] = rgb.r;
    data[dataIdx + 1] = rgb.g;
    data[dataIdx + 2] = rgb.b;
    data[dataIdx + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
}
