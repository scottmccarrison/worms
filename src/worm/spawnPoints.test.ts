import { describe, expect, it } from "vitest";
import { xorshift } from "../maps/xorshift";
import { findSpawnPoints } from "./spawnPoints";

/** Transparent top half + solid bottom half (simulates ground-only terrain). */
function groundOnlyMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = Math.floor(h / 2); row < h; row++) {
    for (let col = 0; col < w; col++) {
      data[(row * w + col) * 4 + 3] = 255;
    }
  }
  return data;
}

/** All-transparent mask. */
function emptyMask(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

describe("findSpawnPoints", () => {
  it("returns [] for an empty mask", () => {
    const data = emptyMask(1000, 500);
    expect(findSpawnPoints(data, 1000, 500, 4)).toEqual([]);
  });

  it("returns [] for count=0", () => {
    const data = groundOnlyMask(1000, 500);
    expect(findSpawnPoints(data, 1000, 500, 0)).toEqual([]);
  });

  it("full-terrain map: finds N spawns all on the surface", () => {
    const w = 2000;
    const h = 500;
    const data = groundOnlyMask(w, h);
    const pts = findSpawnPoints(data, w, h, 4, { rng: xorshift(1) });
    expect(pts).toHaveLength(4);
    for (const pt of pts) {
      // Surface is at h/2 = 250
      expect(pt.yPx).toBe(Math.floor(h / 2));
      // xPx should be inside the canvas
      expect(pt.xPx).toBeGreaterThanOrEqual(0);
      expect(pt.xPx).toBeLessThan(w);
    }
  });

  it("determinism: same rng seed produces same spawn set", () => {
    const w = 2000;
    const h = 500;
    const data = groundOnlyMask(w, h);
    const ptsA = findSpawnPoints(data, w, h, 4, { rng: xorshift(42) });
    const ptsB = findSpawnPoints(data, w, h, 4, { rng: xorshift(42) });
    expect(ptsA).toEqual(ptsB);
  });

  it("spacing: with wide open terrain, spawns are at least minSpacingPx apart", () => {
    const w = 2000;
    const h = 500;
    const data = groundOnlyMask(w, h);
    const minSpacing = 200;
    const pts = findSpawnPoints(data, w, h, 4, { rng: xorshift(7), minSpacingPx: minSpacing });
    expect(pts.length).toBeGreaterThan(0);
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dist = Math.abs((pts[i] as { xPx: number }).xPx - (pts[j] as { xPx: number }).xPx);
        expect(dist).toBeGreaterThanOrEqual(minSpacing);
      }
    }
  });

  it("different rng seeds produce different spawn positions (variety check)", () => {
    const w = 2000;
    const h = 500;
    const data = groundOnlyMask(w, h);
    const ptsA = findSpawnPoints(data, w, h, 4, { rng: xorshift(1) });
    const ptsB = findSpawnPoints(data, w, h, 4, { rng: xorshift(99) });
    // At least one x position should differ between the two runs
    const xsA = ptsA.map((p) => p.xPx).sort((a, b) => a - b);
    const xsB = ptsB.map((p) => p.xPx).sort((a, b) => a - b);
    expect(xsA).not.toEqual(xsB);
  });
});
