/**
 * Epic 45 - OfflineSimAdapter.
 *
 * Wraps the pre-Epic-45 local planck simulation behind the SimAdapter
 * contract. All of the physics-touching code (PhysicsSystem, Terrain bodies,
 * Worm bodies, ProjectileManager, fire, explode, TurnManager, contact
 * listeners) now lives inside this adapter rather than sprawling across
 * GameScene. GameScene becomes a pure renderer + input dispatcher.
 *
 * This adapter is used whenever:
 *   - the URL has `?offline=1` (single-device dev)
 *   - GameScene was entered without a RoomHandle
 *
 * The networked path uses NetworkedSimAdapter instead, which never loads
 * any of these modules.
 *
 * The adapter OWNS:
 *   - PhysicsSystem (planck World)
 *   - Terrain (with planck bodies)
 *   - Worm[] (with planck bodies)
 *   - ProjectileManager
 *   - WeaponManager per team
 *   - TurnManager
 *   - NinjaRope + JetPack utilities per worm
 *
 * GameScene still owns the scene graph: sprite roots, debug graphics,
 * HUDs, touch controls. The adapter pokes through to the scene for
 * `scene.add.graphics()` etc. because Worm + ProjectileManager already
 * need the Phaser scene reference.
 */

import type Phaser from "phaser";
import type { Contact, ContactImpulse } from "planck";
import type { LoadedMap } from "../maps/types";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { TurnManager } from "../state/TurnManager";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";
import { JetPack } from "../utilities/JetPack";
import { NinjaRope } from "../utilities/NinjaRope";
import { ProjectileManager } from "../weapons/ProjectileManager";
import { WeaponManager } from "../weapons/WeaponManager";
import { fire } from "../weapons/fire";
import { defaultAmmoForMatch } from "../weapons/registry";
import { Team } from "../worm/Team";
import { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import { fallDamageFromImpulse } from "../worm/fallDamage";
import type { RenderableProjectile, RenderableWorm, SimAdapter, SimEvent } from "./SimAdapter";

export interface OfflineSimAdapterInit {
  scene: Phaser.Scene;
  loaded: LoadedMap;
  widthPx: number;
  heightPx: number;
  teams: Array<{ id: string; name: string; color: number; wormNames: string[] }>;
}

export class OfflineSimAdapter implements SimAdapter {
  readonly kind = "offline" as const;
  readonly teams: Team[] = [];

  private readonly physicsSystem: PhysicsSystem;
  private readonly terrainInstance: Terrain;
  private readonly wormList: Worm[] = [];
  private readonly projectileManager: ProjectileManager;
  private readonly weaponManagers = new Map<Team, WeaponManager>();
  private readonly turnManager: TurnManager;

  private readonly eventSubs = new Set<(ev: SimEvent) => void>();
  private readonly gameOverSubs = new Set<(winnerTeamId: string | null) => void>();
  private readonly turnChangedSubs = new Set<(teamId: string, wormId: string) => void>();
  private readonly inputAllowedSubs = new Set<(allowed: boolean) => void>();
  private readonly stableStateSubs = new Set<() => void>();

  // Rendering mirror: OfflineSimAdapter's Worms own their own sprites for
  // backward compat with the pre-Epic-45 flow. RenderableWorm[] is a thin
  // view that GameScene polls each frame. In the networked variant the
  // worms are render-only (no body); here we forward getters to the
  // underlying Worm so the API shape matches either way.
  readonly allWorms: RenderableWorm[] = [];

  private inputAllowed = false;

  constructor(init: OfflineSimAdapterInit) {
    // --- Build physics world + terrain (with bodies) ---
    this.physicsSystem = new PhysicsSystem({ gravity: { x: 0, y: tuning.world.gravityY } });
    this.terrainInstance = new Terrain({
      scene: init.scene,
      physics: this.physicsSystem,
      widthPx: init.widthPx,
      heightPx: init.heightPx,
      sourceMask: init.loaded.mask,
      prePainted: init.loaded.config.prePainted,
      materialMap: init.loaded.materialMap,
      hardness: tuning.worldgen.materialHardness,
    });

    // Register contact listeners BEFORE spawning worms (matches old GameScene).
    this.physicsSystem.world.on("begin-contact", this.onBeginContact);
    this.physicsSystem.world.on("end-contact", this.onEndContact);
    this.physicsSystem.world.on("post-solve", this.onPostSolve);

    // --- Build teams + worms ---
    for (const t of init.teams) {
      this.teams.push(new Team({ id: t.id, name: t.name, color: t.color }));
    }

    const spawnPts = init.loaded.spawnPoints;
    const totalWorms = init.teams.reduce((n, t) => n + t.wormNames.length, 0);
    const fallbackYPx = init.heightPx * 0.3;
    for (let i = 0; i < totalWorms; i++) {
      const team = this.teams[i % this.teams.length];
      if (!team) continue;
      const teamInit = init.teams[this.teams.indexOf(team)];
      if (!teamInit) continue;
      const pt = spawnPts[i];
      const spawnXPx = pt ? pt.xPx : (init.widthPx / (totalWorms + 1)) * (i + 1);
      const spawnYPx = pt ? pt.yPx - tuning.worm.radiusPx * 2 : fallbackYPx;
      const wormName =
        teamInit.wormNames[team.worms.length] ?? `${team.id}-${team.worms.length + 1}`;
      const w = new Worm({
        scene: init.scene,
        physics: this.physicsSystem,
        team,
        spawnXPx,
        spawnYPx,
        wormName,
      });
      team.addWorm(w);
      this.wormList.push(w);
      this.allWorms.push(this.makeRenderableView(w));
    }

    // Rope + JetPack utilities per worm.
    for (const w of this.wormList) {
      w.ropeUtility = new NinjaRope({
        scene: init.scene,
        world: this.physicsSystem.world,
        worm: w,
      });
      w.jetPackUtility = new JetPack({ scene: init.scene, worm: w });
    }

    // --- Projectile manager + weapon managers ---
    this.projectileManager = new ProjectileManager({
      scene: init.scene,
      world: this.physicsSystem.world,
      terrain: this.terrainInstance,
      onDetonate: (firer, selfDamage) => {
        if (selfDamage > 0 && firer === this.turnManager.getActiveWorm()) {
          this.turnManager.reportSelfDamage(selfDamage);
        }
      },
    });
    for (const team of this.teams) {
      this.weaponManagers.set(team, new WeaponManager(team, defaultAmmoForMatch()));
    }

    // --- Turn manager ---
    this.turnManager = new TurnManager({
      scene: init.scene,
      teams: this.teams,
      allWorms: this.wormList,
      onTurnStart: (team, worm) => {
        this.setInputAllowed(true);
        this.getWeaponManager(team)?.resetActivation();
        for (const sub of this.turnChangedSubs) sub(team.id, worm.name);
        // Offline sim is always immediately stable - fire stable subs on next microtask.
        queueMicrotask(() => {
          for (const sub of this.stableStateSubs) sub();
        });
      },
      onTurnEnd: () => {
        this.setInputAllowed(false);
        for (const w of this.wormList) {
          w.ropeUtility?.deactivate();
          w.jetPackUtility?.deactivate();
        }
      },
      onGameOver: (winner) => {
        this.setInputAllowed(false);
        for (const sub of this.gameOverSubs) sub(winner?.id ?? null);
      },
    });
    this.turnManager.start();
  }

  // -------------------------------------------------------------------------
  // Scene / host accessors. The new GameScene needs these for its renderer
  // (draw worm sprites via the embedded Worm.graphics, call
  // terrain.sprite.setDepth, etc.). Kept read-only via getters.
  // -------------------------------------------------------------------------

  /** Underlying Terrain (visual sprite + mask + bodies). Scene uses this for the sprite. */
  get terrain(): Terrain {
    return this.terrainInstance;
  }

  /** Live Worm[] with embedded bodies + sprites. Scene reads Worm.* for rendering. */
  get wormsInternal(): Worm[] {
    return this.wormList;
  }

  /** TurnManager reference so the scene can wire end-turn buttons / HUDs. */
  get turns(): TurnManager {
    return this.turnManager;
  }

  /** Weapon manager lookup for UI (ammo drawer, etc.). */
  getWeaponManager(team: Team | null): WeaponManager | null {
    if (!team) return null;
    return this.weaponManagers.get(team) ?? null;
  }

  /** Projectile count (drives settle detection in older scenes; kept for parity). */
  get projectileCount(): number {
    return this.projectileManager.count;
  }

  /**
   * Returns live offline projectiles with their Phaser Graphics objects so
   * CameraFollower can track them. Each entry has a stable id for the
   * projectile's lifetime.
   */
  getProjectilesWithGfx(): ReadonlyArray<{
    id: string;
    gfx: import("phaser").GameObjects.Graphics;
  }> {
    return this.projectileManager.getProjectilesWithGfx();
  }

  // -------------------------------------------------------------------------
  // SimAdapter API
  // -------------------------------------------------------------------------

  getActiveWormId(): string {
    return this.turnManager.getActiveWorm()?.name ?? "";
  }

  getActiveTeamId(): string {
    return this.turnManager.getActiveTeam()?.id ?? "";
  }

  getActiveWeaponId(): string {
    const team = this.turnManager.getActiveTeam();
    return this.getWeaponManager(team)?.getSelected().id ?? "";
  }

  getTurnSecondsRemaining(): number {
    return this.turnManager.getTurnSecondsRemaining();
  }

  getWind(): number {
    return 0;
  }

  getWaterLevelPx(): number {
    return Number.MAX_SAFE_INTEGER;
  }

  walk(dir: -1 | 0 | 1): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.walk(dir);
  }

  jump(): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.jump();
  }

  backflip(): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.backflip();
  }

  setAimAngle(rad: number): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.setAimAngle(rad);
  }

  setAimPower(p: number): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.setAimPower(p);
  }

  setFacing(dir: -1 | 1): void {
    if (!this.inputAllowed) return;
    this.turnManager.getActiveWorm()?.setFacing(dir);
  }

  selectWeapon(id: string): void {
    if (!this.inputAllowed) return;
    const team = this.turnManager.getActiveTeam();
    this.getWeaponManager(team)?.select(id);
  }

  fire(): void {
    if (!this.inputAllowed) return;
    const team = this.turnManager.getActiveTeam();
    const worm = this.turnManager.getActiveWorm();
    const wm = this.getWeaponManager(team);
    if (!wm || !worm) return;
    const weapon = wm.getSelected();
    if (!wm.hasAmmo(weapon.id)) return;
    const result = fire(
      weapon,
      {
        world: this.physicsSystem.world,
        terrain: this.terrainInstance,
        firer: worm,
        aimRadians: worm.aimAngle,
        aimPower01: worm.aimPower01,
        projectileManager: this.projectileManager,
      },
      wm.shotsFiredThisActivation,
    );
    wm.consumeOne(weapon.id);
    wm.shotsFiredThisActivation++;
    if (result.turnEndsImmediately) {
      this.turnManager.endTurnByPlayer();
    }
  }

  endTurn(): void {
    this.turnManager.endTurnByPlayer();
  }

  toggleRope(): void {
    if (!this.inputAllowed) return;
    const worm = this.turnManager.getActiveWorm();
    if (!worm) return;
    worm.ropeUtility?.isActive() ? worm.ropeUtility.deactivate() : worm.ropeUtility?.activate();
  }

  toggleJetPack(): void {
    if (!this.inputAllowed) return;
    const worm = this.turnManager.getActiveWorm();
    if (!worm) return;
    worm.jetPackUtility?.isActive()
      ? worm.jetPackUtility.deactivate()
      : worm.jetPackUtility?.activate();
  }

  setJetPackThrust(active: boolean): void {
    this.turnManager.getActiveWorm()?.jetPackUtility?.setVerticalInput(active);
  }

  setJetPackHorizontal(dir: -1 | 0 | 1): void {
    this.turnManager.getActiveWorm()?.jetPackUtility?.setHorizontalInput(dir);
  }

  setJetPackThrustVector(vx: number, vy: number): void {
    this.turnManager.getActiveWorm()?.jetPackUtility?.setThrustVector(vx, vy);
  }

  isJetPacking(): boolean {
    return this.turnManager.getActiveWorm()?.isJetPacking() ?? false;
  }

  getJetPackFuel(): number {
    const worm = this.turnManager.getActiveWorm();
    if (!worm) return 0;
    return worm.jetPackUtility?.getFuel() ?? 0;
  }

  update(dtMs: number): void {
    this.physicsSystem.step(dtMs);
    this.terrainInstance.flushPendingCuts();
    this.projectileManager.update(dtMs);
    for (const w of this.wormList) w.applyPendingDamage();
    this.turnManager.update(dtMs);
    for (const w of this.wormList) {
      w.update(dtMs);
      w.ropeUtility?.update(dtMs);
      w.jetPackUtility?.update(dtMs);
    }
  }

  destroy(): void {
    try {
      this.physicsSystem.world.off("begin-contact", this.onBeginContact);
      this.physicsSystem.world.off("end-contact", this.onEndContact);
      this.physicsSystem.world.off("post-solve", this.onPostSolve);
    } catch {
      // Already torn down.
    }
    try {
      this.turnManager.destroy();
    } catch {
      // no-op
    }
    try {
      this.projectileManager.destroy();
    } catch {
      // no-op
    }
    for (const w of this.wormList) {
      try {
        w.destroy();
      } catch {
        // no-op
      }
    }
    this.eventSubs.clear();
    this.gameOverSubs.clear();
    this.turnChangedSubs.clear();
    this.inputAllowedSubs.clear();
    this.stableStateSubs.clear();
  }

  onEvent(cb: (ev: SimEvent) => void): () => void {
    this.eventSubs.add(cb);
    return () => {
      this.eventSubs.delete(cb);
    };
  }

  onGameOver(cb: (winnerTeamId: string | null) => void): () => void {
    this.gameOverSubs.add(cb);
    return () => {
      this.gameOverSubs.delete(cb);
    };
  }

  onTurnChanged(cb: (activeTeamId: string, activeWormId: string) => void): () => void {
    this.turnChangedSubs.add(cb);
    return () => {
      this.turnChangedSubs.delete(cb);
    };
  }

  onInputAllowedChanged(cb: (allowed: boolean) => void): () => void {
    this.inputAllowedSubs.add(cb);
    return () => {
      this.inputAllowedSubs.delete(cb);
    };
  }

  onStateStable(cb: () => void): () => void {
    this.stableStateSubs.add(cb);
    return () => {
      this.stableStateSubs.delete(cb);
    };
  }

  /** Scene exposes this for settle / isInputAllowed UI gating. */
  isInputAllowed(): boolean {
    return this.inputAllowed;
  }

  /** Current projectile list for scene rendering (offline mode: empty; worms draw themselves). */
  getProjectiles(): RenderableProjectile[] {
    // Offline mode: ProjectileManager owns its own graphics. Scene doesn't
    // need a render list because the projectiles render themselves via
    // Phaser Graphics attached to the ProjectileManager. Returning an empty
    // list here keeps the API uniform with NetworkedSimAdapter without
    // forcing GameScene to branch.
    return [];
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private setInputAllowed(allowed: boolean): void {
    if (this.inputAllowed === allowed) return;
    this.inputAllowed = allowed;
    for (const sub of this.inputAllowedSubs) sub(allowed);
  }

  private makeRenderableView(worm: Worm): RenderableWorm {
    return {
      get id() {
        return worm.name;
      },
      get team() {
        return worm.team;
      },
      get xPx() {
        return worm.xPx;
      },
      get yPx() {
        return worm.yPx;
      },
      get facing() {
        return worm.facing;
      },
      get aimAngle() {
        return worm.aimAngle;
      },
      get aimPower() {
        return worm.aimPower01;
      },
      get hp() {
        return worm.health;
      },
      get isAlive() {
        return worm.isAlive;
      },
      get name() {
        return worm.name;
      },
    };
  }

  private onBeginContact = (contact: Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    if (a.isSensor()) {
      const ud = a.getBody().getUserData() as WormUserData | null;
      if (ud?.kind === "worm") ud.worm.onFootContactBegin();
    }
    if (b.isSensor()) {
      const ud = b.getBody().getUserData() as WormUserData | null;
      if (ud?.kind === "worm") ud.worm.onFootContactBegin();
    }
  };

  private onEndContact = (contact: Contact): void => {
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    if (a.isSensor()) {
      const ud = a.getBody().getUserData() as WormUserData | null;
      if (ud?.kind === "worm") ud.worm.onFootContactEnd();
    }
    if (b.isSensor()) {
      const ud = b.getBody().getUserData() as WormUserData | null;
      if (ud?.kind === "worm") ud.worm.onFootContactEnd();
    }
  };

  private onPostSolve = (contact: Contact, impulse: ContactImpulse): void => {
    const normalImpulse = impulse.normalImpulses[0] ?? 0;
    if (normalImpulse <= 0) return;
    const a = contact.getFixtureA();
    const b = contact.getFixtureB();
    for (const fixture of [a, b]) {
      if (fixture.isSensor()) continue;
      const ud = fixture.getBody().getUserData() as WormUserData | null;
      if (ud?.kind === "worm") {
        const dmg = fallDamageFromImpulse(normalImpulse, {
          density: tuning.worm.density,
          threshold: tuning.worm.fallDamageThresholdImpulse,
          maxDamage: tuning.worm.fallDamageCapHp,
        });
        if (dmg > 0) ud.worm.takeDamage(dmg);
      }
    }
  };
}
