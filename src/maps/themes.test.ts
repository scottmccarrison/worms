import { describe, expect, it } from "vitest";
import { THEMES, getTheme } from "./themes";

const EXPECTED_TAGS = ["default", "canyon", "snow", "jungle", "plateau", "volcanic"] as const;
const FLAG_KEYS: (keyof import("./themes").ThemeFlags)[] = [
  "wantsPeaks",
  "wantsCaves",
  "noFloor",
  "wantsSurfaceCrust",
  "wantsCaveAmbient",
];

describe("THEMES registry", () => {
  it("has exactly 6 entries with the expected tags", () => {
    const keys = Object.keys(THEMES);
    expect(keys).toHaveLength(6);
    for (const tag of EXPECTED_TAGS) {
      expect(keys).toContain(tag);
    }
  });
});

describe("getTheme", () => {
  it("resolves all 6 themes and returns a Theme with matching tag", () => {
    for (const tag of EXPECTED_TAGS) {
      const theme = getTheme(tag);
      expect(theme.tag).toBe(tag);
    }
  });

  it("every theme has all five ThemeFlags set as booleans (not undefined)", () => {
    for (const tag of EXPECTED_TAGS) {
      const theme = getTheme(tag);
      for (const key of FLAG_KEYS) {
        expect(typeof theme.flags[key], `${tag}.flags.${key} should be boolean`).toBe("boolean");
      }
    }
  });

  it("every theme palette has surface, mid, rock, deep as numbers in valid RGB range (0-0xFFFFFF)", () => {
    for (const tag of EXPECTED_TAGS) {
      const { palette } = getTheme(tag);
      for (const channel of ["surface", "mid", "rock", "deep"] as const) {
        const val = palette[channel];
        expect(typeof val, `${tag}.palette.${channel} should be number`).toBe("number");
        expect(val, `${tag}.palette.${channel} should be >= 0`).toBeGreaterThanOrEqual(0);
        expect(val, `${tag}.palette.${channel} should be <= 0xFFFFFF`).toBeLessThanOrEqual(
          0xffffff,
        );
      }
    }
  });

  it("throws for unknown tag and error message lists known themes", () => {
    expect(() => getTheme("nonsense")).toThrowError(/Known themes:/);
    expect(() => getTheme("nonsense")).toThrowError(/default/);
    expect(() => getTheme("nonsense")).toThrowError(/canyon/);
  });
});
