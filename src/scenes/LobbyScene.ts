import * as Phaser from "phaser";
import { CODE_ALPHABET } from "../../shared/codeAlphabet";
import { packMask } from "../../shared/maskPack";
import { dlogUnthrottled } from "../debug/logger";
import { loadMap } from "../maps/loadMap";
import { firstId, getById, lobbyIds } from "../maps/registry";
import type { NetClient } from "../net/client";
import {
  clearRoomToken,
  readNickname,
  readRoomToken,
  saveNickname,
  saveRoomToken,
} from "../net/clientStorage";
import { runReconnectLoop } from "../net/reconnectLoop";
import { ALLOWED_COLORS } from "../net/types";
import type { ErrorMessage, GameStartedMessage, LobbyState } from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { ReconnectingOverlay } from "../ui/ReconnectingOverlay";
import { toViewModel } from "./lobby/renderModel";
import type { ViewModel } from "./lobby/renderModel";

/**
 * LobbyScene accepts two init shapes:
 *
 * 1. `{ netClient, autoJoinCode }` - the normal BootScene flow. We render
 *    the home view; user picks Create or Join.
 * 2. `{ netClient, room }` - Epic 10/13 reconnect flow. BootScene successfully
 *    called `joinRoom(wsBase, code, nick, color, resumeToken)` and is handing
 *    us the live RoomHandle. We skip the home view and jump straight to the
 *    room view.
 */
interface LobbySceneDataHome {
  netClient: NetClient;
  autoJoinCode: string | null;
}
interface LobbySceneDataReconnect {
  netClient: NetClient;
  room: RoomHandle;
}
type LobbySceneData = LobbySceneDataHome | LobbySceneDataReconnect;

type View = "home" | "room";

const CANVAS_W = 1280;

const TEXT_STYLE_LARGE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "64px",
  color: "#e0e0e0",
  fontFamily: "system-ui, sans-serif",
};
const TEXT_STYLE_BODY: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "22px",
  color: "#e0e0e0",
  fontFamily: "system-ui, sans-serif",
};
const TEXT_STYLE_ROOM: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "32px",
  color: "#e0e0e0",
  fontFamily: "system-ui, sans-serif",
};
const TEXT_STYLE_SMALL: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "18px",
  color: "#aaaaaa",
  fontFamily: "system-ui, sans-serif",
};
const TEXT_STYLE_BUTTON: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "24px",
  color: "#ffffff",
  fontFamily: "system-ui, sans-serif",
  fontStyle: "bold",
};
const TEXT_STYLE_ERROR: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "18px",
  color: "#ff8888",
  fontFamily: "system-ui, sans-serif",
};

const INPUT_CSS =
  "width: 240px; height: 36px; font-size: 20px; padding: 4px 8px; color: #e0e0e0; background: #22222c; border: 1px solid #555; border-radius: 4px; color-scheme: dark;";

/**
 * LobbyScene - two-view Phaser scene (home + room).
 *
 * Home: nickname input + Create/Join actions.
 * Room: code display, map picker (host only), player list, Ready toggle,
 *       Start Game (host only), Leave. Re-renders on every state change.
 *
 * Epic 13 net surface: RoomHandle (native-WS wrapper) instead of Colyseus
 * Room. State replication is full-snapshot every `state` message; no
 * per-field listeners or MapSchema.onAdd/Remove/onChange. We still debounce
 * renders via rAF to let Phaser's input plugin settle between tear-down
 * and rebuild (original fix for #56 - Ready button click-through).
 */
export class LobbyScene extends Phaser.Scene {
  private static instanceCount = 0;
  private readonly instanceId = LobbyScene.instanceCount++;

  private netClient!: NetClient;
  private autoJoinCode: string | null = null;

  private view: View = "home";
  private nickname = "";
  private selectedColor: string = ALLOWED_COLORS[0];
  private room: RoomHandle | null = null;

