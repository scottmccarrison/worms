import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

/**
 * Palette of colours a LobbyPlayer may pick. Server validates any
 * incoming `set_color` against this list.
 *
 * Kept small + static so the client palette can mirror it trivially.
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
 * One entry per connected client inside a GameRoom's lobby phase.
 *
 * `joinedAt` is server wall-clock time at join and is used to
 * deterministically promote the next host when the current host leaves.
 *
 * `ownerOfTeamId` is assigned at `start_game` time (Epic 9). Empty
 * string means the player is a spectator or has not been given a team.
 */
export class LobbyPlayer extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  @type("string") color = "";
  @type("boolean") ready = false;
  @type("boolean") isHost = false;
  @type("number") joinedAt = 0;
  @type("string") ownerOfTeamId = "";
  // Epic 10: set to true while the server is holding this player's slot
  // inside a Colyseus `allowReconnection` grace window. Cleared on
  // successful reconnect; the player is deleted from the map when the
  // grace expires or a consented leave lands.
  @type("boolean") disconnected = false;
  // Server wall-clock ms at which the grace window ends (Date.now() +
  // DISCONNECT_GRACE_MS). Zero when not disconnected. Clients read this
  // to render a per-player countdown in the HUD.
  @type("number") disconnectGraceEndsAt = 0;
}

/**
 * Authoritative state broadcast to every client in a GameRoom.
 *
 * `phase` is a simple string enum: "lobby" | "playing" | "ended".
 * Epic 8 exercised "lobby" -> "playing"; Epic 9 keeps that split and
 * layers post-lobby game-phase fields below.
 *
 * Game-phase fields (post-start_game):
 * - `teamOrder` is the canonical cycle order (shuffled once at start).
 * - `currentTeamId` is the team whose owner is the active player.
 * - `currentWormId` is e.g. "red-0"; empty during game_over.
 * - `turnSeq` increments every turn; clients key drift reconciliation off this.
 * - `turnEndsAt` is Date.now() + remaining ms; 0 means not counting.
 *
 * Worm/terrain state is NOT replicated via schema; it flows through
 * the `turn_resolved` message to avoid per-frame serialization cost.
 */
export class LobbyState extends Schema {
  @type("string") code = "";
  @type("string") phase = "lobby";
  @type("string") hostSessionId = "";
  @type("string") selectedMapId = "flat";
  @type({ map: LobbyPlayer }) players = new MapSchema<LobbyPlayer>();

  // ---- game-phase (post-start_game) ----
  @type(["string"]) teamOrder = new ArraySchema<string>();
  @type("string") currentTeamId = "";
  @type("string") currentWormId = "";
  @type("number") turnSeq = 0;
  @type("number") turnEndsAt = 0;
}
