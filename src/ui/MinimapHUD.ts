import * as Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";

export interface MinimapHUDInit {
  scene: Phaser.Scene;
  sim: SimAdapter;
  worldWidthPx: number;
  worldHeightPx: number;
  /** Phaser texture key for the terrain canvas; rendered as a tinted silhouette under the worm dots. */
  terrainTextureKey: string;
}

/**
 * Press-and-hold "Map" button. While the button is held, a centered minimap
 * overlay shows the world with a terrain silhouette backdrop and a dot per
 * alive worm. The active worm is highlighted with a yellow ring. Release the
 * button (anywhere) to dismiss.
 *
 * Mirrors TurnHUD's End-button style; sits immediately left of it.
 */
export class MinimapHUD {
  private readonly scene: Phaser.Scene;
  private readonly sim: SimAdapter;
  private readonly worldWidthPx: number;
  private readonly worldHeightPx: number;

  private readonly mapBtn: Phaser.GameObjects.Container;
  private readonly mapBtnCircle: Phaser.GameObjects.Graphics;
  private readonly mapBtnLabel: Phaser.GameObjects.Text;

  private readonly overlay: Phaser.GameObjects.Container;
  private readonly dotsGfx: Phaser.GameObjects.Graphics;
  private readonly frameX: number;
  private readonly frameY: number;
  private readonly frameW: number;
  private readonly frameH: number;

  private activePointerId = -1;
  private visible = false;

  private _onPointerUp: ((p: Phaser.Input.Pointer) => void) | null = null;

  private readonly BTN_RADIUS = 40;

