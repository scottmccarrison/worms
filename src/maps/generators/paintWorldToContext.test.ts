import { createCanvas } from "canvas";
import { describe, expect, it } from "vitest";
import type { ThemePalette } from "../themes";
import { paintWorldToContext } from "./paintWorldToContext";

function makeCtx(w: number, h: number) {
  const c = createCanvas(w, h);
  return c.getContext("2d") as unknown as CanvasRenderingContext2D;
}

const testPalette: ThemePalette = {
  surface: 0xff0000, // red - CRUST
  mid: 0x00ff00, // green - DIRT
  rock: 0x0000ff, // blue - ROCK
  deep: 0xffff00, // yellow - STONE
};

describe("paintWorldToContext", () => {
  it("paints alpha from mask and RGB from material code via palette", () => {
    // 4x1 world. mask: [1, 1, 1, 1] (all solid). material: [DIRT, ROCK, STONE, CRUST] = [1, 2, 3, 4]
    const ctx = makeCtx(4, 1);
    const mask = new Uint8Array([1, 1, 1, 1]);
    const materialMap = new Uint8Array([1, 2, 3, 4]);
    paintWorldToContext(ctx, mask, materialMap, testPalette, 4, 1);
    const data = ctx.getImageData(0, 0, 4, 1).data;
    // pixel 0: DIRT = green (0x00ff00) + alpha 255
    expect(data[0]).toBe(0x00);
    expect(data[1]).toBe(0xff);
    expect(data[2]).toBe(0x00);
    expect(data[3]).toBe(255);
    // pixel 1: ROCK = blue
    expect(data[4]).toBe(0x00);
    expect(data[5]).toBe(0x00);
    expect(data[6]).toBe(0xff);
    expect(data[7]).toBe(255);
    // pixel 2: STONE = yellow
    expect(data[8]).toBe(0xff);
    expect(data[9]).toBe(0xff);
    expect(data[10]).toBe(0x00);
    expect(data[11]).toBe(255);
    // pixel 3: CRUST = red
    expect(data[12]).toBe(0xff);
    expect(data[13]).toBe(0x00);
    expect(data[14]).toBe(0x00);
    expect(data[15]).toBe(255);
  });

  it("air pixels (mask=0) become fully transparent regardless of material", () => {
    const ctx = makeCtx(2, 1);
    const mask = new Uint8Array([0, 0]);
    const materialMap = new Uint8Array([1, 4]); // DIRT, CRUST - irrelevant
    paintWorldToContext(ctx, mask, materialMap, testPalette, 2, 1);
    const data = ctx.getImageData(0, 0, 2, 1).data;
    expect(data[3]).toBe(0); // pixel 0 alpha
    expect(data[7]).toBe(0); // pixel 1 alpha
    expect(data[0]).toBe(0); // pixel 0 R (default from createImageData)
    expect(data[4]).toBe(0); // pixel 1 R
  });

  it("solid pixel with material=AIR (defensive) renders as palette.mid", () => {
    const ctx = makeCtx(1, 1);
    const mask = new Uint8Array([1]);
    const materialMap = new Uint8Array([0]); // AIR (shouldn't happen but defensive)
    paintWorldToContext(ctx, mask, materialMap, testPalette, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    // Falls back to dirt = palette.mid = green
    expect(data[0]).toBe(0x00);
    expect(data[1]).toBe(0xff);
    expect(data[2]).toBe(0x00);
    expect(data[3]).toBe(255);
  });

  it("solid pixel with unknown material code (defensive) renders as palette.mid", () => {
    const ctx = makeCtx(1, 1);
    const mask = new Uint8Array([1]);
    const materialMap = new Uint8Array([99]); // unknown
    paintWorldToContext(ctx, mask, materialMap, testPalette, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    expect(data[0]).toBe(0x00);
    expect(data[1]).toBe(0xff);
    expect(data[2]).toBe(0x00);
    expect(data[3]).toBe(255);
  });

  it("throws when mask length does not match widthPx * heightPx", () => {
    const ctx = makeCtx(2, 2);
    const wrong = new Uint8Array(3); // 3 != 4
    const materialMap = new Uint8Array(4);
    expect(() => paintWorldToContext(ctx, wrong, materialMap, testPalette, 2, 2)).toThrow(
      /mask.length/,
    );
  });

  it("throws when materialMap length does not match widthPx * heightPx", () => {
    const ctx = makeCtx(2, 2);
    const mask = new Uint8Array(4);
    const wrongMaterial = new Uint8Array(3);
    expect(() => paintWorldToContext(ctx, mask, wrongMaterial, testPalette, 2, 2)).toThrow(
      /materialMap.length/,
    );
  });
});
