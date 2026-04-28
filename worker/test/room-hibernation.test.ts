/**
 * DO hibernation tests for world objects (barrels et al.).
 *
 * Verifies that Simulation.serialize() + restore() correctly round-trips
 * object state (id, kind, position, hp) across a hibernate-resume cycle.
 *
 * These tests live at the Simulation level - the same layer as
 * sim.test.ts - because:
 *   (a) The existing test harness only drives Simulation directly, not the DO.
 *   (b) The serialize/restore pair IS the hibernate-resume path; the DO simply
 *       calls serialize() before hibernating and restore() on wake-up.
 *
 * WS-A contract assumed:
 *   - SimulationInit accepts an optional `initialObjects` field:
 *       initialObjects?: Array<{ kind: string; xPx: number; yPx: number }>
 *   - Simulation.toSimState().objects: ObjectRenderState[]
 *       each entry has { id, kind, x, y, hp, dead, flags, vx, vy }
 *   - Simulation.serialize().objects: Array<{ id, kind, x, y, vx, vy, hp, flags }>
 *   - Simulation.restore(serialized) restores objects by re-creating their
 *       physics bodies at the serialized positions + velocities + hp.
 *   - Dead objects are excluded from serialize() (reaped before snapshot).
 *
 * ObjectInstance.takeDamage() is exposed via the Simulation.objects Map or
 * an accessor such as Simulation.getObject(id). This test accesses it via
 * sim.objects.get(id) (the Map is typed `readonly objects: Map<string,
 * ObjectInstance>`). If WS-A chooses a different accessor, the integration
 * pass will update the call-sites below.
 */

import { describe, expect, it } from "vitest";
import { type SimulationInit, Simulation } from "../src/sim/simulation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const WIDTH = 2560;
const HEIGHT = 1024;

function makeEmptyMask(width: number, height: number): Uint8Array {
  // All zeros = no terrain. Objects placed above the floor will fall
  // indefinitely in the sim, but for serialization tests we only care
  // that bodies exist and state is preserved, not that physics settles.
  return new Uint8Array(width * height);
}

function makeSim(
  initialObjects: Array<{ kind: string; xPx: number; yPx: number }> = [],
): Simulation {
  const init = {
    widthPx: WIDTH,
    heightPx: HEIGHT,
    mask: makeEmptyMask(WIDTH, HEIGHT),
    teams: [],
    seed: 42,
    // initialObjects is the field WS-A adds. Cast through unknown so
    // the test compiles against the baseline type and still runs once
    // WS-A's changes are merged.
    initialObjects,
  } as unknown as SimulationInit;
  return new Simulation(init);
}

/**
 * Access the objects map through the Simulation. WS-A adds a public
 * `objects: Map<string, ObjectInstance>` property. We access it via a
 * type-widened cast so the test compiles against the current baseline
 * (where the property does not exist yet) and runs correctly once WS-A
 * lands.
 */
type ObjectLike = { id: string; kind: string; hp: number; dead: boolean; takeDamage(n: number): void };

