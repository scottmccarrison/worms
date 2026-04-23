/**
 * Server-side Projectile. Mirrors the client's ProjectileManager
 * state but stripped to one projectile-per-object so the Simulation
 * can manage the array.
 *
 * Types:
 *   - contact-detonate (Bazooka): fuseMs === null; detonates via the
 *     begin-contact listener wired in Simulation.
 *   - fuse (Grenade): fuseMs > 0; tick() decrements and
 *     shouldDetonate() flips when fuse hits 0.
 *
 * The Simulation owns the begin-contact listener + queues detonations
 * on pending[] so destroyBody runs outside planck's callback stack.
 */

import { Circle } from "planck";
import type { Body, World } from "planck";
import { toMeters, toPixels } from "../physics/scale.js";
import type { WeaponConfig } from "../weapons/types.js";
import type { Terrain } from "./terrain.js";

export interface ProjectileInit {
  id: string;
  ownerId: string;
  world: World;
  config: WeaponConfig;
  originPx: { x: number; y: number };
  velocityMps: { x: number; y: number };
  fuseMs: number | null;
}

export interface ProjectileUserData {
  kind: "projectile";
  projectile: Projectile;
}

export interface ProjectileRenderState {
  id: string;
  ownerId: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuseRemainingMs: number | null;
}

export class Projectile {
  readonly id: string;
  readonly ownerId: string;
  readonly body: Body;
  readonly config: WeaponConfig;
  fuseRemainingMs: number | null;
  detonated = false;
  /** Accumulator for tunnel carving cadence. Only used when config.tunnel is set. */
  msSinceLastCut = 0;

  constructor(init: ProjectileInit) {
    this.id = init.id;
    this.ownerId = init.ownerId;
    this.config = init.config;
    this.fuseRemainingMs = init.fuseMs;

    const radiusM = toMeters(init.config.projectileRadiusPx ?? 5);

    this.body = init.world.createBody({
      type: "dynamic",
      position: {
        x: toMeters(init.originPx.x),
        y: toMeters(init.originPx.y),
      },
      linearVelocity: { x: init.velocityMps.x, y: init.velocityMps.y },
      bullet: true,
    });

    this.body.createFixture({
      shape: new Circle(radiusM),
      density: 0.5,
      friction: 0.3,
      restitution: init.config.restitution ?? 0.1,
    });

    const userData: ProjectileUserData = { kind: "projectile", projectile: this };
    this.body.setUserData(userData);
  }

  /** Decrement fuse. Returns true if the projectile detonates this tick. */
  tick(dtMs: number): void {
    if (this.detonated) return;
    if (this.fuseRemainingMs === null) return;
    this.fuseRemainingMs = Math.max(0, this.fuseRemainingMs - dtMs);
  }

  shouldDetonate(): boolean {
    if (this.detonated) return false;
    return this.fuseRemainingMs === 0;
  }

  /**
   * Tick tunnel carving. Accumulates dtMs and cuts terrain at the configured
   * cadence. No-op if the weapon has no tunnel config.
   */
  tickTunnel(dtMs: number, terrain: Terrain): void {
    if (this.detonated) return;
    const tunnel = this.config.tunnel;
    if (!tunnel) return;
    this.msSinceLastCut += dtMs;
    if (this.msSinceLastCut >= tunnel.cutIntervalMs) {
      const pos = this.body.getPosition();
      terrain.cutCircle(toPixels(pos.x), toPixels(pos.y), tunnel.cutRadiusPx);
      this.msSinceLastCut = 0;
    }
  }

  /** Mark for destruction. The Simulation removes the body. */
  markDetonated(): void {
    this.detonated = true;
  }

  toRenderState(): ProjectileRenderState {
    const pos = this.body.getPosition();
    const vel = this.body.getLinearVelocity();
    return {
      id: this.id,
      ownerId: this.ownerId,
      type: this.config.id,
      x: toPixels(pos.x),
      y: toPixels(pos.y),
      vx: toPixels(vel.x),
      vy: toPixels(vel.y),
      fuseRemainingMs: this.fuseRemainingMs,
    };
  }
}
