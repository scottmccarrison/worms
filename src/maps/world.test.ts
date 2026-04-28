import { describe, expect, it } from "vitest";
import {
  HEIGHTMAP_UNINIT,
  MASK_AIR,
  MATERIAL_AIR,
  MATERIAL_CRUST,
  MATERIAL_DIRT,
  MATERIAL_ROCK,
  MATERIAL_STONE,
  MAX_PIXEL_COUNT,
  createWorld,
  gateCutByMaterial,
} from "./world";

const DEFAULT_HARDNESS = { rockMinRadiusPx: 30, stoneMinRadiusPx: 60 };

describe("gateCutByMaterial", () => {
  it("AIR is always cuttable", () => {
    expect(gateCutByMaterial(MATERIAL_AIR, 1, DEFAULT_HARDNESS)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_AIR, 0, DEFAULT_HARDNESS)).toBe(true);
  });

  it("DIRT is always cuttable", () => {
    expect(gateCutByMaterial(MATERIAL_DIRT, 1, DEFAULT_HARDNESS)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_DIRT, 100, DEFAULT_HARDNESS)).toBe(true);
  });

  it("CRUST is always cuttable", () => {
    expect(gateCutByMaterial(MATERIAL_CRUST, 1, DEFAULT_HARDNESS)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_CRUST, 0, DEFAULT_HARDNESS)).toBe(true);
  });

  it("ROCK is cuttable at exactly rockMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_ROCK, 30, DEFAULT_HARDNESS)).toBe(true);
  });

  it("ROCK is cuttable above rockMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_ROCK, 31, DEFAULT_HARDNESS)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_ROCK, 100, DEFAULT_HARDNESS)).toBe(true);
  });

  it("ROCK survives below rockMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_ROCK, 29, DEFAULT_HARDNESS)).toBe(false);
    expect(gateCutByMaterial(MATERIAL_ROCK, 1, DEFAULT_HARDNESS)).toBe(false);
    expect(gateCutByMaterial(MATERIAL_ROCK, 0, DEFAULT_HARDNESS)).toBe(false);
  });

  it("STONE is cuttable at exactly stoneMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_STONE, 60, DEFAULT_HARDNESS)).toBe(true);
  });

  it("STONE is cuttable above stoneMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_STONE, 61, DEFAULT_HARDNESS)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_STONE, 200, DEFAULT_HARDNESS)).toBe(true);
  });

  it("STONE survives below stoneMinRadiusPx", () => {
    expect(gateCutByMaterial(MATERIAL_STONE, 59, DEFAULT_HARDNESS)).toBe(false);
    expect(gateCutByMaterial(MATERIAL_STONE, 29, DEFAULT_HARDNESS)).toBe(false);
    expect(gateCutByMaterial(MATERIAL_STONE, 0, DEFAULT_HARDNESS)).toBe(false);
  });

  it("respects custom hardness values", () => {
    const custom = { rockMinRadiusPx: 10, stoneMinRadiusPx: 20 };
    expect(gateCutByMaterial(MATERIAL_ROCK, 10, custom)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_ROCK, 9, custom)).toBe(false);
    expect(gateCutByMaterial(MATERIAL_STONE, 20, custom)).toBe(true);
    expect(gateCutByMaterial(MATERIAL_STONE, 19, custom)).toBe(false);
  });
});

describe("createWorld", () => {
  it("returns a World with correct dimensions, seed, and themeTag", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.widthPx).toBe(100);
    expect(w.heightPx).toBe(50);
    expect(w.seed).toBe(42);
    expect(w.themeTag).toBe("default");
  });

  it("heightmap is Int32Array of length widthPx filled with HEIGHTMAP_UNINIT", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.heightmap).toBeInstanceOf(Int32Array);
    expect(w.heightmap.length).toBe(100);
    for (let i = 0; i < w.heightmap.length; i++) {
      expect(w.heightmap[i]).toBe(HEIGHTMAP_UNINIT);
    }
  });

  it("mask is Uint8Array of length widthPx * heightPx zero-filled", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.mask).toBeInstanceOf(Uint8Array);
    expect(w.mask.length).toBe(100 * 50);
    for (let i = 0; i < w.mask.length; i++) {
      expect(w.mask[i]).toBe(MASK_AIR);
    }
  });

  it("materialMap is Uint8Array of length widthPx * heightPx zero-filled", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.materialMap).toBeInstanceOf(Uint8Array);
    expect(w.materialMap.length).toBe(100 * 50);
    for (let i = 0; i < w.materialMap.length; i++) {
      expect(w.materialMap[i]).toBe(MATERIAL_AIR);
    }
  });

  it("spawnList is { left: [], right: [] }", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.spawnList).toEqual({ left: [], right: [] });
  });

  it("theme is null initially", () => {
    const w = createWorld(42, 100, 50, "default");
    expect(w.theme).toBeNull();
  });

  it("throws for negative seed", () => {
    expect(() => createWorld(-1, 100, 50, "x")).toThrow(/seed must be a non-negative integer/);
  });

  it("throws for seed >= 2^32", () => {
    expect(() => createWorld(2 ** 32, 100, 50, "x")).toThrow(/seed must be a non-negative integer/);
  });

  it("throws for non-integer seed", () => {
    expect(() => createWorld(1.5, 100, 50, "x")).toThrow(/seed must be a non-negative integer/);
  });

  it("throws for invalid widthPx (0)", () => {
    expect(() => createWorld(0, 0, 50, "x")).toThrow(/widthPx must be a positive integer/);
  });

  it("throws for invalid heightPx (negative)", () => {
    expect(() => createWorld(0, 100, -5, "x")).toThrow(/heightPx must be a positive integer/);
  });

  it("throws when widthPx * heightPx exceeds the allocation cap", () => {
    expect(() => createWorld(0, 20000, 20000, "x")).toThrow(/exceeds the allocation cap/);
  });

  it("accepts widthPx * heightPx exactly at the allocation cap", () => {
    const side = Math.floor(Math.sqrt(MAX_PIXEL_COUNT));
    expect(() => createWorld(0, side, side, "default")).not.toThrow();
  });
});
