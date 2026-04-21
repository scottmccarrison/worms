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
import { TouchControls } from "../ui/TouchControls";
import { TurnHUD } from "../ui/TurnHUD";
import { JetPack } from "../utilities/JetPack";
import { NinjaRope } from "../utilities/NinjaRope";
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

    // Clean up contact listeners on scene shutdown to prevent HMR stacking
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.physicsSystem.world.off("begin-contact", this.onBeginContact);
      this.physicsSystem.world.off("end-contact", this.onEndContact);
      this.physicsSystem.world.off("post-solve", this.onPostSolve);
      this.turnManager.destroy();
      this.turnHUD.destroy();
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

    // Spawn worms from terrain surface scan; fall back to width-spread for any missing slots
    const fallbackYPx = this.scale.height * 0.3;
    for (let i = 0; i < totalWorms; i++) {
      const team = this.teams[i % 2];
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

    // Assign utilities to each worm AFTER construction (worm doesn't instantiate these)
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

    this.inputController = new InputController({
      scene: this,
      allWorms: this.allWorms,
      onEndTurn: () => this.turnManager.endTurnByPlayer(),
      onSelectWeapon: () => { /* wired in commit 10 */ },
      onFire: () => { /* wired in commit 10 */ },
    });

    // Touch overlay - instantiated AFTER inputController so getActiveWorm() works
    this.touchControls = new TouchControls({
      scene: this,
      getActiveWorm: () => this.inputController.getActiveWorm(),
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

    // Terrain-cut on click/tap - gate against touch buttons and HUD end button
    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      if (this.touchControls.hitsButton(p)) return;
      if (this.turnHUD.hitsButton(p)) return;
      this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
    });

    void mountTuningPanel(() => {
      this.physicsSystem.world.setGravity({ x: 0, y: tuning.world.gravityY });
    });
  }

  update(_time: number, deltaMs: number): void {
    this.physicsSystem.step(deltaMs);
    this.terrain.flushPendingCuts();

    // Apply pending damage BEFORE win check so same-frame kills are detected immediately
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

    drawDebug(this.debugGfx, this.physicsSystem.world);

    this.hud.setText(`click to cut - bodies: ${this.terrain.bodyCount()}`);
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

    // Only apply fall damage via non-sensor fixtures (not foot sensor)
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
