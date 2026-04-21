import { type Client, Room, matchMaker } from "@colyseus/core";
import { generateUniqueCode } from "../codegen.js";
import { ALLOWED_COLORS, LobbyPlayer, LobbyState } from "../state/LobbyState.js";

/**
 * Whitelist of map ids a host may select. Mirrors
 * `src/maps/registry.ts` on the client. Hard-coded here instead of
 * shared so the server is the authority (client cannot widen it).
 *
 * Epic 7 added: flat, hills, island, cave.
 */
const MAP_WHITELIST = ["flat", "hills", "island", "cave"] as const;

const NICKNAME_MIN = 1;
const NICKNAME_MAX = 16;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000; // 5 minutes
const MIN_PLAYERS_TO_START = 2;

/**
 * One GameRoom instance per active game.
 *
 * Epic 8 scope: lobby-only. Players join, pick nicknames/colors,
 * host picks map + hits start, every client transitions to
 * GameScene locally (no authoritative server sim yet).
 *
 * Authoritative physics + state sync land in Epic 9 (#9);
 * reconnection robustness lands in Epic 10 (#10).
 */
export class GameRoom extends Room<LobbyState> {
  maxClients = 8;

  /** Handle returned by setTimeout for the empty-room disposal timer. */
  private disposeTimer: NodeJS.Timeout | null = null;

  async onCreate(options: { nickname?: string; color?: string } = {}): Promise<void> {
    // Keep the room alive past the last-client-leaves moment so the
    // EMPTY_ROOM_GRACE_MS timer can fire for rejoin/reconnect flows.
    this.autoDispose = false;

    // Collect codes already in use so we don't collide with other rooms.
    const takenCodes = await collectTakenCodes();
    const code = generateUniqueCode(takenCodes);

    const state = new LobbyState();
    state.code = code;
    this.setState(state);

    // Publish code on the room listing so `.filterBy(["code"])` in
    // index.ts matches clients joining with { code }. Colyseus saves
    // room.listing after onCreate returns, so in-place assignment is
    // sufficient; no separate save call required.
    (this.listing as unknown as { code: string }).code = code;
    // Also expose on metadata so tooling / debug lookups can find it.
    await this.setMetadata({ code });

    this.registerMessageHandlers();

    void options; // explicit - onCreate options are validated on onJoin instead
    console.log(`GameRoom ${this.roomId} created with code ${code}`);
  }

  async onJoin(
    client: Client,
    options: { nickname?: string; color?: string } = {},
  ): Promise<void> {
    const nickname = normaliseNickname(options.nickname);
    const colorInput = typeof options.color === "string" ? options.color : "";

    if (!isValidNickname(nickname)) {
      client.send("error", {
        code: "invalid_nickname",
        message: `Nickname must be ${NICKNAME_MIN}-${NICKNAME_MAX} characters (trimmed).`,
      });
      throw new Error("invalid_nickname");
    }

    // If the requested color is missing / invalid / already taken, auto-assign
    // the first free one. This keeps two-player rooms working even without a
    // client-side color picker. Rejection only happens if the palette is
    // exhausted (8 colors, maxClients=8, so effectively never).
    const color =
      isAllowedColor(colorInput) && !isColorTaken(this.state, colorInput)
        ? colorInput
        : (firstFreeColor(this.state) ?? "");
    if (color === "") {
      client.send("error", {
        code: "room_full_palette",
        message: "No colors available in the palette.",
      });
      throw new Error("room_full_palette");
    }

    const player = new LobbyPlayer();
    player.sessionId = client.sessionId;
    player.nickname = nickname;
    player.color = color;
    player.ready = false;
    player.isHost = this.state.players.size === 0;
    player.joinedAt = Date.now();

    this.state.players.set(client.sessionId, player);

    if (player.isHost) {
      this.state.hostSessionId = client.sessionId;
    }

    // A new joiner cancels any pending empty-room disposal.
    this.clearDisposeTimer();

    console.log(
      `${client.sessionId} (${nickname}) joined ${this.roomId} (host=${player.isHost})`,
    );
  }

