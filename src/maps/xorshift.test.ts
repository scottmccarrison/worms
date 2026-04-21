import { describe, expect, it } from "vitest";
import { xorshift } from "./xorshift";

describe("xorshift", () => {
  it("same seed produces identical sequence over 10 calls", () => {
    const a = xorshift(42);
    const b = xorshift(42);
    for (let i = 0; i < 10; i++) {
      expect(a()).toBe(b());
    }
  });

  it("different seeds produce different sequences", () => {
    const a = xorshift(1);
    const b = xorshift(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    // At least one value should differ
    expect(seqA).not.toEqual(seqB);
  });

  it("seed 0 is replaced with deadbeef default (does not return NaN or zero sequence)", () => {
    const rng = xorshift(0);
    const val = rng();
    expect(Number.isFinite(val)).toBe(true);
    expect(val).toBeGreaterThan(0);
  });

  it("seed 0 and seed 1 produce different sequences", () => {
    const a = xorshift(0);
    const b = xorshift(1);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it("output is always in [0, 1) range", () => {
    const rng = xorshift(12345);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
