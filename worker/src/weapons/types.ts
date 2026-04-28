/**
 * Server-side weapon config shape. Mirrors src/weapons/types.ts but
 * drops client-only helpers (FireContext / FireResult). The server
 * passes these configs into fire() / explode() directly - the
 * Simulation owns the world + terrain + projectiles list.
 */
// MUST mirror src/weapons/types.ts - kept in sync manually.

export type WeaponArchetype = "hitscan" | "projectile" | "throwable";

export interface ExplosionConfig {
  terrainRadiusPx: number;
  damageRadiusPx: number;
  maxDamage: number;
  impulseMag: number;
}

export interface WeaponConfig {
  id: string;
  name: string;
  archetype: WeaponArchetype;
  ammoPerMatch: number; // -1 infinite
  selectKey: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  iconColor: number;
  iconLabel: string;
  projectileColor?: number;
  projectileRadiusPx?: number;
  fuseMs?: number;
  restitution?: number;
  shotsPerActivation?: number;
  powerCapMps?: number;
  /**
   * If set, a projectile's body continuously carves terrain at the given
   * radius + cadence while in flight. Used by Drill.
   */
  tunnel?: { cutRadiusPx: number; cutIntervalMs: number };
  /**
   * If set, hitscan fires with a random per-shot angle jitter in radians
   * (uniformly sampled in [-spread, +spread]). Used by Minigun.
   */
  hitscanSpreadRad?: number;
  /**
   * If false, wind force is not applied to this weapon's projectiles. Default true.
   * Hitscan weapons set this explicitly to false for self-documentation; they
   * never go through the wind-apply loop today, but the explicit flag prevents
   * a future regression if they ever do.
   */
  affectedByWind?: boolean;
  explosion: ExplosionConfig;
}
