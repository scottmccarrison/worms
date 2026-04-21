import { Box, Circle, World } from "planck";
import { describe, expect, it } from "vitest";
import { toMeters } from "../physics/scale";
import { raycastFirstHit } from "./hitscan";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a static box body at the given center (pixels), half-extents in px. */
function makeStaticBox(
  world: ReturnType<typeof World>,
  cxPx: number,
  cyPx: number,
  hwPx: number,
  hhPx: number,
) {
  const body = world.createBody({
    type: "static",
    position: { x: toMeters(cxPx), y: toMeters(cyPx) },
  });
  body.createFixture({ shape: new Box(toMeters(hwPx), toMeters(hhPx)) });
  return body;
}

/** Create a dynamic circle body at the given center (pixels). */
function makeDynamicCircle(world: ReturnType<typeof World>, xPx: number, yPx: number, rPx: number) {
  const body = world.createBody({
    type: "dynamic",
    position: { x: toMeters(xPx), y: toMeters(yPx) },
  });
  body.createFixture({ shape: new Circle(toMeters(rPx)) });
  return body;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("raycastFirstHit()", () => {
  it("returns null when nothing between from and to", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    const from = { x: 0, y: 0 };
    const to = { x: 500, y: 0 };
    const hit = raycastFirstHit(world, from, to);
    expect(hit).toBeNull();
  });

  it("returns the closer of two fixtures on the ray", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    // Ray fires right along y=360 (horizontal mid-screen)
    const from = { x: 0, y: 360 };
    const to = { x: 1280, y: 360 };

    // Two boxes: near one at x=200, far one at x=600
    makeStaticBox(world, 200, 360, 20, 20);
    makeStaticBox(world, 600, 360, 20, 20);

    const hit = raycastFirstHit(world, from, to);
    expect(hit).not.toBeNull();
    // Hit point should be near x=180 (left edge of near box at x=200 - 20 half-width)
    expect(hit?.pointPx.x).toBeCloseTo(180, 0);
  });

  it("excludes firer's own body", () => {
    const world = World({ gravity: { x: 0, y: 10 } });
    // Ray fires right
    const from = { x: 0, y: 360 };
    const to = { x: 1280, y: 360 };

    // Firer body right at the start of the ray
    const firerBody = makeDynamicCircle(world, 0, 360, 12);
    // Another target further along
    makeStaticBox(world, 400, 360, 20, 20);

    const hit = raycastFirstHit(world, from, to, firerBody);
    expect(hit).not.toBeNull();
    // Should NOT hit the firer; should hit the box at ~x=380
    expect(hit?.fixture.getBody()).not.toBe(firerBody);
    expect(hit?.pointPx.x).toBeGreaterThan(200);
  });
});
