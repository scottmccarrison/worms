import { bazooka } from "./bazooka";
import type { WeaponConfig } from "./types";

// Drill, dynamite, handgrenade, holygrenade, minigun, shotgun are unregistered
// (source files stay for re-introduction in #16/#17 once the world layer settles).
const REGISTRY: WeaponConfig[] = [bazooka];

/** All weapons as an array. */
export function allWeapons(): WeaponConfig[] {
  return REGISTRY;
}

/** Look up by numeric select key (1-9). Returns undefined if not found. */
export function getByKey(n: number): WeaponConfig | undefined {
  return REGISTRY.find((w) => w.selectKey === n);
}

/** Look up by string id. Returns undefined if not found. */
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
