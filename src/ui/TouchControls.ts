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
  /**
   * When false (default true), the drill button is not rendered.
   */
  drillEnabled?: boolean;
  /** @deprecated Use ropeEnabled/jetPackEnabled instead. */
  networked?: boolean;
  /** Sim adapter used for jetpack toggle in networked mode. */
  sim?: SimAdapter;
}

/**
 * On-screen touch overlay with rope + jetpack + drill buttons.
 *
 * Button visibility is controlled per-utility via `ropeEnabled`,
 * `jetPackEnabled`, and `drillEnabled` (all default true).
 *
 * `update()` should be called each frame from the scene; it refreshes
 * button visuals based on the active worm's utility state (jet fuel
 * level, drill uses-this-turn).
 */
export class TouchControls {
  private readonly container: Phaser.GameObjects.Container;
  private ropeBtn: Phaser.GameObjects.Container | null = null;
  private jetBtn: Phaser.GameObjects.Container | null = null;
  drillBtn: Phaser.GameObjects.Container | null = null;
  /** Per-button fuel/cooldown overlays drawn under the label. */
  private jetFuelBar: Phaser.GameObjects.Graphics | null = null;
  private readonly scene: Phaser.Scene;
  private readonly getActiveWorm: () => Worm | null;
  private readonly buttonRadius: number;

