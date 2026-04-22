/**
 * Offline-only client sim. Epic 45 moved authoritative explosion logic
 * (AABB query, damage, impulse) to the server. This module is used only
 * by OfflineSimAdapter via fire.ts + ProjectileManager.ts; no production
 * code path outside offline imports from here.
 */
import type { World } from "planck";
import { Vec2 } from "planck";
import { toMeters } from "../physics/scale";
import type { Terrain } from "../terrain/Terrain";
import type { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import type { ExplosionConfig } from "./types";

export interface ExplodeParams {
  world: World;
  terrain: Terrain;
  centerPx: { x: number; y: number };
  config: ExplosionConfig;
  firedBy: Worm | null; // null = environmental (e.g. future landmine)
}

export interface ExplodeResult {
  damagedWorms: { worm: Worm; amount: number }[];
  selfDamageTaken: number;
}

export function explode(p: ExplodeParams): ExplodeResult {
  const { world, terrain, centerPx, config, firedBy } = p;

  // Step 1: cut terrain
  terrain.cutCircle(centerPx.x, centerPx.y, config.terrainRadiusPx);

  // Step 2: build AABB around center in meters
  const centerM = { x: toMeters(centerPx.x), y: toMeters(centerPx.y) };
  const halfSize = toMeters(config.damageRadiusPx);
  const aabb = {
    lowerBound: Vec2(centerM.x - halfSize, centerM.y - halfSize),
    upperBound: Vec2(centerM.x + halfSize, centerM.y + halfSize),
  };

  const result: ExplodeResult = { damagedWorms: [], selfDamageTaken: 0 };
  const seen = new Set<Worm>();

  // Step 3: query AABB for dynamic bodies
  world.queryAABB(aabb, (fixture) => {
    const body = fixture.getBody();
    const ud = body.getUserData() as WormUserData | null;
    if (!ud || ud.kind !== "worm") return true; // skip non-worms

    const worm = ud.worm;
    if (!worm.isAlive) return true; // skip corpses - body still in world but worm is dead
    if (seen.has(worm)) return true; // each worm once
    seen.add(worm);

    // Distance from explosion center to worm body center (meters)
    const pos = body.getPosition();
    const dx = pos.x - centerM.x;
    const dy = pos.y - centerM.y;
    const distM = Math.sqrt(dx * dx + dy * dy);
    const damageRadiusM = toMeters(config.damageRadiusPx);

    if (distM >= damageRadiusM) return true; // outside damage radius (edge inclusive = 0 dmg)

    // Linear falloff: full damage at center, zero at edge
    const falloff = Math.max(0, 1 - distM / damageRadiusM);
    const amount = Math.round(config.maxDamage * falloff);
    if (amount <= 0) return true; // no effective damage

    worm.takeDamage(amount);

    // Radial impulse away from explosion center
    const impulseMag = config.impulseMag;
    if (distM > 0.001) {
      const nx = dx / distM;
      const ny = dy / distM;
      body.applyLinearImpulse(Vec2(nx * impulseMag, ny * impulseMag), body.getPosition());
    } else {
      // Worm is at exact center - push straight up
      body.applyLinearImpulse(Vec2(0, -impulseMag), body.getPosition());
    }

    result.damagedWorms.push({ worm, amount });

    // Self-damage tracking
    if (worm === firedBy) {
      result.selfDamageTaken += amount;
    }

    return true; // continue querying
  });

  return result;
}
