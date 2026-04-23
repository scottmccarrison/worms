import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { findSpawnPoints } from "../worm/spawnPoints";
import { bridgesGenerator } from "./generators/bridges";
import { canyonBiomeGenerator } from "./generators/canyonBiome";
import { canyonLegacyGenerator } from "./generators/canyonLegacy";
import { caveGenerator } from "./generators/cave";
import { flatGenerator } from "./generators/flat";
import { hillsGenerator } from "./generators/hills";
import { islandGenerator } from "./generators/island";
import { plateauGenerator } from "./generators/plateau";
import { spireGenerator } from "./generators/spire";
import { terraworldGenerator } from "./generators/terraworld";

const W = 1280;
const H = 720;
const FIXED_SEED = 42;

function countOpaquePixels(ctx: ReturnType<typeof createCanvas.prototype.getContext>): number {
  const data = ctx.getImageData(0, 0, W, H).data;
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) count++;
  }
  return count;
}

function totalPixels(): number {
  return W * H;
}

describe("flatGenerator", () => {
  it("produces some opaque pixels (terrain drawn)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    flatGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeGreaterThan(0);
  });

  it("does not fill all pixels (sky exists above terrain)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    flatGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeLessThan(totalPixels());
  });

  it("is deterministic with same seed (sample row check)", () => {
    const c1 = createCanvas(W, H);
    const c2 = createCanvas(W, H);
    flatGenerator(c1.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, {
      seed: FIXED_SEED,
    });
    flatGenerator(c2.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, {
      seed: FIXED_SEED,
    });
    // Compare alpha channel of row at y=600 (well below groundY=~504, inside terrain)
    // NOTE: y=500 was sky (groundY = height*0.7 = ~504), making the test trivially pass.
    const d1 = c1.getContext("2d").getImageData(0, 600, W, 1).data;
    const d2 = c2.getContext("2d").getImageData(0, 600, W, 1).data;
    expect(Array.from(d1)).toEqual(Array.from(d2));
  });
});

describe("hillsGenerator", () => {
  it("produces some opaque pixels (terrain drawn)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    hillsGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeGreaterThan(0);
  });

  it("does not fill all pixels (sky exists)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    hillsGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeLessThan(totalPixels());
  });

  it("is deterministic with same seed (sample row check)", () => {
    const c1 = createCanvas(W, H);
    const c2 = createCanvas(W, H);
    hillsGenerator(c1.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, {
      seed: FIXED_SEED,
    });
    hillsGenerator(c2.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, {
      seed: FIXED_SEED,
    });
    // Compare alpha channel of row at y=550 (should be inside terrain for hills)
    const d1 = c1.getContext("2d").getImageData(0, 550, W, 1).data;
    const d2 = c2.getContext("2d").getImageData(0, 550, W, 1).data;
    expect(Array.from(d1)).toEqual(Array.from(d2));
  });
});

describe("caveGenerator", () => {
  it("produces some opaque pixels (terrain drawn)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    caveGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeGreaterThan(0);
  });

  it("does not fill all pixels (open cave interior exists)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    caveGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeLessThan(totalPixels());
  });
});

