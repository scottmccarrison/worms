/**
 * Shared wire protocol between the worker + Durable Object server and
 * the client. Pure TypeScript types, zero runtime dependencies; both
 * sides import these same definitions.
 *
 * Transport is plain JSON over a WebSocket. Messages are discriminated
 * unions with a `type` tag. Full-state broadcast pattern: any mutation
 * to the lobby/game state ships the entire `LobbyState` as a `state`
 * message, so the client can swap it in wholesale and rerender.
 */

// ---- lobby state shape ----

/**
 * Palette of colours a LobbyPlayer may pick. Server validates any
 * incoming `set_color` against this list.
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
 * One entry per connected client. Mirrors the old Colyseus schema shape
 * 1:1 so the client render model stays the same across the transport
 * swap.
 */
export interface LobbyPlayer {
  sessionId: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
  joinedAt: number;
  ownerOfTeamId: string;
  /** True while the server is holding this player's slot in the grace window. */
  disconnected: boolean;
  /** Wall-clock ms at which the grace window ends. Zero when not disconnected. */
  disconnectGraceEndsAt: number;
}

/**
 * Full room state broadcast to every client on any change. Phase is
 * one of "lobby" | "playing" | "ended".
 */
export interface LobbyState {
  code: string;
  phase: "lobby" | "playing" | "ended";
  hostSessionId: string;
  selectedMapId: string;
  /** Plain object keyed by sessionId (not a Map; JSON-transportable). */
  players: Record<string, LobbyPlayer>;
  // ---- game-phase (post-start_game) ----
  teamOrder: string[];
  currentTeamId: string;
  currentWormId: string;
  turnSeq: number;
  turnEndsAt: number;
}

// ---- game payload shapes ----

/** Single-worm authoritative snapshot entry. */
export interface WormSnapshot {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
}

/** Circular terrain cut, monotonic `seq` for idempotent reapply. */
export interface CircleCut {
  x: number;
  y: number;
  r: number;
  seq: number;
}

/** Team roster shipped inside `game_started`. */
export interface TeamInit {
  id: string;
  name: string;
  color: string;
  wormNames: string[];
  ownerSessionId: string;
}

// ---- client -> server messages ----

export type ClientMsg =
  | { type: "set_nickname"; nickname: string }
  | { type: "set_color"; color: string }
  | { type: "set_ready"; ready: boolean }
  | { type: "select_map"; mapId: string }
  | { type: "start_game" }
  | { type: "input_walk"; dir: number }
  | { type: "input_jump" }
  | { type: "input_backflip" }
  | { type: "input_aim_angle"; angleRad: number }
  | { type: "input_aim_power"; power: number }
  | { type: "input_select_weapon"; weaponId: string }
  | { type: "input_fire" }
  | { type: "input_end_turn" }
  | { type: "turn_snapshot"; worms: WormSnapshot[]; terrainCuts: CircleCut[] }
  | { type: "leave" };

/** Discriminator literals for the input-relay subset. */
export type InputMsgType =
  | "input_walk"
  | "input_jump"
  | "input_backflip"
  | "input_aim_angle"
  | "input_aim_power"
  | "input_select_weapon"
  | "input_fire"
  | "input_end_turn";

export const INPUT_MSG_TYPES: readonly InputMsgType[] = [
  "input_walk",
  "input_jump",
  "input_backflip",
  "input_aim_angle",
  "input_aim_power",
  "input_select_weapon",
  "input_fire",
  "input_end_turn",
] as const;

// ---- server -> client messages ----

/** Sent once per connect/reconnect with the full state + tokens. */
export interface WelcomeMsg {
  type: "welcome";
  sessionId: string;
  resumeToken: string;
  state: LobbyState;
}

/** Full-state broadcast on any mutation. */
export interface StateMsg {
  type: "state";
  state: LobbyState;
}

/** Input relay: the server forwards the active player's input. */
export interface InputRelayMsg {
  type: InputMsgType;
  /** Original sender's sessionId so clients can route to the right worm. */
  from: string;
  /** Payload mirrors the client-side message fields (variable per type). */
  [key: string]: unknown;
}

export interface TurnResolvedMsg {
  type: "turn_resolved";
  turnSeq: number;
  worms: WormSnapshot[];
  terrainCuts: CircleCut[];
  nextTeamId: string;
  nextWormId: string;
}

export interface GameStartedMsg {
  type: "game_started";
  mapId: string;
  seed: number;
  teams: TeamInit[];
}

export interface GameOverMsg {
  type: "game_over";
  winnerTeamId: string | null;
}

export interface ErrorMsg {
  type: "error";
  code: string;
  message: string;
}

export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | InputRelayMsg
  | TurnResolvedMsg
  | GameStartedMsg
  | GameOverMsg
  | ErrorMsg;

// ---- HTTP API shapes ----

/** POST /api/room response body. */
export interface CreateRoomResponse {
  code: string;
}
