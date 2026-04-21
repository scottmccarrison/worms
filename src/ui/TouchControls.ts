import * as Phaser from "phaser";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";

export interface TouchControlsInit {
  scene: Phaser.Scene;
  getActiveWorm: () => Worm | null;
}

/**
 * On-screen touch overlay with rope + jetpack buttons.
 * Positioned bottom-right, fixed to the viewport (scrollFactor 0).
 * Mobile-first: primary control surface. Keyboard is additive.
 *
 * Button layout (landscape 1280x720):
 *   JetPack btn: (sceneW - 60, sceneH - 60)
 *   Rope btn:    (sceneW - 160, sceneH - 60)
 */
export class TouchControls {
  private readonly container: Phaser.GameObjects.Container;
  private readonly ropeBtn: Phaser.GameObjects.Container;
  private readonly jetBtn: Phaser.GameObjects.Container;
  private readonly scene: Phaser.Scene;

  constructor(init: TouchControlsInit) {
    this.scene = init.scene;
    const { getActiveWorm } = init;
    const radius = tuning.touch.buttonRadiusPx;
    const sw = this.scene.scale.width;
    const sh = this.scene.scale.height;

    // --- Rope button ---
    this.ropeBtn = this._makeButton({
      fillColor: 0x2266cc,
      strokeColor: 0x88aaff,
      label: "R",
      radius,
    });
    this.ropeBtn.setPosition(sw - 160, sh - 60);

    // --- JetPack button ---
    this.jetBtn = this._makeButton({
      fillColor: 0xcc6600,
      strokeColor: 0xff9933,
      label: "J",
      radius,
    });
    this.jetBtn.setPosition(sw - 60, sh - 60);

    // --- Container wrapping both ---
    this.container = this.scene.add.container(0, 0, [this.ropeBtn, this.jetBtn]);
    this.container.setDepth(100);
    this.container.setScrollFactor(0);

    // --- Rope: tap to toggle ---
    this.ropeBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, radius),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    this.ropeBtn.on("pointerdown", () => {
      const w = getActiveWorm();
      if (!w) return;
      w.ropeUtility.isActive() ? w.ropeUtility.deactivate() : w.ropeUtility.activate();
      this._flashButton(this.ropeBtn, w.ropeUtility.isActive());
    });

    // --- JetPack: hold to thrust (pointerdown = activate, pointerup = deactivate) ---
    this.jetBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, radius),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    const jetDeactivate = (): void => {
      const w = getActiveWorm();
      if (!w) return;
      if (w.jetPackUtility.isActive()) w.jetPackUtility.deactivate();
      this._setButtonAlpha(this.jetBtn, false);
    };
    this.jetBtn.on("pointerdown", () => {
      const w = getActiveWorm();
      if (!w) return;
      if (!w.jetPackUtility.isActive()) w.jetPackUtility.activate();
      this._setButtonAlpha(this.jetBtn, true);
    });
    this.jetBtn.on("pointerup", jetDeactivate);
    this.jetBtn.on("pointerupoutside", jetDeactivate);
    this.jetBtn.on("pointerout", jetDeactivate);

    // Set idle alpha on both
    this.ropeBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    this.jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
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
