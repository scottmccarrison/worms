import type * as Phaser from "phaser";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";
import type { Utility } from "./types";

export interface JetPackInit {
  scene: Phaser.Scene;
  worm: Worm;
}

export class JetPack implements Utility {
  readonly worm: Worm;

  private _active = false;
  private fuel: number;
  private readonly flameGfx: Phaser.GameObjects.Graphics;
  private thrustH: -1 | 0 | 1 = 0; // horizontal from InputController
  private thrustUp = false; // vertical from InputController

  constructor(init: JetPackInit) {
    this.worm = init.worm;
    this.fuel = tuning.jetpack.fuelCapacity;
    this.flameGfx = init.scene.add.graphics();
    this.flameGfx.setDepth(7);
    this.flameGfx.setVisible(false);
  }

  isActive(): boolean {
    return this._active;
  }

  /**
   * Toggle jetpack. Activate if fuel > 0 and worm not roped.
   * Deactivate if already active.
   */
  activate(): void {
    if (this._active) {
      this.deactivate();
      return;
    }
    // Mutual exclusion: can't jetpack while roped
    if (this.worm.isRoped()) return;
    if (this.fuel <= 0) return;
    this._active = true;
    this.worm.setJetPackActive(true);
    this.flameGfx.setVisible(true);
  }

  deactivate(): void {
    this._active = false;
    this.worm.setJetPackActive(false);
    this.flameGfx.setVisible(false);
    this.flameGfx.clear();
    // Fuel stays depleted until turn end (Epic 5 will reset on turn cycle)
  }

  /** Per-frame: apply thrust impulse and drain fuel. Called by GameScene.update. */
  update(dtMs: number): void {
    void dtMs;
    if (!this._active) return;

    // Fuel check first
    if (this.fuel <= 0) {
      this.deactivate();
      return;
    }

    // Build impulse vector
    // Negative Y = upward in planck (y-down coordinate system)
    const ix = this.thrustH * tuning.jetpack.sideImpulse;
    const iy = this.thrustUp ? -tuning.jetpack.upwardImpulse : 0;

    if (ix !== 0 || iy !== 0) {
      this.worm.body.applyLinearImpulse({ x: ix, y: iy }, this.worm.body.getPosition(), true);
      this.fuel -= tuning.jetpack.fuelPerFrame;
    }

    if (this.fuel <= 0) {
      this.fuel = 0;
      this.deactivate();
      return;
    }

    // Update facing direction when thrusting sideways
    if (this.thrustH !== 0) {
      this.worm.setFacing(this.thrustH as -1 | 1);
    }

    // Draw flame (small orange triangle below worm)
    this._drawFlame();
  }

  /**
   * Called by InputController: horizontal thrust direction.
   * -1 = left, 0 = none, 1 = right.
   */
  setHorizontalInput(direction: -1 | 0 | 1): void {
    this.thrustH = direction;
  }

  /**
   * Called by InputController: whether upward thrust is pressed.
   */
  setVerticalInput(up: boolean): void {
    this.thrustUp = up;
  }

  /** Clean up graphics. Called when worm is destroyed. */
  destroy(): void {
    this.deactivate();
    this.flameGfx.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _drawFlame(): void {
    const pos = this.worm.body.getPosition();
    const r = tuning.worm.radiusPx;
    // Convert meters to pixels for drawing
    const pxPerM = 30; // from physics/scale.ts PX_PER_M
    const cx = pos.x * pxPerM;
    const cy = pos.y * pxPerM;

    this.flameGfx.clear();

    // Bottom flame when thrusting up
    if (this.thrustUp) {
      this.flameGfx.fillStyle(0xff6600, 0.85);
      this.flameGfx.fillTriangle(cx - 5, cy + r + 2, cx + 5, cy + r + 2, cx, cy + r + 14);
    }

    // Side flame when thrusting horizontally
    if (this.thrustH !== 0) {
      const sx = this.thrustH * -1; // flame points opposite to movement
      this.flameGfx.fillStyle(0xff8800, 0.75);
      this.flameGfx.fillTriangle(cx + sx * r, cy - 4, cx + sx * r, cy + 4, cx + sx * (r + 10), cy);
    }
  }
}
