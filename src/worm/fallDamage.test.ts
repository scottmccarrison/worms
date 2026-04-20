import { describe, expect, it } from "vitest";
import { fallDamageFromImpulse } from "./fallDamage";

const config = { density: 1.0, threshold: 8, maxDamage: 25 };

describe("fallDamageFromImpulse", () => {
  it("returns 0 when impulse is below threshold", () => {
    expect(fallDamageFromImpulse(4, config)).toBe(0);
    expect(fallDamageFromImpulse(0, config)).toBe(0);
  });

  it("returns 0 at exact threshold", () => {
    expect(fallDamageFromImpulse(8, config)).toBe(0);
  });

  it("returns positive damage above threshold", () => {
    const dmg = fallDamageFromImpulse(12, config);
    expect(dmg).toBeGreaterThan(0);
    expect(dmg).toBeLessThanOrEqual(25);
  });

  it("caps at maxDamage for very large impulse", () => {
    expect(fallDamageFromImpulse(1000, config)).toBe(25);
  });

  it("returns integer HP (rounded)", () => {
    const dmg = fallDamageFromImpulse(10.7, config);
    expect(dmg).toBe(Math.round(dmg));
  });

  it("scales with density - higher density raises threshold", () => {
    const heavyConfig = { density: 2.0, threshold: 8, maxDamage: 25 };
    // impulse 12 was above threshold for density 1.0 but not for density 2.0 (threshold = 16)
    expect(fallDamageFromImpulse(12, heavyConfig)).toBe(0);
    expect(fallDamageFromImpulse(20, heavyConfig)).toBeGreaterThan(0);
  });
});
