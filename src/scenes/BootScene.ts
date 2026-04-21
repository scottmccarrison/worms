import * as Phaser from "phaser";
import { createNetClient } from "../net/client";
import { parseUrlParams } from "./lobby/urlParams";
import type { UrlParams } from "./lobby/urlParams";

/**
 * Transient boot scene. Parses URL params, creates the singleton NetClient,
 * and routes to either GameScene (offline dev mode) or LobbyScene (normal).
 *
 * Renders no visible UI - Phaser runs this, the next scene takes over on the
 * same frame.
 */
export class BootScene extends Phaser.Scene {
  private urlParams!: UrlParams;

  constructor() {
    super("BootScene");
  }

  init(): void {
    this.urlParams = parseUrlParams(window.location.search);
  }

  create(): void {
    if (this.urlParams.offline) {
      // Dev shortcut: skip multiplayer entirely. Preserves Epic 7 behaviour
      // when GameScene is booted directly.
      this.scene.start("GameScene", { mapId: this.urlParams.mapId ?? undefined });
      return;
    }

    const netClient = createNetClient();
    this.scene.start("LobbyScene", {
      netClient,
      autoJoinCode: this.urlParams.autoJoinCode,
    });
  }
}
