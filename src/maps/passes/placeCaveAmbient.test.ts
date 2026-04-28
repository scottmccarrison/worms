import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { rngForPass } from "../rng";
import { getTheme } from "../themes";
import { MASK_AIR, MASK_SOLID, type World, createWorld } from "../world";
import { placeCaveAmbientPass } from "./placeCaveAmbient";

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
 * Fills a world with a carved cave: surface crust at surfY, solid below surfY
 * except for a rectangular cave pocket from caveTop..caveBottom (exclusive)
 * and caveLeft..caveRight (exclusive), which is air.
 */
function setupWorldWithCave(
  w: number,
  h: number,
  themeTag: string,
  surfY: number,
  caveTop: number,
  caveBottom: number,
  caveLeft: number,
  caveRight: number,
): World {
  const world = setupWorld(w, h, themeTag);
  // Fill heightmap: all columns have surface at surfY
  for (let x = 0; x < w; x++) {
    world.heightmap[x] = surfY;
  }
  // Fill mask: solid everywhere below surfY, then carve cave pocket to AIR
  for (let y = surfY; y < h; y++) {
    for (let x = 0; x < w; x++) {
      world.mask[y * w + x] = MASK_SOLID;
    }
  }
  for (let y = caveTop; y < caveBottom; y++) {
    for (let x = caveLeft; x < caveRight; x++) {
      world.mask[y * w + x] = MASK_AIR;
    }
  }
  return world;
}

describe("placeCaveAmbientPass", () => {
  it("wantsCaveAmbient=false returns early; caveAmbient stays empty", () => {
    // default theme has wantsCaveAmbient: false
    const world = setupWorldWithCave(40, 40, "default", 5, 10, 35, 5, 35);
    expect(world.theme?.flags.wantsCaveAmbient).toBe(false);
    placeCaveAmbientPass.run(makeCtx(world, 10));
    expect(world.caveAmbient).toHaveLength(0);
  });

  it("snow theme produces frost-typed features inside the cave", () => {
    // Use a generous world + cave to ensure attempts land inside the cave.
    // 200x200 * 0.00015 = 6 attempts; max(8,6) = 8 attempts minimum.
    // The cave covers 150x150 pixels below surface (y 20..170, x 20..170)
    // which is a large fraction of the world area, so most attempts land inside.
    // Use a large world + high factor override to guarantee some hits.
    const world = setupWorldWithCave(200, 200, "snow", 10, 20, 190, 10, 190);
    if (!world.theme) throw new Error("theme must be set");
    // Override factor to guarantee many attempts
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, caveAmbientAttemptFactor: 0.01 },
    };
    placeCaveAmbientPass.run(makeCtx(world, 10));
    expect(world.caveAmbient.length).toBeGreaterThan(0);
    for (const f of world.caveAmbient) {
      expect(f.type).toBe("frost");
    }
  });

  it("all produced features satisfy mask=AIR and yPx > heightmap[xPx]", () => {
    const world = setupWorldWithCave(200, 200, "snow", 10, 20, 190, 10, 190);
    if (!world.theme) throw new Error("theme must be set");
    world.theme = {
      ...world.theme,
      params: { ...world.theme.params, caveAmbientAttemptFactor: 0.01 },
    };
    placeCaveAmbientPass.run(makeCtx(world, 10));
    expect(world.caveAmbient.length).toBeGreaterThan(0);
    const { widthPx, mask, heightmap } = world;
    for (const f of world.caveAmbient) {
      expect(mask[f.yPx * widthPx + f.xPx]).toBe(MASK_AIR);
      const surfY = heightmap[f.xPx];
      expect(f.yPx).toBeGreaterThan(surfY);
    }
  });

  it("determinism: same seed produces identical caveAmbient list", () => {
    const makeRun = () => {
      const world = setupWorldWithCave(200, 200, "snow", 10, 20, 190, 10, 190);
      if (!world.theme) throw new Error("theme must be set");
      world.theme = {
        ...world.theme,
        params: { ...world.theme.params, caveAmbientAttemptFactor: 0.005 },
      };
      placeCaveAmbientPass.run(makeCtx(world, 10));
      return world.caveAmbient;
    };
    const first = makeRun();
    const second = makeRun();
    expect(first).toEqual(second);
  });

  it("theme.params.caveAmbientAttemptFactor override changes the produced count", () => {
    const makeRunWithFactor = (factor: number) => {
      const world = setupWorldWithCave(200, 200, "snow", 10, 20, 190, 10, 190);
      if (!world.theme) throw new Error("theme must be set");
      world.theme = {
        ...world.theme,
        params: { ...world.theme.params, caveAmbientAttemptFactor: factor },
      };
      placeCaveAmbientPass.run(makeCtx(world, 10));
      return world.caveAmbient.length;
    };
    const lowCount = makeRunWithFactor(0.0005);
    const highCount = makeRunWithFactor(0.05);
    // Higher factor = more attempts = more features (stochastic but strong signal at 100x ratio)
    expect(highCount).toBeGreaterThan(lowCount);
  });

  it("throws on null theme", () => {
    const world = createWorld(0, 40, 40, "snow");
    // theme is null by default after createWorld
    expect(() => placeCaveAmbientPass.run(makeCtx(world, 10))).toThrow(
      /DefineTheme must run first/,
    );
  });
});
