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

// ---------------------------------------------------------------------------
// Wire + Durable-Object-storage transport for packed masks / material maps.
//
// A packed terrain mask is mostly long uniform runs (sky above, solid below),
// so deflate shrinks it ~100-1000x. That keeps a wide world's mask under the
// Durable Object per-value storage limit (an uncompressed 15360x1280 mask is
// ~3.2MB of base64 and overflows it with SQLITE_TOOBIG) and tiny on the wire.
//
// CompressionStream("deflate-raw") exists in browsers, the Cloudflare Workers
// runtime, and Node 18+, so the same helpers run host-side, worker-side, and
// guest-side.

/** Chunked base64 encode (avoids per-byte string concat blowing up on big inputs). */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function runStream(
  stream: CompressionStream | DecompressionStream,
  input: Uint8Array,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Start draining before writing so a single chunk can't deadlock on backpressure.
  const drained = new Response(stream.readable).arrayBuffer();
  // Cast: the packed arrays are ArrayBuffer-backed at runtime, but their static
  // type widens to Uint8Array<ArrayBufferLike>, which the DOM lib's BufferSource
  // (ArrayBuffer-backed) does not accept directly.
  await writer.write(input as BufferSource);
  await writer.close();
  return new Uint8Array(await drained);
}

/** Deflate packed bytes and base64-encode them for the wire / DO storage. */
export async function packedToWire(packed: Uint8Array): Promise<string> {
  return bytesToBase64(await runStream(new CompressionStream("deflate-raw"), packed));
}

/** Inverse of packedToWire: base64-decode then inflate back to packed bytes. */
export async function wireToPacked(wire: string): Promise<Uint8Array> {
  return runStream(new DecompressionStream("deflate-raw"), base64ToBytes(wire));
}
