/**
 * Room - per-game Durable Object.
 *
 * Post-Epic-45 the DO owns an authoritative planck Simulation. While
 * the game is in "playing" phase an alarm fires every 50ms (20Hz) and:
 *   1. Drains the input queue (walk/jump/aim/fire messages from the
 *      active player).
 *   2. Steps the Simulation (world.step(50ms) + fuse ticks + off-map
 *      kill floor).
 *   3. Collects SimEvents + SimState.
 *   4. Broadcasts sim_state + terrain_cut / fire_event / damage_event
 *      / worm_died events to every attached socket.
 *   5. Persists the sim + arbiter so DO hibernation is recoverable.
 *   6. Schedules the next alarm.
 *
 * Input relays (`input_walk`, `input_jump`, ...) are GONE: the server
 * is authoritative and clients see the result via sim_state. The
 * `turn_snapshot` handler is also removed - alive counts come from
 * the Simulation directly.
 */

import {
  ALLOWED_COLORS,
  type LobbyPlayer,
  type LobbyState,
  type ServerMsg,
  type SimState,
  type TeamInit,
} from "./messages.js";
import { isValidNickname, normaliseNickname } from "./sanitize.js";
import { type SerializedSim, type SimEvent, Simulation } from "./sim/simulation.js";
import {
  type AliveCountsProvider,
  type ArbiterPersistedState,
  type ArbiterRoomAdapter,
  DISCONNECT_GRACE_MS,
  TURN_DURATION_MS,
  type TeamRoster,
  TurnArbiter,
} from "./turnArbiter.js";

const MAP_WHITELIST = ["flat", "hills", "island", "cave"] as const;
const MIN_PLAYERS_TO_START = 2;
const MAX_CLIENTS = 8;
/** Sim tick cadence. 50ms = 20Hz. */
const SIM_TICK_MS = 50;
const EMPTY_ROOM_GRACE_MS = 5 * 60 * 1000;

/** Canonical physics world size. Clients use PX_PER_M=30 to render. */
const WORLD_WIDTH_PX = 1280;
const WORLD_HEIGHT_PX = 720;

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
  ownerOfTeamId: string;
}

interface ResumeEntry {
  sessionId: string;
}

/** Pending input queued during a tick window. */
type PendingInput =
  | { kind: "walk"; sessionId: string; dir: -1 | 0 | 1 }
  | { kind: "jump"; sessionId: string }
  | { kind: "backflip"; sessionId: string }
  | { kind: "aim_angle"; sessionId: string; angleRad: number }
  | { kind: "aim_power"; sessionId: string; power: number }
  | { kind: "select_weapon"; sessionId: string; weaponId: string }
  | { kind: "fire"; sessionId: string };

/** Sim-kickoff metadata persisted so hibernation can rebuild. */
interface SimBootstrap {
  widthPx: number;
  heightPx: number;
  /** Base64-encoded initial terrain mask. */
  maskBase64: string;
  teams: Array<{
    id: string;
    wormIds: string[];
    spawns: Array<{ xPx: number; yPx: number }>;
  }>;
  seed: number;
}

