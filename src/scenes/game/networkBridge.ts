/**
 * Pure bridge between the Colyseus room and the local GameScene simulation.
 *
 * Deliberately has NO dependencies on Phaser or planck so its behavior can be
 * unit-tested with plain objects (see networkBridge.test.ts). GameScene is the
 * only caller; it supplies real Worm/Team instances which satisfy the duck
 * types declared here.
 *
 * Three responsibilities:
 * 1. `applyRemoteInput` - map a relayed input message onto the active worm.
 * 2. `buildTurnSnapshot` - serialize current worm + terrain state for
 *    `turn_snapshot`.
 * 3. `setWormFromSnapshot` - snap a worm back to the server's authoritative
 *    position / velocity / hp at turn end.
 *
 * Epic 9 scope: no fire handling here - fire is GameScene-level because it
 * needs the WeaponManager + ProjectileManager context. `applyRemoteInput`
 * treats `"fire"` as a no-op and returns; GameScene handles the relay
 * separately by calling its own `fire()` path.
 */

import type { CircleCut, TurnSnapshotMessage, WormSnapshot } from "../../net/types";
import { toMeters, toPixels } from "../../physics/scale";

/**
 * Duck-typed worm interface used by `applyRemoteInput`.
 * Mirrors the subset of the real `Worm` class's API that remote inputs drive.
 * Tests pass plain objects shaped like this.
 */
export interface WormLike {
  walk(direction: -1 | 0 | 1): void;
  jump(): void;
  backflip(): void;
  setAimAngle(rad: number): void;
  setAimPower(p: number): void;
  setFacing(dir: -1 | 1): void;
}

/**
 * Duck-typed Team used by `buildTurnSnapshot`. We read only `id` + `worms`.
 */
export interface TeamLike {
  id: string;
  worms: WormSnapshotSource[];
}

/**
 * Minimal interface a worm must satisfy to be serialized into a snapshot.
 * Matches the real `Worm` fields (name, body, health, isAlive) at runtime.
 */
export interface WormSnapshotSource {
  name: string;
  health: number;
  isAlive: boolean;
  body: {
    getPosition(): { x: number; y: number };
    getLinearVelocity(): { x: number; y: number };
  };
}

/**
 * Minimal interface a worm must satisfy to be snapped FROM a snapshot.
 */
export interface WormSnapshotApplyTarget {
  name: string;
  health: number;
  isAlive: boolean;
  body: {
    setPosition(p: { x: number; y: number }): void;
    setLinearVelocity(v: { x: number; y: number }): void;
    setAwake(awake: boolean): void;
  };
}

/**
 * Apply a relayed input message to the currently-active remote worm.
 *
 * The active worm is NOT looked up here - the caller identifies it via
 * `state.currentWormId` and passes it in. This keeps the bridge decoupled
 * from scene state.
 *
 * Unknown types and `"fire"` are no-ops (see file-level comment).
 */
export function applyRemoteInput(worm: WormLike, type: string, payload: unknown): void {
  const p = payload as Record<string, unknown> | undefined;
  switch (type) {
    case "walk":
    case "input_walk": {
      const dir = (p?.dir as -1 | 0 | 1 | undefined) ?? 0;
      worm.walk(dir);
      return;
    }
    case "jump":
    case "input_jump":
      worm.jump();
      return;
    case "backflip":
    case "input_backflip":
      worm.backflip();
      return;
    case "aim_angle":
    case "input_aim_angle": {
      const angle = typeof p?.angleRad === "number" ? p.angleRad : 0;
      worm.setAimAngle(angle);
      return;
    }
    case "aim_power":
    case "input_aim_power": {
      const power = typeof p?.power === "number" ? p.power : 0;
      worm.setAimPower(power);
      return;
    }
    case "facing": {
      const dir = (p?.dir as -1 | 1 | undefined) ?? 1;
      worm.setFacing(dir);
      return;
    }
    // fire is GameScene-level (needs WeaponManager); bridge is a no-op.
    case "fire":
    case "input_fire":
      return;
    default:
      // Unknown types are silently ignored so forward-compat message types
      // from a newer server don't crash older clients.
      return;
  }
}

/**
 * Build a WormSnapshot array from live teams. Positions converted from meters
 * to pixels here so the wire format stays in screen space (same unit the
 * client displays and the terrain uses).
 */
export function buildTurnSnapshot(teams: TeamLike[], cuts: CircleCut[]): TurnSnapshotMessage {
  const worms: WormSnapshot[] = [];
  for (const team of teams) {
    for (const w of team.worms) {
      const pos = w.body.getPosition();
      const vel = w.body.getLinearVelocity();
      worms.push({
        id: w.name,
        x: toPixels(pos.x),
        y: toPixels(pos.y),
        vx: vel.x,
        vy: vel.y,
        hp: w.health,
        alive: w.isAlive,
      });
    }
  }
  // Defensive copy so callers can't mutate the outgoing message post-send.
  return { worms, terrainCuts: cuts.slice() };
}

/**
 * Snap a worm to the given snapshot. Position comes in pixels (wire format),
 * velocity in m/s. Body is woken so physics re-engages immediately - a resting
 * body would otherwise ignore the new velocity until the next contact.
 */
export function setWormFromSnapshot(worm: WormSnapshotApplyTarget, snap: WormSnapshot): void {
  worm.body.setPosition({
    x: toMeters(snap.x),
    y: toMeters(snap.y),
  });
  worm.body.setLinearVelocity({ x: snap.vx, y: snap.vy });
  worm.body.setAwake(true);
  worm.health = snap.hp;
  worm.isAlive = snap.alive;
}
