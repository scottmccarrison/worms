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
// Epic 45 - Server-authoritative sim protocol
// ---------------------------------------------------------------------------
//
// The `sim_state` message supersedes `turn_resolved` + per-input relays. At
// 20Hz the server emits a full snapshot of every worm + projectile plus the
// currently-active team/worm + authoritative turn timer. Clients keep a
// two-frame buffer and interpolate positions between them at 60fps.
//
// Coordinates are in PIXELS (client's native space). The server converts
// from planck meters at the broadcast boundary. This keeps the client
// renderer simple and matches the existing `WormSnapshot` convention.
//
// Events (terrain_cut / fire_event / damage_event / worm_died / game_over)
// are fire-and-forget VFX triggers. Clients emit sound, particles, screen
// shake etc. on receipt; the authoritative state continues to arrive via
// sim_state.

/**
 * Render-ready worm state. One entry per living-or-dead worm; `alive`
 * differentiates. Positions + velocities are in pixels / pixels-per-second.
 */
export interface WormRenderState {
  id: string;
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
  jetPackActive: boolean;
  jetPackFuel: number; // 0-100
}

/**
 * Render-ready projectile state. `fuseRemainingMs` is optional because
 * bullet / contact-detonation weapons don't have a fuse.
 */
export interface ProjectileRenderState {
  id: string;
  /** The worm that fired this projectile. */
  ownerId: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  type: string;
  /** Remaining fuse ms for timed weapons (grenade). `null` for contact-detonation. */
  fuseRemainingMs: number | null;
}

/**
 * Full sim snapshot at a given server tick. Broadcast at 20Hz.
 */
export interface SimState {
  tick: number;
  worms: WormRenderState[];
  projectiles: ProjectileRenderState[];
  activeTeamId: string;
  activeWormId: string;
  /** ms-epoch time at which the active turn ends (client ticks down locally). */
  turnEndsAt: number;
}

/**
 * Single terrain cut fired as an event. Visual mask + VFX only; server
 * owns the authoritative physics-body rebuild. `seq` is monotonic; clients
 * dedupe in case the transport retries.
 */
export interface TerrainCutEvent {
  x: number;
  y: number;
  r: number;
  seq: number;
}

/**
 * Fire event for VFX: muzzle flash, sound, camera shake. Spawn-and-track
 * is handled by sim_state's projectile list; this is just the trigger.
 */
export interface FireEvent {
  wormId: string;
  weaponId: string;
  angleRad: number;
  power: number;
  /** Worm facing at fire time. Drives muzzle-flash orientation. */
  facing: -1 | 1;
}

/**
 * Damage applied to a worm during a server tick. Feeds damage numbers +
 * blood particles.
 */
export interface DamageEvent {
  wormId: string;
  amount: number;
  /** Projectile id that caused the damage, or null for collision/fall damage. */
  fromProjectileId: string | null;
  impact: { x: number; y: number };
}

/**
 * Worm died on the server. Triggers death animation + scoreboard update.
 */
export interface WormDiedEvent {
  wormId: string;
}

// ---------------------------------------------------------------------------
// Server -> client messages (discriminated by `type`)
// ---------------------------------------------------------------------------

export type ServerMsg =
  | { type: "welcome"; sessionId: string; resumeToken: string; state: LobbyState }
  | { type: "state"; state: LobbyState }
  | {
      type: "game_started";
      mapId: string;
      seed: number;
      teams: TeamInit[];
      /** World dimensions (pixels). Clients create their visual terrain
       *  canvas at this size. */
      widthPx: number;
      heightPx: number;
      /** Authoritative map mask (base64 Uint8Array of solid/air bytes,
       *  widthPx * heightPx bytes, row-major). Clients decode + render. */
      mask: string;
      /** Surface spawn points derived from the mask. */
      spawnPoints: Array<{ xPx: number; yPx: number }>;
    }
  | { type: "game_over"; winnerTeamId: string | null }
  | ({ type: "sim_state" } & SimState)
  | ({ type: "terrain_cut" } & TerrainCutEvent)
  | ({ type: "fire_event" } & FireEvent)
  | ({ type: "damage_event" } & DamageEvent)
  | ({ type: "worm_died" } & WormDiedEvent)
  | { type: "error"; code: string; message: string };

// Note: Epic 9's per-input relay variants (input_walk/jump/etc as SERVER-SENT
// messages) + turn_resolved have been removed. Server runs an authoritative
// sim and emits sim_state + event messages only. Clients render from state.

// ---------------------------------------------------------------------------
// Client -> server messages
// ---------------------------------------------------------------------------

export type ClientMsg =
  | { type: "set_nickname"; nickname: string }
  | { type: "set_color"; color: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "select_map"; mapId: string }
  | {
      type: "start_game";
      /** Host-generated map geometry (base64 Uint8Array of solid/air bytes,
       *  WIDTH_PX * HEIGHT_PX bytes, row-major). Server uses this for
       *  physics and forwards it via game_started so all clients render
       *  pixel-identical terrain. Omitted for backcompat; server falls
       *  back to its flat test map. */
      mask?: string;
      /** Host-generated surface spawn points derived from the mask. */
      spawnPoints?: Array<{ xPx: number; yPx: number }>;
    }
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
  | { type: "input_jetpack_toggle"; seq: number }
  | { type: "input_jetpack_thrust"; active: boolean; seq: number }
  | { type: "input_jetpack_horizontal"; dir: -1 | 0 | 1; seq: number }
  | { type: "leave" };
