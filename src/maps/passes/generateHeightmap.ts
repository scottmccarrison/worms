import type { Pass } from "../pass";

function smoothstep(lo: number, hi: number, x: number): number {
  if (hi <= lo) return x < lo ? 0 : 1;
  const t = Math.max(0, Math.min(1, (x - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}

function cosInterp(a: number, b: number, t: number): number {
  const ft = (1 - Math.cos(t * Math.PI)) / 2;
  return a * (1 - ft) + b * ft;
}

/**
 * Three-octave value-noise heightmap.
 *
 * Octaves 1 and 2 replicate the existing terraworld generator (broad rolling
 * hills + fine detail noise). Octave 3 is new: low-frequency mountain peaks
 * gated by theme.flags.wantsPeaks and smoothstep-blended over the upper-lobe
 * of its noise so peaks are sparse, not everywhere.
 *
 * Surface formula:
 *   surfaceY = floor(baseY + base + detail + mountainContribution)
 *   baseY            = heightPx * tuning.worldgen.surfaceBaselineFrac
 *   base             = sampleAt(baseSamples, baseStride, x)        in [-baseAmp, baseAmp]
 *   detail           = sampleAt(detailSamples, detailStride, x)    in [-detailAmp, detailAmp]
 *   mountain (raw)   = sampleAt(mountainSamples, mountainStride, x) in [-mountainAmp, mountainAmp]
 *   t                = max(0, mountain / mountainAmp)              in [0, 1] (only positive lobe)
 *   blend            = smoothstep(mountainSmoothstepLo, mountainSmoothstepHi, t)
 *   mountainContribution = -blend * mountainAmp                    (negative => surfaceY decreases => taller peak)
 *
 * surfaceY clamped to [0, heightPx - 1] - never produces the heightPx void
 * sentinel (only ApplyThemeHeightmapMods is allowed to write that).
 *
 * RNG call count is deterministic for given (widthPx, theme.flags.wantsPeaks):
 *   - octave 1: ceil(widthPx / baseStride) + 2
 *   - octave 2: ceil(widthPx / detailStride) + 2
 *   - octave 3: ceil(widthPx / mountainStride) + 2 if wantsPeaks && mountainAmp > 0, else 0
 *
 * Determinism: same seed at the same widthPx produces identical heightmaps.
 * Same seed at different widthPx does NOT produce comparable output (sample
 * counts differ). Acceptable; we do not dynamically resize worlds in v1.
 */
export const generateHeightmapPass: Pass = {
  name: "GenerateHeightmap",
  run: ({ world, rng, tuning }) => {
    if (!world.theme) {
      throw new Error("GenerateHeightmap: world.theme is null; DefineTheme must run first");
    }
    const { widthPx, heightPx } = world;
    const cfg = tuning.worldgen.heightmap;
    const baseAmp = heightPx * cfg.baseAmpFrac;
    const detailAmp = heightPx * cfg.detailAmpFrac;
    const mountainAmp = heightPx * cfg.mountainAmpFrac;
    const baseY = heightPx * tuning.worldgen.surfaceBaselineFrac;
    const wantsPeaks = world.theme.flags.wantsPeaks && mountainAmp > 0;

    const buildSamples = (amp: number, count: number): number[] => {
      const samples: number[] = [];
      for (let i = 0; i < count; i++) {
        samples.push((rng() * 2 - 1) * amp);
      }
      return samples;
    };
    const sampleAt = (samples: number[], stride: number, x: number): number => {
      const col = x / stride;
      const i = Math.floor(col);
      const t = col - i;
      const s0 = samples[i] ?? 0;
      const s1 = samples[i + 1] ?? 0;
      return cosInterp(s0, s1, t);
    };

    const baseSamples = buildSamples(baseAmp, Math.ceil(widthPx / cfg.baseStride) + 2);
    const detailSamples = buildSamples(detailAmp, Math.ceil(widthPx / cfg.detailStride) + 2);
    const mountainSamples = wantsPeaks
      ? buildSamples(mountainAmp, Math.ceil(widthPx / cfg.mountainStride) + 2)
      : null;

    const maxY = heightPx - 1; // never produce the heightPx void sentinel
    for (let x = 0; x < widthPx; x++) {
      const base = sampleAt(baseSamples, cfg.baseStride, x);
      const detail = sampleAt(detailSamples, cfg.detailStride, x);
      let mountain = 0;
      if (mountainSamples) {
        const noise = sampleAt(mountainSamples, cfg.mountainStride, x);
        const t = Math.max(0, noise / mountainAmp);
        const blend = smoothstep(cfg.mountainSmoothstepLo, cfg.mountainSmoothstepHi, t);
        mountain = -blend * mountainAmp;
      }
      const surfaceY = Math.max(0, Math.min(maxY, Math.floor(baseY + base + detail + mountain)));
      world.heightmap[x] = surfaceY;
    }
  },
};
