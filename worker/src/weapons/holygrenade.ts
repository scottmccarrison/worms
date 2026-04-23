import type { WeaponConfig } from "./types.js";

export const holyGrenade: WeaponConfig = {
  id: "holygrenade",
  name: "Holy Grenade",
  archetype: "throwable",
  ammoPerMatch: 2, // limited - only 2 per match
  selectKey: 5,
  iconColor: 0xffd700,
  iconLabel: "H",
  projectileColor: 0xffd700,
  projectileRadiusPx: 7,
  fuseMs: 4000,
  restitution: 0.6,
  powerCapMps: 14,
  explosion: {
    terrainRadiusPx: 80,
    damageRadiusPx: 100,
    maxDamage: 100,
    impulseMag: 120,
  },
};
