import * as Phaser from "phaser";
import { mountTuningPanel } from "../debug/tuningPanel";
import { PhysicsSystem } from "../physics/PhysicsSystem";
import { drawDebug } from "../rendering/debugDraw";
import { Terrain } from "../terrain/Terrain";
import { tuning } from "../tuning";

export class GameScene extends Phaser.Scene {
  private physicsSystem!: PhysicsSystem;
  private terrain!: Terrain;
  private debugGfx!: Phaser.GameObjects.Graphics;
  private hud!: Phaser.GameObjects.Text;

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

    mountTuningPanel(() => {
      this.physicsSystem.world.setGravity({ x: 0, y: tuning.world.gravityY });
    });
  }

  update(_time: number, deltaMs: number): void {
    this.physicsSystem.step(deltaMs);
    this.terrain.flushPendingCuts();
    drawDebug(this.debugGfx, this.physicsSystem.world);
    this.hud.setText(`click to cut - bodies: ${this.terrain.bodyCount()}`);
  }

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
