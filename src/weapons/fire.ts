/**
 * Offline-only client sim: spawns projectiles + runs hitscan on the local
 * planck world. Epic 45 moved authoritative fire logic to the server; this
 * module now runs exclusively under OfflineSimAdapter. No other part of the
 * client (GameScene, NetworkedSimAdapter) imports from here.
 */
import { tuning } from "../tuning";
import { explode } from "./explode";
import { raycastFirstHit } from "./hitscan";
import type { FireContext, FireResult, WeaponConfig } from "./types";

// ---------------------------------------------------------------------------
// Main dispatcher
// ---------------------------------------------------------------------------

/**
 * Fire the weapon described by `weapon` with the given context.
 * Returns a FireResult indicating whether the turn should end and how many
 * shots remain in this activation.
 *
 * @param shotsFiredBefore - how many shots have already been fired this activation
 */
export function fire(weapon: WeaponConfig, ctx: FireContext, shotsFiredBefore: number): FireResult {
  switch (weapon.archetype) {
    case "hitscan":
      return fireHitscan(weapon, ctx, shotsFiredBefore);
    case "projectile":
      return fireProjectile(weapon, ctx);
    case "throwable":
      return fireThrowable(weapon, ctx);
  }
}

// ---------------------------------------------------------------------------
// Hitscan (Shotgun)
// ---------------------------------------------------------------------------

function fireHitscan(weapon: WeaponConfig, ctx: FireContext, shotsFiredBefore: number): FireResult {
  const { world, terrain, firer, aimRadians } = ctx;
  const shotsAllowed = weapon.shotsPerActivation ?? 1;

  // Apply per-shot angle jitter if weapon has hitscanSpreadRad set (e.g. Minigun).
  const spread = weapon.hitscanSpreadRad ?? 0;
  // Bates-2 (triangular) distribution biases toward center, removing visible
  // outliers. Sum of two uniforms peaks at 0; ~50% of pellets within +/-0.29*spread
  // vs uniform's +/-0.5*spread.
  const jitter = spread > 0
    ? ((Math.random() - 0.5) + (Math.random() - 0.5)) * spread
    : 0;
  const shotAngle = aimRadians + jitter;

  // Compute ray endpoints
  const wormRadiusPx = tuning.worm.radiusPx;
  const originPx = {
    x: firer.xPx + Math.cos(shotAngle) * firer.facing * wormRadiusPx * 1.5,
    y: firer.yPx + Math.sin(shotAngle) * wormRadiusPx * 1.5,
  };
  const rayLengthPx = 2000;
  const endPx = {
    x: originPx.x + Math.cos(shotAngle) * firer.facing * rayLengthPx,
    y: originPx.y + Math.sin(shotAngle) * rayLengthPx,
  };

  const hit = raycastFirstHit(world, originPx, endPx, firer.body);
  if (hit) {
    explode({
      world,
      terrain,
      centerPx: hit.pointPx,
      config: weapon.explosion,
      firedBy: firer,
    });
  }

  const shotsFiredNow = shotsFiredBefore + 1;
  const shotsRemaining = shotsAllowed - shotsFiredNow;

  return {
    turnEndsImmediately: shotsFiredNow >= shotsAllowed,
    shotsRemaining: Math.max(0, shotsRemaining),
  };
}

// ---------------------------------------------------------------------------
// Projectile (Bazooka)
// ---------------------------------------------------------------------------

function fireProjectile(weapon: WeaponConfig, ctx: FireContext): FireResult {
  const { firer, aimRadians, aimPower01, projectileManager } = ctx;

  const wormRadiusPx = tuning.worm.radiusPx;
  const projRadiusPx = weapon.projectileRadiusPx ?? 5;

  // Spawn just in front of the worm
  const spawnOffset = wormRadiusPx + projRadiusPx + 2;
  const originPx = {
    x: firer.xPx + Math.cos(aimRadians) * firer.facing * spawnOffset,
    y: firer.yPx + Math.sin(aimRadians) * spawnOffset,
  };

  const powerCap = weapon.powerCapMps ?? 20;
  const speed = aimPower01 * powerCap;
  const velocityMps = {
    x: Math.cos(aimRadians) * firer.facing * speed,
    y: Math.sin(aimRadians) * speed,
  };

  projectileManager.spawn({
    weapon,
    firer,
    originPx,
    velocityMps,
    fuseMs: weapon.fuseMs ?? null, // null = contact-only; set for timed projectiles like Drill
  });

  return { turnEndsImmediately: true, shotsRemaining: 0 };
}

// ---------------------------------------------------------------------------
// Throwable (HandGrenade)
// ---------------------------------------------------------------------------

function fireThrowable(weapon: WeaponConfig, ctx: FireContext): FireResult {
  const { firer, aimRadians, aimPower01, projectileManager } = ctx;

  const wormRadiusPx = tuning.worm.radiusPx;
  const projRadiusPx = weapon.projectileRadiusPx ?? 6;

  const spawnOffset = wormRadiusPx + projRadiusPx + 2;
  const originPx = {
    x: firer.xPx + Math.cos(aimRadians) * firer.facing * spawnOffset,
    y: firer.yPx + Math.sin(aimRadians) * spawnOffset,
  };

  const powerCap = weapon.powerCapMps ?? 14;
  const speed = aimPower01 * powerCap;
  const velocityMps = {
    x: Math.cos(aimRadians) * firer.facing * speed,
    y: Math.sin(aimRadians) * speed,
  };

  projectileManager.spawn({
    weapon,
    firer,
    originPx,
    velocityMps,
    fuseMs: weapon.fuseMs ?? 3000,
  });

  return { turnEndsImmediately: true, shotsRemaining: 0 };
}