describe("islandGenerator", () => {
  it("produces some opaque pixels (terrain drawn)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    islandGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeGreaterThan(0);
  });

  it("does not fill all pixels (void gaps on edges)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    islandGenerator(ctx, W, H, { seed: FIXED_SEED });
    const opaqueCount = countOpaquePixels(canvas.getContext("2d"));
    expect(opaqueCount).toBeLessThan(totalPixels());
  });

  it("predefined spawn points land on or near terrain (within 40px tolerance)", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    islandGenerator(ctx, W, H, { seed: FIXED_SEED });
    const imgData = canvas.getContext("2d").getImageData(0, 0, W, H).data;

    // Island predefined spawn points from registry
    const spawnPoints = [
      { xPx: 384, yPx: 380 },
      { xPx: 896, yPx: 380 },
      { xPx: 512, yPx: 380 },
      { xPx: 768, yPx: 380 },
    ];

    for (const pt of spawnPoints) {
      // Check if there is terrain within 40px below the spawn point
      let foundTerrain = false;
      for (let dy = -10; dy <= 40; dy++) {
        const row = pt.yPx + dy;
        if (row < 0 || row >= H) continue;
        const col = pt.xPx;
        const alpha = imgData[(row * W + col) * 4 + 3] ?? 0;
        if (alpha > 0) {
          foundTerrain = true;
          break;
        }
      }
      expect(foundTerrain).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Helper: render a generator into a fresh canvas and return the full pixel
// data buffer (Uint8ClampedArray, RGBA interleaved).
// ---------------------------------------------------------------------------
function renderPixels(
  gen: (ctx: CanvasRenderingContext2D, w: number, h: number, opts: { seed: number }) => void,
  seed: number,
): Uint8ClampedArray {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  gen(ctx, W, H, { seed });
  return canvas.getContext("2d").getImageData(0, 0, W, H).data;
}

function countSolidPixels(data: Uint8ClampedArray): number {
  let count = 0;
  for (let i = 3; i < data.length; i += 4) {
    if ((data[i] ?? 0) > 0) count++;
  }
  return count;
}

describe("bridgesGenerator", () => {
  it("bridges generator is deterministic given a seed", () => {
    const a = renderPixels(bridgesGenerator, 1);
    const b = renderPixels(bridgesGenerator, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("bridges produces substantial solid terrain", () => {
    const data = renderPixels(bridgesGenerator, 1);
    const solid = countSolidPixels(data);
    expect(solid / (W * H)).toBeGreaterThan(0.1);
  });

  it("bridges yields 4 valid spawn points on solid surface", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    bridgesGenerator(ctx, W, H, { seed: 1 });
    const imgData = canvas.getContext("2d").getImageData(0, 0, W, H);
    const spawnPoints = findSpawnPoints(imgData.data, W, H, 4);
    expect(spawnPoints.length).toBe(4);
    const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
    expect(ids.size).toBe(4);
    for (const { xPx, yPx } of spawnPoints) {
      // yPx itself is solid (that is what findSpawnPoints returns)
      const selfAlpha = imgData.data[(yPx * W + xPx) * 4 + 3] ?? 0;
      expect(selfAlpha).toBeGreaterThan(0);
      // Check 3px above to clear any anti-aliased edge fringe; should be clean air.
      const clearAboveAlpha = yPx >= 3 ? (imgData.data[((yPx - 3) * W + xPx) * 4 + 3] ?? 0) : 255;
      expect(clearAboveAlpha).toBe(0);
    }
  });
});

describe("spireGenerator", () => {
  it("spire generator is deterministic given a seed", () => {
    const a = renderPixels(spireGenerator, 1);
    const b = renderPixels(spireGenerator, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("spire produces substantial solid terrain", () => {
    const data = renderPixels(spireGenerator, 1);
    const solid = countSolidPixels(data);
    expect(solid / (W * H)).toBeGreaterThan(0.1);
  });

  it("spire yields 4 valid spawn points on solid surface", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    spireGenerator(ctx, W, H, { seed: 1 });
    const imgData = canvas.getContext("2d").getImageData(0, 0, W, H);
    const spawnPoints = findSpawnPoints(imgData.data, W, H, 4);
    expect(spawnPoints.length).toBe(4);
    const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
    expect(ids.size).toBe(4);
    for (const { xPx, yPx } of spawnPoints) {
      const selfAlpha = imgData.data[(yPx * W + xPx) * 4 + 3] ?? 0;
      expect(selfAlpha).toBeGreaterThan(0);
      // Check 3px above to clear any anti-aliased edge fringe; should be clean air.
      const clearAboveAlpha = yPx >= 3 ? (imgData.data[((yPx - 3) * W + xPx) * 4 + 3] ?? 0) : 255;
      expect(clearAboveAlpha).toBe(0);
    }
  });
});

describe("canyonLegacyGenerator", () => {
  it("canyon generator is deterministic given a seed", () => {
    const a = renderPixels(canyonLegacyGenerator, 1);
    const b = renderPixels(canyonLegacyGenerator, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("canyon produces substantial solid terrain", () => {
    const data = renderPixels(canyonLegacyGenerator, 1);
    const solid = countSolidPixels(data);
    expect(solid / (W * H)).toBeGreaterThan(0.1);
  });

  it("canyon yields 4 valid spawn points on solid surface", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    canyonLegacyGenerator(ctx, W, H, { seed: 1 });
    const imgData = canvas.getContext("2d").getImageData(0, 0, W, H);
    const spawnPoints = findSpawnPoints(imgData.data, W, H, 4);
    expect(spawnPoints.length).toBe(4);
    const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
    expect(ids.size).toBe(4);
    for (const { xPx, yPx } of spawnPoints) {
      const selfAlpha = imgData.data[(yPx * W + xPx) * 4 + 3] ?? 0;
      expect(selfAlpha).toBeGreaterThan(0);
      // Check 3px above to clear any anti-aliased edge fringe; should be clean air.
      const clearAboveAlpha = yPx >= 3 ? (imgData.data[((yPx - 3) * W + xPx) * 4 + 3] ?? 0) : 255;
      expect(clearAboveAlpha).toBe(0);
    }
  });
});

describe("plateauGenerator", () => {
  it("plateau generator is deterministic given a seed", () => {
    const a = renderPixels(plateauGenerator, 1);
    const b = renderPixels(plateauGenerator, 1);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("plateau produces substantial solid terrain", () => {
    const data = renderPixels(plateauGenerator, 1);
    const solid = countSolidPixels(data);
    expect(solid / (W * H)).toBeGreaterThan(0.1);
  });

  it("plateau yields 4 valid spawn points on solid surface", () => {
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    plateauGenerator(ctx, W, H, { seed: 1 });
    const imgData = canvas.getContext("2d").getImageData(0, 0, W, H);
    const spawnPoints = findSpawnPoints(imgData.data, W, H, 4);
    expect(spawnPoints.length).toBe(4);
    const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
    expect(ids.size).toBe(4);
    for (const { xPx, yPx } of spawnPoints) {
      const selfAlpha = imgData.data[(yPx * W + xPx) * 4 + 3] ?? 0;
      expect(selfAlpha).toBeGreaterThan(0);
      // Check 3px above to clear any anti-aliased edge fringe; should be clean air.
      const clearAboveAlpha = yPx >= 3 ? (imgData.data[((yPx - 3) * W + xPx) * 4 + 3] ?? 0) : 255;
      expect(clearAboveAlpha).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Terraworld generator (2560x1024 - the Phase 1 world size)
// ---------------------------------------------------------------------------
const TW = 2560;
const TH = 1024;

function renderTerraworldPixels(seed: number): Uint8ClampedArray {
  const canvas = createCanvas(TW, TH);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  terraworldGenerator(ctx, TW, TH, { seed });
  return canvas.getContext("2d").getImageData(0, 0, TW, TH).data;
}

describe("terraworldGenerator", () => {
  it("terraworld generator is deterministic given a seed (2560x1024)", { timeout: 15000 }, () => {
    const a = renderTerraworldPixels(42);
    const b = renderTerraworldPixels(42);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("terraworld has solid ratio between 20% and 60%", () => {
    const data = renderTerraworldPixels(42);
    const solid = countSolidPixels(data);
    const ratio = solid / (TW * TH);
    expect(ratio).toBeGreaterThan(0.2);
    expect(ratio).toBeLessThan(0.6);
  });

  it("terraworld yields 4 valid spawn points on solid surface", () => {
    const canvas = createCanvas(TW, TH);
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    terraworldGenerator(ctx, TW, TH, { seed: 1 });
    const imgData = canvas.getContext("2d").getImageData(0, 0, TW, TH);
    const spawnPoints = findSpawnPoints(imgData.data, TW, TH, 4);
    expect(spawnPoints.length).toBe(4);
    const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
    expect(ids.size).toBe(4);
    for (const { xPx, yPx } of spawnPoints) {
      const selfAlpha = imgData.data[(yPx * TW + xPx) * 4 + 3] ?? 0;
      expect(selfAlpha).toBeGreaterThan(0);
    }
  });

  it("terraworld surface reads as rolling hills (neighbor-Y delta < 30px)", () => {
    const data = renderTerraworldPixels(42);
    // For each x, find the first solid pixel (surface Y) by scanning top-down
    const surfaceYs: number[] = [];
    for (let x = 0; x < TW; x++) {
      let surfaceY = TH; // default: no terrain found
      for (let y = 0; y < TH; y++) {
        const alpha = data[(y * TW + x) * 4 + 3] ?? 0;
        if (alpha > 0) {
          surfaceY = y;
          break;
        }
      }
      surfaceYs.push(surfaceY);
    }
    // Measure max neighbor delta across the width
    let maxDelta = 0;
    for (let x = 0; x < TW - 1; x++) {
      const delta = Math.abs((surfaceYs[x] ?? TH) - (surfaceYs[x + 1] ?? TH));
      if (delta > maxDelta) maxDelta = delta;
    }
    expect(maxDelta).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Canyon biome generator (procgen, 2560x1024)
// ---------------------------------------------------------------------------

function renderCanyonBiomePixels(width: number, height: number, seed: number): Uint8ClampedArray {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
  canyonBiomeGenerator(ctx, width, height, { seed });
  return canvas.getContext("2d").getImageData(0, 0, width, height).data;
}

describe("canyonBiomeGenerator", () => {
  it("canyon biome generator is deterministic given a seed (640x256)", () => {
    const W2 = 640;
    const H2 = 256;
    const a = renderCanyonBiomePixels(W2, H2, 42);
    const b = renderCanyonBiomePixels(W2, H2, 42);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("canyon biome has solid ratio between 0.1 and 0.5 (2560x1024)", () => {
    const data = renderCanyonBiomePixels(TW, TH, 42);
    const solid = countSolidPixels(data);
    const ratio = solid / (TW * TH);
    expect(ratio).toBeGreaterThan(0.1);
    expect(ratio).toBeLessThan(0.5);
  });

  it("canyon biome yields 4 valid spawn points on solid surface (2560x1024)", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const canvas = createCanvas(TW, TH);
      const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
      canyonBiomeGenerator(ctx, TW, TH, { seed });
      const imgData = canvas.getContext("2d").getImageData(0, 0, TW, TH);
      const spawnPoints = findSpawnPoints(imgData.data, TW, TH, 4);
      expect(spawnPoints.length).toBe(4);
      const ids = new Set(spawnPoints.map((s) => `${s.xPx},${s.yPx}`));
      expect(ids.size).toBe(4);
      for (const { xPx, yPx } of spawnPoints) {
        const selfAlpha = imgData.data[(yPx * TW + xPx) * 4 + 3] ?? 0;
        expect(selfAlpha).toBeGreaterThan(0);
        // Check 3px above - should be clear air above the surface
        const clearAboveAlpha =
          yPx >= 3 ? (imgData.data[((yPx - 3) * TW + xPx) * 4 + 3] ?? 0) : 255;
        expect(clearAboveAlpha).toBe(0);
      }
    }
  });
});
