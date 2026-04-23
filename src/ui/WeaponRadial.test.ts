import { describe, expect, it, vi } from "vitest";
import { WeaponRadial } from "./WeaponRadial";

// ---------------------------------------------------------------------------
// Phaser scene mock
// ---------------------------------------------------------------------------

function makeScene() {
  const tweenTargets: Array<{
    targets: unknown;
    x?: number;
    y?: number;
    alpha?: number;
    onComplete?: () => void;
  }> = [];

  const offListeners: Array<() => void> = [];
  // Map keyed by event name -> array of {handler, context} pairs
  // Phaser's input.on supports a third `context` arg; we honor it so bound methods work.
  type ListenerEntry = { handler: (...args: unknown[]) => void; context: unknown };
  const inputListeners: Map<string, Array<ListenerEntry>> = new Map();

  const input = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void, context?: unknown) => {
      if (!inputListeners.has(event)) inputListeners.set(event, []);
      inputListeners.get(event)?.push({ handler, context });
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const entries = inputListeners.get(event);
      if (entries) {
        const idx = entries.findIndex((e) => e.handler === handler);
        if (idx >= 0) entries.splice(idx, 1);
      }
      offListeners.push(() => {});
    }),
  };

  function fireInput(event: string, ...args: unknown[]) {
    const entries = inputListeners.get(event) ?? [];
    for (const { handler, context } of entries) handler.call(context, ...args);
  }

  function makeArc(_fill = 0, _alpha = 1) {
    const obj = {
      _fill,
      _strokeColor: 0,
      _strokeAlpha: 0,
      _alpha,
      setFillStyle: vi.fn((color: number) => {
        obj._fill = color;
        return obj;
      }),
      setStrokeStyle: vi.fn((_w: number, color: number, a: number) => {
        obj._strokeColor = color;
        obj._strokeAlpha = a;
        return obj;
      }),
      setAlpha: vi.fn((a: number) => {
        obj._alpha = a;
        return obj;
      }),
    };
    return obj;
  }

  function makeText() {
    const obj = {
      _text: "",
      _color: "#ffffff",
      setOrigin: vi.fn(() => obj),
      setText: vi.fn((t: string) => {
        obj._text = t;
        return obj;
      }),
      setColor: vi.fn((c: string) => {
        obj._color = c;
        return obj;
      }),
    };
    return obj;
  }

  function makeZone() {
    const listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
    const obj = {
      setOrigin: vi.fn(() => obj),
      setScrollFactor: vi.fn(() => obj),
      setDepth: vi.fn(() => obj),
      setInteractive: vi.fn(() => obj),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)?.push(handler);
        return obj;
      }),
      fire: (event: string, ...args: unknown[]) => {
        for (const h of listeners.get(event) ?? []) h(...args);
      },
    };
    return obj;
  }

  function makeContainer(x = 0, y = 0) {
    const _children: unknown[] = [];
    let _x = x;
    let _y = y;
    let _alpha = 1;
    let _scaleX = 1;
    let _scaleY = 1;
    let _depth = 0;
    let _scrollFactor = 1;
    const listeners: Map<string, Array<(...args: unknown[]) => void>> = new Map();
    const obj: {
      x: number;
      y: number;
      alpha: number;
      readonly scaleX: number;
      readonly scaleY: number;
      add: ReturnType<typeof vi.fn>;
      setDepth: ReturnType<typeof vi.fn>;
      setScrollFactor: ReturnType<typeof vi.fn>;
      setAlpha: ReturnType<typeof vi.fn>;
      setPosition: ReturnType<typeof vi.fn>;
      setScale: ReturnType<typeof vi.fn>;
      destroy: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
      fire: (event: string, ...args: unknown[]) => void;
      _children: unknown[];
      _depth: () => number;
      _scrollFactor: () => number;
    } = {
      get x() {
        return _x;
      },
      set x(v: number) {
        _x = v;
      },
      get y() {
        return _y;
      },
      set y(v: number) {
        _y = v;
      },
      get alpha() {
        return _alpha;
      },
      set alpha(v: number) {
        _alpha = v;
      },
      get scaleX() {
        return _scaleX;
      },
      get scaleY() {
        return _scaleY;
      },
      add: vi.fn((child: unknown) => {
        _children.push(child);
        return obj;
      }),
      setDepth: vi.fn((d: number) => {
        _depth = d;
        return obj;
      }),
      setScrollFactor: vi.fn((f: number) => {
        _scrollFactor = f;
        return obj;
      }),
      setAlpha: vi.fn((a: number) => {
        _alpha = a;
        return obj;
      }),
      setPosition: vi.fn((nx: number, ny: number) => {
        _x = nx;
        _y = ny;
        return obj;
      }),
      setScale: vi.fn((s: number) => {
        _scaleX = s;
        _scaleY = s;
        return obj;
      }),
      destroy: vi.fn(),
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        if (!listeners.has(event)) listeners.set(event, []);
        listeners.get(event)?.push(handler);
        return obj;
      }),
      fire: (event: string, ...args: unknown[]) => {
        for (const h of listeners.get(event) ?? []) h(...args);
      },
      _children,
      _depth: () => _depth,
      _scrollFactor: () => _scrollFactor,
    };
    return obj;
  }

  const addFns = {
    container: vi.fn(makeContainer),
    circle: vi.fn(makeArc),
    text: vi.fn(makeText),
    zone: vi.fn(makeZone),
  };

  const scene = {
    scale: { width: 1280, height: 720 },
    input,
    add: addFns,
    tweens: {
      add: vi.fn((config: (typeof tweenTargets)[number]) => {
        tweenTargets.push(config);
        // Immediately call onComplete if present (for collapse tests)
      }),
      killTweensOf: vi.fn(),
    },
    _tweenTargets: tweenTargets,
    _fireInput: fireInput,
  };

  return scene;
}

