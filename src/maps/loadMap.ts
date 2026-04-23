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
  const seed =
    seedOverride !== undefined ? seedOverride : entry.config.generator.seed || Date.now();
  entry.generator(ctx, widthPx, heightPx, {
    ...entry.config.generator.options,
    seed,
  });

  // Spawn points: use predefined if present, else scan the mask
  let spawnPoints: SurfacePoint[];
  if (entry.config.spawnPoints?.length) {
    spawnPoints = entry.config.spawnPoints;
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
