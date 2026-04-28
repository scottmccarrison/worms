import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { paintMaskToContext } from "./paintMaskToContext";

function makeCtx(w: number, h: number): CanvasRenderingContext2D {
  const c = createCanvas(w, h);
  return c.getContext("2d") as unknown as CanvasRenderingContext2D;
}

describe("paintMaskToContext", () => {
  it("paints solid bytes as opaque white pixels and air bytes as transparent", () => {
    const ctx = makeCtx(2, 2);
    // mask layout (row-major): [solid, air, air, solid]
    const mask = new Uint8Array([1, 0, 0, 1]);
    paintMaskToContext(ctx, mask, 2, 2);
    const data = ctx.getImageData(0, 0, 2, 2).data;
    // pixel 0 (top-left): solid -> RGB=255, alpha=255
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
    expect(data[3]).toBe(255);
    // pixel 1 (top-right): air -> alpha=0
    expect(data[7]).toBe(0);
    // pixel 2 (bottom-left): air -> alpha=0
    expect(data[11]).toBe(0);
    // pixel 3 (bottom-right): solid -> alpha=255
    expect(data[15]).toBe(255);
  });

  it("all-zero mask produces fully transparent canvas", () => {
    const ctx = makeCtx(4, 3);
    const mask = new Uint8Array(4 * 3); // zero-filled
    paintMaskToContext(ctx, mask, 4, 3);
    const data = ctx.getImageData(0, 0, 4, 3).data;
    for (let i = 3; i < data.length; i += 4) {
      expect(data[i]).toBe(0);
    }
  });

  it("all-one mask produces fully opaque white canvas", () => {
    const ctx = makeCtx(4, 3);
    const mask = new Uint8Array(4 * 3);
    mask.fill(1);
    paintMaskToContext(ctx, mask, 4, 3);
    const data = ctx.getImageData(0, 0, 4, 3).data;
    for (let i = 0; i < data.length; i += 4) {
      expect(data[i]).toBe(255);
      expect(data[i + 1]).toBe(255);
      expect(data[i + 2]).toBe(255);
      expect(data[i + 3]).toBe(255);
    }
  });

  it("throws when mask length does not match widthPx * heightPx", () => {
    const ctx = makeCtx(4, 3);
    const wrong = new Uint8Array(10); // 10 != 12
    expect(() => paintMaskToContext(ctx, wrong, 4, 3)).toThrow(/mask.length/);
  });

  it("treats non-1 non-0 byte values as air (only mask[i] === 1 is solid)", () => {
    const ctx = makeCtx(2, 1);
    const mask = new Uint8Array([1, 2]); // 1 = solid; 2 = anything else (treated as air)
    paintMaskToContext(ctx, mask, 2, 1);
    const data = ctx.getImageData(0, 0, 2, 1).data;
    expect(data[3]).toBe(255); // solid
    expect(data[7]).toBe(0); // not strictly === 1, so treated as air
  });
});