  constructor(init: MinimapHUDInit) {
    this.scene = init.scene;
    this.sim = init.sim;
    this.worldWidthPx = init.worldWidthPx;
    this.worldHeightPx = init.worldHeightPx;

    const W = this.scene.scale.width;
    const H = this.scene.scale.height;

    // Map button: same radius/style as TurnHUD's End button, 90px to its left.
    // End sits at (W - 80, 60) with BTN_RADIUS 40, so Map at (W - 170, 60)
    // leaves a 10px visual gap between the two circles.
    this.mapBtn = this.scene.add
      .container(W - 170, 60)
      .setDepth(100)
      .setScrollFactor(0);
    this.mapBtnCircle = this.scene.add.graphics();
    this.drawMapBtn();
    this.mapBtnLabel = this.scene.add
      .text(0, 0, "Map", {
        fontSize: "18px",
        fontFamily: "monospace",
        color: "#ffffff",
      })
      .setOrigin(0.5);
    this.mapBtn.add([this.mapBtnCircle, this.mapBtnLabel]);
    this.mapBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });

    // Minimap frame: 800 wide, scaled to world aspect (≈167 tall at 6144x1280).
    // Centered on the scene. Worm dots layer is drawn on top of the silhouette.
    this.frameW = 800;
    this.frameH = Math.round((this.frameW * this.worldHeightPx) / this.worldWidthPx);
    this.frameX = Math.round(W / 2 - this.frameW / 2);
    this.frameY = Math.round(H / 2 - this.frameH / 2);

    // Overlay container holds the dim, frame, silhouette, and dots graphics.
    // Container itself is scrollFactor 0; depth 110 sits above HUDs (100) so
    // the dim absorbs taps that would otherwise hit world objects.
    this.overlay = this.scene.add.container(0, 0).setDepth(110).setScrollFactor(0);

    const dim = this.scene.add.rectangle(W / 2, H / 2, W, H, 0x000000, 0.55);
    dim.setInteractive(); // absorb stray pointer events while visible
    this.overlay.add(dim);

    const frame = this.scene.add.rectangle(
      this.frameX + this.frameW / 2,
      this.frameY + this.frameH / 2,
      this.frameW,
      this.frameH,
      0x111111,
      1,
    );
    frame.setStrokeStyle(2, 0xffffff, 1);
    this.overlay.add(frame);

    // Terrain silhouette: same canvas texture used for the live terrain
    // sprite. Tinted to read as a low-contrast backdrop; alpha-zero air gaps
    // stay dark so caves and sky are visually distinct from solid ground.
    const silhouette = this.scene.add.image(
      this.frameX + this.frameW / 2,
      this.frameY + this.frameH / 2,
      init.terrainTextureKey,
    );
    silhouette.setDisplaySize(this.frameW, this.frameH);
    silhouette.setTint(0x555555);
    this.overlay.add(silhouette);

    this.dotsGfx = this.scene.add.graphics();
    this.overlay.add(this.dotsGfx);

    this.overlay.setVisible(false);

    // Press-and-hold gesture: button pointerdown shows overlay and stores
    // the pointer id; scene-level pointerup / pointercancel for that id
    // hides it. Stored handler ref so destroy() can detach cleanly. Mirrors
    // TouchControls.ts jet joystick.
    this.mapBtn.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.activePointerId !== -1) return; // already held by another finger
      this.activePointerId = p.id;
      this.show();
    });

    this._onPointerUp = (p: Phaser.Input.Pointer) => {
      if (p.id !== this.activePointerId) return;
      this.activePointerId = -1;
      this.hide();
    };
    this.scene.input.on("pointerup", this._onPointerUp);
    this.scene.input.on("pointercancel", this._onPointerUp);
  }

  /** Per-frame refresh: redraws worm dots while visible; no-op otherwise. */
  update(): void {
    if (!this.visible) return;
    this.drawDots();
  }

  /**
   * Returns true if the pointer is over the Map button OR (when visible)
   * anywhere on the overlay. GameScene uses this to gate terrain cut from
   * raw pointerdown so a hold-and-drag inside the overlay can't leak through.
   */
  hitsButton(pointer: Phaser.Input.Pointer): boolean {
    const local = this.mapBtn.getLocalPoint(pointer.x, pointer.y);
    const onMapBtn = Phaser.Geom.Circle.Contains(
      new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      local.x,
      local.y,
    );
    if (onMapBtn) return true;
    return this.visible;
  }

  /**
   * Force-clear gesture state. GameScene calls this on turn change so a
   * leaked hold from the previous turn doesn't carry over.
   */
  resetGestureState(): void {
    if (this.activePointerId === -1 && !this.visible) return;
    this.activePointerId = -1;
    this.hide();
  }

  destroy(): void {
    if (this._onPointerUp) {
      this.scene.input.off("pointerup", this._onPointerUp);
      this.scene.input.off("pointercancel", this._onPointerUp);
      this._onPointerUp = null;
    }
    this.overlay.destroy();
    this.mapBtn.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private show(): void {
    this.visible = true;
    this.overlay.setVisible(true);
    this.drawDots();
  }

  private hide(): void {
    this.visible = false;
    this.overlay.setVisible(false);
  }

  private drawDots(): void {
    this.dotsGfx.clear();
    const activeId = this.sim.getActiveWormId();
    for (const w of this.sim.allWorms) {
      if (!w.isAlive) continue;
      const mx = this.frameX + (w.xPx / this.worldWidthPx) * this.frameW;
      const my = this.frameY + (w.yPx / this.worldHeightPx) * this.frameH;
      if (w.id === activeId) {
        this.dotsGfx.fillStyle(w.team.color, 1);
        this.dotsGfx.fillCircle(mx, my, 7);
        this.dotsGfx.lineStyle(2, 0xffff00, 1);
        this.dotsGfx.strokeCircle(mx, my, 11);
      } else {
        this.dotsGfx.fillStyle(w.team.color, 1);
        this.dotsGfx.fillCircle(mx, my, 4);
      }
    }
  }

  private drawMapBtn(): void {
    this.mapBtnCircle.clear();
    this.mapBtnCircle.fillStyle(0x333333, 1);
    this.mapBtnCircle.fillCircle(0, 0, this.BTN_RADIUS);
    this.mapBtnCircle.lineStyle(2, 0xffffff, 1);
    this.mapBtnCircle.strokeCircle(0, 0, this.BTN_RADIUS);
  }
}
