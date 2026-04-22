/**
 * WaterRenderer - draws a rising water layer below terrain.
 *
 * Renders a semi-transparent blue fill from `waterLevelPx` down to the
 * bottom of the world. Depth -5 places it below terrain sprites (typically
 * depth 0) but above the sky backdrop.
 *
 * When waterLevelPx === Number.MAX_SAFE_INTEGER (the sentinel meaning "no
 * water") nothing is drawn. The graphics object is cleared each update so
 * the level can change smoothly turn-over-turn.
 */
import type * as Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";

export interface WaterRendererInit {
  scene: Phaser.Scene;
  sim: SimAdapter;
  widthPx: number;
  heightPx: number;
}

export class WaterRenderer {
  private readonly gfx: Phaser.GameObjects.Graphics;
  private readonly sim: SimAdapter;
  private readonly widthPx: number;
  private readonly heightPx: number;
  private lastLevelPx = Number.MAX_SAFE_INTEGER;

  constructor(init: WaterRendererInit) {
    this.sim = init.sim;
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.gfx = init.scene.add.graphics();
    this.gfx.setDepth(-5); // below terrain sprite (which is typically 0)
  }

  update(): void {
    const lvl = this.sim.getWaterLevelPx();
    if (lvl === this.lastLevelPx) return;
    this.lastLevelPx = lvl;
    this.gfx.clear();
    if (lvl >= Number.MAX_SAFE_INTEGER) return;
    this.gfx.fillStyle(0x1155aa, 0.55);
    this.gfx.fillRect(0, lvl, this.widthPx, this.heightPx - lvl);
  }

  destroy(): void {
    this.gfx.destroy();
  }
}
