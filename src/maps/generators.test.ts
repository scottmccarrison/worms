import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { flatGenerator } from "./generators/flat";
import { hillsGenerator } from "./generators/hills";
import { islandGenerator } from "./generators/island";

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
    flatGenerator(c1.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, { seed: FIXED_SEED });
    flatGenerator(c2.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, { seed: FIXED_SEED });
    // Compare alpha channel of row at y=500 (should be inside terrain)
    const d1 = c1.getContext("2d").getImageData(0, 500, W, 1).data;
    const d2 = c2.getContext("2d").getImageData(0, 500, W, 1).data;
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
    hillsGenerator(c1.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, { seed: FIXED_SEED });
    hillsGenerator(c2.getContext("2d") as unknown as CanvasRenderingContext2D, W, H, { seed: FIXED_SEED });
    // Compare alpha channel of row at y=550 (should be inside terrain for hills)
    const d1 = c1.getContext("2d").getImageData(0, 550, W, 1).data;
    const d2 = c2.getContext("2d").getImageData(0, 550, W, 1).data;
    expect(Array.from(d1)).toEqual(Array.from(d2));
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
