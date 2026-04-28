/**
 * Object catalog. Sibling to the weapons registry (src/weapons/) but shared
 * between worker and client because both server (sim spawn/damage logic) and
 * client (sprite rendering) consume the catalog.
 *
 * To add a new prop type: add an entry here, possibly add a new sprite asset,
 * and (for behaviors not expressible by data) add a kind branch in
 * worker/src/entities/objects/<kind>.ts.
 */

export interface ObjectConfig {
  /** Catalog id. Matches ObjectRenderState.kind. */
  kind: string;
  /** Sprite key loaded by the client. Matches an Aseprite atlas key. */
  sprite: string;
  /** Hitbox in pixels. Used to build the planck body fixture. */
  hitbox: { widthPx: number; heightPx: number };
  /** Initial HP. 0 means indestructible. */
  hp: number;
  /** Whether the body is static (immovable) or dynamic (gravity-affected). */
  bodyType: "static" | "dynamic";
  /** Optional: explosion on destroy. */
  onDestroy?: { explode: { damagePx: number; radiusPx: number } };
}

export const OBJECT_CATALOG: Record<string, ObjectConfig> = {
  barrel: {
    kind: "barrel",
    sprite: "barrel",
    hitbox: { widthPx: 24, heightPx: 32 },
    hp: 1,
    bodyType: "dynamic",
    onDestroy: { explode: { damagePx: 25, radiusPx: 60 } },
  },
};

export function getObjectConfig(kind: string): ObjectConfig | undefined {
  return OBJECT_CATALOG[kind];
}
