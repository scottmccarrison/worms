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
});
