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
    return (s >>> 0) / 0xffffffff; // 0..1
  };
}
