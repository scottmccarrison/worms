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
