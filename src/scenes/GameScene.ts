import type { Room } from "colyseus.js";
import * as Phaser from "phaser";
import type { Contact } from "planck";
import type { ContactImpulse } from "planck";
import { mountTuningPanel, registerMapCycleFn } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { loadMap } from "../maps/loadMap";
import { firstId, getById, nextId } from "../maps/registry";
import type {
  CircleCut,
  GameOverMessage,
  LobbyState,
  TeamInit as NetTeamInit,
  TurnResolvedMessage,
} from "../net/types";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { drawDebug } from "../rendering/debugDraw";
import { TurnManager } from "../state/TurnManager";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";
import { AimHUD } from "../ui/AimHUD";
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
  // Colyseus room reference stashed in init(). Drives all Epic 9 netcode;
  // undefined means single-device / ?offline=1 play (no network code runs).
  private room: Room<LobbyState> | undefined;
  // True iff `room` is present. Cached so hot paths don't re-check every frame.
  private isNetworked = false;
  // Our Colyseus sessionId when networked, "" otherwise.
  private mySessionId = "";
  // Team id owned by our sessionId (set in create() after teamsInit maps sessionIds
  // to team ids). Empty when spectating or offline.
  private myTeamId = "";
  // Client-monotonic input sequence number. Server does not rely on it for
  // ordering (WebSocket is ordered) but logs it for debugging.
  private inputSeq = 0;

  constructor() {
    super("GameScene");
  }

  init(data?: {
    mapId?: string;
    seed?: number;
    teams?: NetTeamInit[];
    room?: Room<LobbyState>;
  }): void {
    const candidate = data?.mapId ?? this.readMapQueryParam() ?? tuning.maps.defaultId ?? firstId();
    this.mapId = getById(candidate) ? candidate : firstId();
    this.seedOverride = data?.seed;
    this.teamsInit = data?.teams;
    this.room = data?.room;
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
        this.sendLocalInput("input_end_turn", {});
        this.turnManager.endTurnByPlayer();
      },
      onSelectWeapon: (n) => {
        const wm = this.getActiveWeaponManager();
        wm?.selectByKey(n);
        const selected = wm?.getSelected().id;
        if (selected) {
          this.sendLocalInput("input_select_weapon", { weaponId: selected });
        }
      },
      onFire: () => {
        this.sendLocalInput("input_fire", {});
        this.tryFireActiveWeapon();
      },
      onCycleMap: () => {
        if (!this.turnManager.isInputAllowed()) return;
        const next = nextId(this.mapId);
        this.scene.restart({ mapId: next });
      },
      // Epic 9 input relay. All callbacks are no-ops in offline mode
      // because sendLocalInput early-returns when !isNetworked.
      onWalk: (dir) => this.sendLocalInput("input_walk", { dir }),
      onJump: () => this.sendLocalInput("input_jump", {}),
      onBackflip: () => this.sendLocalInput("input_backflip", {}),
      onAimAngleChange: (angleRad) => this.sendLocalInput("input_aim_angle", { angleRad }),
      onAimPowerChange: (power) => this.sendLocalInput("input_aim_power", { power }),
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
    // Epic 9: networked mode wiring. All of this is gated on `isNetworked`
    // so the `?offline=1` / single-device path runs zero network code.
    // Per-commit scope: this commit establishes the listener surface only.
    // Actual input forwarding + turn adoption land in later commits.
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
      const initiallyActive = currentTeamId !== "" && currentTeamId === this.myTeamId;
      this.inputController.setInputAllowed(initiallyActive);
      this.turnHUD.setEndTurnEnabled(initiallyActive);

      // Subscribe to authoritative turn state.
      this.room.state.listen("currentTeamId", (teamId) => this.onActiveTeamChanged(teamId));
      this.room.state.listen("turnEndsAt", (t) => this.syncTurnTimer(t));

      // Input relay handlers. Server broadcasts relayed messages to non-senders;
      // when we're the active player we should never receive our own inputs, so
      // these only fire for other players' actions.
      this.room.onMessage("input_walk", (p: { dir?: -1 | 0 | 1 }) => {
        this.applyRemoteToActiveWorm("walk", p);
      });
      this.room.onMessage("input_jump", (p: unknown) => {
        this.applyRemoteToActiveWorm("jump", p);
      });
      this.room.onMessage("input_backflip", (p: unknown) => {
        this.applyRemoteToActiveWorm("backflip", p);
      });
      this.room.onMessage("input_aim_angle", (p: { angleRad?: number }) => {
        this.applyRemoteToActiveWorm("aim_angle", p);
      });
      this.room.onMessage("input_aim_power", (p: { power?: number }) => {
        this.applyRemoteToActiveWorm("aim_power", p);
      });
      this.room.onMessage(
        "input_select_weapon",
        (p: { weaponId?: "bazooka" | "shotgun" | "handgrenade" }) => {
          const wm = this.getActiveWeaponManager();
          if (wm && p.weaponId) wm.select(p.weaponId);
        },
      );
      this.room.onMessage("input_fire", () => {
        // Fire is GameScene-level: networkBridge treats "fire" as a no-op
        // because it needs WeaponManager + ProjectileManager context. We
        // replay directly here using the active worm's current aim state
        // (prior input_aim_angle / input_aim_power messages have synced it).
        this.tryFireActiveWeapon();
      });
      this.room.onMessage("input_end_turn", () => {
        // Server owns the turn machine; our local end-turn just drops us into
        // turnEnding so the settle/snapshot cadence runs on all clients.
        this.turnManager.endTurnByPlayer();
      });
      this.room.onMessage<TurnResolvedMessage>("turn_resolved", (msg) => {
        this.applyTurnResolved(msg);
      });
      this.room.onMessage<GameOverMessage>("game_over", (msg) => {
        this.onServerGameOver(msg);
      });

      // Active client fires turn_snapshot when local settle says the turn is
      // done. Spectator clients' hook fires too but sendTurnSnapshot()
      // self-gates on iAmActive(), so only one snapshot lands per turn.
      this.turnManager.onLocalTurnFinished = () => this.sendTurnSnapshot();
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
      return init.map((t) => new Team({ id: t.id, name: t.name, color: t.color }));
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
  // Epic 9 network hooks. No-ops until later commits fill them in; stubs keep
  // create() compiling now that it references them.
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
   * Called every time the server advances `currentTeamId`. Flips the local
   * InputController on iff the new active team belongs to us. Remote worms
   * are driven entirely by relayed input messages in later commits.
   */
  protected onActiveTeamChanged(_teamId: string): void {
    if (!this.isNetworked) return;
    const active = this.iAmActive();
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
    if (this.iAmActive()) {
      this.spectatorHUD.hide();
      return;
    }
    const activeTeamId = this.room.state.currentTeamId;
    if (!activeTeamId) {
      this.spectatorHUD.hide();
      return;
    }
    // Find the owner's sessionId via teamsInit, then their nickname via
    // state.players. Falls back to the team name if either lookup misses.
    const team = this.teamsInit?.find((t) => t.id === activeTeamId);
    const ownerSessionId = team?.ownerSessionId ?? "";
    let label = team?.name ?? activeTeamId;
    if (ownerSessionId) {
      const player = this.room.state.players.get(ownerSessionId);
      if (player?.nickname) label = player.nickname;
    }
    this.spectatorHUD.show(`Waiting for ${label}...`);
  }

  /**
   * Sync the local turn timer to the server's authoritative turnEndsAt.
   * TurnManager.getTurnSecondsRemaining() already reads externalTurnEndsAt
   * when externallyDriven, so we only need to forward the value on adoption
   * (happens in applyTurnResolved, not here). This listener fires on every
   * state mutation - we use it to proactively refresh the HUD so the timer
   * stays accurate if the server clamps or extends the turn mid-run.
   */
  protected syncTurnTimer(_endsAt: number): void {
    // TurnManager reads endsAt on adoption; this hook is left wired so future
    // epics can inject latency compensation without changing the listener shape.
  }

  /**
   * Forward a local input event to the server.
   * No-op in offline mode or when we're not the active player (guards
   * against races between gate-flips and in-flight key events).
   */
  protected sendLocalInput(type: string, payload: Record<string, unknown>): void {
    if (!this.isNetworked || !this.room) return;
    if (!this.iAmActive()) return;
    this.inputSeq++;
    this.room.send(type, { ...payload, seq: this.inputSeq });
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
    this.room.send("turn_snapshot", snap);
  }

  /**
   * Apply the server's authoritative turn reconciliation.
   * - Snap every worm to the server's (x, y, vx, vy, hp, alive).
   * - Replay terrain cuts (idempotent: the CircleCut.seq guard lives in
   *   future logic; here we simply queue them via terrain.cutCircle).
   * - Hand the new team + worm + endsAt to TurnManager.adoptServerTurn.
   */
  protected applyTurnResolved(msg: TurnResolvedMessage): void {
    // 1. Worm snap.
    for (const snapWorm of msg.worms) {
      const w = this.allWorms.find((ww) => ww.name === snapWorm.id);
      if (w) setWormFromSnapshot(w, snapWorm);
    }
    // 2. Terrain cuts (deduped via turnSeq idempotency in adoptServerTurn).
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
