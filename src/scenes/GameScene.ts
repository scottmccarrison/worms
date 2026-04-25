import * as Phaser from "phaser";
import { unpackMask } from "../../shared/maskPack";
import { WORLD_HEIGHT_PX, WORLD_WIDTH_PX } from "../../shared/worldConfig";
import { dlogUnthrottled } from "../debug/logger";
import { mountTuningPanel, registerMapCycleFn } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { type GestureInput, createGestureTracker } from "../input/touchGestures";
import { loadMap } from "../maps/loadMap";
import { firstId, getById, nextId } from "../maps/registry";
import type { NetClient } from "../net/client";
import { clearRoomToken, readRoomToken, saveRoomToken } from "../net/clientStorage";
import { runReconnectLoop } from "../net/reconnectLoop";
import type { TeamInit as NetTeamInit } from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { NetworkedSimAdapter } from "../sim/NetworkedSimAdapter";
import { OfflineSimAdapter } from "../sim/OfflineSimAdapter";
import type { RenderableWorm, SimAdapter, SimEvent } from "../sim/SimAdapter";
import { TerrainRenderer } from "../terrain/TerrainRenderer";
import { WaterRenderer } from "../terrain/WaterRenderer";
import { tuning } from "../tuning";
import { AimHUD } from "../ui/AimHUD";
import { CameraFollower } from "../ui/CameraFollower";
import { ReconnectingOverlay } from "../ui/ReconnectingOverlay";
import { SpectatorHUD } from "../ui/SpectatorHUD";
import { TouchControls } from "../ui/TouchControls";
import { TurnHUD } from "../ui/TurnHUD";
import { TurnTransition } from "../ui/TurnTransition";
import { UtilityDPad } from "../ui/UtilityDPad";
import { WeaponRadial } from "../ui/WeaponRadial";
import { WindHUD } from "../ui/WindHUD";
import { allWeapons, defaultAmmoForMatch } from "../weapons/registry";
import type { Team } from "../worm/Team";
import type { Worm } from "../worm/Worm";
import { WormSprite } from "../worm/WormSprite";

/**
 * Post-Epic-45 GameScene. The scene is a thin shell that:
 *
 *   1. Picks a SimAdapter (OfflineSimAdapter or NetworkedSimAdapter)
 *      based on whether a RoomHandle was handed in by the lobby.
 *   2. Instantiates input + HUD + touch overlays.
 *   3. Each frame: calls `adapter.update(dtMs)` (offline: drives local
 *      planck step; networked: advances interpolation clock), then
 *      renders worm + projectile sprites from the adapter's
 *      RenderableWorm snapshots.
 *   4. Routes VFX events from the adapter onto terrain cuts / particles /
 *      screen shake (commit 8 fills the VFX hooks).
 *
 * The scene NO LONGER owns PhysicsSystem, Terrain-with-bodies, Worm
 * physics bodies, ProjectileManager, fire, or explode. Those live inside
 * OfflineSimAdapter.
 */
export class GameScene extends Phaser.Scene {
  // ---- Adapter (owns the sim - offline or networked) ----
  private sim!: SimAdapter;
  /** Narrowed alias when kind = "offline"; null in networked mode. */
  private offlineSim: OfflineSimAdapter | null = null;
  /** Narrowed alias when kind = "networked"; null in offline mode. */
  private networkedSim: NetworkedSimAdapter | null = null;

  // ---- Networked-mode-only render helpers ----
  /** Visual-only terrain (mask + sprite, no bodies). Networked mode owns one. */
  private terrainRenderer: TerrainRenderer | null = null;
  /** One sprite per worm (networked mode). Offline mode's Worm class
   * renders itself so this map stays empty. */
  private wormSprites: Map<string, WormSprite> = new Map();
  /** Fallback graphics for server-spawned projectiles (networked mode). */
  private projectileGraphics: Map<string, Phaser.GameObjects.Graphics> = new Map();

  // ---- Wind + water HUD / rendering ----
  private windHUD: WindHUD | null = null;
  private waterRenderer: WaterRenderer | null = null;

  // ---- Scene-level UI (same for both modes) ----
  private debugGfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private inputController!: InputController;
  private touchControls!: TouchControls;
  private turnHUD!: TurnHUD;
  private spectatorHUD: SpectatorHUD | null = null;
  private weaponRadial!: WeaponRadial;
  private aimHUD!: AimHUD;
  /** Rope / jetpack d-pad. Offline-only (networked disables utilities per #65).
   * Shown when a utility is active, hidden otherwise; visibility + callbacks
   * are refreshed each frame in `update`. */
  private utilityDPad: UtilityDPad | null = null;
  private utilityDPadVisible = false;
  private turnTransition: TurnTransition | null = null;
  private cameraFollower: CameraFollower | null = null;

  // ---- Pointer-gesture state (primary pointer only) ----
  /** Gesture state machine shared across pointer events. Stores last-release
   * timestamps across gestures for double-tap detection. */
  private gestureTracker = createGestureTracker();
  /** Which gesture flavor the current (single) pointer is driving.
   * - "aim": drag-to-aim (existing behavior)
   * - "walk": tap-hold on a screen half, walking left/right
   * - null: no pointer is being tracked
   */
  private activeGestureKind: "aim" | "walk" | null = null;
  /** Pointer id that opened the active gesture. Only this id's move/up events
   * are honored; other pointers (multi-touch) are routed to their own buttons. */
  private activePointerId: number | null = null;
  /** Origin of the active aim drag in screen px. Used by pointermove to compute
   * drag length vs dead-zone for fire-on-release. */
  private aimDragStart: { x: number; y: number } | null = null;

