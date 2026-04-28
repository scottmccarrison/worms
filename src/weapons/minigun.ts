import type { WeaponConfig } from "./types";

export const minigun: WeaponConfig = {
  id: "minigun",
  name: "Minigun",
  archetype: "hitscan",
  ammoPerMatch: -1,
  selectKey: 6,
  iconColor: 0x555555,
  iconLabel: "M",
  shotsPerActivation: 12,
  hitscanSpreadRad: 0.08, // ~4.6 degrees of spread per shot
  affectedByWind: false,
  explosion: {
    terrainRadiusPx: 12,
    damageRadiusPx: 20,
    maxDamage: 8,
    impulseMag: 15,
  },
};
