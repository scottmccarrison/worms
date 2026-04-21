import { type Client, Room, matchMaker } from "@colyseus/core";
import { generateUniqueCode } from "../codegen.js";
import { type ArbiterRoomAdapter, type TeamRoster, TurnArbiter } from "../game/TurnArbiter.js";
import { ALLOWED_COLORS, LobbyPlayer, LobbyState } from "../state/LobbyState.js";
import { DISCONNECT_GRACE_MS, TURN_DURATION_MS } from "../state/constants.js";

/**
 * Seconds passed to `allowReconnection(client, seconds)` on a
 * non-consented disconnect. Exposed as a mutable module-level binding
 * so integration tests can shrink the window (e.g. to 1 second) and
 * exercise the grace-expiry forfeit path without waiting 60 seconds of
 * real time. Production code never mutates this.
 */
export let reconnectionGraceSeconds = DISCONNECT_GRACE_MS / 1000;

/** Test-only: override the reconnection grace window (in seconds). */
export function __setReconnectionGraceSecondsForTests(seconds: number): void {
  reconnectionGraceSeconds = seconds;
}

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
 * All gameplay-input message types the server relays from the active
 * player to spectators. Kept as a const array so the handler wiring
 * loop in `registerMessageHandlers` can stay declarative.
 */
