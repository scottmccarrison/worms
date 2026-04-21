import { findSpawnPoints } from "../worm/spawnPoints";
import type { SurfacePoint } from "../worm/spawnPoints";
import { getById } from "./registry";
import type { LoadedMap } from "./types";

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
    seedOverride !== undefined
      ? seedOverride
      : entry.config.generator.seed || Date.now();
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
    spawnPoints = findSpawnPoints(imgData.data, widthPx, heightPx, entry.config.maxWorms);
  }

  return { config: entry.config, mask: canvas, spawnPoints };
}
