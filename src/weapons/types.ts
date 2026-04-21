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
  explosion: ExplosionConfig;
}

// Forward reference - ProjectileManager is defined in ./ProjectileManager.ts
// Using `unknown` here until ProjectileManager is created; GameScene wires the real type.
// biome-ignore lint/suspicious/noExplicitAny: forward ref resolved when ProjectileManager exists
export type ProjectileManagerRef = any;

export interface FireContext {
  world: import("planck").World;
  terrain: import("../terrain/Terrain").Terrain;
  firer: import("../worm/Worm").Worm;
  aimRadians: number;
  aimPower01: number; // 0..1
  projectileManager: ProjectileManagerRef;
}

export interface FireResult {
  turnEndsImmediately: boolean;
  shotsRemaining: number;
}
