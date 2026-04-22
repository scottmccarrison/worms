/**
 * Room - per-game Durable Object.
 *
 * Responsibilities:
 * - Accept hibernatable WebSockets (`state.acceptWebSocket`).
 * - Maintain the full LobbyState in memory (cached) + DO storage.
 * - Validate + dispatch client messages (lobby edits, start_game,
 *   input relay, turn_snapshot).
 * - Broadcast the full LobbyState on any mutation.
 * - Run the TurnArbiter alarm tick during the "playing" phase.
 * - Handle disconnect grace windows: on close, mark player
 *   disconnected + schedule an alarm to forfeit if they never come
 *   back. Resume-token reconnection swaps in the old sessionId +
 *   player data.
 * - Persist the room code (from the Worker's /init call) so reconnects
 *   can verify.
 */

import {
  ALLOWED_COLORS,
  type LobbyPlayer,
  type LobbyState,
  type ServerMsg,
  type TeamInit,
} from "./messages.js";
import { isValidNickname, normaliseNickname, sanitiseTurnSnapshot } from "./sanitize.js";
import {
  type ArbiterRoomAdapter,
  DISCONNECT_GRACE_MS,
  TURN_DURATION_MS,
  type TeamRoster,
  TurnArbiter,
} from "./turnArbiter.js";

const MAP_WHITELIST = ["flat", "hills", "island", "cave"] as const;
const MIN_PLAYERS_TO_START = 2;
const MAX_CLIENTS = 8;
const TICK_INTERVAL_MS = 500;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;

const TEAM_PALETTE: Array<{ id: string; name: string; color: string; prefix: string }> = [
  { id: "red", name: "Team Red", color: "#ff4444", prefix: "Red" },
  { id: "blue", name: "Team Blue", color: "#4488ff", prefix: "Blue" },
  { id: "green", name: "Team Green", color: "#44dd44", prefix: "Green" },
  { id: "yellow", name: "Team Yellow", color: "#ffdd44", prefix: "Yellow" },
];
const WORMS_PER_TEAM = 2;

/** Per-connection attachment (survives DO hibernation). */
interface WsAttachment {
  sessionId: string;
  resumeToken: string;
  joinedAt: number;
  /** Team ownership; empty string for a lobby-only session. */
  ownerOfTeamId: string;
}

/**
 * Resume-token entry, stored in DO storage keyed by the token. The
 * token maps to a sessionId; the player row is always looked up fresh
 * from LobbyState so nickname / color / ready-state changes don't need
 * to chase the token entry.
 */
interface ResumeEntry {
  sessionId: string;
}