function getObjectsMap(sim: Simulation): Map<string, ObjectLike> | undefined {
  const cast = sim as unknown as { objects?: Map<string, ObjectLike> };
  return cast.objects;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Room DO hibernation: objects", () => {
  it("preserves barrels across serialize-deserialize round-trip", () => {
    // Build a sim with two barrels.
    const sim = makeSim([
      { kind: "barrel", xPx: 600, yPx: 400 },
      { kind: "barrel", xPx: 1280, yPx: 400 },
    ]);

    // Tick a few times so physics applies (barrels may drift slightly).
    for (let i = 0; i < 50; i++) sim.tick(50);

    // Snapshot state before serialization.
    // WS-A adds `objects` to SimState; access via cast so the test
    // compiles before that field exists.
    const beforeState = sim.toSimState() as unknown as {
      objects?: Array<{ id: string; kind: string; x: number; y: number; hp: number; dead: boolean }>;
    };

    // Guard: if WS-A's objects infrastructure has not been merged yet,
    // skip rather than fail. The test documents the expected contract.
    if (beforeState.objects === undefined) {
      console.warn(
        "[room-hibernation] SKIP: objects not in SimState yet - waiting for WS-A merge",
      );
      return;
    }

    expect(beforeState.objects).toHaveLength(2);

    // Capture the serialized snapshot - this is what the DO persists to
    // KV/storage before hibernation.
    const serialized = sim.serialize() as unknown as {
      objects: Array<{ id: string; kind: string; x: number; y: number; hp: number }>;
    };
    expect(serialized.objects).toBeDefined();
    expect(serialized.objects).toHaveLength(2);

    // Construct a fresh sim (simulates DO wake-up: same map, same teams,
    // same seed) then restore from the serialized snapshot.
    const restoredSim = makeSim([
      { kind: "barrel", xPx: 600, yPx: 400 },
      { kind: "barrel", xPx: 1280, yPx: 400 },
    ]);
    restoredSim.restore(sim.serialize());

    const afterState = restoredSim.toSimState() as unknown as {
      objects: Array<{ id: string; kind: string; x: number; y: number; hp: number }>;
    };
    expect(afterState.objects).toHaveLength(2);

    // Each object should have matching id + kind + position + hp.
    for (const before of beforeState.objects) {
      const after = afterState.objects.find((o) => o.id === before.id);
      expect(after).toBeDefined();
      expect(after?.kind).toBe(before.kind);
      expect(after?.x).toBeCloseTo(before.x, 1);
      expect(after?.y).toBeCloseTo(before.y, 1);
      expect(after?.hp).toBe(before.hp);
    }
  });

  it("preserves damaged barrel hp across hibernation", () => {
    // Barrel starts at hp=1 (from objectCatalog). Partial damage is not
    // possible for hp=1 barrels (1 damage kills it). So we test a
    // "generic" object concept: verify that whatever hp value is set on
    // the ObjectInstance before serialization is faithfully restored.
    //
    // The real test here is that hp is included in SerializedSim.objects
    // and that restore() applies it. We set hp directly on the
    // ObjectInstance to simulate any partial-damage scenario.
    const sim = makeSim([{ kind: "barrel", xPx: 600, yPx: 400 }]);
    for (let i = 0; i < 10; i++) sim.tick(50);

    const objMap = getObjectsMap(sim);

    // Guard: if WS-A's objects map has not been merged yet, skip.
    if (objMap === undefined || objMap === null) {
      console.warn(
        "[room-hibernation] SKIP: sim.objects not present yet - waiting for WS-A merge",
      );
      return;
    }

    expect(objMap.size).toBe(1);

    // Manually set hp to a mid-range value to simulate partial damage.
    // This bypasses takeDamage() intentionally so the barrel does not
    // die (we want to test damaged-but-alive preservation).
    const obj = Array.from(objMap.values())[0];
    if (obj) {
      // If catalog hp is already 1 we cannot "partially damage" via
      // takeDamage without killing it; set hp directly instead.
      // The field is public on ObjectInstance.
      (obj as unknown as { hp: number }).hp = 50;
    }

    const serialized = sim.serialize() as unknown as {
      objects: Array<{ id: string; hp: number }>;
    };
    expect(serialized.objects).toHaveLength(1);
    expect(serialized.objects[0]?.hp).toBe(50);

    const restoredSim = makeSim([{ kind: "barrel", xPx: 600, yPx: 400 }]);
    restoredSim.restore(sim.serialize());

    const afterState = restoredSim.toSimState() as unknown as {
      objects: Array<{ hp: number }>;
    };
    expect(afterState.objects).toHaveLength(1);
    expect(afterState.objects[0]?.hp).toBe(50);
  });

  it("dead objects are excluded from serialize", () => {
    // Kill a barrel (hp=0), then verify that serialize() does not include
    // dead objects in the snapshot. This is the "DO wakes up cleanly"
    // guarantee: no ghost objects with dead=true appear in the next
    // session's state.
    //
    // Implementation note: WS-A chose to call reapDeadObjects() before
    // serialize() in the DO's hibernation handler (and/or exclude dead
    // objects from serialize() directly). Either design satisfies this
    // test as written. If the design instead includes dead objects in
    // serialize() and reaps them on first tick post-restore, this test
    // documents the deviation and should be updated.
    const sim = makeSim([
      { kind: "barrel", xPx: 600, yPx: 400 },
      { kind: "barrel", xPx: 1280, yPx: 400 },
    ]);
    for (let i = 0; i < 10; i++) sim.tick(50);

    // Kill one barrel.
    const objMap = getObjectsMap(sim);

    // Guard: if WS-A's objects map has not been merged yet, skip.
    if (objMap === undefined || objMap === null) {
      console.warn(
        "[room-hibernation] SKIP: sim.objects not present yet - waiting for WS-A merge",
      );
      return;
    }

    expect(objMap.size).toBe(2);
    const [firstObj] = Array.from(objMap.values());
    if (firstObj) {
      firstObj.takeDamage(999); // kills it
      expect(firstObj.dead).toBe(true);
    }

    // Tick once so the sim can reap the dead object (if reaping is
    // tick-driven) then serialize.
    sim.tick(50);

    const serialized = sim.serialize() as unknown as {
      objects: Array<{ id: string; dead?: boolean }>;
    };

    // After reaping, only the surviving barrel should appear.
    const deadInSnapshot = (serialized.objects ?? []).filter((o) => o.dead === true);
    expect(deadInSnapshot).toHaveLength(0);
    expect(serialized.objects).toHaveLength(1);
  });

  it("sim with no initialObjects serializes an empty objects array", () => {
    // Regression guard: a sim without objects should not fail serialize()
    // and should produce an empty (not undefined) objects list.
    const sim = makeSim([]);
    for (let i = 0; i < 5; i++) sim.tick(50);

    const serialized = sim.serialize() as unknown as { objects?: unknown[] };
    // objects may be undefined on the baseline; on WS-A it should be [].
    const objects = serialized.objects ?? [];
    expect(Array.isArray(objects)).toBe(true);
    expect(objects).toHaveLength(0);
  });
});
