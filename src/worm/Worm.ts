import type Phaser from "phaser";
import { Box, Circle } from "planck";
import type { Body, Fixture } from "planck";
import type { PhysicsSystem } from "../physics/PhysicsSystem";
import { toMeters, toPixels } from "../physics/scale";
import { tuning } from "../tuning";
import type { Drill } from "../utilities/Drill";
import type { JetPack } from "../utilities/JetPack";
import type { NinjaRope } from "../utilities/NinjaRope";
import type { Team } from "./Team";
import { stepAim } from "./aimAngle";

export interface WormInit {
  scene: Phaser.Scene;
  physics: PhysicsSystem;
  team: Team;
  spawnXPx: number;
  spawnYPx: number;
  wormName?: string;
}

export interface WormUserData {
  kind: "worm";
  worm: Worm;
}

export class Worm {
  readonly team: Team;
  readonly body: Body;
  readonly name: string;

  // Public state
  health: number;
  aimAngle = -Math.PI / 4; // radians; -PI/4 = 45deg up-forward (hits terrain reliably on rolling hills)
  aimPower01 = 0.5; // 0..1 power level for weapon fire
  facing: -1 | 1 = 1;
  pendingDamage = 0;
  isAlive = true;

  // Utility state - set from OfflineSimAdapter after construction, not in constructor
  ropeUtility!: NinjaRope; // assigned by OfflineSimAdapter after worm spawn
  jetPackUtility!: JetPack; // assigned by OfflineSimAdapter after worm spawn
  drillUtility!: Drill; // assigned by OfflineSimAdapter after worm spawn
  private activeRope: NinjaRope | null = null;
  private jetPackActive = false;

  private isActivePlayer = false;

  // Foot contact tracking
  private footContactCount = 0;
  private footSensor: Fixture;

  // Phaser visuals
  private readonly scene: Phaser.Scene;
  private readonly graphics: Phaser.GameObjects.Graphics;
  private readonly nameText: Phaser.GameObjects.Text;
  private readonly healthText: Phaser.GameObjects.Text;

  // Aim direction queued per frame
  private aimDir: -1 | 0 | 1 = 0;

