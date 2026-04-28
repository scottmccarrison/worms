/**
 * Simulation - authoritative server-side game world.
 *
 * Owns:
 *   - planck.World (via createPhysicsWorld)
 *   - Terrain (mask + bodies + cut log)
 *   - worms Map<wormId, Worm>
 *   - projectiles array
 *   - monotonic tick counter
 *
 * Ticks by `tick(dtMs)` called from the Room DO's alarm handler.
 * Each tick:
 *   1. Steps world.
 *   2. Processes projectile fuses + pending contact detonations.
 *   3. Applies an off-map kill floor for worms (absorbs #53).
 *   4. Consumes the terrain cut log.
 *   5. Returns SimTickResult { stateChanged, events[] }.
 *
 * Inputs are driven by applyWalkInput / applyJumpInput / applyAim*
 * /applyFire methods; the Room queues inputs from WebSocket messages
 * and drains them right before calling tick().
 */

import type { Contact, ContactImpulse } from "planck";
import { type LogContext, dlog } from "../debug/logger.js";
import {
  Projectile,
  type ProjectileRenderState,
  type ProjectileUserData,
} from "../entities/projectile.js";
import { Terrain } from "../entities/terrain.js";
import {
  Worm,
  type WormFootUserData,
  type WormRenderState,
  type WormUserData,
} from "../entities/worm.js";
import { ObjectInstance, type ObjectUserData } from "../entities/objectInstance.js";
import { toMeters, toPixels } from "../physics/scale.js";
import { createPhysicsWorld } from "../physics/world.js";
import type { PlanckWorld } from "../physics/world.js";
import { type ExplodeResult, explode } from "../weapons/explode.js";
import { fire } from "../weapons/fire.js";
import type { FireResult as WeaponFireResult } from "../weapons/fire.js";
import { defaultAmmoForMatch, getById } from "../weapons/registry.js";
import type { ObjectRenderState } from "../../../shared/protocol.js";

const OFF_MAP_MARGIN_PX = 200;
const MAX_PROJECTILES = 8;

export interface SimEventTerrainCut {
  type: "terrain_cut";
  x: number;
  y: number;
  r: number;
  seq: number;
}

export interface SimEventFire {
  type: "fire_event";
  wormId: string;
  weaponId: string;
  angleRad: number;
  power: number;
  facing: -1 | 1;
}

export interface SimEventDamage {
  type: "damage_event";
  wormId: string;
  amount: number;
  fromProjectileId: string | null;
  impact: { x: number; y: number };
}

export interface SimEventWormDied {
  type: "worm_died";
  wormId: string;
}

export interface SimEventObjectSpawn {
  type: "object_spawn";
  id: string;
  kind: string;
  x: number;
  y: number;
}

export interface SimEventObjectDestroy {
  type: "object_destroy";
  id: string;
  cause: "explode" | "open" | "remove";
}

export type SimEvent =
  | SimEventTerrainCut
  | SimEventFire
  | SimEventDamage
  | SimEventWormDied
  | SimEventObjectSpawn
  | SimEventObjectDestroy;

export interface SimTickResult {
  tick: number;
  stateChanged: boolean;
  events: SimEvent[];
}

export interface SimState {
  tick: number;
  worms: WormRenderState[];
  projectiles: ProjectileRenderState[];
  objects: ObjectRenderState[];
  wind: number;
  waterLevelPx: number;
}

export interface SimTeamInit {
  id: string;
  wormIds: string[];
  /** Pixel spawn for each worm in the same order as wormIds. */
  spawns: Array<{ xPx: number; yPx: number }>;
}

export interface SimulationInit {
  gravity?: { x: number; y: number };
  widthPx: number;
  heightPx: number;
  mask: Uint8Array;
  teams: SimTeamInit[];
  seed: number;
  logCtx?: () => LogContext;
  initialObjects?: Array<{ kind: string; xPx: number; yPx: number }>;
}

/** Snapshot for DO storage / hibernation recovery. */
export interface SerializedSim {
  tick: number;
  /** Per-team ammo pools. Keyed by teamId -> weaponId -> remaining. */
  teamAmmo?: Record<string, Record<string, number>>;
  worms: Array<{
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
    jetPackActive?: boolean;
    jetPackFuel?: number;
    jetPackThrustV?: boolean;
    jetPackThrustH?: -1 | 0 | 1;
  }>;
  projectiles: Array<{
    id: string;
    ownerId: string;
    weaponId: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    fuseRemainingMs: number | null;
  }>;
  objects: Array<{
    id: string;
    kind: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    flags: number;
  }>;
  terrainCutSeq: number;
  wind: number;
  waterLevelPx: number;
}

