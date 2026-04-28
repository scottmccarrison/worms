/**
 * Abstract base for world-fixed and match-spawned objects.
 *
 * Mirrors the shape of Worm and Projectile: holds a planck body, exposes
 * toRenderState() for the wire, and handles destruction via a tombstone
 * flag. Concrete subclasses live in objects/<kind>.ts.
 */

import { Box } from "planck";
import type { Body, World } from "planck";
import { type ObjectConfig, getObjectConfig } from "../../../shared/objectCatalog.js";
import type { ObjectRenderState } from "../../../shared/protocol.js";
import { toMeters, toPixels } from "../physics/scale.js";

export interface ObjectInstanceInit {
  id: string;
  kind: string;
  world: World;
  xPx: number;
  yPx: number;
}

export interface ObjectUserData {
  kind: "object";
  object: ObjectInstance;
}

export class ObjectInstance {
  readonly id: string;
  readonly kind: string;
  readonly config: ObjectConfig;
  readonly body: Body;
  hp: number;
  dead: boolean = false;
  /**
   * Set by reap pass 1 once the destroy event + side effects have fired.
   * Pass 2 (next tick's reap) destroys the body and removes from the map.
   * Keeping a dead-but-not-tombstoned object in the map for one tick lets
   * the client see one SimState broadcast with dead=true, providing a
   * stable id to fade out instead of seeing the object vanish.
   */
  tombstoned: boolean = false;
  /** Cause set by destroy() for the broadcast. */
  destroyCause: "explode" | "open" | "remove" = "remove";
  /** Per-kind packed flags. Subclasses define bit semantics. */
  flags: number = 0;

  constructor(init: ObjectInstanceInit) {
    const config = getObjectConfig(init.kind);
    if (!config) throw new Error(`unknown object kind: ${init.kind}`);

    this.id = init.id;
    this.kind = init.kind;
    this.config = config;
    this.hp = config.hp;

    this.body = init.world.createBody({
      type: config.bodyType,
      position: { x: toMeters(init.xPx), y: toMeters(init.yPx) },
      fixedRotation: true,
    });

    this.body.createFixture({
      shape: new Box(
        toMeters(config.hitbox.widthPx / 2),
        toMeters(config.hitbox.heightPx / 2),
      ),
      density: 1,
      friction: 0.6,
      restitution: 0.1,
    });

    const userData: ObjectUserData = { kind: "object", object: this };
    this.body.setUserData(userData);
  }

  /** Apply damage. Marks dead if HP drops to 0. */
  takeDamage(amount: number): void {
    if (this.dead) return;
    if (this.config.hp === 0) return; // indestructible
    this.hp = Math.max(0, this.hp - amount);
    if (this.hp === 0) {
      this.dead = true;
      this.destroyCause = this.config.onDestroy ? "explode" : "remove";
    }
  }

  /** Mark dead with a specific cause. */
  destroy(cause: "explode" | "open" | "remove"): void {
    if (this.dead) return;
    this.dead = true;
    this.destroyCause = cause;
  }

  toRenderState(): ObjectRenderState {
    const pos = this.body.getPosition();
    const vel = this.body.getLinearVelocity();
    return {
      id: this.id,
      kind: this.kind,
      x: toPixels(pos.x),
      y: toPixels(pos.y),
      vx: toPixels(vel.x),
      vy: toPixels(vel.y),
      hp: this.hp,
      dead: this.dead,
      flags: this.flags,
    };
  }

  /** For SerializedSim during DO hibernation. */
  serialize(): { id: string; kind: string; x: number; y: number; vx: number; vy: number; hp: number; flags: number } {
    const state = this.toRenderState();
    return {
      id: state.id,
      kind: state.kind,
      x: state.x,
      y: state.y,
      vx: state.vx,
      vy: state.vy,
      hp: state.hp,
      flags: state.flags,
    };
  }
}
