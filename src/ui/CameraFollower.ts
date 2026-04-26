import type Phaser from "phaser";
import { tuning } from "../tuning";

export interface CameraFollowerInit {
  scene: Phaser.Scene;
  now?: () => number;
}

/**
 * Decides what the camera follows. Between turns the camera is
 * controlled by TurnTransition. Within a turn, follows the active
 * worm by default. If a projectile spawns, detaches from the worm
 * and follows the projectile until it despawns; then holds at the
 * impact site for postImpactLingerMs before returning to the worm.
 *
 * Multi-projectile case: sticks with the first followed projectile;
 * ignores subsequent spawns. When the followed projectile despawns
 * AND other projectiles still exist (e.g. cluster children), returns
 * to the worm rather than hopping to an arbitrary other projectile.
 *
 * Lerp values differ by target type:
 *   - worm: tuning.camera.wormLerp (0.08) - responsive
 *   - projectile: tuning.camera.projectileLerp (0.05) - smoother,
 *     masks per-frame jitter on fast-moving projectiles
 */
export class CameraFollower {
  private readonly scene: Phaser.Scene;
  private readonly now: () => number;
  private activeWormTarget: Phaser.GameObjects.GameObject | null = null;
  private followedProjectileId: string | null = null;
  private lingerUntilMs: number | null = null;
  private suspended = false; // set true while TurnTransition owns the camera
  private lastFollowedPos: { x: number; y: number } | null = null;

  constructor(init: CameraFollowerInit) {
    this.scene = init.scene;
    this.now = init.now ?? (() => Date.now());
  }

  private followWorm(target: Phaser.GameObjects.GameObject): void {
    const lerp = tuning.camera.wormLerp;
    this.scene.cameras.main.startFollow(target, true, lerp, lerp);
  }

  private followProjectile(target: Phaser.GameObjects.GameObject): void {
    const lerp = tuning.camera.projectileLerp;
    this.scene.cameras.main.startFollow(target, true, lerp, lerp);
  }

  /** Called by GameScene when TurnTransition lands the camera on a worm at zoom-in completion. */
  setActiveWormTarget(target: Phaser.GameObjects.GameObject | null): void {
    this.activeWormTarget = target;
    // If we're currently following a worm (not projectile) and not suspended, swap to the new target.
    if (
      !this.suspended &&
      this.followedProjectileId === null &&
      this.lingerUntilMs === null &&
      target
    ) {
      this.followWorm(target);
    }
  }

  /** Called when TurnTransition starts + ends, so CameraFollower knows to yield or resume. */
  setSuspended(suspended: boolean): void {
    this.suspended = suspended;
    if (suspended) {
      // Drop our tracking; TurnTransition owns the camera now.
      this.followedProjectileId = null;
      this.lingerUntilMs = null;
      this.lastFollowedPos = null;
    } else {
      // Resumed - return to active worm if we have one.
      if (this.activeWormTarget) {
        this.followWorm(this.activeWormTarget);
      }
    }
  }

  /**
   * Called every frame with the current list of projectile gfx entries.
   * Only calls startFollow when the follow target changes - not every frame.
   */
  update(projectiles: ReadonlyArray<{ id: string; gfx: Phaser.GameObjects.GameObject }>): void {
    if (this.suspended) return;

    // Linger phase: followed projectile is gone but we're holding the camera
    // at the impact site for a beat before returning to the worm.
    if (this.lingerUntilMs !== null) {
      if (projectiles.length > 0) {
        // New projectile appeared mid-linger - interrupt, follow the new one.
        this.lingerUntilMs = null;
        this.followedProjectileId = null;
        // fall through to "acquire first projectile" block below
      } else if (this.now() >= this.lingerUntilMs) {
        // Linger elapsed - return to worm.
        this.lingerUntilMs = null;
        this.followedProjectileId = null;
        if (this.activeWormTarget) this.followWorm(this.activeWormTarget);
        return;
      } else {
        // Still lingering. Camera is frozen (stopFollow was called), nothing to do.
        return;
      }
    }

    // Followed projectile just despawned - enter linger.
    if (this.followedProjectileId !== null) {
      const cur = projectiles.find((p) => p.id === this.followedProjectileId);
      if (cur) {
        // Cache position each frame so we know where to snap on despawn.
        const g = cur.gfx as unknown as { x: number; y: number };
        this.lastFollowedPos = { x: g.x, y: g.y };
        return;
      }
      // Followed projectile just despawned. Snap to last known position
      // so the impact VFX is visible regardless of camera lerp lag.
      const cam = this.scene.cameras.main;
      cam.stopFollow();
      if (this.lastFollowedPos) {
        cam.centerOn(this.lastFollowedPos.x, this.lastFollowedPos.y);
      }
      this.lastFollowedPos = null;
      this.lingerUntilMs = this.now() + tuning.camera.postImpactLingerMs;
      return;
    }

    // No current projectile follow target.
    if (projectiles.length > 0) {
      const first = projectiles[0];
      if (first) {
        this.followedProjectileId = first.id;
        const g = first.gfx as unknown as { x: number; y: number };
        this.lastFollowedPos = { x: g.x, y: g.y };
        this.followProjectile(first.gfx);
      }
    }
  }

  destroy(): void {
    // Nothing to clean up; camera follow state is owned by the scene lifecycle.
    this.activeWormTarget = null;
    this.followedProjectileId = null;
    this.lingerUntilMs = null;
    this.lastFollowedPos = null;
  }
}
