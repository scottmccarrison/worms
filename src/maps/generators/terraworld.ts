import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

/**
 * Phase 1 procgen generator: heightmap surface noise, solid below.
 * RGB is painted by TerrainRenderer's stratum pass; this generator only
 * produces the alpha mask (solid/air geometry).
 */
export const terraworldGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);
  const sampleStride = 32;
  const baseY = height * 0.55;
  const ampY = height * 0.12;
  const sampleCount = Math.ceil(width / sampleStride) + 1;
  const samples: number[] = [];
  for (let i = 0; i < sampleCount; i++) {
    samples.push(baseY + (rng() * 2 - 1) * ampY);
  }

  // Any opaque fill works; stratum painter overwrites RGB.
  ctx.fillStyle = "#ffffff";
  for (let x = 0; x < width; x++) {
    const col = x / sampleStride;
    const i = Math.floor(col);
    const t = col - i;
    const s0 = samples[i] ?? baseY;
    const s1 = samples[i + 1] ?? baseY;
    const surfaceY = Math.floor(s0 * (1 - t) + s1 * t);
    if (surfaceY < height) {
      ctx.fillRect(x, surfaceY, 1, height - surfaceY);
    }
  }
};
