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
}