  constructor(init: WormInit) {
    this.scene = init.scene;
    this.team = init.team;
    this.name = init.wormName ?? `${init.team.id}-worm`;
    this.health = tuning.worm.maxHealth;

    const radius = toMeters(tuning.worm.radiusPx);

    // Create dynamic body
    this.body = init.physics.world.createBody({
      type: "dynamic",
      position: { x: toMeters(init.spawnXPx), y: toMeters(init.spawnYPx) },
      fixedRotation: true,
      linearDamping: tuning.worm.linearDamping,
    });

    // Main circle fixture
    this.body.createFixture({
      shape: new Circle(radius),
      density: tuning.worm.density,
      friction: 1.0,
      restitution: 0.1,
    });

    // Foot sensor - small box offset below circle center
    const sensorHalfW = toMeters(tuning.worm.radiusPx * 0.6);
    const sensorHalfH = toMeters(tuning.worm.radiusPx * 0.3);
    this.footSensor = this.body.createFixture({
      shape: new Box(sensorHalfW, sensorHalfH, { x: 0, y: radius }, 0),
      isSensor: true,
      density: 0,
      friction: 0,
    });
    // Set user data on body for contact listener identification
    const userData: WormUserData = { kind: "worm", worm: this };
    this.body.setUserData(userData);
    this.footSensor.setUserData({ kind: "worm-foot", worm: this });

    // Phaser graphics placeholder
    this.graphics = this.scene.add.graphics();
    this.graphics.setDepth(5);

    // Name text above worm
    this.nameText = this.scene.add
      .text(init.spawnXPx, init.spawnYPx - 30, this.name, {
        fontSize: "11px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(6);

    // Health text
    this.healthText = this.scene.add
      .text(init.spawnXPx, init.spawnYPx - 18, `${this.health}`, {
        fontSize: "12px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5, 1)
      .setDepth(6);

    this.drawWorm(init.spawnXPx, init.spawnYPx);
  }

  /** Expose the graphics object for camera follow targets. */
  get graphicsObject(): Phaser.GameObjects.Graphics {
    return this.graphics;
  }

  // ------ Movement ------

  walk(direction: -1 | 0 | 1): void {
    if (!this.isAlive) return;
    if (this.activeRope !== null) return; // rope controls own lateral physics
    if (this.jetPackActive) return; // walk keys intercepted by JetPack.setHorizontalInput
    // Airborne: walk inputs do not override horizontal velocity. The worm
    // keeps whatever momentum it had (from jet thrust, jump, or knockback)
    // until it touches ground again. Facing still updates so aim direction
    // tracks player intent.
    if (this.footContactCount === 0) {
      if (direction !== 0) this.setFacing(direction);
      return;
    }
    const vel = this.body.getLinearVelocity();
    const targetVx = direction * tuning.worm.walkSpeedMps;
    this.body.setLinearVelocity({ x: targetVx, y: vel.y });
    if (direction !== 0) this.setFacing(direction);
  }

  jump(): void {
    if (!this.isAlive) return;
    if (this.activeRope !== null) return; // no jumping while roped
    if (this.jetPackActive) return; // no jumping while jetpacking
    if (!this.canJump()) return;
    const d = tuning.worm.density;
    this.body.applyLinearImpulse(
      { x: this.facing * 1.5 * d, y: -2 * 1.5 * d },
      this.body.getPosition(),
    );
  }

  backflip(): void {
    if (!this.isAlive) return;
    if (this.activeRope !== null) return; // no backflip while roped
    if (this.jetPackActive) return; // no backflip while jetpacking
    if (!this.canJump()) return;
    const d = tuning.worm.density;
    this.body.applyLinearImpulse(
      { x: -this.facing * 2.3 * d, y: -2 * 2.3 * d },
      this.body.getPosition(),
    );
  }

  aim(direction: -1 | 0 | 1): void {
    if (!this.isAlive) return;
    this.aimDir = direction;
  }

  /**
   * Set aim angle directly (radians). Clamped to [-PI/2, PI/2].
   * Facing is handled by the caller (fire.ts multiplies by firer.facing).
   */
  setAimAngle(rad: number): void {
    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
    this.aimAngle = clamp(rad, -Math.PI / 2, Math.PI / 2);
  }

  /** Set aim power 0..1, clamped. */
  setAimPower(p: number): void {
    this.aimPower01 = Math.max(0, Math.min(1, p));
  }

  /** Nudge aim power by delta, clamped. */
  nudgeAimPower(delta: number): void {
    this.setAimPower(this.aimPower01 + delta);
  }

  setFacing(dir: -1 | 1): void {
    this.facing = dir;
  }

  // ------ Health ------

  takeDamage(amount: number): void {
    if (!this.isAlive) return;
    this.pendingDamage += amount;
  }

  /**
   * Force-kill (off-map culling). Mirrors worker Worm.kill(): drops health,
   * marks dead, dims sprite, and disarms utilities so a roped or jetting
   * worm doesn't keep its body anchored once it has fallen off the world.
   * Idempotent.
   */
  kill(): void {
    if (!this.isAlive) return;
    this.health = 0;
    this.isAlive = false;
    this.graphics.setAlpha(0.3);
    this.ropeUtility?.deactivate();
    this.jetPackUtility?.deactivate();
    this.drillUtility?.disarm();
  }

  applyPendingDamage(): void {
    if (!this.isAlive) return;
    if (this.pendingDamage <= 0) return;
    this.health = Math.max(0, this.health - this.pendingDamage);
    this.pendingDamage = 0;

    // Cancel any prior damage tween before starting a new one
    this.scene.tweens.killTweensOf(this.graphics);
    this.graphics.setAlpha(1);

    // Flash red
    this.scene.tweens.add({
      targets: this.graphics,
      alpha: { from: 1, to: 0.3 },
      yoyo: true,
      duration: 150,
      repeat: 1,
      onComplete: () => {
        this.graphics.setAlpha(1);
      },
    });

    if (this.health <= 0) {
      this.isAlive = false;
      this.graphics.setAlpha(0.3);
    }
  }

  // ------ Lifecycle ------

  update(dtMs: number): void {
    const pos = this.body.getPosition();
    const xPx = toPixels(pos.x);
    const yPx = toPixels(pos.y);

    if (this.isAlive && this.aimDir !== 0) {
      this.aimAngle = stepAim(
        this.aimAngle,
        this.aimDir,
        tuning.worm.aimSpeedRadPerSec,
        dtMs / 1000,
      );
      this.aimDir = 0;
    }

    this.drawWorm(xPx, yPx);

    this.nameText.setPosition(xPx, yPx - tuning.worm.radiusPx - 18);
    this.healthText.setPosition(xPx, yPx - tuning.worm.radiusPx - 6);
    const fuelStr =
      this.isAlive && this.jetPackActive
        ? ` fuel:${Math.ceil(this.jetPackUtility?.fuel ?? 0)}`
        : "";
    this.healthText.setText(`${this.health}${fuelStr}`);
  }

  destroy(): void {
    // Clean up utilities before destroying body (joints reference worm body)
    this.ropeUtility?.destroy();
    this.jetPackUtility?.destroy();
    // drillUtility has no external resources to release (no joints/planck objects)
    if (this.body.isActive()) {
      // Clear userData before destroying to break circular ref for GC
      this.body.setUserData(null);
      // Mark inactive before removing to avoid double-destroy
      this.body.getWorld().destroyBody(this.body);
    }
    this.graphics.destroy();
    this.nameText.destroy();
    this.healthText.destroy();
  }

  // ------ Foot contact (called by world contact listener) ------

  onFootContactBegin(): void {
    this.footContactCount++;
  }

  onFootContactEnd(): void {
    this.footContactCount = Math.max(0, this.footContactCount - 1);
  }

  // ------ Private helpers ------

  private canJump(): boolean {
    const vel = this.body.getLinearVelocity();
    return this.footContactCount > 0 && Math.abs(vel.y) < 0.5;
  }

  private drawWorm(xPx: number, yPx: number): void {
    const r = tuning.worm.radiusPx;
    const color = this.team.color;

    // Position the Graphics transform at the worm's world pos so
    // camera.startFollow(graphics) tracks the worm. Shapes are drawn
    // origin-relative below.
    this.graphics.setPosition(xPx, yPx);
    this.graphics.clear();

    if (this.isActivePlayer) {
      this.graphics.lineStyle(3, 0xffff00, 1);
      this.graphics.strokeCircle(0, 0, r + 4);
    }

    this.graphics.fillStyle(color, 1);
    this.graphics.fillCircle(0, 0, r);

    this.graphics.lineStyle(1.5, 0xffffff, 0.6);
    this.graphics.strokeCircle(0, 0, r);

    if (this.isActivePlayer) {
      const aimLen = r * 2.2;
      const ax = Math.cos(this.aimAngle) * this.facing * aimLen;
      const ay = Math.sin(this.aimAngle) * aimLen;
      this.graphics.lineStyle(2, 0xffffff, 0.8);
      this.graphics.beginPath();
      this.graphics.moveTo(0, 0);
      this.graphics.lineTo(ax, ay);
      this.graphics.strokePath();
    }
  }

  /** Highlight this worm as the active one. */
  setActive(active: boolean): void {
    this.isActivePlayer = active;
    if (active) {
      this.graphics.setAlpha(1.0);
    } else {
      this.graphics.setAlpha(this.isAlive ? 0.45 : 0.2);
    }
  }

  // ------ Utility state (set by NinjaRope / JetPack, not by InputController) ------

  /** Called by NinjaRope when attaching/detaching. */
  setActiveRope(rope: NinjaRope | null): void {
    this.activeRope = rope;
  }

  /** Called by JetPack when activating/deactivating. */
  setJetPackActive(active: boolean): void {
    this.jetPackActive = active;
  }

  isRoped(): boolean {
    return this.activeRope !== null;
  }

  isJetPacking(): boolean {
    return this.jetPackActive;
  }

  /** Pixel X position (derived from physics body). */
  get xPx(): number {
    return toPixels(this.body.getPosition().x);
  }

  /** Pixel Y position (derived from physics body). */
  get yPx(): number {
    return toPixels(this.body.getPosition().y);
  }

  /** Passthrough to planck body gravity scale. */
  setGravityScale(scale: number): void {
    this.body.setGravityScale(scale);
  }

  /** Return foot sensor fixture for contact listener checks. */
  getFootSensor(): Fixture {
    return this.footSensor;
  }
}
