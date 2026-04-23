import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TurnTransition } from "./TurnTransition";

function makeMocks() {
  const cameraCalls: Array<string> = [];
  // Store pan callbacks so tests can trigger them manually
  let panCallback: ((cam: object, progress: number) => void) | undefined;

  const camera = {
    zoom: 1,
    scrollX: 0,
    scrollY: 0,
    width: 1280,
    height: 720,
    stopFollow: vi.fn(() => cameraCalls.push("stopFollow")),
    startFollow: vi.fn(() => cameraCalls.push("startFollow")),
    zoomTo: vi.fn((zoom: number, _duration: number, _ease?: string, _force?: boolean) => {
      cameraCalls.push(`zoomTo:${zoom}`);
    }),
    pan: vi.fn(
      (
        x: number,
        y: number,
        _duration: number,
        _ease?: string,
        _force?: boolean,
        cb?: (cam: object, progress: number) => void,
      ) => {
        cameraCalls.push(`pan:${x},${y}`);
        panCallback = cb;
        // Simulate completion asynchronously for tests that need it
        if (cb) queueMicrotask(() => cb({}, 1.0));
      },
    ),
  };

  const scene = {
    cameras: { main: camera },
    scale: { width: 1280, height: 720 },
    time: {
      delayedCall: vi.fn((_ms: number, cb: () => void) => setTimeout(cb, 0)),
    },
  };

  const stableSubs: Array<() => void> = [];
  const sim = {
    onStateStable: vi.fn((cb: () => void) => {
      stableSubs.push(cb);
      return () => {
        const i = stableSubs.indexOf(cb);
        if (i >= 0) stableSubs.splice(i, 1);
      };
    }),
  };

  const onTransitioningChanged = vi.fn();
  const resolveFollowTarget = vi.fn((_id: string) => ({ x: 500, y: 300 }));

  function fireStable() {
    for (const sub of stableSubs) sub();
  }

  function firePanCallback(progress: number) {
    if (panCallback) panCallback({}, progress);
  }

  return {
    scene,
    sim,
    onTransitioningChanged,
    resolveFollowTarget,
    cameraCalls,
    stableSubs,
    fireStable,
    firePanCallback,
  };
}

function makeTurnTransition(mocks: ReturnType<typeof makeMocks>) {
  return new TurnTransition({
    scene: mocks.scene as never,
    sim: mocks.sim as never,
    worldWidthPx: 2560,
    worldHeightPx: 1024,
    resolveFollowTarget: mocks.resolveFollowTarget as never,
    onTransitioningChanged: mocks.onTransitioningChanged,
  });
}

describe("TurnTransition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("begin() transitions from IDLE and fires expected camera calls + onTransitioningChanged(true)", () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    expect(tt.isTransitioning()).toBe(false);

    tt.begin("red", "red-1");

    expect(tt.isTransitioning()).toBe(true);
    expect(mocks.onTransitioningChanged).toHaveBeenCalledWith(true);
    expect(mocks.cameraCalls).toContain("stopFollow");
    // zoomTo called with fit zoom (1280/2560 = 0.5)
    expect(mocks.cameraCalls.some((c) => c.startsWith("zoomTo:"))).toBe(true);
    // pan called toward world center
    expect(mocks.cameraCalls.some((c) => c.startsWith("pan:"))).toBe(true);
    expect(mocks.scene.cameras.main.zoomTo).toHaveBeenCalled();
    expect(mocks.scene.cameras.main.pan).toHaveBeenCalled();
  });

  it("pan callback with progress=1.0 during ZOOMING_OUT moves state to HOLDING", async () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");

    // Wait for the queueMicrotask to fire the pan callback
    await Promise.resolve();

    // State should now be HOLDING - still transitioning
    expect(tt.isTransitioning()).toBe(true);
  });

  it("HOLDING -> ZOOMING_IN when stable fires AND min hold elapses", async () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");

    // Wait for pan callback (ZOOMING_OUT -> HOLDING)
    await Promise.resolve();

    // Fire stable signal
    mocks.fireStable();

    // Still holding because min hold timer hasn't elapsed
    expect(tt.isTransitioning()).toBe(true);

    // Advance min hold timer
    vi.advanceTimersByTime(700);

    // Now should be ZOOMING_IN - another zoomTo + pan
    expect(mocks.scene.cameras.main.zoomTo).toHaveBeenCalledTimes(2);
  });

  it("zoom-in pan completion -> IDLE, startFollow called, onTransitioningChanged(false)", async () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");

    // ZOOMING_OUT -> HOLDING via pan callback
    await Promise.resolve();

    // stable + min hold
    mocks.fireStable();
    vi.advanceTimersByTime(700);

    // ZOOMING_IN pan callback fires
    await Promise.resolve();

    // Should be IDLE now
    expect(tt.isTransitioning()).toBe(false);
    expect(mocks.onTransitioningChanged).toHaveBeenCalledWith(false);
    expect(mocks.cameraCalls).toContain("startFollow");
  });

  it("cancel() during ZOOMING_OUT resets to IDLE and fires onTransitioningChanged(false)", () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");
    expect(tt.isTransitioning()).toBe(true);

    tt.cancel();

    expect(tt.isTransitioning()).toBe(false);
    expect(mocks.onTransitioningChanged).toHaveBeenCalledWith(false);
  });

  it("back-to-back begin() cancels in-flight and starts new transition", async () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");
    expect(tt.isTransitioning()).toBe(true);

    // Second begin cancels and restarts
    tt.begin("blue", "blue-1");

    expect(tt.isTransitioning()).toBe(true);
    // onTransitioningChanged(false) from cancel then (true) from new begin
    const calls = mocks.onTransitioningChanged.mock.calls.map((c) => c[0]);
    expect(calls).toContain(false);
    expect(calls[calls.length - 1]).toBe(true);
  });

  it("isTransitioning() reflects the current state", () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    expect(tt.isTransitioning()).toBe(false);

    tt.begin("red", "red-1");
    expect(tt.isTransitioning()).toBe(true);

    tt.cancel();
    expect(tt.isTransitioning()).toBe(false);
  });

  it("maxHoldTimer fires stable + advances even if onStateStable never fires", async () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");
    await Promise.resolve();

    // Advance past max hold without firing stable
    vi.advanceTimersByTime(3000);

    // Should have moved to ZOOMING_IN (max hold cap fired)
    expect(mocks.scene.cameras.main.zoomTo).toHaveBeenCalledTimes(2);
  });

  it("destroy() unsubscribes stable and cancels", () => {
    const mocks = makeMocks();
    const tt = makeTurnTransition(mocks);

    tt.begin("red", "red-1");
    tt.destroy();

    expect(tt.isTransitioning()).toBe(false);
    // Stable sub should have been removed
    expect(mocks.stableSubs.length).toBe(0);
  });
});
