import * as Phaser from "phaser";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";

export interface TouchControlsInit {
  scene: Phaser.Scene;
  getActiveWorm: () => Worm | null;
  /** When true, rope + jetpack are no-ops (per plan #65) so we skip rendering
   * any buttons. When false (offline), buttons render in the top-right corner. */
  networked?: boolean;
}

/**
 * On-screen touch overlay with rope + jetpack buttons.
 *
 * Offline mode: small buttons top-right, out of the walk / aim area. Tap rope
 * to toggle, hold jet to thrust.
 *
 * Networked mode: buttons are hidden entirely. Utilities aren't wired to the
 * server yet (plan #65), so showing inert buttons would be misleading.
 */
export class TouchControls {
  private readonly container: Phaser.GameObjects.Container;
  private ropeBtn: Phaser.GameObjects.Container | null = null;
  private jetBtn: Phaser.GameObjects.Container | null = null;
  private readonly scene: Phaser.Scene;

  constructor(init: TouchControlsInit) {
    this.scene = init.scene;
    // Always make an empty container so `destroy()` and `hitsButton()` have
    // a consistent target regardless of mode.
    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(100);
    this.container.setScrollFactor(0);

    if (init.networked) {
      // Networked mode: no rope / jet buttons. The container stays empty so
      // hitsButton() always returns false and the gesture layer sees every
      // pointerdown.
      return;
    }

    const { getActiveWorm } = init;
    const radius = tuning.touch.buttonRadiusPx;
    const sw = this.scene.scale.width;

    // --- Rope button (top-right, inboard) ---
    const ropeBtn = this._makeButton({
      fillColor: 0x2266cc,
      strokeColor: 0x88aaff,
      label: "R",
      radius,
    });
    ropeBtn.setPosition(sw - 60 - (radius * 2 + 10), 60);
    this.ropeBtn = ropeBtn;

    // --- JetPack button (top-right corner) ---
    const jetBtn = this._makeButton({
      fillColor: 0xcc6600,
      strokeColor: 0xff9933,
      label: "J",
      radius,
    });
    jetBtn.setPosition(sw - 60, 60);
    this.jetBtn = jetBtn;

    this.container.add([ropeBtn, jetBtn]);

    // --- Rope: tap to toggle ---
    ropeBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, radius),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    ropeBtn.on("pointerdown", () => {
      const w = getActiveWorm();
      if (!w) return;
      w.ropeUtility.isActive() ? w.ropeUtility.deactivate() : w.ropeUtility.activate();
      this._flashButton(ropeBtn, w.ropeUtility.isActive());
    });

    // --- JetPack: hold to thrust (pointerdown = activate, pointerup = deactivate) ---
    jetBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, radius),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    const jetDeactivate = (): void => {
      const w = getActiveWorm();
      if (!w) return;
      if (w.jetPackUtility.isActive()) w.jetPackUtility.deactivate();
      this._setButtonAlpha(jetBtn, false);
    };
    jetBtn.on("pointerdown", () => {
      const w = getActiveWorm();
      if (!w) return;
      if (!w.jetPackUtility.isActive()) w.jetPackUtility.activate();
      this._setButtonAlpha(jetBtn, true);
    });
    jetBtn.on("pointerup", jetDeactivate);
    jetBtn.on("pointerupoutside", jetDeactivate);
    jetBtn.on("pointerout", jetDeactivate);

    // Set idle alpha on both
    ropeBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
  }

  /**
   * Returns true if the given pointer position hits any interactive button.
   * Used by GameScene to gate terrain cut from touch events.
   */
  hitsButton(pointer: Phaser.Input.Pointer): boolean {
    const hits = this.scene.input.hitTestPointer(pointer);
    return hits.some((obj) => obj === this.ropeBtn || obj === this.jetBtn);
  }

  destroy(): void {
    this.container.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _makeButton(opts: {
    fillColor: number;
    strokeColor: number;
    label: string;
    radius: number;
  }): Phaser.GameObjects.Container {
    const { fillColor, strokeColor, label, radius } = opts;

    const gfx = this.scene.add.graphics();
    gfx.fillStyle(fillColor, 1);
    gfx.fillCircle(0, 0, radius);
    gfx.lineStyle(2, strokeColor, 1);
    gfx.strokeCircle(0, 0, radius);

    const text = this.scene.add
      .text(0, 0, label, {
        fontSize: "18px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontStyle: "bold",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0.5);

    return this.scene.add.container(0, 0, [gfx, text]);
  }

  private _setButtonAlpha(btn: Phaser.GameObjects.Container, pressed: boolean): void {
    btn.setAlpha(pressed ? tuning.touch.buttonPressedAlpha : tuning.touch.buttonIdleAlpha);
  }

  private _flashButton(btn: Phaser.GameObjects.Container, active: boolean): void {
    this._setButtonAlpha(btn, active);
  }
}
