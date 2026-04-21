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
 */
export interface LobbyPlayer {
  sessionId: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
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
 * Top-level lobby state received from the server.
 * `listen()` is Colyseus 0.15's per-field change subscription.
 */
export interface LobbyState {
  code: string;
  phase: "lobby" | "playing" | "ended";
  hostSessionId: string;
  selectedMapId: string;
  players: LobbyPlayersMap;
  listen<K extends "code" | "phase" | "hostSessionId" | "selectedMapId">(
    prop: K,
    callback: (value: LobbyState[K], previousValue: LobbyState[K]) => void,
    immediate?: boolean,
  ): () => boolean;
}

/**
 * Team bootstrap info sent in the `game_started` message.
 * Authoritative Team list for the match - client GameScene uses this instead
 * of its hardcoded default teams when present.
 */
export interface TeamInit {
  id: string;
  name: string;
  color: number;
  wormNames: string[];
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
