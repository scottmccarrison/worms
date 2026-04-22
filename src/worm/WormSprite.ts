/**
 * Epic 45 - render-only worm sprite.
 *
 * A lightweight Phaser graphics wrapper that draws a worm without any
 * planck body, health tracking, or input methods. Positions + aim come
 * from a `RenderableWorm` snapshot that the SimAdapter refreshes each
 * frame. Used by GameScene's networked path; offline mode keeps using
 * the heavier `Worm` class (which bundles body + sprite together) via
 * OfflineSimAdapter.
 *
 * Mirrors the visual output of `Worm.drawWorm` one-to-one so the two
 * paths look identical on screen.
 */

import type Phaser from "phaser";
import { tuning } from "../tuning";
import type { RenderableWorm } from "../sim/SimAdapter";

export interface WormSpriteInit {
  scene: Phaser.Scene;
}

export class WormSprite {
  readonly graphics: Phaser.GameObjects.Graphics;
  readonly nameText: Phaser.GameObjects.Text;
  readonly healthText: Phaser.GameObjects.Text;

  private isActive = false;

  constructor(init: WormSpriteInit, snapshot: RenderableWorm) {
    this.graphics = init.scene.add.graphics();
    this.graphics.setDepth(5);
    this.nameText = init.scene.add
      .text(snapshot.xPx, snapshot.yPx - 30, snapshot.name, {
        fontSize: "11px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(6);
    this.healthText = init.scene.add
      .text(snapshot.xPx, snapshot.yPx - 18, `${snapshot.hp}`, {
        fontSize: "12px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(6);
  }

  /** Flag this sprite as the active player's worm (yellow ring + aim arrow). */
  setActive(active: boolean): void {
    this.isActive = active;
  }

  /** Redraw from the latest snapshot. Called each frame from the scene loop. */
  render(snapshot: RenderableWorm): void {
    const r = tuning.worm.radiusPx;
    const color = snapshot.team.color;

    this.graphics.clear();

    if (!snapshot.isAlive) {
      this.graphics.setAlpha(0.3);
    } else if (this.isActive) {
      this.graphics.setAlpha(1.0);
    } else {
      this.graphics.setAlpha(0.45);
    }

    if (this.isActive && snapshot.isAlive) {
      this.graphics.lineStyle(3, 0xffff00, 1);
      this.graphics.strokeCircle(snapshot.xPx, snapshot.yPx, r + 4);
    }

    this.graphics.fillStyle(color, 1);
    this.graphics.fillCircle(snapshot.xPx, snapshot.yPx, r);
    this.graphics.lineStyle(1.5, 0xffffff, 0.6);
    this.graphics.strokeCircle(snapshot.xPx, snapshot.yPx, r);

    if (this.isActive && snapshot.isAlive) {
      const aimLen = r * 2.2;
      const ax = snapshot.xPx + Math.cos(snapshot.aimAngle) * snapshot.facing * aimLen;
      const ay = snapshot.yPx + Math.sin(snapshot.aimAngle) * aimLen;
      this.graphics.lineStyle(2, 0xffffff, 0.8);
      this.graphics.beginPath();
      this.graphics.moveTo(snapshot.xPx, snapshot.yPx);
      this.graphics.lineTo(ax, ay);
      this.graphics.strokePath();
    }

    this.nameText.setPosition(snapshot.xPx, snapshot.yPx - tuning.worm.radiusPx - 18);
    this.nameText.setText(snapshot.name);
    this.healthText.setPosition(snapshot.xPx, snapshot.yPx - tuning.worm.radiusPx - 6);
    this.healthText.setText(`${snapshot.hp}`);
  }

  destroy(): void {
    this.graphics.destroy();
    this.nameText.destroy();
    this.healthText.destroy();
  }
}
