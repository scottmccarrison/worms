import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { MASK_SOLID, createWorld } from "../world";
import { paintSubstrateMaskPass } from "./paintSubstrateMask";

function makeCtx(world: ReturnType<typeof createWorld>, passIndex: number): PassContext {
  return {
    world,
    rng: rngForPass(world.seed, passIndex),
    passIndex,
    tuning,
    resolveParam: (key, fb) => {
      const v = world.theme?.params[key];
      return typeof v === "number" ? v : fb;
    },
  };
}

describe("paintSubstrateMaskPass", () => {
  it("total solid pixels equals sum over columns", () => {
    const widthPx = 8;
    const heightPx = 10;
    const world = createWorld(1, widthPx, heightPx, "default");
    // Pre-populate with varied surface values
    const surfaces = [3, 0, 10, 7, 2, 9, 5, 1];
    for (let x = 0; x < widthPx; x++) {
      world.heightmap[x] = surfaces[x];
    }
    paintSubstrateMaskPass.run(makeCtx(world, 4));

    // Compute expected solid count
    let expected = 0;
    for (let x = 0; x < widthPx; x++) {
      const s = surfaces[x];
      if (s < heightPx) {
        expected += heightPx - s;
      }
    }

    let actual = 0;
    for (let i = 0; i < world.mask.length; i++) {
      if (world.mask[i] === MASK_SOLID) actual++;
    }
    expect(actual).toBe(expected);
  });

  it("void column (surfaceY = heightPx) produces zero solid pixels in that column", () => {
    const widthPx = 3;
    const heightPx = 5;
    const world = createWorld(2, widthPx, heightPx, "default");
    // Middle column is void
    world.heightmap[0] = 2;
    world.heightmap[1] = heightPx; // void
    world.heightmap[2] = 3;
    paintSubstrateMaskPass.run(makeCtx(world, 4));

    // Column 1: all pixels in mask should be air
    for (let y = 0; y < heightPx; y++) {
      expect(world.mask[y * widthPx + 1]).toBe(0);
    }
    // Non-void columns should have solid pixels
    let col0Solid = 0;
    for (let y = 0; y < heightPx; y++) {
      if (world.mask[y * widthPx + 0] === MASK_SOLID) col0Solid++;
    }
    expect(col0Solid).toBe(heightPx - 2);
  });

  it("column with surfaceY = 0 produces full-height column", () => {
    const widthPx = 1;
    const heightPx = 8;
    const world = createWorld(3, widthPx, heightPx, "default");
    world.heightmap[0] = 0;
    paintSubstrateMaskPass.run(makeCtx(world, 4));

    let solidCount = 0;
    for (let y = 0; y < heightPx; y++) {
      if (world.mask[y * widthPx + 0] === MASK_SOLID) solidCount++;
    }
    expect(solidCount).toBe(heightPx);
  });

  it("column with surfaceY = heightPx - 1 produces exactly 1 solid pixel", () => {
    const widthPx = 1;
    const heightPx = 6;
    const world = createWorld(4, widthPx, heightPx, "default");
    world.heightmap[0] = heightPx - 1;
    paintSubstrateMaskPass.run(makeCtx(world, 4));

    let solidCount = 0;
    for (let y = 0; y < heightPx; y++) {
      if (world.mask[y * widthPx + 0] === MASK_SOLID) solidCount++;
    }
    expect(solidCount).toBe(1);
    // The one solid pixel must be at the bottom row
    expect(world.mask[(heightPx - 1) * widthPx + 0]).toBe(MASK_SOLID);
  });

  it("throws on uninitialized heightmap (HEIGHTMAP_UNINIT)", () => {
    const world = createWorld(5, 4, 8, "default");
    // heightmap is filled with HEIGHTMAP_UNINIT by createWorld - leave as-is
    expect(() => paintSubstrateMaskPass.run(makeCtx(world, 4))).toThrow(
      "PaintSubstrateMask: heightmap[0] is uninitialized",
    );
  });

  it("throws on negative surfaceY", () => {
    const world = createWorld(6, 3, 8, "default");
    world.heightmap[0] = 4;
    world.heightmap[1] = -1; // invalid
    world.heightmap[2] = 4;
    expect(() => paintSubstrateMaskPass.run(makeCtx(world, 4))).toThrow(
      "PaintSubstrateMask: heightmap[1] = -1 is out of range",
    );
  });

  it("throws on surfaceY > heightPx", () => {
    const heightPx = 8;
    const world = createWorld(7, 2, heightPx, "default");
    world.heightmap[0] = heightPx + 1; // one past the valid void sentinel
    world.heightmap[1] = 4;
    expect(() => paintSubstrateMaskPass.run(makeCtx(world, 4))).toThrow(
      `PaintSubstrateMask: heightmap[0] = ${heightPx + 1} is out of range`,
    );
  });
});
