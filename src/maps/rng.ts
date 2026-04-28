import { xorshift } from "./xorshift";

const PASS_MIX = 0x9e3779b9;
const SEED_SALT = 0x85ebca6b;

/**
 * Returns a deterministic RNG instance for a given (worldSeed, passIndex) pair.
 *
 * Mixing constants chosen to avoid two collision classes:
 * 1. `seed=0, passIndex=0` colliding with `seed=0xdeadbeef, passIndex=0` via
 *    xorshift's zero-substitution.
 * 2. Adjacent pass indices producing similar streams.
 *
 * Per `docs/guides/world-gen-passes-v1.md` cross-cutting conventions, this is
 * the only blessed way to get an RNG inside a pass. Sharing a cursor across
 * passes would mean reordering passes changes the RNG of unaffected passes,
 * breaking same-seed-same-world for any future pipeline edit.
 */
export function rngForPass(worldSeed: number, passIndex: number): () => number {
  const mixed = (worldSeed ^ SEED_SALT ^ Math.imul(passIndex + 1, PASS_MIX)) >>> 0;
  // Ensure non-zero seed; xorshift's own zero-substitution would otherwise
  // map our (0,0) and any other input that hashes to 0 onto the same stream.
  const safe = mixed === 0 ? PASS_MIX : mixed;
  return xorshift(safe);
}

/**
 * Uniform integer in [0, n). The blessed integer-from-rng path; do not use
 * `Math.floor(rng() * n)` directly in passes - this helper is a single-point
 * audit surface for cross-engine determinism risks (V8 vs SpiderMonkey vs
 * JavaScriptCore at the f64 boundary).
 */
export function rngInt(rng: () => number, n: number): number {
  if (n <= 0 || !Number.isInteger(n)) {
    throw new Error(`rngInt: n must be a positive integer, got ${n}`);
  }
  return Math.floor(rng() * n);
}

/** Uniform integer in [lo, hi] inclusive. */
export function rngRange(rng: () => number, lo: number, hi: number): number {
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
    throw new Error("rngRange: lo and hi must be integers");
  }
  if (hi < lo) {
    throw new Error(`rngRange: hi (${hi}) must be >= lo (${lo})`);
  }
  return lo + rngInt(rng, hi - lo + 1);
}
