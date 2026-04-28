import { tuning } from "../tuning";
import type { Pass, PassContext } from "./pass";
import { rngForPass } from "./rng";
import type { Theme } from "./themes";
import type { World } from "./world";

export interface PipelineRunOpts {
  /** Optional observer fired once per pass. Useful for telemetry, profiling, debugging. */
  onPass?: (info: { index: number; name: string; durationMs: number }) => void;
}

/**
 * Executes an ordered list of named passes against a World.
 *
 * Each pass receives a PassContext with a per-pass RNG via rngForPass, the
 * full Tuning object, the pass index, and a resolveParam helper. Passes
 * that throw are wrapped in an Error that names the failing pass so
 * stack traces are useful.
 */
export class Pipeline {
  constructor(private readonly passes: readonly Pass[]) {}

  get length(): number {
    return this.passes.length;
  }

  run(world: World, opts?: PipelineRunOpts): void {
    for (let i = 0; i < this.passes.length; i++) {
      const pass = this.passes[i];
      if (!pass) continue;
      const rng = rngForPass(world.seed, i);
      const ctx: PassContext = {
        world,
        rng,
        passIndex: i,
        tuning,
        resolveParam: (key: keyof Theme["params"], fallback: number): number => {
          const v = world.theme?.params[key];
          return typeof v === "number" ? v : fallback;
        },
      };
      const t0 = performance.now();
      try {
        pass.run(ctx);
      } catch (e) {
        const cause = e instanceof Error ? e : new Error(String(e));
        const wrapped = new Error(`pass ${i} (${pass.name}) failed: ${cause.message}`, { cause });
        throw wrapped;
      }
      const durationMs = performance.now() - t0;
      opts?.onPass?.({ index: i, name: pass.name, durationMs });
    }
  }
}
