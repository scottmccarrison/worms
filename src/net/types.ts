/**
 * Client-side TypeScript mirror of the server's Colyseus schema (W1).
 *
 * These are PLAIN INTERFACES used for reading state, NOT @colyseus/schema
 * decorators. In Colyseus 0.15 the client receives state as objects that
 * conform to the server schema shape; we type them with these interfaces.
 *
 * Keep in sync with server/src/state/LobbyState.ts.
 */

/**
 * 8-color palette mirrored from server. Taken colors are hidden from the
 * picker server-side, but the client also filters for a snappier UI.
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
 * Per-player state in the lobby MapSchema. Keyed by sessionId.
 *
 * `ownerOfTeamId` is populated during `start_game` when the server assigns
 * teams to players by join order. Empty string means this player does not
 * own a team (spectator, or team unassigned in a 2-player / 4-team match).
 */
export interface LobbyPlayer {
  sessionId: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
  ownerOfTeamId: string;
}

/**
 * Minimal MapSchema-like surface we read in the client.
 * colyseus.js 0.15 exposes MapSchema with forEach + size + get + onAdd/onRemove/onChange.
 */
export interface LobbyPlayersMap {
  readonly size: number;
  forEach(cb: (player: LobbyPlayer, key: string) => void): void;
  get(key: string): LobbyPlayer | undefined;
  onAdd(cb: (player: LobbyPlayer, key: string) => void): void;
  onRemove(cb: (player: LobbyPlayer, key: string) => void): void;
  onChange(cb: (player: LobbyPlayer, key: string) => void): void;
}

/**
 * Minimal ArraySchema-like surface (mirrors Colyseus 0.15 ArraySchema read API).
 * Used for server-side canonical team rotation order (`teamOrder`).
 */
export interface TeamOrderArray {
  readonly length: number;
  [n: number]: string;
  forEach(cb: (id: string) => void): void;
}

/**
 * Top-level lobby state received from the server.
 * `listen()` is Colyseus 0.15's per-field change subscription.
 *
 * Post-Epic-8 / Epic-9 game-phase fields:
 * - `teamOrder`: canonical rotation (shuffled once on start_game).
 * - `currentTeamId` / `currentWormId`: active team + worm (empty during game_over).
 * - `turnSeq`: monotonic turn counter for idempotent `turn_resolved` replay.
 * - `turnEndsAt`: epoch ms; 0 means not counting down.
 */
export interface LobbyState {
  code: string;
  phase: "lobby" | "playing" | "ended";
  hostSessionId: string;
  selectedMapId: string;
  players: LobbyPlayersMap;
  teamOrder: TeamOrderArray;
  currentTeamId: string;
  currentWormId: string;
  turnSeq: number;
  turnEndsAt: number;
  listen<
    K extends
      | "code"
      | "phase"
      | "hostSessionId"
      | "selectedMapId"
      | "currentTeamId"
      | "currentWormId"
      | "turnSeq"
      | "turnEndsAt",
  >(
    prop: K,
    callback: (value: LobbyState[K], previousValue: LobbyState[K]) => void,
    immediate?: boolean,
  ): () => boolean;
}

/**
 * Team bootstrap info sent in the `game_started` message.
 * Authoritative Team list for the match - client GameScene uses this instead
 * of its hardcoded default teams when present.
 *
 * `ownerSessionId` is populated in Epic 9: identifies which player controls
 * this team. Empty string means unowned (auto-skipped by the server).
 */
export interface TeamInit {
  id: string;
  name: string;
  color: number;
  wormNames: string[];
  ownerSessionId: string;
}

/**
 * Server -> client signal that the host hit Start.
 * Clients transition from LobbyScene to GameScene on receipt.
 */
export interface GameStartedMessage {
  mapId: string;
  seed: number;
  teams: TeamInit[];
}

/**
 * Server -> client validation / matchmaking failure.
 */
export interface ErrorMessage {
  code: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Epic 9 - game-phase messages
// ---------------------------------------------------------------------------

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
 * Terrain cut applied during a turn. `seq` is a terrain-cut monotonic counter
 * (NOT the input seq); clients use it to dedupe duplicate `turn_resolved`.
 */
export interface CircleCut {
  x: number;
  y: number;
  r: number;
  seq: number;
}

/**
 * Active player's turn-end snapshot (C->S).
 * Emitted once when the local TurnManager leaves `turnActive`.
 */
export interface TurnSnapshotMessage {
  worms: WormSnapshot[];
  terrainCuts: CircleCut[];
}

/**
 * Server's authoritative turn reconciliation (S->C, broadcast).
 * Everyone snaps their worms + terrain to these values.
 */
export interface TurnResolvedMessage {
  turnSeq: number;
  worms: WormSnapshot[];
  terrainCuts: CircleCut[];
  nextTeamId: string;
  nextWormId: string;
}

/**
 * Server declares the match over. `winnerTeamId === null` indicates a draw
 * (all remaining teams eliminated on the same turn).
 */
export interface GameOverMessage {
  winnerTeamId: string | null;
}

// ---------------------------------------------------------------------------
// Input message payloads (C->S and S->C relay, same shapes)
// All payloads carry a client-monotonic `seq` for debugging; server does NOT
// rely on it for ordering (WebSocket is ordered).
// ---------------------------------------------------------------------------

export interface InputWalkMessage {
  dir: -1 | 0 | 1;
  seq: number;
}

export interface InputJumpMessage {
  seq: number;
}

export interface InputBackflipMessage {
  seq: number;
}

export interface InputAimAngleMessage {
  angleRad: number;
  seq: number;
}

export interface InputAimPowerMessage {
  power: number;
  seq: number;
}

export interface InputSelectWeaponMessage {
  weaponId: "bazooka" | "shotgun" | "handgrenade";
  seq: number;
}

export interface InputFireMessage {
  seq: number;
}

export interface InputEndTurnMessage {
  seq: number;
}
