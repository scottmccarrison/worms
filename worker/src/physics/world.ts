/**
 * Thin wrapper around planck.World. Server-side counterpart of
 * src/physics/PhysicsSystem.ts.
 *
 * The client's PhysicsSystem drives its own fixed-step accumulator
 * (used to keep sim deterministic vs Phaser's variable dt). Server
 * ticks on DO alarms at 20Hz (50ms) so each tick performs exactly
 * one world.step with the server timestep.
 */

import { World } from "planck";
import type { Vec2Value, World as WorldType } from "planck";

export interface WorldConfig {
  gravity?: Vec2Value;
  velocityIter?: number;
  positionIter?: number;
}

export const DEFAULT_VELOCITY_ITER = 8;
export const DEFAULT_POSITION_ITER = 3;
export const SERVER_TICK_MS = 50;
export const SERVER_TICK_SECONDS = SERVER_TICK_MS / 1000;

export function createPhysicsWorld(gravity: Vec2Value = { x: 0, y: 10 }): WorldType {
  return new World({ gravity });
}

// Re-export the planck types + helpers the rest of the worker needs,
// so other modules can import from one place.
export {
  Body,
  Box,
  Circle,
  Contact,
  Fixture,
  Vec2,
  World,
} from "planck";
export type {
  BodyDef,
  FixtureDef,
  Shape,
  Vec2Value,
  World as PlanckWorld,
} from "planck";
