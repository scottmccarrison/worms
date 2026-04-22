import * as Phaser from "phaser";
import { mountTuningPanel, registerMapCycleFn } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { loadMap } from "../maps/loadMap";
import { firstId, getById, nextId } from "../maps/registry";
import type { NetClient } from "../net/client";
import { clearRoomToken, readRoomToken, saveRoomToken } from "../net/clientStorage";
import { runReconnectLoop } from "../net/reconnectLoop";
import type { ClientMsg, TeamInit as NetTeamInit } from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { NetworkedSimAdapter } from "../sim/NetworkedSimAdapter";
import { OfflineSimAdapter } from "../sim/OfflineSimAdapter";
import type { RenderableWorm, SimAdapter, SimEvent } from "../sim/SimAdapter";
import { TerrainRenderer } from "../terrain/TerrainRenderer";
import { tuning } from "../tuning";
import { AimHUD } from "../ui/AimHUD";
import { ReconnectingOverlay } from "../ui/ReconnectingOverlay";
import { SpectatorHUD } from "../ui/SpectatorHUD";
import { TouchControls } from "../ui/TouchControls";
import { TurnHUD } from "../ui/TurnHUD";
import { WeaponDrawer } from "../ui/WeaponDrawer";
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

  // ---- Scene-level UI (same for both modes) ----
  private debugGfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private inputController!: InputController;
  private touchControls!: TouchControls;
  private turnHUD!: TurnHUD;
  private spectatorHUD: SpectatorHUD | null = null;
  private weaponDrawer!: WeaponDrawer;
  private aimHUD!: AimHUD;

  // ---- Drag-to-aim state (primary pointer only) ----
  private dragStart: { x: number; y: number } | null = null;
  private dragPointerId: number | null = null;

  // ---- Init-time data ----
  private mapId: string = firstId();
  private seedOverride: number | undefined;
  private teamsInit: NetTeamInit[] | undefined;
  private room: RoomHandle | undefined;
  private netClient: NetClient | undefined;
  private isNetworked = false;
  private mySessionId = "";
  private myTeamId = "";

  // ---- Networked-mode: monotonic ids for server-spawned projectiles ----

  // ---- Reconnect + disconnected-owner overlay (networked mode only) ----
  private reconnectingOverlay: ReconnectingOverlay | null = null;
  private reconnectInFlight = false;
  private currentRoomCode = "";
  private disconnectTick: Phaser.Time.TimerEvent | null = null;
  private roomUnsubs: Array<() => void> = [];

  // ---- Offline-mode WeaponManager map (built per-team) ----
  // Networked mode: ammo + select state arrive via sim_state.worms[].ammoLeft.
  // This map is only present in offline mode so the weapon drawer UI can
  // read authoritative ammo counts.

  // ---- Drag-to-aim throttle (networked mode only) ----
  private lastAimSendMs = 0;
  private pendingAim: { angleRad: number; power: number } | null = null;

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
  }): void {
    const candidate = data?.mapId ?? this.readMapQueryParam() ?? tuning.maps.defaultId ?? firstId();
    this.mapId = getById(candidate) ? candidate : firstId();
    this.seedOverride = data?.seed;
    this.teamsInit = data?.teams;
    this.room = data?.room;
    this.netClient = data?.netClient;
    this.isNetworked = !!this.room;
    this.mySessionId = this.room?.sessionId ?? "";
    registerMapCycleFn((id: string) => {
      this.scene.restart({ mapId: id });
    });
  }

  private readMapQueryParam(): string | null {
    const url = new URL(window.location.href);
    return url.searchParams.get("map");
  }

  create(): void {
    const loaded = loadMap(this.mapId, this.scale.width, this.scale.height, this.seedOverride);

    // Build the team roster once; both adapters use the same shape.
    const teamsForAdapter = this.buildAdapterTeams(this.teamsInit);

    // ------------------------------------------------------------------
    // Pick the adapter. Everything sim-related flows through it.
    // ------------------------------------------------------------------
    if (this.isNetworked && this.room) {
      // Networked path: server owns the sim. Scene owns the visual terrain.
      this.terrainRenderer = new TerrainRenderer({
        scene: this,
        widthPx: this.scale.width,
        heightPx: this.scale.height,
        sourceMask: loaded.mask,
      });
      this.networkedSim = new NetworkedSimAdapter({
        room: this.room,
        teams: this.teamsInit ?? [],
      });
      this.sim = this.networkedSim;
    } else {
      // Offline path: adapter owns everything physics-touching.
      this.offlineSim = new OfflineSimAdapter({
        scene: this,
        loaded,
        widthPx: this.scale.width,
        heightPx: this.scale.height,
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

    // Event + game-over subscriptions (both modes).
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
      this.weaponDrawer?.destroy();
      this.aimHUD?.destroy();
      this.spectatorHUD?.destroy();
      this.reconnectingOverlay?.destroy();
      this.reconnectingOverlay = null;
      this.disconnectTick?.remove(false);
      this.disconnectTick = null;
      this.terrainRenderer?.destroy();
      this.terrainRenderer = null;
      this.tearDownRoomListeners();
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
    });
    this.weaponDrawer = new WeaponDrawer({
      scene: this,
      weapons: allWeapons(),
      onSelect: (id) => this.sim.selectWeapon(id),
      getAmmo: (id) => this.getAmmoFor(id),
      getSelectedId: () => this.getSelectedWeaponId(),
      getTeamColor: () => this.getActiveTeamColor(),
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

    // Networked-only UI (spectator banner + reconnect + room listeners).
    if (this.isNetworked && this.room) {
      this.wireNetworkedScene();
    }

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
    this.weaponDrawer.update();
    this.aimHUD.update();
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
    // Commit 8 fleshes this out (terrain_cut -> TerrainRenderer.cutCircle,
    // damage_event -> flash + number, worm_died -> death animation, etc.).
    // Here we wire the minimal terrain_cut path so server cuts show up.
    if (ev.type === "terrain_cut" && this.terrainRenderer) {
      this.terrainRenderer.cutCircle(ev.x, ev.y, ev.r, ev.seq);
    }
  }

  private handleGameOver(winnerTeamId: string | null): void {
    this.inputController?.setInputAllowed(false);
    this.turnHUD?.setEndTurnEnabled(false);
    this.spectatorHUD?.hide();
    const winner = this.sim.teams.find((t) => t.id === winnerTeamId) ?? null;
    this.turnHUD?.showGameOver(winner?.name ?? null);
  }

  private handleTurnChanged(teamId: string, _wormId: string): void {
    if (!teamId) return;
    const team = this.sim.teams.find((t) => t.id === teamId);
    if (team) this.turnHUD?.showTurnBanner(team.name, team.color);
    this.refreshSpectatorBanner();
    // Networked mode: update inputAllowed based on team ownership.
    if (this.networkedSim) {
      const active = teamId === this.myTeamId && this.myTeamId !== "";
      this.networkedSim.setActive(active);
    }
    // Sync active worm for InputController when we have its internal list
    // (offline only). Networked mode doesn't need a Worm handle since
    // input methods go through the adapter.
    if (this.offlineSim) {
      const activeWorm = this.offlineSim.wormsInternal.find((w) => w.name === _wormId);
      if (activeWorm) this.inputController?.setActiveWorm(activeWorm);
    }
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
      return adaptRenderableToWormFacade(view);
    }
    return null;
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
    if (this.offlineSim) {
      const team = this.offlineSim.turns.getActiveTeam();
      return this.offlineSim.getWeaponManager(team)?.getSelected().id ?? "";
    }
    // Networked mode: until sim_state carries activeWeapon (W1), default to
    // the first registry entry so the drawer draws a selection.
    return allWeapons()[0]?.id ?? "";
  }

  private getActiveTeamColor(): number {
    const id = this.sim.getActiveTeamId();
    return this.sim.teams.find((t) => t.id === id)?.color ?? 0xffffff;
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
      if (this.turnHUD.hitsButton(p)) return;
      if (this.touchControls.hitsButton(p)) return;
      if (this.weaponDrawer.hitsIcon(p)) return;
      if (this.dragPointerId !== null) return;
      this.dragStart = { x: p.x, y: p.y };
      this.dragPointerId = p.id;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.dragStart || p.id !== this.dragPointerId) return;
      const worm = this.getActiveWormAdapter();
      if (!worm || !this.isInputAllowed()) return;
      const dx = worm.xPx - p.x;
      const dy = worm.yPx - p.y;
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
      if (this.isNetworked) {
        this.throttleAimBroadcast(aimRad, power);
      }
    });

    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.dragStart || p.id !== this.dragPointerId) return;
      const dragDist = Math.hypot(p.x - this.dragStart.x, p.y - this.dragStart.y);
      this.dragStart = null;
      this.dragPointerId = null;
      if (this.isNetworked) this.flushPendingAim();
      if (dragDist < tuning.weapons.dragDeadZonePx) return;
      this.sim.fire();
    });
  }

  /**
   * Drag-to-aim throttle. Pointermove fires up to 60Hz; we coalesce to
   * 20Hz on the network side so the socket doesn't flood. The last
   * pending value is flushed at pointerup so the fire event is preceded
   * by the exact aim state we released at.
   */
  private throttleAimBroadcast(angleRad: number, power: number): void {
    this.pendingAim = { angleRad, power };
    const now = Date.now();
    if (now - this.lastAimSendMs < 50) return;
    this.lastAimSendMs = now;
    this.sendInput({ type: "input_aim_angle", angleRad, seq: 0 });
    this.sendInput({ type: "input_aim_power", power, seq: 0 });
    this.pendingAim = null;
  }

  private flushPendingAim(): void {
    if (!this.pendingAim) return;
    const { angleRad, power } = this.pendingAim;
    this.pendingAim = null;
    this.sendInput({ type: "input_aim_angle", angleRad, seq: 0 });
    this.sendInput({ type: "input_aim_power", power, seq: 0 });
  }

  private sendInput(msg: ClientMsg): void {
    this.room?.send(msg);
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
 * Tiny read-only adapter that lets TouchControls / AimHUD call
 * `worm.xPx`, `worm.yPx`, `worm.facing` in networked mode without
 * carrying around a full Worm (which would demand a planck body).
 *
 * Returned as `Worm` (cast) because the existing TouchControls + AimHUD
 * signatures type `getActiveWorm` as `() => Worm | null`. Only the
 * read-only properties are accessed so the cast is safe at runtime.
 */
function adaptRenderableToWormFacade(view: RenderableWorm): Worm {
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
  } as unknown as Worm;
  return facade;
}