  // Active subscriptions on the current RoomHandle. Cleared on leave +
  // re-populated on every (re)join. Unsub functions returned by
  // RoomHandle.onStateChange / onMessage / onClose.
  private roomUnsubs: Array<() => void> = [];

  // Home view GameObjects (destroyed on view switch).
  private homeObjects: Phaser.GameObjects.GameObject[] = [];
  // Reference kept so we could future-proof focus() calls.
  protected nicknameInput: Phaser.GameObjects.DOMElement | null = null;
  private joinCodeInput: Phaser.GameObjects.DOMElement | null = null;
  private homeErrorText: Phaser.GameObjects.Text | null = null;

  // Room view GameObjects (destroyed + rebuilt on every state change).
  private roomObjects: Phaser.GameObjects.GameObject[] = [];

  constructor() {
    super("LobbyScene");
  }

  // When BootScene hands us a live RoomHandle (Epic 13 reconnect path), we
  // stash it here during init() and consume it in create() to jump straight
  // to the room view. Cleared after consumption.
  private pendingReconnectedRoom: RoomHandle | null = null;

  // Epic 10: shared reconnect UI. Lazy-created on first use so a cleanly
  // exited lobby never mounts it. Destroyed on scene shutdown.
  private reconnectingOverlay: ReconnectingOverlay | null = null;

  // Epic 10: guard against overlapping reconnect loops. If the network
  // flaps twice in quick succession we must not kick off two parallel
  // joinRoom chains (they'd race and one would leave a ghost Room).
  private reconnectInFlight = false;

  // The code for the current room, cached at join time so the close
  // handler can look up the resume token without reading stale
  // room state (state may have been freed by the time the close fires).
  private currentRoomCode = "";

  // Last hidden selectedMapId we normalized away from. Prevents repeat
  // select_map sends while the server echoes stale state before applying
  // our correction (renderRoom fires on every state update).
  private lastNormalizedHiddenMapId: string | null = null;

  init(data: LobbySceneData): void {
    this.netClient = data.netClient;
    if ("room" in data) {
      this.pendingReconnectedRoom = data.room;
      this.autoJoinCode = null;
    } else {
      this.autoJoinCode = data.autoJoinCode;
    }
  }

  create(): void {
    dlogUnthrottled("scene", "LobbyScene.create", {
      hasPendingRoom: this.pendingReconnectedRoom !== null,
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      dlogUnthrottled("scene", "LobbyScene.shutdown", {
        instanceId: this.instanceId,
        unsubCount: this.roomUnsubs.length,
      });
      this.tearDownRoomListeners();
    });

    if (this.pendingReconnectedRoom) {
      // Epic 13: BootScene already did the hard work. Slide straight into
      // the room view with the live RoomHandle.
      const room = this.pendingReconnectedRoom;
      this.pendingReconnectedRoom = null;
      this.onRoomJoined(room);
      return;
    }

    // Pre-fill nickname from localStorage so returning players don't re-type.
    this.nickname = readNickname();

    this.renderHome();

    // If we arrived with ?room=CODE in the URL, surface the code in the Join
    // input so the user just needs to pick a nickname and click.
    if (this.autoJoinCode && this.joinCodeInput) {
      const el = this.joinCodeInput.node as HTMLInputElement;
      el.value = this.autoJoinCode;
    }
  }

  // ---------------------------------------------------------------------------
  // Home view
  // ---------------------------------------------------------------------------

