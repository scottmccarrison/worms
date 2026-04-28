import type { WeaponConfig } from "./types";

export const shotgun: WeaponConfig = {
  id: "shotgun",
  name: "Shotgun",
  archetype: "hitscan",
  ammoPerMatch: -1,
  selectKey: 2,
  iconColor: 0x444444,
  iconLabel: "S",
  shotsPerActivation: 2,
  affectedByWind: false,
  explosion: {
    terrainRadiusPx: 20,
    damageRadiusPx: 30,
    maxDamage: 25,
    impulseMag: 30,
  },
};
