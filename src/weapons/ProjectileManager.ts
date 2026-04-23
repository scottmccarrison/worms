/**
 * Offline-only client sim. Epic 45 moved authoritative projectile physics
 * (spawn, step, contact, fuse) to the server. Projectile sprites in
 * networked mode come from sim_state.projectiles; NetworkedSimAdapter
 * doesn't touch this file. Only OfflineSimAdapter imports it.
 */
import * as Phaser from "phaser";
import { Circle, Vec2 } from "planck";
import type { Body, World } from "planck";
import { toMeters, toPixels } from "../physics/scale";
import type { Terrain } from "../terrain/Terrain";
import type { Worm } from "../worm/Worm";
import { explode } from "./explode";
import type { WeaponConfig } from "./types";

interface ActiveProjectile {
  id: string;
  body: Body;
  graphic: Phaser.GameObjects.Graphics;
  spawnedAt: number; // ms since scene start
  fuseMs: number | null; // null = contact-only detonation
  weapon: WeaponConfig;
  firer: Worm;
  detonated: boolean; // guard against double-detonate
}

interface ProjectileManagerInit {
  scene: Phaser.Scene;
  world: World;
  terrain: Terrain;
  onDetonate: (firer: Worm, selfDamage: number) => void;
}

export class ProjectileManager {
  private readonly scene: Phaser.Scene;
  private readonly world: World;
  private readonly terrain: Terrain;
  private readonly onDetonate: (firer: Worm, selfDamage: number) => void;
  private readonly projectiles: ActiveProjectile[] = [];
  private readonly pendingDetonate: ActiveProjectile[] = [];
  private elapsedMs = 0;
  private nextProjectileId = 0;

  constructor(init: ProjectileManagerInit) {
    this.scene = init.scene;
    this.world = init.world;
    this.terrain = init.terrain;
    this.onDetonate = init.onDetonate;

    // Register a contact listener for projectile-terrain/worm contacts
    this.world.on("begin-contact", this.onBeginContact);

    // Clean up on scene shutdown
    this.scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.world.off("begin-contact", this.onBeginContact);
    });
  }

  /**
   * Spawn a projectile in the world. The body is a dynamic circle.
   * fuseMs = null means detonate on contact only (Bazooka).
   * fuseMs = number means detonate after fuse expires (Grenade).
   */
  spawn(args: {
    weapon: WeaponConfig;
    firer: Worm;
    originPx: { x: number; y: number };
    velocityMps: { x: number; y: number };
    fuseMs: number | null;
  }): void {
    const { weapon, firer, originPx, velocityMps, fuseMs } = args;
    const radiusM = toMeters(weapon.projectileRadiusPx ?? 5);

    const body = this.world.createBody({
      type: "dynamic",
      position: { x: toMeters(originPx.x), y: toMeters(originPx.y) },
      linearVelocity: Vec2(velocityMps.x, velocityMps.y),
      bullet: true, // CCD - prevents tunnelling through thin terrain
    });

    body.createFixture({
      shape: new Circle(radiusM),
      density: 0.5,
      friction: 0.3,
      restitution: weapon.restitution ?? 0.1,
    });

    // Tag the body so contact listener can identify projectiles
    body.setUserData({ kind: "projectile", projectileRef: null as ActiveProjectile | null });

    const graphic = this.scene.add.graphics();
    graphic.setDepth(8);
    graphic.fillStyle(weapon.projectileColor ?? 0xffffff, 1);
    const rPx = weapon.projectileRadiusPx ?? 5;
    graphic.fillCircle(0, 0, rPx);

    const proj: ActiveProjectile = {
      id: `offline-proj-${this.nextProjectileId++}`,
      body,
      graphic,
      spawnedAt: this.elapsedMs,
      fuseMs,
      weapon,
      firer,
      detonated: false,
    };

    // Link body userData back to the ActiveProjectile for contact lookup
    body.setUserData({ kind: "projectile", projectileRef: proj });

    this.projectiles.push(proj);
  }

  /**
   * Called each frame from GameScene.update AFTER physicsSystem.step() and
   * AFTER terrain.flushPendingCuts(). Safe to destroyBody here.
   */
  update(deltaMs: number): void {
    this.elapsedMs += deltaMs;

    // Flush contact-triggered detonations queued in onBeginContact
    for (const proj of this.pendingDetonate) {
      if (!proj.detonated) {
        this.detonateProjectile(proj);
      }
    }
    this.pendingDetonate.length = 0;

    // Tick fuses
    for (const proj of this.projectiles) {
      if (proj.detonated) continue;
      if (proj.fuseMs !== null && this.elapsedMs - proj.spawnedAt >= proj.fuseMs) {
        this.detonateProjectile(proj);
        continue;
      }

      // Sync graphic position to physics body
      const pos = proj.body.getPosition();
      proj.graphic.setPosition(toPixels(pos.x), toPixels(pos.y));
    }

    // Remove detonated projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (this.projectiles[i]?.detonated) {
        this.projectiles.splice(i, 1);
      }
    }
  }

  /** Number of live projectiles (useful for settle detection). */
  get count(): number {
    return this.projectiles.length;
  }

  /**
   * Returns a snapshot of live projectiles with their Phaser Graphics objects.
   * Used by CameraFollower to follow an in-flight projectile in offline mode.
   * Each entry: { id, gfx } where id is stable for the lifetime of the projectile.
   */
  getProjectilesWithGfx(): ReadonlyArray<{ id: string; gfx: Phaser.GameObjects.Graphics }> {
    return this.projectiles.filter((p) => !p.detonated).map((p) => ({ id: p.id, gfx: p.graphic }));
  }

  destroy(): void {
    this.world.off("begin-contact", this.onBeginContact);
    for (const proj of this.projectiles) {
      this.destroyProjectile(proj);
    }
    this.projectiles.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private detonateProjectile(proj: ActiveProjectile): void {
    if (proj.detonated) return;
    proj.detonated = true;

    const pos = proj.body.getPosition();
    const centerPx = { x: toPixels(pos.x), y: toPixels(pos.y) };

    const result = explode({
      world: this.world,
      terrain: this.terrain,
      centerPx,
      config: proj.weapon.explosion,
      firedBy: proj.firer,
    });

    this.onDetonate(proj.firer, result.selfDamageTaken);
    this.destroyProjectile(proj);
  }

  private destroyProjectile(proj: ActiveProjectile): void {
    if (proj.body.isActive()) {
      this.world.destroyBody(proj.body);
    }
    if (proj.graphic.active) {
      proj.graphic.destroy();
    }
  }

  private onBeginContact = (contact: import("planck").Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();

    for (const fixture of [a, b]) {
      const ud = fixture.getBody().getUserData() as {
        kind: string;
        projectileRef: ActiveProjectile | null;
      } | null;

      if (ud?.kind === "projectile" && ud.projectileRef && !ud.projectileRef.detonated) {
        // Contact-detonate (Bazooka) - fuse projectiles detonate on fuse only
        if (ud.projectileRef.fuseMs === null) {
          this.pendingDetonate.push(ud.projectileRef);
        }
      }
    }
  };
}