  private renderHome(): void {
    this.view = "home";
    this.clearRoom();
    this.clearHome();

    const cx = CANVAS_W / 2;

    const title = this.add.text(cx, 120, "WORMS", TEXT_STYLE_LARGE).setOrigin(0.5);
    this.homeObjects.push(title);

    const nicknameLabel = this.add.text(cx, 240, "Nickname", TEXT_STYLE_BODY).setOrigin(0.5);
    this.homeObjects.push(nicknameLabel);

    // Phaser DOM Element - real <input> so mobile virtual keyboards work.
    const nickEl = this.add.dom(cx, 290, "input", INPUT_CSS);
    const nickNode = nickEl.node as HTMLInputElement;
    nickNode.setAttribute("type", "text");
    nickNode.setAttribute("maxlength", "16");
    nickNode.setAttribute("placeholder", "Your name");
    nickNode.value = this.nickname;
    nickNode.addEventListener("input", () => {
      this.nickname = nickNode.value.trim();
    });
    this.nicknameInput = nickEl;
    this.homeObjects.push(nickEl);

    // Create Room button.
    const createBtn = this.makeButton(cx - 170, 400, 260, 60, "Create Room", () => {
      void this.handleCreate();
    });
    this.homeObjects.push(...createBtn);

    // Join Room section. Attribute hints help mobile keyboards surface the
    // right key layout and auto-uppercase; the input listener is still the
    // source of truth because browsers honour these attributes unevenly.
    const joinEl = this.add.dom(cx + 170, 400, "input", INPUT_CSS);
    const joinNode = joinEl.node as HTMLInputElement;
    joinNode.setAttribute("type", "text");
    joinNode.setAttribute("inputmode", "text");
    joinNode.setAttribute("autocapitalize", "characters");
    joinNode.setAttribute("maxlength", "4");
    joinNode.setAttribute("pattern", "[A-Z]{4}");
    joinNode.setAttribute("spellcheck", "false");
    joinNode.setAttribute("placeholder", "CODE");
    joinNode.style.textTransform = "uppercase";
    joinNode.style.textAlign = "center";
    joinNode.addEventListener("input", () => {
      // Strip characters outside CODE_ALPHABET (excludes I and O), uppercase,
      // cap at 4. Runs on every keystroke so the user can never hold an
      // invalid value.
      joinNode.value = joinNode.value
        .toUpperCase()
        .replace(new RegExp(`[^${CODE_ALPHABET}]`, "g"), "")
        .slice(0, 4);
    });
    this.joinCodeInput = joinEl;
    this.homeObjects.push(joinEl);

    const joinBtn = this.makeButton(cx + 170, 470, 260, 50, "Join Room", () => {
      void this.handleJoin();
    });
    this.homeObjects.push(...joinBtn);

    this.homeErrorText = this.add.text(cx, 560, "", TEXT_STYLE_ERROR).setOrigin(0.5);
    this.homeObjects.push(this.homeErrorText);
  }

  private clearHome(): void {
    for (const obj of this.homeObjects) obj.destroy();
    this.homeObjects = [];
    this.nicknameInput = null;
    this.joinCodeInput = null;
    this.homeErrorText = null;
  }

  private makeButton(
    x: number,
    y: number,
    w: number,
    h: number,
    label: string,
    onClick: () => void,
    opts: { enabled?: boolean; fill?: number; stroke?: number } = {},
  ): Phaser.GameObjects.GameObject[] {
    const enabled = opts.enabled !== false;
    const fill = opts.fill ?? (enabled ? 0x3344aa : 0x333344);
    const stroke = opts.stroke ?? (enabled ? 0x7788ff : 0x555566);
    const bg = this.add.rectangle(x, y, w, h, fill).setStrokeStyle(2, stroke);
    if (enabled) {
      bg.setInteractive({ useHandCursor: true });
      bg.on("pointerdown", onClick);
    }
    const text = this.add
      .text(x, y, label, {
        ...TEXT_STYLE_BUTTON,
        color: enabled ? "#ffffff" : "#888888",
      })
      .setOrigin(0.5);
    return [bg, text];
  }

  private async handleCreate(): Promise<void> {
    const nick = this.validateNickname();
    if (!nick) return;
    saveNickname(nick);

    try {
      this.setHomeError("Creating room...");
      const room = await this.netClient.createRoom(nick, this.selectedColor);
      this.onRoomJoined(room);
    } catch (err) {
      this.setHomeError(`Create failed: ${this.errorMessage(err)}`);
    }
  }