  constructor(init: TouchControlsInit) {
    this.scene = init.scene;
    this.getActiveWorm = init.getActiveWorm;
    // Always make an empty container so `destroy()` and `hitsButton()` have
    // a consistent target regardless of mode.
    this.container = this.scene.add.container(0, 0);
    this.container.setDepth(100);
    this.container.setScrollFactor(0);

    // Resolve flags: new per-utility flags take precedence; legacy `networked`
    // flag maps to ropeEnabled=false, jetPackEnabled=true for backward compat.
    const ropeEnabled = init.ropeEnabled ?? !init.networked;
    const jetPackEnabled = init.jetPackEnabled ?? true;
    const drillEnabled = init.drillEnabled ?? true;

    const radius = tuning.touch.buttonRadiusPx;
    this.buttonRadius = radius;
    // End-turn button occupies the top-right 80px square (TurnHUD). Stack rope
    // + jet + drill along the LEFT edge so neither their tap areas nor the End
    // button's hit area overlap.
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
      ropeBtn.setScrollFactor(0);
      this.ropeBtn = ropeBtn;
      this.container.add(ropeBtn);

      ropeBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, radius),
        hitAreaCallback: Phaser.Geom.Circle.Contains,
      });
      ropeBtn.on("pointerdown", () => {
        const w = this.getActiveWorm();
        if (!w) return;
        w.ropeUtility.isActive() ? w.ropeUtility.deactivate() : w.ropeUtility.activate();
        this._setButtonAlpha(ropeBtn, w.ropeUtility.isActive());
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
      jetBtn.setPosition(leftX + radius * 2 + 10, 60);
      jetBtn.setScrollFactor(0);
      this.jetBtn = jetBtn;
      this.container.add(jetBtn);

      // Fuel bar - thin horizontal strip at the bottom of the button.
      // Drawn here, redrawn each update() based on jetPackUtility.getFuelPercent().
      this.jetFuelBar = this.scene.add.graphics();
      jetBtn.add(this.jetFuelBar);

      jetBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, radius),
        hitAreaCallback: Phaser.Geom.Circle.Contains,
      });
      // Toggle pattern matching R and D: tap engages jet, tap again disengages.
      // Directional thrust comes from the UtilityDPad (which appears while jet is
      // active). Press-and-hold on the J button is intentionally NOT used.
      jetBtn.on("pointerdown", () => {
        const w = this.getActiveWorm();
        if (!w) return;
        if (w.jetPackUtility.isActive()) {
          w.jetPackUtility.deactivate();
          return;
        }
        // Exhausted: tap is a no-op. JetPack.activate() also gates internally.
        if (w.jetPackUtility.getFuelPercent() <= 0) return;
        w.jetPackUtility.activate();
      });
      jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }

    if (drillEnabled) {
      // --- Drill button (top-left, right of jetpack) ---
      const drillBtn = this._makeButton({
        fillColor: 0x22aa55,
        strokeColor: 0x66dd99,
        label: "D",
        radius,
      });
      drillBtn.setPosition(leftX + (radius * 2 + 10) * 2, 60);
      drillBtn.setScrollFactor(0);
      this.drillBtn = drillBtn;
      this.container.add(drillBtn);

      drillBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, radius),
        hitAreaCallback: Phaser.Geom.Circle.Contains,
      });
      drillBtn.on("pointerdown", () => {
        const w = this.getActiveWorm();
        if (!w) return;
        // Exhausted: tap is a no-op.
        if (!w.drillUtility.hasUsesRemaining(tuning.drill.usesPerTurn)) return;
        if (w.drillUtility.isArmed()) {
          w.drillUtility.disarm();
        } else {
          // Mutually exclusive with rope/jet
          if (w.ropeUtility?.isActive()) w.ropeUtility.deactivate();
          if (w.jetPackUtility?.isActive()) w.jetPackUtility.deactivate();
          w.drillUtility.arm();
        }
        // Visual refresh handled by update() next frame
      });
      drillBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }
  }

  /**
   * Per-frame visual refresh. Reads the active worm's utility state and
   * updates each button's alpha + (for jet) the fuel bar. Should be called
   * from GameScene.update().
   */
  update(): void {
    const w = this.getActiveWorm();
    if (this.jetBtn) this._refreshJetButton(w);
    if (this.drillBtn) this._refreshDrillButton(w);
    if (this.ropeBtn) this._refreshRopeButton(w);
  }

  /**
   * Returns true if the given pointer position hits any interactive button.
   * Used by GameScene to gate terrain cut from touch events.
   */
  hitsButton(pointer: Phaser.Input.Pointer): boolean {
    const hits = this.scene.input.hitTestPointer(pointer);
    return hits.some((obj) => obj === this.ropeBtn || obj === this.jetBtn || obj === this.drillBtn);
  }

  destroy(): void {
    this.container.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers - per-button refresh
  // ---------------------------------------------------------------------------

  private _refreshRopeButton(w: Worm | null): void {
    if (!this.ropeBtn) return;
    if (!w) {
      this.ropeBtn.setAlpha(tuning.touch.buttonIdleAlpha);
      return;
    }
    this._setButtonAlpha(this.ropeBtn, w.ropeUtility.isActive());
  }

  private _refreshJetButton(w: Worm | null): void {
    if (!this.jetBtn || !this.jetFuelBar) return;
    if (!w) {
      this.jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
      this.jetFuelBar.clear();
      return;
    }
    const fuelPct = w.jetPackUtility.getFuelPercent();
    const exhausted = fuelPct <= 0;
    if (exhausted) {
      this.jetBtn.setAlpha(tuning.touch.buttonExhaustedAlpha);
    } else if (w.jetPackUtility.isActive()) {
      this.jetBtn.setAlpha(tuning.touch.buttonPressedAlpha);
    } else {
      this.jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }
    this._drawFuelBar(this.jetFuelBar, fuelPct);
  }

  private _refreshDrillButton(w: Worm | null): void {
    if (!this.drillBtn) return;
    if (!w) {
      this.drillBtn.setAlpha(tuning.touch.buttonIdleAlpha);
      return;
    }
    const remaining = w.drillUtility.hasUsesRemaining(tuning.drill.usesPerTurn);
    if (!remaining) {
      this.drillBtn.setAlpha(tuning.touch.buttonExhaustedAlpha);
    } else if (w.drillUtility.isArmed()) {
      this.drillBtn.setAlpha(tuning.touch.buttonPressedAlpha);
    } else {
      this.drillBtn.setAlpha(tuning.touch.buttonIdleAlpha);
    }
  }

  /**
   * Draw a thin fuel bar at the bottom of a button. Local coords (button is
   * a Container so 0,0 is button center).
   * Bar color: green > 50%, yellow 20-50%, red < 20%.
   */
  private _drawFuelBar(g: Phaser.GameObjects.Graphics, pct: number): void {
    g.clear();
    const r = this.buttonRadius;
    const barW = r * 1.6; // slightly inset from button edge
    const barH = 4;
    const barX = -barW / 2;
    const barY = r - barH - 2; // 2px inset from bottom edge of circle
    const clamped = Math.max(0, Math.min(1, pct));

    // Background track
    g.fillStyle(0x000000, 0.5);
    g.fillRect(barX, barY, barW, barH);

    if (clamped <= 0) return;

    // Fill color tier
    const fillColor = clamped > 0.5 ? 0x55cc44 : clamped > 0.2 ? 0xffaa00 : 0xff3322;
    g.fillStyle(fillColor, 1.0);
    g.fillRect(barX, barY, barW * clamped, barH);
  }

  // ---------------------------------------------------------------------------
  // Private helpers - construction
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
}
