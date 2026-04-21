import type * as Phaser from "phaser";
import { Circle, DistanceJoint } from "planck";
import type { Body, Joint, World } from "planck";
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

export class NinjaRope implements Utility {
  readonly worm: Worm;

  private state: RopeState = "inactive";
  private anchor: Body | null = null;
  private readonly intermediates: Body[] = [];
  private readonly joints: Joint[] = [];
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

  /**
   * Fire rope in current aim direction. No-op if already active or raycast misses.
   */
  activate(): void {
    if (this.state !== "inactive") return;

    const wormPos = this.worm.body.getPosition();

    // Compute aim direction from aimAngle + facing
    const angle = this.worm.aimAngle;
    const facing = this.worm.facing;
    const dir = {
      x: Math.cos(angle) * facing,
      y: Math.sin(angle),
    };

    // Normalize
    const len = Math.sqrt(dir.x * dir.x + dir.y * dir.y);
    if (len < 0.001) return;
    dir.x /= len;
    dir.y /= len;

    // Raycast from worm center
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

    // Create static anchor body at hit point
    this.anchor = this.world.createBody({
      type: "static",
      position: hit.pointMeters,
    });
    if (!this.anchor) {
      console.error("[NinjaRope] failed to create anchor body");
      return;
    }
    this.anchor.setUserData({ kind: "rope-anchor" });

    // Calculate segment count
    const dx = wormPos.x - hit.pointMeters.x;
    const dy = wormPos.y - hit.pointMeters.y;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const rawN = Math.floor(distance / tuning.rope.segmentLengthM);
    const N = Math.max(rawN, tuning.rope.minSegments);

    // Build intermediate bodies
    let prevBody: Body = this.anchor;
    const anchorPos = hit.pointMeters;

    for (let i = 1; i < N; i++) {
      const t = i / N;
      const pos = {
        x: anchorPos.x + (wormPos.x - anchorPos.x) * t,
        y: anchorPos.y + (wormPos.y - anchorPos.y) * t,
      };

      const body = this.world.createBody({
        type: "dynamic",
        position: pos,
        fixedRotation: true,
      });

      if (!body) {
        console.error("[NinjaRope] failed to create intermediate body");
        this._cleanupPartialBuild();
        return;
      }

      body.createFixture({
        shape: new Circle(tuning.rope.intermediateRadiusM),
        density: 0.5,
        friction: 1.0,
        restitution: 0.0,
      });
      body.setUserData({ kind: "rope-segment" });
      this.intermediates.push(body);

      // Joint from prevBody to this intermediate
      const freqHz = i === N - 1 ? tuning.rope.finalJointFreqHz : tuning.rope.intermediateFreqHz;
      const joint = this.world.createJoint(
        new DistanceJoint(
          {
            frequencyHz: freqHz,
            dampingRatio: tuning.rope.dampingRatio,
            length: tuning.rope.segmentLengthM,
          },
          prevBody,
          body,
          prevBody.getPosition(),
          body.getPosition(),
        ),
      );

      if (!joint) {
        console.error("[NinjaRope] createJoint returned null during build");
        this._cleanupPartialBuild();
        return;
      }
      this.joints.push(joint);
      prevBody = body;
    }

    // Final joint from last intermediate (or anchor if N=1) to worm body
    const finalJoint = this.world.createJoint(
      new DistanceJoint(
        {
          frequencyHz: tuning.rope.finalJointFreqHz,
          dampingRatio: tuning.rope.dampingRatio,
          length: tuning.rope.segmentLengthM,
        },
        prevBody,
        this.worm.body,
        prevBody.getPosition(),
        this.worm.body.getPosition(),
      ),
    );

    if (!finalJoint) {
      console.error("[NinjaRope] createJoint returned null for final joint");
      this._cleanupPartialBuild();
      return;
    }
    this.joints.push(finalJoint);

    this.worm.setActiveRope(this);
    this.state = "attached";
  }

  /**
   * Detach and clean up all physics bodies and joints. Idempotent.
   */
  deactivate(): void {
    if (this.state === "inactive" && this.joints.length === 0 && this.anchor === null) return;

    // Destroy joints first (before bodies)
    for (const j of this.joints) {
      try {
        this.world.destroyJoint(j);
      } catch (_e) {
        // Joint may already be gone
      }
    }
    this.joints.length = 0;

    // Destroy intermediate bodies
    for (const b of this.intermediates) {
      if (b.isActive()) {
        try {
          this.world.destroyBody(b);
        } catch (_e) {
          // Body may already be gone
        }
      }
    }
    this.intermediates.length = 0;

    // Destroy anchor
    if (this.anchor?.isActive()) {
      try {
        this.world.destroyBody(this.anchor);
      } catch (_e) {
        // Body may already be gone
      }
    }
    this.anchor = null;

    this.worm.setActiveRope(null);
    this.state = "inactive";
    this.renderGfx.clear();
  }

