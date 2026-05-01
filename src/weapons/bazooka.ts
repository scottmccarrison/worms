import type { WeaponConfig } from "./types";

export const bazooka: WeaponConfig = {
  id: "bazooka",
  name: "Bazooka",
  archetype: "projectile",
  ammoPerMatch: -1, // infinite for 6a playtest
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
    impulseMag: 25,
  },
};
