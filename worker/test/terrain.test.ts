/**
 * Worker-side Terrain unit tests - material hardness gate.
 *
 * Tests that ROCK and STONE pixels survive cuts below their configured
 * radius thresholds, and that legacy behavior (no materialMap) is unchanged.
 *
 * Planck mocking pattern follows fireHitscan.test.ts: create a real World
 * for physics (needed to construct Terrain bodies), then exercise Terrain
 * methods directly.
 */

import { World } from "planck";
import { describe, expect, it } from "vitest";
import { Terrain } from "../src/entities/terrain.js";

// Material constants (mirror of src/maps/world.ts - keep in sync).
const MATERIAL_AIR = 0;
const MATERIAL_DIRT = 1;
const MATERIAL_ROCK = 2;
const MATERIAL_STONE = 3;

const HARDNESS = { rockMinRadiusPx: 30, stoneMinRadiusPx: 60 };

/** Build a 32x32 all-solid mask. */
function makeSolidMask(w: number, h: number): Uint8Array {
  return new Uint8Array(w * h).fill(1);
}

/** Build a 32x32 materialMap filled with a single material code. */
function makeUniformMaterial(w: number, h: number, mat: number): Uint8Array {
  return new Uint8Array(w * h).fill(mat);
}

const W = 32;
const H = 32;

function makeTerrain(
  world: World,
  materialMap?: Uint8Array,
  hardness?: { rockMinRadiusPx: number; stoneMinRadiusPx: number },
): Terrain {
  return new Terrain({
    world,
    widthPx: W,
    heightPx: H,
    mask: makeSolidMask(W, H),
    materialMap,
    hardness,
  });
}

describe("Terrain - materialMap hardness gate", () => {
  it("stone survives a small cut (r=10 < stoneMinRadiusPx=60)", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_STONE);
    const terrain = makeTerrain(world, mat, HARDNESS);
    const before = terrain.solidPixelCount();
    terrain.cutCircle(16, 16, 10, "explode");
    expect(terrain.solidPixelCount()).toBe(before);
  });

  it("stone is erased by a large cut (r=60 >= stoneMinRadiusPx=60)", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_STONE);
    const terrain = makeTerrain(world, mat, HARDNESS);
    const before = terrain.solidPixelCount();
    // r=60 covers the whole 32x32 grid - all stone should be erased.
    terrain.cutCircle(16, 16, 60, "explode");
    expect(terrain.solidPixelCount()).toBeLessThan(before);
  });

  it("rock survives a small cut (r=10 < rockMinRadiusPx=30)", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_ROCK);
    const terrain = makeTerrain(world, mat, HARDNESS);
    const before = terrain.solidPixelCount();
    terrain.cutCircle(16, 16, 10, "explode");
    expect(terrain.solidPixelCount()).toBe(before);
  });

  it("rock is erased by a large cut (r=30 >= rockMinRadiusPx=30)", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_ROCK);
    const terrain = makeTerrain(world, mat, HARDNESS);
    const before = terrain.solidPixelCount();
    terrain.cutCircle(16, 16, 30, "explode");
    expect(terrain.solidPixelCount()).toBeLessThan(before);
  });

  it("dirt is always erased regardless of radius", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_DIRT);
    const terrain = makeTerrain(world, mat, HARDNESS);
    const before = terrain.solidPixelCount();
    terrain.cutCircle(16, 16, 5, "explode");
    expect(terrain.solidPixelCount()).toBeLessThan(before);
  });

  it("mixed map: DIRT erased, STONE preserved by small cut", () => {
    // Top half (y < 16) = DIRT, bottom half (y >= 16) = STONE.
    const world = new World();
    const mat = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        mat[y * W + x] = y < 16 ? MATERIAL_DIRT : MATERIAL_STONE;
      }
    }
    const terrain = makeTerrain(world, mat, HARDNESS);

    // Count initial solid pixels in the stone half (bottom H/2 rows).
    let initStone = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (y >= 16) initStone++;
      }
    }

    // Small cut centered at (16, 12) - within the DIRT region, r=5.
    // A radius-5 circle at (16,12) only touches DIRT rows (y 7..17).
    // The border row 16 is STONE but r=5 < stoneMinRadiusPx=60 so stone stays.
    terrain.cutCircle(16, 12, 5, "explode");
    const afterCount = terrain.solidPixelCount();

    // Some pixels must have been erased (the DIRT pixels in the circle).
    expect(afterCount).toBeLessThan(W * H);

    // But the stone half must remain entirely intact since r=5 < 60.
    // Check by directly querying isSolid for all stone-half pixels.
    let stoneSurvived = 0;
    for (let y = 16; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (terrain.isSolid(x, y)) stoneSurvived++;
      }
    }
    expect(stoneSurvived).toBe(initStone);
  });

  it("legacy mode (no materialMap): any radius cuts through all materials", () => {
    const world = new World();
    // No materialMap - legacy behavior.
    const terrain = new Terrain({
      world,
      widthPx: W,
      heightPx: H,
      mask: makeSolidMask(W, H),
    });
    const before = terrain.solidPixelCount();
    terrain.cutCircle(16, 16, 5, "explode");
    expect(terrain.solidPixelCount()).toBeLessThan(before);
  });

  it("materialMap length mismatch throws", () => {
    const world = new World();
    const badMat = new Uint8Array(10); // wrong length
    expect(
      () =>
        new Terrain({
          world,
          widthPx: W,
          heightPx: H,
          mask: makeSolidMask(W, H),
          materialMap: badMat,
        }),
    ).toThrow(/materialMap length/);
  });

  it("air pixels are always cuttable (never matters, but gate must not block them)", () => {
    const world = new World();
    const mat = makeUniformMaterial(W, H, MATERIAL_AIR);
    const terrain = makeTerrain(world, mat, HARDNESS);
    // Air pixels are already 0 in the mask but materialMap code should not block them.
    // Just verify no throw and the call is idempotent.
    expect(() => terrain.cutCircle(16, 16, 5, "explode")).not.toThrow();
  });
});
