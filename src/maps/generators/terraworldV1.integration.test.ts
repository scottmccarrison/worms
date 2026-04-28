import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { terraworldV1Generator } from "./terraworldV1";

function makeCtx(w: number, h: number) {
  const c = createCanvas(w, h);
  return c.getContext("2d") as unknown as CanvasRenderingContext2D;
}

describe("terraworldV1 integration", () => {
  it("default theme: produces a canvas with both opaque and transparent pixels (caves carved)", () => {
    const W = 400;
    const H = 300;
    const ctx = makeCtx(W, H);
    terraworldV1Generator(ctx, W, H, { seed: 42 });
    const data = ctx.getImageData(0, 0, W, H).data;
    let opaque = 0;
    let transparent = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] === 255) opaque++;
      else if (data[i] === 0) transparent++;
    }
    expect(opaque).toBeGreaterThan(0);
    expect(transparent).toBeGreaterThan(0);
  });

  it("canyon theme: middle column has at least one transparent pixel (gap exists)", () => {
    const W = 400;
    const H = 300;
    const ctx = makeCtx(W, H);
    terraworldV1Generator(ctx, W, H, { seed: 42, themeTag: "canyon" });
    const data = ctx.getImageData(0, 0, W, H).data;
    let middleHasTransparent = false;
    for (let y = 0; y < H; y++) {
      const idx = (y * W + Math.floor(W / 2)) * 4 + 3;
      if (data[idx] === 0) {
        middleHasTransparent = true;
        break;
      }
    }
    expect(middleHasTransparent).toBe(true);
  });

  it("determinism: same seed produces byte-identical canvas alpha channel", () => {
    const W = 200;
    const H = 200;
    const c1 = makeCtx(W, H);
    const c2 = makeCtx(W, H);
    terraworldV1Generator(c1, W, H, { seed: 1234 });
    terraworldV1Generator(c2, W, H, { seed: 1234 });
    const d1 = c1.getImageData(0, 0, W, H).data;
    const d2 = c2.getImageData(0, 0, W, H).data;
    for (let i = 3; i < d1.length; i += 4) {
      expect(d1[i]).toBe(d2[i]);
    }
  });

  it("different seeds produce different canvases", () => {
    const W = 200;
    const H = 200;
    const c1 = makeCtx(W, H);
    const c2 = makeCtx(W, H);
    terraworldV1Generator(c1, W, H, { seed: 1 });
    terraworldV1Generator(c2, W, H, { seed: 2 });
    const d1 = c1.getImageData(0, 0, W, H).data;
    const d2 = c2.getImageData(0, 0, W, H).data;
    let differs = false;
    for (let i = 3; i < d1.length; i += 4) {
      if (d1[i] !== d2[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });

  it("different themes at same seed produce different canvases", () => {
    const W = 200;
    const H = 200;
    const cDefault = makeCtx(W, H);
    const cCanyon = makeCtx(W, H);
    terraworldV1Generator(cDefault, W, H, { seed: 99 });
    terraworldV1Generator(cCanyon, W, H, { seed: 99, themeTag: "canyon" });
    const d1 = cDefault.getImageData(0, 0, W, H).data;
    const d2 = cCanyon.getImageData(0, 0, W, H).data;
    let differs = false;
    for (let i = 3; i < d1.length; i += 4) {
      if (d1[i] !== d2[i]) {
        differs = true;
        break;
      }
    }
    expect(differs).toBe(true);
  });
});
