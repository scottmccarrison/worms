import type * as Phaser from "phaser";

export interface SpectatorHUDInit {
  scene: Phaser.Scene;
}

/**
 * Passive "Waiting for {nickname}..." banner shown when a networked match
 * has an active team that doesn't belong to us. Also appears briefly
 * during the server's auto-skip of ownerless teams (2-player match with
 * 4 default teams).
 *
 * Zero interactivity - this is purely informational. Touch / pointer
 * events pass through unaffected.
 *
 * Styled after TurnHUD for visual consistency: top-center, semi-transparent
 * dark background rectangle, white monospaced text.
 */
export class SpectatorHUD {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private visible = false;

  private readonly PADDING_X = 16;
  private readonly PADDING_Y = 8;
  // Y position below the turn timer (~y=60) but above gameplay area.
  private readonly TOP_Y = 90;

  constructor(init: SpectatorHUDInit) {
    this.scene = init.scene;
    const W = this.scene.scale.width;

    this.container = this.scene.add
      .container(W / 2, this.TOP_Y)
      .setDepth(99)
      .setScrollFactor(0);

    this.bg = this.scene.add.graphics();
    this.text = this.scene.add
      .text(0, 0, "", {
        fontSize: "20px",
        fontFamily: "monospace",
        color: "#ffffff",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5);

    this.container.add([this.bg, this.text]);
    this.container.setVisible(false);
  }

  /**
   * Display the banner with the given text, e.g. "Waiting for Alice...".
   * Re-rendering on each show keeps the background rect sized to the text.
   */
  show(text: string): void {
    this.text.setText(text);
    const tw = this.text.width;
    const th = this.text.height;
    this.bg.clear();
    this.bg.fillStyle(0x000000, 0.6);
    this.bg.fillRoundedRect(
      -tw / 2 - this.PADDING_X,
      -th / 2 - this.PADDING_Y,
      tw + this.PADDING_X * 2,
      th + this.PADDING_Y * 2,
      6,
    );
    this.container.setVisible(true);
    this.visible = true;
  }

  hide(): void {
    this.container.setVisible(false);
    this.visible = false;
  }

  isVisible(): boolean {
    return this.visible;
  }

  destroy(): void {
    this.container.destroy();
  }
}
