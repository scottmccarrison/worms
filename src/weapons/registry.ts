import { bazooka } from "./bazooka";
import { drill } from "./drill";
import { dynamite } from "./dynamite";
import { handGrenade } from "./handgrenade";
import { holyGrenade } from "./holygrenade";
import { minigun } from "./minigun";
import { shotgun } from "./shotgun";
import type { WeaponConfig } from "./types";

/** All weapons in selectKey order (1-7). */
const REGISTRY: WeaponConfig[] = [
  bazooka,
  shotgun,
  handGrenade,
  dynamite,
  holyGrenade,
  minigun,
  drill,
];

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