export class Room implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: unknown;

  private lobby: LobbyState | null = null;
  private code: string | null = null;
  private arbiter: TurnArbiter | null = null;
  private rosters: TeamRoster[] = [];

  private sim: Simulation | null = null;
  private simBootstrap: SimBootstrap | null = null;
  private pendingInputs: PendingInput[] = [];
  private tickInProgress = false;

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
        if (this.code && !this.lobby.code) this.lobby.code = this.code;
      } else {
        this.lobby = this.freshLobby();
      }
    }
    if (this.rosters.length === 0) {
      const stored = await this.state.storage.get<TeamRoster[]>("rosters");
      if (stored) this.rosters = stored;
    }

    if (this.lobby?.phase === "playing" && this.sim === null) {
      await this.reloadSimFromStorage();
    }

    if (this.lobby?.phase === "playing" && this.arbiter === null && this.rosters.length > 0) {
      const persisted = await this.state.storage.get<ArbiterPersistedState>("arbiterState");
      if (persisted) {
        this.arbiter = TurnArbiter.fromState(this.makeArbiterAdapter(), this.rosters, persisted);
      } else {
        this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
        this.arbiter.start(this.lobby.teamOrder, this.rosters, TURN_DURATION_MS);
        const lobbyRef = this.lobby;
        this.lobby.turnSeq = lobbyRef.turnSeq;
        this.lobby.turnEndsAt = lobbyRef.turnEndsAt;
        this.lobby.currentTeamId = lobbyRef.currentTeamId;
        this.lobby.currentWormId = lobbyRef.currentWormId;
      }
    }
  }

  private async persistArbiter(): Promise<void> {
    if (!this.arbiter) return;
    await this.state.storage.put("arbiterState", this.arbiter.toJSON());
  }

  private async persistLobby(): Promise<void> {
    if (this.lobby) await this.state.storage.put("lobby", this.lobby);
  }

  private async persistRosters(): Promise<void> {
    await this.state.storage.put("rosters", this.rosters);
  }

  private async persistSim(): Promise<void> {
    if (!this.sim) return;
    await this.state.storage.put("simState", this.sim.serialize());
  }

  private async persistSimBootstrap(): Promise<void> {
    if (!this.simBootstrap) return;
    await this.state.storage.put("simBootstrap", this.simBootstrap);
  }

  private async reloadSimFromStorage(): Promise<void> {
    if (!this.simBootstrap) {
      const stored = await this.state.storage.get<SimBootstrap>("simBootstrap");
      if (!stored) return;
      this.simBootstrap = stored;
    }
    const bootstrap = this.simBootstrap;
    const mask = base64ToBytes(bootstrap.maskBase64);
    this.sim = new Simulation({
      widthPx: bootstrap.widthPx,
      heightPx: bootstrap.heightPx,
      mask,
      teams: bootstrap.teams,
      seed: bootstrap.seed,
    });
    const persisted = await this.state.storage.get<SerializedSim>("simState");
    if (persisted) this.sim.restore(persisted);
  }

  // ---- HTTP fetch ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/init") && request.method === "POST") {
      await this.loadState();
      const body = (await request.json()) as { code?: string; claim?: boolean };
      const code = typeof body.code === "string" ? body.code : "";
      if (!code) return json({ error: "missing_code" }, 400);
      const existing = await this.state.storage.get<string>("code");
      if (body.claim && existing && existing !== code) {
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

    if (!this.code) {
      return new Response("room not found", { status: 404 });
    }

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

    if (resumeTokenParam) {
      const entry = await this.state.storage.get<ResumeEntry>(`resumeToken:${resumeTokenParam}`);
      const lobby = this.ensureLobby();
      const restored = entry ? lobby.players[entry.sessionId] : undefined;
      if (entry && restored) {
        isResume = true;
        restored.disconnected = false;
        restored.disconnectGraceEndsAt = 0;
        player = restored;

        const newToken = generateResumeToken();
        attachment = {
          sessionId: entry.sessionId,
          resumeToken: newToken,
          joinedAt: restored.joinedAt,
          ownerOfTeamId: restored.ownerOfTeamId,
        };
        await this.state.storage.delete(`resumeToken:${resumeTokenParam}`);
        await this.state.storage.put(`resumeToken:${newToken}`, {
          sessionId: entry.sessionId,
        } satisfies ResumeEntry);

        if (this.lobby?.phase === "playing" && this.arbiter) {
          this.arbiter.onOwnerReconnected(entry.sessionId);
          await this.persistArbiter();
        }
      }
    }

    if (!isResume) {
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
      return new Response("join failed", { status: 500 });
    }

    this.state.acceptWebSocket(server, [attachment.sessionId]);
    server.serializeAttachment(attachment);

    await this.persistLobby();

    const welcome: ServerMsg = {
      type: "welcome",
      sessionId: attachment.sessionId,
      resumeToken: attachment.resumeToken,
      state: this.ensureLobby(),
    };
    try {
      server.send(JSON.stringify(welcome));
    } catch {
      // swallow
    }
    this.broadcastState();

    if (this.lobby?.phase === "playing" && !this.arbiter) {
      this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
    }
    await this.ensureRunning();

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
      case "input_walk":
      case "input_jump":
      case "input_backflip":
      case "input_aim_angle":
      case "input_aim_power":
      case "input_select_weapon":
      case "input_fire":
      case "input_end_turn":
        this.queueInput(attachment.sessionId, type, msg);
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

    const liveForSession = this.state.getWebSockets().some((other) => {
      if (other === ws) return false;
      const a = other.deserializeAttachment() as WsAttachment | undefined;
      return a?.sessionId === attachment.sessionId;
    });
    if (liveForSession) return;

    player.disconnected = true;
    player.disconnectGraceEndsAt = Date.now() + DISCONNECT_GRACE_MS;
    if (lobby.phase === "playing" && this.arbiter) {
      this.arbiter.onOwnerDisconnected(attachment.sessionId);
      await this.persistArbiter();
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
    if (this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      await this.loadState();
      const lobby = this.ensureLobby();
      const now = Date.now();

      // Grace expiry forfeits.
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

      // Sim tick while in playing phase.
      let simTickEvents: SimEvent[] = [];
      let simTickState: SimState | null = null;
      if (lobby.phase === "playing" && this.sim) {
        this.drainInputs();
        const result = this.sim.tick(SIM_TICK_MS);
        simTickEvents = result.events;
        simTickState = this.sim.toSimState();

        // Forward sim-side worm-died events to the arbiter so it can
        // re-check game_over immediately (not just on turn expiry).
        for (const ev of simTickEvents) {
          if (ev.type === "worm_died") this.arbiter?.onWormDied(ev.wormId);
        }
      }

      if (lobby.phase === "playing" && this.arbiter) {
        this.arbiter.onTick(SIM_TICK_MS);
      }

      if (this.arbiter) await this.persistArbiter();
      if (this.sim) await this.persistSim();

      // Broadcast sim_state + events, then lobby state.
      // Order: sim_state first so clients have the updated positions
      // in hand when the event messages (which reference worm ids +
      // impact points) arrive. The lobby state goes last so the
      // client's lobby view reflects any turn / game_over change
      // triggered by the tick.
      if (simTickState) {
        this.broadcast({ type: "sim_state", ...simTickState });
      }
      for (const ev of simTickEvents) {
        this.broadcastSimEvent(ev);
      }
      this.broadcastState();
      await this.persistLobby();

      // Empty-room cleanup.
      const sockets = this.state.getWebSockets();
      if (sockets.length === 0 && Object.keys(lobby.players).length === 0) {
        await this.state.storage.setAlarm(Date.now() + EMPTY_ROOM_GRACE_MS);
        return;
      }

      await this.ensureRunning();
    } finally {
      this.tickInProgress = false;
    }
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

    // Instantiate the authoritative Simulation. The server builds a
    // simple flat map mask (a thick floor strip) + fixed spawn points
    // derived from team ordering. Clients build their own matching
    // visual map from the broadcast seed + mapId; geometry consistency
    // is W2/W3's integration problem.
    const mask = buildFlatMask(WORLD_WIDTH_PX, WORLD_HEIGHT_PX);
    const simTeams = rosters.map((r, teamIdx) => {
      const spawns = r.wormIds.map((_, wormIdx) => ({
        xPx: 120 + teamIdx * 260 + wormIdx * 80,
        yPx: WORLD_HEIGHT_PX - 120,
      }));
      return { id: r.id, wormIds: r.wormIds.slice(), spawns };
    });
    this.simBootstrap = {
      widthPx: WORLD_WIDTH_PX,
      heightPx: WORLD_HEIGHT_PX,
      maskBase64: bytesToBase64(mask),
      teams: simTeams,
      seed,
    };
    await this.persistSimBootstrap();

    this.sim = new Simulation({
      widthPx: WORLD_WIDTH_PX,
      heightPx: WORLD_HEIGHT_PX,
      mask,
      teams: simTeams,
      seed,
    });
    await this.persistSim();

    this.arbiter = new TurnArbiter(this.makeArbiterAdapter());
    this.arbiter.start(teamOrder, rosters, TURN_DURATION_MS);
    await this.persistArbiter();

    this.broadcastState();
    await this.ensureRunning();
  }

  private queueInput(senderSessionId: string, type: string, msg: unknown): void {
    if (!this.validateActiveInput(senderSessionId)) return;
    const raw = msg as Record<string, unknown>;
    switch (type) {
      case "input_walk": {
        const dir = raw.dir;
        if (dir !== -1 && dir !== 0 && dir !== 1) return;
        this.pendingInputs.push({ kind: "walk", sessionId: senderSessionId, dir });
        return;
      }
      case "input_jump":
        this.pendingInputs.push({ kind: "jump", sessionId: senderSessionId });
        return;
      case "input_backflip":
        this.pendingInputs.push({ kind: "backflip", sessionId: senderSessionId });
        return;
      case "input_aim_angle": {
        const angleRad = raw.angleRad;
        if (typeof angleRad !== "number" || !Number.isFinite(angleRad)) return;
        this.pendingInputs.push({
          kind: "aim_angle",
          sessionId: senderSessionId,
          angleRad,
        });
        return;
      }
      case "input_aim_power": {
        const power = raw.power;
        if (typeof power !== "number" || !Number.isFinite(power)) return;
        this.pendingInputs.push({
          kind: "aim_power",
          sessionId: senderSessionId,
          power,
        });
        return;
      }
      case "input_select_weapon": {
        const weaponId = raw.weaponId;
        if (typeof weaponId !== "string") return;
        this.pendingInputs.push({
          kind: "select_weapon",
          sessionId: senderSessionId,
          weaponId,
        });
        return;
      }
      case "input_fire":
        this.pendingInputs.push({ kind: "fire", sessionId: senderSessionId });
        return;
      case "input_end_turn":
        // No sim effect; the arbiter's settle-grace timeout handles it.
        return;
      default:
        return;
    }
  }

  private drainInputs(): void {
    if (!this.sim || !this.lobby) return;
    const lobby = this.lobby;
    const inputs = this.pendingInputs;
    this.pendingInputs = [];
    for (const input of inputs) {
      const player = lobby.players[input.sessionId];
      if (!player) continue;
      // Re-check at drain time: the active worm might have changed
      // since enqueue. Apply only if player still owns current team.
      if (player.ownerOfTeamId !== lobby.currentTeamId) continue;
      const activeWormId = lobby.currentWormId;
      if (!activeWormId) continue;
      switch (input.kind) {
        case "walk":
          this.sim.applyWalkInput(activeWormId, input.dir);
          break;
        case "jump":
          this.sim.applyJumpInput(activeWormId);
          break;
        case "backflip":
          this.sim.applyBackflipInput(activeWormId);
          break;
        case "aim_angle":
          this.sim.applyAimAngle(activeWormId, input.angleRad);
          break;
        case "aim_power":
          this.sim.applyAimPower(activeWormId, input.power);
          break;
        case "select_weapon":
          this.sim.applySelectWeapon(activeWormId, input.weaponId);
          break;
        case "fire":
          this.sim.applyFire(activeWormId);
          this.arbiter?.onFireCommitted();
          break;
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

  private broadcastSimEvent(ev: SimEvent): void {
    switch (ev.type) {
      case "terrain_cut":
        this.broadcast({
          type: "terrain_cut",
          x: ev.x,
          y: ev.y,
          r: ev.r,
          seq: ev.seq,
        });
        return;
      case "fire_event":
        this.broadcast({
          type: "fire_event",
          wormId: ev.wormId,
          weaponId: ev.weaponId,
          angleRad: ev.angleRad,
          power: ev.power,
          facing: ev.facing,
        });
        return;
      case "damage_event":
        this.broadcast({
          type: "damage_event",
          wormId: ev.wormId,
          amount: ev.amount,
          fromProjectileId: ev.fromProjectileId,
          impact: ev.impact,
        });
        return;
      case "worm_died":
        this.broadcast({ type: "worm_died", wormId: ev.wormId });
        return;
    }
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
      getAliveCountsProvider(): AliveCountsProvider | null {
        return self.sim;
      },
    };
  }

  private handleFinalLeave(sessionId: string): void {
    const lobby = this.ensureLobby();
    const player = lobby.players[sessionId];
    if (!player) return;

    const wasHost = lobby.hostSessionId === sessionId;

    delete lobby.players[sessionId];

    void this.purgeResumeTokensFor(sessionId);

    if (lobby.phase === "playing" && this.arbiter && player.ownerOfTeamId) {
      this.arbiter.onTeamForfeit(player.ownerOfTeamId);
    }

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

  /**
   * While the game is in "playing" phase and not game_over, make sure
   * there's a pending alarm. DOs hibernate between alarms, so we
   * reschedule explicitly at the end of each alarm rather than using
   * setInterval (which wouldn't survive hibernation).
   */
  private async ensureRunning(): Promise<void> {
    const lobby = this.ensureLobby();
    if (lobby.phase !== "playing") return;
    if (this.arbiter?.isGameOver()) return;
    await this.scheduleAlarmIfEarlier(Date.now() + SIM_TICK_MS);
  }
}

// ---- module-local pure helpers ----

function generateSessionId(): string {
  const buf = crypto.getRandomValues(new Uint8Array(6));
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString(36).padStart(9, "0").slice(0, 9);
}

function generateResumeToken(): string {
  const buf = crypto.getRandomValues(new Uint8Array(32));
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
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

/**
 * Build a simple flat-map mask: a solid horizontal slab at the bottom
 * ~15% of the world. Sufficient for the W1 sim tests; the client
 * builds its own matching visual map (same seed + mapId). Geometry
 * sharing is W2/W3 scope.
 */
function buildFlatMask(widthPx: number, heightPx: number): Uint8Array {
  const mask = new Uint8Array(widthPx * heightPx);
  const floorY = Math.floor(heightPx * 0.85);
  for (let y = floorY; y < heightPx; y++) {
    const row = y * widthPx;
    for (let x = 0; x < widthPx; x++) {
      mask[row + x] = 1;
    }
  }
  return mask;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
