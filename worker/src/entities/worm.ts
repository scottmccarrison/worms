/**
 * Server-side Worm entity. No Phaser, no rendering. Only the
 * authoritative physics body + gameplay state.
 *
 * Ported from src/worm/Worm.ts; trimmed to what the sim needs:
 *   - body (planck Body, fixedRotation dynamic circle)
 *   - foot sensor fixture (circle's bottom) for canJump()
 *   - health + alive flag
 *   - aim angle / power / facing (driven by input_aim_* messages)
 *   - active weapon + ammo (per-worm, set when firing)
 *
 * The client's Worm has a pendingDamage accumulator + an
 * applyPendingDamage step that drives the red-flash tween. On the
 * server we apply damage immediately to `health` when takeDamage is
 * called; the DamageEvent is emitted by the caller for client VFX.
 */

import { Box, Circle } from "planck";
import type { Body, Fixture, World } from "planck";
import { toMeters, toPixels } from "../physics/scale.js";

export const DEFAULT_MAX_HP = 100;
export const DEFAULT_WORM_RADIUS_PX = 12;
export const DEFAULT_WORM_DENSITY = 1.0;
export const DEFAULT_WORM_LINEAR_DAMPING = 0.1;
export const DEFAULT_WALK_SPEED_MPS = 2.5;

export interface WormInit {
  id: string;
  teamId: string;
  world: World;
  spawnXPx: number;
  spawnYPx: number;
  radiusPx?: number;
  density?: number;
  linearDamping?: number;
  maxHp?: number;
}

export interface WormUserData {
  kind: "worm";
  worm: Worm;
}

export interface WormFootUserData {
  kind: "worm-foot";
  worm: Worm;
}

/** Render-state subset broadcast to clients in SimState. */
export interface WormRenderState {
  id: string;
  teamId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  aimAngle: number;
  aimPower: number;
  hp: number;
  alive: boolean;
  activeWeapon: string;
  ammoLeft: number;
  jetPackActive: boolean;
  jetPackFuel: number; // 0-100
}

export class Worm {
  readonly id: string;
  readonly teamId: string;
  readonly body: Body;
  readonly maxHp: number;
  readonly radiusPx: number;

  health: number;
  alive = true;
  facing: -1 | 1 = 1;
  /** radians, [-PI/2, PI/2], 0 = horizontal. Stored relative to facing. */
  aimAngle = -Math.PI / 4;
  aimPower = 0.5;
  activeWeapon = "bazooka";
  ammoLeft = -1;

  private footContactCount = 0;
  private readonly footSensor: Fixture;
  private readonly walkSpeedMps: number;
  private walkingDir: -1 | 0 | 1 = 0;
  private jetPackActive = false;
  private jetPackFuel = 100;
  private jetPackThrustV = false;
  private jetPackThrustH: -1 | 0 | 1 = 0;

  constructor(init: WormInit) {
    this.id = init.id;
    this.teamId = init.teamId;
    this.radiusPx = init.radiusPx ?? DEFAULT_WORM_RADIUS_PX;
    const density = init.density ?? DEFAULT_WORM_DENSITY;
    const linearDamping = init.linearDamping ?? DEFAULT_WORM_LINEAR_DAMPING;
    this.maxHp = init.maxHp ?? DEFAULT_MAX_HP;
    this.health = this.maxHp;
    this.walkSpeedMps = DEFAULT_WALK_SPEED_MPS;

    const radiusM = toMeters(this.radiusPx);

    this.body = init.world.createBody({
      type: "dynamic",
      position: { x: toMeters(init.spawnXPx), y: toMeters(init.spawnYPx) },
      fixedRotation: true,
      linearDamping,
    });

    // Main circle body.
    this.body.createFixture({
      shape: new Circle(radiusM),
      density,
      friction: 1.0,
      restitution: 0.1,
    });

    // Foot sensor: small box at bottom of circle, isSensor so it
    // doesn't affect physics but the contact listener tracks it.
    const sensorHalfW = toMeters(this.radiusPx * 0.6);
    const sensorHalfH = toMeters(this.radiusPx * 0.3);
    this.footSensor = this.body.createFixture({
      shape: new Box(sensorHalfW, sensorHalfH, { x: 0, y: radiusM }, 0),
      isSensor: true,
      density: 0,
      friction: 0,
    });

    const userData: WormUserData = { kind: "worm", worm: this };
    this.body.setUserData(userData);
    const footUserData: WormFootUserData = { kind: "worm-foot", worm: this };
    this.footSensor.setUserData(footUserData);
  }

  // ---- Movement ----

  walk(direction: -1 | 0 | 1): void {
    if (!this.alive) return;
    this.walkingDir = direction;
    const vel = this.body.getLinearVelocity();
    this.body.setLinearVelocity({ x: direction * this.walkSpeedMps, y: vel.y });
    if (direction !== 0) this.facing = direction;
  }

  /**
   * Sustain the current walk for one sim tick. Called from Simulation.tick
   * on the active worm only; clients send input_walk edge-triggered (one
   * message on press, one on release), and without this re-applying the
   * velocity every tick, ground friction damps the worm to a halt in a
   * few frames.
   */
  applyWalking(): void {
    if (!this.alive || this.walkingDir === 0) return;
    const vel = this.body.getLinearVelocity();
    this.body.setLinearVelocity({ x: this.walkingDir * this.walkSpeedMps, y: vel.y });
  }

