/**
 * WindHUD - top-center widget showing current wind direction and magnitude.
 *
 * Rendered as a horizontal arrow (direction + length proportional to |wind|)
 * with a text label below it. Sits at depth 100 so it renders above terrain
 * and worm sprites. Scroll-factor 0 keeps it fixed to the screen.
 */
import type * as Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";

export interface WindHUDInit {
  scene: Phaser.Scene;
  sim: SimAdapter;
}

export class WindHUD {
  private readonly container: Phaser.GameObjects.Container;
  private readonly arrow: Phaser.GameObjects.Graphics;
  private readonly label: Phaser.GameObjects.Text;
  private readonly sim: SimAdapter;
  private lastWind = 0;

  constructor(init: WindHUDInit) {
    this.sim = init.sim;
    const sw = init.scene.scale.width;
    this.container = init.scene.add.container(sw / 2, 90);
    this.container.setDepth(100);
    this.container.setScrollFactor(0);
    this.arrow = init.scene.add.graphics();
    this.label = init.scene.add
      .text(0, 20, "WIND 0.0", {
        fontSize: "14px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5);
    this.container.add([this.arrow, this.label]);
    this.redraw(0);
  }

  update(): void {
    const w = this.sim.getWind();
    if (w !== this.lastWind) {
      this.lastWind = w;
      this.redraw(w);
    }
  }

  destroy(): void {
    this.container.destroy();
  }

  private redraw(wind: number): void {
    this.arrow.clear();
    this.label.setText(`WIND ${wind.toFixed(1)}`);
    if (wind === 0) return;
    const len = 40 * Math.abs(wind);
    const dir = wind > 0 ? 1 : -1;
    this.arrow.lineStyle(3, 0x88ccff, 1);
    this.arrow.beginPath();
    this.arrow.moveTo(-dir * 5, 0);
    this.arrow.lineTo(dir * len, 0);
    this.arrow.strokePath();
    // Arrowhead
    this.arrow.fillStyle(0x88ccff, 1);
    this.arrow.beginPath();
    this.arrow.moveTo(dir * len, 0);
    this.arrow.lineTo(dir * (len - 8), -5);
    this.arrow.lineTo(dir * (len - 8), 5);
    this.arrow.closePath();
    this.arrow.fillPath();
  }
}
