import * as Phaser from "phaser";
import type { Contact } from "planck";
import type { ContactImpulse } from "planck";
import { mountTuningPanel, registerMapCycleFn } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { loadMap } from "../maps/loadMap";
import { firstId, getById, nextId } from "../maps/registry";
import type { NetClient } from "../net/client";
import { clearRoomToken, readRoomToken, saveRoomToken } from "../net/clientStorage";
import { runReconnectLoop } from "../net/reconnectLoop";
import type {
  CircleCut,
  ClientMsg,
  GameOverMessage,
  LobbyState,
  TeamInit as NetTeamInit,
  TurnResolvedMessage,
} from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { drawDebug } from "../rendering/debugDraw";
import { TurnManager } from "../state/TurnManager";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";
import { AimHUD } from "../ui/AimHUD";
import { ReconnectingOverlay } from "../ui/ReconnectingOverlay";
import { SpectatorHUD } from "../ui/SpectatorHUD";
import { TouchControls } from "../ui/TouchControls";
import { TurnHUD } from "../ui/TurnHUD";
import { WeaponDrawer } from "../ui/WeaponDrawer";
import { JetPack } from "../utilities/JetPack";
import { NinjaRope } from "../utilities/NinjaRope";
import { ProjectileManager } from "../weapons/ProjectileManager";
import { WeaponManager } from "../weapons/WeaponManager";
import { fire } from "../weapons/fire";
import { allWeapons, defaultAmmoForMatch } from "../weapons/registry";
import { Team } from "../worm/Team";
import { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import { fallDamageFromImpulse } from "../worm/fallDamage";
import { applyRemoteInput, buildTurnSnapshot, setWormFromSnapshot } from "./game/networkBridge";

export class GameScene extends Phaser.Scene {
  private physicsSystem!: PhysicsSystem;
  private terrain!: Terrain;
  private debugGfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;
  private allWorms: Worm[] = [];
  private teams: Team[] = [];
  private inputController!: InputController;
  private touchControls!: TouchControls;
  private turnManager!: TurnManager;
  private turnHUD!: TurnHUD;
  // Epic 9: spectator "Waiting for X..." banner. Only instantiated in networked mode.
  private spectatorHUD: SpectatorHUD | null = null;

  // Weapon system
  private projectileManager!: ProjectileManager;
  private weaponManagers!: Map<Team, WeaponManager>;
  private weaponDrawer!: WeaponDrawer;
  private aimHUD!: AimHUD;
  private shotsFiredThisTurn = 0;

  // Drag-to-aim state - tracked per primary pointer ID to block multitouch conflicts
  private dragStart: { x: number; y: number } | null = null;
  private dragPointerId: number | null = null;

  // Active map id - set in init() before create() runs
  private mapId: string = firstId();
  // Authoritative seed from the lobby host. Undefined means local/solo play
  // and loadMap falls back to its own default.
  private seedOverride: number | undefined;
  // Authoritative team roster from the lobby. Undefined falls back to the
  // hardcoded red/blue defaults that Epic 7 used for single-device play.
  private teamsInit: NetTeamInit[] | undefined;
  // Room reference stashed in init(). Drives all Epic 9/13 netcode;
  // undefined means single-device / ?offline=1 play (no network code runs).
  private room: RoomHandle | undefined;
  // NetClient reference - only present in networked mode. Used by the Epic
  // 10 reconnect loop to rebuild a RoomHandle after an unexpected drop.
  private netClient: NetClient | undefined;
  // True iff `room` is present. Cached so hot paths don't re-check every frame.
  private isNetworked = false;
  /** Last turn_resolved turnSeq we applied locally. Guards against duplicate
   *  messages double-cutting terrain. */
  private lastAppliedTurnSeq = 0;
  // Our sessionId when networked, "" otherwise.
  private mySessionId = "";
  // Team id owned by our sessionId (set in create() after teamsInit maps sessionIds
  // to team ids). Empty when spectating or offline.
  private myTeamId = "";
  // Client-monotonic input sequence number. Server does not rely on it for
  // ordering (WebSocket is ordered) but logs it for debugging.
  private inputSeq = 0;

  // ----- Epic 10: reconnect + disconnected-owner HUD -----
  /** Shared ReconnectingOverlay. Lazy-created on first drop. */
  private reconnectingOverlay: ReconnectingOverlay | null = null;
  /** Concurrent-loop guard; prevents overlapping reconnect chains. */
  private reconnectInFlight = false;
  /** Room code captured at init time (room.state.code may be freed on drop). */
  private currentRoomCode = "";
  /** Phaser Time event that refreshes the disconnected-owner countdown. */
  private disconnectTick: Phaser.Time.TimerEvent | null = null;
  /** Active RoomHandle subscriptions (unsub fns). Cleared on scene shutdown. */
  private roomUnsubs: Array<() => void> = [];

  // Latest cached values from the server state. Track manually so
  // onStateChange can fire field-level callbacks the way Colyseus'
  // state.listen did. Comparisons happen in handleStateChange.
  private lastCurrentTeamId = "";
  private lastTurnEndsAt = 0;

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
    // Presence of room is the ONLY source of truth for networked mode.
    // Offline / ?offline=1 paths pass no room and this stays false end-to-end.
    this.isNetworked = !!this.room;
    this.mySessionId = this.room?.sessionId ?? "";
    // Register scene restart hook for dat.gui Maps panel
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

    this.physicsSystem = new PhysicsSystem({ gravity: { x: 0, y: tuning.world.gravityY } });
    this.terrain = new Terrain({
      scene: this,
      physics: this.physicsSystem,
      widthPx: this.scale.width,
      heightPx: this.scale.height,
      sourceMask: loaded.mask,
    });

    // Register contact listeners BEFORE spawning worms
    this.physicsSystem.world.on("begin-contact", this.onBeginContact);
    this.physicsSystem.world.on("end-contact", this.onEndContact);
    this.physicsSystem.world.on("post-solve", this.onPostSolve);

    // Clean up on scene shutdown
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.physicsSystem.world.off("begin-contact", this.onBeginContact);
      this.physicsSystem.world.off("end-contact", this.onEndContact);
      this.physicsSystem.world.off("post-solve", this.onPostSolve);
      this.turnManager.destroy();
      this.turnHUD.destroy();
      this.projectileManager.destroy();
      this.weaponDrawer.destroy();
      this.aimHUD.destroy();
      this.spectatorHUD?.destroy();
      this.reconnectingOverlay?.destroy();
      this.reconnectingOverlay = null;
      this.disconnectTick?.remove(false);
      this.disconnectTick = null;
      this.tearDownRoomListeners();
    });

    // Spawn worms using map spawn points (predefined or scanned).
    // Team roster comes from the lobby in multiplayer mode, falls back to
    // the hardcoded red/blue defaults for single-device play.
    this.teams = this.buildTeams(this.teamsInit);
    const spawnPts = loaded.spawnPoints;
    const totalWorms = this.teams.reduce((n, t) => {
      const goal = this.teamsInit
        ? (this.teamsInit.find((ti) => ti.id === t.id)?.wormNames.length ??
          tuning.team.wormsPerTeam)
        : tuning.team.wormsPerTeam;
      return n + goal;
    }, 0);

    const fallbackYPx = this.scale.height * 0.3;
    for (let i = 0; i < totalWorms; i++) {
      const team = this.teams[i % this.teams.length];
      if (!team) continue;
      const pt = spawnPts[i];
      const spawnXPx = pt ? pt.xPx : (this.scale.width / (totalWorms + 1)) * (i + 1);
      const spawnYPx = pt ? pt.yPx - tuning.worm.radiusPx * 2 : fallbackYPx;
      const teamIdx = this.teams.indexOf(team);
      const fromInit = this.teamsInit?.[teamIdx]?.wormNames[team.worms.length];
      const wormName = fromInit ?? `${team.id}-${team.worms.length + 1}`;
      const w = new Worm({
        scene: this,
        physics: this.physicsSystem,
        team,
        spawnXPx,
        spawnYPx,
        wormName,
      });
      team.addWorm(w);
      this.allWorms.push(w);
    }

    // Assign utilities to each worm AFTER construction
    for (const w of this.allWorms) {
      w.ropeUtility = new NinjaRope({
        scene: this,
        world: this.physicsSystem.world,
        worm: w,
      });
      w.jetPackUtility = new JetPack({
        scene: this,
        worm: w,
      });
    }

    // Weapon system - instantiate before inputController so callbacks can reference them
    this.projectileManager = new ProjectileManager({
      scene: this,
      world: this.physicsSystem.world,
      terrain: this.terrain,
      onDetonate: (firer, selfDamage) => {
        if (selfDamage > 0 && firer === this.inputController.getActiveWorm()) {
          this.turnManager.reportSelfDamage(selfDamage);
        }
      },
    });

    this.weaponManagers = new Map();
    for (const team of this.teams) {
      this.weaponManagers.set(team, new WeaponManager(team, defaultAmmoForMatch()));
    }

    this.inputController = new InputController({
      scene: this,
      allWorms: this.allWorms,
      onEndTurn: () => {
        this.sendLocalInput({ type: "input_end_turn" });
        this.turnManager.endTurnByPlayer();
      },
      onSelectWeapon: (n) => {
        const wm = this.getActiveWeaponManager();
        wm?.selectByKey(n);
        const selected = wm?.getSelected().id;
        if (selected) {
          this.sendLocalInput({ type: "input_select_weapon", weaponId: selected });
        }
      },
      onFire: () => {
        this.sendLocalInput({ type: "input_fire" });
        this.tryFireActiveWeapon();
      },
      onCycleMap: () => {
        if (!this.turnManager.isInputAllowed()) return;
        const next = nextId(this.mapId);
        this.scene.restart({ mapId: next });
      },
      // Epic 9 input relay. All callbacks are no-ops in offline mode
      // because sendLocalInput early-returns when !isNetworked.
      onWalk: (dir) => this.sendLocalInput({ type: "input_walk", dir }),
      onJump: () => this.sendLocalInput({ type: "input_jump" }),
      onBackflip: () => this.sendLocalInput({ type: "input_backflip" }),
      onAimAngleChange: (angleRad) => this.sendLocalInput({ type: "input_aim_angle", angleRad }),
      onAimPowerChange: (power) => this.sendLocalInput({ type: "input_aim_power", power }),
    });

    // Touch overlay - instantiated AFTER inputController so getActiveWorm() works
    this.touchControls = new TouchControls({
      scene: this,
      getActiveWorm: () => this.inputController.getActiveWorm(),
    });

    this.weaponDrawer = new WeaponDrawer({
      scene: this,
      weapons: allWeapons(),
      onSelect: (id) => {
        // Guard: weapon select via touch drawer must respect the same inputAllowed
        // gate as keyboard 1/2/3 select (InputController.update guards those).
        if (!this.turnManager.isInputAllowed()) return;
        this.getActiveWeaponManager()?.select(id);
      },
      getAmmo: (id) => this.getActiveWeaponManager()?.ammoFor(id) ?? 0,
      getSelectedId: () => this.getActiveWeaponManager()?.getSelected().id ?? "",
      getTeamColor: () => this.getActiveTeam()?.color ?? 0xffffff,
    });

    this.aimHUD = new AimHUD({
      scene: this,
      getActiveWorm: () => this.inputController.getActiveWorm(),
      isInputAllowed: () => this.turnManager.isInputAllowed(),
    });

    this.turnHUD = new TurnHUD({
      scene: this,
      onEndTurnPressed: () => this.turnManager.endTurnByPlayer(),
    });

    this.turnManager = new TurnManager({
      scene: this,
      teams: this.teams,
      allWorms: this.allWorms,
      onTurnStart: (team, worm) => {
        this.inputController.setActiveWorm(worm);
        // In networked mode, input is gated on "is this my team?". In offline
        // mode all turns are local so input is always allowed.
        const allow = this.isNetworked ? this.iAmActive() : true;
        this.inputController.setInputAllowed(allow);
        this.turnHUD.showTurnBanner(team.name, team.color);
        this.turnHUD.setEndTurnEnabled(allow);
        // Reset per-turn weapon activation state
        this.shotsFiredThisTurn = 0;
        this.getActiveWeaponManager()?.resetActivation();
      },
      onTurnEnd: () => {
        this.inputController.setInputAllowed(false);
        this.turnHUD.setEndTurnEnabled(false);
        for (const w of this.allWorms) {
          w.ropeUtility?.deactivate();
          w.jetPackUtility?.deactivate();
        }
      },
      onGameOver: (winner) => {
        this.inputController.setInputAllowed(false);
        this.turnHUD.setEndTurnEnabled(false);
        this.turnHUD.showGameOver(winner?.name ?? null);
      },
    });
    this.turnManager.start();

    // ---------------------------------------------------------------------
    // Epic 9/13: networked mode wiring. All of this is gated on `isNetworked`
    // so the `?offline=1` / single-device path runs zero network code.
    // ---------------------------------------------------------------------
    if (this.isNetworked && this.room) {
      // Find which team our sessionId owns. Matched against teamsInit's
      // ownerSessionId (populated by the server on start_game).
      const mine = this.teamsInit?.find((t) => t.ownerSessionId === this.mySessionId);
      this.myTeamId = mine?.id ?? "";

      // Server owns turn rotation; local SETTLED no longer cycles teams.
      this.turnManager.setExternallyDriven(true);

      // Passive "Waiting for X..." banner, only mounted in networked mode.
      this.spectatorHUD = new SpectatorHUD({ scene: this });
      this.refreshSpectatorBanner();

      // Gate initial input based on the state we see at scene-create time.
      // If the server hasn't picked currentTeamId yet, err on the side of
      // locked input - onActiveTeamChanged will unlock once it arrives.
      const currentTeamId = this.room.state.currentTeamId ?? "";
      this.lastCurrentTeamId = currentTeamId;
      this.lastTurnEndsAt = this.room.state.turnEndsAt ?? 0;
      const initiallyActive = currentTeamId !== "" && currentTeamId === this.myTeamId;
      this.inputController.setInputAllowed(initiallyActive);
      this.turnHUD.setEndTurnEnabled(initiallyActive);

      // Epic 13: single onStateChange replaces the Colyseus
      // state.listen("currentTeamId", ...) / state.listen("turnEndsAt", ...)
      // / players.onChange(...) trio. We diff against the last-cached values
      // and dispatch synthetic field-level callbacks.
      this.roomUnsubs.push(
        this.room.onStateChange((state) => this.handleStateChange(state)),
      );

      // Input relay handlers. Server broadcasts relayed messages to non-senders;
      // when we're the active player we should never receive our own inputs, so
      // these only fire for other players' actions.
      this.roomUnsubs.push(
        this.room.onMessage("input_walk", (p) => {
          this.applyRemoteToActiveWorm("walk", p);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_jump", (p) => {
          this.applyRemoteToActiveWorm("jump", p);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_backflip", (p) => {
          this.applyRemoteToActiveWorm("backflip", p);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_aim_angle", (p) => {
          this.applyRemoteToActiveWorm("aim_angle", p);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_aim_power", (p) => {
          this.applyRemoteToActiveWorm("aim_power", p);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_select_weapon", (p) => {
          const wm = this.getActiveWeaponManager();
          if (wm && p.weaponId) wm.select(p.weaponId);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("input_fire", () => {
          // Fire is GameScene-level: networkBridge treats "fire" as a no-op
          // because it needs WeaponManager + ProjectileManager context. We
          // replay directly here using the active worm's current aim state
          // (prior input_aim_angle / input_aim_power messages have synced it).
          this.tryFireActiveWeapon();
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("turn_resolved", (msg) => {
          this.applyTurnResolved(msg);
        }),
      );
      this.roomUnsubs.push(
        this.room.onMessage("game_over", (msg) => {
          this.onServerGameOver(msg);
        }),
      );

      // Active client fires turn_snapshot when local settle says the turn is
      // done. Spectator clients' hook fires too but sendTurnSnapshot()
      // self-gates on iAmActive(), so only one snapshot lands per turn.
      this.turnManager.onLocalTurnFinished = () => this.sendTurnSnapshot();

      // Epic 10: capture the room code + unexpected-drop handler. Any close
      // code other than 1000 (consented) triggers the reconnect loop.
      this.currentRoomCode = this.room.state?.code ?? "";
      this.roomUnsubs.push(
        this.room.onClose((code) => {
          if (code === 1000) return;
          void this.startReconnectionLoop();
        }),
      );

      // Countdown tick for "(owner disconnected, Ns)". 250ms is plenty for a
      // 1-second-precision countdown without burning render budget. The
      // onStateChange listener handles the connected/disconnected flip;
      // this only drives the remaining-seconds text.
      this.disconnectTick = this.time.addEvent({
        delay: 250,
        loop: true,
        callback: () => this.refreshSpectatorBanner(),
      });
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

    // Pointerdown chain: TurnHUD -> TouchControls -> WeaponDrawer -> Shift+click dev cut -> drag-to-aim
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.turnHUD.hitsButton(p)) return;
      if (this.touchControls.hitsButton(p)) return;
      if (this.weaponDrawer.hitsIcon(p)) return; // drawer owns tap via its zones
      // Shift+click = dev terrain cut (removed in Epic 7)
      if ((p.event as MouseEvent | undefined)?.shiftKey) {
        this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
        return;
      }
      // Only track the FIRST (primary) pointer for drag-to-aim.
      // Multitouch: ignore secondary fingers so a second tap can't steal
      // dragStart and cause an accidental fire when the first finger lifts.
      if (this.dragPointerId !== null) return;
      this.dragStart = { x: p.x, y: p.y };
      this.dragPointerId = p.id;
    });

    // Drag updates aim angle + power in real-time relative to active worm position
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.dragStart || p.id !== this.dragPointerId) return;
      const worm = this.inputController.getActiveWorm();
      if (!worm || !this.turnManager.isInputAllowed()) return;

      const dx = p.x - worm.xPx;
      const dy = p.y - worm.yPx;
      const mag = Math.hypot(dx, dy);
      const cap = tuning.weapons.dragMaxLengthPx;
      const power = Math.min(1, mag / cap);

      // Compute raw aim angle; flip facing if drag goes behind worm
      const rawAngle = Math.atan2(dy, dx);
      const facingDot = Math.cos(rawAngle) * worm.facing;
      if (facingDot < 0) {
        // Pointer is on the opposite side - flip facing
        worm.setFacing(-worm.facing as -1 | 1);
      }
      // Aim angle is relative to facing; atan2(dy, |dx|) gives correct up/down angle
      const aimRad = Math.atan2(dy, Math.abs(dx));
      worm.setAimAngle(aimRad);
      worm.setAimPower(power);
    });

    // Drag release: if distance >= deadzone, fire current weapon
    this.input.on("pointerup", (p: Phaser.Input.Pointer) => {
      if (!this.dragStart || p.id !== this.dragPointerId) return;
      const dragDist = Math.hypot(p.x - this.dragStart.x, p.y - this.dragStart.y);
      this.dragStart = null;
      this.dragPointerId = null;
      if (dragDist < tuning.weapons.dragDeadZonePx) return; // tap, not a drag
      this.tryFireActiveWeapon();
    });

    void mountTuningPanel(() => {
      this.physicsSystem.world.setGravity({ x: 0, y: tuning.world.gravityY });
    });
  }

  update(_time: number, deltaMs: number): void {
    this.physicsSystem.step(deltaMs);
    this.terrain.flushPendingCuts();

    // ProjectileManager runs AFTER physics + terrain flush, BEFORE damage apply
    // so same-frame detonation damage is visible in the win check
    this.projectileManager.update(deltaMs);

    // Apply pending damage BEFORE win check so same-frame kills are detected
    for (const w of this.allWorms) {
      w.applyPendingDamage();
    }

    // Win check + settle detection + timer tick
    this.turnManager.update(deltaMs);

    // Input: respects inputAllowed set by turn manager
    this.inputController.update(deltaMs);

    // Per-worm update + utilities
    for (const w of this.allWorms) {
      w.update(deltaMs);
      w.ropeUtility.update(deltaMs);
      w.jetPackUtility.update(deltaMs);
    }

    // HUD timer
    this.turnHUD.update(this.turnManager.getTurnSecondsRemaining());

    // Weapon UI
    this.weaponDrawer.update();
    this.aimHUD.update();

    drawDebug(this.debugGfx, this.physicsSystem.world);

    const wm = this.getActiveWeaponManager();
    const selectedName = wm ? wm.getSelected().name : "-";
    this.hud.setText(`weapon: ${selectedName}  bodies: ${this.terrain.bodyCount()}`);
  }

  // ---------------------------------------------------------------------------
  // Weapon helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the Team list for this match.
   *
   * - Lobby path: server sends TeamInit[] in the `game_started` message;
   *   we instantiate Teams with those id/name/color values.
   * - Solo path: fall back to the Epic 7 hardcoded red/blue defaults.
   */
  private buildTeams(init: NetTeamInit[] | undefined): Team[] {
    if (init && init.length > 0) {
      return init.map((t) => new Team({ id: t.id, name: t.name, color: parseTeamColor(t.color) }));
    }
    return [
      new Team({ id: "red", name: "Red", color: 0xff4444 }),
      new Team({ id: "blue", name: "Blue", color: 0x4488ff }),
    ];
  }

  private getActiveTeam(): Team | null {
    const worm = this.inputController.getActiveWorm();
    if (!worm) return null;
    return worm.team;
  }

  private getActiveWeaponManager(): WeaponManager | null {
    const team = this.getActiveTeam();
    if (!team) return null;
    return this.weaponManagers.get(team) ?? null;
  }

  private tryFireActiveWeapon(): void {
    if (!this.turnManager.isInputAllowed()) return;
    const wm = this.getActiveWeaponManager();
    const worm = this.inputController.getActiveWorm();
    if (!wm || !worm) return;

    const weapon = wm.getSelected();
    if (!wm.hasAmmo(weapon.id)) return; // out of ammo

    const result = fire(
      weapon,
      {
        world: this.physicsSystem.world,
        terrain: this.terrain,
        firer: worm,
        aimRadians: worm.aimAngle,
        aimPower01: worm.aimPower01,
        projectileManager: this.projectileManager,
      },
      wm.shotsFiredThisActivation,
    );

    wm.consumeOne(weapon.id);
    wm.shotsFiredThisActivation++;
    this.shotsFiredThisTurn++;

    if (result.turnEndsImmediately) {
      this.turnManager.endTurnByPlayer();
    }
  }

  // ------ Contact listeners ------

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

  // ---------------------------------------------------------------------------
  // Epic 9/13 network hooks.
  // ---------------------------------------------------------------------------

  /**
   * True when our sessionId is the owner of the currently active team.
   * Returns false in offline mode.
   */
  protected iAmActive(): boolean {
    if (!this.isNetworked || !this.room) return false;
    return this.room.state.currentTeamId === this.myTeamId && this.myTeamId !== "";
  }

  /**
   * Dispatch synthetic field-level callbacks from a full-state snapshot.
   *
   * Replaces the Colyseus `state.listen("currentTeamId", ...)` +
   * `state.listen("turnEndsAt", ...)` + `players.onChange` trio. We diff
   * the incoming state against our cached last values; anything that
   * changed routes to the matching handler.
   */
  private handleStateChange(state: LobbyState): void {
    if (!this.isNetworked) return;
    if (state.currentTeamId !== this.lastCurrentTeamId) {
      this.lastCurrentTeamId = state.currentTeamId;
      this.onActiveTeamChanged(state.currentTeamId);
    }
    if (state.turnEndsAt !== this.lastTurnEndsAt) {
      this.lastTurnEndsAt = state.turnEndsAt;
      this.syncTurnTimer(state.turnEndsAt);
    }
    // The disconnected-owner banner reads directly from state.players, so
    // a refresh on every state change keeps the "(disconnected, Ns)"
    // countdown live without a dedicated players.onChange subscription.
    this.refreshSpectatorBanner();
  }

  /**
   * Called every time the server advances `currentTeamId`. Flips the local
   * InputController on iff the new active team belongs to us. Remote worms
   * are driven entirely by relayed input messages.
   */
  protected onActiveTeamChanged(_teamId: string): void {
    if (!this.isNetworked) return;
    const active = this.iAmActive();
    // Flush a pending walk if we were walking when control flipped away.
    // Otherwise spectators keep seeing the active worm walk forever on our
    // last known dir. Bugcheck M6.
    if (!active && this.inputController) {
      const dir = this.inputController.getLastWalkDir();
      if (dir !== 0 && this.room) {
        this.inputSeq++;
        this.room.send({ type: "input_walk", dir: 0, seq: this.inputSeq });
      }
      this.inputController.resetWalkState();
    }
    this.inputController?.setInputAllowed(active);
    this.turnHUD?.setEndTurnEnabled(active);
    this.refreshSpectatorBanner();
  }

  /**
   * Toggle the spectator banner based on current turn ownership.
   * - I'm active: hide.
   * - Someone else is active: show "Waiting for {their nickname}...".
   * - Active team has no owner (server about to auto-skip): show a
   *   generic message. The banner will flip to the real owner a moment
   *   later when the skip lands.
   */
  private refreshSpectatorBanner(): void {
    if (!this.spectatorHUD || !this.room) return;
    const activeTeamId = this.room.state.currentTeamId;
    if (!activeTeamId) {
      this.spectatorHUD.hide();
      return;
    }
    // Find the owner's sessionId via teamsInit, then look up the live
    // LobbyPlayer for nickname + disconnected flag. Falls back to the
    // team name if the lookup misses.
    const team = this.teamsInit?.find((t) => t.id === activeTeamId);
    const ownerSessionId = team?.ownerSessionId ?? "";
    // Epic 13: players is now a plain Record; no .get() method.
    const ownerPlayer = ownerSessionId ? this.room.state.players[ownerSessionId] : undefined;
    const ownerName = ownerPlayer?.nickname ?? team?.name ?? activeTeamId;

    // Epic 10: if the active team's owner is disconnected, surface it on
    // the banner with a grace countdown. This takes precedence over the
    // usual "I'm active - hide banner" rule so the active player also sees
    // the countdown when... someone else (e.g. the other player in a
    // 1v1) has dropped.
    if (ownerPlayer?.disconnected) {
      const graceEndsAt = ownerPlayer.disconnectGraceEndsAt ?? 0;
      const remainingSec = Math.max(0, Math.ceil((graceEndsAt - Date.now()) / 1000));
      this.spectatorHUD.show(`${ownerName} (disconnected, ${remainingSec}s)`);
      return;
    }

    if (this.iAmActive()) {
      this.spectatorHUD.hide();
      return;
    }
    this.spectatorHUD.show(`Waiting for ${ownerName}...`);
  }

  /**
   * Sync the local turn timer to the server's authoritative turnEndsAt.
   * TurnManager reads endsAt on adoption (in applyTurnResolved); this hook
   * is left wired so future epics can inject latency compensation without
   * changing the listener shape.
   */
  protected syncTurnTimer(_endsAt: number): void {
    // no-op placeholder
  }

  /**
   * Forward a local input event to the server.
   * No-op in offline mode or when we're not the active player (guards
   * against races between gate-flips and in-flight key events).
   *
   * Accepts a partial ClientMsg (without `seq`) for input_* variants and
   * the flat start_game / select_map / set_ready / end_turn messages.
   * For input messages we stamp the next inputSeq before sending.
   */
  protected sendLocalInput(partial: Omit<InputClientMsg, "seq"> | ClientMsg): void {
    if (!this.isNetworked || !this.room) return;
    if (!this.iAmActive()) return;
    const needsSeq = isInputType(partial.type);
    if (needsSeq) {
      this.inputSeq++;
      // Spread with seq appended. Cast through unknown to satisfy the
      // discriminated-union narrowing.
      const msg = { ...partial, seq: this.inputSeq } as unknown as ClientMsg;
      this.room.send(msg);
    } else {
      this.room.send(partial as ClientMsg);
    }
  }

  /**
   * Route a relayed input message onto the currently-active remote worm.
   * Looks up the target worm by the server's `currentWormId` so if the
   * server has already rotated worms within a team, we replay onto the
   * right one.
   */
  private applyRemoteToActiveWorm(type: string, payload: unknown): void {
    if (!this.isNetworked || !this.room) return;
    const currentWormId = this.room.state.currentWormId;
    if (!currentWormId) return;
    const target = this.allWorms.find((w) => w.name === currentWormId);
    if (!target) return;
    applyRemoteInput(target, type, payload);
  }

  /**
   * Active player only: bundle the current sim into a turn_snapshot and
   * ship it to the server. The server broadcasts it back as turn_resolved
   * so all clients (including us) snap to the same authoritative state.
   *
   * Terrain cuts are carried as an empty array in this epic: all clients
   * replay the same input stream through the same weapon + terrain logic,
   * so locally-computed cuts already match across clients. Drift correction
   * focuses on worm positions which ARE subject to per-client physics noise.
   * A future epic can add a proper pending-cut log on Terrain if needed.
   */
  protected sendTurnSnapshot(): void {
    if (!this.isNetworked || !this.room) return;
    if (!this.iAmActive()) return;
    const emptyCuts: CircleCut[] = [];
    const snap = buildTurnSnapshot(this.teams, emptyCuts);
    this.room.send({ type: "turn_snapshot", ...snap });
  }

  /**
   * Apply the server's authoritative turn reconciliation.
   * - Snap every worm to the server's (x, y, vx, vy, hp, alive).
   * - Replay terrain cuts (idempotent: the CircleCut.seq guard lives in
   *   future logic; here we simply queue them via terrain.cutCircle).
   * - Hand the new team + worm + endsAt to TurnManager.adoptServerTurn.
   */
  protected applyTurnResolved(msg: TurnResolvedMessage): void {
    // Idempotent on turnSeq: a duplicate message must not double-cut terrain.
    if (msg.turnSeq <= this.lastAppliedTurnSeq) return;
    this.lastAppliedTurnSeq = msg.turnSeq;

    // 1. Worm snap.
    for (const snapWorm of msg.worms) {
      const w = this.allWorms.find((ww) => ww.name === snapWorm.id);
      if (w) setWormFromSnapshot(w, snapWorm);
    }
    // 2. Terrain cuts.
    for (const cut of msg.terrainCuts) {
      this.terrain.cutCircle(cut.x, cut.y, cut.r);
    }
    // 3. Turn rotation.
    const endsAt = this.room?.state.turnEndsAt ?? 0;
    this.turnManager.adoptServerTurn(msg.turnSeq, msg.nextTeamId, msg.nextWormId, endsAt);
  }

  /**
   * Server has declared the match over. Pipe through the same
   * game-over HUD path used by offline mode so the UX is unified.
   */
  protected onServerGameOver(msg: GameOverMessage): void {
    this.inputController?.setInputAllowed(false);
    this.turnHUD?.setEndTurnEnabled(false);
    this.spectatorHUD?.hide();
    const winningTeam = this.teams.find((t) => t.id === msg.winnerTeamId) ?? null;
    this.turnHUD?.showGameOver(winningTeam?.name ?? null);
  }

  /**
   * Epic 10/13: unexpected-drop reconnect loop. Matches the LobbyScene
   * pattern but operates on the live game Room. On success we swap
   * `this.room` via scene.restart so listeners rewire cleanly. On
   * failure we clear the cached token and drop back to the LobbyScene
   * home view so the user can re-join manually.
   */
  private async startReconnectionLoop(): Promise<void> {
    if (this.reconnectInFlight) return;
    if (!this.netClient) {
      // Can't reconnect without a client reference; bounce to home.
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

    // Use a neutral nickname + the lobby's known color; the worker will
    // match us by resume token first and ignore these values on a match.
    const result = await runReconnectLoop({
      netClient: this.netClient,
      code,
      nickname: "player",
      color: "#ff4444",
      resumeToken: stored.resumeToken,
      onAttempt: (n) => overlay.show(n),
    });

    if (result.ok && result.room) {
      // Swap to the fresh RoomHandle. Rotated resume token gets saved.
      saveRoomToken(code, result.room.resumeToken);
      overlay.hide();
      this.reconnectInFlight = false;
      // Full re-wire of listeners on the new Room would be invasive here;
      // a scene.restart() is simpler and guaranteed consistent. We keep
      // the same teamsInit + mapId + seed so physics state is rebuilt
      // from scratch and then catches up via the next turn_resolved.
      this.scene.restart({
        mapId: this.mapId,
        seed: this.seedOverride,
        teams: this.teamsInit,
        room: result.room,
        netClient: this.netClient,
      });
      return;
    }

    // All attempts failed. Token is stale; drop to home.
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
        // Already torn down - drop.
      }
    }
    this.roomUnsubs = [];
  }

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** ClientMsg variants that carry a `seq` field (all the input_* ones). */
type InputClientMsg = Extract<ClientMsg, { seq: number }>;

const INPUT_TYPES: ReadonlySet<InputClientMsg["type"]> = new Set([
  "input_walk",
  "input_jump",
  "input_backflip",
  "input_aim_angle",
  "input_aim_power",
  "input_select_weapon",
  "input_fire",
  "input_end_turn",
]);

function isInputType(type: ClientMsg["type"]): type is InputClientMsg["type"] {
  return INPUT_TYPES.has(type as InputClientMsg["type"]);
}

/**
 * Convert a `game_started` team color (server sends "#ff4444" as a string)
 * into the Phaser hex int that `Team.color` expects. Tolerates numeric
 * inputs for callers that already have an int. Bugcheck found the mismatch
 * on first Epic 9 integration.
 */
function parseTeamColor(input: string | number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const hex = input.startsWith("#") ? input.slice(1) : input;
    const parsed = Number.parseInt(hex, 16);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0xaaaaaa;
}
