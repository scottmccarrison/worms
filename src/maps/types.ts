import type { SurfacePoint } from "../worm/spawnPoints";
import type { SpawnList } from "./world";

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
  /**
   * When false, the map is hidden from the multiplayer lobby's map cycle.
   * Still reachable via `?offline=1&map=<id>` for regression testing. Per
   * ADR-003 (procgen-first) legacy handcrafted maps are hidden here.
   */
  readonly visibleInLobby?: boolean;
  /**
   * When true, the generator has already painted final RGB to the canvas
   * (via paintWorldToContext or similar materials-aware painter). Renderers
   * skip applyStratumPaint so the materials-derived colors are preserved.
   * Legacy generators leave this false/undefined and rely on stratumPaint.
   */
  readonly prePainted?: boolean;
}

/**
 * Pipeline-based generators (terraworldV1) return their world.spawnList so
 * loadMap can ship authoritative team-partitioned spawn data downstream.
 * Legacy generators return void; the absence is treated as "fall back to
 * legacy findSpawnPoints scan."
 *
 * `void` (rather than `undefined`) is required so existing legacy generators
 * declared `() => void` continue to satisfy the type without modification.
 */
export type MapGenerator = (
  ctx: CanvasRenderingContext2D,
  widthPx: number,
  heightPx: number,
  opts: { seed: number } & Record<string, number | string | boolean>,
  // biome-ignore lint/suspicious/noConfusingVoidType: legacy generators declare `() => void`; see jsdoc.
) => void | { spawnList: SpawnList; materialMap?: Uint8Array };

export interface LoadedMap {
  config: MapConfig;
  mask: HTMLCanvasElement;
  spawnPoints: SurfacePoint[];
  /** Per-pixel material codes from world generation. Optional; legacy generators may not produce it. */
  materialMap?: Uint8Array;
  widthPx?: number;
  heightPx?: number;
}
