import type { Tuning } from "../tuning";
import type { Theme } from "./themes";
import type { World } from "./world";

/**
 * Per-pass execution context. Passes receive this once and read from it.
 * The shape is the load-bearing API of the pipeline: it deliberately
 * includes resolveParam so passes can read theme.params with a tuning
 * fallback in one call, instead of re-implementing the lookup pattern in
 * every pass.
 */
export interface PassContext {
  readonly world: World;
  readonly rng: () => number;
  readonly passIndex: number;
  readonly tuning: Tuning;
  /**
   * Looks up `world.theme?.params[key]` and returns it if present (number),
   * otherwise returns `fallback`. The standard pattern for "use theme
   * override or fall back to global tuning default".
   */
  resolveParam(key: keyof Theme["params"], fallback: number): number;
}

export interface Pass {
  readonly name: string;
  run(ctx: PassContext): void;
}
