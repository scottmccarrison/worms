import type * as Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";
import { allWeapons, getById } from "../weapons/registry";

export interface WeaponRadialInit {
  scene: Phaser.Scene;
  sim: SimAdapter;
  /** Callback to get the currently-selected weapon id so the trigger can show its icon. */
  getSelectedWeaponId: () => string;
  /** Callback to get remaining ammo for a weapon id, for dimmed/out-of-ammo display. */
  getAmmoFor: (id: string) => number;
}

type State = "CLOSED" | "OPEN" | "CLOSING";

// Tunable constants - easy to migrate to tuning.ts later
const TRIGGER_RADIUS = 34;
const ICON_RADIUS = 26;
const ORBIT_RADIUS = 130;
const ARC_START_DEG = 90; // straight up
const ARC_SPAN_DEG = 90; // 90-degree fan to the left
const EXPAND_MS = 160;
const COLLAPSE_MS = 140;
const TRIGGER_HIT_RADIUS = 40; // gating radius for hitsRadial when CLOSED

interface IconNode {
  weaponId: string;
  container: Phaser.GameObjects.Container;
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  ring: Phaser.GameObjects.Arc;
  angleDeg: number;
  targetX: number;
  targetY: number;
}

/**
 * Bottom-right radial weapon picker.
 *
 * Tap the trigger: icons fan out on a 90-degree arc fanning up-and-left from
 * the trigger (90 deg = straight up, 180 deg = straight left). Drag finger to
 * angle at an icon - the nearest icon highlights. Release to commit the
 * selection; icons tween back to the trigger.
 *
 * Keyboard 1-9 still works directly via GameScene (this widget does not own
 * keyboard handling).
 *
 * Design notes:
 * - Icons are plain Phaser shapes (fill circle + letter text) matching the
 *   rest of the UI aesthetic. No sprite assets.
 * - Out-of-ammo weapons render dimmed (alpha 0.4).
 * - If only 1 weapon exists, the radial opens but just shows that one icon.
 */
export class WeaponRadial {
  private readonly scene: Phaser.Scene;
  private readonly sim: SimAdapter;
  private readonly getSelectedWeaponId: () => string;
  private readonly getAmmoFor: (id: string) => number;

  private readonly container: Phaser.GameObjects.Container;
  private readonly trigger: Phaser.GameObjects.Container;
  private readonly iconNodes: IconNode[] = [];

  private state: State = "CLOSED";
  private activePointerId: number | null = null;
  private highlightedIdx = -1;
  private lastSelectedId = "";