const INPUT_MESSAGE_TYPES = [
  "input_walk",
  "input_jump",
  "input_backflip",
  "input_aim_angle",
  "input_aim_power",
  "input_select_weapon",
  "input_fire",
  "input_end_turn",
] as const;

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

  /** Epic 9 turn arbiter; null until `start_game` promotes the room to "playing". */
  private arbiter: TurnArbiter | null = null;

  /**
   * Plain 20Hz setInterval driving TurnArbiter.onTick. We deliberately
   * use a vanilla setInterval instead of Colyseus' setSimulationInterval
   * so the arbiter stays decoupled from Colyseus' internal patch loop.
   */
  private simInterval: NodeJS.Timeout | null = null;

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

  async onJoin(client: Client, options: { nickname?: string; color?: string } = {}): Promise<void> {
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

    console.log(`${client.sessionId} (${nickname}) joined ${this.roomId} (host=${player.isHost})`);
  }

  async onLeave(client: Client, consented: boolean): Promise<void> {
    const wasHost = this.state.hostSessionId === client.sessionId;
    const player = this.state.players.get(client.sessionId);

    // Consented leave = explicit `leave()` call / tab close handshake.
    // Skip the reconnection grace window and finalise immediately.
    if (consented) {
      this.handleFinalLeave(client, player, wasHost);
      return;
    }

    // Flag disconnect so other clients can render "(disconnected, Ns)".
    // If this is the active team owner, tell the arbiter so it can
    // freeze the turn timer; otherwise the arbiter's advanceTurn skip
    // predicate handles the case lazily on the next advance.
    if (player) {
      player.disconnected = true;
      // Track the ACTUAL grace window so a runtime override of
      // reconnectionGraceSeconds (e.g. tests) stays in sync with what
      // clients see counting down. Bugcheck flagged the prior hardcoded
      // DISCONNECT_GRACE_MS as a potential client/server drift.
      player.disconnectGraceEndsAt = Date.now() + reconnectionGraceSeconds * 1000;
      if (this.state.phase === "playing" && this.arbiter) {
        this.arbiter.onOwnerDisconnected(client.sessionId);
      }
    }

    // allowReconnection resolves when the client reconnects; it
    // rejects when the grace window expires or the room is disposed.
    // Either way we call it exactly once per onLeave.
    try {
      await this.allowReconnection(client, reconnectionGraceSeconds);
      // Success path: the same client reconnected. Colyseus preserves
      // state + listeners; no onJoin re-fires. Just clear the flags.
      if (player) {
        player.disconnected = false;
        player.disconnectGraceEndsAt = 0;
        if (this.state.phase === "playing" && this.arbiter) {
          this.arbiter.onOwnerReconnected(client.sessionId);
        }
      }
      console.log(`${client.sessionId} reconnected to ${this.roomId}`);
    } catch {
      // Grace expired (or room disposed). Finalise the leave now.
      this.handleFinalLeave(client, player, wasHost);
    }
  }

  /**
   * Final-leave bookkeeping: delete the player row, let the arbiter
   * forfeit the team if we're mid-game, promote the next host, and
   * schedule empty-room disposal. Called either on a consented leave
   * or after the reconnect grace expires.
   */
  private handleFinalLeave(
    client: Client,
    player: LobbyPlayer | undefined,
    wasHost: boolean,
  ): void {
    this.state.players.delete(client.sessionId);

    // Post-lobby: forfeit the team. onTeamForfeit is responsible for
    // broadcasting a turn_resolved that rotates off the forfeited team
    // (or declaring game_over if only one team remains), so there is no
    // separate forceAdvance call here - that would double-advance past
    // the next eligible team in 3+ player games. Bugcheck flagged this.
    if (this.state.phase === "playing" && this.arbiter && player?.ownerOfTeamId) {
      this.arbiter.onTeamForfeit(player.ownerOfTeamId);
    }

    // Host promotion (unchanged from Epic 8 semantics).
    if (wasHost && this.state.players.size > 0) {
      let nextHostId = "";
      let earliest = Number.POSITIVE_INFINITY;
      for (const [sid, p] of this.state.players) {
        if (p.joinedAt < earliest) {
          earliest = p.joinedAt;
          nextHostId = sid;
        }
      }
      if (nextHostId) {
        this.state.hostSessionId = nextHostId;
        const next = this.state.players.get(nextHostId);
        if (next) next.isHost = true;
      }
    } else if (this.state.players.size === 0) {
      this.state.hostSessionId = "";
      this.scheduleDisposeIfEmpty();
    }

    console.log(`${client.sessionId} left ${this.roomId} (finalLeave, wasHost=${wasHost})`);
  }

  onDispose(): void {
    this.clearDisposeTimer();
    if (this.simInterval) {
      clearInterval(this.simInterval);
      this.simInterval = null;
    }
    console.log(`GameRoom ${this.roomId} (${this.state?.code ?? "?"}) disposed`);
  }

  /**
   * Build the narrow adapter the TurnArbiter consumes. Intentionally
   * inline so arbiter doesn't need to know about Colyseus' Client type.
   */
  private makeArbiterAdapter(): ArbiterRoomAdapter {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      get state() {
        return self.state;
      },
      broadcast(type, payload) {
        self.broadcast(type, payload);
      },
      getConnectedSessionIds() {
        const out = new Set<string>();
        for (const c of self.clients) out.add(c.sessionId);
        return out;
      },
      getPlayerDisconnected(sessionId: string) {
        const p = self.state.players.get(sessionId);
        return p?.disconnected === true;
      },
    };
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
      for (const [, p] of this.state.players) {
        if (!p.isHost && !p.ready) {
          allReady = false;
          break;
        }
      }
      if (!allReady) {
        client.send("error", {
          code: "not_all_ready",
          message: "All non-host players must be ready.",
        });
        return;
      }

      const seed = Math.floor(Math.random() * 2 ** 31);

      // Build teams keyed to player join order so team-to-sessionId
      // ownership is deterministic (Alice joined first -> owns team 0).
      const sortedPlayers = [...this.state.players.values()].sort(
        (a, b) => a.joinedAt - b.joinedAt,
      );
      const teamCount = Math.min(sortedPlayers.length, 4);
      const teams = buildTeamsForPlayers(sortedPlayers, teamCount);

      // Mirror ownership onto the replicated LobbyPlayer rows so
      // clients (and the arbiter's adapter) can see who owns what.
      for (const t of teams) {
        if (!t.ownerSessionId) continue;
        const p = this.state.players.get(t.ownerSessionId);
        if (p) p.ownerOfTeamId = t.id;
      }

      // Shuffle teamOrder so turn cycle is randomised per game. Order
      // is what the arbiter walks; ownership lives on the per-team
      // roster, so shuffling here is purely about turn rotation.
      const teamOrder = shuffle(teams.map((t) => t.id));

      this.broadcast("game_started", {
        mapId: this.state.selectedMapId,
        seed,
        teams,
      });
      this.state.phase = "playing";

      // Hand off to the arbiter. Roster shape deliberately mirrors the
      // client-facing TeamInit so the arbiter has wormIds + owner.
      // Use wormNames verbatim as the arbiter's wormIds; this guarantees
      // the server's `currentWormId` broadcasts match the client's
      // `worm.name` field so remote input + snapshot lookups find the
      // right worm. Caught by bugcheck of the first Epic 9 integration.
      const rosters: TeamRoster[] = teams.map((t) => ({
        id: t.id,
        ownerSessionId: t.ownerSessionId,
        wormIds: t.wormNames.slice(),
      }));
      this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
      this.arbiter.start(teamOrder, rosters, TURN_DURATION_MS);

      // 20Hz tick (every 50ms) is plenty for a turn-based game; we only
      // need to detect end-of-turn timeouts, not per-frame physics.
      this.simInterval = setInterval(() => {
        this.arbiter?.onTick(50);
      }, 50);
    });

    // ---- Epic 9 turn resolution ----
    //
    // Active player tells us the authoritative end-of-turn state; we
    // forward to the arbiter which broadcasts `turn_resolved` (or
    // `game_over`) on our behalf and advances the turn.
    this.onMessage("turn_snapshot", (client, payload: unknown) => {
      if (!this.validateActiveInput(client)) return;
      if (!this.arbiter) return;
      const snap = sanitiseTurnSnapshot(payload);
      if (!snap) return;
      this.arbiter.onSnapshot(snap);
    });

    // ---- Epic 9 input relay ----
    //
    // Each gameplay input the active player sends is validated and then
    // re-broadcast to every other client. Validation: phase==="playing"
    // AND the sender owns state.currentTeamId. On violation we return
    // silently (no error reply) so a non-malicious mis-timed keystroke
    // from a backseater doesn't spam the error channel; see bugcheck
    // targets in the Epic 9 plan for the "drop silently" rationale.
    for (const inputType of INPUT_MESSAGE_TYPES) {
      this.onMessage(inputType, (client, payload) => {
        if (!this.validateActiveInput(client)) return;
        this.broadcast(inputType, payload, { except: client });
      });
    }

    this.onMessage("leave", (client) => {
      // Client-initiated clean disconnect. Colyseus will call onLeave.
      client.leave();
    });
  }

  /**
   * Guard common to all `input_*` and `turn_snapshot` handlers: the
   * sender must be the active player for the current team. Silent on
   * failure per Epic 9 plan (avoid giving cheaters confirmation that a
   * forged message was seen).
   */
  private validateActiveInput(client: Client): boolean {
    if (this.state.phase !== "playing") return false;
    const player = this.state.players.get(client.sessionId);
    if (!player) return false;
    if (!this.state.currentTeamId) return false;
    if (player.ownerOfTeamId !== this.state.currentTeamId) return false;
    return true;
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
  return (
    input
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional; stripping control chars from user input
      .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .trim()
  );
}

