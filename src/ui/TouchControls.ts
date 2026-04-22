import * as Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";

export interface TouchControlsInit {
  scene: Phaser.Scene;
  getActiveWorm: () => Worm | null;
  /**
   * When false (default true), the rope button is not rendered.
   * Use this to disable rope in networked mode until the rope port ships.
   */
  ropeEnabled?: boolean;
  /**
   * When false (default true), the jetpack button is not rendered.
   */
  jetPackEnabled?: boolean;
  /** @deprecated Use ropeEnabled/jetPackEnabled instead. */
  networked?: boolean;
  /** Sim adapter used for jetpack toggle in networked mode. */
  sim?: SimAdapter;
}

/**
 * On-screen touch overlay with rope + jetpack buttons.
 *
 * Button visibility is controlled per-utility via `ropeEnabled` and
 * `jetPackEnabled` (both default true). In networked mode, pass
 * `ropeEnabled: false` to hide rope (not yet ported) while keeping
 * the jetpack button active.
 *
 * The container is always constructed so `destroy()` and `hitsButton()`
 * work regardless of which buttons were created.
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

    // Resolve flags: new per-utility flags take precedence; legacy `networked`
    // flag maps to ropeEnabled=false, jetPackEnabled=true for backward compat.
    const ropeEnabled = init.ropeEnabled ?? !init.networked;
    const jetPackEnabled = init.jetPackEnabled ?? true;

    const { getActiveWorm } = init;
    const radius = tuning.touch.buttonRadiusPx;
    // End-turn button occupies the top-right 80px square (TurnHUD). Stack rope
    // + jet along the LEFT edge so neither their tap areas nor the End button's
    // hit area overlap.
    const leftX = 60;

    if (ropeEnabled) {
      // --- Rope button (top-left) ---
      const ropeBtn = this._makeButton({
        fillColor: 0x2266cc,
        strokeColor: 0x88aaff,
        label: "R",
        radius,
      });
      ropeBtn.setPosition(leftX, 60);
      this.ropeBtn = ropeBtn;
      this.container.add(ropeBtn);

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
      ropeBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }

    if (jetPackEnabled) {
      // --- JetPack button (top-left, right of rope) ---
      const jetBtn = this._makeButton({
        fillColor: 0xcc6600,
        strokeColor: 0xff9933,
        label: "J",
        radius,
      });
      // Offset by rope's footprint (+10px gap) even if rope is disabled, so
      // the jet button sits at the same absolute position in both modes.
      jetBtn.setPosition(leftX + radius * 2 + 10, 60);
      this.jetBtn = jetBtn;
      this.container.add(jetBtn);

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
      jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }
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
