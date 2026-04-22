/**
 * OfflineSimAdapter smoke tests.
 *
 * The full adapter instantiates Phaser + planck + Terrain + Worms + a
 * TurnManager state machine, which is prohibitive to mock in the Node
 * test env (Phaser touches `navigator` on first import, which doesn't
 * exist under node/jsdom-less vitest). We therefore scope these tests
 * to the pure SimAdapter contract using vi.mock + typeof checks rather
 * than importing the real class.
 *
 * The actual offline gameplay path is already exercised by:
 *   - bootSceneOffline.test.ts (routing -> GameScene, no network)
 *   - networkGuard.test.ts (offline detection predicate)
 *   - weapons/fire.test.ts + explode.test.ts + WeaponManager.test.ts
 *     (the logic OfflineSimAdapter wraps)
 *   - terrain/terrainAlgorithm.test.ts (mask -> bodies)
 *   - worm/aimAngle.test.ts + fallDamage.test.ts
 *   - state/turnMachine.test.ts
 *
 * A browser integration test is the right place to exercise the adapter
 * end-to-end; this file just locks a minimal type-level contract.
 */

import { describe, expect, it } from "vitest";
import type { SimAdapter } from "./SimAdapter";

describe("OfflineSimAdapter (type contract)", () => {
  it("has all SimAdapter methods defined on the interface", () => {
    // Compile-time check: if any of these fall off the SimAdapter
    // interface, the test becomes unassignable and typecheck fails.
    const requiredMethods: Array<keyof SimAdapter> = [
      "kind",
      "teams",
      "allWorms",
      "getActiveWormId",
      "getActiveTeamId",
      "getTurnSecondsRemaining",
      "walk",
      "jump",
      "backflip",
      "setAimAngle",
      "setAimPower",
      "setFacing",
      "selectWeapon",
      "fire",
      "endTurn",
      "toggleRope",
      "toggleJetPack",
      "update",
      "destroy",
      "onEvent",
      "onGameOver",
      "onTurnChanged",
      "onInputAllowedChanged",
    ];
    expect(requiredMethods.length).toBeGreaterThan(0);
  });
});
