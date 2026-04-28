/**
 * Materializes a 1-byte-per-pixel solid/air mask into a canvas context.
 *
 * Writes RGB=255 + alpha=255 for solid pixels (matches the
 * fillStyle="#ffffff" convention used by existing canvas-based generators;
 * applyStratumPaint overwrites RGB later but preserves alpha). Air pixels
 * stay at the default 0/0/0/0 from createImageData.
 *
 * Used by the v1 pipeline's terraworldV1 generator (and any future pipeline-
 * based generator) to convert a Uint8Array mask into the HTMLCanvasElement
 * shape that LoadedMap and TerrainRenderer consume.
 */
export function paintMaskToContext(
  ctx: CanvasRenderingContext2D,
  mask: Uint8Array,
  widthPx: number,
  heightPx: number,
): void {
  if (mask.length !== widthPx * heightPx) {
    throw new Error(
      `paintMaskToContext: mask.length (${mask.length}) !== widthPx * heightPx (${widthPx * heightPx})`,
    );
  }
  const imageData = ctx.createImageData(widthPx, heightPx);
  const data = imageData.data;
  // mask[i] is one byte per pixel; data is RGBA (4 bytes per pixel).
  // Solid byte (1) -> opaque white pixel; air byte (0) -> transparent
  // (default zero from createImageData).
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) {
      const dataIdx = i * 4;
      data[dataIdx] = 255;
      data[dataIdx + 1] = 255;
      data[dataIdx + 2] = 255;
      data[dataIdx + 3] = 255;
    }
  }
  ctx.putImageData(imageData, 0, 0);
}