/**
 * Structured result from applyFire. On success, `ok: true` and the underlying
 * WeaponFireResult is included for the arbiter (shotsRemaining / turnEndsImmediately).
 * On failure, `ok: false` with a reason the caller can forward to the client.
 */
export type SimFireResult =
  | { ok: true; weaponResult: WeaponFireResult }
  | {
      ok: false;
      reason: "no_ammo" | "no_active_worm" | "max_projectiles" | "weapon_not_found";
    };

export class Simulation {
  readonly world: PlanckWorld;
  readonly terrain: Terrain;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly seed: number;
  private readonly worms: Map<string, Worm> = new Map();
  private readonly projectiles: Projectile[] = [];
  private readonly pendingDetonate: Projectile[] = [];
  private projectileIdCounter = 0;
  private tickCount = 0;
  private readonly objects: Map<string, ObjectInstance> = new Map();
  private objectIdCounter = 0;
  private pendingObjectHits: Array<{ obj: ObjectInstance; projectile: Projectile }> = [];
  /** Tick-scoped events appended during world step / apply passes. */
  private events: SimEvent[] = [];
  /** Worms already marked dead this tick; dedupes worm_died events. */
  private readonly diedThisTick = new Set<string>();
  /** Wind strength -1..1. Applied as horizontal force on in-flight projectiles each tick. */
  private wind = 0;
  /** Water level in pixels. Number.MAX_SAFE_INTEGER = no water (sentinel). */
  private waterLevelPx = Number.MAX_SAFE_INTEGER;
  private onPostSolve: ((contact: Contact, impulse: ContactImpulse) => void) | null = null;
  /**
   * Per-team ammo pool. Maps teamId -> weaponId -> remaining count.
   * -1 means infinite. Finite weapons (e.g. holygrenade=2) are tracked here.
   */
  private readonly teamAmmo: Map<string, Record<string, number>> = new Map();
  private readonly getLogCtx: () => LogContext;

  constructor(init: SimulationInit) {
    this.widthPx = init.widthPx;
    this.heightPx = init.heightPx;
    this.seed = init.seed;
    this.getLogCtx = init.logCtx ?? (() => ({}));
    this.world = createPhysicsWorld(init.gravity ?? { x: 0, y: 10 });
    this.terrain = new Terrain({
      world: this.world,
      widthPx: init.widthPx,
      heightPx: init.heightPx,
      mask: init.mask,
    });

    const ammoTemplate = defaultAmmoForMatch();
    for (const team of init.teams) {
      this.teamAmmo.set(team.id, { ...ammoTemplate });
      for (let i = 0; i < team.wormIds.length; i++) {
        const wormId = team.wormIds[i];
        const spawn = team.spawns[i] ?? { xPx: 100, yPx: 100 };
        const worm = new Worm({
          id: wormId,
          teamId: team.id,
          world: this.world,
          spawnXPx: spawn.xPx,
          spawnYPx: spawn.yPx,
        });
        this.worms.set(wormId, worm);
      }
    }

    for (const seed of init.initialObjects ?? []) {
      this.spawnObject(seed.kind, seed.xPx, seed.yPx);
    }

    this.world.on("begin-contact", this.onBeginContact);
    this.onPostSolve = this.handlePostSolve.bind(this);
    this.world.on("post-solve", this.onPostSolve);
  }

  /** Destroy listeners + free planck resources. */
  destroy(): void {
    try {
      this.world.off("begin-contact", this.onBeginContact);
    } catch {
      // planck contract: off() may no-op after world is GC'd
    }
    if (this.onPostSolve) {
      try {
        this.world.off("post-solve", this.onPostSolve);
      } catch {
        // planck contract: off() may no-op after world is GC'd
      }
      this.onPostSolve = null;
    }
  }

  // ---- Wind + water controls ----

  setWind(w: number): void {
    this.wind = Math.max(-1, Math.min(1, w));
  }

  setWaterLevel(yPx: number): void {
    this.waterLevelPx = Math.max(0, yPx);
  }

  // ---- Ammo controls ----

  /** Return remaining ammo for a team + weapon. -1 means infinite. */
  getTeamAmmo(teamId: string, weaponId: string): number {
    const pool = this.teamAmmo.get(teamId);
    return pool?.[weaponId] ?? -1;
  }

  /** Re-initialize all team ammo pools from defaultAmmoForMatch (call on match restart). */
  resetTeamAmmo(): void {
    const template = defaultAmmoForMatch();
    for (const teamId of this.teamAmmo.keys()) {
      this.teamAmmo.set(teamId, { ...template });
    }
  }

