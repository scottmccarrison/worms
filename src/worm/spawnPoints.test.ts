import { describe, expect, it } from "vitest";
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

/** Solid top strip (ceiling) + transparent middle + solid bottom (ground). */
function ceilingAndGroundMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  const ceilingHeight = Math.floor(h * 0.1);
  const groundStart = Math.floor(h * 0.6);
  for (let row = 0; row < h; row++) {
    if (row < ceilingHeight || row >= groundStart) {
      for (let col = 0; col < w; col++) {
        data[(row * w + col) * 4 + 3] = 255;
      }
    }
  }
  return data;
}

/** All-transparent mask. */
function emptyMask(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

/** Ground only in left + right edge columns (narrow playing field). */
function edgeOnlyGroundMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  const groundStart = Math.floor(h / 2);
  for (let row = groundStart; row < h; row++) {
    for (const col of [0, w - 1]) {
      data[(row * w + col) * 4 + 3] = 255;
    }
  }
  return data;
}

describe("findSpawnPoints", () => {
  it("returns N spawn points at ground surface for a ground-only mask", () => {
    const w = 100;
    const h = 50;
    const data = groundOnlyMask(w, h);
    const pts = findSpawnPoints(data, w, h, 4);
    expect(pts).toHaveLength(4);
    // Ground starts at h/2 = 25
    for (const pt of pts) {
      expect(pt.yPx).toBe(25);
    }
  });

  it("skips a ceiling and returns ground-top for a ceiling+ground mask", () => {
    const w = 100;
    const h = 50;
    const data = ceilingAndGroundMask(w, h);
    const pts = findSpawnPoints(data, w, h, 4);
    expect(pts).toHaveLength(4);
    // Ceiling is rows 0-4; air rows 5-29; ground starts at row 30
    const expectedGroundTop = Math.floor(50 * 0.6);
    for (const pt of pts) {
      expect(pt.yPx).toBe(expectedGroundTop);
    }
  });

  it("returns [] for an empty mask", () => {
    const data = emptyMask(100, 50);
    expect(findSpawnPoints(data, 100, 50, 4)).toEqual([]);
  });

  it("returns partial results when some slots lack ground", () => {
    // Only edge columns have ground; center slots have no ground surface
    const data = edgeOnlyGroundMask(100, 50);
    const pts = findSpawnPoints(data, 100, 50, 4);
    expect(pts.length).toBeGreaterThan(0);
    expect(pts.length).toBeLessThan(4);
  });

  it("returns [] for count=0", () => {
    const data = groundOnlyMask(100, 50);
    expect(findSpawnPoints(data, 100, 50, 0)).toEqual([]);
  });
});
