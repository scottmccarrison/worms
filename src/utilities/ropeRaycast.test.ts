import type { World } from "planck";
import { describe, expect, it } from "vitest";
import { raycastFirstTerrain } from "./ropeRaycast";

// ---------------------------------------------------------------------------
// Minimal World mock helpers
// ---------------------------------------------------------------------------

interface MockFixture {
  kind: string;
}

interface MockRayCastHit {
  fixture: MockFixture;
  point: { x: number; y: number };
  fraction: number;
}

function makeWorld(hits: MockRayCastHit[]): World {
  return {
    rayCast: (
      _p1: unknown,
      _p2: unknown,
      callback: (
        fixture: { getBody: () => { getUserData: () => { kind: string } } },
        point: { x: number; y: number },
        normal: { x: number; y: number },
        fraction: number,
      ) => number,
    ) => {
      for (const hit of hits) {
        callback(
          {
            getBody: () => ({
              getUserData: () => ({ kind: hit.fixture.kind }),
            }),
          },
          hit.point,
          { x: 0, y: -1 },
          hit.fraction,
        );
      }
    },
  } as unknown as World;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("raycastFirstTerrain", () => {
  it("direct hit - returns hit point for a terrain fixture", () => {
    const world = makeWorld([
      {
        fixture: { kind: "terrain" },
        point: { x: 5, y: 3 },
        fraction: 0.5,
      },
    ]);

    const result = raycastFirstTerrain(world, { x: 0, y: 0 }, { x: 1, y: 0 }, 10);

    expect(result).not.toBeNull();
    expect(result?.pointMeters.x).toBeCloseTo(5);
    expect(result?.pointMeters.y).toBeCloseTo(3);
    expect(result?.fraction).toBeCloseTo(0.5);
  });

  it("no hit - returns null when no fixtures are hit", () => {
    const world = makeWorld([]);

    const result = raycastFirstTerrain(world, { x: 0, y: 0 }, { x: 1, y: 0 }, 10);

    expect(result).toBeNull();
  });

  it("multiple hits - returns closest (smallest fraction)", () => {
    const world = makeWorld([
      {
        fixture: { kind: "terrain" },
        point: { x: 8, y: 0 },
        fraction: 0.8,
      },
      {
        fixture: { kind: "terrain" },
        point: { x: 3, y: 0 },
        fraction: 0.3,
      },
      {
        fixture: { kind: "terrain" },
        point: { x: 6, y: 0 },
        fraction: 0.6,
      },
    ]);

    const result = raycastFirstTerrain(world, { x: 0, y: 0 }, { x: 1, y: 0 }, 10);

    expect(result).not.toBeNull();
    expect(result?.fraction).toBeCloseTo(0.3);
    expect(result?.pointMeters.x).toBeCloseTo(3);
  });

  it("non-terrain fixture is ignored", () => {
    const world = makeWorld([
      {
        fixture: { kind: "worm" },
        point: { x: 2, y: 0 },
        fraction: 0.2,
      },
      {
        fixture: { kind: "terrain" },
        point: { x: 7, y: 0 },
        fraction: 0.7,
      },
    ]);

    const result = raycastFirstTerrain(world, { x: 0, y: 0 }, { x: 1, y: 0 }, 10);

    // Should skip the worm and return the terrain hit
    expect(result).not.toBeNull();
    expect(result?.fraction).toBeCloseTo(0.7);
  });
});
