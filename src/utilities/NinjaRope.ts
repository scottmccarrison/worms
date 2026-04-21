import type * as Phaser from "phaser";
import type { Body, World } from "planck";
import { DistanceJoint } from "planck";
import { toPixels } from "../physics/scale";
import { tuning } from "../tuning";
import type { Worm } from "../worm/Worm";
import { raycastFirstTerrain } from "./ropeRaycast";
import type { Utility } from "./types";

type RopeState = "inactive" | "attached";

export interface NinjaRopeInit {
  scene: Phaser.Scene;
  world: World;
  worm: Worm;
}

/**
 * Single-joint ninja rope. One DistanceJoint directly from worm to a static
 * anchor at the raycast hit. Rope is visually a straight line worm -> anchor.
 * Extend/retract changes the joint length in fixed steps.
 *
 * Simpler + snappier than the chain-of-intermediates approach: rope is taut
 * from frame 1; worm starts swinging immediately under gravity.
 */
export class NinjaRope implements Utility {
  readonly worm: Worm;

  private state: RopeState = "inactive";
  private anchor: Body | null = null;
  private joint: DistanceJoint | null = null;
  private lengthM = 0;
  private readonly renderGfx: Phaser.GameObjects.Graphics;
  private readonly world: World;

  constructor(init: NinjaRopeInit) {
    this.worm = init.worm;
    this.world = init.world;
    this.renderGfx = init.scene.add.graphics();
    this.renderGfx.setDepth(8);
  }

  isActive(): boolean {
    return this.state === "attached";
  }

  /** Fire rope in current aim direction. No-op if already active or raycast misses. */
  activate(): void {
    if (this.state !== "inactive") return;

    const wormPos = this.worm.body.getPosition();
    const angle = this.worm.aimAngle;
    const facing = this.worm.facing;
    const dir = {
      x: Math.cos(angle) * facing,
      y: Math.sin(angle),
    };
    const len = Math.hypot(dir.x, dir.y);
    if (len < 0.001) return;
    dir.x /= len;
    dir.y /= len;

    const hit = raycastFirstTerrain(
      this.world,
      { x: wormPos.x, y: wormPos.y },
      dir,
      tuning.rope.maxReachM,
    );
    if (!hit) {
      console.log("[NinjaRope] raycast miss - no terrain in range");
      return;
    }

    // Static anchor at hit point.
    this.anchor = this.world.createBody({
      type: "static",
      position: hit.pointMeters,
    });
    if (!this.anchor) {
      console.error("[NinjaRope] failed to create anchor body");
      return;
    }
    this.anchor.setUserData({ kind: "rope-anchor" });

    // Compute current worm-anchor distance. Joint length starts slightly shorter
    // so the rope is under tension on frame 1 - pulls worm off the ground and
    // initiates the pendulum swing.
    const dx = hit.pointMeters.x - wormPos.x;
    const dy = hit.pointMeters.y - wormPos.y;
    const actualDistance = Math.hypot(dx, dy);
    this.lengthM = Math.max(
      actualDistance * tuning.rope.initialLengthScale,
      tuning.rope.minLengthM,
    );

    const joint = this.world.createJoint(
      new DistanceJoint(
        {
          frequencyHz: tuning.rope.jointFreqHz,
          dampingRatio: tuning.rope.dampingRatio,
          length: this.lengthM,
        },
        this.anchor,
        this.worm.body,
        hit.pointMeters,
        wormPos,
      ),
    );
    if (!joint) {
      console.error("[NinjaRope] createJoint returned null");
      this.world.destroyBody(this.anchor);
      this.anchor = null;
      return;
    }
    this.joint = joint as DistanceJoint;

    // Kick the worm toward the anchor so it breaks off the ground and the
    // pendulum has some initial velocity to swing with.
    if (actualDistance > 0.001) {
      const invDist = 1 / actualDistance;
      const impulseMag = tuning.rope.fireImpulseMag;
      this.worm.body.applyLinearImpulse(
        { x: dx * invDist * impulseMag, y: dy * invDist * impulseMag },
        this.worm.body.getPosition(),
        true,
      );
    }

    this.worm.setActiveRope(this);
    this.state = "attached";
  }

  deactivate(): void {
    if (this.joint) {
      try {
        this.world.destroyJoint(this.joint);
      } catch (_e) {
        /* joint may already be gone */
      }
      this.joint = null;
    }
    if (this.anchor?.isActive()) {
      try {
        this.world.destroyBody(this.anchor);
      } catch (_e) {
        /* body may already be gone */
      }
    }
    this.anchor = null;
    this.lengthM = 0;
    this.worm.setActiveRope(null);
    this.state = "inactive";
    this.renderGfx.clear();
  }

  /**
   * Change rope length by deltaM (positive = extend, negative = retract).
   * Called each frame from InputController while up/down is held; deltaM is
   * scaled by dt so change is smooth frame-to-frame instead of discrete steps.
   */
  adjust(deltaM: number): void {
    if (this.state !== "attached" || !this.joint) return;
    const next = this.lengthM + deltaM;
    this.lengthM = Math.max(tuning.rope.minLengthM, Math.min(next, tuning.rope.maxReachM));
    this.joint.setLength(this.lengthM);
  }

  update(_dtMs: number): void {
    if (this.state !== "attached" || !this.anchor) return;

    this.renderGfx.clear();
    this.renderGfx.lineStyle(2, 0xffffff, 0.9);
    const a = this.anchor.getPosition();
    const w = this.worm.body.getPosition();
    this.renderGfx.beginPath();
    this.renderGfx.moveTo(toPixels(a.x), toPixels(a.y));
    this.renderGfx.lineTo(toPixels(w.x), toPixels(w.y));
    this.renderGfx.strokePath();
  }

  destroy(): void {
    this.deactivate();
    this.renderGfx.destroy();
  }
}
