import type { WeaponConfig } from "./types";

export const dynamite: WeaponConfig = {
  id: "dynamite",
  name: "Dynamite",
  archetype: "throwable",
  ammoPerMatch: -1,
  selectKey: 4,
  iconColor: 0xcc3333,
  iconLabel: "D",
  projectileColor: 0xcc3333,
  projectileRadiusPx: 8,
  fuseMs: 5000,
  restitution: 0.2,
  powerCapMps: 2, // tiny - dynamite drops at feet, barely any arc
  explosion: {
    terrainRadiusPx: 70,
    damageRadiusPx: 85,
    maxDamage: 75,
    impulseMag: 90,
  },
};
