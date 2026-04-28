/**
 * Object catalog stub for WS-B (client rendering).
 *
 * WS-A (feature/object-interaction-server) will replace this with the
 * authoritative OBJECT_CATALOG and full ObjectConfig definitions at
 * integration time. This stub satisfies the type contract so the client
 * compiles independently.
 */

export interface ObjectConfig {
  kind: string;
  sprite: string;
  hitbox: { widthPx: number; heightPx: number };
  hp: number;
  bodyType: "static" | "dynamic";
  onDestroy?: { explode: { damagePx: number; radiusPx: number } };
}

export const OBJECT_CATALOG: Record<string, ObjectConfig> = {
  barrel: {
    kind: "barrel",
    sprite: "barrel",
    hitbox: { widthPx: 24, heightPx: 32 },
    hp: 50,
    bodyType: "dynamic",
    onDestroy: { explode: { damagePx: 40, radiusPx: 60 } },
  },
};

export function getObjectConfig(kind: string): ObjectConfig | undefined {
  return OBJECT_CATALOG[kind];
}
