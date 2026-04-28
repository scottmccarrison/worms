import { describe, expect, it } from "vitest";
import { tuning } from "../../tuning";
import type { PassContext } from "../pass";
import { getTheme } from "../themes";
import { createWorld } from "../world";
import type { World } from "../world";
import { defineThemePass } from "./defineTheme";

const FLAG_KEYS: (keyof import("../themes").ThemeFlags)[] = [
  "wantsPeaks",
  "wantsCaves",
  "noFloor",
  "wantsSurfaceCrust",
  "wantsCaveAmbient",
];

function makeCtx(world: World): PassContext {
  return {
    world,
    rng: () => 0.5,
    passIndex: 0,
    tuning,
    resolveParam: (_, fb) => fb,
  };
}

describe("defineThemePass", () => {
  it("populates theme from themeTag", () => {
    const world = createWorld(42, 10, 5, "snow");
    expect(world.theme).toBeNull();

    defineThemePass.run(makeCtx(world));

    expect(world.theme).not.toBeNull();
    expect(world.theme?.tag).toBe("snow");

    // All 5 flags should be booleans
    for (const key of FLAG_KEYS) {
      expect(typeof world.theme?.flags[key], `flags.${key} should be boolean`).toBe("boolean");
    }
  });

  it("is idempotent - running twice yields the same theme", () => {
    const world = createWorld(42, 10, 5, "snow");

    defineThemePass.run(makeCtx(world));
    const themeAfterFirst = world.theme;

    defineThemePass.run(makeCtx(world));
    const themeAfterSecond = world.theme;

    expect(themeAfterSecond).toEqual(getTheme("snow"));
    expect(themeAfterSecond).toBe(themeAfterFirst);
  });

  it("throws for unknown themeTag with message including the bad tag", () => {
    // createWorld does not validate themeTag, so we can pass "x" directly
    const world = createWorld(42, 10, 5, "x");

    expect(() => defineThemePass.run(makeCtx(world))).toThrow(/x/);
  });
});
