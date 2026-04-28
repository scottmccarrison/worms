import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { getTheme } from "../themes";
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

  it("default theme: opaque pixels have RGB matching the theme palette or known decoration colors", () => {
    const W = 400;
    const H = 300;
    const ctx = makeCtx(W, H);
    terraworldV1Generator(ctx, W, H, { seed: 42 });
    const data = ctx.getImageData(0, 0, W, H).data;
    const palette = getTheme("default").palette;
    // Palette colors (from substrate + crust passes)
    const paletteColors = [palette.surface, palette.mid, palette.rock, palette.deep].map((hex) => ({
      r: (hex >> 16) & 0xff,
      g: (hex >> 8) & 0xff,
      b: hex & 0xff,
    }));
    // Decoration colors emitted by paintDecorationToContext on the default theme.
    // Default theme has wantsCaveAmbient=false and wantsSurfaceDressing=true with sprite=grass_tuft.
    const decorationColors = [{ r: 0x3a, g: 0x8a, b: 0x3a }];
    const allowedColors = [...paletteColors, ...decorationColors];
    let matched = 0;
    let sampled = 0;
    for (let i = 0; i < data.length && sampled < 100; i += 4) {
      if (data[i + 3] !== 255) continue;
      sampled++;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (allowedColors.some((c) => c.r === r && c.g === g && c.b === b)) matched++;
    }
    expect(sampled).toBeGreaterThan(0);
    expect(matched).toBe(sampled);
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

  it("snow theme: canvas contains at least one frost ambient pixel (#caf0ff)", () => {
    // Larger canvas: at 400x300 the carved caves fall below the FinalizeMask
    // hygiene threshold (1024px) and get stripped, leaving no AIR below the
    // surface for PlaceCaveAmbient to land in. 800x600 produces a stable
    // cave area where ambient features land.
    const W = 800;
    const H = 600;
    const ctx = makeCtx(W, H);
    terraworldV1Generator(ctx, W, H, { seed: 42, themeTag: "snow" });
    const data = ctx.getImageData(0, 0, W, H).data;
    let frostHits = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 0xca && data[i + 1] === 0xf0 && data[i + 2] === 0xff) frostHits++;
    }
    expect(frostHits).toBeGreaterThan(0);
  });

  it("default theme: canvas contains at least one grass_tuft dressing pixel (#3a8a3a)", () => {
    const W = 400;
    const H = 300;
    const ctx = makeCtx(W, H);
    terraworldV1Generator(ctx, W, H, { seed: 42 });
    const data = ctx.getImageData(0, 0, W, H).data;
    let grassHits = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] === 0x3a && data[i + 1] === 0x8a && data[i + 2] === 0x3a) grassHits++;
    }
    expect(grassHits).toBeGreaterThan(0);
  });
});
