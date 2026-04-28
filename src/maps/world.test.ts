import { describe, expect, it } from "vitest";
import { HEIGHTMAP_UNINIT, MASK_AIR, MATERIAL_AIR, createWorld } from "./world";

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
});
