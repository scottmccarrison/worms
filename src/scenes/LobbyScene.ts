import * as Phaser from "phaser";
import type { Client } from "colyseus.js";

interface LobbySceneData {
  netClient: Client;
  autoJoinCode: string | null;
}

/**
 * Lobby scene stub - home + room views wired up in follow-up commits.
 * Receives the shared NetClient and any `?room=CODE` deep link from BootScene.
 */
export class LobbyScene extends Phaser.Scene {
  private netClient!: Client;
  private autoJoinCode: string | null = null;

  constructor() {
    super("LobbyScene");
  }

  init(data: LobbySceneData): void {
    this.netClient = data.netClient;
    this.autoJoinCode = data.autoJoinCode;
  }

  create(): void {
    // Views wired in follow-up commits (home view, room view, game_started handoff).
    // Reference the fields so TypeScript noUnusedLocals doesn't complain yet.
    void this.netClient;
    void this.autoJoinCode;
    this.add.text(20, 20, "Lobby (boot)", {
      fontSize: "20px",
      color: "#e0e0e0",
      fontFamily: "system-ui, sans-serif",
    });
  }
}
