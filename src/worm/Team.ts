import type { Worm } from "./Worm";

export interface TeamInit {
  id: string; // "red", "blue" etc.
  name: string; // "Team Red"
  color: number; // 0xff4444 - Phaser color int
}

export class Team {
  readonly id: string;
  readonly name: string;
  readonly color: number;
  readonly worms: Worm[] = [];

  /** Starts at -1 so the first `advanceWorm()` call lands at index 0. */
  private _currentWormIdx = -1;

  constructor(init: TeamInit) {
    this.id = init.id;
    this.name = init.name;
    this.color = init.color;
  }

  addWorm(worm: Worm): void {
    this.worms.push(worm);
  }

  aliveCount(): number {
    return this.worms.filter((w) => w.isAlive).length;
  }

  isEliminated(): boolean {
    return this.aliveCount() === 0;
  }

  getCurrentWorm(): Worm | null {
    if (this._currentWormIdx < 0) return null;
    return this.worms[this._currentWormIdx] ?? null;
  }

  /** Rotate to the next alive worm. Works correctly starting from -1. Returns null if all dead. */
  advanceWorm(): Worm | null {
    const n = this.worms.length;
    if (n === 0) return null;
    for (let i = 1; i <= n; i++) {
      const idx = (((this._currentWormIdx + i) % n) + n) % n;
      const w = this.worms[idx];
      if (w?.isAlive) {
        this._currentWormIdx = idx;
        return w;
      }
    }
    return null;
  }

  get currentWormIdx(): number {
    return this._currentWormIdx;
  }
}
