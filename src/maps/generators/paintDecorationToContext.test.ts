import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { paintDecorationToContext } from "./paintDecorationToContext";

function makeCtx(w: number, h: number) {
  const c = createCanvas(w, h);
  return c.getContext("2d") as unknown as CanvasRenderingContext2D;
}

/** Read a single pixel as [R, G, B, A]. */
function px(ctx: CanvasRenderingContext2D, x: number, y: number): [number, number, number, number] {
  const d = ctx.getImageData(x, y, 1, 1).data;
  return [d[0], d[1], d[2], d[3]];
}

describe("paintDecorationToContext", () => {
  it("single ambient frost feature paints #caf0ff over a 2x2 area", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [{ xPx: 10, yPx: 20, type: "frost" }], []);
    // #caf0ff = RGB(202, 240, 255)
    expect(px(ctx, 10, 20)).toEqual([202, 240, 255, 255]);
    expect(px(ctx, 11, 20)).toEqual([202, 240, 255, 255]);
    expect(px(ctx, 10, 21)).toEqual([202, 240, 255, 255]);
    expect(px(ctx, 11, 21)).toEqual([202, 240, 255, 255]);
  });

  it("single dressing grass_tuft feature paints #3a8a3a over fillRect(10, 18, 2, 3)", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [], [{ xPx: 10, yPx: 20, sprite: "grass_tuft" }]);
    // fillRect(10, 20-2, 2, 3) = fillRect(10, 18, 2, 3) -> rows 18, 19, 20; cols 10, 11
    // #3a8a3a = RGB(58, 138, 58)
    expect(px(ctx, 10, 18)).toEqual([58, 138, 58, 255]);
    expect(px(ctx, 11, 18)).toEqual([58, 138, 58, 255]);
    expect(px(ctx, 10, 19)).toEqual([58, 138, 58, 255]);
    expect(px(ctx, 11, 19)).toEqual([58, 138, 58, 255]);
    expect(px(ctx, 10, 20)).toEqual([58, 138, 58, 255]);
    expect(px(ctx, 11, 20)).toEqual([58, 138, 58, 255]);
  });

  it("unknown ambient type is silently skipped; canvas remains untouched", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [{ xPx: 5, yPx: 5, type: "nope" }], []);
    // All pixels should remain at their default (transparent black)
    expect(px(ctx, 5, 5)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 6, 5)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 5, 6)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 6, 6)).toEqual([0, 0, 0, 0]);
  });

  it("unknown dressing sprite is silently skipped; canvas remains untouched", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [], [{ xPx: 5, yPx: 10, sprite: "nope" }]);
    expect(px(ctx, 5, 8)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 5, 9)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 5, 10)).toEqual([0, 0, 0, 0]);
  });

  it("empty arrays produce no canvas changes", () => {
    const ctx = makeCtx(16, 16);
    paintDecorationToContext(ctx, [], []);
    // Spot-check several pixels; all should be default transparent black
    expect(px(ctx, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 8, 8)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 15, 15)).toEqual([0, 0, 0, 0]);
  });

  it("mixed valid + invalid entries: valid ones paint, invalid are skipped", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(
      ctx,
      [
        { xPx: 2, yPx: 2, type: "moss" }, // valid  -> #2a5a1a = RGB(42, 90, 26)
        { xPx: 10, yPx: 2, type: "unknown" }, // invalid -> skipped
      ],
      [
        { xPx: 2, yPx: 15, sprite: "ash_pile" }, // valid  -> #1a1a1a = RGB(26, 26, 26)
        { xPx: 10, yPx: 15, sprite: "bad_sprite" }, // invalid -> skipped
      ],
    );

    // Valid ambient: moss at (2,2) 2x2 -> #2a5a1a = RGB(42, 90, 26)
    expect(px(ctx, 2, 2)).toEqual([42, 90, 26, 255]);
    expect(px(ctx, 3, 2)).toEqual([42, 90, 26, 255]);
    expect(px(ctx, 2, 3)).toEqual([42, 90, 26, 255]);
    expect(px(ctx, 3, 3)).toEqual([42, 90, 26, 255]);

    // Invalid ambient: location untouched
    expect(px(ctx, 10, 2)).toEqual([0, 0, 0, 0]);

    // Valid dressing: ash_pile at sprite=(2,15) -> fillRect(2, 13, 2, 3) -> rows 13,14,15
    // #1a1a1a = RGB(26, 26, 26)
    expect(px(ctx, 2, 13)).toEqual([26, 26, 26, 255]);
    expect(px(ctx, 2, 14)).toEqual([26, 26, 26, 255]);
    expect(px(ctx, 2, 15)).toEqual([26, 26, 26, 255]);

    // Invalid dressing: location untouched
    expect(px(ctx, 10, 13)).toEqual([0, 0, 0, 0]);
    expect(px(ctx, 10, 15)).toEqual([0, 0, 0, 0]);
  });
});