  constructor(init: WeaponRadialInit) {
    this.scene = init.scene;
    this.sim = init.sim;
    this.getSelectedWeaponId = init.getSelectedWeaponId;
    this.getAmmoFor = init.getAmmoFor;

    const w = this.scene.scale.width;
    const h = this.scene.scale.height;
    const triggerX = w - 80;
    const triggerY = h - 80;

    this.container = this.scene.add.container(triggerX, triggerY);
    this.container.setDepth(100).setScrollFactor(0);

    // --- Trigger button ---
    this.trigger = this.scene.add.container(0, 0);
    const triggerBg = this.scene.add.circle(0, 0, TRIGGER_RADIUS, 0x222233, 0.9);
    triggerBg.setStrokeStyle(2, 0x88aaff, 1);
    const triggerCurrentIcon = this.scene.add.circle(0, 0, 18, 0xaaaaaa, 1.0);
    const triggerLabel = this.scene.add
      .text(0, 0, "W", {
        fontSize: "18px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        fontStyle: "bold",
      })
      .setOrigin(0.5);

    this.trigger.add([triggerBg, triggerCurrentIcon, triggerLabel]);
    // Store refs for updateTriggerDisplay
    (
      this.trigger as Phaser.GameObjects.Container & {
        _currentIcon: Phaser.GameObjects.Arc;
        _currentLabel: Phaser.GameObjects.Text;
      }
    )._currentIcon = triggerCurrentIcon;
    (
      this.trigger as Phaser.GameObjects.Container & {
        _currentIcon: Phaser.GameObjects.Arc;
        _currentLabel: Phaser.GameObjects.Text;
      }
    )._currentLabel = triggerLabel;

    this.container.add(this.trigger);

    // --- Hit zone for the trigger (generous for thumb) ---
    const hit = this.scene.add
      .zone(0, 0, 80, 80)
      .setOrigin(0.5)
      .setInteractive({ useHandCursor: true });
    this.container.add(hit);
    hit.on("pointerdown", (p: Phaser.Input.Pointer) => {
      this.onTriggerDown(p);
    });

    // --- Icon nodes ---
    this.buildIconNodes();

    // --- Global pointer events for drag handling ---
    this.scene.input.on("pointermove", this.onPointerMove, this);
    this.scene.input.on("pointerup", this.onPointerUp, this);

    this.updateTriggerDisplay();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Call each frame to refresh the trigger icon when selection changes externally. */
  update(): void {
    this.updateTriggerDisplay();
  }

  /**
   * Returns true if the given pointer is within the radial trigger or an
   * expanded icon. GameScene uses this to gate walk/aim gestures so a
   * radial tap does not double-fire as a walk.
   */
  hitsRadial(p: Phaser.Input.Pointer): boolean {
    if (this.state === "CLOSED") {
      const dx = p.x - this.container.x;
      const dy = p.y - this.container.y;
      return dx * dx + dy * dy < TRIGGER_HIT_RADIUS * TRIGGER_HIT_RADIUS;
    }
    // While open or closing, radial owns the pointer that opened it.
    return this.activePointerId === p.id;
  }

  destroy(): void {
    this.scene.input.off("pointermove", this.onPointerMove, this);
    this.scene.input.off("pointerup", this.onPointerUp, this);
    this.container.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private - icon construction
  // ---------------------------------------------------------------------------

  private buildIconNodes(): void {
    const weapons = allWeapons();
    const positions = this.computeIconPositions(weapons.length);

    for (let i = 0; i < weapons.length; i++) {
      const weapon = weapons[i];
      if (!weapon) continue;
      const pos = positions[i];
      if (!pos) continue;

      const iconContainer = this.scene.add.container(0, 0);
      iconContainer.setAlpha(0);

      const circle = this.scene.add.circle(0, 0, ICON_RADIUS, weapon.iconColor, 1.0);

      const ring = this.scene.add.circle(0, 0, ICON_RADIUS + 4, 0xffee00, 0);
      ring.setStrokeStyle(2.5, 0xffee00, 0);

      const label = this.scene.add
        .text(0, 0, weapon.iconLabel, {
          fontSize: "16px",
          color: "#ffffff",
          fontFamily: "monospace",
          fontStyle: "bold",
        })
        .setOrigin(0.5);

      iconContainer.add([ring, circle, label]);
      this.container.add(iconContainer);

      this.iconNodes.push({
        weaponId: weapon.id,
        container: iconContainer,
        circle,
        label,
        ring,
        angleDeg: pos.angleDeg,
        targetX: pos.x,
        targetY: pos.y,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private - math
  // ---------------------------------------------------------------------------

  /**
   * Compute icon positions on the arc.
   * Arc: 90 deg (up) to 180 deg (left) in standard math convention.
   * Phaser y increases downward so y = -ORBIT_RADIUS * sin(angle).
   *
   * For n == 1: single icon at 135 deg (midpoint).
   * For n >= 2: evenly spaced from ARC_START_DEG to ARC_START_DEG + ARC_SPAN_DEG.
   */
  computeIconPositions(n: number): Array<{ x: number; y: number; angleDeg: number }> {
    if (n === 0) return [];
    if (n === 1) {
      const angle = 135;
      const rad = (angle * Math.PI) / 180;
      return [
        {
          x: ORBIT_RADIUS * Math.cos(rad),
          y: -ORBIT_RADIUS * Math.sin(rad),
          angleDeg: angle,
        },
      ];
    }
    const result: Array<{ x: number; y: number; angleDeg: number }> = [];
    for (let i = 0; i < n; i++) {
      const angle = ARC_START_DEG + (ARC_SPAN_DEG / (n - 1)) * i;
      const rad = (angle * Math.PI) / 180;
      result.push({
        x: ORBIT_RADIUS * Math.cos(rad),
        y: -ORBIT_RADIUS * Math.sin(rad),
        angleDeg: angle,
      });
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Private - pointer handling
  // ---------------------------------------------------------------------------

  private onTriggerDown(p: Phaser.Input.Pointer): void {
    if (this.state !== "CLOSED") return;
    this.activePointerId = p.id;
    this.highlightedIdx = -1;
    this.state = "OPEN";
    this.openRadial();
  }

  private onPointerMove(p: Phaser.Input.Pointer): void {
    if (this.state !== "OPEN") return;
    if (p.id !== this.activePointerId) return;
    this.highlightAtAngle(p);
  }

  private onPointerUp(p: Phaser.Input.Pointer): void {
    if (this.state !== "OPEN") return;
    if (p.id !== this.activePointerId) return;

    if (this.highlightedIdx >= 0) {
      const node = this.iconNodes[this.highlightedIdx];
      if (node) {
        this.sim.selectWeapon(node.weaponId);
      }
    }

    this.collapseToIdle();
  }

  // ---------------------------------------------------------------------------
  // Private - open / close animations
  // ---------------------------------------------------------------------------

  private openRadial(): void {
    for (let i = 0; i < this.iconNodes.length; i++) {
      const node = this.iconNodes[i];
      if (!node) continue;

      node.container.setPosition(0, 0);
      node.container.setAlpha(0);

      const ammo = this.getAmmoFor(node.weaponId);
      const outOfAmmo = ammo === 0;
      node.circle.setAlpha(outOfAmmo ? 0.4 : 1.0);
      this.clearHighlight(node);

      this.scene.tweens.add({
        targets: node.container,
        x: node.targetX,
        y: node.targetY,
        alpha: outOfAmmo ? 0.6 : 1.0,
        duration: EXPAND_MS,
        ease: "Back.Out",
        delay: i * 15,
      });
    }
  }

  private collapseToIdle(): void {
    this.state = "CLOSING";
    const nodes = this.iconNodes;
    let remaining = nodes.length;

    if (remaining === 0) {
      this.state = "CLOSED";
      this.activePointerId = null;
      this.highlightedIdx = -1;
      return;
    }

    for (const node of nodes) {
      this.clearHighlight(node);
      this.scene.tweens.add({
        targets: node.container,
        x: 0,
        y: 0,
        alpha: 0,
        duration: COLLAPSE_MS,
        ease: "Quad.In",
        onComplete: () => {
          remaining--;
          if (remaining === 0) {
            this.state = "CLOSED";
            this.activePointerId = null;
            this.highlightedIdx = -1;
          }
        },
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Private - highlight logic
  // ---------------------------------------------------------------------------

  /**
   * Given a pointer position (in screen space), find the icon whose assigned
   * angle is closest and highlight it. Requires pointer to be at least 40px
   * from trigger center to avoid jitter near the origin.
   */
  private highlightAtAngle(p: Phaser.Input.Pointer): void {
    // Pointer relative to trigger center (container is at trigger position)
    const dx = p.x - this.container.x;
    const dy = p.y - this.container.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    // Too close to origin - keep existing highlight, don't jitter
    if (dist < 40) return;

    // Compute angle in standard math convention (y flipped for Phaser)
    // atan2 with -dy because Phaser y is down
    const pointerAngleRad = Math.atan2(-dy, dx);
    const pointerAngleDeg = (pointerAngleRad * 180) / Math.PI;

    let bestIdx = -1;
    let bestDiff = Number.POSITIVE_INFINITY;

    for (let i = 0; i < this.iconNodes.length; i++) {
      const node = this.iconNodes[i];
      if (!node) continue;
      let diff = Math.abs(pointerAngleDeg - node.angleDeg);
      // Wrap-around difference
      if (diff > 180) diff = 360 - diff;
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    }

    if (bestIdx !== this.highlightedIdx) {
      // Clear old highlight
      if (this.highlightedIdx >= 0) {
        const old = this.iconNodes[this.highlightedIdx];
        if (old) this.clearHighlight(old);
      }
      // Apply new highlight
      if (bestIdx >= 0) {
        const node = this.iconNodes[bestIdx];
        if (node) this.applyHighlight(node);
      }
      this.highlightedIdx = bestIdx;
    }
  }

  private applyHighlight(node: IconNode): void {
    node.ring.setStrokeStyle(2.5, 0xffee00, 1);
    node.container.setScale(1.15);
  }

  private clearHighlight(node: IconNode): void {
    node.ring.setStrokeStyle(2.5, 0xffee00, 0);
    node.container.setScale(1.0);
  }

  // ---------------------------------------------------------------------------
  // Private - trigger display
  // ---------------------------------------------------------------------------

  private updateTriggerDisplay(): void {
    const selectedId = this.getSelectedWeaponId();
    if (selectedId === this.lastSelectedId) return;
    this.lastSelectedId = selectedId;

    const trig = this.trigger as Phaser.GameObjects.Container & {
      _currentIcon: Phaser.GameObjects.Arc;
      _currentLabel: Phaser.GameObjects.Text;
    };

    const weapon = getById(selectedId);
    if (weapon) {
      trig._currentIcon.setFillStyle(weapon.iconColor, 1.0);
      trig._currentLabel.setText(weapon.iconLabel);
    }
  }
}
