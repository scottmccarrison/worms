import * as Phaser from "phaser";
import { tuning } from "../tuning";

export interface TurnHUDInit {
  scene: Phaser.Scene;
  onEndTurnPressed: () => void;
}

export class TurnHUD {
  private readonly scene: Phaser.Scene;
  private readonly onEndTurnPressed: () => void;
  private readonly timerText: Phaser.GameObjects.Text;
  private readonly endBtn: Phaser.GameObjects.Container;
  private readonly endBtnCircle: Phaser.GameObjects.Graphics;
  private readonly endBtnLabel: Phaser.GameObjects.Text;
  private bannerText: Phaser.GameObjects.Text | null = null;
  private bannerTween: Phaser.Tweens.Tween | null = null;
  private gameOverText: Phaser.GameObjects.Text | null = null;
  private endEnabled = false;

  private readonly BTN_RADIUS = 40; // diameter 80 - exceeds WCAG 44 even after Scale.FIT on narrow viewports

  constructor(init: TurnHUDInit) {
    this.scene = init.scene;
    this.onEndTurnPressed = init.onEndTurnPressed;

    const W = this.scene.scale.width;

    this.timerText = this.scene.add
      .text(W / 2, 36, "", {
        fontSize: "48px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 4,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0);

    // End-turn button: Container with Graphics circle + Text.
    // Position y=60 so the 80px button (radius 40) sits fully on canvas (y=20..100).
    this.endBtn = this.scene.add
      .container(W - 80, 60)
      .setDepth(100)
      .setScrollFactor(0);
    this.endBtnCircle = this.scene.add.graphics();
    this.drawEndBtn(false);
    this.endBtnLabel = this.scene.add
      .text(0, 0, "End", {
        fontSize: "18px",
        fontFamily: "monospace",
        color: "#ffffff",
      })
      .setOrigin(0.5);
    this.endBtn.add([this.endBtnCircle, this.endBtnLabel]);

    this.endBtn.setInteractive({
      hitArea: new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
    });
    this.endBtn.on("pointerdown", () => {
      if (this.endEnabled) this.onEndTurnPressed();
    });
  }

  update(secondsRemaining: number): void {
    const warnBelowSec = Math.ceil(tuning.turn.warnThresholdMs / 1000);
    this.timerText.setText(secondsRemaining > 0 ? String(secondsRemaining) : "");
    this.timerText.setColor(
      secondsRemaining > 0 && secondsRemaining <= warnBelowSec ? "#ff4444" : "#ffffff",
    );
  }

  /** Returns true if the pointer is over the end-turn button. GameScene uses this to gate terrain cut.
   * Blocks cuts even when the button is visually disabled - the greyed button still occupies screen space
   * and tapping there during turnEnding should not leak through to terrain cut. */
  hitsButton(pointer: Phaser.Input.Pointer): boolean {
    const local = this.endBtn.getLocalPoint(pointer.x, pointer.y);
    return Phaser.Geom.Circle.Contains(
      new Phaser.Geom.Circle(0, 0, this.BTN_RADIUS),
      local.x,
      local.y,
    );
  }

  showTurnBanner(teamName: string, teamColor: number): void {
    this.bannerTween?.stop();
    this.bannerText?.destroy();

    const W = this.scene.scale.width;
    const H = this.scene.scale.height;

    this.bannerText = this.scene.add
      .text(W / 2, H / 2, `${teamName}'s turn`, {
        fontSize: "64px",
        fontFamily: "monospace",
        color: `#${teamColor.toString(16).padStart(6, "0")}`,
        stroke: "#000000",
        strokeThickness: 6,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0)
      .setAlpha(0)
      .setScale(2);

    const t = this.bannerText;
    this.bannerTween = this.scene.tweens.add({
      targets: t,
      alpha: { from: 0, to: 1 },
      scale: { from: 2, to: 1 },
      duration: 300,
      onComplete: () => {
        this.scene.tweens.add({
          targets: t,
          alpha: 0,
          delay: 900,
          duration: 300,
          onComplete: () => {
            t.destroy();
            if (this.bannerText === t) this.bannerText = null;
          },
        });
      },
    });
  }

  showGameOver(winnerName: string | null): void {
    this.gameOverText?.destroy();
    const W = this.scene.scale.width;
    const H = this.scene.scale.height;
    const label = winnerName ? `${winnerName} wins!` : "Draw!";
    this.gameOverText = this.scene.add
      .text(W / 2, H / 2, label, {
        fontSize: "72px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 8,
      })
      .setOrigin(0.5)
      .setDepth(100)
      .setScrollFactor(0);
  }

  setEndTurnEnabled(enabled: boolean): void {
    this.endEnabled = enabled;
    this.drawEndBtn(enabled);
    this.endBtn.setAlpha(enabled ? 1 : 0.5);
  }

  destroy(): void {
    this.bannerTween?.stop();
    this.bannerText?.destroy();
    this.gameOverText?.destroy();
    this.timerText.destroy();
    this.endBtn.destroy();
  }

  private drawEndBtn(enabled: boolean): void {
    this.endBtnCircle.clear();
    this.endBtnCircle.fillStyle(enabled ? 0x333333 : 0x111111, 1);
    this.endBtnCircle.fillCircle(0, 0, this.BTN_RADIUS);
    this.endBtnCircle.lineStyle(2, 0xffffff, 1);
    this.endBtnCircle.strokeCircle(0, 0, this.BTN_RADIUS);
  }
}