  // ---- Init-time data ----
  private mapId: string = firstId();
  private seedOverride: number | undefined;
  private teamsInit: NetTeamInit[] | undefined;
  private room: RoomHandle | undefined;
  private netClient: NetClient | undefined;
  private isNetworked = false;
  private mySessionId = "";
  private myTeamId = "";
  // Authoritative geometry from server's game_started. Networked mode uses
  // these instead of calling loadMap() locally so server physics + client
  // visuals align pixel-perfect.
  private serverMask: string | null = null;
  private serverWidthPx: number | null = null;
  private serverHeightPx: number | null = null;

  // ---- Networked-mode: monotonic ids for server-spawned projectiles ----

  // ---- Reconnect + disconnected-owner overlay (networked mode only) ----
  private reconnectingOverlay: ReconnectingOverlay | null = null;
  private reconnectInFlight = false;
  private currentRoomCode = "";
  private disconnectTick: Phaser.Time.TimerEvent | null = null;
  private roomUnsubs: Array<() => void> = [];
  private returnToLobbyObjects: Phaser.GameObjects.GameObject[] = [];

  // ---- Offline-mode WeaponManager map (built per-team) ----
  // Networked mode: ammo + select state arrive via sim_state.worms[].ammoLeft.
  // This map is only present in offline mode so the weapon drawer UI can
  // read authoritative ammo counts.

  // Aim throttling lives inside NetworkedSimAdapter now; scene dispatches
  // every pointermove and the adapter decides when to fire a wire message.

  // (Active-worm tracking flows through the adapter's onTurnChanged hook;
  // no field needed at this layer.)

  constructor() {
    super("GameScene");
  }

  init(data?: {
    mapId?: string;
    seed?: number;
    teams?: NetTeamInit[];
    room?: RoomHandle;
    netClient?: NetClient;
    /** Base64 Uint8Array mask from the server's game_started. Networked
     *  mode uses this as the source of truth for visual terrain; offline
     *  falls back to loadMap(). */
    mask?: string;
    /** Authoritative spawn points from the server (paired with mask). */
    spawnPoints?: Array<{ xPx: number; yPx: number }>;
    widthPx?: number;
    heightPx?: number;
  }): void {
    const candidate = data?.mapId ?? this.readMapQueryParam() ?? tuning.maps.defaultId ?? firstId();
    this.mapId = getById(candidate) ? candidate : firstId();
    this.seedOverride = data?.seed;
    this.teamsInit = data?.teams;
    this.room = data?.room;
    this.netClient = data?.netClient;
    this.isNetworked = !!this.room;
    this.mySessionId = this.room?.sessionId ?? "";
    this.serverMask = data?.mask ?? null;
    this.serverWidthPx = data?.widthPx ?? null;
    this.serverHeightPx = data?.heightPx ?? null;
    // spawnPoints in game_started are for the server's physics only; the
    // client doesn't need them since worm positions arrive via sim_state.
    registerMapCycleFn((id: string) => {
      this.scene.restart({ mapId: id });
    });
  }

  private readMapQueryParam(): string | null {
    const url = new URL(window.location.href);
    return url.searchParams.get("map");
  }

