import type { WeaponConfig } from "./types";

export const handGrenade: WeaponConfig = {
  id: "handgrenade",
  name: "Grenade",
  archetype: "throwable",
  ammoPerMatch: -1,
  selectKey: 3,
  iconColor: 0x3a5f2e,
  iconLabel: "G",
  projectileColor: 0x8fbf6b,
  projectileRadiusPx: 6,
  fuseMs: 3000,
  restitution: 0.55,
  powerCapMps: 14,
  explosion: {
    terrainRadiusPx: 40,
    damageRadiusPx: 60,
    maxDamage: 45,
    impulseMag: 55,
  },
};
