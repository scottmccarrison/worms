import * as Phaser from "phaser";
import type { Client, Room, RoomAvailable } from "colyseus.js";
import { allIds, getById } from "../maps/registry";
import { ALLOWED_COLORS } from "../net/types";
import type { ErrorMessage, LobbyState } from "../net/types";
import { toViewModel } from "./lobby/renderModel";
import type { ViewModel } from "./lobby/renderModel";

interface LobbySceneData {
  netClient: Client;
  autoJoinCode: string | null;
}

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

  constructor() {
    super("LobbyScene");
  }

  init(data: LobbySceneData): void {
    this.netClient = data.netClient;
    this.autoJoinCode = data.autoJoinCode;
  }

  create(): void {
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

    const nicknameLabel = this.add
      .text(cx, 240, "Nickname", TEXT_STYLE_BODY)
      .setOrigin(0.5);
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

    // Join Room section.
    const joinEl = this.add.dom(cx + 170, 400, "input", INPUT_CSS);
    const joinNode = joinEl.node as HTMLInputElement;
    joinNode.setAttribute("type", "text");
    joinNode.setAttribute("maxlength", "4");
    joinNode.setAttribute("placeholder", "CODE");
    joinNode.style.textTransform = "uppercase";
    joinNode.style.textAlign = "center";
    joinNode.addEventListener("input", () => {
      joinNode.value = joinNode.value.toUpperCase().replace(/[^A-Z]/g, "");
    });
    this.joinCodeInput = joinEl;
    this.homeObjects.push(joinEl);

    const joinBtn = this.makeButton(cx + 170, 470, 260, 50, "Join Room", () => {
      void this.handleJoin();
    });
    this.homeObjects.push(...joinBtn);

    this.homeErrorText = this.add
      .text(cx, 560, "", TEXT_STYLE_ERROR)
      .setOrigin(0.5);
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
    const nick = this.validateNickname();
    if (!nick) return;

    const codeRaw = this.joinCodeInput
      ? (this.joinCodeInput.node as HTMLInputElement).value
      : "";
    const code = codeRaw.trim().toUpperCase();
    if (!/^[A-Z]{4}$/.test(code)) {
      this.setHomeError("Enter a 4-letter room code");
      return;
    }

    try {
      this.setHomeError("Looking up room...");
      // Colyseus matchmaking: room codes live in metadata (server-side
      // .filterBy(["code"])). We query the full list and pick the matching one
      // rather than relying on joinOrCreate's implicit create-on-miss.
      const rooms: RoomAvailable<{ code?: string }>[] =
        await this.netClient.getAvailableRooms<{ code?: string }>("game");
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
    this.wireRoomMessages(room);
    this.wireRoomStateListeners(room);
    this.view = "room";
    this.clearHome();
    // First render can run immediately; state has already arrived by the time
    // the join promise resolves in Colyseus 0.15.
    this.renderRoom();
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
    room.onLeave(() => {
      this.room = null;
      this.renderHome();
    });
  }

  private wireRoomStateListeners(room: Room<LobbyState>): void {
    // Colyseus 0.15: attach listeners directly on state. Every mutation path
    // (add/remove/change/scalar listen) triggers a full re-render. The room
    // view is small enough that tear-down + rebuild is fine; if perf ever
    // bites, swap for targeted updates.
    const rerender = () => {
      if (this.view === "room") this.renderRoom();
    };
    room.state.players.onAdd(rerender);
    room.state.players.onRemove(rerender);
    room.state.players.onChange(rerender);
    room.state.listen("selectedMapId", rerender);
    room.state.listen("hostSessionId", rerender);
    room.state.listen("phase", rerender);
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
      const nameText = this.add
        .text(cx + 80, y, mapName, TEXT_STYLE_BODY)
        .setOrigin(0.5);
      this.roomObjects.push(nameText);

      const hint = this.add
        .text(cx + 80, y + 28, "(host chooses)", TEXT_STYLE_SMALL)
        .setOrigin(0.5);
      this.roomObjects.push(hint);
    }
  }

  private renderPlayerList(cx: number, y: number, vm: ViewModel): void {
    const header = this.add
      .text(cx - 300, y, "Players", TEXT_STYLE_BODY)
      .setOrigin(0, 0.5);
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
      const tagStr = tags.length > 0 ? ` (${tags.join(", ")})` : "";
      const label = this.add.text(cx - 250, rowY, `${row.nickname}${tagStr}`, {
        ...TEXT_STYLE_BODY,
        color: row.isMe ? "#ffffaa" : "#e0e0e0",
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
    const ids = allIds();
    if (ids.length === 0) return;
    const current = this.room.state.selectedMapId;
    const idx = ids.indexOf(current);
    const nextIdx = (((idx >= 0 ? idx : 0) + dir) % ids.length + ids.length) % ids.length;
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
