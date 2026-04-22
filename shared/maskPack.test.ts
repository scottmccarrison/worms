import { describe, expect, it } from "vitest";
import { packMask, packedMaskByteLength, unpackMask } from "./maskPack";

describe("maskPack", () => {
  it("round-trips small arrays", () => {
    const input = new Uint8Array([1, 0, 1, 1, 0, 0, 1, 0, 1, 0]);
    const packed = packMask(input);
    const out = unpackMask(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("packedMaskByteLength rounds up", () => {
    expect(packedMaskByteLength(0)).toBe(0);
    expect(packedMaskByteLength(1)).toBe(1);
    expect(packedMaskByteLength(8)).toBe(1);
    expect(packedMaskByteLength(9)).toBe(2);
    expect(packedMaskByteLength(2560 * 1024)).toBe(327680);
  });

  it("round-trips a 2560x1024 mask with random pattern", () => {
    const size = 2560 * 1024;
    const input = new Uint8Array(size);
    for (let i = 0; i < size; i++) input[i] = (i * 31) & 1;
    const packed = packMask(input);
    const out = unpackMask(packed, size);
    expect(out.length).toBe(size);
    // Sample check: verify every 1000th pixel matches rather than all 2.6M
    // assertions (which would time out the test runner).
    let mismatch = -1;
    for (let i = 0; i < size; i++) {
      if (out[i] !== input[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 30000);
});