function isValidNickname(nickname: string): boolean {
  return nickname.length >= NICKNAME_MIN && nickname.length <= NICKNAME_MAX;
}

function isAllowedColor(color: string): boolean {
  return (ALLOWED_COLORS as readonly string[]).includes(color);
}

function isColorTaken(state: LobbyState, color: string): boolean {
  for (const [, p] of state.players) {
    if (p.color === color) return true;
  }
  return false;
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
 * Defensive parse of a `turn_snapshot` payload. Returns null for
 * anything that doesn't match the expected shape so a malformed
 * message doesn't crash the arbiter or poison the alive-count tally.
 */
function sanitiseTurnSnapshot(input: unknown): {
  worms: Array<{
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    alive: boolean;
  }>;
  terrainCuts: Array<{ x: number; y: number; r: number; seq: number }>;
} | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as { worms?: unknown; terrainCuts?: unknown };
  if (!Array.isArray(raw.worms)) return null;
  if (!Array.isArray(raw.terrainCuts)) return null;

  const worms: Array<{
    id: string;
    x: number;
    y: number;
    vx: number;
    vy: number;
    hp: number;
    alive: boolean;
  }> = [];
  for (const w of raw.worms) {
    if (!w || typeof w !== "object") continue;
    const r = w as {
      id?: unknown;
      x?: unknown;
      y?: unknown;
      vx?: unknown;
      vy?: unknown;
      hp?: unknown;
      alive?: unknown;
    };
    if (typeof r.id !== "string") continue;
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    if (!Number.isFinite(r.vx) || !Number.isFinite(r.vy)) continue;
    if (!Number.isFinite(r.hp)) continue;
    if (typeof r.alive !== "boolean") continue;
    // Clamp hp to [0, 100] so a buggy / malicious client cannot ship negative
    // or outsized values. Bugcheck flagged this as a peer-crash vector because
    // NaN/Infinity in planck setPosition puts bodies into undefined state.
    const hp = Math.max(0, Math.min(100, r.hp as number));
    worms.push({
      id: r.id,
      x: r.x as number,
      y: r.y as number,
      vx: r.vx as number,
      vy: r.vy as number,
      hp,
      alive: r.alive && hp > 0,
    });
  }

  const terrainCuts: Array<{ x: number; y: number; r: number; seq: number }> = [];
  for (const c of raw.terrainCuts) {
    if (!c || typeof c !== "object") continue;
    const r = c as { x?: unknown; y?: unknown; r?: unknown; seq?: unknown };
    if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
    if (!Number.isFinite(r.r) || !Number.isFinite(r.seq)) continue;
    // Clamp terrain cut radius to a sane range; anything bigger than the
    // canvas or negative is nonsense.
    const radius = Math.max(0, Math.min(500, r.r as number));
    terrainCuts.push({
      x: r.x as number,
      y: r.y as number,
      r: radius,
      seq: r.seq as number,
    });
  }

  return { worms, terrainCuts };
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
 * Team roster shipped in the `game_started` message. `ownerSessionId`
 * is the sessionId of the player who drives this team's worms; empty
 * string means the slot is unowned (small game + unused 3rd/4th team).
 */
export interface TeamInit {
  id: string;
  name: string;
  color: string;
  wormNames: string[];
  ownerSessionId: string;
}

/**
 * Fixed 4-team palette. Intentionally separate from ALLOWED_COLORS
 * (which is the per-player UI palette); team colours are a different
 * axis and we want them to stay stable even as the player palette
 * grows.
 */
const TEAM_PALETTE: Array<{ id: string; name: string; color: string; prefix: string }> = [
  { id: "red", name: "Team Red", color: "#ff4444", prefix: "Red" },
  { id: "blue", name: "Team Blue", color: "#4488ff", prefix: "Blue" },
  { id: "green", name: "Team Green", color: "#44dd44", prefix: "Green" },
  { id: "yellow", name: "Team Yellow", color: "#ffdd44", prefix: "Yellow" },
];

const WORMS_PER_TEAM = 2;

/**
 * Assign teams to the given players in join order. Team i goes to
 * player i for i < players.length; remaining team slots (up to
 * teamCount) are created with empty ownerSessionId so the arbiter
 * can skip them.
 */
export function buildTeamsForPlayers(sortedPlayers: LobbyPlayer[], teamCount: number): TeamInit[] {
  const teams: TeamInit[] = [];
  const capped = Math.min(teamCount, TEAM_PALETTE.length);
  for (let i = 0; i < capped; i++) {
    const slot = TEAM_PALETTE[i];
    const owner = sortedPlayers[i];
    const wormNames: string[] = [];
    for (let w = 0; w < WORMS_PER_TEAM; w++) {
      wormNames.push(`${slot.prefix}-${w + 1}`);
    }
    teams.push({
      id: slot.id,
      name: slot.name,
      color: slot.color,
      wormNames,
      ownerSessionId: owner?.sessionId ?? "",
    });
  }
  return teams;
}

/**
 * Fisher-Yates shuffle using Math.random. Deterministic seeding isn't
 * needed here; turn rotation order is broadcast via `teamOrder` so
 * clients share the same sequence.
 */
function shuffle<T>(input: readonly T[]): T[] {
  const out = [...input];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