// ---------------------------------------------------------------------------
// SimAdapter mock
// ---------------------------------------------------------------------------

function makeSim() {
  return {
    selectWeapon: vi.fn(),
    getActiveWeaponId: vi.fn(() => "bazooka"),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRadial(overrides?: {
  selectedId?: string;
  ammoFor?: (id: string) => number;
}) {
  const scene = makeScene();
  const sim = makeSim();
  const radial = new WeaponRadial({
    scene: scene as never,
    sim: sim as never,
    getSelectedWeaponId: () => overrides?.selectedId ?? "bazooka",
    getAmmoFor: overrides?.ammoFor ?? (() => 5),
  });
  return { scene, sim, radial };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WeaponRadial", () => {
  it("computeIconPositions(3) returns 3 points spread across the arc", () => {
    const { radial } = makeRadial();
    const positions = radial.computeIconPositions(3);
    expect(positions).toHaveLength(3);

    // First position: 90 degrees (straight up) -> x ~= 0, y < 0
    expect(positions[0]).toBeDefined();
    expect(positions[0]?.angleDeg).toBeCloseTo(90);
    expect(positions[0]?.x).toBeCloseTo(0, 0);
    expect(positions[0]?.y).toBeLessThan(0);

    // Last position: 180 degrees (straight left) -> x < 0, y ~= 0
    expect(positions[2]).toBeDefined();
    expect(positions[2]?.angleDeg).toBeCloseTo(180);
    expect(positions[2]?.x).toBeLessThan(0);
    expect(positions[2]?.y).toBeCloseTo(0, 0);

    // Middle: 135 degrees
    expect(positions[1]).toBeDefined();
    expect(positions[1]?.angleDeg).toBeCloseTo(135);
  });

  it("computeIconPositions(1) returns a single point at 135 degrees", () => {
    const { radial } = makeRadial();
    const positions = radial.computeIconPositions(1);
    expect(positions).toHaveLength(1);
    expect(positions[0]?.angleDeg).toBeCloseTo(135);
    // At 135 deg: x = ORBIT_RADIUS * cos(135 deg) < 0, y = -ORBIT_RADIUS * sin(135 deg) < 0
    expect(positions[0]?.x).toBeLessThan(0);
    expect(positions[0]?.y).toBeLessThan(0);
  });

  it("computeIconPositions(0) returns empty array", () => {
    const { radial } = makeRadial();
    expect(radial.computeIconPositions(0)).toHaveLength(0);
  });

  it("hitsRadial(p) returns true for pointer within 40px of trigger when CLOSED", () => {
    const { radial } = makeRadial();
    // Trigger is at (1280-80, 720-80) = (1200, 640)
    const near = { x: 1205, y: 640, id: 99 } as Phaser.Input.Pointer;
    expect(radial.hitsRadial(near)).toBe(true);
  });

  it("hitsRadial(p) returns false for pointer outside 40px when CLOSED", () => {
    const { radial } = makeRadial();
    const far = { x: 100, y: 100, id: 99 } as Phaser.Input.Pointer;
    expect(radial.hitsRadial(far)).toBe(false);
  });

  it("onPointerUp while OPEN with highlighted icon calls sim.selectWeapon", () => {
    const { scene, sim, radial } = makeRadial();

    // Open by firing trigger pointerdown
    const trigX = 1200;
    const trigY = 640;
    const downPtr = { x: trigX, y: trigY, id: 1 } as Phaser.Input.Pointer;

    // Find the zone added inside container - it is the 4th child of the top container
    // We simulate by directly triggering via the global input "pointerdown" won't work -
    // we need the zone's "pointerdown". Since the zone is internal, we invoke the method
    // indirectly by sending a pointermove/pointerup via scene.input mocks.
    // Instead, we use hitsRadial to verify OPEN state after triggerDown.

    // Call onTriggerDown via private access
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );

    // Should be OPEN
    expect(radial.hitsRadial(downPtr)).toBe(true);

    // Move pointer toward angle ~90 deg (straight up from trigger)
    const movePtr = { x: trigX, y: trigY - 100, id: 1 } as Phaser.Input.Pointer;
    scene._fireInput("pointermove", movePtr);

    // Release
    const upPtr = { x: trigX, y: trigY - 100, id: 1 } as Phaser.Input.Pointer;
    scene._fireInput("pointerup", upPtr);

    // selectWeapon must have been called
    expect(sim.selectWeapon).toHaveBeenCalledOnce();
    expect(typeof (sim.selectWeapon.mock.calls[0] as [string])[0]).toBe("string");
  });

  it("onPointerUp while OPEN with no highlight does NOT call selectWeapon", () => {
    const { sim, radial } = makeRadial();

    // Open
    const downPtr = { x: 1200, y: 640, id: 2 } as Phaser.Input.Pointer;
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );

    // Release immediately at trigger position - within 40px, so highlightAtAngle skips
    const upPtr = { x: 1200, y: 640, id: 2 } as Phaser.Input.Pointer;
    // Manually ensure highlightedIdx stays -1 (release without move)
    // Private access to confirm
    const priv = radial as unknown as {
      highlightedIdx: number;
      onPointerUp: (p: Phaser.Input.Pointer) => void;
    };
    priv.onPointerUp(upPtr);

    expect(sim.selectWeapon).not.toHaveBeenCalled();
  });

  it("destroy() removes pointermove and pointerup input listeners", () => {
    const { scene, radial } = makeRadial();

    radial.destroy();

    // off should have been called for both events
    const offCalls = (scene.input.off as ReturnType<typeof vi.fn>).mock.calls as Array<
      [string, unknown]
    >;
    const events = offCalls.map((c) => c[0]);
    expect(events).toContain("pointermove");
    expect(events).toContain("pointerup");
  });

  it("quick click (no drag) leaves radial OPEN in sticky mode instead of collapsing", () => {
    const { scene, sim, radial } = makeRadial();
    const trigX = 1200;
    const trigY = 640;

    // Open radial with a pointerdown on the trigger.
    const downPtr = { x: trigX, y: trigY, id: 3 } as Phaser.Input.Pointer;
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );

    // Immediately release at the trigger position (no drag, no highlight).
    // Simulate a fast release by setting pointerDownAt to just now
    // (the threshold check is < 200ms, so releasing immediately qualifies).
    const upPtr = { x: trigX, y: trigY, id: 3 } as Phaser.Input.Pointer;
    scene._fireInput("pointerup", upPtr);

    // Radial should still be OPEN (sticky mode) - hitsRadial returns true.
    expect(radial.hitsRadial(downPtr)).toBe(true);
    // selectWeapon must NOT have been called.
    expect(sim.selectWeapon).not.toHaveBeenCalled();
  });

  it("in sticky mode, second pointerdown on an icon commits selection and closes", () => {
    const { scene, sim, radial } = makeRadial();
    const trigX = 1200;
    const trigY = 640;

    // Open + quick-release to enter sticky mode.
    const downPtr = { x: trigX, y: trigY, id: 4 } as Phaser.Input.Pointer;
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );
    scene._fireInput("pointerup", { x: trigX, y: trigY, id: 4 } as Phaser.Input.Pointer);

    // Verify sticky is set.
    const priv = radial as unknown as { stickyOpen: boolean };
    expect(priv.stickyOpen).toBe(true);

    // The icons fan out to positions based on arc math. With 7 weapons the
    // first icon is at 90 deg (straight up), so its target position is:
    //   targetX = ORBIT_RADIUS * cos(90deg) = ~0
    //   targetY = -ORBIT_RADIUS * sin(90deg) = -130
    // Absolute screen position: (trigX + 0, trigY - 130) = (1200, 510).
    // Fire a global pointerdown near that icon position.
    const iconPtr = { x: trigX, y: trigY - 130, id: 7 } as Phaser.Input.Pointer;
    scene._fireInput("pointerdown", iconPtr);

    // selectWeapon should have been called with a weapon id string.
    expect(sim.selectWeapon).toHaveBeenCalledOnce();
    expect(typeof (sim.selectWeapon.mock.calls[0] as [string])[0]).toBe("string");
    // Radial should now be closing / closed.
    expect(priv.stickyOpen).toBe(false);
  });

  it("in sticky mode, second pointerdown outside icons closes without selection", () => {
    const { scene, sim, radial } = makeRadial();
    const trigX = 1200;
    const trigY = 640;

    // Open + quick-release to enter sticky mode.
    const downPtr = { x: trigX, y: trigY, id: 8 } as Phaser.Input.Pointer;
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );
    scene._fireInput("pointerup", { x: trigX, y: trigY, id: 8 } as Phaser.Input.Pointer);

    const priv = radial as unknown as { stickyOpen: boolean };
    expect(priv.stickyOpen).toBe(true);

    // Click far away from any icon.
    scene._fireInput("pointerdown", { x: 100, y: 100, id: 9 } as Phaser.Input.Pointer);

    // No weapon selection.
    expect(sim.selectWeapon).not.toHaveBeenCalled();
    expect(priv.stickyOpen).toBe(false);
  });

  it("hitsRadial returns true for the active pointer id while OPEN", () => {
    const { radial } = makeRadial();

    const downPtr = { x: 1200, y: 640, id: 5 } as Phaser.Input.Pointer;
    (radial as unknown as { onTriggerDown: (p: Phaser.Input.Pointer) => void }).onTriggerDown(
      downPtr,
    );

    const otherPtr = { x: 500, y: 300, id: 5 } as Phaser.Input.Pointer;
    expect(radial.hitsRadial(otherPtr)).toBe(true);

    const wrongPtr = { x: 500, y: 300, id: 6 } as Phaser.Input.Pointer;
    expect(radial.hitsRadial(wrongPtr)).toBe(false);
  });
});
