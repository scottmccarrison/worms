import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_AIR, MASK_SOLID, type World, createWorld } from "../world";
import { validateSpawnCoherencePass } from "./validateSpawnCoherence";

function makeCtx(world: World, passIndex: number): PassContext {
  return {
    world,
    rng: rngForPass(world.seed, passIndex),
    passIndex,
    tuning,
    resolveParam: (key, fb) => {
      const v = world.theme?.params[key];
      return typeof v === "number" ? v : fb;
    },
  };
}

function setupWorld(w: number, h: number, themeTag: string): World {
  const world = createWorld(0, w, h, themeTag);
  world.theme = getTheme(themeTag);
  return world;
}

/**
 * Build a valid surface column: mask[surfY * w + x] = SOLID, mask[(surfY-1) * w + x] = AIR.
 * Sets heightmap[x] = surfY.
 */
function makeSolidSurface(world: World, xPx: number, surfY: number): void {
  const w = world.widthPx;
  world.heightmap[xPx] = surfY;
  world.mask[surfY * w + xPx] = MASK_SOLID;
  if (surfY >= 1) {
    world.mask[(surfY - 1) * w + xPx] = MASK_AIR;
  }
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateSpawnCoherencePass", () => {
  it("throws on null theme", () => {
    const world = createWorld(0, 40, 40, "default");
    // theme is null by default after createWorld
    expect(() => validateSpawnCoherencePass.run(makeCtx(world, 12))).toThrow(
      /DefineTheme must run first/,
    );
  });

  it("healthy world emits no warnings", () => {
    // 3 spawns each side at known-valid positions; minPerTeam=2 (tuning default)
    const w = 100;
    const h = 60;
    const world = setupWorld(w, h, "default");

    // surfY=10 is valid: >= 1 and < 60
    const leftXs = [5, 10, 15];
    const rightXs = [70, 75, 80];
    const surfY = 10;

    for (const x of leftXs) {
      makeSolidSurface(world, x, surfY);
      world.spawnList.left.push({ xPx: x, yPx: surfY });
    }
    for (const x of rightXs) {
      makeSolidSurface(world, x, surfY);
      world.spawnList.right.push({ xPx: x, yPx: surfY });
    }

    validateSpawnCoherencePass.run(makeCtx(world, 12));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("underpopulated left team emits warning containing 'left team has 1 spawns'", () => {
    const w = 100;
    const h = 60;
    const world = setupWorld(w, h, "default");
    // Override minSpawnsPerTeam to 2 via theme params
    world.theme = {
      // biome-ignore lint/style/noNonNullAssertion: just set above
      ...world.theme!,
      // biome-ignore lint/style/noNonNullAssertion: just set above
      params: { ...world.theme!.params, minSpawnsPerTeam: 2 },
    };

    // 1 valid spawn on left, 3 on right
    makeSolidSurface(world, 5, 10);
    world.spawnList.left.push({ xPx: 5, yPx: 10 });

    for (const x of [70, 75, 80]) {
      makeSolidSurface(world, x, 10);
      world.spawnList.right.push({ xPx: x, yPx: 10 });
    }

    validateSpawnCoherencePass.run(makeCtx(world, 12));

    const calls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((msg: string) => msg.includes("left team has 1 spawns"))).toBe(true);
  });

  it("spawns pointing to invalid mask cells produce one summary warning per side", () => {
    // 5 spawns on left, 3 of which have a broken surface (mask[surfY*w+x] = AIR instead of SOLID).
    // Use minSpawnsPerTeam=1 so the count check passes (5 >= 1 and right side has 5 valid spawns),
    // then break 3 of the 5 left-side surface cells to trigger the surface invariant warning.
    const w = 100;
    const h = 60;
    const world = setupWorld(w, h, "default");
    world.theme = {
      // biome-ignore lint/style/noNonNullAssertion: just set above
      ...world.theme!,
      // biome-ignore lint/style/noNonNullAssertion: just set above
      params: { ...world.theme!.params, minSpawnsPerTeam: 1 },
    };

    const surfY = 10;
    const leftXs = [5, 10, 15, 20, 25];
    const rightXs = [60, 65, 70, 75, 80];

    // Build valid right-side spawns (all pass surface invariant)
    for (const x of rightXs) {
      makeSolidSurface(world, x, surfY);
      world.spawnList.right.push({ xPx: x, yPx: surfY });
    }

    // Build left-side spawns: all start valid, then break 3
    for (const x of leftXs) {
      world.heightmap[x] = surfY;
      // Make the air cell above correct
      world.mask[(surfY - 1) * w + x] = MASK_AIR;
      // Make the surface cell SOLID (will be overwritten for 3 of them below)
      world.mask[surfY * w + x] = MASK_SOLID;
      world.spawnList.left.push({ xPx: x, yPx: surfY });
    }
    // Break 3 of the 5 surface cells - set to AIR so mask check fails
    for (const x of [5, 10, 15]) {
      world.mask[surfY * w + x] = MASK_AIR;
    }

    validateSpawnCoherencePass.run(makeCtx(world, 12));

    const calls = warnSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    // Exactly one warning: left side surface invariant (right side is all valid)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(
      calls.some((msg: string) => msg.includes("3 of 5 spawns failed surface invariant")),
    ).toBe(true);
  });

  it("multiple invalid spawns produce exactly ONE warning per side", () => {
    // 10 invalid spawns on left side (all fail surface invariant), 10 valid on right.
    // Use minSpawnsPerTeam=1 so count check passes, leaving only the surface invariant path.
    const w = 200;
    const h = 60;
    const world = setupWorld(w, h, "default");
    world.theme = {
      // biome-ignore lint/style/noNonNullAssertion: just set above
      ...world.theme!,
      // biome-ignore lint/style/noNonNullAssertion: just set above
      params: { ...world.theme!.params, minSpawnsPerTeam: 1 },
    };

    const surfY = 10;

    // 10 left-side spawns: heightmap set but mask stays AIR -> surface invariant fails
    for (let i = 0; i < 10; i++) {
      const x = i * 10 + 5;
      world.heightmap[x] = surfY;
      // Leave mask as AIR (default) so surface invariant fails
      world.spawnList.left.push({ xPx: x, yPx: surfY });
    }
    // 10 valid right-side spawns so count check and surface check both pass
    for (let i = 0; i < 10; i++) {
      const x = 110 + i * 8;
      makeSolidSurface(world, x, surfY);
      world.spawnList.right.push({ xPx: x, yPx: surfY });
    }

    validateSpawnCoherencePass.run(makeCtx(world, 12));

    // Only one summary warning: left side surface invariant (right side is clean)
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain("10 of 10 spawns failed surface invariant");
  });

  it("minPerTeam=0 returns early; no warnings even with empty spawnList", () => {
    const world = setupWorld(100, 60, "default");
    world.theme = {
      // biome-ignore lint/style/noNonNullAssertion: just set above
      ...world.theme!,
      // biome-ignore lint/style/noNonNullAssertion: just set above
      params: { ...world.theme!.params, minSpawnsPerTeam: 0 },
    };
    // spawnList is empty - if we didn't early-return on minPerTeam=0 we'd see count warnings
    validateSpawnCoherencePass.run(makeCtx(world, 12));
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