  private async handleJoin(): Promise<void> {
    const codeEl = this.joinCodeInput ? (this.joinCodeInput.node as HTMLInputElement) : null;
    const codeRaw = codeEl?.value ?? "";
    const code = codeRaw.trim().toUpperCase();

    // Blind-click guard: if the code input is empty, focus it instead of
    // attempting to join. Prevents "room not found" errors on accidental
    // taps. Partial codes (1-3 chars) focus + show the explicit length rule.
    if (code.length === 0) {
      codeEl?.focus();
      this.setHomeError("Enter a 4-letter room code");
      return;
    }
    if (code.length < 4) {
      codeEl?.focus();
      this.setHomeError("Code must be 4 letters");
      return;
    }
    if (!new RegExp(`^[${CODE_ALPHABET}]{4}$`).test(code)) {
      this.setHomeError("Enter a 4-letter room code");
      return;
    }

    const nick = this.validateNickname();
    if (!nick) return;
    saveNickname(nick);

    try {
      this.setHomeError("Looking up room...");
      // Epic 13: joinRoom opens a WebSocket directly to the worker, which
      // routes to the Durable Object by `idFromName(code)`. No matchmaking
      // round-trip needed - if the code is unknown the server rejects the
      // upgrade with an application-layer `error` message.
      const room = await this.netClient.joinRoom(code, nick, this.selectedColor);
      this.onRoomJoined(room);
    } catch (err) {
      this.setHomeError(`Join failed: ${this.errorMessage(err)}`);
    }
  }

  private validateNickname(): string | null {
    const nick = this.nickname.trim();
    if (nick.length === 0) {
      this.setHomeError("Enter a nickname");
      return null;
    }
    if (nick.length > 16) {
      this.setHomeError("Nickname too long (max 16)");
      return null;
    }
    return nick;
  }

  private setHomeError(msg: string): void {
    this.homeErrorText?.setText(msg);
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    if (typeof err === "string") return err;
    return "unknown error";
  }

  // ---------------------------------------------------------------------------
  // Room view
  // ---------------------------------------------------------------------------

  private onRoomJoined(room: RoomHandle): void {
    dlogUnthrottled("scene", "LobbyScene.onRoomJoined", {
      roomCode: room.state?.code,
      phase: room.state?.phase,
    });
    this.tearDownRoomListeners();
    this.room = room;
    this.currentRoomCode = room.state?.code ?? room.code ?? "";
    this.wireRoomListeners(room);
    dlogUnthrottled("scene", "LobbyScene.wired", {
      unsubCount: this.roomUnsubs.length,
      phase: room.state?.phase,
    });

    // Backstop: if we re-entered the lobby but the server already says we're
    // in 'playing' phase, the game_started broadcast may have been missed
    // (race during scene transition or stale state). Log only for now - if
    // the next playtest shows this firing, we'll know this is the failing
    // path and add a re-request mechanism in the next PR.
    const currentPhase = room.state?.phase;
    if (currentPhase === "playing") {
      dlogUnthrottled("scene", "LobbyScene.backstop_to_game", { reason: "phase_already_playing" });
    }

    this.view = "room";
    this.clearHome();
    // Hide any overlay left behind from a previous reconnect attempt.
    this.reconnectingOverlay?.hide();
    // Epic 13: cache the resume token keyed by the room code so a page
    // reload within the grace window can slide back in via BootScene's
    // reconnect path. The code is on the welcome state so we can save
    // immediately without a listener dance.
    if (this.currentRoomCode && room.resumeToken) {
      saveRoomToken(this.currentRoomCode, room.resumeToken);
    }
    // Defensive: if we reconnect into a live game, don't render the lobby UI.
    // The game_started message (sent by the server on resume into phase=playing)
    // will transition to GameScene momentarily.
    if (room.state?.phase === "playing") {
      this.showReconnectingPlaceholder();
      return;
    }

    // First render can run immediately; state has already arrived by the time
    // the join promise resolves (welcome message populates the handle).
    this.renderRoom();
  }