  // ---- Input application (called after validating active player) ----

  applyWalkInput(wormId: string, dir: -1 | 0 | 1): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.walk(dir);
  }

  applyJumpInput(wormId: string): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.jump();
  }

  applyBackflipInput(wormId: string): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.backflip();
  }

  applyAimAngle(wormId: string, rad: number): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.setAimAngle(rad);
  }

  applyAimPower(wormId: string, p: number): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.setAimPower(p);
  }

  applyFacing(wormId: string, facing: -1 | 1): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    worm.setFacing(facing);
  }

  applyJetPackToggle(wormId: string): void {
    this.worms.get(wormId)?.toggleJetPack();
  }

  applyJetPackThrust(wormId: string, active: boolean): void {
    this.worms.get(wormId)?.setJetPackThrust(active);
  }

  applyJetPackHorizontal(wormId: string, dir: -1 | 0 | 1): void {
    this.worms.get(wormId)?.setJetPackHorizontal(dir);
  }

  applyJetPackVector(wormId: string, vx: number, vy: number): void {
    this.worms.get(wormId)?.setJetPackThrustVector(vx, vy);
  }

  /** Reset utility state when a new turn starts for the given worm. */
  resetUtilitiesForTurnStart(wormId: string): void {
    this.worms.get(wormId)?.resetUtilitiesForTurnStart();
  }

  applySelectWeapon(wormId: string, weaponId: string): void {
    const worm = this.worms.get(wormId);
    if (!worm) return;
    const weapon = getById(weaponId);
    if (!weapon) return;
    worm.activeWeapon = weapon.id;
  }

  /**
   * Fire the worm's active weapon. Returns a SimFireResult so the caller can
   * inspect shotsRemaining / turnEndsImmediately (on success) or forward a
   * rejection reason to the originating client (on failure). Also emits a
   * fire_event SimEvent on success, and any explode events for hitscan hits.
   */
  applyFire(wormId: string, weaponId?: string): SimFireResult {
    const worm = this.worms.get(wormId);
    if (!worm || !worm.alive) return { ok: false, reason: "no_active_worm" };
    if (this.projectiles.length >= MAX_PROJECTILES) return { ok: false, reason: "max_projectiles" };
    const weapon = weaponId ? getById(weaponId) : getById(worm.activeWeapon);
    if (!weapon) return { ok: false, reason: "weapon_not_found" };

    // Enforce per-team ammo. Reject if the team has run out.
    const teamPool = this.teamAmmo.get(worm.teamId);
    const remaining = teamPool?.[weapon.id] ?? -1;
    if (remaining !== -1 && remaining <= 0) return { ok: false, reason: "no_ammo" };

    const result = fire({
      world: this.world,
      terrain: this.terrain,
      worms: this.worms.values(),
      firer: worm,
      weapon,
      aimRadians: worm.aimAngle,
      aimPower01: worm.aimPower,
      shotsFiredBefore: 0,
    });

    worm.activeWeapon = weapon.id;

    // Consume one unit of ammo from the team pool if finite.
    if (teamPool && remaining !== -1) {
      teamPool[weapon.id] = remaining - 1;
    }

    this.events.push({
      type: "fire_event",
      wormId: worm.id,
      weaponId: weapon.id,
      angleRad: worm.aimAngle,
      power: worm.aimPower,
      facing: worm.facing,
    });
    dlog("sim", "fire", this.getLogCtx(), { weaponId: weapon.id, wormId: worm.id });

    for (const ex of result.explodeResults) {
      this.emitExplodeEvents(ex, null);
    }

    if (result.spawn) {
      const id = this.nextProjectileId();
      const proj = new Projectile({
        id,
        ownerId: result.spawn.ownerId,
        world: this.world,
        config: result.spawn.weapon,
        originPx: result.spawn.originPx,
        velocityMps: result.spawn.velocityMps,
        fuseMs: result.spawn.fuseMs,
      });
      this.projectiles.push(proj);
    }

    return { ok: true, weaponResult: result };
  }

  // ---- Main tick ----

  tick(dtMs: number, activeWormId: string | null = null): SimTickResult {
    // Keep any events that applyFire / other pre-tick inputs pushed;
    // they are logically part of this tick. Reset diedThisTick so
    // the dedup guard only spans the current tick.
    this.diedThisTick.clear();
    const beforeWormPositions = this.snapshotWormPositions();

    // 0. Sustain the active worm's walking velocity. Clients send
    //    input_walk edge-triggered, so without this step ground friction
    //    would damp the worm to a halt between inputs. Non-active worms
    //    with stale walkingDir are skipped, which also means turn
    //    advance implicitly stops the previous walker.
    if (activeWormId) {
      this.worms.get(activeWormId)?.applyWalking();
      this.worms.get(activeWormId)?.applyJetPackForce(dtMs);
    }

    // 1. Step world. planck does fixed-step internally via the passed
    //    timestep; 50ms is a single step at 20Hz.
    this.world.step(dtMs / 1000, 8, 3);

    // 1a. Fall damage: post-solve listeners have accumulated per-contact
    //     impulses during world.step. Apply them now, before detonation
    //     processing so we don't double-emit worm_died.
    for (const worm of this.worms.values()) {
      if (!worm.alive) continue;
      const dmg = worm.applyPendingFallDamage();
      if (dmg > 0) {
        const pos = worm.body.getPosition();
        this.events.push({
          type: "damage_event",
          wormId: worm.id,
          amount: dmg,
          fromProjectileId: null,
          impact: { x: toPixels(pos.x), y: toPixels(pos.y) },
        });
        if (!worm.alive && !this.diedThisTick.has(worm.id)) {
          this.diedThisTick.add(worm.id);
          this.events.push({ type: "worm_died", wormId: worm.id });
          dlog("sim", "worm_died", this.getLogCtx(), { wormId: worm.id, cause: "fall" });
        }
      }
    }

    // 2. Process pending contact detonations.
    for (const proj of this.pendingDetonate) {
      if (!proj.detonated) this.detonateProjectile(proj, "contact");
    }
    this.pendingDetonate.length = 0;

    // 3. Tick projectile fuses + detonate expired ones.
    for (const proj of this.projectiles) {
      if (proj.detonated) continue;
      proj.tick(dtMs);
      proj.tickTunnel(dtMs, this.terrain);
      // Wind: apply horizontal force per tick to in-flight projectiles.
      // WIND_FORCE is Newtons per unit wind; tunable in src/tuning.ts.
      if (this.wind !== 0) {
        // Mirror of src/tuning.ts wind.forceNewtonsPerUnit - keep in sync.
        // 0.8 N/unit gives ~9 m/s^2 lateral accel at wind=0.8 on a 0.07kg projectile,
        // approximately gravity strength - meaningful but not trajectory-breaking.
        const WIND_FORCE = 0.8;
        proj.body.applyForce(
          { x: this.wind * WIND_FORCE, y: 0 },
          proj.body.getWorldCenter(),
          true, // wake
        );
      }
      if (proj.shouldDetonate()) {
        this.detonateProjectile(proj, "fuse");
      }
    }

    // 4. Remove detonated projectiles.
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const proj = this.projectiles[i];
      if (!proj || !proj.detonated) continue;
      try {
        if (proj.body.isActive()) this.world.destroyBody(proj.body);
      } catch {
        // ignore; body may already be gone
      }
      this.projectiles.splice(i, 1);
    }

    // 4a. Apply pending projectile-vs-object hits collected during begin-contact.
    for (const hit of this.pendingObjectHits) {
      hit.obj.takeDamage(1);
      hit.projectile.markDetonated();
    }
    this.pendingObjectHits = [];

    // 4b. Reap dead objects (applies explosion effects, emits object_destroy events).
    this.reapDeadObjects();

    // 5. Off-map kill: any worm pushed outside the map (in any direction,
    //    plus a margin) is marked dead. Absorbs issue #53.
    //    Top boundary intentionally excluded: gravity returns airborne worms;
    //    turn timer caps duration. Fix for issue #141.
    const killMinX = -OFF_MAP_MARGIN_PX / 30; // meters
    const killMaxX = (this.widthPx + OFF_MAP_MARGIN_PX) / 30;
    const killMaxY = (this.heightPx + OFF_MAP_MARGIN_PX) / 30;
    for (const worm of this.worms.values()) {
      if (!worm.alive) continue;
      const pos = worm.body.getPosition();
      if (pos.x < killMinX || pos.x > killMaxX || pos.y > killMaxY) {
        worm.kill();
        if (!this.diedThisTick.has(worm.id)) {
          this.diedThisTick.add(worm.id);
          this.events.push({ type: "worm_died", wormId: worm.id });
          dlog("sim", "worm_died", this.getLogCtx(), { wormId: worm.id, cause: "off_map" });
        }
      }
    }

    // 6. Water drown: rising water level kills worms below the surface.
    //    Shares diedThisTick with the off-map floor so a worm at the
    //    corner doesn't double-emit worm_died.
    if (this.waterLevelPx !== Number.MAX_SAFE_INTEGER) {
      const waterY = toMeters(this.waterLevelPx);
      for (const worm of this.worms.values()) {
        if (!worm.alive) continue;
        const pos = worm.body.getPosition();
        if (pos.y > waterY) {
          worm.kill();
          if (!this.diedThisTick.has(worm.id)) {
            this.diedThisTick.add(worm.id);
            this.events.push({ type: "worm_died", wormId: worm.id });
            dlog("sim", "worm_died", this.getLogCtx(), { wormId: worm.id, cause: "drown" });
            this.events.push({
              type: "damage_event",
              wormId: worm.id,
              amount: 999,
              fromProjectileId: null,
              impact: { x: toPixels(pos.x), y: toPixels(pos.y) },
            });
          }
        }
      }
    }

    // 7. Drain terrain cut log. Drill tunnel cuts (projectile.tickTunnel
    //    -> terrain.cutCircle) bypass emitExplodeEvents, so emit them as
    //    terrain_cut SimEvents here. Explosion cuts already emitted via
    //    emitExplodeEvents - filter them out to avoid double-emit.
    const drained = this.terrain.consumeCutLog();
    for (const cut of drained) {
      if (cut.source !== "tunnel") continue;
      this.events.push({ type: "terrain_cut", x: cut.x, y: cut.y, r: cut.r, seq: cut.seq });
    }

    // stateChanged: always true when playing (worms + projectiles
    // move). Cheap heuristic: events non-empty OR any worm moved OR
    // projectiles in flight (they drift under gravity + wind each tick).
    const stateChanged =
      this.events.length > 0 || this.wormsMoved(beforeWormPositions) || this.projectiles.length > 0;

    this.tickCount += 1;
    const emittedEvents = this.events;
    this.events = [];
    return {
      tick: this.tickCount,
      stateChanged,
      events: emittedEvents,
    };
  }

  // ---- Serialisation ----

  toSimState(): SimState {
    const worms: WormRenderState[] = [];
    for (const w of this.worms.values()) worms.push(w.toRenderState());
    const projectiles: ProjectileRenderState[] = [];
    for (const p of this.projectiles) projectiles.push(p.toRenderState());
    const objects: ObjectRenderState[] = [];
    for (const o of this.objects.values()) objects.push(o.toRenderState());
    return {
      tick: this.tickCount,
      worms,
      projectiles,
      objects,
      wind: this.wind,
      waterLevelPx: this.waterLevelPx,
    };
  }

  serialize(): SerializedSim {
    // Serialized positions/velocities are in METERS (physics-body native).
    // Only the wire format (`toRenderState`) is in pixels; internal
    // storage stays in meters so restore() can set body position directly.
    const teamAmmoRecord: Record<string, Record<string, number>> = {};
    for (const [teamId, pool] of this.teamAmmo) {
      teamAmmoRecord[teamId] = { ...pool };
    }
    return {
      tick: this.tickCount,
      teamAmmo: teamAmmoRecord,
      worms: Array.from(this.worms.values()).map((w) => {
        const pos = w.body.getPosition();
        const vel = w.body.getLinearVelocity();
        return {
          id: w.id,
          teamId: w.teamId,
          x: pos.x,
          y: pos.y,
          vx: vel.x,
          vy: vel.y,
          facing: w.facing,
          aimAngle: w.aimAngle,
          aimPower: w.aimPower,
          hp: w.health,
          alive: w.alive,
          activeWeapon: w.activeWeapon,
          ammoLeft: w.ammoLeft,
          jetPackActive: w.jetPackActive,
          jetPackFuel: w.jetPackFuel,
          jetPackThrustV: w.jetPackThrustV,
          jetPackThrustH: w.jetPackThrustH,
        };
      }),
      projectiles: this.projectiles.map((p) => ({
        id: p.id,
        ownerId: p.ownerId,
        weaponId: p.config.id,
        x: p.body.getPosition().x,
        y: p.body.getPosition().y,
        vx: p.body.getLinearVelocity().x,
        vy: p.body.getLinearVelocity().y,
        fuseRemainingMs: p.fuseRemainingMs,
      })),
      objects: Array.from(this.objects.values())
        .filter((o) => !o.dead)
        .map((o) => o.serialize()),
      terrainCutSeq: 0,
      wind: this.wind,
      waterLevelPx: this.waterLevelPx,
    };
  }

  /**
   * Apply a serialized sim state on top of this (freshly-constructed)
   * Simulation. Used by the DO to resume after hibernation: instantiate
   * with the original map + teams + seed, then call this to restore
   * positions / velocities / health / projectiles.
   */
  restore(state: SerializedSim): void {
    this.tickCount = state.tick;
    // Restore per-team ammo pools if present (absent in pre-fix serializations
    // means teams keep their freshly-initialized defaultAmmoForMatch pools).
    if (state.teamAmmo) {
      for (const [teamId, pool] of Object.entries(state.teamAmmo)) {
        this.teamAmmo.set(teamId, { ...pool });
      }
    }
    for (const ws of state.worms) {
      const worm = this.worms.get(ws.id);
      if (!worm) continue;
      worm.body.setPosition({ x: ws.x, y: ws.y });
      worm.body.setLinearVelocity({ x: ws.vx, y: ws.vy });
      worm.facing = ws.facing;
      worm.aimAngle = ws.aimAngle;
      worm.aimPower = ws.aimPower;
      worm.health = ws.hp;
      worm.alive = ws.alive;
      worm.activeWeapon = ws.activeWeapon;
      worm.ammoLeft = ws.ammoLeft;
      // Round-trip jetpack state across hibernation. Defaults cover pre-PR
      // persisted shapes that didn't have these fields.
      worm.jetPackActive = ws.jetPackActive ?? false;
      worm.jetPackFuel = ws.jetPackFuel ?? 100;
      worm.jetPackThrustV = ws.jetPackThrustV ?? false;
      worm.jetPackThrustH = ws.jetPackThrustH ?? 0;
    }
    this.wind = state.wind ?? 0;
    this.waterLevelPx = state.waterLevelPx ?? Number.MAX_SAFE_INTEGER;
    // Clear any bodies we pre-created for projectiles (we didn't).
    for (const ps of state.projectiles) {
      const weapon = getById(ps.weaponId);
      if (!weapon) continue;
      const proj = new Projectile({
        id: ps.id,
        ownerId: ps.ownerId,
        world: this.world,
        config: weapon,
        originPx: { x: toPixels(ps.x), y: toPixels(ps.y) },
        velocityMps: { x: ps.vx, y: ps.vy },
        fuseMs: ps.fuseRemainingMs,
      });
      this.projectiles.push(proj);
      const n = Number.parseInt(ps.id.replace("p", ""), 10);
      if (Number.isFinite(n) && n > this.projectileIdCounter) {
        this.projectileIdCounter = n;
      }
    }
    // Restore objects. The constructor pre-spawns from initialObjects; we
    // tear those down so restore is the single source of truth for object
    // state. IDs from the serialized snapshot are preserved so any in-flight
    // client references remain valid post-resume.
    for (const obj of this.objects.values()) {
      this.world.destroyBody(obj.body);
    }
    this.objects.clear();
    let maxObjectId = 0;
    for (const os of state.objects ?? []) {
      const n = Number.parseInt(os.id.replace("obj_", ""), 10);
      if (Number.isFinite(n) && n > maxObjectId) maxObjectId = n;
    }
    this.objectIdCounter = maxObjectId;
    for (const os of state.objects ?? []) {
      const obj = this.spawnObject(os.kind, os.x, os.y, os.id);
      obj.body.setLinearVelocity({ x: toMeters(os.vx), y: toMeters(os.vy) });
      obj.hp = os.hp;
      obj.flags = os.flags;
    }
    // Drain the spawn events generated by restore so they don't replay as new events.
    this.events = [];
  }

  // ---- Turn-arbiter feed ----

  aliveWormsByTeam(): Map<string, number> {
    const out = new Map<string, number>();
    for (const worm of this.worms.values()) {
      if (!worm.alive) continue;
      out.set(worm.teamId, (out.get(worm.teamId) ?? 0) + 1);
    }
    return out;
  }

  isWormAlive(wormId: string): boolean {
    return this.worms.get(wormId)?.alive ?? false;
  }

  getWorm(wormId: string): Worm | undefined {
    return this.worms.get(wormId);
  }

  allWorms(): Worm[] {
    return Array.from(this.worms.values());
  }

  projectileCount(): number {
    return this.projectiles.length;
  }

  /**
   * True when every alive worm has linear velocity magnitude below the
   * threshold AND no projectiles/throwables are currently in flight.
   * Used by turnArbiter to advance the turn as soon as the sim is quiet
   * instead of waiting the full SETTLE_GRACE_MS safety cap.
   */
  isAllSettled(velThresholdMps: number): boolean {
    const threshSq = velThresholdMps * velThresholdMps;
    for (const worm of this.worms.values()) {
      if (!worm.alive) continue;
      const v = worm.body.getLinearVelocity();
      if (v.x * v.x + v.y * v.y >= threshSq) return false;
    }
    if (this.projectiles.length > 0) return false;
    return true;
  }

  // ---- Object management ----

  spawnObject(kind: string, xPx: number, yPx: number, idOverride?: string): ObjectInstance {
    const id = idOverride ?? `obj_${++this.objectIdCounter}`;
    const obj = new ObjectInstance({ id, kind, world: this.world, xPx, yPx });
    this.objects.set(id, obj);
    this.events.push({ type: "object_spawn", id, kind, x: xPx, y: yPx });
    return obj;
  }

  private reapDeadObjects(): void {
    // Pass 1: actually remove tombstoned objects from the previous tick.
    // These have already had their destroy event + explosion fired and
    // appeared in one SimState broadcast with dead=true; now they go away.
    for (const [id, obj] of this.objects) {
      if (!obj.dead || !obj.tombstoned) continue;
      this.world.destroyBody(obj.body);
      this.objects.delete(id);
    }
    // Pass 2: handle freshly-dead objects. Fire side effects + destroy event
    // immediately, but keep the entry in the map (with dead=true) so it
    // appears in the next SimState broadcast as a tombstone for the client
    // to fade out. Pass 1 of the next tick's reap will remove the body.
    for (const [id, obj] of this.objects) {
      if (!obj.dead || obj.tombstoned) continue;
      if (obj.destroyCause === "explode" && obj.config.onDestroy) {
        const pos = obj.body.getPosition();
        const xPx = toPixels(pos.x);
        const yPx = toPixels(pos.y);
        const cfg = obj.config.onDestroy.explode;
        const result = explode({
          world: this.world,
          terrain: this.terrain,
          worms: this.worms.values(),
          centerPx: { x: xPx, y: yPx },
          config: {
            terrainRadiusPx: cfg.radiusPx,
            damageRadiusPx: cfg.radiusPx,
            maxDamage: cfg.damagePx,
            impulseMag: 3,
          },
          firedByWormId: null,
        });
        this.emitExplodeEvents(result, null);
      }
      this.events.push({ type: "object_destroy", id, cause: obj.destroyCause });
      obj.tombstoned = true;
    }
  }

  // ---- private ----

  private nextProjectileId(): string {
    this.projectileIdCounter += 1;
    return `p${this.projectileIdCounter}`;
  }

  private emitExplodeEvents(ex: ExplodeResult, fromProjectileId: string | null): void {
    this.events.push({
      type: "terrain_cut",
      x: ex.cut.x,
      y: ex.cut.y,
      r: ex.cut.r,
      seq: ex.cut.seq,
    });
    dlog("sim", "terrain_cut", this.getLogCtx(), { x: ex.cut.x, y: ex.cut.y, r: ex.cut.r });
    for (const d of ex.damaged) {
      this.events.push({
        type: "damage_event",
        wormId: d.wormId,
        amount: d.amount,
        fromProjectileId,
        impact: { x: ex.cut.x, y: ex.cut.y },
      });
      if (d.died && !this.diedThisTick.has(d.wormId)) {
        this.diedThisTick.add(d.wormId);
        this.events.push({ type: "worm_died", wormId: d.wormId });
        dlog("sim", "worm_died", this.getLogCtx(), { wormId: d.wormId, cause: "explosion" });
      }
    }
  }

  private detonateProjectile(proj: Projectile, _reason: "contact" | "fuse"): void {
    if (proj.detonated) return;
    proj.markDetonated();
    const pos = proj.body.getPosition();
    dlog("sim", "detonate", this.getLogCtx(), {
      weaponId: proj.config.id,
      x: toPixels(pos.x),
      y: toPixels(pos.y),
    });
    const centerPx = { x: toPixels(pos.x), y: toPixels(pos.y) };
    const result = explode({
      world: this.world,
      terrain: this.terrain,
      worms: this.worms.values(),
      centerPx,
      config: proj.config.explosion,
      firedByWormId: proj.ownerId,
    });
    this.emitExplodeEvents(result, proj.id);
  }

  private onBeginContact = (contact: Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    const fixtures = [a, b];

    for (const fixture of fixtures) {
      const ud = fixture.getBody().getUserData() as ProjectileUserData | null;
      if (ud && ud.kind === "projectile" && !ud.projectile.detonated) {
        // Determine what the projectile hit - check the OTHER body.
        const otherBody = (fixture === a ? b : a).getBody();
        const otherUd = otherBody.getUserData() as WormUserData | WormFootUserData | null;
        const isWormContact = otherUd?.kind === "worm" || otherUd?.kind === "worm-foot";

        // Detonate immediately on worm contact regardless of fuse state.
        // This lets the drill (which has a fuse) still explode when it hits a worm
        // rather than tunneling through it harmlessly.
        // For terrain/other contacts, keep the original fuse-null gate so
        // fused projectiles (drill) keep tunneling until the fuse expires.

        // Skip detonation when the projectile contacts its own firer. Without
        // this, drill fired straight down spawns inside the firer's foot sensor
        // and self-destructs (the foot sensor's body userData is kind:"worm",
        // so otherBody.getUserData() reports a worm contact). Bazooka into one's
        // own feet also no longer self-detonates - acceptable edge case;
        // fused weapons still detonate via fuse expiration regardless.
        const otherWormRef = (otherUd as { worm?: { id: string } } | null)?.worm;
        const isFirerSelfContact = isWormContact && otherWormRef?.id === ud.projectile.ownerId;

        if (!isFirerSelfContact && (ud.projectile.fuseRemainingMs === null || isWormContact)) {
          this.pendingDetonate.push(ud.projectile);
        }
      }
    }

    // Projectile-vs-object contact: queue damage; the projectile also detonates.
    const bodyA = a.getBody();
    const bodyB = b.getBody();
    const userDataA = bodyA.getUserData() as { kind?: string } | null;
    const userDataB = bodyB.getUserData() as { kind?: string } | null;
    if (userDataA?.kind === "object" || userDataB?.kind === "object") {
      const objData = (userDataA?.kind === "object" ? userDataA : userDataB) as ObjectUserData;
      const otherData = userDataA?.kind === "object" ? userDataB : userDataA;
      if (otherData?.kind === "projectile") {
        const projData = otherData as ProjectileUserData;
        if (!projData.projectile.detonated && !objData.object.dead) {
          this.pendingObjectHits.push({ obj: objData.object, projectile: projData.projectile });
          // Detonate the projectile too. Mirrors worm contact (line 926):
          // a projectile hitting an object should fire its own explosion
          // (damage radius affects nearby worms) in addition to the
          // object's onDestroy explosion when the object dies.
          this.pendingDetonate.push(projData.projectile);
        }
      }
    }

    // Worm foot sensor contact tracking (mirrors client).
    for (const fixture of fixtures) {
      const ud = fixture.getUserData() as WormFootUserData | null;
      if (ud && ud.kind === "worm-foot") {
        const other = fixture === a ? b : a;
        // Only count against non-sensor terrain + non-self
        if (other.isSensor()) continue;
        const otherBody = other.getBody();
        if (otherBody === fixture.getBody()) continue;
        ud.worm.onFootContactBegin();
      }
    }
  };

  private handlePostSolve(contact: Contact, impulse: ContactImpulse): void {
    const normalImpulse = impulse.normalImpulses[0] ?? 0;
    if (normalImpulse <= 0) return;
    const fA = contact.getFixtureA();
    const fB = contact.getFixtureB();
    // WormUserData is set on the body (this.body.setUserData) not the fixture.
    // ProjectileUserData is also set on the body.
    const bodyUdA = fA.getBody().getUserData() as
      | WormUserData
      | WormFootUserData
      | { kind?: string }
      | null;
    const bodyUdB = fB.getBody().getUserData() as
      | WormUserData
      | WormFootUserData
      | { kind?: string }
      | null;
    // Skip contacts involving projectiles (handled via detonation).
    if (bodyUdA?.kind === "projectile" || bodyUdB?.kind === "projectile") return;
    // Accumulate fall impulse on worm bodies. kind === "worm" is the main body
    // userData set in the Worm constructor. The foot sensor fixture shares the
    // same body so kind will also be "worm" - that's fine since we want the
    // body-level tracking. Sensors don't participate in physics resolution so
    // post-solve won't fire for them anyway.
    if (bodyUdA?.kind === "worm")
      (bodyUdA as WormUserData).worm.accumulateFallImpulse(normalImpulse);
    if (bodyUdB?.kind === "worm")
      (bodyUdB as WormUserData).worm.accumulateFallImpulse(normalImpulse);
  }

  private snapshotWormPositions(): Map<string, { x: number; y: number }> {
    const out = new Map<string, { x: number; y: number }>();
    for (const [id, worm] of this.worms) {
      const p = worm.body.getPosition();
      out.set(id, { x: p.x, y: p.y });
    }
    return out;
  }

  private wormsMoved(before: Map<string, { x: number; y: number }>): boolean {
    for (const [id, worm] of this.worms) {
      const prev = before.get(id);
      if (!prev) return true;
      const cur = worm.body.getPosition();
      if (Math.abs(cur.x - prev.x) > 1e-5 || Math.abs(cur.y - prev.y) > 1e-5) return true;
    }
    return false;
  }
}
