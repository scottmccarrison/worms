/**
 * Client-side Phaser sprite wrapping one ObjectRenderState.
 *
 * GameScene maintains a Map<id, ObjectSprite> and reconciles each tick:
 *   - state.objects has id we don't track   -> new ObjectSprite()
 *   - id is in our map but not in state     -> sprite.destroy()
 *   - id is in both                          -> sprite.applyState(state)
 */

import Phaser from "phaser";
import { getObjectConfig } from "../../shared/objectCatalog";
import type { ObjectRenderState } from "../../shared/protocol";

export class ObjectSprite extends Phaser.GameObjects.Sprite {
  private targetX: number;
  private targetY: number;

  constructor(scene: Phaser.Scene, state: ObjectRenderState) {
    const config = getObjectConfig(state.kind);
    if (!config) {
      console.warn(`ObjectSprite: unknown kind ${state.kind}, using fallback`);
    }
    const spriteKey = config?.sprite ?? "barrel";
    super(scene, state.x, state.y, spriteKey);
    scene.add.existing(this);
    this.targetX = state.x;
    this.targetY = state.y;
  }

  /** Called on every SimState reconciliation to lerp toward the new server state. */
  applyState(state: ObjectRenderState): void {
    this.targetX = state.x;
    this.targetY = state.y;
    if (state.dead) {
      this.setAlpha(0.5);
    } else {
      this.setAlpha(1);
    }
  }

  /** Called from the scene's update() at 60fps to interpolate between server snapshots. */
  interpolate(_dt: number): void {
    this.x = Phaser.Math.Linear(this.x, this.targetX, 0.3);
    this.y = Phaser.Math.Linear(this.y, this.targetY, 0.3);
  }

  playDestroyVfx(cause: "explode" | "open" | "remove"): void {
    if (cause === "explode") {
      this.scene.cameras.main.shake(150, 0.005);
    }
    this.destroy();
  }
}
