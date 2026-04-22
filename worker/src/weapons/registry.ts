import { bazooka } from "./bazooka.js";
import { handGrenade } from "./handgrenade.js";
import { shotgun } from "./shotgun.js";
import type { WeaponConfig } from "./types.js";

/** All weapons in selectKey order (1, 2, 3). */
const REGISTRY: WeaponConfig[] = [bazooka, shotgun, handGrenade];

/** All weapons as an array. */
export function allWeapons(): WeaponConfig[] {
  return REGISTRY;
}

/** Look up by numeric select key (1-9). */
export function getByKey(n: number): WeaponConfig | undefined {
  return REGISTRY.find((w) => w.selectKey === n);
}

/** Look up by string id. */
export function getById(id: string): WeaponConfig | undefined {
  return REGISTRY.find((w) => w.id === id);
}

/** Build the default ammo map for a match (id -> count). */
export function defaultAmmoForMatch(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of REGISTRY) {
    out[w.id] = w.ammoPerMatch;
  }
  return out;
}
