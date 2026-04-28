/**
 * 1-bit-per-pixel mask packing for the host-provides-mask wire protocol.
 *
 * Alpha source -> packed bytes where bit i (LSB-first) of byte i>>3 is 1
 * if the source pixel i is solid. Length check: ceil(pixelCount / 8).
 */
export function packMask(alphaBytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(alphaBytes.length / 8));
  for (let i = 0; i < alphaBytes.length; i++) {
    if (alphaBytes[i]) out[i >> 3] |= 1 << (i & 7);
  }
  return out;
}

export function unpackMask(packed: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    if (packed[i >> 3] & (1 << (i & 7))) out[i] = 1;
  }
  return out;
}

export function packedMaskByteLength(pixelCount: number): number {
  return Math.ceil(pixelCount / 8);
}

/**
 * Pack a per-pixel material map (0..15) into 2 pixels per byte (4-bit each).
 * Material range is 0..4 today; 4-bit packing leaves headroom.
 * Byte i stores: lo nibble = pixel 2i, hi nibble = pixel 2i+1.
 */
export function packMaterialBytes(m: Uint8Array): Uint8Array {
  const out = new Uint8Array(Math.ceil(m.length / 2));
  for (let i = 0; i < m.length; i += 2) {
    const lo = m[i] & 0xf;
    const hi = (m[i + 1] ?? 0) & 0xf;
    out[i >> 1] = lo | (hi << 4);
  }
  return out;
}

export function unpackMaterialBytes(packed: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const b = packed[i >> 1] ?? 0;
    out[i] = (i & 1) === 0 ? b & 0xf : (b >> 4) & 0xf;
  }
  return out;
}
