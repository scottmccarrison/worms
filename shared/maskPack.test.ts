import { describe, expect, it } from "vitest";
import {
  base64ToBytes,
  bytesToBase64,
  packMask,
  packMaterialBytes,
  packedMaskByteLength,
  packedToWire,
  unpackMask,
  unpackMaterialBytes,
  wireToPacked,
} from "./maskPack";

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

describe("packMaterialBytes / unpackMaterialBytes", () => {
  it("round-trips an even-length array", () => {
    const input = new Uint8Array([0, 1, 2, 3, 4, 0, 1, 2]);
    const packed = packMaterialBytes(input);
    const out = unpackMaterialBytes(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("round-trips an odd-length array", () => {
    const input = new Uint8Array([3, 1, 4, 1, 5]);
    const packed = packMaterialBytes(input);
    const out = unpackMaterialBytes(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("round-trips all-zeros", () => {
    const input = new Uint8Array(10);
    const packed = packMaterialBytes(input);
    const out = unpackMaterialBytes(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("round-trips all-fours (max material value in current schema)", () => {
    const input = new Uint8Array(10).fill(4);
    const packed = packMaterialBytes(input);
    const out = unpackMaterialBytes(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("round-trips mixed materials (0..4)", () => {
    const input = new Uint8Array([0, 1, 2, 3, 4, 4, 3, 2, 1, 0, 2, 2]);
    const packed = packMaterialBytes(input);
    const out = unpackMaterialBytes(packed, input.length);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("packed length is ceil(n/2)", () => {
    expect(packMaterialBytes(new Uint8Array(6)).length).toBe(3);
    expect(packMaterialBytes(new Uint8Array(7)).length).toBe(4);
    expect(packMaterialBytes(new Uint8Array(0)).length).toBe(0);
  });
});

describe("base64 transport", () => {
  it("round-trips arbitrary bytes", () => {
    const input = new Uint8Array(1024);
    for (let i = 0; i < input.length; i++) input[i] = (i * 53) & 0xff;
    expect(Array.from(base64ToBytes(bytesToBase64(input)))).toEqual(Array.from(input));
  });
});

describe("packedToWire / wireToPacked (deflate transport)", () => {
  it("round-trips packed bytes through deflate + base64", async () => {
    const input = new Uint8Array(4096);
    for (let i = 0; i < input.length; i++) input[i] = (i * 37) & 0xff;
    const wire = await packedToWire(input);
    const out = await wireToPacked(wire);
    expect(Array.from(out)).toEqual(Array.from(input));
  });

  it("compresses a wide-world terrain mask far under the DO storage limit", async () => {
    // 15360x1280 surface-over-solid mask: the go-wide case that overflowed
    // Durable Object storage uncompressed (~3.2MB of base64, SQLITE_TOOBIG).
    // Deflate must bring it well under the 128KiB per-value storage limit.
    const w = 15360;
    const h = 1280;
    const mask = new Uint8Array(w * h);
    for (let x = 0; x < w; x++) {
      const surf = Math.floor(h * 0.55 + Math.sin(x / 256) * h * 0.12);
      for (let y = Math.max(0, surf); y < h; y++) mask[y * w + x] = 1;
    }
    const packed = packMask(mask);
    const wire = await packedToWire(packed);
    expect(wire.length).toBeLessThan(128 * 1024);

    const out = await wireToPacked(wire);
    expect(out.length).toBe(packed.length);
    // Spot-check fidelity without a 2.4M-element deep-equal.
    let mismatch = -1;
    for (let i = 0; i < packed.length; i++) {
      if (out[i] !== packed[i]) {
        mismatch = i;
        break;
      }
    }
    expect(mismatch).toBe(-1);
  }, 30000);
});
