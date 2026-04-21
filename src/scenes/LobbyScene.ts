import type { Client, Room, RoomAvailable } from "colyseus.js";
import * as Phaser from "phaser";
import { allIds, getById } from "../maps/registry";
import { clearRoomToken, readRoomToken, saveRoomToken } from "../net/clientStorage";
import { runReconnectLoop } from "../net/reconnectLoop";
import { ALLOWED_COLORS } from "../net/types";
import type { ErrorMessage, GameStartedMessage, LobbyState } from "../net/types";
import { ReconnectingOverlay } from "../ui/ReconnectingOverlay";
import { toViewModel } from "./lobby/renderModel";
import type { ViewModel } from "./lobby/renderModel";
import { buildInviteUrl, shareInvite } from "./lobby/shareInvite";

/**
 * LobbyScene accepts two init shapes:
 *
 * 1. `{ netClient, autoJoinCode }` - the normal BootScene flow. We render
 *    the home view; user picks Create or Join.
 * 2. `{ netClient, room }` - Epic 10 reconnect flow. BootScene successfully
 *    called `client.reconnect(token)` with a cached reconnectionToken and
 *    is handing us the live Room. We skip the home view and jump straight
 *    to the room view.
 */
interface LobbySceneDataHome {
  netClient: Client;
  autoJoinCode: string | null;
}
interface LobbySceneDataReconnect {
  netClient: Client;
  room: Room<LobbyState>;
}
type LobbySceneData = LobbySceneDataHome | LobbySceneDataReconnect;

type View = "home" | "room";

const CANVAS_W = 1280;

const TEXT_STYLE_LARGE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "64px",
  color: "#e0e0e0",
  fontFamily: "system-ui, sans-serif",
};
const TEXT_STYLE_CODE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "72px",
  color: "#88ddff",
  fontFamily: "system-ui, sans-serif",
  fontStyle: "bold",
};
const TEXT_STYLE_BODY: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "22px",
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
 */
export class LobbyScene extends Phaser.Scene {
  private netClient!: Client;
  private autoJoinCode: string | null = null;

  private view: View = "home";
  private nickname = "";
  private selectedColor: string = ALLOWED_COLORS[0];
  private room: Room<LobbyState> | null = null;

  // Home view GameObjects (destroyed on view switch).
  private homeObjects: Phaser.GameObjects.GameObject[] = [];
  // Reference kept so we could future-proof focus() calls.
  protected nicknameInput: Phaser.GameObjects.DOMElement | null = null;
  private joinCodeInput: Phaser.GameObjects.DOMElement | null = null;
  private homeErrorText: Phaser.GameObjects.Text | null = null;

  // Room view GameObjects (destroyed + rebuilt on every state change).
  private roomObjects: Phaser.GameObjects.GameObject[] = [];
  private shareFeedbackText: Phaser.GameObjects.Text | null = null;
  private rawInviteInput: Phaser.GameObjects.DOMElement | null = null;

  constructor() {
    super("LobbyScene");
  }

  // When BootScene hands us a live Room (Epic 10 reconnect path), we stash
  // it here during init() and consume it in create() to jump straight to the
  // room view. Cleared after consumption.
  private pendingReconnectedRoom: Room<LobbyState> | null = null;

  // Epic 10: shared reconnect UI. Lazy-created on first use so a cleanly
  // exited lobby never mounts it. Destroyed on scene shutdown.
  private reconnectingOverlay: ReconnectingOverlay | null = null;

  // Epic 10: guard against overlapping reconnect loops. If the network
  // flaps twice in quick succession we must not kick off two parallel
  // client.reconnect chains (they'd race and one would leave a ghost Room).
  private reconnectInFlight = false;

  // The code for the current room, cached at join time so the onLeave
  // handler can look up the reconnection token without reading stale
  // room state (state may have been freed by the time onLeave fires).
  private currentRoomCode = "";

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
    if (this.pendingReconnectedRoom) {
      // Epic 10: BootScene already did the hard work. Slide straight into
      // the room view with the live Room.
      const room = this.pendingReconnectedRoom;
      this.pendingReconnectedRoom = null;
      this.onRoomJoined(room);
      return;
    }

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
      // Strip non-letters, uppercase, cap at 4. Runs on every keystroke so
      // the user can never hold an invalid value.
      joinNode.value = joinNode.value
        .toUpperCase()
        .replace(/[^A-Z]/g, "")
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