  create(): void {
    dlogUnthrottled("scene", "GameScene.create", { isNetworked: this.isNetworked });
    // Build the team roster once; both adapters use the same shape.
    const teamsForAdapter = this.buildAdapterTeams(this.teamsInit);

    // ------------------------------------------------------------------
    // Pick the adapter. Everything sim-related flows through it.
    // ------------------------------------------------------------------
    // World dimensions: networked games get them from game_started; offline
    // and fallback paths use the canonical WORLD_*_PX constants so the
    // scrolling world (2560x1024) still applies. Never use this.scale.width
    // as a fallback - that's the logical viewport (1280x720 for Scale.FIT),
    // not the world.
    const worldW = this.serverWidthPx ?? WORLD_WIDTH_PX;
    const worldH = this.serverHeightPx ?? WORLD_HEIGHT_PX;
    if (this.isNetworked && this.room) {
      // Networked path: the server is authoritative for geometry. Paint
      // the received mask into a canvas for the visual terrain.
      const maskCanvas = this.serverMask
        ? decodeServerMaskToCanvas(this.serverMask, worldW, worldH)
        : loadMap(this.mapId, worldW, worldH, this.seedOverride).mask;
      this.terrainRenderer = new TerrainRenderer({
        scene: this,
        widthPx: worldW,
        heightPx: worldH,
        sourceMask: maskCanvas,
      });
      this.networkedSim = new NetworkedSimAdapter({
        room: this.room,
        teams: this.teamsInit ?? [],
      });
      this.sim = this.networkedSim;
    } else {
      // Offline path: adapter owns everything physics-touching.
      const loaded = loadMap(this.mapId, worldW, worldH, this.seedOverride);
      this.offlineSim = new OfflineSimAdapter({
        scene: this,
        loaded,
        widthPx: worldW,
        heightPx: worldH,
        teams: teamsForAdapter,
      });
      this.sim = this.offlineSim;
    }

    // Build render sprites for networked worms; offline worms draw themselves.
    if (this.networkedSim) {
      for (const w of this.networkedSim.allWorms) {
        this.wormSprites.set(w.id, new WormSprite({ scene: this }, w));
      }
    }

    // Event + game-over subscriptions (both modes). We attach these AFTER
    // adapter construction so the first turn's onTurnStart (fired synchronously
    // during OfflineSimAdapter's TurnManager.start()) has already fired; the
    // current active worm is re-read below when the HUDs wire up.
    this.sim.onEvent((ev) => this.handleSimEvent(ev));
    this.sim.onGameOver((winnerTeamId) => this.handleGameOver(winnerTeamId));
    this.sim.onTurnChanged((teamId, wormId) => this.handleTurnChanged(teamId, wormId));
    this.sim.onInputAllowedChanged((allowed) => {
      this.inputController?.setInputAllowed(allowed);
      this.turnHUD?.setEndTurnEnabled(allowed);
    });

    // ------------------------------------------------------------------
    // Shutdown hook. Scene.restart on reconnect re-runs create(); we rely
    // on SHUTDOWN to tear down adapter + unsubs.
    // ------------------------------------------------------------------
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      dlogUnthrottled("scene", "GameScene.shutdown", { unsubCount: this.roomUnsubs.length });
      // Tear down room listeners FIRST so a throw in any of the downstream
      // destroys can't leave an active onStateChange listener that keeps
      // firing (and attempting scene.start) after we've moved on.
      this.tearDownRoomListeners();
      this.cameraFollower?.destroy();
      this.cameraFollower = null;
      this.turnTransition?.destroy();
      this.turnTransition = null;
      try {
        this.sim.destroy();
      } catch {
        // adapter may have torn itself down on reconnect; ignore.
      }
      for (const s of this.wormSprites.values()) s.destroy();
      this.wormSprites.clear();
      for (const g of this.projectileGraphics.values()) g.destroy();
      this.projectileGraphics.clear();
      this.turnHUD?.destroy();
      this.weaponRadial?.destroy();
      this.aimHUD?.destroy();
      this.spectatorHUD?.destroy();
      this.utilityDPad?.destroy();
      this.utilityDPad = null;
      this.windHUD?.destroy();
      this.windHUD = null;
      this.waterRenderer?.destroy();
      this.waterRenderer = null;
      this.reconnectingOverlay?.destroy();
      this.reconnectingOverlay = null;
      this.disconnectTick?.remove(false);
      this.disconnectTick = null;
      this.terrainRenderer?.destroy();
      this.terrainRenderer = null;
    });

    // ------------------------------------------------------------------
    // Input layer. InputController drives the adapter, not Worm directly.
    // ------------------------------------------------------------------
    this.inputController = new InputController({
      scene: this,
      allWorms: this.offlineSim?.wormsInternal ?? [],
      onEndTurn: () => {
        this.sim.endTurn();
      },
      onSelectWeapon: (n) => {
        const weapon = allWeapons().find((w) => w.selectKey === n);
        if (!weapon) return;
        this.sim.selectWeapon(weapon.id);
      },
      onFire: () => {
        this.sim.fire();
      },
      onCycleMap: () => {
        if (!this.sim.getActiveWormId()) return;
        const next = nextId(this.mapId);
        this.scene.restart({ mapId: next });
      },
      onWalk: (dir) => this.sim.walk(dir),
      onJump: () => this.sim.jump(),
      onBackflip: () => this.sim.backflip(),
      onAimAngleChange: (rad) => this.sim.setAimAngle(rad),
      onAimPowerChange: (p) => this.sim.setAimPower(p),
    });

    // Touch + HUDs are scene-owned and identical across modes.
    this.touchControls = new TouchControls({
      scene: this,
      getActiveWorm: () => this.getActiveWormAdapter(),
      ropeEnabled: !this.isNetworked,
      jetPackEnabled: true,
    });
    this.weaponRadial = new WeaponRadial({
      scene: this,
      sim: this.sim,
      getSelectedWeaponId: () => this.getSelectedWeaponId(),
      getAmmoFor: (id) => this.getAmmoFor(id),
    });
    this.aimHUD = new AimHUD({
      scene: this,
      getActiveWorm: () => this.getActiveWormAdapter(),
      isInputAllowed: () => this.isInputAllowed(),
    });
    this.turnHUD = new TurnHUD({
      scene: this,
      onEndTurnPressed: () => this.sim.endTurn(),
    });

    // Utility d-pad: always mounted in both modes. Networked mode routes
    // through the sim adapter (sends to server); offline routes to the
    // local worm directly. Down button stays offline-only (rope extend).
    this.utilityDPad = new UtilityDPad({
      scene: this,
      onLeft: (dir) => this.sim.setJetPackHorizontal(dir),
      onUp: (active) => this.sim.setJetPackThrust(active),
      onDown: (_active) => {
        if (this.offlineSim) this.dispatchUtilityDown(_active);
      },
    });

    // Replay the current turn so the HUD + input gates are correctly
    // primed. Offline mode's TurnManager.start() fires its onTurnStart
    // synchronously during adapter construction, before our subscribers
    // are attached - so we manually pull the current state here.
    const initialTeamId = this.sim.getActiveTeamId();
    const initialWormId = this.sim.getActiveWormId();
    if (initialTeamId) {
      this.handleTurnChanged(initialTeamId, initialWormId);
    }
    // Initial inputAllowed is "true" offline (local player drives every turn)
    // and "am I the active team's owner?" networked.
    const initialAllowed = this.offlineSim
      ? this.offlineSim.isInputAllowed()
      : this.networkedSim
        ? initialTeamId === this.myTeamId && this.myTeamId !== ""
        : false;
    this.inputController.setInputAllowed(initialAllowed);
    this.turnHUD.setEndTurnEnabled(initialAllowed);

    // Networked-only UI (spectator banner + reconnect + room listeners).
    if (this.isNetworked && this.room) {
      this.wireNetworkedScene();
    }

    // Wind HUD and water renderer (both modes). Use the canonical world
    // dims - not this.scale.width, which is the viewport, not the world.
    const sceneWidthPx = this.serverWidthPx ?? WORLD_WIDTH_PX;
    const sceneHeightPx = this.serverHeightPx ?? WORLD_HEIGHT_PX;
    this.windHUD = new WindHUD({ scene: this, sim: this.sim });
    this.waterRenderer = new WaterRenderer({
      scene: this,
      sim: this.sim,
      widthPx: sceneWidthPx,
      heightPx: sceneHeightPx,
    });

    // Camera: constrain scroll to the world bounds so the camera never shows
    // blank space outside the terrain. The camera will follow the active worm
    // once handleTurnChanged fires.
    this.cameras.main.setBounds(0, 0, sceneWidthPx, sceneHeightPx);

    this.cameraFollower = new CameraFollower({ scene: this });

    this.turnTransition = new TurnTransition({
      scene: this,
      sim: this.sim,
      worldWidthPx: sceneWidthPx,
      worldHeightPx: sceneHeightPx,
      resolveFollowTarget: (wormId) => {
        if (this.offlineSim) {
          const w = this.offlineSim.wormsInternal.find((worm) => worm.name === wormId);
          return w?.graphicsObject ?? null;
        }
        return this.wormSprites.get(wormId)?.graphics ?? null;
      },
      onTransitioningChanged: (t) => {
        this.inputController?.setTransitioning(t);
        this.cameraFollower?.setSuspended(t);
      },
      onActiveWormResolved: (target) => {
        this.cameraFollower?.setActiveWormTarget(target);
      },
    });

    this.debugGfx = this.add.graphics();
    this.debugGfx.setDepth(10);
    this.hud = this.add
      .text(12, 12, "", {
        fontSize: "14px",
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
      })
      .setDepth(20);

    this.wirePointerInput();

    void mountTuningPanel(() => {
      // Tuning panel gravity edit only affects offline; networked sim gravity
      // lives on the server and is immutable from the client.
      if (this.offlineSim) {
        this.offlineSim.wormsInternal[0]?.body.getWorld().setGravity({
          x: 0,
          y: tuning.world.gravityY,
        });
      }
    });
  }

  update(_time: number, deltaMs: number): void {
    this.sim.update(deltaMs);
    this.renderFromAdapter();
    this.inputController.update(deltaMs);
    this.turnHUD.update(this.sim.getTurnSecondsRemaining());
    this.weaponRadial.update();
    this.aimHUD.update();
    this.windHUD?.update();
    this.waterRenderer?.update();
    this.refreshUtilityDPad();
    const selectedId = this.getSelectedWeaponId();
    const weapon = allWeapons().find((w) => w.id === selectedId);
    const bodies = this.offlineSim?.terrain.bodyCount() ?? 0;
    this.hud.setText(`weapon: ${weapon?.name ?? "-"}  bodies: ${bodies}`);
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  private renderFromAdapter(): void {
    if (this.networkedSim) {
      this.renderNetworkedWorms();
      this.renderNetworkedProjectiles();
      // Feed networked projectile entries to CameraFollower each frame.
      if (this.cameraFollower) {
        const entries: Array<{ id: string; gfx: Phaser.GameObjects.GameObject }> = [];
        for (const [id, gfx] of this.projectileGraphics) {
          entries.push({ id, gfx });
        }
        this.cameraFollower.update(entries);
      }
    } else if (this.offlineSim && this.cameraFollower) {
      // Offline: projectile graphics are managed by ProjectileManager.
      this.cameraFollower.update(this.offlineSim.getProjectilesWithGfx());
    }
    // Offline: Worm.update draws each worm's own sprite + HUD text. Nothing
    // to do at the scene level for worm rendering.
  }

  private renderNetworkedWorms(): void {
    if (!this.networkedSim) return;
    const activeWormId = this.networkedSim.getActiveWormId();
    for (const w of this.networkedSim.allWorms) {
      const sprite = this.wormSprites.get(w.id);
      if (!sprite) continue;
      sprite.setActive(w.id === activeWormId);
      sprite.render(w);
    }
  }

  private renderNetworkedProjectiles(): void {
    if (!this.networkedSim) return;
    const projs = this.networkedSim.getProjectiles();
    const live = new Set<string>();
    for (const p of projs) {
      live.add(p.id);
      let g = this.projectileGraphics.get(p.id);
      if (!g) {
        g = this.add.graphics();
        g.setDepth(8);
        g.fillStyle(0xffffff, 1);
        g.fillCircle(0, 0, 5);
        this.projectileGraphics.set(p.id, g);
      }
      g.setPosition(p.xPx, p.yPx);
    }
    // Destroy any stale graphics (projectile no longer in server state).
    for (const [id, g] of this.projectileGraphics) {
      if (!live.has(id)) {
        g.destroy();
        this.projectileGraphics.delete(id);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Event hooks (expanded in commit 8 for VFX; minimal plumbing here).
  // ---------------------------------------------------------------------------

  private handleSimEvent(ev: SimEvent): void {
    switch (ev.type) {
      case "terrain_cut":
        // Visual mask cut (networked mode only; offline mode cuts the
        // bodies-aware Terrain directly inside OfflineSimAdapter).
        this.terrainRenderer?.cutCircle(ev.x, ev.y, ev.r, ev.seq);
        // Small camera shake on large cuts. Radius 20+ counts as "big".
        if (ev.r >= 20) {
          this.cameras.main.shake(120, 0.003);
        }
        return;
      case "fire_event":
        // Brief camera shake for the fire muzzle. Keeps a weight of feedback
        // since projectile sprites only render after the next sim_state.
        this.cameras.main.shake(60, 0.0015);
        return;
      case "damage_event": {
        // Floating damage number at the impact point.
        this.spawnDamageNumber(ev.impact.x, ev.impact.y, ev.amount);
        // Flash the worm's sprite red if we have one (networked path).
        const sprite = this.wormSprites.get(ev.wormId);
        if (sprite) {
          this.tweens.killTweensOf(sprite.graphics);
          sprite.graphics.setAlpha(1);
          this.tweens.add({
            targets: sprite.graphics,
            alpha: { from: 1, to: 0.3 },
            yoyo: true,
            duration: 150,
            repeat: 1,
          });
        }
        return;
      }
      case "worm_died": {
        // Fade the worm's sprite down (networked path). Offline path uses
        // Worm.applyPendingDamage which fades locally.
        const sprite = this.wormSprites.get(ev.wormId);
        if (sprite) {
          this.tweens.killTweensOf(sprite.graphics);
          this.tweens.add({
            targets: sprite.graphics,
            alpha: { from: sprite.graphics.alpha, to: 0.2 },
            duration: 300,
          });
        }
        this.cameras.main.shake(80, 0.002);
        return;
      }
    }
  }

  /**
   * Transient damage-number text that floats up and fades. Spawned by
   * damage_event. Auto-destroys after the tween completes.
   */
  private spawnDamageNumber(xPx: number, yPx: number, amount: number): void {
    if (amount <= 0) return;
    const txt = this.add
      .text(xPx, yPx, `-${amount}`, {
        fontSize: "18px",
        fontFamily: "monospace",
        color: "#ff4444",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5, 1)
      .setDepth(50);
    this.tweens.add({
      targets: txt,
      y: yPx - 30,
      alpha: { from: 1, to: 0 },
      duration: 800,
      ease: "Quad.easeOut",
      onComplete: () => txt.destroy(),
    });
  }

  private handleGameOver(winnerTeamId: string | null): void {
    this.turnTransition?.cancel();
    this.inputController?.setInputAllowed(false);
    this.turnHUD?.setEndTurnEnabled(false);
    this.spectatorHUD?.hide();
    const winner = this.sim.teams.find((t) => t.id === winnerTeamId) ?? null;
    this.turnHUD?.showGameOver(winner?.name ?? null);
    if (this.isNetworked) this.showReturnToLobbyControl();
  }

  /**
   * After game_over in networked mode, show a "Back to lobby" affordance:
   * the host sees a clickable button that sends input_return_to_lobby;
   * non-host players see a waiting line. Phase transition back to LobbyScene
   * is driven by the server's state broadcast (handled elsewhere).
   */
  private showReturnToLobbyControl(): void {
    if (!this.room) return;
    const mySid = this.mySessionId;
    const me = mySid ? this.room.state?.players?.[mySid] : undefined;
    const iAmHost = !!me?.isHost;
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2 + 60;

    if (!iAmHost) {
      const waitText = this.add
        .text(cx, cy, "Waiting for host to return to lobby...", {
          fontSize: "16px",
          color: "#ffffff",
          fontFamily: "system-ui, sans-serif",
          stroke: "#000000",
          strokeThickness: 2,
        })
        .setOrigin(0.5)
        .setDepth(200)
        .setScrollFactor(0);
      this.returnToLobbyObjects.push(waitText);
      return;
    }

    const gfx = this.add.graphics().setDepth(200).setScrollFactor(0);
    gfx.fillStyle(0x2266cc, 1);
    gfx.fillRoundedRect(cx - 110, cy - 22, 220, 44, 8);
    gfx.lineStyle(2, 0x88aaff, 1);
    gfx.strokeRoundedRect(cx - 110, cy - 22, 220, 44, 8);
    const btnText = this.add
      .text(cx, cy, "Back to lobby", {
        fontSize: "18px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 2,
      })
      .setOrigin(0.5)
      .setDepth(201)
      .setScrollFactor(0);
    const hit = this.add.zone(cx, cy, 220, 44).setOrigin(0.5).setScrollFactor(0).setInteractive();
    hit.on("pointerdown", () => {
      this.room?.send({ type: "input_return_to_lobby", seq: 0 });
    });
    this.returnToLobbyObjects.push(gfx, btnText, hit);
  }

  private handleTurnChanged(teamId: string, _wormId: string): void {
    dlogUnthrottled("scene", "GameScene.handleTurnChanged", { teamId, wormId: _wormId });
    if (!teamId) return;
    const team = this.sim.teams.find((t) => t.id === teamId);
    if (team) this.turnHUD?.showTurnBanner(team.name, team.color);
    this.refreshSpectatorBanner();
    // Networked mode: update inputAllowed based on team ownership.
    if (this.networkedSim) {
      const active = teamId === this.myTeamId && this.myTeamId !== "";
      this.networkedSim.setActive(active);
    }
    // Sync active worm for InputController.
    if (this.offlineSim) {
      const activeWorm = this.offlineSim.wormsInternal.find((w) => w.name === _wormId);
      if (activeWorm) this.inputController?.setActiveWorm(activeWorm);
    } else if (this.networkedSim) {
      // Wrap the render view in a facade so InputController has something
      // to read xPx / facing / aimAngle from. The facade's mutator methods
      // are no-ops because the on* callbacks drive the actual wire sends.
      const view = this.networkedSim.allWorms.find((w) => w.id === _wormId);
      this.inputController?.setActiveWorm(
        view ? adaptRenderableToWormFacade(view, () => this.sim.isJetPacking(), this.sim) : null,
      );
    }
    // Delegate camera follow to TurnTransition for zoom-out/hold/zoom-in animation.
    this.turnTransition?.begin(teamId, _wormId);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private buildAdapterTeams(
    init: NetTeamInit[] | undefined,
  ): Array<{ id: string; name: string; color: number; wormNames: string[] }> {
    if (init && init.length > 0) {
      return init.map((t) => ({
        id: t.id,
        name: t.name,
        color: parseTeamColor(t.color),
        wormNames: t.wormNames,
      }));
    }
    // Offline fallback: Epic 7 red + blue with default worm names.
    const wormsPerTeam = tuning.team.wormsPerTeam;
    const mkNames = (prefix: string) =>
      Array.from({ length: wormsPerTeam }, (_, i) => `${prefix}-${i + 1}`);
    return [
      { id: "red", name: "Red", color: 0xff4444, wormNames: mkNames("red") },
      { id: "blue", name: "Blue", color: 0x4488ff, wormNames: mkNames("blue") },
    ];
  }

  /**
   * Return a worm-shaped handle for callers that need xPx/yPx + facing,
   * primarily TouchControls and AimHUD. Offline mode returns the live Worm
   * instance; networked mode synthesizes a lightweight view from the
   * adapter's active RenderableWorm so the same callers work.
   */
  private getActiveWormAdapter(): Worm | null {
    if (this.offlineSim) {
      return this.offlineSim.turns.getActiveWorm();
    }
    if (this.networkedSim) {
      const id = this.networkedSim.getActiveWormId();
      const view = this.networkedSim.allWorms.find((w) => w.id === id);
      if (!view || !view.isAlive) return null;
      return adaptRenderableToWormFacade(view, () => this.sim.isJetPacking(), this.sim);
    }
    return null;
  }

  /** Show the d-pad when the active worm has a utility engaged, hide when idle.
   *  Works in both offline and networked mode. Runs every frame from `update`. */
  private refreshUtilityDPad(): void {
    if (!this.utilityDPad) return;
    const isJetPacking = this.sim.isJetPacking();
    const isRoped = this.offlineSim ? !!this.offlineSim.turns.getActiveWorm()?.isRoped() : false;
    const active = isJetPacking || isRoped;
    if (active && !this.utilityDPadVisible) {
      this.utilityDPad.show();
      this.utilityDPadVisible = true;
    } else if (!active && this.utilityDPadVisible) {
      this.utilityDPad.hide();
      this.utilityDPadVisible = false;
    }
  }

  /** Down-button: rope extend only (jetpack has no "down"). */
  private dispatchUtilityDown(active: boolean): void {
    if (!this.offlineSim) return;
    const worm = this.offlineSim.turns.getActiveWorm();
    if (!worm) return;
    if (worm.isRoped() && active) {
      const rate = tuning.rope.adjustRateMps / 60;
      worm.ropeUtility.adjust(+rate);
    }
  }

  private getAmmoFor(id: string): number {
    if (this.offlineSim) {
      const team = this.offlineSim.turns.getActiveTeam();
      return this.offlineSim.getWeaponManager(team)?.ammoFor(id) ?? 0;
    }
    if (this.networkedSim) {
      // Networked mode reads authoritative ammo out of the active worm's
      // sim_state entry. Until W1 ships, expose the match-default so the
      // drawer still renders ammo numbers in dev.
      const defaults = defaultAmmoForMatch();
      return defaults[id] ?? 0;
    }
    return 0;
  }

  private getSelectedWeaponId(): string {
    return this.sim.getActiveWeaponId() || allWeapons()[0]?.id || "";
  }

  private isInputAllowed(): boolean {
    if (this.offlineSim) return this.offlineSim.turns.isInputAllowed();
    if (this.networkedSim) return this.networkedSim.isInputAllowed();
    return false;
  }

  // ---------------------------------------------------------------------------
  // Networked-only wiring (spectator banner + reconnect loop + room listeners).
  // ---------------------------------------------------------------------------

  private wireNetworkedScene(): void {
    if (!this.room) return;

    const mine = this.teamsInit?.find((t) => t.ownerSessionId === this.mySessionId);
    this.myTeamId = mine?.id ?? "";

    this.spectatorHUD = new SpectatorHUD({ scene: this });
    this.refreshSpectatorBanner();

    this.currentRoomCode = this.room.state?.code ?? "";

    this.roomUnsubs.push(
      this.room.onClose((code) => {
        if (code === 1000) return;
        void this.startReconnectionLoop();
      }),
    );

    // Phase change: if the server flips back to "lobby" (after host presses
    // Back to lobby from the game-over overlay), return to LobbyScene with
    // the existing room handle so players re-ready in place.
    //
    // CRITICAL: self-unsubscribe after the first lobby-phase hit. Without
    // this, every subsequent state change (e.g. the non-host readying up
    // in the rematch lobby) retriggers scene.start("LobbyScene") because
    // the transition is async and state keeps flowing. That produced a
    // freeze on rematch-ready.
    let phaseSub: (() => void) | null = null;
    phaseSub = this.room.onStateChange((state) => {
      dlogUnthrottled("scene", "GameScene.phaseObserved", { phase: state.phase });
      if (state.phase !== "lobby") return;
      dlogUnthrottled("scene", "GameScene.phaseSub fired", { phase: state.phase });
      phaseSub?.();
      phaseSub = null;
      dlogUnthrottled("scene", "GameScene -> LobbyScene transition", { reason: "phase=lobby" });
      this.scene.start("LobbyScene", { netClient: this.netClient, room: this.room });
    });
    this.roomUnsubs.push(() => phaseSub?.());

    this.disconnectTick = this.time.addEvent({
      delay: 250,
      loop: true,
      callback: () => this.refreshSpectatorBanner(),
    });
  }

  private refreshSpectatorBanner(): void {
    if (!this.spectatorHUD || !this.room) return;
    const activeTeamId = this.sim.getActiveTeamId();
    if (!activeTeamId) {
      this.spectatorHUD.hide();
      return;
    }
    const team = this.teamsInit?.find((t) => t.id === activeTeamId);
    const ownerSessionId = team?.ownerSessionId ?? "";
    const ownerPlayer = ownerSessionId ? this.room.state.players[ownerSessionId] : undefined;
    const ownerName = ownerPlayer?.nickname ?? team?.name ?? activeTeamId;
    if (ownerPlayer?.disconnected) {
      const graceEndsAt = ownerPlayer.disconnectGraceEndsAt ?? 0;
      const remainingSec = Math.max(0, Math.ceil((graceEndsAt - Date.now()) / 1000));
      this.spectatorHUD.show(`${ownerName} (disconnected, ${remainingSec}s)`);
      return;
    }
    if (activeTeamId === this.myTeamId) {
      this.spectatorHUD.hide();
      return;
    }
    this.spectatorHUD.show(`Waiting for ${ownerName}...`);
  }

  private async startReconnectionLoop(): Promise<void> {
    if (this.reconnectInFlight) return;
    if (!this.netClient) {
      this.scene.start("LobbyScene");
      return;
    }
    this.reconnectInFlight = true;
    const code = this.currentRoomCode;
    const stored = code ? readRoomToken(code) : null;
    if (!stored) {
      this.reconnectInFlight = false;
      this.scene.start("LobbyScene", { netClient: this.netClient, autoJoinCode: null });
      return;
    }
    const overlay = this.ensureOverlay();
    overlay.show(1);
    const result = await runReconnectLoop({
      netClient: this.netClient,
      code,
      nickname: "player",
      color: "#ff4444",
      resumeToken: stored.resumeToken,
      onAttempt: (n) => overlay.show(n),
    });
    if (result.ok && result.room) {
      saveRoomToken(code, result.room.resumeToken);
      overlay.hide();
      this.reconnectInFlight = false;
      this.scene.restart({
        mapId: this.mapId,
        seed: this.seedOverride,
        teams: this.teamsInit,
        room: result.room,
        netClient: this.netClient,
      });
      return;
    }
    overlay.showFinal("Lost connection. Returning home.");
    if (code) clearRoomToken(code);
    this.time.delayedCall(2000, () => {
      overlay.hide();
      this.reconnectInFlight = false;
      this.scene.start("LobbyScene", { netClient: this.netClient, autoJoinCode: null });
    });
  }

  private ensureOverlay(): ReconnectingOverlay {
    if (!this.reconnectingOverlay) {
      this.reconnectingOverlay = new ReconnectingOverlay({ scene: this });
    }
    return this.reconnectingOverlay;
  }

  private tearDownRoomListeners(): void {
    for (const unsub of this.roomUnsubs) {
      try {
        unsub();
      } catch {
        // already torn down
      }
    }
    this.roomUnsubs = [];
  }

  // ---------------------------------------------------------------------------
  // Pointer input (drag-to-aim) - routes through adapter, no local side effect.
  // ---------------------------------------------------------------------------

  private wirePointerInput(): void {
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      // Button hit-tests first: the drawer / HUDs / touch controls own their
      // own pointerdown handlers, so the scene-level gesture layer gates on
      // them to avoid double-triggering.
      if (this.turnHUD.hitsButton(p)) return;
      if (this.touchControls.hitsButton(p)) return;
      if (this.weaponRadial?.hitsRadial(p)) return;
      // Already tracking a gesture on a different pointer: ignore. Multi-touch
      // secondary fingers should route to buttons (above), not the gesture layer.
      if (this.activePointerId !== null) return;

      const worm = this.getActiveWormAdapter();
      const myTurn = this.isInputAllowed();
      const utilityActive = !!worm && (worm.isRoped() || worm.isJetPacking());
      // worldX/worldY are camera-adjusted pointer coords. We use these
      // throughout the gesture path so downXPx/downYPx are in the same
      // coord system as worm.xPx/worm.yPx (world) - the on-worm hit test
      // and drag-to-aim math depend on both being in the same system.
      const input: GestureInput = {
        downXPx: p.worldX,
        downYPx: p.worldY,
        nowMs: Date.now(),
        screenWidth: this.scale.width,
        wormXPx: worm?.xPx ?? null,
        wormYPx: worm?.yPx ?? null,
        myTurn,
        utilityActive,
        wormHitRadiusPx: tuning.touch.wormHitRadiusPx,
        doubleTapMaxMs: tuning.touch.doubleTapMaxMs,
        longPressMs: tuning.touch.longPressMs,
      };
      const outcomes = this.gestureTracker.processDown(input);
      for (const o of outcomes) {
        if (o.kind === "aim_start") {
          this.activeGestureKind = "aim";
          this.activePointerId = p.id;
          this.aimDragStart = { x: o.xPx, y: o.yPx };
        } else if (o.kind === "walk") {
          this.activeGestureKind = "walk";
          this.activePointerId = p.id;
          // Face the side being walked so offline mode's setFacing gate does
          // not fight the walk. Networked mode server handles facing from the
          // walk message directly.
          this.sim.setFacing(o.dir);
          this.sim.walk(o.dir);
        }
        // "ignored": no-op. pointermove / pointerup for this pointer won't
        // match activePointerId (null), so they short-circuit.
      }
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (p.id !== this.activePointerId) return;
      if (this.activeGestureKind !== "aim") return;
      const worm = this.getActiveWormAdapter();
      if (!worm || !this.isInputAllowed()) return;
      // Existing drag-to-aim math: vector from pointer to worm sets angle,
      // distance (capped) sets power. Facing flips when dragging across the
      // worm's center. Pointer coords must be worldX/worldY so they share
      // the same space as worm.xPx/worm.yPx once the camera has scrolled.
      const dx = worm.xPx - p.worldX;
      const dy = worm.yPx - p.worldY;
      const mag = Math.hypot(dx, dy);
      const cap = tuning.weapons.dragMaxLengthPx;
      const power = Math.min(1, mag / cap);
      const rawAngle = Math.atan2(dy, dx);
      const facingDot = Math.cos(rawAngle) * worm.facing;
      if (facingDot < 0) {
        this.sim.setFacing(-worm.facing as -1 | 1);
      }
      const aimRad = Math.atan2(dy, Math.abs(dx));
      this.sim.setAimAngle(aimRad);
      this.sim.setAimPower(power);
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (p.id !== this.activePointerId) return;
      const gestureKind = this.activeGestureKind;
      const aimStart = this.aimDragStart;
      // Reset per-pointer state BEFORE dispatching so the next gesture starts
      // clean, even if a handler below throws.
      this.activeGestureKind = null;
      this.activePointerId = null;
      this.aimDragStart = null;

      const outcomes = this.gestureTracker.processUp(Date.now());
      for (const o of outcomes) {
        if (o.kind === "aim_end") {
          // Fire-on-release, gated by the dead-zone so a stray tap doesn't
          // fire a zero-power shot.
          if (!aimStart) continue;
          // aimStart is in world coords (see pointerdown path), so compare
          // against worldX/worldY for a consistent drag distance check.
          const dragDist = Math.hypot(p.worldX - aimStart.x, p.worldY - aimStart.y);
          if (dragDist < tuning.weapons.dragDeadZonePx) continue;
          this.sim.fire();
        } else if (o.kind === "walk_release") {
          this.sim.walk(0);
        } else if (o.kind === "jump") {
          this.sim.jump();
        } else if (o.kind === "backflip") {
          this.sim.backflip();
        }
      }
      void gestureKind; // retained for future metrics / debug.
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTeamColor(input: string | number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const hex = input.startsWith("#") ? input.slice(1) : input;
    const parsed = Number.parseInt(hex, 16);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0xaaaaaa;
}

/**
 * Tiny read-only facade that lets TouchControls / AimHUD / InputController
 * call `worm.xPx`, `worm.yPx`, `worm.facing` in networked mode without
 * carrying around a full Worm (which would demand a planck body).
 *
 * Mutator methods (walk, jump, etc.) are no-ops: the real input path in
 * networked mode goes InputController -> onWalk callback ->
 * sim.walk() -> room.send(). Direct worm.walk() is never used here.
 *
 * Rope + JetPack utilities are stubbed to "inactive" shapes so the
 * InputController's `worm.isRoped()` / `isJetPacking()` guards short-
 * circuit correctly (networked mode disables both per plan #65).
 *
 * Returned as `Worm` (cast) because the existing TouchControls + AimHUD
 * + InputController signatures type their worm params as `Worm`. The
 * only fields they read are covered by this facade.
 */
function adaptRenderableToWormFacade(
  view: RenderableWorm,
  isJetPackingFn?: () => boolean,
  simRef?: SimAdapter,
): Worm {
  const stubUtility = {
    isActive: () => false,
    activate: () => {},
    deactivate: () => {},
    update: () => {},
    destroy: () => {},
    adjust: () => {},
    setHorizontalInput: () => {},
    setVerticalInput: () => {},
    getFuel: () => 0,
  };
  const jetPackUtility = simRef
    ? {
        ...stubUtility,
        setHorizontalInput: (dir: -1 | 0 | 1) => simRef.setJetPackHorizontal(dir),
        setVerticalInput: (active: boolean) => simRef.setJetPackThrust(active),
      }
    : stubUtility;
  const facade = {
    get xPx() {
      return view.xPx;
    },
    get yPx() {
      return view.yPx;
    },
    get facing() {
      return view.facing;
    },
    get aimAngle() {
      return view.aimAngle;
    },
    get aimPower01() {
      return view.aimPower;
    },
    get isAlive() {
      return view.isAlive;
    },
    get name() {
      return view.name;
    },
    get team(): Team {
      return view.team;
    },
    get health() {
      return view.hp;
    },
    ropeUtility: stubUtility,
    jetPackUtility,
    // Input-method stubs: adapter-routed callbacks drive the wire sends.
    walk: (_dir: -1 | 0 | 1) => {
      void _dir;
    },
    jump: () => {},
    backflip: () => {},
    aim: (_d: -1 | 0 | 1) => {
      void _d;
    },
    setAimAngle: (_r: number) => {
      void _r;
    },
    setAimPower: (_p: number) => {
      void _p;
    },
    nudgeAimPower: (_d: number) => {
      void _d;
    },
    setFacing: (_dir: -1 | 1) => {
      void _dir;
    },
    isRoped: () => false,
    isJetPacking: isJetPackingFn ?? (() => false),
    setActive: (_b: boolean) => {
      void _b;
    },
  } as unknown as Worm;
  return facade;
}

/**
 * Decode the server's base64 1-bit-packed mask into an HTMLCanvasElement
 * with alpha set (solid) or cleared (air). RGB is left as opaque white here;
 * TerrainRenderer's stratum painter overwrites the RGB in a post-pass.
 *
 * Wire format (as of Phase 1): 1-bit-per-pixel packed (LSB-first), base64.
 * So the decoded Uint8Array is packed bytes; unpackMask expands to one byte
 * per pixel for canvas painting.
 */
function decodeServerMaskToCanvas(
  base64: string,
  widthPx: number,
  heightPx: number,
): HTMLCanvasElement {
  const raw = atob(base64);
  const packed = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) packed[i] = raw.charCodeAt(i);

  // Expand packed bits back to one-byte-per-pixel.
  const pixelCount = widthPx * heightPx;
  const bytes = unpackMask(packed, pixelCount);

  const canvas = document.createElement("canvas");
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("decodeServerMaskToCanvas: no 2d context");

  // Paint solid pixels opaque (RGB will be overwritten by stratum pass).
  // Air pixels stay transparent so destruction (destination-out) works.
  const img = ctx.createImageData(widthPx, heightPx);
  for (let i = 0; i < pixelCount; i++) {
    const j = i * 4;
    if (bytes[i]) {
      img.data[j] = 0xff;
      img.data[j + 1] = 0xff;
      img.data[j + 2] = 0xff;
      img.data[j + 3] = 0xff;
    }
    // else: leave transparent (air).
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}
