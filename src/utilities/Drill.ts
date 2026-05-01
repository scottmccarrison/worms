import type { Worm } from "../worm/Worm";

export interface DrillCallbacks {
  onFire: (worm: Worm, angleRad: number, nowMs: number) => void;
}

export class Drill {
  private armed = false;
  private lastFiredAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly worm: Worm,
    private readonly callbacks: DrillCallbacks,
  ) {}

  arm(): void {
    this.armed = true;
  }

  disarm(): void {
    this.armed = false;
  }

  isArmed(): boolean {
    return this.armed;
  }

  isOnCooldown(nowMs: number, cooldownMs: number): boolean {
    return nowMs - this.lastFiredAtMs < cooldownMs;
  }

  /** Fire the drill at angleRad (radians). Records timestamp + auto-disarms. */
  fire(angleRad: number, nowMs: number): void {
    this.callbacks.onFire(this.worm, angleRad, nowMs);
    this.lastFiredAtMs = nowMs;
    this.armed = false;
  }

  /** Called at turn-start to clear lingering state from prior owner. */
  resetForNewTurn(): void {
    this.armed = false;
    // lastFiredAtMs stays - prevents drill spam across rapid turn rotations
  }
}
