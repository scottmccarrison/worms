import type * as Phaser from "phaser";

export interface ReconnectingOverlayInit {
  scene: Phaser.Scene;
}

/**
 * Passive "Reconnecting..." overlay shared by LobbyScene and GameScene
 * (Epic 10). Renders as a semi-transparent black rectangle with centered
 * white text at the top of the canvas.
 *
 * Styled after SpectatorHUD / TurnHUD for visual consistency: top-center
 * position, rounded rect background, monospace white text with a black stroke.
 *
 * Non-interactive: no hit areas, no pointer handlers. The rectangle is a
 * Graphics drawable that doesn't respond to input, so taps pass through to
 * whatever scene UI is underneath (useful so the user can still see the
 * Leave button on reconnect failure).
 *
 * API:
 *   show(attempt?)    - "Reconnecting..."; appends "(attempt N)" if N>=1.
 *   showFinal(msg)    - final static message, e.g. "Lost connection.".
 *   hide()            - hides the overlay without destroying it.
 *   destroy()         - releases Phaser objects. Call in scene SHUTDOWN.
 */
export class ReconnectingOverlay {
  private readonly scene: Phaser.Scene;
  private readonly container: Phaser.GameObjects.Container;
  private readonly bg: Phaser.GameObjects.Graphics;
  private readonly text: Phaser.GameObjects.Text;
  private visible = false;

  private readonly PADDING_X = 20;
  private readonly PADDING_Y = 12;
  // Sits below the TurnHUD timer / SpectatorHUD banner so the three HUD
  // layers don't collide. TurnHUD: y=36. SpectatorHUD: y=90. This: y=140.
  private readonly TOP_Y = 140;

  constructor(init: ReconnectingOverlayInit) {
    this.scene = init.scene;
    const W = this.scene.scale.width;

    this.container = this.scene.add
      .container(W / 2, this.TOP_Y)
      .setDepth(200) // above HUD (depth 99/100)
      .setScrollFactor(0);

    this.bg = this.scene.add.graphics();
    this.text = this.scene.add
      .text(0, 0, "", {
        fontSize: "22px",
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
   * Show the "Reconnecting..." state. `attempt` is 1-indexed; values <= 0
   * omit the attempt suffix.
   */
  show(attempt?: number): void {
    const base = "Reconnecting...";
    const msg = attempt && attempt >= 1 ? `${base} (attempt ${attempt})` : base;
    this.render(msg);
  }

  /**
   * Display a final static message (e.g. "Lost connection. Returning home.").
   * Visually identical to show() but no attempt counter.
   */
  showFinal(msg: string): void {
    this.render(msg);
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

  private render(msg: string): void {
    this.text.setText(msg);
    const tw = this.text.width;
    const th = this.text.height;
    this.bg.clear();
    this.bg.fillStyle(0x000000, 0.75);
    this.bg.fillRoundedRect(
      -tw / 2 - this.PADDING_X,
      -th / 2 - this.PADDING_Y,
      tw + this.PADDING_X * 2,
      th + this.PADDING_Y * 2,
      8,
    );
    this.container.setVisible(true);
    this.visible = true;
  }
}
