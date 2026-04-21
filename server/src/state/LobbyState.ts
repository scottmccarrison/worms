import { MapSchema, Schema, type } from "@colyseus/schema";

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
 */
export class LobbyPlayer extends Schema {
  @type("string") sessionId = "";
  @type("string") nickname = "";
  @type("string") color = "";
  @type("boolean") ready = false;
  @type("boolean") isHost = false;
  @type("number") joinedAt = 0;
}

/**
 * Authoritative state broadcast to every client in a GameRoom.
 *
 * `phase` is a simple string enum: "lobby" | "playing" | "ended".
 * Epic 8 only exercises "lobby" -> "playing"; "ended" is reserved for Epic 9+.
 */
export class LobbyState extends Schema {
  @type("string") code = "";
  @type("string") phase = "lobby";
  @type("string") hostSessionId = "";
  @type("string") selectedMapId = "flat";
  @type({ map: LobbyPlayer }) players = new MapSchema<LobbyPlayer>();
}
