import * as Phaser from "phaser";
import type { Contact } from "planck";
import type { ContactImpulse } from "planck";
import { mountTuningPanel } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { drawDebug } from "../rendering/debugDraw";
import { TurnManager } from "../state/TurnManager";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";
import { AimHUD } from "../ui/AimHUD";
import { TouchControls } from "../ui/TouchControls";
import { TurnHUD } from "../ui/TurnHUD";
import { WeaponDrawer } from "../ui/WeaponDrawer";
import { JetPack } from "../utilities/JetPack";
import { NinjaRope } from "../utilities/NinjaRope";
import { allWeapons, defaultAmmoForMatch } from "../weapons/registry";
import { fire } from "../weapons/fire";
import { ProjectileManager } from "../weapons/ProjectileManager";
import { WeaponManager } from "../weapons/WeaponManager";
import { Team } from "../worm/Team";
import { Worm } from "../worm/Worm";
import type { WormUserData } from "../worm/Worm";
import { fallDamageFromImpulse } from "../worm/fallDamage";
import { findSpawnPoints } from "../worm/spawnPoints";

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

  // Weapon system
  private projectileManager!: ProjectileManager;
  private weaponManagers!: Map<Team, WeaponManager>;
  private weaponDrawer!: WeaponDrawer;
  private aimHUD!: AimHUD;
  private shotsFiredThisTurn = 0;

  // Drag-to-aim state
  private dragStart: { x: number; y: number } | null = null;

  constructor() {
    super("GameScene");
  }

  create(): void {
    const mask = this.buildPlaceholderMask(this.scale.width, this.scale.height);

    this.physicsSystem = new PhysicsSystem({ gravity: { x: 0, y: tuning.world.gravityY } });
    this.terrain = new Terrain({
      scene: this,
      physics: this.physicsSystem,
      widthPx: this.scale.width,
      heightPx: this.scale.height,
      sourceMask: mask,
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
    });

    // Spawn worms on terrain surface
    const maskImgData = this.terrain.getMaskImageData();
    const totalWorms = tuning.team.wormsPerTeam * 2;
    const spawnPts = findSpawnPoints(
      maskImgData.data,
      maskImgData.width,
      maskImgData.height,
      totalWorms,
    );

    const red = new Team({ id: "red", name: "Red", color: 0xff4444 });
    const blue = new Team({ id: "blue", name: "Blue", color: 0x4488ff });

    this.teams = [red, blue];

    const fallbackYPx = this.scale.height * 0.3;
    for (let i = 0; i < totalWorms; i++) {
      const team = this.teams[i % 2]!;
      const pt = spawnPts[i];
      const spawnXPx = pt ? pt.xPx : (this.scale.width / (totalWorms + 1)) * (i + 1);
      const spawnYPx = pt ? pt.yPx - tuning.worm.radiusPx * 2 : fallbackYPx;
      const w = new Worm({
        scene: this,
        physics: this.physicsSystem,
        team,
        spawnXPx,
        spawnYPx,
        wormName: `${team.id}-${team.worms.length + 1}`,
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
      onEndTurn: () => this.turnManager.endTurnByPlayer(),
      onSelectWeapon: (n) => {
        this.getActiveWeaponManager()?.selectByKey(n);
      },
      onFire: () => {
        this.tryFireActiveWeapon();
      },
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
        this.inputController.setInputAllowed(true);
        this.turnHUD.showTurnBanner(team.name, team.color);
        this.turnHUD.setEndTurnEnabled(true);
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
      // Begin drag-to-aim
      this.dragStart = { x: p.x, y: p.y };
    });

    // Drag updates aim angle + power in real-time relative to active worm position
    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
      if (!this.dragStart) return;
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
      if (!this.dragStart) return;
      const dragDist = Math.hypot(p.x - this.dragStart.x, p.y - this.dragStart.y);
      this.dragStart = null;
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
    this.hud.setText(
      `weapon: ${selectedName}  bodies: ${this.terrain.bodyCount()}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Weapon helpers
  // ---------------------------------------------------------------------------

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

  private buildPlaceholderMask(width: number, height: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = width;
    c.height = height;
    const g = c.getContext("2d");
    if (!g) throw new Error("mask ctx");

    // Ground: wavy hills at the bottom half.
    g.fillStyle = "#4a7d3c";
    g.beginPath();
    g.moveTo(0, height);
    for (let x = 0; x <= width; x += 4) {
      const y = height / 2 + Math.sin(x * 0.01) * 60 + Math.sin(x * 0.03) * 30;
      g.lineTo(x, y);
    }
    g.lineTo(width, height);
    g.closePath();
    g.fill();

    // Ceiling: rough rocky strip at the top so rope has something to grapple.
    g.fillStyle = "#3d5d2f";
    g.beginPath();
    g.moveTo(0, 0);
    g.lineTo(width, 0);
    for (let x = width; x >= 0; x -= 4) {
      const y = 40 + Math.sin(x * 0.015) * 18 + Math.sin(x * 0.04) * 10;
      g.lineTo(x, y);
    }
    g.closePath();
    g.fill();

    return c;
  }
}
