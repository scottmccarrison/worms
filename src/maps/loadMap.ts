import { findSpawnPoints } from "../worm/spawnPoints";
import type { SurfacePoint } from "../worm/spawnPoints";
import { getById } from "./registry";
import type { LoadedMap } from "./types";
import { xorshift } from "./xorshift";

export function loadMap(
  id: string,
  widthPx: number,
  heightPx: number,
  seedOverride?: number,
): LoadedMap {
  const entry = getById(id);
  if (!entry) throw new Error(`Unknown map id: ${id}`);

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("loadMap: 2D context unavailable");

  // Precedence: explicit override (multiplayer host's authoritative seed) >
  // config seed > runtime default. Falsy 0 is treated like "unset" to match
  // the original behavior.
  //
  // Date.now() returns ~1.7e12 (post-2024), which exceeds 2^32. The v1
  // pipeline's createWorld validates seed < 2^32 and throws on out-of-range,
  // so we mask the fallback to uint32 via `>>> 0`. Legacy generators don't
  // care, but masking is harmless for them. Without this mask, terraworld_v1
  // and canyon_v1 always throw on the host, fall through to the flat-mask
  // fallback in LobbyScene.handleStart, and players spawn in a 4-worm cluster
  // at (120-460, 904) on a featureless rectangle.
  const seed =
    seedOverride !== undefined ? seedOverride : entry.config.generator.seed || Date.now() >>> 0;
  const generatorResult = entry.generator(ctx, widthPx, heightPx, {
    ...entry.config.generator.options,
    seed,
  });

  // Spawn points: precedence is config preset > generator-returned spawnList >
  // legacy canvas scan fallback.
  let spawnPoints: SurfacePoint[];
  if (entry.config.spawnPoints?.length) {
    spawnPoints = entry.config.spawnPoints;
  } else if (generatorResult?.spawnList) {
    // v1 pipeline generators return authoritative spawn data. Interleave the
    // sides as [L0, R0, L1, R1, ...] so the worker's stride-2 round-robin
    // (worker/src/room.ts:887-900) produces team-segregated assignment - team
    // 0 ends up on the left, team 1 on the right. A naive [...left, ...right]
    // concatenation would clump both teams on whichever side comes first.
    const { left, right } = generatorResult.spawnList;
    spawnPoints = [];
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i++) {
      const l = left[i];
      if (l) spawnPoints.push(l);
      const r = right[i];
      if (r) spawnPoints.push(r);
    }
  } else {
    const imgData = ctx.getImageData(0, 0, widthPx, heightPx);
    // Derive a separate rng for spawn selection. XOR the seed with a constant
    // so the spawn stream doesn't collide with the generator's stream (which
    // may or may not share the same seed).
    const spawnRng = xorshift(seed ^ 0x5a5a5a5a);
    spawnPoints = findSpawnPoints(imgData.data, widthPx, heightPx, entry.config.maxWorms, {
      rng: spawnRng,
    });
  }

  return { config: entry.config, mask: canvas, spawnPoints };
}
