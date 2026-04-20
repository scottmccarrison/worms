import { describe, expect, it } from "vitest";
import { findSpawnPoints } from "./spawnPoints";

/** Build a flat RGBA Uint8ClampedArray where every pixel is fully opaque. */
function solidMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100;
    data[i + 1] = 150;
    data[i + 2] = 80;
    data[i + 3] = 255; // fully opaque
  }
  return data;
}

/** Build mask with terrain only in the left and right columns (hollow center). */
function hollowCenterMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  // Only fill the leftmost and rightmost columns
  for (let row = 0; row < h; row++) {
    for (const col of [0, w - 1]) {
      const idx = (row * w + col) * 4;
      data[idx + 3] = 255;
    }
  }
  return data;
}

/** All-transparent mask. */
function emptyMask(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4); // default 0 = transparent
}

/** Single column with terrain (only col 0). */
function singleColumnMask(w: number, h: number): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const idx = row * w * 4; // col 0
    data[idx + 3] = 255;
  }
  return data;
}

describe("findSpawnPoints", () => {
  it("returns N evenly-spread points for a full solid mask", () => {
    const w = 100;
    const h = 50;
    const data = solidMask(w, h);
    const pts = findSpawnPoints(data, w, h, 4);
    expect(pts).toHaveLength(4);
    // All should be at row 0 (first opaque row from top)
    for (const pt of pts) {
      expect(pt.yPx).toBe(0);
    }
    // X positions should be spread across width
    const xs = pts.map((p) => p.xPx).sort((a, b) => a - b);
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
  });

  it("returns [] when mask is entirely transparent", () => {
    const data = emptyMask(100, 50);
    expect(findSpawnPoints(data, 100, 50, 4)).toEqual([]);
  });

  it("returns [] when count > available terrain columns", () => {
    // Only 2 edge columns have terrain, asking for 4 points
    const data = hollowCenterMask(100, 50);
    const pts = findSpawnPoints(data, 100, 50, 4);
    expect(pts).toEqual([]);
  });

  it("returns 1 point when asking for 1 and single column has terrain", () => {
    const data = singleColumnMask(100, 50);
    const pts = findSpawnPoints(data, 100, 50, 1);
    expect(pts).toHaveLength(1);
    expect(pts[0].xPx).toBe(0);
    expect(pts[0].yPx).toBe(0);
  });

  it("returns [] for count=0", () => {
    const data = solidMask(100, 50);
    expect(findSpawnPoints(data, 100, 50, 0)).toEqual([]);
  });
});
