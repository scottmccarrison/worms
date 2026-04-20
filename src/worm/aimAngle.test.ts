import { describe, expect, it } from "vitest";
import { AIM_MAX, AIM_MIN, clampAim, stepAim } from "./aimAngle";

describe("clampAim", () => {
  it("returns value unchanged when within range", () => {
    expect(clampAim(0)).toBeCloseTo(0);
    expect(clampAim(0.5)).toBeCloseTo(0.5);
    expect(clampAim(-0.5)).toBeCloseTo(-0.5);
  });

  it("clamps to AIM_MIN when below range", () => {
    expect(clampAim(-Math.PI)).toBeCloseTo(AIM_MIN);
    expect(clampAim(-100)).toBeCloseTo(AIM_MIN);
  });

  it("clamps to AIM_MAX when above range", () => {
    expect(clampAim(Math.PI)).toBeCloseTo(AIM_MAX);
    expect(clampAim(100)).toBeCloseTo(AIM_MAX);
  });

  it("allows exact boundary values", () => {
    expect(clampAim(AIM_MIN)).toBeCloseTo(AIM_MIN);
    expect(clampAim(AIM_MAX)).toBeCloseTo(AIM_MAX);
  });
});

describe("stepAim", () => {
  it("returns current when direction is 0", () => {
    expect(stepAim(0.3, 0, 2.0, 0.016)).toBeCloseTo(0.3);
  });

  it("rotates up (toward AIM_MIN) when direction is -1", () => {
    const result = stepAim(0, -1, 2.0, 0.5);
    expect(result).toBeCloseTo(-1.0);
  });

  it("rotates down (toward AIM_MAX) when direction is +1", () => {
    const result = stepAim(0, 1, 2.0, 0.5);
    expect(result).toBeCloseTo(1.0);
  });

  it("clamps at AIM_MIN when stepping up past limit", () => {
    const result = stepAim(AIM_MIN + 0.1, -1, 2.0, 1.0);
    expect(result).toBeCloseTo(AIM_MIN);
  });

  it("clamps at AIM_MAX when stepping down past limit", () => {
    const result = stepAim(AIM_MAX - 0.1, 1, 2.0, 1.0);
    expect(result).toBeCloseTo(AIM_MAX);
  });
});
