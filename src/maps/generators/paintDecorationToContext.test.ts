import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import { ALPHA_SOLID } from "../../terrain/terrainAlgorithm";
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

/**
 * Painted decoration uses globalAlpha < 1 so it stays visually solid but is
 * below ALPHA_SOLID for terrain body building. These helpers express that
 * contract without locking the tests to exact canvas alpha-blend rounding,
 * which varies subtly between node-canvas and browsers.
 */
function expectDecorationAt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  expectedRgb: [number, number, number],
): void {
  const [r, g, b, a] = px(ctx, x, y);
  // Color is recognizable - within 2 LSB of expected after alpha pre/un-multiply round-trip.
  expect(Math.abs(r - expectedRgb[0])).toBeLessThanOrEqual(2);
  expect(Math.abs(g - expectedRgb[1])).toBeLessThanOrEqual(2);
  expect(Math.abs(b - expectedRgb[2])).toBeLessThanOrEqual(2);
  // Crucial invariant: alpha is below ALPHA_SOLID so terrain body builder skips it.
  expect(a).toBeGreaterThan(0);
  expect(a).toBeLessThan(ALPHA_SOLID);
}

function expectUntouched(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  expect(px(ctx, x, y)).toEqual([0, 0, 0, 0]);
}

describe("paintDecorationToContext", () => {
  it("single ambient frost feature paints recognizably blue-white over a 2x2 area", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [{ xPx: 10, yPx: 20, type: "frost" }], []);
    // #caf0ff ~ RGB(202, 240, 255)
    expectDecorationAt(ctx, 10, 20, [202, 240, 255]);
    expectDecorationAt(ctx, 11, 20, [202, 240, 255]);
    expectDecorationAt(ctx, 10, 21, [202, 240, 255]);
    expectDecorationAt(ctx, 11, 21, [202, 240, 255]);
  });

  it("single dressing grass_tuft feature paints green over fillRect(10, 18, 2, 3)", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [], [{ xPx: 10, yPx: 20, sprite: "grass_tuft" }]);
    // fillRect(10, 20-2, 2, 3) = fillRect(10, 18, 2, 3) -> rows 18, 19, 20; cols 10, 11
    // #3a8a3a ~ RGB(58, 138, 58)
    expectDecorationAt(ctx, 10, 18, [58, 138, 58]);
    expectDecorationAt(ctx, 11, 18, [58, 138, 58]);
    expectDecorationAt(ctx, 10, 19, [58, 138, 58]);
    expectDecorationAt(ctx, 11, 19, [58, 138, 58]);
    expectDecorationAt(ctx, 10, 20, [58, 138, 58]);
    expectDecorationAt(ctx, 11, 20, [58, 138, 58]);
  });

  it("unknown ambient type is silently skipped; canvas remains untouched", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [{ xPx: 5, yPx: 5, type: "nope" }], []);
    expectUntouched(ctx, 5, 5);
    expectUntouched(ctx, 6, 5);
    expectUntouched(ctx, 5, 6);
    expectUntouched(ctx, 6, 6);
  });

  it("unknown dressing sprite is silently skipped; canvas remains untouched", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(ctx, [], [{ xPx: 5, yPx: 10, sprite: "nope" }]);
    expectUntouched(ctx, 5, 8);
    expectUntouched(ctx, 5, 9);
    expectUntouched(ctx, 5, 10);
  });

  it("empty arrays produce no canvas changes", () => {
    const ctx = makeCtx(16, 16);
    paintDecorationToContext(ctx, [], []);
    expectUntouched(ctx, 0, 0);
    expectUntouched(ctx, 8, 8);
    expectUntouched(ctx, 15, 15);
  });

  it("mixed valid + invalid entries: valid ones paint, invalid are skipped", () => {
    const ctx = makeCtx(32, 32);
    paintDecorationToContext(
      ctx,
      [
        { xPx: 2, yPx: 2, type: "moss" }, // valid - moss is #2a5a1a ~ RGB(42, 90, 26)
        { xPx: 10, yPx: 2, type: "unknown" }, // invalid -> skipped
      ],
      [
        { xPx: 2, yPx: 15, sprite: "ash_pile" }, // valid - ash_pile is #1a1a1a ~ RGB(26, 26, 26)
        { xPx: 10, yPx: 15, sprite: "bad_sprite" }, // invalid -> skipped
      ],
    );

    expectDecorationAt(ctx, 2, 2, [42, 90, 26]);
    expectDecorationAt(ctx, 3, 2, [42, 90, 26]);
    expectDecorationAt(ctx, 2, 3, [42, 90, 26]);
    expectDecorationAt(ctx, 3, 3, [42, 90, 26]);

    expectUntouched(ctx, 10, 2);

    // ash_pile fillRect(2, 13, 2, 3) -> rows 13,14,15
    expectDecorationAt(ctx, 2, 13, [26, 26, 26]);
    expectDecorationAt(ctx, 2, 14, [26, 26, 26]);
    expectDecorationAt(ctx, 2, 15, [26, 26, 26]);

    expectUntouched(ctx, 10, 13);
    expectUntouched(ctx, 10, 15);
  });

  it("restores ctx.globalAlpha after painting", () => {
    const ctx = makeCtx(8, 8);
    ctx.globalAlpha = 0.5;
    paintDecorationToContext(ctx, [{ xPx: 1, yPx: 1, type: "moss" }], []);
    expect(ctx.globalAlpha).toBe(0.5);
  });
});
