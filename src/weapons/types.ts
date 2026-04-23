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
  explosion: ExplosionConfig;
}

export interface FireContext {
  world: import("planck").World;
  terrain: import("../terrain/Terrain").Terrain;
  firer: import("../worm/Worm").Worm;
  aimRadians: number;
  aimPower01: number; // 0..1
  projectileManager: import("./ProjectileManager").ProjectileManager;
}

export interface FireResult {
  turnEndsImmediately: boolean;
  shotsRemaining: number;
}
