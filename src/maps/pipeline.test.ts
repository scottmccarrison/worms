import { describe, expect, it, vi } from "vitest";

// Stub the cross-workstream module so tests can run before WS-B lands.
// rngForPass(seed, passIndex) must return a deterministic () => number.
// We implement the minimal contract: same (seed, passIndex) -> same sequence,
// different passIndex -> different first value.
vi.mock("./rng", () => ({
  rngForPass: (seed: number, passIndex: number): (() => number) => {
    // Simple deterministic sequence based on seed and passIndex.
    let state = (seed ^ (passIndex * 2654435761)) >>> 0;
    return () => {
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
      state = Math.imul(state ^ (state >>> 16), 0x45d9f3b) >>> 0;
      state = (state ^ (state >>> 16)) >>> 0;
      return state / 0x100000000;
    };
  },
}));

import type { Pass, PassContext } from "./pass";
import { Pipeline } from "./pipeline";
import { createWorld } from "./world";

function makeWorld() {
  return createWorld(42, 100, 100, "default");
}

/** Build a Pass whose run() calls the provided fn. */
function makePass(name: string, fn: (ctx: PassContext) => void): Pass {
  return { name, run: fn };
}

describe("Pipeline", () => {
  describe("length", () => {
    it("returns the pass count", () => {
      const p = new Pipeline([makePass("a", () => {}), makePass("b", () => {})]);
      expect(p.length).toBe(2);
    });

    it("returns 0 for empty pipeline", () => {
      expect(new Pipeline([]).length).toBe(0);
    });
  });

  describe("pass ordering and passIndex", () => {
    it("executes passes in order with correct passIndex", () => {
      const indices: number[] = [];
      const passes: Pass[] = [
        makePass("p0", (ctx) => {
          indices.push(ctx.passIndex);
        }),
        makePass("p1", (ctx) => {
          indices.push(ctx.passIndex);
        }),
        makePass("p2", (ctx) => {
          indices.push(ctx.passIndex);
        }),
      ];
      new Pipeline(passes).run(makeWorld());
      expect(indices).toEqual([0, 1, 2]);
    });
  });

  describe("per-pass RNG", () => {
    it("each pass receives a distinct RNG (distinct first values)", () => {
      const firstValues: number[] = [];
      const passes: Pass[] = [
        makePass("p0", (ctx) => {
          firstValues.push(ctx.rng());
        }),
        makePass("p1", (ctx) => {
          firstValues.push(ctx.rng());
        }),
        makePass("p2", (ctx) => {
          firstValues.push(ctx.rng());
        }),
      ];
      new Pipeline(passes).run(makeWorld());
      expect(firstValues.length).toBe(3);
      const unique = new Set(firstValues);
      expect(unique.size).toBe(3);
    });
  });

  describe("determinism", () => {
    it("same seed produces identical rng() sequences across two runs", () => {
      const run1: number[] = [];
      const run2: number[] = [];
      const buildPasses = (out: number[]): Pass[] => [
        makePass("p0", (ctx) => {
          out.push(ctx.rng(), ctx.rng());
        }),
        makePass("p1", (ctx) => {
          out.push(ctx.rng(), ctx.rng());
        }),
        makePass("p2", (ctx) => {
          out.push(ctx.rng(), ctx.rng());
        }),
      ];
      new Pipeline(buildPasses(run1)).run(makeWorld());
      new Pipeline(buildPasses(run2)).run(makeWorld());
      expect(run1).toEqual(run2);
    });
  });

  describe("subseed isolation", () => {
    it("a pass at index 0 gets the same rng regardless of total pipeline length", () => {
      let valueA = -1;
      let valueB = -1;
      const p0a = makePass("p0", (ctx) => {
        valueA = ctx.rng();
      });
      const p0b = makePass("p0", (ctx) => {
        valueB = ctx.rng();
      });
      const noop = makePass("noop", () => {});
      const world = makeWorld();
      new Pipeline([p0a]).run(world);
      new Pipeline([p0b, noop, noop]).run(world);
      expect(valueA).toBe(valueB);
    });
  });

  describe("error wrapping", () => {
    it("wraps pass errors with pass name and index in message", () => {
      const boom = makePass("explode", () => {
        throw new Error("original error");
      });
      let caught: unknown;
      try {
        new Pipeline([boom]).run(makeWorld());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      const err = caught as Error;
      expect(err.message).toContain("explode");
      expect(err.message).toContain("0");
    });

    it("sets the original error as .cause", () => {
      const original = new Error("original error");
      const boom = makePass("explode", () => {
        throw original;
      });
      let caught: unknown;
      try {
        new Pipeline([boom]).run(makeWorld());
      } catch (e) {
        caught = e;
      }
      expect((caught as Error & { cause?: unknown }).cause).toBe(original);
    });

    it("wraps non-Error throws by converting to Error first", () => {
      const boom = makePass("strthrow", () => {
        throw "raw string error";
      });
      let caught: unknown;
      try {
        new Pipeline([boom]).run(makeWorld());
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("strthrow");
    });
  });

  describe("onPass observer", () => {
    it("fires once per pass with index, name, and non-negative durationMs", () => {
      const events: { index: number; name: string; durationMs: number }[] = [];
      const passes: Pass[] = [makePass("alpha", () => {}), makePass("beta", () => {})];
      new Pipeline(passes).run(makeWorld(), {
        onPass: (info) => {
          events.push(info);
        },
      });
      expect(events.length).toBe(2);
      expect(events[0]).toMatchObject({ index: 0, name: "alpha" });
      expect(events[1]).toMatchObject({ index: 1, name: "beta" });
      for (const ev of events) {
        expect(ev.durationMs).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe("empty pipeline", () => {
    it("runs without error", () => {
      expect(() => new Pipeline([]).run(makeWorld())).not.toThrow();
    });
  });
});
