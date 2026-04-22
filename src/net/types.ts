/**
 * Client-facing protocol types. Source of truth is `shared/protocol.ts` at
 * the repo root (Epic 13) - this file is a thin re-export so existing
 * imports under `../net/types` keep working.
 *
 * The Colyseus-era MapSchema / listen / forEach surface is gone:
 * `LobbyState.players` is now a plain `Record<string, LobbyPlayer>`.
 * Iterate with `Object.values(state.players)`.
 */

export {
  ALLOWED_COLORS,
  type AllowedColor,
  type CircleCut,
  type ClientMsg,
  type DamageEvent,
  type FireEvent,
  type LobbyPlayer,
  type LobbyState,
  type ProjectileRenderState,
  type ServerMsg,
  type SimState,
  type TeamInit,
  type TerrainCutEvent,
  type WormDiedEvent,
  type WormRenderState,
  type WormSnapshot,
} from "../../shared/protocol";

import type { ClientMsg, ServerMsg } from "../../shared/protocol";

// ---------------------------------------------------------------------------
// Convenience aliases: narrow discriminated-union subtypes by the `type` tag
// so callers can annotate variables without repeating `Extract<...>`. Keeps
// existing import sites (`import type { GameOverMessage }`) compiling with
// minimal churn.
// ---------------------------------------------------------------------------

export type GameStartedMessage = Extract<ServerMsg, { type: "game_started" }>;
export type ErrorMessage = Extract<ServerMsg, { type: "error" }>;
export type TurnResolvedMessage = Extract<ServerMsg, { type: "turn_resolved" }>;
export type GameOverMessage = Extract<ServerMsg, { type: "game_over" }>;
export type TurnSnapshotMessage = Extract<ClientMsg, { type: "turn_snapshot" }>;

// Epic 45 server-authoritative sim messages.
export type SimStateMessage = Extract<ServerMsg, { type: "sim_state" }>;
export type TerrainCutMessage = Extract<ServerMsg, { type: "terrain_cut" }>;
export type FireEventMessage = Extract<ServerMsg, { type: "fire_event" }>;
export type DamageEventMessage = Extract<ServerMsg, { type: "damage_event" }>;
export type WormDiedMessage = Extract<ServerMsg, { type: "worm_died" }>;
