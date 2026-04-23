import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

/**
 * Procgen two-cliff canyon generator.
 *
 * Designed for 2560x1024 but works at any size. A randomized void gap
 * splits the world into left and right cliff masses. There is no floor;
 * worms that fall into the gap are killed by the off-map-kill system.
 *
 * The gap width is 18-25% of the world width, positioned near center
 * with a small random offset. Each cliff has a bumpy top surface
 * produced by a sparse heightmap (stride 128, amplitude +-5% of height).
 * The two cliff tops are seeded independently for asymmetry.
 *
 * RGB is painted by the stratum pass; this generator only emits the
 * alpha mask (solid/air geometry).
 */
export const canyonBiomeGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);

  // Gap geometry
  const gapWidth = Math.floor(width * (0.22 + rng() * 0.1));
  const centerX = Math.floor(width / 2 + (rng() - 0.5) * width * 0.08);
  const leftEdge = centerX - Math.floor(gapWidth / 2);
  const rightEdge = centerX + Math.ceil(gapWidth / 2);

  // Heightmap samples for left cliff top
  const stride = 192;
  const amp = height * 0.02;
  const baseTopLeft = height * (0.28 + rng() * 0.1);
  const baseTopRight = height * (0.28 + rng() * 0.1);

  // Generate left cliff samples (covers x = 0..leftEdge)
  const leftSampleCount = Math.ceil(leftEdge / stride) + 2;
  const leftSamples: number[] = [];
  for (let i = 0; i < leftSampleCount; i++) {
    leftSamples.push(baseTopLeft + (rng() * 2 - 1) * amp);
  }

  // Generate right cliff samples (covers x = rightEdge..width)
  const rightSampleCount = Math.ceil((width - rightEdge) / stride) + 2;
  const rightSamples: number[] = [];
  for (let i = 0; i < rightSampleCount; i++) {
    rightSamples.push(baseTopRight + (rng() * 2 - 1) * amp);
  }

  const sampleAt = (samples: number[], localX: number, fallback: number): number => {
    const col = localX / stride;
    const i = Math.floor(col);
    const t = col - i;
    const s0 = samples[i] ?? fallback;
    const s1 = samples[i + 1] ?? fallback;
    return s0 * (1 - t) + s1 * t;
  };

  ctx.fillStyle = "#ffffff";

  // Left cliff: x = 0..leftEdge-1
  for (let x = 0; x < leftEdge; x++) {
    const surfaceY = Math.floor(sampleAt(leftSamples, x, baseTopLeft));
    if (surfaceY < height) {
      ctx.fillRect(x, surfaceY, 1, height - surfaceY);
    }
  }

  // Right cliff: x = rightEdge..width-1
  for (let x = rightEdge; x < width; x++) {
    const localX = x - rightEdge;
    const surfaceY = Math.floor(sampleAt(rightSamples, localX, baseTopRight));
    if (surfaceY < height) {
      ctx.fillRect(x, surfaceY, 1, height - surfaceY);
    }
  }

  // Gap (x = leftEdge..rightEdge-1) is void - no geometry drawn here
};
