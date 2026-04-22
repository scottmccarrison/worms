import { ALLOWED_COLORS } from "../../net/types";
import type { LobbyPlayer, LobbyState } from "../../net/types";

/**
 * Per-player row the room view renders.
 */
export interface PlayerRow {
  sessionId: string;
  nickname: string;
  color: string;
  ready: boolean;
  isHost: boolean;
  isMe: boolean;
  /**
   * Epic 10: true while the player's connection has dropped but the server
   * is still holding their slot during the 60s grace window. UI renders a
   * dimmed row + "(disconnected)" suffix.
   */
  disconnected: boolean;
}

/**
 * Flattened, render-ready view of the lobby state for the current client.
 *
 * `toViewModel` is a pure function so we can unit-test state -> UI logic
 * without spinning up Phaser or a real Colyseus room.
 */
export interface ViewModel {
  iAmHost: boolean;
  myReady: boolean;
  canStart: boolean;
  /** Colors not yet taken by another player. `myColor` is always included
   * (the current player can re-pick their own color). */
  availableColors: string[];
  /** Host-first, then insertion order. Each row carries `isMe` so the UI
   * can highlight the local player. */
  players: PlayerRow[];
  /** Map id from state. UI can look up the display name via the registry. */
  mapId: string;
}

/**
 * Pure derive of the rendered view model from the authoritative LobbyState.
 * `mySessionId` comes from the RoomHandle (was the Colyseus Room pre-Epic-13).
 *
 * canStart rule:
 * - current user is the host
 * - >= 2 players total
 * - every non-host player is ready
 *
 * The host's own `ready` state does not gate start - the host uses Start,
 * not Ready, to signal go.
 */
export function toViewModel(state: LobbyState, mySessionId: string): ViewModel {
  // Epic 13: `state.players` is now a plain Record (was a Colyseus MapSchema
  // with forEach-only). Object.values iterates on the JSON object directly.
  const all: LobbyPlayer[] = Object.values(state.players);

  // Host first, then original order for the rest.
  const host = all.find((p) => p.isHost) ?? null;
  const others = all.filter((p) => !p.isHost);
  const sorted = host ? [host, ...others] : all;

  const me = all.find((p) => p.sessionId === mySessionId) ?? null;
  const iAmHost = me ? me.isHost : false;
  const myReady = me ? me.ready : false;

  const taken = new Set<string>();
  for (const p of all) {
    if (p.sessionId !== mySessionId) taken.add(p.color);
  }
  const availableColors = ALLOWED_COLORS.filter((c) => !taken.has(c));

  const nonHostPlayers = all.filter((p) => !p.isHost);
  const allNonHostReady = nonHostPlayers.every((p) => p.ready);
  const canStart = iAmHost && all.length >= 2 && allNonHostReady;

  const rows: PlayerRow[] = sorted.map((p) => ({
    sessionId: p.sessionId,
    nickname: p.nickname,
    color: p.color,
    ready: p.ready,
    isHost: p.isHost,
    isMe: p.sessionId === mySessionId,
    disconnected: p.disconnected,
  }));

  return {
    iAmHost,
    myReady,
    canStart,
    availableColors,
    players: rows,
    mapId: state.selectedMapId,
  };
}
