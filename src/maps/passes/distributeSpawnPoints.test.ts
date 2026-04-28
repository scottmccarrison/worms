import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_AIR, MASK_SOLID, type World, createWorld } from "../world";
import { distributeSpawnPointsPass } from "./distributeSpawnPoints";

function makeCtx(world: World, passIndex = 11): PassContext {
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

function setupWorld(w: number, h: number, themeTag = "default"): World {
  const world = createWorld(0, w, h, themeTag);
  world.theme = getTheme(themeTag);
  return world;
}

/**
 * Fills a world with a flat surface at surfY: solid from surfY downward,
 * air above. heightmap[x] = surfY for all x.
 */
function setupFlatWorld(w: number, h: number, surfY: number, themeTag = "default"): World {
  const world = setupWorld(w, h, themeTag);
  for (let x = 0; x < w; x++) {
    world.heightmap[x] = surfY;
  }
  for (let y = surfY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      world.mask[y * w + x] = MASK_SOLID;
    }
  }
  // Ensure the row above surfY is explicitly air
  if (surfY > 0) {
    for (let x = 0; x < w; x++) {
      world.mask[(surfY - 1) * w + x] = MASK_AIR;
    }
  }
  return world;
}

describe("distributeSpawnPointsPass", () => {
  it("throws on null theme", () => {
    const world = createWorld(0, 100, 100, "default");
    // world.theme is null by default after createWorld
    expect(() => distributeSpawnPointsPass.run(makeCtx(world, 11))).toThrow(/world.theme is null/);
  });

  it("densityPx <= 0 returns early; spawnList unchanged", () => {
    const world = setupFlatWorld(200, 100, 50);
    if (!world.theme) throw new Error("theme must be set");
    // Override spawnDensity to 0 via theme params
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, spawnDensity: 0 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    expect(world.spawnList.left).toHaveLength(0);
    expect(world.spawnList.right).toHaveLength(0);
  });

  it("minPerTeam <= 0 returns early; spawnList unchanged", () => {
    const world = setupFlatWorld(200, 100, 50);
    if (!world.theme) throw new Error("theme must be set");
    // Override minSpawnsPerTeam to 0 via theme params
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, minSpawnsPerTeam: 0 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    expect(world.spawnList.left).toHaveLength(0);
    expect(world.spawnList.right).toHaveLength(0);
  });

  it("flat surface produces >= minPerTeam spawns on each side", () => {
    // Wide world ensures enough valid columns on both sides after edge margin
    const world = setupFlatWorld(400, 200, 100);
    if (!world.theme) throw new Error("theme must be set");
    // Use a small densityPx so we can get multiple spawns easily
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, spawnDensity: 20, minSpawnsPerTeam: 2 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    expect(world.spawnList.left.length).toBeGreaterThanOrEqual(2);
    expect(world.spawnList.right.length).toBeGreaterThanOrEqual(2);
  });

  it("left spawns are all at xPx < midX; right spawns are all at xPx >= midX", () => {
    const w = 400;
    const world = setupFlatWorld(w, 200, 100);
    if (!world.theme) throw new Error("theme must be set");
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, spawnDensity: 20, minSpawnsPerTeam: 2 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    const midX = Math.floor(w / 2);
    for (const p of world.spawnList.left) {
      expect(p.xPx).toBeLessThan(midX);
    }
    for (const p of world.spawnList.right) {
      expect(p.xPx).toBeGreaterThanOrEqual(midX);
    }
  });

  it("all spawns satisfy worm-fits invariant: surface solid, cell above air", () => {
    const w = 400;
    const h = 200;
    const surfY = 100;
    const world = setupFlatWorld(w, h, surfY);
    if (!world.theme) throw new Error("theme must be set");
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, spawnDensity: 20, minSpawnsPerTeam: 2 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    const { widthPx, mask, heightmap } = world;
    const allSpawns = [...world.spawnList.left, ...world.spawnList.right];
    expect(allSpawns.length).toBeGreaterThan(0);
    for (const p of allSpawns) {
      const hY = heightmap[p.xPx];
      expect(hY).toBeDefined();
      // surface cell must be solid
      expect(mask[hY * widthPx + p.xPx]).toBe(MASK_SOLID);
      // cell above surface must be air
      expect(mask[(hY - 1) * widthPx + p.xPx]).toBe(MASK_AIR);
    }
  });

  it("columns where heightmap[xPx] === 0 are skipped; no spawns added", () => {
    // Build a world where all heightmap values are 0 (surface at top row,
    // no air row above for worm clearance)
    const w = 200;
    const h = 100;
    const world = setupWorld(w, h);
    for (let x = 0; x < w; x++) {
      world.heightmap[x] = 0;
    }
    // Fill row 0 as solid
    for (let x = 0; x < w; x++) {
      world.mask[0 * w + x] = MASK_SOLID;
    }
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    expect(world.spawnList.left).toHaveLength(0);
    expect(world.spawnList.right).toHaveLength(0);
  });

  it("determinism: same seed produces deep-equal spawnList across two runs", () => {
    const makeRun = () => {
      const world = setupFlatWorld(400, 200, 100);
      if (!world.theme) throw new Error("theme must be set");
      world.theme = {
        ...world.theme,
        params: { ...world.theme.params, spawnDensity: 20, minSpawnsPerTeam: 2 },
      };
      distributeSpawnPointsPass.run(makeCtx(world, 11));
      return world.spawnList;
    };
    const first = makeRun();
    const second = makeRun();
    expect(first.left).toEqual(second.left);
    expect(first.right).toEqual(second.right);
  });

  it("spawnList.left and spawnList.right are sorted by xPx ascending after pass", () => {
    const world = setupFlatWorld(400, 200, 100);
    if (!world.theme) throw new Error("theme must be set");
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, spawnDensity: 20, minSpawnsPerTeam: 3 },
    };
    distributeSpawnPointsPass.run(makeCtx(world, 11));
    const isSorted = (arr: Array<{ xPx: number }>) =>
      arr.every((p, i) => i === 0 || (arr[i - 1]?.xPx ?? Number.NEGATIVE_INFINITY) <= p.xPx);
    expect(isSorted(world.spawnList.left)).toBe(true);
    expect(isSorted(world.spawnList.right)).toBe(true);
  });
});