export class Room implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: unknown;

  /** In-memory cache of the LobbyState. Hydrated on first message after hibernation. */
  private lobby: LobbyState | null = null;
  /** In-memory cache of the room code. Set by the Worker's /init call. */
  private code: string | null = null;
  /** Arbiter is instantiated when phase transitions to "playing". */
  private arbiter: TurnArbiter | null = null;
  /** Team rosters (ownership + worm ids), mirrored for the arbiter. */
  private rosters: TeamRoster[] = [];

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    void this.env;
  }

  // ---- storage helpers ----

  private freshLobby(): LobbyState {
    return {
      code: this.code ?? "",
      phase: "lobby",
      hostSessionId: "",
      selectedMapId: "flat",
      players: {},
      teamOrder: [],
      currentTeamId: "",
      currentWormId: "",
      turnSeq: 0,
      turnEndsAt: 0,
    };
  }

  private async loadState(): Promise<void> {
    if (this.code === null) {
      const stored = await this.state.storage.get<string>("code");
      this.code = stored ?? "";
    }
    if (this.lobby === null) {
      const stored = await this.state.storage.get<LobbyState>("lobby");
      if (stored) {
        this.lobby = stored;
        // Code is authoritative from storage.
        if (this.code && !this.lobby.code) this.lobby.code = this.code;
      } else {
        this.lobby = this.freshLobby();
      }
    }
    if (this.rosters.length === 0) {
      const stored = await this.state.storage.get<TeamRoster[]>("rosters");
      if (stored) this.rosters = stored;
    }
    // Rebuild arbiter if we come out of hibernation mid-game.
    if (this.lobby?.phase === "playing" && this.arbiter === null && this.rosters.length > 0) {
      this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
      // Start populates teamOrder + currentTeamId again; to avoid that
      // we only rebuild when the stored state already has those fields.
      // Keep it simple: call start with the stored teamOrder so the
      // internal roster map is populated. It will also reset
      // turnEndsAt / turnSeq - which would lose wall clock progress.
      // For now, accept this; the alarm() path will realign on the
      // next snapshot. Playtests will tell us if this is a problem.
      this.arbiter.start(this.lobby.teamOrder, this.rosters, TURN_DURATION_MS);
      // Restore the persisted turn fields so the arbiter resumes mid-turn.
      // start() just wrote fresh values; put the stored ones back.
      const persisted = this.lobby;
      this.lobby.turnSeq = persisted.turnSeq;
      this.lobby.turnEndsAt = persisted.turnEndsAt;
      this.lobby.currentTeamId = persisted.currentTeamId;
      this.lobby.currentWormId = persisted.currentWormId;
    }
  }

  private async persistLobby(): Promise<void> {
    if (this.lobby) await this.state.storage.put("lobby", this.lobby);
  }

  private async persistRosters(): Promise<void> {
    await this.state.storage.put("rosters", this.rosters);
  }

  // ---- HTTP fetch ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Worker -> DO init call. Stores the room code.
    if (url.pathname.endsWith("/init") && request.method === "POST") {
      await this.loadState();
      const body = (await request.json()) as { code?: string; claim?: boolean };
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) return json({ error: "missing_code" }, 400);
      const existing = await this.state.storage.get<string>("code");
      if (body.claim && existing && existing !== code) {
        // Another code claimed this DO slot already. Should be rare -
        // idFromName is deterministic, so a collision means two rooms
        // tried to claim the same code at once. Reject so the Worker
        // can retry with a fresh code.
        return json({ error: "code_collision", existing }, 409);
      }
      if (!existing) {
        await this.state.storage.put("code", code);
        this.code = code;
        if (this.lobby) this.lobby.code = code;
        await this.persistLobby();
      }
      return json({ ok: true, code: this.code });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    await this.loadState();

    // Parse the query string for nickname / color / resumeToken.
    const nickname = normaliseNickname(url.searchParams.get("nickname") ?? "");
    const colorRaw = url.searchParams.get("color") ?? "";
    const resumeTokenParam = url.searchParams.get("resumeToken") ?? "";

    if (!isValidNickname(nickname)) {
      return new Response("invalid nickname", { status: 400 });
    }

    if (this.state.getWebSockets().length >= MAX_CLIENTS) {
      return new Response("room full", { status: 409 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    let attachment: WsAttachment | null = null;
    let player: LobbyPlayer | null = null;
    let isResume = false;

    // Resume path: if the token matches a stored session, restore the
    // old sessionId + player row and rotate the token so a replayed
    // URL can't be reused. The ResumeEntry only stores sessionId; the
    // player row is always read fresh from LobbyState.players so
    // mid-lobby field edits don't need to chase the token entry.
    if (resumeTokenParam) {
      const entry = await this.state.storage.get<ResumeEntry>(`resumeToken:${resumeTokenParam}`);
      const lobby = this.ensureLobby();
      const restored = entry ? lobby.players[entry.sessionId] : undefined;
      if (entry && restored) {
        isResume = true;
        // Clear disconnect flags on resume.
        restored.disconnected = false;
        restored.disconnectGraceEndsAt = 0;
        // Restore nickname + color the client asked for, if valid.
        if (
          (ALLOWED_COLORS as readonly string[]).includes(colorRaw) &&
          !this.isColorTakenBySomeoneElse(colorRaw, entry.sessionId)
        ) {
          restored.color = colorRaw;
        }
        restored.nickname = nickname;
        player = restored;

        const newToken = generateResumeToken();
        attachment = {
          sessionId: entry.sessionId,
          resumeToken: newToken,
          joinedAt: restored.joinedAt,
          ownerOfTeamId: restored.ownerOfTeamId,
        };
        // Rotate: delete old token, write new.
        await this.state.storage.delete(`resumeToken:${resumeTokenParam}`);
        await this.state.storage.put(`resumeToken:${newToken}`, {
          sessionId: entry.sessionId,
        } satisfies ResumeEntry);

        // If we were holding an alarm for this player's grace expiry,
        // the alarm() handler is idempotent (rechecks every player on
        // fire) so leaving it scheduled is fine - it will see the
        // cleared flags and skip.

        if (this.lobby?.phase === "playing" && this.arbiter) {
          this.arbiter.onOwnerReconnected(entry.sessionId);
        }
      }
    }

    if (!isResume) {
      // Fresh join: auto-assign a color if the requested one is invalid
      // or taken.
      const color =
        (ALLOWED_COLORS as readonly string[]).includes(colorRaw) &&
        !this.isColorTakenBySomeoneElse(colorRaw, null)
          ? colorRaw
          : this.firstFreeColor();
      if (!color) return new Response("no colors available", { status: 409 });

      const sessionId = generateSessionId();
      const resumeToken = generateResumeToken();
      const joinedAt = Date.now();
      const lobby = this.ensureLobby();

      player = {
        sessionId,
        nickname,
        color,
        ready: false,
        isHost: Object.keys(lobby.players).length === 0,
        joinedAt,
        ownerOfTeamId: "",
        disconnected: false,
        disconnectGraceEndsAt: 0,
      };
      lobby.players[sessionId] = player;
      if (player.isHost) lobby.hostSessionId = sessionId;

      await this.state.storage.put(`resumeToken:${resumeToken}`, {
        sessionId,
      } satisfies ResumeEntry);

      attachment = {
        sessionId,
        resumeToken,
        joinedAt,
        ownerOfTeamId: "",
      };
    }

    if (!attachment || !player) {
      // Impossible per the branching above, but keeps TS happy.
      return new Response("join failed", { status: 500 });
    }

    this.state.acceptWebSocket(server, [attachment.sessionId]);
    server.serializeAttachment(attachment);

    await this.persistLobby();

    // Send the welcome message to the new socket, then broadcast the
    // updated state to everyone else.
    const welcome: ServerMsg = {
      type: "welcome",
      sessionId: attachment.sessionId,
      resumeToken: attachment.resumeToken,
      state: this.ensureLobby(),
    };
    try {
      server.send(JSON.stringify(welcome));
    } catch {
      // swallow; client may have disconnected mid-upgrade
    }
    this.broadcastState();

    // On reconnect, kick the arbiter timer back to life via an alarm.
    if (this.lobby?.phase === "playing" && !this.arbiter) {
      this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
    }
    await this.maybeScheduleTickAlarm();

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket handlers ----

  async webSocketMessage(ws: WebSocket, msgRaw: ArrayBuffer | string): Promise<void> {
    await this.loadState();

    let data: unknown;
    try {
      const text = typeof msgRaw === "string" ? msgRaw : new TextDecoder().decode(msgRaw);
      data = JSON.parse(text);
    } catch {
      return;
    }
    if (!data || typeof data !== "object") return;
    const msg = data as { type?: string };
    const type = msg.type;
    if (typeof type !== "string") return;

    const attachment = ws.deserializeAttachment() as WsAttachment | undefined;
    if (!attachment) return;
    const lobby = this.ensureLobby();
    const player = lobby.players[attachment.sessionId];
    if (!player) return;

    switch (type) {
      case "set_nickname":
        this.onSetNickname(ws, player, msg);
        break;
      case "set_color":
        this.onSetColor(ws, player, msg);
        break;
      case "set_ready":
        this.onSetReady(player, msg);
        break;
      case "select_map":
        this.onSelectMap(ws, player, msg);
        break;
      case "start_game":
        await this.onStartGame(ws, player);
        break;
      case "turn_snapshot":
        this.onTurnSnapshot(attachment.sessionId, msg);
        break;
      case "input_walk":
      case "input_jump":
      case "input_backflip":
      case "input_aim_angle":
      case "input_aim_power":
      case "input_select_weapon":
      case "input_fire":
      case "input_end_turn":
        this.onInputRelay(attachment.sessionId, type, msg);
        break;
      case "leave":
        try {
          ws.close(1000, "client_leave");
        } catch {
          // ignore
        }
        break;
      default:
        // Unknown type. Silent drop.
        break;
    }

    await this.persistLobby();
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    await this.loadState();
    const attachment = ws.deserializeAttachment() as WsAttachment | undefined;
    if (!attachment) return;
    const lobby = this.ensureLobby();
    const player = lobby.players[attachment.sessionId];
    if (!player) return;

    // Mark disconnected + kick off a grace alarm.
    player.disconnected = true;
    player.disconnectGraceEndsAt = Date.now() + DISCONNECT_GRACE_MS;
    if (lobby.phase === "playing" && this.arbiter) {
      this.arbiter.onOwnerDisconnected(attachment.sessionId);
    }
    await this.persistLobby();
    this.broadcastState();

    await this.scheduleAlarmIfEarlier(player.disconnectGraceEndsAt);
  }

  async webSocketError(ws: WebSocket, _err: unknown): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      // ignore
    }
  }

  async alarm(): Promise<void> {
    await this.loadState();
    const lobby = this.ensureLobby();
    const now = Date.now();

    // Grace expiry: any player whose grace window has elapsed forfeits.
    const expiredSessionIds: string[] = [];
    for (const [sid, player] of Object.entries(lobby.players)) {
      if (
        player.disconnected &&
        player.disconnectGraceEndsAt > 0 &&
        now >= player.disconnectGraceEndsAt
      ) {
        expiredSessionIds.push(sid);
      }
    }
    for (const sid of expiredSessionIds) {
      this.handleFinalLeave(sid);
    }

    // Arbiter tick while in playing phase.
    if (lobby.phase === "playing" && this.arbiter) {
      this.arbiter.onTick(TICK_INTERVAL_MS);
    }

    // Broadcast any state changes made above.
    this.broadcastState();
    await this.persistLobby();

    // Empty-room cleanup. If there are no attached sockets AND the
    // room has been sitting empty for a while, blow away storage.
    const sockets = this.state.getWebSockets();
    if (sockets.length === 0 && Object.keys(lobby.players).length === 0) {
      await this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_GRACE_MS);
      return;
    }

    await this.maybeScheduleTickAlarm();
  }

  // ---- message handlers ----

  private onSetNickname(ws: WebSocket, player: LobbyPlayer, msg: unknown): void {
    const nickname = normaliseNickname((msg as { nickname?: unknown }).nickname);
    if (!isValidNickname(nickname)) {
      this.sendError(ws, "invalid_nickname", "Nickname must be 1-16 characters (trimmed).");
      return;
    }
    player.nickname = nickname;
    this.broadcastState();
  }

  private onSetColor(ws: WebSocket, player: LobbyPlayer, msg: unknown): void {
    const color =
      typeof (msg as { color?: unknown }).color === "string"
        ? (msg as { color: string }).color
        : "";
    if (!(ALLOWED_COLORS as readonly string[]).includes(color)) {
      this.sendError(ws, "invalid_color", "Color is not in the allowed palette.");
      return;
    }
    if (color !== player.color && this.isColorTakenBySomeoneElse(color, player.sessionId)) {
      this.sendError(ws, "color_taken", "Color is already taken by another player.");
      return;
    }
    player.color = color;
    this.broadcastState();
  }

  private onSetReady(player: LobbyPlayer, msg: unknown): void {
    const lobby = this.ensureLobby();
    if (lobby.phase !== "lobby") return;
    player.ready = Boolean((msg as { ready?: unknown }).ready);
    this.broadcastState();
  }

  private onSelectMap(ws: WebSocket, player: LobbyPlayer, msg: unknown): void {
    const lobby = this.ensureLobby();
    if (!player.isHost) {
      this.sendError(ws, "not_host", "Only the host may change the map.");
      return;
    }
    const mapId =
      typeof (msg as { mapId?: unknown }).mapId === "string"
        ? (msg as { mapId: string }).mapId
        : "";
    if (!(MAP_WHITELIST as readonly string[]).includes(mapId)) {
      this.sendError(ws, "invalid_map", "Map id is not in the allowed list.");
      return;
    }
    lobby.selectedMapId = mapId;
    this.broadcastState();
  }

  private async onStartGame(ws: WebSocket, player: LobbyPlayer): Promise<void> {
    const lobby = this.ensureLobby();
    if (!player.isHost) {
      this.sendError(ws, "not_host", "Only the host may start the game.");
      return;
    }
    if (lobby.phase !== "lobby") return;
    const players = Object.values(lobby.players);
    if (players.length < MIN_PLAYERS_TO_START) {
      this.sendError(
        ws,
        "not_enough_players",
        `Need at least ${MIN_PLAYERS_TO_START} players to start.`,
      );
      return;
    }
    const allReady = players.every((p) => p.isHost || p.ready);
    if (!allReady) {
      this.sendError(ws, "not_all_ready", "All non-host players must be ready.");
      return;
    }

    const seed = Math.floor(Math.random() * 2 ** 31);
    const sorted = players.slice().sort((a, b) => a.joinedAt - b.joinedAt);
    const teamCount = Math.min(sorted.length, 4);
    const teams = buildTeamsForPlayers(sorted, teamCount);
    for (const t of teams) {
      if (!t.ownerSessionId) continue;
      const p = lobby.players[t.ownerSessionId];
      if (p) p.ownerOfTeamId = t.id;
    }

    const teamOrder = shuffle(teams.map((t) => t.id));
    this.broadcast({ type: "game_started", mapId: lobby.selectedMapId, seed, teams });
    lobby.phase = "playing";

    const rosters: TeamRoster[] = teams.map((t) => ({
      id: t.id,
      ownerSessionId: t.ownerSessionId,
      wormIds: t.wormNames.slice(),
    }));
    this.rosters = rosters;
    await this.persistRosters();

    this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
    this.arbiter.start(teamOrder, rosters, TURN_DURATION_MS);

    this.broadcastState();
    await this.maybeScheduleTickAlarm();
  }

  private onTurnSnapshot(senderSessionId: string, msg: unknown): void {
    if (!this.validateActiveInput(senderSessionId)) return;
    if (!this.arbiter) return;
    const snap = sanitiseTurnSnapshot(msg);
    if (!snap) return;
    // Security: the active player is authoritative ONLY over their own
    // team's worms. Without this filter a malicious active player could
    // send `alive: false` entries for opponent worms and force an
    // instant win. Opponent worm state comes exclusively from earlier
    // snapshots sent when those teams were active.
    const lobby = this.ensureLobby();
    const myTeamId = lobby.players[senderSessionId]?.ownerOfTeamId ?? "";
    const myRoster = this.rosters.find((r) => r.id === myTeamId);
    const myWormIds = new Set(myRoster?.wormIds ?? []);
    const filtered = {
      worms: snap.worms.filter((w) => myWormIds.has(w.id)),
      terrainCuts: snap.terrainCuts,
    };
    this.arbiter.onSnapshot(filtered);
    this.broadcastState();
  }

  private onInputRelay(senderSessionId: string, type: string, msg: unknown): void {
    if (!this.validateActiveInput(senderSessionId)) return;
    // Relay to everyone except the sender. Attach `from` so the client
    // can route to the right worm without trusting an external id.
    const payload = { ...(msg as Record<string, unknown>), from: senderSessionId, type };
    const serialised = JSON.stringify(payload);
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | undefined;
      if (!att) continue;
      if (att.sessionId === senderSessionId) continue;
      try {
        ws.send(serialised);
      } catch {
        // ignore
      }
    }
  }

  // ---- helpers ----

  private ensureLobby(): LobbyState {
    if (!this.lobby) this.lobby = this.freshLobby();
    return this.lobby;
  }

  private validateActiveInput(senderSessionId: string): boolean {
    const lobby = this.ensureLobby();
    if (lobby.phase !== "playing") return false;
    const player = lobby.players[senderSessionId];
    if (!player) return false;
    if (!lobby.currentTeamId) return false;
    if (player.ownerOfTeamId !== lobby.currentTeamId) return false;
    return true;
  }

  private isColorTakenBySomeoneElse(color: string, exceptSessionId: string | null): boolean {
    const lobby = this.ensureLobby();
    for (const [sid, p] of Object.entries(lobby.players)) {
      if (sid === exceptSessionId) continue;
      if (p.color === color) return true;
    }
    return false;
  }

  private firstFreeColor(): string | null {
    for (const c of ALLOWED_COLORS) {
      if (!this.isColorTakenBySomeoneElse(c, null)) return c;
    }
    return null;
  }

  private sendError(ws: WebSocket, code: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: "error", code, message }));
    } catch {
      // ignore
    }
  }

  private broadcast(msg: ServerMsg): void {
    const serialised = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(serialised);
      } catch {
        // ignore
      }
    }
  }

  private broadcastState(): void {
    const lobby = this.ensureLobby();
    this.broadcast({ type: "state", state: lobby });
  }

  private makeArbiterAdapter(): ArbiterRoomAdapter {
    const self = this;
    return {
      get state() {
        return self.ensureLobby();
      },
      broadcast(type, payload): void {
        self.broadcast({ type, ...(payload as object) } as ServerMsg);
      },
      getConnectedSessionIds(): Set<string> {
        const out = new Set<string>();
        for (const ws of self.state.getWebSockets()) {
          const att = ws.deserializeAttachment() as WsAttachment | undefined;
          if (att) out.add(att.sessionId);
        }
        return out;
      },
      getPlayerDisconnected(sessionId: string): boolean {
        return self.ensureLobby().players[sessionId]?.disconnected === true;
      },
    };
  }

  private handleFinalLeave(sessionId: string): void {
    const lobby = this.ensureLobby();
    const player = lobby.players[sessionId];
    if (!player) return;

    const wasHost = lobby.hostSessionId === sessionId;

    delete lobby.players[sessionId];

    // Best-effort purge of any resume tokens pointing at this session.
    // Fire-and-forget is fine here: tokens only match a live player
    // row, and we just deleted that row, so even if deletion lags any
    // resume attempt with the old token will fall through to the
    // fresh-join path.
    void this.purgeResumeTokensFor(sessionId);

    // Forfeit if mid-game.
    if (lobby.phase === "playing" && this.arbiter && player.ownerOfTeamId) {
      this.arbiter.onTeamForfeit(player.ownerOfTeamId);
    }

    // Promote next host if this player was the host.
    if (wasHost) {
      let nextHostId = "";
      let earliest = Number.POSITIVE_INFINITY;
      for (const [sid, p] of Object.entries(lobby.players)) {
        if (p.joinedAt < earliest) {
          earliest = p.joinedAt;
          nextHostId = sid;
        }
      }
      if (nextHostId) {
        lobby.hostSessionId = nextHostId;
        const next = lobby.players[nextHostId];
        if (next) next.isHost = true;
      } else {
        lobby.hostSessionId = "";
      }
    }
  }

  private async purgeResumeTokensFor(sessionId: string): Promise<void> {
    const entries = await this.state.storage.list<ResumeEntry>({
      prefix: "resumeToken:",
    });
    for (const [key, entry] of entries) {
      if (entry.sessionId === sessionId) {
        await this.state.storage.delete(key);
      }
    }
  }

  private async scheduleAlarmIfEarlier(ts: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || ts < current) {
      await this.state.storage.setAlarm(ts);
    }
  }

  private async maybeScheduleTickAlarm(): Promise<void> {
    const lobby = this.ensureLobby();
    if (lobby.phase !== "playing") return;
    if (this.arbiter?.isGameOver()) return;
    await this.scheduleAlarmIfEarlier(Date.now() + TICK_INTERVAL_MS);
  }
}

// ---- module-local pure helpers ----

function generateSessionId(): string {
  // 9-char base36 for continuity with Colyseus' session id length.
  const buf = crypto.getRandomValues(new Uint8Array(6));
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(9, "0").slice(0, 9);
}

function generateResumeToken(): string {
  // 32 bytes of entropy, base64url-encoded. Strictly unguessable.
  const buf = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  // btoa is available in the Workers runtime.
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildTeamsForPlayers(sortedPlayers: LobbyPlayer[], teamCount: number): TeamInit[] {
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

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