  /**
   * Extend rope by one segment (up to maxSegments).
   */
  extend(): void {
    if (this.state !== "attached") return;
    // Total segments = intermediates count + 1 (final-to-worm)
    if (this.intermediates.length >= tuning.rope.maxSegments) return;

    // Remove last joint (the one to worm)
    const lastJoint = this.joints.pop();
    if (!lastJoint) return;
    try {
      this.world.destroyJoint(lastJoint);
    } catch (_e) {
      /* ignore */
    }

    // Last intermediate (or anchor if no intermediates)
    const lastBody =
      this.intermediates.length > 0
        ? this.intermediates[this.intermediates.length - 1]
        : this.anchor;

    if (!lastBody) return;

    // Create new body between lastBody and worm
    const lPos = lastBody.getPosition();
    const wPos = this.worm.body.getPosition();
    const midPos = {
      x: lPos.x + (wPos.x - lPos.x) * 0.5,
      y: lPos.y + (wPos.y - lPos.y) * 0.5,
    };

    const newBody = this.world.createBody({
      type: "dynamic",
      position: midPos,
      fixedRotation: true,
    });

    if (!newBody) {
      console.error("[NinjaRope] extend: failed to create body");
      // Rebuild the final joint to keep chain valid
      this._rebuildFinalJoint(lastBody);
      return;
    }

    newBody.createFixture({
      shape: new Circle(tuning.rope.intermediateRadiusM),
      density: 0.5,
      friction: 1.0,
      restitution: 0.0,
    });
    newBody.setUserData({ kind: "rope-segment" });
    this.intermediates.push(newBody);

    // Joint: lastBody -> newBody
    const j1 = this.world.createJoint(
      new DistanceJoint(
        {
          frequencyHz: tuning.rope.intermediateFreqHz,
          dampingRatio: tuning.rope.dampingRatio,
          length: tuning.rope.segmentLengthM * 0.5,
        },
        lastBody,
        newBody,
        lastBody.getPosition(),
        newBody.getPosition(),
      ),
    );
    if (!j1) {
      console.error("[NinjaRope] extend: j1 null");
      this.world.destroyBody(newBody);
      this.intermediates.pop();
      this._rebuildFinalJoint(lastBody);
      return;
    }
    this.joints.push(j1);

    // Final joint: newBody -> worm (same half-length as j1 for symmetric sag)
    const j2 = this.world.createJoint(
      new DistanceJoint(
        {
          frequencyHz: tuning.rope.finalJointFreqHz,
          dampingRatio: tuning.rope.dampingRatio,
          length: tuning.rope.segmentLengthM * 0.5,
        },
        newBody,
        this.worm.body,
        newBody.getPosition(),
        this.worm.body.getPosition(),
      ),
    );
    if (!j2) {
      console.error("[NinjaRope] extend: j2 null");
      this.world.destroyBody(newBody);
      this.intermediates.pop();
      this.world.destroyJoint(j1);
      this.joints.pop();
      this._rebuildFinalJoint(lastBody);
      return;
    }
    this.joints.push(j2);
  }

  /**
   * Retract rope by one segment (down to minSegments).
   */
  retract(): void {
    if (this.state !== "attached") return;
    if (this.intermediates.length <= tuning.rope.minSegments) return;

    // Remove last 2 joints (intermediate->last and last->worm)
    const j2 = this.joints.pop(); // final-to-worm
    const j1 = this.joints.pop(); // penultimate-to-last

    if (j2) {
      try {
        this.world.destroyJoint(j2);
      } catch (_e) {
        /* ignore */
      }
    }
    if (j1) {
      try {
        this.world.destroyJoint(j1);
      } catch (_e) {
        /* ignore */
      }
    }

    // Remove last intermediate body
    const lastBody = this.intermediates.pop();
    if (lastBody?.isActive()) {
      try {
        this.world.destroyBody(lastBody);
      } catch (_e) {
        /* ignore */
      }
    }

    // Rebuild final joint from penultimate (or anchor) to worm
    const newLastBody =
      this.intermediates.length > 0
        ? this.intermediates[this.intermediates.length - 1]
        : this.anchor;

    if (newLastBody) {
      this._rebuildFinalJoint(newLastBody);
    }
  }

  /** Per-frame: redraw rope line. */
  update(_dtMs: number): void {
    if (this.state !== "attached" || !this.anchor) return;

    this.renderGfx.clear();
    this.renderGfx.lineStyle(2, 0xffffff, 0.9);
    this.renderGfx.beginPath();

    const aPos = this.anchor.getPosition();
    this.renderGfx.moveTo(toPixels(aPos.x), toPixels(aPos.y));

    for (const seg of this.intermediates) {
      const sPos = seg.getPosition();
      this.renderGfx.lineTo(toPixels(sPos.x), toPixels(sPos.y));
    }

    const wPos = this.worm.body.getPosition();
    this.renderGfx.lineTo(toPixels(wPos.x), toPixels(wPos.y));
    this.renderGfx.strokePath();
  }

  /** Same as deactivate, but also destroys the graphics object. */
  destroy(): void {
    this.deactivate();
    this.renderGfx.destroy();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Destroy whatever partial state was created during a failed activate().
   * Called on any null return from createBody or createJoint before state
   * is set to "attached". Safe to call regardless of current state.
   */
  private _cleanupPartialBuild(): void {
    for (const j of this.joints) {
      try {
        this.world.destroyJoint(j);
      } catch (_e) {
        // Joint may already be gone
      }
    }
    this.joints.length = 0;
    for (const b of this.intermediates) {
      try {
        this.world.destroyBody(b);
      } catch (_e) {
        // Body may already be gone
      }
    }
    this.intermediates.length = 0;
    if (this.anchor) {
      try {
        this.world.destroyBody(this.anchor);
      } catch (_e) {
        // Body may already be gone
      }
      this.anchor = null;
    }
  }

  private _rebuildFinalJoint(fromBody: Body): void {
    const joint = this.world.createJoint(
      new DistanceJoint(
        {
          frequencyHz: tuning.rope.finalJointFreqHz,
          dampingRatio: tuning.rope.dampingRatio,
          length: tuning.rope.segmentLengthM,
        },
        fromBody,
        this.worm.body,
        fromBody.getPosition(),
        this.worm.body.getPosition(),
      ),
    );
    if (!joint) {
      console.error("[NinjaRope] _rebuildFinalJoint: createJoint returned null");
      this.deactivate();
      return;
    }
    this.joints.push(joint);
  }
}
