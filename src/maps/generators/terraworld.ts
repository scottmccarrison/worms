import { tuning } from "../../tuning";
import { carveCaves } from "../caves/cellularAutomata";
import type { MapGenerator } from "../types";
import { xorshift } from "../xorshift";

/**
 * Phase 1 procgen generator: rolling hills via two-octave heightmap with
 * cosine interpolation. Solid below the surface line; sky above.
 *
 * Octave 1 (base): stride 256, amplitude height * 0.08 - broad undulation.
 * Octave 2 (detail): stride 96, amplitude height * 0.02 - fine surface noise.
 *
 * RGB is painted by TerrainRenderer's stratum pass; this generator only
 * produces the alpha mask (solid/air geometry).
 */
export const terraworldGenerator: MapGenerator = (ctx, width, height, opts) => {
  const rng = xorshift(opts.seed);

  const baseY = height * 0.55;

  // Cosine interpolation between two samples
  const cosInterp = (a: number, b: number, t: number): number => {
    const ft = (1 - Math.cos(t * Math.PI)) / 2;
    return a * (1 - ft) + b * ft;
  };

  // Build a sample array for a given amplitude
  const buildSamples = (amp: number, count: number): number[] => {
    const samples: number[] = [];
    for (let i = 0; i < count; i++) {
      samples.push((rng() * 2 - 1) * amp);
    }
    return samples;
  };

  // Read interpolated value from a sample array at pixel x
  const sampleAt = (samples: number[], stride: number, x: number): number => {
    const col = x / stride;
    const i = Math.floor(col);
    const t = col - i;
    const s0 = samples[i] ?? 0;
    const s1 = samples[i + 1] ?? 0;
    return cosInterp(s0, s1, t);
  };

  // Octave 1: broad rolling hills
  const baseStride = 256;
  const baseAmp = height * 0.08;
  const baseSampleCount = Math.ceil(width / baseStride) + 2;
  const baseSamples = buildSamples(baseAmp, baseSampleCount);

  // Octave 2: fine surface detail
  const detailStride = 96;
  const detailAmp = height * 0.02;
  const detailSampleCount = Math.ceil(width / detailStride) + 2;
  const detailSamples = buildSamples(detailAmp, detailSampleCount);

  // Shared surface formula used by both the fill loop and cave carver
  const surfaceAt = (x: number): number => {
    return Math.floor(
      baseY + sampleAt(baseSamples, baseStride, x) + sampleAt(detailSamples, detailStride, x),
    );
  };

  // Any opaque fill works; stratum painter overwrites RGB.
  ctx.fillStyle = "#ffffff";
  for (let x = 0; x < width; x++) {
    const surfaceY = surfaceAt(x);
    if (surfaceY < height) {
      ctx.fillRect(x, surfaceY, 1, height - surfaceY);
    }
  }

  // Build per-column surface array for cave carver
  const surfaceByColumn = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    surfaceByColumn[x] = Math.max(0, Math.min(height, surfaceAt(x)));
  }

  // Carve cellular-automata caves in the subsurface (Terraworld only)
  carveCaves(ctx, width, height, {
    cellSizePx: tuning.caves.cellSizePx,
    initialFillRatio: tuning.caves.initialFillRatio,
    iterations: tuning.caves.iterations,
    rng,
    surfaceByColumn,
    surfaceBufferPx: tuning.caves.surfaceBufferPx,
  });
};
