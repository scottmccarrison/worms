import type { SurfacePoint } from "../worm/spawnPoints";

export interface MapConfig {
  id: string;
  name: string;
  description: string;
  /** Preferred worm count for this map layout. findSpawnPoints honors this. */
  maxWorms: number;
  /** Explicit spawn points; if omitted, falls back to findSpawnPoints scan. */
  spawnPoints?: SurfacePoint[];
  /** Procedural generator id + its options. */
  generator: {
    id: string;
    seed?: number;
    options?: Record<string, number | string | boolean>;
  };
  /** Optional solid sky color override. Defaults to Phaser scene backgroundColor. */
  backgroundColor?: string;
}

export type MapGenerator = (
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  opts: { seed: number } & Record<string, number | string | boolean>,
) => void;

export interface LoadedMap {
  config: MapConfig;
  mask: HTMLCanvasElement;
  spawnPoints: SurfacePoint[];
}
