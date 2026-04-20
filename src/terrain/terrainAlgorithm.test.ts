import { describe, expect, it } from "vitest";
import { type BoxSpec, TERRAIN_ROW_HEIGHT, scanMaskForBoxes } from "./terrainAlgorithm";

/**
 * Build a flat RGBA pixel buffer. predicate(x, y) returns true if that
 * pixel should be fully opaque (alpha = 255).
 */
function makeMask(
  width: number,
  height: number,
  predicate: (x: number, y: number) => boolean,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (predicate(x, y)) {
        data[idx] = 0; // r
        data[idx + 1] = 128; // g
        data[idx + 2] = 0; // b
        data[idx + 3] = 255; // a - fully opaque
      }
      // transparent pixels remain 0 (default)
    }
  }
  return data;
}

describe("scanMaskForBoxes", () => {
  it("returns empty array for fully transparent mask", () => {
    const data = new Uint8ClampedArray(100 * 20 * 4); // all zeros
    const result = scanMaskForBoxes(data, 100, 20);
    expect(result).toEqual([]);
  });

  it("returns one box for a fully opaque mask (single row)", () => {
    const width = 100;
    const height = TERRAIN_ROW_HEIGHT;
    const data = makeMask(width, height, () => true);
    const result = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(1);
    const box = result[0];
    expect(box?.cxPx).toBe(50);
    expect(box?.wPx).toBe(100);
    expect(box?.hPx).toBe(TERRAIN_ROW_HEIGHT);
  });

  it("splits into two boxes when there is a gap in the middle", () => {
    const width = 100;
    const height = TERRAIN_ROW_HEIGHT;
    // Opaque on left [0-39] and right [60-99], transparent [40-59]
    const data = makeMask(width, height, (x) => x < 40 || x >= 60);
    const result = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(2);
    // Left box
    const left = result.find((b) => b.cxPx < 50);
    expect(left).toBeDefined();
    expect(left?.wPx).toBe(40);
    expect(left?.cxPx).toBe(20);
    // Right box
    const right = result.find((b) => b.cxPx > 50);
    expect(right).toBeDefined();
    expect(right?.wPx).toBe(40);
    expect(right?.cxPx).toBe(80);
  });

  it("skips single-pixel runs (below MIN_RUN_PX)", () => {
    const width = 20;
    const height = TERRAIN_ROW_HEIGHT;
    // Only pixel at x=10 is opaque - run length 1 < MIN_RUN_PX (2)
    const data = makeMask(width, height, (x) => x === 10);
    const result = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(0);
  });

  it("includes exactly-2-pixel runs (at MIN_RUN_PX boundary)", () => {
    const width = 20;
    const height = TERRAIN_ROW_HEIGHT;
    const data = makeMask(width, height, (x) => x === 10 || x === 11);
    const result = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(1);
    expect(result[0]?.wPx).toBe(2);
  });

  it("scans only rows within a region", () => {
    const width = 100;
    const height = 20; // 4 rows at rowHeight=5: rows 0,5,10,15
    // All opaque
    const data = makeMask(width, height, () => true);
    // Region covers only rows 5-10
    const region = { xMin: 0, xMax: width, yMin: 5, yMax: 10 };
    const result = scanMaskForBoxes(data, width, height, region);
    // Should scan 1 row: rowY=5 (snapped)
    expect(result).toHaveLength(1);
    expect(result[0]?.cyPx).toBe(5 + TERRAIN_ROW_HEIGHT / 2);
  });

  it("clamps region out of bounds to valid pixel range", () => {
    const width = 50;
    const height = 10;
    const data = makeMask(width, height, () => true);
    // Region extends beyond height
    const region = { xMin: 0, xMax: width, yMin: 0, yMax: 100 };
    const result = scanMaskForBoxes(data, width, height, region);
    // Should return same as full scan
    const full = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(full.length);
  });

  it("handles height not divisible by rowHeight - partial last row ignored", () => {
    const width = 20;
    const height = 7; // not divisible by 5
    const data = makeMask(width, height, () => true);
    const result = scanMaskForBoxes(data, width, height);
    // Only row rowY=0 has scanY=2 which is < 7; row rowY=5 has scanY=7 >= 7 so skipped
    expect(result).toHaveLength(1);
  });

  it("flushes a run that reaches the right edge", () => {
    const width = 20;
    const height = TERRAIN_ROW_HEIGHT;
    // Opaque from x=15 to x=19 (inclusive), run of 5
    const data = makeMask(width, height, (x) => x >= 15);
    const result = scanMaskForBoxes(data, width, height);
    expect(result).toHaveLength(1);
    const box = result[0];
    expect(box?.wPx).toBe(5);
    expect(box?.cxPx).toBe(17.5); // 15 + 5/2
  });

  it("boxes have expected cyPx based on rowY", () => {
    const width = 100;
    const height = 10; // two rows: rowY=0, rowY=5
    const data = makeMask(width, height, () => true);
    const result = scanMaskForBoxes(data, width, height);
    const cys = result.map((b) => b.cyPx).sort((a, b) => a - b);
    expect(cys[0]).toBe(TERRAIN_ROW_HEIGHT / 2); // 2.5
    expect(cys[1]).toBe(TERRAIN_ROW_HEIGHT + TERRAIN_ROW_HEIGHT / 2); // 7.5
  });

  it("region yMin snaps down to rowHeight grid", () => {
    const width = 50;
    const height = 20;
    const data = makeMask(width, height, () => true);
    // yMin=3 should snap down to 0 (nearest multiple of 5 <= 3)
    const region = { xMin: 0, xMax: width, yMin: 3, yMax: 10 };
    const result = scanMaskForBoxes(data, width, height, region);
    // Should include rowY=0 (snapped from 3) and rowY=5
    expect(result.some((b: BoxSpec) => b.cyPx === TERRAIN_ROW_HEIGHT / 2)).toBe(true);
  });
});
