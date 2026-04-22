import * as Phaser from "phaser";
import { tuning } from "../tuning";

/**
 * Epic 32 - Utility d-pad overlay.
 *
 * Shown only while rope or jetpack is active. The half-screen tap-walk
 * gesture doesn't make sense while swinging on a rope or flying a jetpack,
 * so this d-pad replaces it with persistent left / right / up (/ down)
 * buttons the player can hold.
 *
 * Mounted by GameScene when the active worm activates a utility;
 * destroyed when the utility deactivates. Never shown in networked mode
 * (per plan #65: utilities are offline-only).
 *
 * Interaction model:
 *  - Left / right buttons: held = onLeft(-1 / 1); released = onLeft(0).
 *  - Up button: held = onUp(true); released = onUp(false).
 *  - Down button: same as up, for rope-extend.
 */
export interface UtilityDPadInit {
  scene: Phaser.Scene;
  onLeft(dir: -1 | 0 | 1): void;
  onUp(active: boolean): void;
  onDown(active: boolean): void;
}

export class UtilityDPad {
  private readonly container: Phaser.GameObjects.Container;
  private readonly leftBtn: Phaser.GameObjects.Container;
  private readonly rightBtn: Phaser.GameObjects.Container;
  private readonly upBtn: Phaser.GameObjects.Container;
  private readonly downBtn: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;
  // Tracks which horizontal button is currently held so we can resolve
  // simultaneous left+right to a defined direction (last pressed wins).
  private leftHeld = false;
  private rightHeld = false;
  private readonly onLeft: (dir: -1 | 0 | 1) => void;

  constructor(init: UtilityDPadInit) {
    this.scene = init.scene;
    this.onLeft = init.onLeft;
    const radius = tuning.touch.buttonRadiusPx;
    const sw = this.scene.scale.width;
    const sh = this.scene.scale.height;

    // Layout: 4-button cross, bottom-center. Positions are rough; dat.gui
    // panel doesn't expose these yet so values are hardcoded relative to
    // screen size.
    const cx = sw / 2;
    const cy = sh - 80;
    const spacing = radius * 2 + 12;

    this.leftBtn = this._makeButton({ label: "<", radius });
    this.leftBtn.setPosition(cx - spacing, cy);
    this.rightBtn = this._makeButton({ label: ">", radius });
    this.rightBtn.setPosition(cx + spacing, cy);
    this.upBtn = this._makeButton({ label: "^", radius });
    this.upBtn.setPosition(cx, cy - spacing);
    this.downBtn = this._makeButton({ label: "v", radius });
    this.downBtn.setPosition(cx, cy + spacing);

    this.container = this.scene.add.container(0, 0, [
      this.leftBtn,
      this.rightBtn,
      this.upBtn,
      this.downBtn,
    ]);
    this.container.setDepth(100);
    this.container.setScrollFactor(0);
    this.container.setVisible(false);

    this._wireHorizontalButton(this.leftBtn, -1);
    this._wireHorizontalButton(this.rightBtn, 1);
    this._wireHoldButton(this.upBtn, init.onUp);
    this._wireHoldButton(this.downBtn, init.onDown);

    for (const b of [this.leftBtn, this.rightBtn, this.upBtn, this.downBtn]) {
      b.setAlpha(tuning.touch.buttonIdleAlpha);
    }
  }

  show(): void {
    this.container.setVisible(true);
  }

  hide(): void {
    this.container.setVisible(false);
    // Release any held directions when hiding so the utility doesn't think
    // the user is still pressing.
    if (this.leftHeld || this.rightHeld) {
      this.leftHeld = false;
      this.rightHeld = false;
      this.onLeft(0);
    }
  }

  destroy(): void {
    this.container.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _makeButton(opts: {
    label: string;
    radius: number;
  }): Phaser.GameObjects.Container {
    const { label, radius } = opts;
    const gfx = this.scene.add.graphics();
    gfx.fillStyle(0x222222, 1);
    gfx.fillCircle(0, 0, radius);
    gfx.lineStyle(2, 0xcccccc, 1);
    gfx.strokeCircle(0, 0, radius);
    const text = this.scene.add
      .text(0, 0, label, {
        fontSize: "20px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0.5);
    const container = this.scene.add.container(0, 0, [gfx, text]);
    container.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, radius),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    return container;
  }

  /** Wire a left / right button so holding dispatches the correct combined
   *  horizontal direction (last-pressed wins when both held simultaneously). */
  private _wireHorizontalButton(btn: Phaser.GameObjects.Container, dir: -1 | 1): void {
    const press = (): void => {
      if (dir === -1) this.leftHeld = true;
      else this.rightHeld = true;
      btn.setAlpha(tuning.touch.buttonPressedAlpha);
      this._dispatchHorizontal();
    };
    const release = (): void => {
      if (dir === -1) this.leftHeld = false;
      else this.rightHeld = false;
      btn.setAlpha(tuning.touch.buttonIdleAlpha);
      this._dispatchHorizontal();
    };
    btn.on("pointerdown", press);
    btn.on("pointerup", release);
    btn.on("pointerupoutside", release);
    btn.on("pointerout", release);
  }

  /** Wire a simple hold-to-activate button (up / down thrust). */
  private _wireHoldButton(btn: Phaser.GameObjects.Container, cb: (active: boolean) => void): void {
    const press = (): void => {
      btn.setAlpha(tuning.touch.buttonPressedAlpha);
      cb(true);
    };
    const release = (): void => {
      btn.setAlpha(tuning.touch.buttonIdleAlpha);
      cb(false);
    };
    btn.on("pointerdown", press);
    btn.on("pointerup", release);
    btn.on("pointerupoutside", release);
    btn.on("pointerout", release);
  }

  private _dispatchHorizontal(): void {
    // Both held: left wins if it was pressed most recently (undeterminable
    // here; fall back to 0 = stop). User clarity: release one to resolve.
    if (this.leftHeld && this.rightHeld) {
      this.onLeft(0);
      return;
    }
    if (this.leftHeld) this.onLeft(-1);
    else if (this.rightHeld) this.onLeft(1);
    else this.onLeft(0);
  }
}
