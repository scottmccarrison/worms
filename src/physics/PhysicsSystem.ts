import { World } from "planck";
import type { Vec2Value } from "planck";

export interface PhysicsSystemInit {
  gravity?: Vec2Value; // meters/s^2; default { x: 0, y: 10 } (y-down)
  timestep?: number; // seconds; default 1/60
  velocityIter?: number; // default 8
  positionIter?: number; // default 3
}

export class PhysicsSystem {
  readonly world: World;
  private readonly timestep: number;
  private readonly velocityIter: number;
  private readonly positionIter: number;
  private accumulator = 0;

  constructor(init: PhysicsSystemInit = {}) {
    this.world = new World({ gravity: init.gravity ?? { x: 0, y: 10 } });
    this.timestep = init.timestep ?? 1 / 60;
    this.velocityIter = init.velocityIter ?? 8;
    this.positionIter = init.positionIter ?? 3;
  }

  /** Advance simulation. dtMs is Phaser's delta in milliseconds. */
  step(dtMs: number): void {
    const dt = Math.min(dtMs / 1000, 0.25); // cap spiral
    this.accumulator += dt;
    while (this.accumulator >= this.timestep) {
      this.world.step(this.timestep, this.velocityIter, this.positionIter);
      this.accumulator -= this.timestep;
    }
  }
}
