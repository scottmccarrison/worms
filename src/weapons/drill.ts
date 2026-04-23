import type { WeaponConfig } from "./types";

export const drill: WeaponConfig = {
  id: "drill",
  name: "Drill",
  archetype: "projectile",
  ammoPerMatch: -1,
  selectKey: 7,
  iconColor: 0x8899aa,
  iconLabel: "X",
  projectileColor: 0xbbccdd,
  projectileRadiusPx: 6,
  powerCapMps: 18,
  fuseMs: 3500, // after 3.5s, detonate
  tunnel: { cutRadiusPx: 14, cutIntervalMs: 40 }, // carves a tunnel every 40ms
  explosion: {
    terrainRadiusPx: 40,
    damageRadiusPx: 55,
    maxDamage: 40,
    impulseMag: 50,
  },
};
