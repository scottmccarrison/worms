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
 *
 * JetPack button uses a virtual-joystick (press-and-hold + slide).
 * Press J to engage; slide finger from J center; thrust direction is
 * the OPPOSITE of the slide direction (slingshot). Release to disengage.
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

  // Virtual joystick state for the J button.
  private jetGestureActive = false;
  private jetGesturePointerId = -1;
  private jetButtonCenterX = 0;
  private jetButtonCenterY = 0;

  // Joystick visual indicator graphics (scrollFactor 0, always in viewport coords).
  private jetIndicatorRing: Phaser.GameObjects.Graphics | null = null;
  private jetIndicatorDot: Phaser.GameObjects.Graphics | null = null;

  // Bound event handlers stored so we can remove them in destroy().
  private _onPointerMove: ((p: Phaser.Input.Pointer) => void) | null = null;
  private _onPointerUp: ((p: Phaser.Input.Pointer) => void) | null = null;

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
    // SNES-style face-button cluster, anchored bottom-left for thumb reach.
    // Triangle: J at the top (anchor for the joystick slide); R + D form the
    // base. J is set 220px above the bottom edge so a downward slide (which
    // thrusts the worm UP via slingshot) has the full joystickMaxSlidePx
    // budget before the finger leaves the canvas.
    const sceneH = this.scene.scale.height;
    const triangleCenterX = 130;
    const triangleTopY = sceneH - 220;
    const triangleBaseY = sceneH - 110;
    const triangleHorizSpread = 60; // half-width: R is -spread, D is +spread from center
    const rPosX = triangleCenterX - triangleHorizSpread;
    const rPosY = triangleBaseY;
    const jPosX = triangleCenterX;
    const jPosY = triangleTopY;
    const dPosX = triangleCenterX + triangleHorizSpread;
    const dPosY = triangleBaseY;
    // Hit-test radius is generously larger than the visual radius so a finger
    // tap doesn't have to land dead-center to register.
    const hitRadius = Math.round(radius * 1.5);

    if (ropeEnabled) {
      // --- Rope button (top-left) ---
      const ropeBtn = this._makeButton({
        fillColor: 0x2266cc,
        strokeColor: 0x88aaff,
        label: "R",
        radius,
      });
      ropeBtn.setPosition(rPosX, rPosY);
      ropeBtn.setScrollFactor(0);
      this.ropeBtn = ropeBtn;
      this.container.add(ropeBtn);

      ropeBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, hitRadius),
        hitAreaCallback: Phaser.Geom.Circle.Contains,
      });
      // Aim-and-fire pattern (matches drill): tap R to arm, drag-aim, release
      // fires rope.activate() at the aim direction. Tap R while attached
      // detaches. No radial dpad for rope - swing is passive under gravity.
      ropeBtn.on("pointerdown", () => {
        const w = this.getActiveWorm();
        if (!w) return;
        if (w.ropeUtility.isActive()) {
          w.ropeUtility.deactivate();
          return;
        }
        if (w.ropeUtility.isArmed()) {
          w.ropeUtility.disarm();
          return;
        }
        // Mutually exclusive with jet/drill
        if (w.jetPackUtility?.isActive()) w.jetPackUtility.deactivate();
        if (w.drillUtility?.isArmed()) w.drillUtility.disarm();
        w.ropeUtility.arm();
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
      const jetBtnX = jPosX;
      const jetBtnY = jPosY;
      jetBtn.setPosition(jetBtnX, jetBtnY);
      jetBtn.setScrollFactor(0);
      this.jetBtn = jetBtn;
      this.container.add(jetBtn);

      // Store J button center in screen coords (viewport coords, scrollFactor 0).
      this.jetButtonCenterX = jetBtnX;
      this.jetButtonCenterY = jetBtnY;

      // Fuel bar - thin horizontal strip at the bottom of the button.
      // Drawn here, redrawn each update() based on jetPackUtility.getFuelPercent().
      this.jetFuelBar = this.scene.add.graphics();
      jetBtn.add(this.jetFuelBar);

      // Indicator graphics: ring (depth 99) and dot (depth 101).
      // These are scene-level objects (not inside the container) so they stay in
      // viewport coords via scrollFactor 0.
      this.jetIndicatorRing = this.scene.add.graphics();
      this.jetIndicatorRing.setScrollFactor(0);
      this.jetIndicatorRing.setDepth(99);
      this.jetIndicatorRing.setVisible(false);

      this.jetIndicatorDot = this.scene.add.graphics();
      this.jetIndicatorDot.setScrollFactor(0);
      this.jetIndicatorDot.setDepth(101);
      this.jetIndicatorDot.setVisible(false);

      jetBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, hitRadius),
        hitAreaCallback: Phaser.Geom.Circle.Contains,
      });

      // Press-and-hold + virtual joystick pattern.
      // Down: engage jet immediately if fuel > 0; begin tracking finger position.
      // Move: compute thrust as opposite of slide direction (slingshot).
      // Up: disengage jet, clear indicators.
      jetBtn.on("pointerdown", (p: Phaser.Input.Pointer) => {
        // Reject secondary touches: only one finger drives the joystick.
        if (this.jetGestureActive) return;
        const w = this.getActiveWorm();
        if (!w) return;
        // Exhausted: tap is a no-op.
        if (w.jetPackUtility.getFuelPercent() <= 0) return;
        // Mutually exclusive: deactivate rope/drill before engaging jet.
        if (w.ropeUtility?.isActive()) w.ropeUtility.deactivate();
        if (w.drillUtility?.isArmed()) w.drillUtility.disarm();
        // Activate jet immediately.
        if (!w.jetPackUtility.isActive()) {
          w.jetPackUtility.activate();
        }
        // Start joystick tracking. Re-read the button's current position
        // each press so any layout change since construction is reflected.
        this.jetButtonCenterX = jetBtn.x;
        this.jetButtonCenterY = jetBtn.y;
        this.jetGestureActive = true;
        this.jetGesturePointerId = p.id;
        // Thrust starts at zero (neutral) until the finger slides.
        w.jetPackUtility.setThrustVector(0, 0);
        this._showJoystickIndicator(this.jetButtonCenterX, this.jetButtonCenterY);
        jetBtn.setAlpha(tuning.touch.buttonPressedAlpha);
      });

      jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);

      // Scene-level pointermove: update thrust while J is held and finger slides.
      this._onPointerMove = (p: Phaser.Input.Pointer) => {
        if (!this.jetGestureActive || p.id !== this.jetGesturePointerId) return;
        const w = this.getActiveWorm();
        if (!w || !w.jetPackUtility.isActive()) return;

        const cx = this.jetButtonCenterX;
        const cy = this.jetButtonCenterY;
        // Use screen (viewport) coords - the button is scrollFactor 0.
        const dx = p.x - cx;
        const dy = p.y - cy;
        const dist = Math.hypot(dx, dy);

        const deadZone = tuning.jetpack.joystickDeadZonePx;
        const maxSlide = tuning.jetpack.joystickMaxSlidePx;

        if (dist < deadZone) {
          // In dead zone: zero thrust.
          w.jetPackUtility.setThrustVector(0, 0);
          this._updateJoystickDot(cx, cy);
          return;
        }

        // Slingshot: thrust direction is OPPOSITE of slide.
        const nx = -(dx / dist);
        const ny = -(dy / dist);
        const mag = Math.min(1, (dist - deadZone) / (maxSlide - deadZone));
        w.jetPackUtility.setThrustVector(nx * mag, ny * mag);

        // Clamp dot to maxSlide radius visually.
        const clampedDist = Math.min(dist, maxSlide);
        const dotX = cx + (dx / dist) * clampedDist;
        const dotY = cy + (dy / dist) * clampedDist;
        this._updateJoystickDot(dotX, dotY);
      };

      // Scene-level pointerup / pointercancel: disengage jet. Pointercancel
      // fires when the OS interrupts a touch (incoming call, screenshot,
      // browser swipe gesture). Without it, the gesture would hang and
      // thrust would keep applying invisibly.
      this._onPointerUp = (p: Phaser.Input.Pointer) => {
        if (!this.jetGestureActive || p.id !== this.jetGesturePointerId) return;
        const w = this.getActiveWorm();
        if (w?.jetPackUtility.isActive()) {
          w.jetPackUtility.setThrustVector(0, 0);
          w.jetPackUtility.deactivate();
        }
        this.jetGestureActive = false;
        this.jetGesturePointerId = -1;
        this._hideJoystickIndicator();
      };

      this.scene.input.on("pointermove", this._onPointerMove);
      this.scene.input.on("pointerup", this._onPointerUp);
      this.scene.input.on("pointercancel", this._onPointerUp);
    }

    if (drillEnabled) {
      // --- Drill button (top-left, right of jetpack) ---
      const drillBtn = this._makeButton({
        fillColor: 0x22aa55,
        strokeColor: 0x66dd99,
        label: "D",
        radius,
      });
      drillBtn.setPosition(dPosX, dPosY);
      drillBtn.setScrollFactor(0);
      this.drillBtn = drillBtn;
      this.container.add(drillBtn);

      drillBtn.setInteractive({
        hitArea: new Phaser.Geom.Circle(0, 0, hitRadius),
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
          if (w.ropeUtility?.isArmed?.()) w.ropeUtility.disarm();
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
    if (this._onPointerMove) {
      this.scene.input.off("pointermove", this._onPointerMove);
      this._onPointerMove = null;
    }
    if (this._onPointerUp) {
      this.scene.input.off("pointerup", this._onPointerUp);
      this.scene.input.off("pointercancel", this._onPointerUp);
      this._onPointerUp = null;
    }
    this.jetIndicatorRing?.destroy();
    this.jetIndicatorRing = null;
    this.jetIndicatorDot?.destroy();
    this.jetIndicatorDot = null;
    this.container.destroy();
  }

  /**
   * Public reset hook for turn rotations. Called by GameScene when the active
   * worm changes so a hung gesture (finger still on J when timer expired)
   * doesn't leak thrust state into the next worm's turn.
   */
  resetGestureState(): void {
    if (!this.jetGestureActive) return;
    const w = this.getActiveWorm();
    if (w?.jetPackUtility.isActive()) {
      w.jetPackUtility.setThrustVector(0, 0);
      w.jetPackUtility.deactivate();
    }
    this.jetGestureActive = false;
    this.jetGesturePointerId = -1;
    this._hideJoystickIndicator();
    if (this.jetBtn) this.jetBtn.setAlpha(tuning.touch.buttonIdleAlpha);
  }

  // ---------------------------------------------------------------------------
  // Joystick indicator helpers
  // ---------------------------------------------------------------------------

  /** Draw the joystick ring centered at (cx, cy) and show indicator graphics. */
  private _showJoystickIndicator(cx: number, cy: number): void {
    const maxSlide = tuning.jetpack.joystickMaxSlidePx;
    if (this.jetIndicatorRing) {
      this.jetIndicatorRing.clear();
      this.jetIndicatorRing.lineStyle(2, 0xff9933, 0.4);
      this.jetIndicatorRing.strokeCircle(cx, cy, maxSlide);
      this.jetIndicatorRing.setVisible(true);
    }
    if (this.jetIndicatorDot) {
      this.jetIndicatorDot.clear();
      this.jetIndicatorDot.fillStyle(0xff9933, 0.9);
      this.jetIndicatorDot.fillCircle(cx, cy, 6);
      this.jetIndicatorDot.setVisible(true);
    }
  }

  /** Redraw the dot at the clamped finger position. */
  private _updateJoystickDot(x: number, y: number): void {
    if (!this.jetIndicatorDot) return;
    this.jetIndicatorDot.clear();
    this.jetIndicatorDot.fillStyle(0xff9933, 0.9);
    this.jetIndicatorDot.fillCircle(x, y, 6);
  }

  /** Hide both indicator graphics and clear gesture state. */
  private _hideJoystickIndicator(): void {
    this.jetIndicatorRing?.setVisible(false);
    this.jetIndicatorDot?.setVisible(false);
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
    // Pressed alpha when attached OR armed (waiting for drag-fire). Idle otherwise.
    const isLit = w.ropeUtility.isActive() || w.ropeUtility.isArmed();
    this._setButtonAlpha(this.ropeBtn, isLit);
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
    } else if (this.jetGestureActive) {
      // Keep pressed alpha while joystick is held.
      this.jetBtn.setAlpha(tuning.touch.buttonPressedAlpha);
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