  jump(): void {
    if (!this.alive) return;
    if (!this.canJump()) return;
    const d = DEFAULT_WORM_DENSITY; // mass scale
    this.body.applyLinearImpulse(
      { x: this.facing * 1.5 * d, y: -2 * 1.5 * d },
      this.body.getPosition(),
    );
  }

  backflip(): void {
    if (!this.alive) return;
    if (!this.canJump()) return;
    const d = DEFAULT_WORM_DENSITY;
    this.body.applyLinearImpulse(
      { x: -this.facing * 2.3 * d, y: -2 * 2.3 * d },
      this.body.getPosition(),
    );
  }

  setAimAngle(rad: number): void {
    if (!Number.isFinite(rad)) return;
    this.aimAngle = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, rad));
  }

  setAimPower(p: number): void {
    if (!Number.isFinite(p)) return;
    this.aimPower = Math.max(0, Math.min(1, p));
  }

  setFacing(dir: -1 | 1): void {
    this.facing = dir;
  }

  // ---- JetPack ----

  toggleJetPack(): void {
    if (!this.alive) return;
    if (this.jetPackActive) {
      this.jetPackActive = false;
      this.jetPackThrustV = false;
      this.jetPackThrustH = 0;
    } else {
      if (this.jetPackFuel <= 0) return;
      this.jetPackActive = true;
    }
  }

  setJetPackThrust(active: boolean): void {
    this.jetPackThrustV = active;
  }

  setJetPackHorizontal(dir: -1 | 0 | 1): void {
    this.jetPackThrustH = dir;
  }

  /**
   * Apply jetpack force for one sim tick. Called from Simulation.tick
   * on the active worm before world.step(). Drains fuel and auto-deactivates
   * when empty.
   */
  applyJetPackForce(dtMs: number): void {
    if (!this.alive || !this.jetPackActive) return;
    if (this.jetPackFuel <= 0) {
      this.jetPackActive = false;
      this.jetPackThrustV = false;
      this.jetPackThrustH = 0;
      return;
    }

    const UP_FORCE = 18; // Newtons (planck units)
    const SIDE_FORCE = 10;
    const FUEL_PER_SECOND = 30; // percent per second

    const fx = this.jetPackThrustH * SIDE_FORCE;
    const fy = this.jetPackThrustV ? -UP_FORCE : 0;

    if (fx !== 0 || fy !== 0) {
      this.body.applyForce({ x: fx, y: fy }, this.body.getPosition(), true);
      this.jetPackFuel -= FUEL_PER_SECOND * (dtMs / 1000);
    }

    if (this.jetPackFuel <= 0) {
      this.jetPackFuel = 0;
      this.jetPackActive = false;
      this.jetPackThrustV = false;
      this.jetPackThrustH = 0;
    }
  }

  /** Reset all utility state. Called when a new turn starts for a worm. */
  resetUtilitiesForTurnStart(): void {
    this.jetPackActive = false;
    this.jetPackFuel = 100;
    this.jetPackThrustV = false;
    this.jetPackThrustH = 0;
  }

  // ---- Health ----

  takeDamage(amount: number): number {
    if (!this.alive) return 0;
    const dmg = Math.max(0, Math.floor(amount));
    if (dmg <= 0) return 0;
    const prev = this.health;
    this.health = Math.max(0, this.health - dmg);
    if (this.health <= 0) {
      this.alive = false;
    }
    return prev - this.health;
  }

  /** Force-kill (used for off-map culling + forfeit). */
  kill(): void {
    this.health = 0;
    this.alive = false;
    this.walkingDir = 0;
    this.jetPackActive = false;
    this.jetPackThrustV = false;
    this.jetPackThrustH = 0;
  }

  // ---- Foot contact ----

  getFootSensor(): Fixture {
    return this.footSensor;
  }

  onFootContactBegin(): void {
    this.footContactCount++;
  }

  onFootContactEnd(): void {
    this.footContactCount = Math.max(0, this.footContactCount - 1);
  }

  canJump(): boolean {
    const vel = this.body.getLinearVelocity();
    return this.footContactCount > 0 && Math.abs(vel.y) < 0.5;
  }

  // ---- Serialisation ----

  toRenderState(): WormRenderState {
    // Render state is in PIXELS. Client multiplies nothing; it renders
    // directly. Keeping physics in meters inside the world + converting
    // at the serialisation boundary is simpler than threading units
    // through every call site on both sides of the wire.
    const pos = this.body.getPosition();
    const vel = this.body.getLinearVelocity();
    return {
      id: this.id,
      teamId: this.teamId,
      x: toPixels(pos.x),
      y: toPixels(pos.y),
      vx: toPixels(vel.x),
      vy: toPixels(vel.y),
      facing: this.facing,
      aimAngle: this.aimAngle,
      aimPower: this.aimPower,
      hp: this.health,
      alive: this.alive,
      activeWeapon: this.activeWeapon,
      ammoLeft: this.ammoLeft,
      jetPackActive: this.jetPackActive,
      jetPackFuel: Math.round(this.jetPackFuel),
    };
  }
}
