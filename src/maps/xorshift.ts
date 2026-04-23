/** Seeded uint32 xorshift. Cheap, deterministic, good enough for map gen. */
export function xorshift(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0xdeadbeef;
  // Warm up: discard 4 internal iterations so the first rng() output has
  // full entropy. Small integer seeds produce near-zero first outputs
  // without this step, collapsing variety in downstream generators.
  for (let i = 0; i < 4; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
  }
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    // Divide by 2^32 so output is [0, 1) - exactly matches Math.random().
    // Using 0xffffffff (= 2^32 - 1) would let the result hit 1.0 when s
    // lands on 0xffffffff, which would make `Math.floor(rng() * n)` index
    // out of bounds in callers (e.g. Fisher-Yates shuffle).
    return (s >>> 0) / 0x100000000;
  };
}