  onLeave(client: Client, consented: boolean): void {
    const wasHost = this.state.hostSessionId === client.sessionId;
    this.state.players.delete(client.sessionId);

    if (wasHost && this.state.players.size > 0) {
      // Promote the earliest-joined remaining player.
      let nextHostId = "";
      let earliest = Number.POSITIVE_INFINITY;
      this.state.players.forEach((p, sid) => {
        if (p.joinedAt < earliest) {
          earliest = p.joinedAt;
          nextHostId = sid;
        }
      });
      if (nextHostId) {
        this.state.hostSessionId = nextHostId;
        const next = this.state.players.get(nextHostId);
        if (next) next.isHost = true;
      }
    } else if (this.state.players.size === 0) {
      this.state.hostSessionId = "";
      // Schedule disposal after a grace period so a quick reconnect
      // flow (Epic 10) can reclaim the room.
      this.scheduleDisposeIfEmpty();
    }

    void consented;
    console.log(`${client.sessionId} left ${this.roomId} (wasHost=${wasHost})`);
  }

  onDispose(): void {
    this.clearDisposeTimer();
    console.log(`GameRoom ${this.roomId} (${this.state?.code ?? "?"}) disposed`);
  }

  // ---- message handlers ----

  private registerMessageHandlers(): void {
    this.onMessage("set_nickname", (client, payload: { nickname?: string } = {}) => {
      const player = this.requirePlayer(client);
      if (!player) return;
      const nickname = normaliseNickname(payload.nickname);
      if (!isValidNickname(nickname)) {
        client.send("error", {
          code: "invalid_nickname",
          message: `Nickname must be ${NICKNAME_MIN}-${NICKNAME_MAX} characters (trimmed).`,
        });
        return;
      }
      player.nickname = nickname;
    });

    this.onMessage("set_color", (client, payload: { color?: string } = {}) => {
      const player = this.requirePlayer(client);
      if (!player) return;
      const color = typeof payload.color === "string" ? payload.color : "";
      if (!isAllowedColor(color)) {
        client.send("error", {
          code: "invalid_color",
          message: "Color is not in the allowed palette.",
        });
        return;
      }
      if (color !== player.color && isColorTaken(this.state, color)) {
        client.send("error", {
          code: "color_taken",
          message: "Color is already taken by another player.",
        });
        return;
      }
      player.color = color;
    });

    this.onMessage("set_ready", (client, payload: { ready?: boolean } = {}) => {
      const player = this.requirePlayer(client);
      if (!player) return;
      if (this.state.phase !== "lobby") return;
      player.ready = Boolean(payload.ready);
    });

    this.onMessage("select_map", (client, payload: { mapId?: string } = {}) => {
      const player = this.requirePlayer(client);
      if (!player) return;
      if (!player.isHost) {
        client.send("error", {
          code: "not_host",
          message: "Only the host may change the map.",
        });
        return;
      }
      const mapId = typeof payload.mapId === "string" ? payload.mapId : "";
      if (!isAllowedMap(mapId)) {
        client.send("error", {
          code: "invalid_map",
          message: "Map id is not in the allowed list.",
        });
        return;
      }
      this.state.selectedMapId = mapId;
    });

    this.onMessage("start_game", (client) => {
      const player = this.requirePlayer(client);
      if (!player) return;
      if (!player.isHost) {
        client.send("error", {
          code: "not_host",
          message: "Only the host may start the game.",
        });
        return;
      }
      if (this.state.phase !== "lobby") return;
      if (this.state.players.size < MIN_PLAYERS_TO_START) {
        client.send("error", {
          code: "not_enough_players",
          message: `Need at least ${MIN_PLAYERS_TO_START} players to start.`,
        });
        return;
      }
      // All non-host players must be ready.
      let allReady = true;
      this.state.players.forEach((p) => {
        if (!p.isHost && !p.ready) allReady = false;
      });
      if (!allReady) {
        client.send("error", {
          code: "not_all_ready",
          message: "All non-host players must be ready.",
        });
        return;
      }

      const seed = Math.floor(Math.random() * 2 ** 31);
      const teams = buildDefaultTeams();
      this.broadcast("game_started", {
        mapId: this.state.selectedMapId,
        seed,
        teams,
      });
      this.state.phase = "playing";
    });

    this.onMessage("leave", (client) => {
      // Client-initiated clean disconnect. Colyseus will call onLeave.
      client.leave();
    });
  }

