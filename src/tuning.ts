interface Tuning {
  world: { gravityY: number };
  weapons: { testCutRadiusPx: number };
  terrain: { rowHeight: number };
}

export const tuning: Tuning = {
  world: { gravityY: 10 },
  weapons: { testCutRadiusPx: 40 },
  terrain: { rowHeight: 5 },
};
