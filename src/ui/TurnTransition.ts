import type Phaser from "phaser";
import type { SimAdapter } from "../sim/SimAdapter";
import { tuning } from "../tuning";

export interface TurnTransitionInit {
  scene: Phaser.Scene;
  sim: SimAdapter;
  worldWidthPx: number;
  worldHeightPx: number;
  /** Resolve the GameObject the camera should follow at zoom-in completion. */
  resolveFollowTarget: (wormId: string) => Phaser.GameObjects.GameObject | null;
  /** Called when transitioning state changes (for input gating). */
  onTransitioningChanged: (transitioning: boolean) => void;
}

type State = "IDLE" | "ZOOMING_OUT" | "HOLDING" | "ZOOMING_IN";

/**
 * Owns the camera's turn-change animation: zoom out to world, hold
 * for a min dwell (stretched adaptively while networked state is
 * stabilizing), then zoom back in on the new active worm. Input is
 * gated OFF for the duration.
 *
 * Integrates with SimAdapter.onStateStable to know when the server's
 * next-turn state has settled (networked mode) or always-stable
 * (offline).
 */
export class TurnTransition {
  private readonly scene: Phaser.Scene;
  private readonly sim: SimAdapter;
  private readonly worldWidthPx: number;
  private readonly worldHeightPx: number;
  private readonly resolveFollowTarget: (wormId: string) => Phaser.GameObjects.GameObject | null;
  private readonly onTransitioningChanged: (t: boolean) => void;
  private readonly unsubStable: () => void;

  private state: State = "IDLE";
  private pendingWormId: string | null = null;
  private stableObserved = false;
  private minHoldTimer: ReturnType<typeof setTimeout> | null = null;
  private maxHoldTimer: ReturnType<typeof setTimeout> | null = null;
  // Monotonic id for the current transition. Incremented on every begin()
  // and cancel(). Tween callbacks and delayedCalls capture this value in
  // closure and compare before acting, so a stale callback from a
  // superseded transition can't flip state on a live one.
  private generation = 0;
  // Handle for the delayedCall scheduled in the null-target path of
  // enterZoomingIn. Must be cleared on cancel(); otherwise a late fire
  // could drop the live transition back to IDLE.
  private zoomInDelayed: Phaser.Time.TimerEvent | null = null;

  constructor(init: TurnTransitionInit) {
    this.scene = init.scene;
    this.sim = init.sim;
    this.worldWidthPx = init.worldWidthPx;
    this.worldHeightPx = init.worldHeightPx;
    this.resolveFollowTarget = init.resolveFollowTarget;
    this.onTransitioningChanged = init.onTransitioningChanged;
    this.unsubStable = this.sim.onStateStable(() => this.handleStateStable());
  }

  /** Kick off a new transition. Cancels any in-flight animation. */
  begin(_teamId: string, wormId: string): void {
    this.cancel();
    this.generation += 1;
    const gen = this.generation;
    this.pendingWormId = wormId;
    this.stableObserved = false;
    this.setState("ZOOMING_OUT");
    this.onTransitioningChanged(true);

    const camera = this.scene.cameras.main;
    camera.stopFollow();

    const fitZoom = this.computeFitZoom();
    const centerX = this.worldWidthPx / 2;
    const centerY = this.worldHeightPx / 2;

    camera.zoomTo(fitZoom, tuning.camera.turnZoomOutMs, "Sine.easeInOut", true);
    camera.pan(
      centerX,
      centerY,
      tuning.camera.turnZoomOutMs,
      "Sine.easeInOut",
      true,
      (_c: Phaser.Cameras.Scene2D.Camera, progress: number) => {
        if (progress >= 1 && this.state === "ZOOMING_OUT" && gen === this.generation) {
          this.enterHolding();
        }
      },
    );
  }

