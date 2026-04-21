/** Seeded uint32 xorshift. Cheap, deterministic, good enough for map gen. */
export function xorshift(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 0xdeadbeef;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0xffffffff; // 0..1
  };
}
