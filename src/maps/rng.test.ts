import { describe, expect, it } from "vitest";
import { rngForPass, rngInt, rngRange } from "./rng";

describe("rngForPass", () => {
  it("determinism: same (worldSeed, passIndex) produces identical stream over 1000 values", () => {
    const a = rngForPass(42, 3);
    const b = rngForPass(42, 3);
    for (let i = 0; i < 1000; i++) {
      expect(a()).toBe(b());
    }
  });

  it("collision resistance #1: (0, 0) differs from (0xdeadbeef, 0) over 1000 values", () => {
    const a = rngForPass(0, 0);
    const b = rngForPass(0xdeadbeef, 0);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    // At least one value must differ
    const anyDiff = seqA.some((v, i) => v !== seqB[i]);
    expect(anyDiff).toBe(true);
  });

  it("collision resistance #2: (0, 0) differs from (0, 1)", () => {
    const a = rngForPass(0, 0);
    const b = rngForPass(0, 1);
    const seqA = Array.from({ length: 1000 }, () => a());
    const seqB = Array.from({ length: 1000 }, () => b());
    const anyDiff = seqA.some((v, i) => v !== seqB[i]);
    expect(anyDiff).toBe(true);
  });

  it("pass independence: 11 distinct pass streams for passIndex 0..10 (same worldSeed)", () => {
    const SEED = 12345;
    const streams = Array.from({ length: 11 }, (_, i) =>
      Array.from({ length: 100 }, rngForPass(SEED, i)),
    );
    // Every pair of streams must differ in at least one value
    for (let i = 0; i < streams.length; i++) {
      for (let j = i + 1; j < streams.length; j++) {
        const anyDiff = streams[i].some((v, k) => v !== streams[j][k]);
        expect(anyDiff).toBe(true);
      }
    }
  });
});

describe("rngInt", () => {
  it("distribution sanity: 10000 samples of rngInt(rng, 10) fill all buckets [0..9] with 500..1500 hits", () => {
    const rng = rngForPass(99, 0);
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 10000; i++) {
      counts[rngInt(rng, 10)]++;
    }
    for (let bucket = 0; bucket < 10; bucket++) {
      expect(counts[bucket]).toBeGreaterThanOrEqual(500);
      expect(counts[bucket]).toBeLessThanOrEqual(1500);
    }
  });

  it("throws when n is 0", () => {
    const rng = rngForPass(1, 0);
    expect(() => rngInt(rng, 0)).toThrow();
  });

  it("throws when n is negative", () => {
    const rng = rngForPass(1, 0);
    expect(() => rngInt(rng, -5)).toThrow();
  });

  it("throws when n is non-integer", () => {
    const rng = rngForPass(1, 0);
    expect(() => rngInt(rng, 2.5)).toThrow();
  });
});

describe("rngRange", () => {
  it("boundaries inclusive: 10000 samples of rngRange(rng, 5, 7) stay in {5, 6, 7} and hit each value", () => {
    const rng = rngForPass(77, 2);
    const seen = new Set<number>();
    for (let i = 0; i < 10000; i++) {
      const v = rngRange(rng, 5, 7);
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(7);
      seen.add(v);
    }
    expect(seen.has(5)).toBe(true);
    expect(seen.has(6)).toBe(true);
    expect(seen.has(7)).toBe(true);
  });

  it("throws when hi < lo", () => {
    const rng = rngForPass(1, 0);
    expect(() => rngRange(rng, 5, 3)).toThrow();
  });
});
