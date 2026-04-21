import type * as Phaser from "phaser";
import type { WeaponConfig } from "../weapons/types";

interface WeaponDrawerInit {
  scene: Phaser.Scene;
  weapons: WeaponConfig[];
  onSelect: (id: string) => void;
  getAmmo: (id: string) => number;
  getSelectedId: () => string;
  getTeamColor: () => number;
}

interface IconEntry {
  x: number;
  y: number;
  gfx: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  zone: Phaser.GameObjects.Zone;
  weaponId: string;
}

/**
 * Bottom-center weapon icon drawer. N icons (N=3 for 6a), 56x56 tap targets,
 * team-color glow on selected, 100ms alpha tween on select change.
 *
 * Each icon has its own Graphics object so individual alpha tweens don't conflict.
 * The selection glow/ring is drawn each frame on a separate selectionGfx layer.
 */
export class WeaponDrawer {
  private readonly scene: Phaser.Scene;
  private readonly getSelectedId: () => string;
  private readonly getTeamColor: () => number;

  private readonly panelShadowGfx: Phaser.GameObjects.Graphics;
  private readonly panelGfx: Phaser.GameObjects.Graphics;
  private readonly selectionGfx: Phaser.GameObjects.Graphics;
  private readonly icons: IconEntry[] = [];
  private readonly iconsById = new Map<string, IconEntry>();

  private lastSelectedId = "";

  // Panel geometry (computed in constructor, used in update)
  private readonly panelX: number;
  private readonly panelY: number;
  private readonly panelW: number;
  private readonly panelH = 72;

  constructor(init: WeaponDrawerInit) {
    this.scene = init.scene;
    void init.getAmmo; // reserved for 6b ammo display overlay
    this.getSelectedId = init.getSelectedId;
    this.getTeamColor = init.getTeamColor;

    const { weapons } = init;
    const N = weapons.length;
    const sceneW = this.scene.scale.width;
    const sceneH = this.scene.scale.height;

    // Panel dimensions: 56px icon + 8px gap per slot, 20px horizontal padding
    this.panelW = 56 * N + 8 * (N - 1) + 20;
    this.panelX = Math.floor((sceneW - this.panelW) / 2);
    this.panelY = sceneH - 12 - this.panelH;

    // Panel shadow (depth 90, offset +2 down)
    this.panelShadowGfx = this.scene.add.graphics();
    this.panelShadowGfx.setDepth(90).setScrollFactor(0);
    this.panelShadowGfx.fillStyle(0x000000, 0.35);
    this.panelShadowGfx.fillRoundedRect(
      this.panelX + 2,
      this.panelY + 2,
      this.panelW,
      this.panelH,
      12,
    );

    // Panel main (depth 91)
    this.panelGfx = this.scene.add.graphics();
    this.panelGfx.setDepth(91).setScrollFactor(0);
    this.panelGfx.fillStyle(0x111111, 0.82);
    this.panelGfx.fillRoundedRect(this.panelX, this.panelY, this.panelW, this.panelH, 12);

    // Build icons - one Graphics per icon so alpha tweens work independently
    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (!weapon) continue;
      const iconX = this.panelX + 10 + i * (56 + 8);
      const iconY = this.panelY + 8;

      // Icon Graphics (depth 92)
      const gfx = this.scene.add.graphics();
      gfx.setDepth(92).setScrollFactor(0);
      this.drawIconBase(gfx, weapon, iconX, iconY);
      // Start unselected - faded
      gfx.setAlpha(0.4);

      // Label text (depth 93)
      const label = this.scene.add
        .text(iconX + 28, iconY + 28, weapon.iconLabel, {
          fontSize: "20px",
          fontFamily: "monospace",
          color: "#888888",
        })
        .setOrigin(0.5, 0.5)
        .setDepth(93)
        .setScrollFactor(0);

      // Interactive zone for tap-to-select (depth 94 area, but zone doesn't render)
      const zone = this.scene.add
        .zone(iconX + 28, iconY + 28, 56, 56)
        .setInteractive()
        .setScrollFactor(0);

      const weaponId = weapon.id;
      zone.on("pointerdown", () => {
        init.onSelect(weaponId);
      });

      const entry: IconEntry = { x: iconX, y: iconY, gfx, label, zone, weaponId };
      this.icons.push(entry);
      this.iconsById.set(weapon.id, entry);
    }

    // Selection glow + ring layer (depth 94) - cleared and redrawn each frame
    this.selectionGfx = this.scene.add.graphics();
    this.selectionGfx.setDepth(94).setScrollFactor(0);
  }

  /**
   * Call each frame. Redraws the selection glow/ring; detects selection
   * changes and triggers alpha tweens.
   */
  update(): void {
    const currentId = this.getSelectedId();

    // Handle selection change - tween old icon out, new icon in
    if (currentId !== this.lastSelectedId) {
      const oldEntry = this.iconsById.get(this.lastSelectedId);
      if (oldEntry) {
        this.scene.tweens.killTweensOf(oldEntry.gfx);
        this.scene.tweens.add({
          targets: oldEntry.gfx,
          alpha: 0.4,
          duration: 100,
          ease: "Linear",
        });
        oldEntry.label.setColor("#888888");
      }

      const newEntry = this.iconsById.get(currentId);
      if (newEntry) {
        this.scene.tweens.killTweensOf(newEntry.gfx);
        this.scene.tweens.add({
          targets: newEntry.gfx,
          alpha: 1.0,
          duration: 100,
          ease: "Linear",
        });
        newEntry.label.setColor("#ffffff");
      }

      this.lastSelectedId = currentId;
    }

    // Redraw selection glow + ring each frame
    this.selectionGfx.clear();
    const selected = this.iconsById.get(currentId);
    if (selected) {
      const teamColor = this.getTeamColor();
      // Glow layer (behind icon)
      this.selectionGfx.fillStyle(teamColor, 0.22);
      this.selectionGfx.fillRoundedRect(selected.x - 4, selected.y - 4, 64, 64, 10);
      // Ring
      this.selectionGfx.lineStyle(2.5, 0xffee00, 1.0);
      this.selectionGfx.strokeRoundedRect(selected.x - 3, selected.y - 3, 62, 62, 10);
    }
  }

  /**
   * Returns true if the pointer is inside any icon's 56x56 bounding rect.
   * Used by GameScene's pointerdown chain to skip drag-to-aim when a drawer
   * icon is tapped.
   */
  hitsIcon(p: Phaser.Input.Pointer): boolean {
    for (const icon of this.icons) {
      if (p.x >= icon.x && p.x <= icon.x + 56 && p.y >= icon.y && p.y <= icon.y + 56) {
        return true;
      }
    }
    return false;
  }

  destroy(): void {
    this.selectionGfx.destroy();
    this.panelGfx.destroy();
    this.panelShadowGfx.destroy();
    for (const icon of this.icons) {
      icon.gfx.destroy();
      icon.label.destroy();
      icon.zone.destroy();
    }
    this.icons.length = 0;
    this.iconsById.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Draw the static icon base (fill + bevel strip). Alpha controlled externally. */
  private drawIconBase(
    gfx: Phaser.GameObjects.Graphics,
    weapon: WeaponConfig,
    iconX: number,
    iconY: number,
  ): void {
    // Base fill - color at full opacity; alpha tween on the Graphics object dims it
    gfx.fillStyle(weapon.iconColor, 1.0);
    gfx.fillRoundedRect(iconX, iconY, 56, 56, 8);

    // Bevel strip at top of icon
    gfx.fillStyle(0xffffff, 0.12);
    gfx.fillRect(iconX + 4, iconY + 4, 48, 6);
  }
}