  /** Cancel any in-flight animation and return to IDLE. */
  cancel(): void {
    if (this.state === "IDLE") return;
    // Bump generation so any pending tween / delayedCall callback is
    // invalidated and becomes a no-op when it eventually fires.
    this.generation += 1;
    const camera = this.scene.cameras.main;
    // Stop in-flight tweens by issuing an instantaneous pan/zoom at current state.
    camera.pan(
      camera.scrollX + camera.width / 2,
      camera.scrollY + camera.height / 2,
      0,
      "Linear",
      true,
    );
    camera.zoomTo(camera.zoom, 0, "Linear", true);
    if (this.minHoldTimer) clearTimeout(this.minHoldTimer);
    if (this.maxHoldTimer) clearTimeout(this.maxHoldTimer);
    if (this.zoomInDelayed) this.zoomInDelayed.remove(false);
    this.minHoldTimer = null;
    this.maxHoldTimer = null;
    this.zoomInDelayed = null;
    this.pendingWormId = null;
    this.stableObserved = false;
    this.setState("IDLE");
    this.onTransitioningChanged(false);
  }

  isTransitioning(): boolean {
    return this.state !== "IDLE";
  }

  destroy(): void {
    this.cancel();
    this.unsubStable();
  }

  // ---- Internal ----

  private setState(next: State): void {
    this.state = next;
  }

  private computeFitZoom(): number {
    const vw = this.scene.scale.width;
    const vh = this.scene.scale.height;
    return Math.min(vw / this.worldWidthPx, vh / this.worldHeightPx);
  }

  private enterHolding(): void {
    this.setState("HOLDING");

    // Minimum dwell timer
    this.minHoldTimer = setTimeout(() => {
      this.minHoldTimer = null;
      this.maybeLeaveHold();
    }, tuning.camera.turnHoldMinMs);

    // Maximum dwell safety cap (even if state never stabilizes)
    this.maxHoldTimer = setTimeout(() => {
      this.maxHoldTimer = null;
      this.stableObserved = true;
      this.maybeLeaveHold();
    }, tuning.camera.turnHoldMaxMs);
  }

  private handleStateStable(): void {
    if (this.state !== "HOLDING" && this.state !== "ZOOMING_OUT") return;
    this.stableObserved = true;
    if (this.state === "HOLDING") this.maybeLeaveHold();
  }

  private maybeLeaveHold(): void {
    if (this.state !== "HOLDING") return;
    if (!this.stableObserved) return;
    if (this.minHoldTimer !== null) return; // min hold not yet elapsed
    this.enterZoomingIn();
  }

  private enterZoomingIn(): void {
    if (this.maxHoldTimer) clearTimeout(this.maxHoldTimer);
    this.maxHoldTimer = null;
    this.setState("ZOOMING_IN");
    const gen = this.generation;

    const camera = this.scene.cameras.main;
    const target = this.pendingWormId ? this.resolveFollowTarget(this.pendingWormId) : null;

    if (!target) {
      // No target - fail gracefully back to idle without a zoom-in.
      camera.zoomTo(1, tuning.camera.turnZoomInMs, "Sine.easeInOut", true);
      this.zoomInDelayed = this.scene.time.delayedCall(tuning.camera.turnZoomInMs, () => {
        this.zoomInDelayed = null;
        if (gen === this.generation) this.finishToIdle(null);
      });
      return;
    }

    // target is a Phaser GameObject with x/y we can read
    const g = target as unknown as { x: number; y: number };
    camera.zoomTo(1, tuning.camera.turnZoomInMs, "Sine.easeInOut", true);
    camera.pan(
      g.x,
      g.y,
      tuning.camera.turnZoomInMs,
      "Sine.easeInOut",
      true,
      (_c: Phaser.Cameras.Scene2D.Camera, progress: number) => {
        if (progress >= 1 && this.state === "ZOOMING_IN" && gen === this.generation) {
          this.finishToIdle(target);
        }
      },
    );
  }

  private finishToIdle(followTarget: Phaser.GameObjects.GameObject | null): void {
    const camera = this.scene.cameras.main;
    if (followTarget) camera.startFollow(followTarget, true, 0.08, 0.08);
    this.pendingWormId = null;
    this.stableObserved = false;
    this.setState("IDLE");
    this.onTransitioningChanged(false);
  }
}
