import { describe, expect, it } from "vitest";
import { type GestureInput, createGestureTracker } from "./touchGestures";

/**
 * Helpers: a "default" GestureInput with sane test defaults, plus
 * overrides. Tests stay focused on the axis they care about.
 */
function mkInput(overrides: Partial<GestureInput> = {}): GestureInput {
  return {
    downXPx: 100,
    downYPx: 360,
    nowMs: 1000,
    screenWidth: 1280,
    wormXPx: 640,
    wormYPx: 400,
    myTurn: true,
    utilityActive: false,
    wormHitRadiusPx: 40,
    doubleTapMaxMs: 250,
    longPressMs: 400,
    ...overrides,
  };
}

describe("touchGestures state machine", () => {
  it("tap-hold left side walks left then releases", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    expect(down).toEqual([{ kind: "walk", dir: -1 }]);
    const up = t.processUp(1100);
    expect(up).toEqual([{ kind: "walk_release" }]);
  });

  it("tap-hold right side walks right then releases", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ downXPx: 900, nowMs: 1000 }));
    expect(down).toEqual([{ kind: "walk", dir: 1 }]);
    const up = t.processUp(1100);
    expect(up).toEqual([{ kind: "walk_release" }]);
  });

  it("tap on worm enters aim mode (no walk)", () => {
    const t = createGestureTracker();
    // downXPx within 40px of worm (640, 400)
    const down = t.processDown(mkInput({ downXPx: 650, downYPx: 410, nowMs: 1000 }));
    expect(down).toEqual([{ kind: "aim_start", xPx: 650, yPx: 410 }]);
    const move = t.processMove(700, 300);
    expect(move).toEqual([{ kind: "aim_move", xPx: 700, yPx: 300 }]);
    const up = t.processUp(1100);
    expect(up).toEqual([{ kind: "aim_end" }]);
  });

  it("double-tap left within window emits jump instead of second walk_release", () => {
    const t = createGestureTracker();
    // First tap: walk left + release at t=1100
    t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    const up1 = t.processUp(1100);
    expect(up1).toEqual([{ kind: "walk_release" }]);

    // Second tap: down within doubleTapMaxMs (250) on same side
    const down2 = t.processDown(mkInput({ downXPx: 220, nowMs: 1300 }));
    expect(down2).toEqual([{ kind: "walk", dir: -1 }]);
    const up2 = t.processUp(1400);
    // Release should be walk_release followed by jump.
    expect(up2).toEqual([{ kind: "walk_release" }, { kind: "jump" }]);
  });

  it("double-tap on opposite side does NOT fire jump", () => {
    const t = createGestureTracker();
    // Walk left, release
    t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    t.processUp(1100);
    // Then tap right side within window
    const down2 = t.processDown(mkInput({ downXPx: 900, nowMs: 1300 }));
    expect(down2).toEqual([{ kind: "walk", dir: 1 }]);
    const up2 = t.processUp(1400);
    expect(up2).toEqual([{ kind: "walk_release" }]);
  });

  it("tap beyond doubleTapMaxMs is a plain walk_release", () => {
    const t = createGestureTracker();
    t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    t.processUp(1100);
    // 500ms later - past the 250ms window
    const down2 = t.processDown(mkInput({ downXPx: 200, nowMs: 1600 }));
    expect(down2).toEqual([{ kind: "walk", dir: -1 }]);
    const up2 = t.processUp(1700);
    expect(up2).toEqual([{ kind: "walk_release" }]);
  });

  it("long-press emits backflip on release", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    expect(down).toEqual([{ kind: "walk", dir: -1 }]);
    // Hold past longPressMs (400) -> release at 1500
    const up = t.processUp(1500);
    expect(up).toEqual([{ kind: "walk_release" }, { kind: "backflip" }]);
  });

  it("spectator (not my turn) returns ignored on down", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ myTurn: false }));
    expect(down).toEqual([{ kind: "ignored" }]);
    // processUp after an ignored down emits nothing.
    const up = t.processUp(1100);
    expect(up).toEqual([]);
  });

  it("utility active off-worm returns ignored", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ downXPx: 200, utilityActive: true }));
    expect(down).toEqual([{ kind: "ignored" }]);
  });

  it("utility active ON worm still enters aim mode", () => {
    const t = createGestureTracker();
    const down = t.processDown(mkInput({ downXPx: 640, downYPx: 400, utilityActive: true }));
    expect(down).toEqual([{ kind: "aim_start", xPx: 640, yPx: 400 }]);
  });

  it("consuming a double-tap resets state (triple-tap is one walk)", () => {
    const t = createGestureTracker();
    // Tap 1
    t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    t.processUp(1100);
    // Tap 2 (double-tap -> jump)
    t.processDown(mkInput({ downXPx: 200, nowMs: 1300 }));
    expect(t.processUp(1400)).toEqual([{ kind: "walk_release" }, { kind: "jump" }]);
    // Tap 3 within window should NOT be a double-tap anymore (we reset).
    t.processDown(mkInput({ downXPx: 200, nowMs: 1600 }));
    expect(t.processUp(1700)).toEqual([{ kind: "walk_release" }]);
  });

  it("long-press on double-tap window prioritizes backflip over jump", () => {
    const t = createGestureTracker();
    // Seed a recent release so a double-tap would otherwise trigger.
    t.processDown(mkInput({ downXPx: 200, nowMs: 1000 }));
    t.processUp(1100);
    // Hold the second tap past longPressMs.
    t.processDown(mkInput({ downXPx: 200, nowMs: 1200 }));
    const up = t.processUp(1700);
    expect(up).toEqual([{ kind: "walk_release" }, { kind: "backflip" }]);
  });
});
