/**
 * Server-side fire. Ported from src/weapons/fire.ts.
 *
 * Takes:
 *   - world: the planck World
 *   - firer: the shooting Worm
 *   - weapon: the weapon config
 *   - terrain: for hitscan (shotgun raycast -> explode)
 *   - worms: live worms for hitscan (explode needs them)
 *   - spawnProjectile: callback invoked for projectile + throwable
 *
 * Returns a FireResult describing shots remaining + whether the turn
 * should end. The Simulation drives the spawn callback (so it can
 * manage id assignment + its projectiles array) and separately
 * invokes explode() with shotgun hit coords.
 */

import type { World } from "planck";
import { toMeters, toPixels } from "../physics/scale.js";
import type { Terrain } from "../entities/terrain.js";
import { DEFAULT_WORM_RADIUS_PX, type Worm } from "../entities/worm.js";
import { explode, type ExplodeResult } from "./explode.js";
import type { WeaponConfig } from "./types.js";

export interface FireResult {
  turnEndsImmediately: boolean;
  shotsRemaining: number;
  /** Non-null for hitscan hits (explosion applied); caller emits events. */
  explodeResults: ExplodeResult[];
  /** Non-null for projectile/throwable; caller spawns the Projectile. */
  spawn: FireSpawnSpec | null;
}

export interface FireSpawnSpec {
  weapon: WeaponConfig;
  ownerId: string;
  originPx: { x: number; y: number };
  velocityMps: { x: number; y: number };
  fuseMs: number | null;
}

export interface FireContext {
  world: World;
  terrain: Terrain;
  worms: Iterable<Worm>;
  firer: Worm;
  weapon: WeaponConfig;
  aimRadians: number;
  aimPower01: number;
  shotsFiredBefore: number;
}

export function fire(ctx: FireContext): FireResult {
  switch (ctx.weapon.archetype) {
    case "hitscan":
      return fireHitscan(ctx);
    case "projectile":
      return fireProjectile(ctx);
    case "throwable":
      return fireThrowable(ctx);
  }
}

// ---- archetype implementations ----

function fireHitscan(ctx: FireContext): FireResult {
  const { world, terrain, worms, firer, weapon, aimRadians, shotsFiredBefore } = ctx;
  const shotsAllowed = weapon.shotsPerActivation ?? 1;
  const wormRadiusPx = DEFAULT_WORM_RADIUS_PX;
  const xPx = toPixels(firer.body.getPosition().x);
  const yPx = toPixels(firer.body.getPosition().y);
  const originPx = {
    x: xPx + Math.cos(aimRadians) * firer.facing * wormRadiusPx * 1.5,
    y: yPx + Math.sin(aimRadians) * wormRadiusPx * 1.5,
  };
  const rayLengthPx = 2000;
  const endPx = {
    x: originPx.x + Math.cos(aimRadians) * firer.facing * rayLengthPx,
    y: originPx.y + Math.sin(aimRadians) * rayLengthPx,
  };

  const explodeResults: ExplodeResult[] = [];
  const hit = raycastFirstHit(world, originPx, endPx, firer);
  if (hit) {
    const result = explode({
      world,
      terrain,
      worms,
      centerPx: hit.pointPx,
      config: weapon.explosion,
      firedByWormId: firer.id,
    });
    explodeResults.push(result);
  }

  const shotsFiredNow = shotsFiredBefore + 1;
  const shotsRemaining = shotsAllowed - shotsFiredNow;
  return {
    turnEndsImmediately: shotsFiredNow >= shotsAllowed,
    shotsRemaining: Math.max(0, shotsRemaining),
    explodeResults,
    spawn: null,
  };
}

function fireProjectile(ctx: FireContext): FireResult {
  const { firer, weapon, aimRadians, aimPower01 } = ctx;
  const wormRadiusPx = DEFAULT_WORM_RADIUS_PX;
  const projRadiusPx = weapon.projectileRadiusPx ?? 5;
  const spawnOffset = wormRadiusPx + projRadiusPx + 2;
  const xPx = toPixels(firer.body.getPosition().x);
  const yPx = toPixels(firer.body.getPosition().y);
  const originPx = {
    x: xPx + Math.cos(aimRadians) * firer.facing * spawnOffset,
    y: yPx + Math.sin(aimRadians) * spawnOffset,
  };
  const powerCap = weapon.powerCapMps ?? 20;
  const speed = aimPower01 * powerCap;
  const velocityMps = {
    x: Math.cos(aimRadians) * firer.facing * speed,
    y: Math.sin(aimRadians) * speed,
  };

  return {
    turnEndsImmediately: true,
    shotsRemaining: 0,
    explodeResults: [],
    spawn: {
      weapon,
      ownerId: firer.id,
      originPx,
      velocityMps,
      fuseMs: null,
    },
  };
}

function fireThrowable(ctx: FireContext): FireResult {
  const { firer, weapon, aimRadians, aimPower01 } = ctx;
  const wormRadiusPx = DEFAULT_WORM_RADIUS_PX;
  const projRadiusPx = weapon.projectileRadiusPx ?? 6;
  const spawnOffset = wormRadiusPx + projRadiusPx + 2;
  const xPx = toPixels(firer.body.getPosition().x);
  const yPx = toPixels(firer.body.getPosition().y);
  const originPx = {
    x: xPx + Math.cos(aimRadians) * firer.facing * spawnOffset,
    y: yPx + Math.sin(aimRadians) * spawnOffset,
  };
  const powerCap = weapon.powerCapMps ?? 14;
  const speed = aimPower01 * powerCap;
  const velocityMps = {
    x: Math.cos(aimRadians) * firer.facing * speed,
    y: Math.sin(aimRadians) * speed,
  };

  return {
    turnEndsImmediately: true,
    shotsRemaining: 0,
    explodeResults: [],
    spawn: {
      weapon,
      ownerId: firer.id,
      originPx,
      velocityMps,
      fuseMs: weapon.fuseMs ?? 3000,
    },
  };
}

// ---- Hitscan raycast helper ----

interface RaycastHit {
  pointPx: { x: number; y: number };
  normal: { x: number; y: number };
}

function raycastFirstHit(
  world: World,
  fromPx: { x: number; y: number },
  toPx: { x: number; y: number },
  firer: Worm,
): RaycastHit | null {
  let closest: RaycastHit | null = null;
  let closestFrac = 1;

  world.rayCast(
    { x: toMeters(fromPx.x), y: toMeters(fromPx.y) },
    { x: toMeters(toPx.x), y: toMeters(toPx.y) },
    (fixture, point, normal, fraction) => {
      if (fixture.getBody() === firer.body) return -1;
      if (fraction < closestFrac) {
        closestFrac = fraction;
        closest = {
          pointPx: { x: toPixels(point.x), y: toPixels(point.y) },
          normal: { x: normal.x, y: normal.y },
        };
      }
      return fraction;
    },
  );

  return closest;
}
