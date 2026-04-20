import * as Phaser from "phaser";
import type { Contact } from "planck";
import type { ContactImpulse } from "planck";
import { mountTuningPanel } from "../debug/tuningPanel";
import { InputController } from "../input/InputController";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { drawDebug } from "../rendering/debugDraw";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";
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
  private inputController!: InputController;

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

    const teams = [red, blue];

    if (spawnPts.length === totalWorms) {
      spawnPts.forEach((pt, i) => {
        const team = teams[i % 2];
        const w = new Worm({
          scene: this,
          physics: this.physicsSystem,
          team,
          spawnXPx: pt.xPx,
          spawnYPx: pt.yPx - tuning.worm.radiusPx * 2, // spawn above surface
          wormName: `${team.id}-${team.worms.length + 1}`,
        });
        team.addWorm(w);
        this.allWorms.push(w);
      });
    } else {
      // Fallback: spread across width manually if spawn scan failed
      const fallbackYPx = this.scale.height * 0.3;
      for (let i = 0; i < totalWorms; i++) {
        const team = teams[i % 2];
        const xPx = (this.scale.width / (totalWorms + 1)) * (i + 1);
        const w = new Worm({
          scene: this,
          physics: this.physicsSystem,
          team,
          spawnXPx: xPx,
          spawnYPx: fallbackYPx,
          wormName: `${team.id}-${team.worms.length + 1}`,
        });
        team.addWorm(w);
        this.allWorms.push(w);
      }
    }

    this.inputController = new InputController({ scene: this, worms: this.allWorms });

    this.debugGfx = this.add.graphics();
    this.debugGfx.setDepth(10);

    this.hud = this.add
      .text(12, 12, "", {
        fontSize: "14px",
        color: "#e0e0e0",
        fontFamily: "system-ui, sans-serif",
      })
      .setDepth(20);

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.terrain.cutCircle(p.x, p.y, tuning.weapons.testCutRadiusPx);
    });

    void mountTuningPanel(() => {
      this.physicsSystem.world.setGravity({ x: 0, y: tuning.world.gravityY });
    });
  }

  update(_time: number, deltaMs: number): void {
    this.physicsSystem.step(deltaMs);
    this.terrain.flushPendingCuts();

    this.inputController.update(deltaMs);
    for (const w of this.allWorms) {
      w.update(deltaMs);
    }

    // Apply pending damage after physics step
    for (const w of this.allWorms) {
      w.applyPendingDamage();
    }

    drawDebug(this.debugGfx, this.physicsSystem.world);

    const active = this.inputController.getActiveWorm();
    const activeName = active ? active.name : "none";
    this.hud.setText(`click to cut - bodies: ${this.terrain.bodyCount()} - active: ${activeName}`);
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
    return c;
  }
}
