import type * as Phaser from "phaser";
import type { Worm } from "../worm/Worm";

interface AimHUDInit {
  scene: Phaser.Scene;
  getActiveWorm: () => Worm | null;
  isInputAllowed: () => boolean;
}

/**
 * Aim indicator HUD. Draws a yellow arrow from the active worm at its aim
 * angle (length scales with power, 20-80px) and a small power bar below
 * the worm. Redrawn each frame.
 *
 * Hidden when:
 * - inputAllowed is false
 * - no active worm
 * - worm is roped or jetpacking
 */
export class AimHUD {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly getActiveWorm: () => Worm | null;
  private readonly isInputAllowed: () => boolean;

  constructor(init: AimHUDInit) {
    this.getActiveWorm = init.getActiveWorm;
    this.isInputAllowed = init.isInputAllowed;

    this.gfx = init.scene.add.graphics();
    this.gfx.setDepth(20).setScrollFactor(0);
  }

  /** Call each frame from GameScene.update. Clears and redraws. */
  update(): void {
    this.gfx.clear();

    const worm = this.getActiveWorm();
    const shouldDraw =
      this.isInputAllowed() && worm !== null && !worm.isRoped() && !worm.isJetPacking();

    if (!shouldDraw || !worm) return;

    const wx = worm.xPx;
    const wy = worm.yPx;
    const angle = worm.aimAngle;
    const facing = worm.facing;
    const power = worm.aimPower01;

    const arrowLen = 20 + power * 60;

    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    // Endpoint of the arrow
    const endX = wx + cosA * facing * arrowLen;
    const endY = wy + sinA * arrowLen;

    // Draw arrow shaft
    this.gfx.lineStyle(3, 0xffee00, 1.0);
    this.gfx.beginPath();
    this.gfx.moveTo(wx, wy);
    this.gfx.lineTo(endX, endY);
    this.gfx.strokePath();

    // Arrowhead
    const fwdX = cosA * facing;
    const fwdY = sinA;
    const perpX = -sinA * facing;
    const perpY = cosA;
    const headLen = 10;
    const headWidth = 5;

    const leftX = endX - fwdX * headLen + perpX * headWidth;
    const leftY = endY - fwdY * headLen + perpY * headWidth;
    const rightX = endX - fwdX * headLen - perpX * headWidth;
    const rightY = endY - fwdY * headLen - perpY * headWidth;

    this.gfx.fillStyle(0xffee00, 1.0);
    this.gfx.fillTriangle(endX, endY, leftX, leftY, rightX, rightY);

    // Power bar below worm
    const barX = wx - 10;
    const barY = wy + 18;

    // Background
    this.gfx.fillStyle(0x333333, 0.85);
    this.gfx.fillRect(barX, barY, 20, 4);

    // Fill color: yellow < 50%, orange 50-80%, red >= 80%
    const fillColor = power >= 0.8 ? 0xff3300 : power >= 0.5 ? 0xff8800 : 0xffee00;
    const fillW = Math.round(20 * power);
    this.gfx.fillStyle(fillColor, 1.0);
    this.gfx.fillRect(barX, barY, fillW, 4);

    // Tick mark at 100% right edge
    this.gfx.lineStyle(1, 0xffffff, 0.7);
    this.gfx.beginPath();
    this.gfx.moveTo(barX + 20, barY - 1);
    this.gfx.lineTo(barX + 20, barY + 5);
    this.gfx.strokePath();
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
