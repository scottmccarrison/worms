import * as Phaser from "phaser";
import type { Client, Room, RoomAvailable } from "colyseus.js";
import { ALLOWED_COLORS } from "../net/types";
import type { ErrorMessage, LobbyState } from "../net/types";

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
const TEXT_STYLE_BODY: Phaser.Types.GameObjects.Text.TextStyle = {
  fontSize: "22px",
  color: "#e0e0e0",
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
 * LobbyScene - two-view Phaser scene.
 *
 * This commit wires the HOME view: title, nickname input, Create Room and
 * Join Room actions. Follow-up commits add the room view + game_started
 * handoff.
 */
export class LobbyScene extends Phaser.Scene {
  private netClient!: Client;
  private autoJoinCode: string | null = null;

  protected view: View = "home";
  private nickname = "";
  private selectedColor: string = ALLOWED_COLORS[0];
  protected room: Room<LobbyState> | null = null;

  // Home view GameObjects (destroyed on view switch).
  private homeObjects: Phaser.GameObjects.GameObject[] = [];
  protected nicknameInput: Phaser.GameObjects.DOMElement | null = null;
  private joinCodeInput: Phaser.GameObjects.DOMElement | null = null;
  private homeErrorText: Phaser.GameObjects.Text | null = null;

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
  ): Phaser.GameObjects.GameObject[] {
    const bg = this.add.rectangle(x, y, w, h, 0x3344aa).setStrokeStyle(2, 0x7788ff);
    bg.setInteractive({ useHandCursor: true });
    bg.on("pointerdown", onClick);
    const text = this.add.text(x, y, label, TEXT_STYLE_BUTTON).setOrigin(0.5);
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
      this.room = room;
      this.wireRoomMessages(room);
      this.setHomeError("");
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
      this.room = room;
      this.wireRoomMessages(room);
      this.setHomeError("");
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
  // Room view + game_started handoff land in follow-up commits.
  // ---------------------------------------------------------------------------

  private wireRoomMessages(room: Room<LobbyState>): void {
    // Contract is defined; full wiring lands with the room view commit.
    // For now: log errors + fall back to home on leave so a closed socket
    // doesn't strand the user on a blank screen.
    room.onMessage<ErrorMessage>("error", (msg) => {
      this.setHomeError(`${msg.code}: ${msg.message}`);
    });
    room.onLeave(() => {
      this.room = null;
      this.renderHome();
    });
  }
}
