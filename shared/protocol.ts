/**
 * Shared Worms room protocol (Epic 13).
 *
 * Imported by BOTH the Cloudflare Worker (worker/src/messages.ts re-exports
 * from this file) and the browser client (src/net/protocol.ts and
 * src/net/types.ts re-export from this file). Keeping the source of truth
 * at the repo root means both tsconfigs can include the shared glob
 * (../shared) without cross-project path aliases.
 *
 * Transport is hand-rolled JSON over a single hibernation-safe WebSocket per
 * client (no @colyseus/schema patch deltas). Full-state broadcast: every
 * lobby state change goes out as a "state" message with the complete
 * LobbyState snapshot. Total state is <1 KB so this is trivially cheap at
 * our scale.
 *
 * Unlike Colyseus MapSchema, LobbyState.players is a plain
 * Record<string, LobbyPlayer> keyed by sessionId. Iterate with
 * Object.values(state.players) on either side.
 */

// ---------------------------------------------------------------------------
// Shared state types
// ---------------------------------------------------------------------------

/**
 * 8-color palette mirrored to both client + worker. The picker hides taken
 * colors server-side; the client also filters for a snappier UI.
 */
export const ALLOWED_COLORS = [
  "#ff4444",
  "#4488ff",
  "#44dd44",
  "#ffdd44",
  "#dd44dd",
  "#44dddd",
  "#ff8844",
  "#aa88ff",
] as const;

export type AllowedColor = (typeof ALLOWED_COLORS)[number];

/**
 * Per-player lobby state. Keyed by `sessionId` in the top-level
 * `LobbyState.players` record.
 *
 * Epic 10 fields (`disconnected`, `disconnectGraceEndsAt`) drive the UI
 * banner + countdown for dropped owners. `joinedAt` is epoch ms, used to
 * sort the player list deterministically (host first, then join order).
 */
export interface LobbyPlayer {
  sessionId: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
  ownerOfTeamId: string;
  disconnected: boolean;
  disconnectGraceEndsAt: number;
  joinedAt: number;
}

/**
 * Top-level lobby state broadcast on every change.
 * Plain JSON object - no MapSchema / listen() surface.
 */
export interface LobbyState {
  code: string;
  phase: "lobby" | "playing" | "ended";
  hostSessionId: string;
  selectedMapId: string;
  /** Keyed by sessionId. Replaces Colyseus MapSchema. */
  players: Record<string, LobbyPlayer>;
  /** Canonical team rotation order, shuffled once on start_game. */
  teamOrder: string[];
  currentTeamId: string;
  currentWormId: string;
  turnSeq: number;
  turnEndsAt: number;
}

/**
 * Team bootstrap info sent in the `game_started` message.
 * `ownerSessionId` identifies which player controls the team; empty string
 * means unowned (auto-skipped by the server).
 */
export interface TeamInit {
  id: string;
  name: string;
  color: string;
  wormNames: string[];
  ownerSessionId: string;
}

/**
 * Serialized worm state for end-of-turn snapshots.
 * Position in pixels (converted from physics meters on send); velocity in m/s.
 */
export interface WormSnapshot {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
}

/**
 * Terrain cut applied during a turn. `seq` is a terrain-cut monotonic
 * counter (NOT the input seq); clients use it to dedupe duplicate
 * `turn_resolved` messages.
 */
export interface CircleCut {
  x: number;
  y: number;
  r: number;
  seq: number;
}

// ---------------------------------------------------------------------------
// Server -> client messages (discriminated by `type`)
// ---------------------------------------------------------------------------

/**
 * Epic 45 sim state broadcast. `tick` is a monotonic server tick
 * counter; `worms[]` + `projectiles[]` are full snapshots. Sent every
 * ~50ms (20Hz) while the game is in progress.
 *
 * Positions are meters (converted from physics body.getPosition()),
 * not pixels. Clients multiply by PX_PER_M (30) for rendering.
 */
export interface SimWormState {
  id: string;
  teamId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  facing: -1 | 1;
  aimAngle: number;
  aimPower: number;
  hp: number;
  alive: boolean;
  activeWeapon: string;
  ammoLeft: number;
}

export interface SimProjectileState {
  id: string;
  ownerId: string;
  type: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  fuseRemainingMs: number | null;
}

export interface SimState {
  tick: number;
  worms: SimWormState[];
  projectiles: SimProjectileState[];
}

/** Epic 45 VFX/audio trigger events, broadcast alongside sim_state. */
export interface TerrainCutEvent {
  type: "terrain_cut";
  x: number;
  y: number;
  r: number;
  seq: number;
}
export interface FireEvent {
  type: "fire_event";
  wormId: string;
  weaponId: string;
  angleRad: number;
  power: number;
  facing: -1 | 1;
}
export interface DamageEvent {
  type: "damage_event";
  wormId: string;
  amount: number;
  fromProjectileId: string | null;
  impact: { x: number; y: number };
}
export interface WormDiedEvent {
  type: "worm_died";
  wormId: string;
}

export type ServerMsg =
  | { type: "welcome"; sessionId: string; resumeToken: string; state: LobbyState }
  | { type: "state"; state: LobbyState }
  | { type: "game_started"; mapId: string; seed: number; teams: TeamInit[] }
  | { type: "game_over"; winnerTeamId: string | null }
  | ({ type: "sim_state" } & SimState)
  | TerrainCutEvent
  | FireEvent
  | DamageEvent
  | WormDiedEvent
  | { type: "error"; code: string; message: string };

// DEPRECATED post-Epic-45: turn_resolved + input_* relays removed.
// Server owns sim authoritatively and broadcasts sim_state at 20Hz.
// Clients no longer see echoed inputs; they render from sim_state.

// ---------------------------------------------------------------------------
// Client -> server messages
// ---------------------------------------------------------------------------

export type ClientMsg =
  | { type: "set_nickname"; nickname: string }
  | { type: "set_color"; color: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "select_map"; mapId: string }
  | { type: "start_game" }
  // Input messages: server-authoritative. Post-Epic-45 these are NOT
  // relayed back to other clients; the server applies them to the
  // authoritative sim and everyone sees the result via sim_state.
  | { type: "input_walk"; dir: -1 | 0 | 1; seq: number }
  | { type: "input_jump"; seq: number }
  | { type: "input_backflip"; seq: number }
  | { type: "input_aim_angle"; angleRad: number; seq: number }
  | { type: "input_aim_power"; power: number; seq: number }
  | { type: "input_select_weapon"; weaponId: string; seq: number }
  | { type: "input_fire"; seq: number }
  | { type: "input_end_turn"; seq: number }
  | { type: "leave" };
