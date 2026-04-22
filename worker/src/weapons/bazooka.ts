import type { WeaponConfig } from "./types.js";

export const bazooka: WeaponConfig = {
  id: "bazooka",
  name: "Bazooka",
  archetype: "projectile",
  ammoPerMatch: -1,
  selectKey: 1,
  iconColor: 0x8b5a2b,
  iconLabel: "B",
  projectileColor: 0xcc9966,
  projectileRadiusPx: 5,
  powerCapMps: 20,
  explosion: {
    terrainRadiusPx: 45,
    damageRadiusPx: 60,
    maxDamage: 50,
    impulseMag: 60,
  },
};
