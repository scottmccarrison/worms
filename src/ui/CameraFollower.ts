import type Phaser from "phaser";

export interface CameraFollowerInit {
  scene: Phaser.Scene;
}

/**
 * Decides what the camera follows. Between turns the camera is
 * controlled by TurnTransition. Within a turn, follows the active
 * worm by default. If a projectile spawns, detaches from the worm
 * and follows the projectile until it despawns; then returns to the
 * active worm.
 *
 * Multi-projectile case: sticks with the first followed projectile;
 * ignores subsequent spawns. When the followed projectile despawns
 * AND other projectiles still exist (e.g. cluster children), returns
 * to the worm rather than hopping to an arbitrary other projectile.
 */
export class CameraFollower {
  private readonly scene: Phaser.Scene;
  private activeWormTarget: Phaser.GameObjects.GameObject | null = null;
  private followedProjectileId: string | null = null;
  private suspended = false; // set true while TurnTransition owns the camera

  constructor(init: CameraFollowerInit) {
    this.scene = init.scene;
  }

  /** Called by GameScene when TurnTransition lands the camera on a worm at zoom-in completion. */
  setActiveWormTarget(target: Phaser.GameObjects.GameObject | null): void {
    this.activeWormTarget = target;
    // If we're currently following a worm (not projectile) and not suspended, swap to the new target.
    if (!this.suspended && this.followedProjectileId === null && target) {
      this.scene.cameras.main.startFollow(target, true, 0.08, 0.08);
    }
  }

  /** Called when TurnTransition starts + ends, so CameraFollower knows to yield or resume. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) {
      // Drop our tracking; TurnTransition owns the camera now.
      this.followedProjectileId = null;
    } else {
      // Resumed - return to active worm if we have one.
      if (this.activeWormTarget) {
        this.scene.cameras.main.startFollow(this.activeWormTarget, true, 0.08, 0.08);
      }
    }
  }

  /**
   * Called every frame with the current list of projectile gfx entries.
   * Only calls startFollow when the follow target changes - not every frame.
   */
  update(projectiles: ReadonlyArray<{ id: string; gfx: Phaser.GameObjects.GameObject }>): void {
    if (this.suspended) return;

    const followedStillExists =
      this.followedProjectileId !== null &&
      projectiles.some((p) => p.id === this.followedProjectileId);

    if (this.followedProjectileId !== null && !followedStillExists) {
      // Our followed projectile despawned. Return to worm.
      this.followedProjectileId = null;
      if (this.activeWormTarget) {
        this.scene.cameras.main.startFollow(this.activeWormTarget, true, 0.08, 0.08);
      }
      return;
    }

    if (this.followedProjectileId === null && projectiles.length > 0) {
      // No current follow target and a projectile just appeared - follow the first one.
      const first = projectiles[0];
      if (first) {
        this.followedProjectileId = first.id;
        this.scene.cameras.main.startFollow(first.gfx, true, 0.08, 0.08);
      }
    }
  }

  destroy(): void {
    // Nothing to clean up; camera follow state is owned by the scene lifecycle.
    this.activeWormTarget = null;
    this.followedProjectileId = null;
  }
}
