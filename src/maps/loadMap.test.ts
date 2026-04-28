import { createCanvas } from "canvas";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadMap } from "./loadMap";

// Patch document.createElement("canvas") to use node-canvas in the node test environment
beforeEach(() => {
  vi.stubGlobal("document", {
    createElement: (tag: string) => {
      if (tag === "canvas") {
        return createCanvas(1280, 720);
      }
      throw new Error(`document.createElement("${tag}") not supported in test`);
    },
  });
});

describe("loadMap", () => {
  it("returns a LoadedMap with non-empty spawnPoints for hills", () => {
    const result = loadMap("hills", 1280, 720);
    expect(result.config.id).toBe("hills");
    expect(result.mask).toBeDefined();
    expect(result.spawnPoints.length).toBeGreaterThan(0);
  });

  it("returns predefined spawn points verbatim for island", () => {
    const result = loadMap("island", 1280, 720);
    expect(result.spawnPoints).toEqual([
      { xPx: 384, yPx: 380 },
      { xPx: 896, yPx: 380 },
      { xPx: 512, yPx: 380 },
      { xPx: 768, yPx: 380 },
    ]);
  });

  it("returns a LoadedMap with non-empty spawnPoints for flat", () => {
    const result = loadMap("flat", 1280, 720);
    expect(result.config.id).toBe("flat");
    expect(result.spawnPoints.length).toBeGreaterThan(0);
  });

  it("throws on unknown map id", () => {
    expect(() => loadMap("nonexistent", 1280, 720)).toThrow("Unknown map id: nonexistent");
  });

  it("mask canvas has the requested dimensions", () => {
    const result = loadMap("hills", 1280, 720);
    expect(result.mask.width).toBe(1280);
    expect(result.mask.height).toBe(720);
  });

  it("config matches registry entry", () => {
    const result = loadMap("flat", 1280, 720);
    expect(result.config.name).toBe("Open Field");
    expect(result.config.maxWorms).toBe(4);
  });

  it("v1 map (terraworld_v1): returns spawnPoints from generator-returned spawnList, interleaved L/R", () => {
    const result = loadMap("terraworld_v1", 1280, 720, 42);
    expect(result.spawnPoints.length).toBeGreaterThan(0);
    // With interleave order [L0, R0, L1, R1, ...], adjacent pairs should
    // straddle the midline (one < midX, the next >= midX) until one side
    // exhausts. Verify at least the first pair.
    const midX = Math.floor(1280 / 2);
    if (result.spawnPoints.length >= 2) {
      const first = result.spawnPoints[0];
      const second = result.spawnPoints[1];
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      if (first && second) {
        // first is from left (xPx < midX), second is from right (xPx >= midX)
        expect(first.xPx).toBeLessThan(midX);
        expect(second.xPx).toBeGreaterThanOrEqual(midX);
      }
    }
  });

  it("v1 map (canyon_v1): returns non-empty spawnPoints through the v1 path", () => {
    const result = loadMap("canyon_v1", 1280, 720, 42);
    expect(result.config.id).toBe("canyon_v1");
    expect(result.spawnPoints.length).toBeGreaterThan(0);
  });

  it("v1 map (terraworld_v1) without seedOverride: succeeds with Date.now() fallback (regression: createWorld would otherwise throw on seed >= 2^32)", () => {
    // The terraworld_v1 registry entry has seed: 0 which intentionally falls
    // through to Date.now() in loadMap. createWorld validates seed < 2^32, so
    // loadMap must mask Date.now() to uint32 to prevent throwing. Pre-fix,
    // this call threw and the host fell back to a flat mask + 4-worms-on-grid
    // spawn pattern.
    const result = loadMap("terraworld_v1", 2560, 1024);
    expect(result.spawnPoints.length).toBeGreaterThan(0);
    expect(result.config.id).toBe("terraworld_v1");
  });
});