    try {
      this.setHomeError("Creating room...");
      const room = await this.netClient.create<LobbyState>("game", {
        nickname: nick,
        color: this.selectedColor,
      });
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
    if (!/^[A-Z]{4}$/.test(code)) {
      this.setHomeError("Enter a 4-letter room code");
      return;
    }

    const nick = this.validateNickname();
    if (!nick) return;

    try {
      this.setHomeError("Looking up room...");
      // Colyseus matchmaking: room codes live in metadata (server-side
      // .filterBy(["code"])). We query the full list and pick the matching one
      // rather than relying on joinOrCreate's implicit create-on-miss.
      const rooms: RoomAvailable<{ code?: string }>[] = await this.netClient.getAvailableRooms<{
        code?: string;
      }>("game");
      const target = rooms.find((r) => r.metadata?.code === code);
      if (!target) {
        this.setHomeError(`No room with code ${code}`);
        return;
      }
      const room = await this.netClient.joinById<LobbyState>(target.roomId, {
        nickname: nick,
        color: this.selectedColor,
      });
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

  private onRoomJoined(room: Room<LobbyState>): void {
    this.room = room;
    this.currentRoomCode = room.state?.code ?? "";
    this.wireRoomMessages(room);
    this.wireRoomStateListeners(room);
    this.view = "room";
    this.clearHome();
    // Hide any overlay left behind from a previous reconnect attempt.
    this.reconnectingOverlay?.hide();
    // Epic 10: cache the reconnectionToken keyed by the room code so a page
    // reload within the grace window can slide back in via BootScene's
    // reconnect path. Colyseus 0.15 fills state.code synchronously for the
    // creator but may arrive a beat later for joiners, hence the code-ready
    // guard + a belt-and-braces listener below.
    this.saveRoomTokenIfReady(room);
    // First render can run immediately; state has already arrived by the time
    // the join promise resolves in Colyseus 0.15.
    this.renderRoom();
  }

  /**
   * Save the reconnection token as soon as we know the room's code. The code
   * is the only thing we can't derive on reload (roomId + token are in the
   * Room instance already), so we key storage by code and wait for it.
   *
   * Idempotent: calling with an already-saved (code, token) pair just
   * refreshes the timestamp, which is fine.
   */
  private saveRoomTokenIfReady(room: Room<LobbyState>): void {
    const code = room.state?.code ?? "";
    const token = room.reconnectionToken;
    if (code && token) {
      this.currentRoomCode = code;
      saveRoomToken(code, room.roomId, token);
      return;
    }
    // Code not yet populated. Colyseus 0.15 lets us subscribe to a single
    // field; fire once when code lands, then unhook.
    if (!token) return; // token missing is terminal; never save
    const unlisten = room.state.listen("code", (value) => {
      if (value) {
        this.currentRoomCode = value;
        saveRoomToken(value, room.roomId, token);
        unlisten();
      }
    });
  }

  private wireRoomMessages(room: Room<LobbyState>): void {
    room.onMessage<ErrorMessage>("error", (msg) => {
      // Show the error in the room's error band; if we're already home it
      // surfaces there instead.
      if (this.view === "home") {
        this.setHomeError(`${msg.code}: ${msg.message}`);
      } else {
        this.flashRoomError(`${msg.code}: ${msg.message}`);
      }
    });
    room.onMessage<GameStartedMessage>("game_started", (msg) => {
      // Host clicked Start. Hand off to GameScene with authoritative map +
      // seed + team roster; pass the room reference through so Epic 9 can
      // wire server-driven ticks without touching the scene boundary.
      // Epic 10: also forward the NetClient so GameScene's reconnect loop
      // has something to call reconnect() on.
      this.scene.start("GameScene", {
        mapId: msg.mapId,
        seed: msg.seed,
        teams: msg.teams,
        room,
        netClient: this.netClient,
      });
    });
    room.onLeave((code) => {
      // Colyseus close codes:
      // - 1000 (CLOSE_NORMAL) = consented leave (tab close / room.leave()).
      // - 4200 = Colyseus "consented" via room.leave(true).
      // - anything else (1006, 1011, ...) = unexpected drop (wifi, crash).
      // Treat 1000 + 4200 as "user meant this" and do NOT kick off a
      // reconnect loop; any other code triggers the Epic 10 retry flow.
      if (code === 1000 || code === 4200) {
        this.room = null;
        this.renderHome();
        return;
      }
      // Unexpected drop: the server is holding our slot for up to 60s.
      // Keep `this.room` pinned until the loop resolves; if it succeeds
      // we'll swap it, if it fails we renderHome() in the final handler.
      void this.startReconnectionLoop();
    });
  }

  /**
   * Epic 10: unexpected-drop reconnect loop. Shows the shared
   * ReconnectingOverlay and walks the default backoff schedule. On success
   * we rewire the new Room in place; on failure we drop the cached token
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

    const result = await runReconnectLoop<LobbyState>({
      client: this.netClient,
      token: stored.token,
      onAttempt: (n) => overlay.show(n),
    });

    if (result.ok && result.room) {
      // Swap to the fresh Room instance. onRoomJoined rewires all listeners
      // on the new room, caches the rotated token, and hides the overlay.
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
      });
    }
    return this.reconnectingOverlay;
  }

  private wireRoomStateListeners(room: Room<LobbyState>): void {
    // Debounce rerenders to once per animation frame. Without this, bursts
    // of schema patches fire renderRoom many times within a single frame.
    // Each render tears down + recreates the Ready button; each new button
    // lands in Phaser's input `_pendingInsertion` queue. The queue only
    // drains at frame tick, so the current Ready button is never
    // hit-testable. rAF coalescing lets Phaser's input plugin run between
    // renders and promote each new button to the active hit-test list.
    let pending = false;
    const rerender = () => {
      if (pending || this.view !== "room") return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        if (this.view === "room") this.renderRoom();
      });
    };

    // Colyseus 0.15: MapSchema.onChange fires for add/remove/replace of
    // ENTRIES (whole player objects), NOT for field mutations on existing
    // players. To catch `ready` / `color` / `nickname` / `disconnected`
    // flipping, we have to attach a per-player onChange listener on every
    // join. Without this the clicker's own tab never re-renders when they
    // toggle Ready - their local Schema state has the new value, but no
    // listener fires so `renderRoom` isn't called.
    //
    // Other tabs happened to rerender on Carol joining (onAdd fires),
    // which is why it LOOKED like the ready flip propagated to everyone
    // else but not the sender.
    const perPlayerListen = (player: unknown) => {
      // biome-ignore lint/suspicious/noExplicitAny: colyseus.js 0.15 Schema#onChange isn't in our hand-written mirror types
      (player as any).onChange?.(rerender);
    };

    room.state.players.onAdd((player, _key) => {
      rerender();
      perPlayerListen(player);
    });
    room.state.players.onRemove(rerender);
    room.state.players.onChange(rerender);
    room.state.listen("selectedMapId", rerender);
    room.state.listen("hostSessionId", rerender);
    room.state.listen("phase", rerender);

    // Players that joined before we attached the onAdd listener (ourselves,
    // typically) won't fire onAdd retroactively, so hook them up now.
    room.state.players.forEach((player) => perPlayerListen(player));
  }

  private renderRoom(): void {
    this.clearRoom();
    if (!this.room) return;

    const state = this.room.state;
    const mySessionId = this.room.sessionId;
    const vm = toViewModel(state, mySessionId);

    const cx = CANVAS_W / 2;

    // Header: code + leave button.
    const header = this.add.text(60, 40, `Room: ${state.code}`, TEXT_STYLE_BODY);
    this.roomObjects.push(header);

    const bigCode = this.add.text(cx, 120, state.code, TEXT_STYLE_CODE).setOrigin(0.5);
    this.roomObjects.push(bigCode);

    const leaveBtn = this.makeButton(CANVAS_W - 120, 50, 160, 50, "Leave", () => {
      void this.handleLeave();
    });
    this.roomObjects.push(...leaveBtn);

    // Share Invite button sits below the big room code so the host can push
    // the link via the OS share sheet on mobile or the clipboard on desktop.
    this.renderShareInvite(cx, 175, state.code);

    // Map picker row (host = arrows; guest = read-only name).
    this.renderMapPicker(cx, 220, vm);

    // Player list.
    this.renderPlayerList(cx, 310, vm);

    // Ready + Start buttons at the bottom.
    this.renderActions(cx, 620, vm);
  }

  private renderMapPicker(cx: number, y: number, vm: ViewModel): void {
    const entry = getById(vm.mapId);
    const mapName = entry?.config.name ?? vm.mapId;

    const mapLabel = this.add.text(cx - 220, y, "Map:", TEXT_STYLE_BODY).setOrigin(0, 0.5);
    this.roomObjects.push(mapLabel);

    if (vm.iAmHost) {
      const prev = this.makeButton(cx - 40, y, 50, 40, "<", () => {
        this.cycleMap(-1);
      });
      this.roomObjects.push(...prev);

      const nameText = this.add.text(cx + 80, y, mapName, TEXT_STYLE_BODY).setOrigin(0.5);
      this.roomObjects.push(nameText);

      const next = this.makeButton(cx + 200, y, 50, 40, ">", () => {
        this.cycleMap(+1);
      });
      this.roomObjects.push(...next);
    } else {
      const nameText = this.add.text(cx + 80, y, mapName, TEXT_STYLE_BODY).setOrigin(0.5);
      this.roomObjects.push(nameText);

      const hint = this.add
        .text(cx + 80, y + 28, "(host chooses)", TEXT_STYLE_SMALL)
        .setOrigin(0.5);
      this.roomObjects.push(hint);
    }
  }

  private renderPlayerList(cx: number, y: number, vm: ViewModel): void {
    const header = this.add.text(cx - 300, y, "Players", TEXT_STYLE_BODY).setOrigin(0, 0.5);
    this.roomObjects.push(header);

    let rowY = y + 40;
    for (const row of vm.players) {
      // Color swatch.
      const swatch = this.add.rectangle(
        cx - 280,
        rowY,
        28,
        28,
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
      const label = this.add.text(cx - 250, rowY, `${row.nickname}${tagStr}`, {
        ...TEXT_STYLE_BODY,
        color: nameColor,
      });
      label.setOrigin(0, 0.5);
      this.roomObjects.push(label);

      // Ready indicator.
      const readyLabel = row.isHost ? "-" : row.ready ? "READY" : "not ready";
      const readyColor = row.ready ? "#44dd44" : "#aaaaaa";
      const readyText = this.add
        .text(cx + 200, rowY, readyLabel, {
          ...TEXT_STYLE_BODY,
          color: row.isHost ? "#666666" : readyColor,
        })
        .setOrigin(0, 0.5);
      this.roomObjects.push(readyText);

      rowY += 40;
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
        const reason = this.add
          .text(cx, y + 50, "Need 2+ players, all non-host ready", TEXT_STYLE_SMALL)
          .setOrigin(0.5);
        this.roomObjects.push(reason);
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

  /**
   * Share Invite button + feedback area. On mobile the Web Share API opens
   * the OS share sheet; on desktop we fall back to the clipboard. If both
   * fail we reveal a read-only text input with the raw URL so the host can
   * select-and-copy manually.
   */
  private renderShareInvite(cx: number, y: number, code: string): void {
    const shareBtn = this.makeButton(cx, y, 260, 60, "Share Invite", () => {
      void this.handleShareInvite(code);
    });
    this.roomObjects.push(...shareBtn);

    // Small feedback slot for transient "Link copied" messages.
    const feedback = this.add.text(cx, y + 46, "", TEXT_STYLE_SMALL).setOrigin(0.5);
    this.roomObjects.push(feedback);
    this.shareFeedbackText = feedback;
  }

  private async handleShareInvite(code: string): Promise<void> {
    const result = await shareInvite(code, window);
    if (result === "shared") {
      // No feedback: OS share sheet or user cancel is its own feedback.
      return;
    }
    if (result === "copied") {
      this.flashShareFeedback("Link copied");
      return;
    }
    // Failed: reveal a read-only text field with the raw URL.
    this.revealRawInviteUrl(code);
  }

  private flashShareFeedback(msg: string): void {
    const el = this.shareFeedbackText;
    if (!el) return;
    el.setText(msg);
    this.time.delayedCall(2000, () => {
      if (!el.scene) return;
      el.setText("");
    });
  }

  private revealRawInviteUrl(code: string): void {
    // Skip if already revealed (avoid stacking inputs on repeated failures).
    if (this.rawInviteInput) return;
    const cx = CANVAS_W / 2;
    const url = buildInviteUrl(code, window);
    const inputEl = this.add.dom(
      cx,
      255,
      "input",
      "width: 360px; height: 36px; font-size: 16px; padding: 4px 8px; color: #e0e0e0; background: #22222c; border: 1px solid #555; border-radius: 4px; color-scheme: dark; text-align: center;",
    );
    const node = inputEl.node as HTMLInputElement;
    node.setAttribute("type", "text");
    node.setAttribute("readonly", "readonly");
    node.value = url;
    node.addEventListener("focus", () => node.select());
    this.rawInviteInput = inputEl;
    this.roomObjects.push(inputEl);
    this.flashShareFeedback("Copy manually:");
  }

  private clearRoom(): void {
    for (const obj of this.roomObjects) obj.destroy();
    this.roomObjects = [];
    this.shareFeedbackText = null;
    this.rawInviteInput = null;
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
    const ids = allIds();
    if (ids.length === 0) return;
    const current = this.room.state.selectedMapId;
    const idx = ids.indexOf(current);
    const nextIdx = ((((idx >= 0 ? idx : 0) + dir) % ids.length) + ids.length) % ids.length;
    const nextId = ids[nextIdx];
    if (!nextId) return;
    this.room.send("select_map", { mapId: nextId });
  }

  private handleToggleReady(next: boolean): void {
    this.room?.send("set_ready", { ready: next });
  }

  private handleStart(): void {
    this.room?.send("start_game", {});
  }

  private async handleLeave(): Promise<void> {
    const room = this.room;
    if (!room) return;
    try {
      await room.leave(true);
    } catch {
      // onLeave handler drops us back to home regardless.
    }
  }
}