  private showReconnectingPlaceholder(): void {
    this.clearRoom();
    const cx = this.scale.width / 2;
    const cy = this.scale.height / 2;
    const placeholder = this.add
      .text(cx, cy, "Reconnecting...", {
        ...TEXT_STYLE_BODY,
        fontSize: "24px",
      })
      .setOrigin(0.5);
    this.roomObjects.push(placeholder);
  }

  /**
   * Wire all RoomHandle listeners. Debounces re-renders to once per animation
   * frame so bursts of `state` messages don't tear down + rebuild Phaser
   * hit-test lists faster than the input plugin can settle (original fix
   * for #56 - Ready button click-through under patch bursts).
   *
   * Epic 13 simplification: MapSchema.onAdd/Remove/Change + per-player
   * onChange + state.listen() are all replaced by a single
   * `onStateChange(newState => rerender())`. The full LobbyState arrives on
   * every change, so the callback sees the new value and renderRoom picks
   * it up via this.room.state.
   */
  private wireRoomListeners(room: RoomHandle): void {
    dlogUnthrottled("scene", "LobbyScene.wireRoomListeners", {
      existingUnsubs: this.roomUnsubs.length,
    });
    let pending = false;
    const rerender = () => {
      if (pending || this.view !== "room") return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (this.view === "room") this.renderRoom();
      });
    };

    this.roomUnsubs.push(
      room.onStateChange(() => {
        rerender();
      }),
    );

    this.roomUnsubs.push(
      room.onMessage("error", (msg: ErrorMessage) => {
        if (this.view === "home") {
          this.setHomeError(`${msg.code}: ${msg.message}`);
        } else {
          this.flashRoomError(`${msg.code}: ${msg.message}`);
        }
      }),
    );

    this.roomUnsubs.push(
      room.onMessage("game_started", (msg: GameStartedMessage) => {
        dlogUnthrottled("scene", "LobbyScene.gameStarted", {
          mapId: msg.mapId,
          phase: room.state?.phase,
        });
        // Host clicked Start. Server includes the authoritative mask +
        // spawn points so every client renders pixel-identical terrain
        // (server's physics and client's visuals match).
        this.scene.start("GameScene", {
          mapId: msg.mapId,
          seed: msg.seed,
          teams: msg.teams,
          mask: msg.mask,
          spawnPoints: msg.spawnPoints,
          widthPx: msg.widthPx,
          heightPx: msg.heightPx,
          room,
          netClient: this.netClient,
        });
      }),
    );

    this.roomUnsubs.push(
      room.onClose((code: number) => {
        // Native WebSocket close codes:
        // - 1000 (CLOSE_NORMAL) = consented leave (tab close / room.leave()).
        // - anything else (1001, 1006, 1011, ...) = unexpected drop.
        // We only kick off a reconnect loop on unexpected drops.
        if (code === 1000) {
          this.room = null;
          this.renderHome();
          return;
        }
        // Unexpected drop: the server is holding our slot for up to 60s.
        void this.startReconnectionLoop();
      }),
    );
  }

  private tearDownRoomListeners(): void {
    dlogUnthrottled("scene", "LobbyScene.tearDownRoomListeners", {
      unsubCount: this.roomUnsubs.length,
    });
    for (const unsub of this.roomUnsubs) {
      try {
        unsub();
      } catch {
        // Already torn down - drop.
      }
    }
    this.roomUnsubs = [];
  }

  /**
   * Epic 10/13: unexpected-drop reconnect loop. Shows the shared
   * ReconnectingOverlay and walks the default backoff schedule. On success
   * we wire the new Room in place; on failure we drop the cached token
   * and fall back to the home view.
   */
  private async startReconnectionLoop(): Promise<void> {
    if (this.reconnectInFlight) return;
    this.reconnectInFlight = true;
    const code = this.currentRoomCode;
    const stored = code ? readRoomToken(code) : null;
    if (!stored) {
      // No cached token - can't reconnect. Drop to home.
      this.reconnectInFlight = false;
      this.room = null;
      this.renderHome();
      return;
    }

    const overlay = this.ensureOverlay();
    overlay.show(1);

    const result = await runReconnectLoop({
      netClient: this.netClient,
      code,
      nickname: this.nickname || "player",
      color: this.selectedColor,
      resumeToken: stored.resumeToken,
      onAttempt: (n) => overlay.show(n),
    });

    if (result.ok && result.room) {
      // Swap to the fresh RoomHandle. onRoomJoined rewires all listeners
      // on the new room, caches the rotated resume token, and hides the
      // overlay.
      this.onRoomJoined(result.room);
      this.reconnectInFlight = false;
      return;
    }

    // All attempts failed. Token is stale by definition (past grace).
    overlay.showFinal("Lost connection. Returning home.");
    if (code) clearRoomToken(code);
    this.currentRoomCode = "";
    this.room = null;
    // Brief pause so the final message is readable before we reset.
    this.time.delayedCall(2000, () => {
      overlay.hide();
      this.renderHome();
      this.reconnectInFlight = false;
    });
  }

  private ensureOverlay(): ReconnectingOverlay {
    if (!this.reconnectingOverlay) {
      this.reconnectingOverlay = new ReconnectingOverlay({ scene: this });
      this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
        this.reconnectingOverlay?.destroy();
        this.reconnectingOverlay = null;
        this.tearDownRoomListeners();
      });
    }
    return this.reconnectingOverlay;
  }

  private renderRoom(): void {
    dlogUnthrottled("scene", "LobbyScene.renderRoom", {
      phase: this.room?.state.phase,
      playerCount: Object.keys(this.room?.state.players ?? {}).length,
    });
    this.clearRoom();
    if (!this.room) return;

    const state = this.room.state;
    const mySessionId = this.room.sessionId;
    const vm = toViewModel(state, mySessionId);

    // If we reconnected into a room whose selectedMapId is now hidden
    // (e.g. a legacy map after ADR-003 deprecation), ask the host to
    // switch to the first visible biome so the picker shows a valid state.
    const visibleIds = lobbyIds();
    if (state.selectedMapId && !visibleIds.includes(state.selectedMapId)) {
      const fallback = visibleIds[0] ?? firstId();
      // Only the host can change the map; guest clients surface the stale
      // name and wait for the host to cycle. Safe no-op for non-hosts.
      // Gate on lastNormalizedHiddenMapId so we only send select_map once
      // per distinct hidden id, even if the server echoes stale state
      // across multiple renderRoom ticks before applying our correction.
      if (
        vm.iAmHost &&
        fallback !== state.selectedMapId &&
        this.lastNormalizedHiddenMapId !== state.selectedMapId
      ) {
        this.lastNormalizedHiddenMapId = state.selectedMapId;
        this.room.send({ type: "select_map", mapId: fallback });
      }
    } else {
      this.lastNormalizedHiddenMapId = null;
    }

    const cx = CANVAS_W / 2;

    // Header: code + leave button.
    const header = this.add.text(60, 40, `Room: ${state.code}`, TEXT_STYLE_BODY);
    this.roomObjects.push(header);

    const leaveBtn = this.makeButton(CANVAS_W - 120, 50, 160, 50, "Leave", () => {
      void this.handleLeave();
    });
    this.roomObjects.push(...leaveBtn);

    // Map picker row (host = arrows; guest = read-only name).
    this.renderMapPicker(cx, 160, vm);

    // Player list.
    this.renderPlayerList(cx, 260, vm);

    // Ready + Start buttons at the bottom.
    this.renderActions(cx, 620, vm);
  }

  private renderMapPicker(cx: number, y: number, vm: ViewModel): void {
    const entry = getById(vm.mapId);
    const mapName = entry?.config.name ?? vm.mapId;

    const mapLabel = this.add.text(cx - 260, y, "Map:", TEXT_STYLE_ROOM).setOrigin(0, 0.5);
    this.roomObjects.push(mapLabel);

    if (vm.iAmHost) {
      const prev = this.makeButton(cx - 60, y, 60, 50, "<", () => {
        this.cycleMap(-1);
      });
      this.roomObjects.push(...prev);

      const nameText = this.add.text(cx + 90, y, mapName, TEXT_STYLE_ROOM).setOrigin(0.5);
      this.roomObjects.push(nameText);

      const next = this.makeButton(cx + 240, y, 60, 50, ">", () => {
        this.cycleMap(+1);
      });
      this.roomObjects.push(...next);
    } else {
      const nameText = this.add.text(cx + 90, y, mapName, TEXT_STYLE_ROOM).setOrigin(0.5);
      this.roomObjects.push(nameText);

      const hint = this.add
        .text(cx + 90, y + 34, "(host chooses)", TEXT_STYLE_SMALL)
        .setOrigin(0.5);
      this.roomObjects.push(hint);
    }
  }

  private renderPlayerList(cx: number, y: number, vm: ViewModel): void {
    const header = this.add.text(cx - 340, y, "Players", TEXT_STYLE_ROOM).setOrigin(0, 0.5);
    this.roomObjects.push(header);

    let rowY = y + 58;
    for (const row of vm.players) {
      // Color swatch.
      const swatch = this.add.rectangle(
        cx - 320,
        rowY,
        36,
        36,
        Number.parseInt(row.color.replace("#", ""), 16),
      );
      swatch.setStrokeStyle(2, 0xffffff);
      this.roomObjects.push(swatch);

      // Name + tags.
      const tags: string[] = [];
      if (row.isHost) tags.push("host");
      if (row.isMe) tags.push("you");
      if (row.disconnected) tags.push("disconnected");
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      // Disconnected rows render in a dim grey so the eye skips them. Takes
      // precedence over the "you" highlight because if you're seeing your
      // own row as disconnected we're in a weird state worth surfacing.
      const nameColor = row.disconnected ? "#888888" : row.isMe ? "#ffffaa" : "#e0e0e0";
      const label = this.add.text(cx - 280, rowY, `${row.nickname}${tagStr}`, {
        ...TEXT_STYLE_ROOM,
        color: nameColor,
      });
      label.setOrigin(0, 0.5);
      this.roomObjects.push(label);

      // Ready indicator.
      const readyLabel = row.isHost ? "-" : row.ready ? "READY" : "not ready";
      const readyColor = row.ready ? "#44dd44" : "#aaaaaa";
      const readyText = this.add
        .text(cx + 220, rowY, readyLabel, {
          ...TEXT_STYLE_ROOM,
          color: row.isHost ? "#666666" : readyColor,
        })
        .setOrigin(0, 0.5);
      this.roomObjects.push(readyText);

      rowY += 56;
    }
  }

  private renderActions(cx: number, y: number, vm: ViewModel): void {
    if (vm.iAmHost) {
      // Host sees Start Game, gated by canStart.
      const startBtn = this.makeButton(
        cx,
        y,
        280,
        60,
        "Start Game",
        () => {
          this.handleStart();
        },
        { enabled: vm.canStart, fill: vm.canStart ? 0x228833 : 0x333344 },
      );
      this.roomObjects.push(...startBtn);

      if (!vm.canStart) {
        const msg =
          vm.startBlockedReason === "need-players"
            ? "Waiting for another player to join..."
            : vm.startBlockedReason === "need-ready"
              ? "Waiting for players to ready up..."
              : "";
        if (msg) {
          const reason = this.add.text(cx, y + 50, msg, TEXT_STYLE_SMALL).setOrigin(0.5);
          this.roomObjects.push(reason);
        }
      }
    } else {
      // Non-host sees Ready toggle.
      const label = vm.myReady ? "Unready" : "Ready";
      const fill = vm.myReady ? 0x888844 : 0x228833;
      const readyBtn = this.makeButton(
        cx,
        y,
        280,
        60,
        label,
        () => {
          this.handleToggleReady(!vm.myReady);
        },
        { fill },
      );
      this.roomObjects.push(...readyBtn);
    }
  }

  private clearRoom(): void {
    for (const obj of this.roomObjects) obj.destroy();
    this.roomObjects = [];
  }

  private flashRoomError(msg: string): void {
    const cx = CANVAS_W / 2;
    const txt = this.add.text(cx, 680, msg, TEXT_STYLE_ERROR).setOrigin(0.5);
    this.roomObjects.push(txt);
    this.time.delayedCall(3000, () => {
      if (!txt.scene) return;
      txt.destroy();
    });
  }

  // ---------------------------------------------------------------------------
  // Room actions -> server messages
  // ---------------------------------------------------------------------------

  private cycleMap(dir: 1 | -1): void {
    if (!this.room) return;
    const ids = lobbyIds();
    if (ids.length === 0) return;
    const current = this.room.state.selectedMapId;
    const idx = ids.indexOf(current);
    const nextIdx = ((((idx >= 0 ? idx : 0) + dir) % ids.length) + ids.length) % ids.length;
    const nextId = ids[nextIdx];
    if (!nextId) return;
    this.room.send({ type: "select_map", mapId: nextId });
  }

  private handleToggleReady(next: boolean): void {
    this.room?.send({ type: "set_ready", ready: next });
  }

  private handleStart(): void {
    const room = this.room;
    if (!room) return;
    const mapId = room.state.selectedMapId || "flat";
    // The map generators use Canvas2D which doesn't run on the Cloudflare
    // Workers runtime. Host generates the mask + spawn points locally and
    // ships them in start_game; server uses for physics + forwards them
    // in game_started so every client renders pixel-identical terrain.

    const loadingText = this.add
      .text(CANVAS_W / 2, this.scale.height / 2, "Generating world...", {
        fontSize: "32px",
        color: "#ffffff",
        fontFamily: "system-ui, sans-serif",
        stroke: "#000000",
        strokeThickness: 3,
      })
      .setOrigin(0.5)
      .setDepth(1000);

    try {
      const WORLD_W = 2560;
      const WORLD_H = 1024;
      const loaded = loadMap(mapId, WORLD_W, WORLD_H);
      const ctx = loaded.mask.getContext("2d");
      if (!ctx) throw new Error("mask canvas has no 2d context");
      const img = ctx.getImageData(0, 0, WORLD_W, WORLD_H);
      const bytes = new Uint8Array(WORLD_W * WORLD_H);
      // Alpha > 0 means solid terrain.
      for (let i = 0; i < bytes.length; i++) bytes[i] = img.data[i * 4 + 3] > 0 ? 1 : 0;
      const packed = packMask(bytes);
      const mask = bytesToBase64(packed);
      const spawnPoints = loaded.spawnPoints.map((s) => ({ xPx: s.xPx, yPx: s.yPx }));
      room.send({ type: "start_game", mask, spawnPoints });
    } catch (err) {
      console.warn("[start_game] host could not generate mask, sending without:", err);
      room.send({ type: "start_game" });
    } finally {
      loadingText.destroy();
    }
  }

  private async handleLeave(): Promise<void> {
    const room = this.room;
    // Immediately flip back to home without waiting for the socket's close
    // event. The close ack is async and on mobile/slow connections can take
    // a perceptible beat, making the Leave button feel dead. Tear down
    // listeners + render home synchronously, then fire-and-forget the close.
    this.tearDownRoomListeners();
    this.room = null;
    this.currentRoomCode = "";
    // Drop any cached reconnection token for this room - the user chose to
    // leave, we don't want a page reload to silently rejoin.
    try {
      if (room) {
        const code = room.code;
        if (code) clearRoomToken(code);
      }
    } catch {
      // Best-effort cleanup.
    }
    this.renderHome();
    if (!room) return;
    try {
      room.leave();
    } catch {
      // Already closed.
    }
  }
}

/** Encode a Uint8Array as base64 for transport in a JSON message. */
function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  // Chunk to avoid blowing the arg stack on >1MB buffers.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Re-exported types used by other files importing this module.
export type { LobbyState };
