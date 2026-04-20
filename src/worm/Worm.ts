import type Phaser from "phaser";
import { Circle } from "planck";
import type { Body, Fixture } from "planck";
import type { PhysicsSystem } from "../physics/PhysicsSystem";
import { toMeters, toPixels } from "../physics/scale";
import { tuning } from "../tuning";
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
  aimAngle = 0; // radians; 0 = aim right
  facing: -1 | 1 = 1;
  pendingDamage = 0;
  isAlive = true;

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

    // Foot sensor - small box below circle center
    const sensorHalfW = toMeters(tuning.worm.radiusPx * 0.6);
    const sensorHalfH = toMeters(tuning.worm.radiusPx * 0.3);
    this.footSensor = this.body.createFixture({
      shape: new Circle(radius * 1.05), // slightly larger, offset below
      isSensor: true,
      density: 0,
      friction: 0,
      filterMaskBits: 0x0001,
    });
    // Set user data on body for contact listener identification
    const userData: WormUserData = { kind: "worm", worm: this };
    this.body.setUserData(userData);
    this.footSensor.setUserData({ kind: "worm-foot", worm: this });

    // Phaser graphics placeholder (colored rectangle ~40x30)
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

    // Suppress unused variable lint warning - footSensor is used via contact listeners
    void sensorHalfW;
    void sensorHalfH;
  }

  // ------ Movement ------

  walk(direction: -1 | 0 | 1): void {
    const vel = this.body.getLinearVelocity();
    const targetVx = direction * tuning.worm.walkSpeedMps;
    this.body.setLinearVelocity({ x: targetVx, y: vel.y });
    if (direction !== 0) this.setFacing(direction);
  }

  jump(): void {
    if (!this.canJump()) return;
    const d = tuning.worm.density;
    this.body.applyLinearImpulse(
      { x: this.facing * 1.5 * d, y: -2 * 1.5 * d },
      this.body.getPosition(),
    );
  }

  backflip(): void {
    if (!this.canJump()) return;
    const d = tuning.worm.density;
    this.body.applyLinearImpulse(
      { x: -this.facing * 2.3 * d, y: -2 * 2.3 * d },
      this.body.getPosition(),
    );
  }

  aim(direction: -1 | 0 | 1): void {
    this.aimDir = direction;
  }

  setFacing(dir: -1 | 1): void {
    this.facing = dir;
  }

  // ------ Health ------

  takeDamage(amount: number): void {
    this.pendingDamage += amount;
  }

  applyPendingDamage(): void {
    if (this.pendingDamage <= 0) return;
    this.health = Math.max(0, this.health - this.pendingDamage);
    this.pendingDamage = 0;

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
    if (!this.isAlive) return;

    const pos = this.body.getPosition();
    const xPx = toPixels(pos.x);
    const yPx = toPixels(pos.y);

    // Step aim angle
    if (this.aimDir !== 0) {
      this.aimAngle = stepAim(
        this.aimAngle,
        this.aimDir,
        tuning.worm.aimSpeedRadPerSec,
        dtMs / 1000,
      );
      this.aimDir = 0;
    }

    this.drawWorm(xPx, yPx);

    // Update text positions
    this.nameText.setPosition(xPx, yPx - tuning.worm.radiusPx - 18);
    this.healthText.setPosition(xPx, yPx - tuning.worm.radiusPx - 6);
    this.healthText.setText(`${this.health}`);
  }

  destroy(): void {
    if (this.body.isActive()) {
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

    this.graphics.clear();

    // Body circle
    this.graphics.fillStyle(color, 1);
    this.graphics.fillCircle(xPx, yPx, r);

    // Outline - brighter when selected (toggled externally by GameScene)
    this.graphics.lineStyle(1.5, 0xffffff, 0.6);
    this.graphics.strokeCircle(xPx, yPx, r);

    // Aim line
    const aimLen = r * 2.2;
    const ax = xPx + Math.cos(this.aimAngle) * this.facing * aimLen;
    const ay = yPx + Math.sin(this.aimAngle) * aimLen;
    this.graphics.lineStyle(2, 0xffffff, 0.8);
    this.graphics.beginPath();
    this.graphics.moveTo(xPx, yPx);
    this.graphics.lineTo(ax, ay);
    this.graphics.strokePath();
  }

  /** Highlight this worm as the active one. */
  setActive(active: boolean): void {
    if (active) {
      this.graphics.setAlpha(1.0);
    } else {
      this.graphics.setAlpha(this.isAlive ? 0.75 : 0.3);
    }
  }

  /** Return foot sensor fixture for contact listener checks. */
  getFootSensor(): Fixture {
    return this.footSensor;
  }
}