  // ---- helpers ----

  /** Look up the LobbyPlayer for this client; null if the client is a stranger. */
  private requirePlayer(client: Client): LobbyPlayer | null {
    const p = this.state.players.get(client.sessionId);
    if (!p) {
      client.send("error", {
        code: "not_in_room",
        message: "You are not a member of this room.",
      });
      return null;
    }
    return p;
  }

  private scheduleDisposeIfEmpty(): void {
    this.clearDisposeTimer();
    this.disposeTimer = setTimeout(() => {
      if (this.state.players.size === 0) {
        this.disconnect().catch((err) => {
          console.error(`GameRoom ${this.roomId} failed to disconnect:`, err);
        });
      }
    }, EMPTY_ROOM_GRACE_MS);
  }

  private clearDisposeTimer(): void {
    if (this.disposeTimer) {
      clearTimeout(this.disposeTimer);
      this.disposeTimer = null;
    }
  }
}

// ---- pure helpers (exported for tests if needed) ----

function normaliseNickname(input: unknown): string {
  if (typeof input !== "string") return "";
  // Strip C0/C1 control chars, zero-width + bidi overrides, and ZWNBSP.
  // Without this a client could send RTL-override characters to spoof
  // display order, or newlines to break the room-view layout.
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
    .trim();
}

function isValidNickname(nickname: string): boolean {
  return nickname.length >= NICKNAME_MIN && nickname.length <= NICKNAME_MAX;
}

function isAllowedColor(color: string): boolean {
  return (ALLOWED_COLORS as readonly string[]).includes(color);
}

function isColorTaken(state: LobbyState, color: string): boolean {
  let taken = false;
  state.players.forEach((p) => {
    if (p.color === color) taken = true;
  });
  return taken;
}

function firstFreeColor(state: LobbyState): string | null {
  for (const c of ALLOWED_COLORS) {
    if (!isColorTaken(state, c)) return c;
  }
  return null;
}

function isAllowedMap(mapId: string): boolean {
  return (MAP_WHITELIST as readonly string[]).includes(mapId);
}

/**
 * Collect codes currently in use across all live GameRooms. Uses
 * matchMaker.query which reads from the presence store (in-memory by
 * default).
 */
async function collectTakenCodes(): Promise<Set<string>> {
  const taken = new Set<string>();
  try {
    const rooms = await matchMaker.query({ name: "game" });
    for (const r of rooms) {
      const code = r.metadata?.code;
      if (typeof code === "string" && code.length > 0) taken.add(code);
    }
  } catch (err) {
    // If the matchmaker is not reachable (e.g. in some test harnesses),
    // fall back to an empty set. Uniqueness is still sanity-checked
    // inside generateUniqueCode.
    console.warn("collectTakenCodes: matchMaker.query failed, assuming empty set:", err);
  }
  return taken;
}

/**
 * Placeholder team layout used by `game_started`. Matches the current
 * GameScene default (2 teams x 2 worms). Replaced with real team
 * configuration once Epic 9 / #23 lands.
 */
export interface TeamInit {
  id: string;
  name: string;
  color: string;
  wormNames: string[];
}

function buildDefaultTeams(): TeamInit[] {
  return [
    {
      id: "team-red",
      name: "Team Red",
      color: "#ff4444",
      wormNames: ["Red-1", "Red-2"],
    },
    {
      id: "team-blue",
      name: "Team Blue",
      color: "#4488ff",
      wormNames: ["Blue-1", "Blue-2"],
    },
  ];
}
