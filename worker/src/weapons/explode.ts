/**
 * Server-side explode. Ported from src/weapons/explode.ts.
 *
 * Takes the terrain + an iterable of live worms + an explosion config
 * and applies:
 *   1. terrain cut at centerPx (via Terrain.cutCircle).
 *   2. AABB query for worm bodies within damageRadiusPx; linear
 *      falloff damage.
 *   3. Radial impulse on each damaged worm.
 *
 * Returns a summary so the caller can emit damage_event + worm_died
 * messages. This matches the client's ExplodeResult shape (damage per
 * worm + self-damage tally) so the port is faithful.
 */

import { Vec2 } from "planck";
import type { World } from "planck";
import { toMeters } from "../physics/scale.js";
import type { Terrain, TerrainCut } from "../entities/terrain.js";
import type { Worm, WormUserData } from "../entities/worm.js";
import type { ExplosionConfig } from "./types.js";

export interface ExplodeParams {
  world: World;
  terrain: Terrain;
  worms: Iterable<Worm>;
  centerPx: { x: number; y: number };
  config: ExplosionConfig;
  firedByWormId: string | null;
}

export interface DamagedWorm {
  wormId: string;
  amount: number;
  died: boolean;
}

export interface ExplodeResult {
  cut: TerrainCut;
  damaged: DamagedWorm[];
  selfDamageTaken: number;
}

export function explode(p: ExplodeParams): ExplodeResult {
  const { world, terrain, centerPx, config, firedByWormId } = p;

  // 1. Terrain cut (also appends to terrain's cut log).
  const cut = terrain.cutCircle(centerPx.x, centerPx.y, config.terrainRadiusPx);

  // 2. AABB query
  const centerM = { x: toMeters(centerPx.x), y: toMeters(centerPx.y) };
  const damageRadiusM = toMeters(config.damageRadiusPx);
  const halfSize = damageRadiusM;
  const aabb = {
    lowerBound: Vec2(centerM.x - halfSize, centerM.y - halfSize),
    upperBound: Vec2(centerM.x + halfSize, centerM.y + halfSize),
  };

  const damaged: DamagedWorm[] = [];
  let selfDamageTaken = 0;
  const seen = new Set<Worm>();

  world.queryAABB(aabb, (fixture) => {
    const body = fixture.getBody();
    const ud = body.getUserData() as WormUserData | null;
    if (!ud || ud.kind !== "worm") return true;
    const worm = ud.worm;
    if (!worm.alive) return true;
    if (seen.has(worm)) return true;
    seen.add(worm);

    const pos = body.getPosition();
    const dx = pos.x - centerM.x;
    const dy = pos.y - centerM.y;
    const distM = Math.sqrt(dx * dx + dy * dy);
    if (distM >= damageRadiusM) return true;

    const falloff = Math.max(0, 1 - distM / damageRadiusM);
    const amount = Math.round(config.maxDamage * falloff);
    if (amount <= 0) return true;

    const actualDamage = worm.takeDamage(amount);

    const impulseMag = config.impulseMag;
    if (distM > 0.001) {
      const nx = dx / distM;
      const ny = dy / distM;
      body.applyLinearImpulse(Vec2(nx * impulseMag, ny * impulseMag), body.getPosition());
    } else {
      body.applyLinearImpulse(Vec2(0, -impulseMag), body.getPosition());
    }

    damaged.push({ wormId: worm.id, amount: actualDamage, died: !worm.alive });
    if (firedByWormId && worm.id === firedByWormId) {
      selfDamageTaken += actualDamage;
    }
    return true;
  });

  return { cut, damaged, selfDamageTaken };
}
