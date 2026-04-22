import * as Phaser from "phaser";
import { createNetClient } from "../net/client";
import { clearRoomToken, readRoomToken, saveRoomToken } from "../net/clientStorage";
import { parseUrlParams } from "./lobby/urlParams";
import type { UrlParams } from "./lobby/urlParams";

/**
 * Transient boot scene. Parses URL params, creates the singleton NetClient,
 * and routes to either GameScene (offline dev mode) or LobbyScene (normal).
 *
 * Renders no visible UI - Phaser runs this, the next scene takes over on the
 * same frame.
 *
 * Epic 10/13: when we arrive with `?room=CODE` in the URL AND we have a
 * cached resumeToken for that code, try `netClient.joinRoom(code, nick,
 * color, resumeToken)` first. On success the DO matched our token and
 * restored the session; we jump straight into the LobbyScene room view.
 * On failure (stale token, DO hibernated + evicted, grace expired) we
 * clear the token and fall through to the normal join flow.
 *
 * The offline path (`?offline=1`) is a hard short-circuit: no localStorage
 * read, no network call, no NetClient created. Matches the Epic 7
 * single-device contract exactly. Regression-locked in
 * bootSceneOffline.test.ts.
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
      // when GameScene is booted directly. Must stay before any localStorage
      // access so `?offline=1` never touches client storage or the network.
      this.scene.start("GameScene", { mapId: this.urlParams.mapId ?? undefined });
      return;
    }

    // Async wrapper: create() itself can't be async (Phaser ignores the
    // returned promise), but we kick off the reconnect-then-route flow and
    // swallow rejections ourselves.
    void this.bootOnline();
  }

  private async bootOnline(): Promise<void> {
    const netClient = createNetClient();
    const code = this.urlParams.autoJoinCode;

    if (code) {
      const stored = readRoomToken(code);
      if (stored) {
        try {
          // Epic 13: joinRoom opens a WebSocket to the DO with the resume
          // token query param. DO looks up the token in storage, matches
          // it to an existing player slot, and restores our sessionId.
          // Placeholder nickname + color are ignored by the server on a
          // resume-token match; they only kick in if the token is stale
          // and we fall through to fresh-join semantics.
          const room = await netClient.joinRoom(code, "player", "#ff4444", stored.resumeToken);
          // Reconnect succeeded. The resume token rotates on every
          // (re)connect so we immediately refresh the cached value.
          saveRoomToken(code, room.resumeToken);
          this.scene.start("LobbyScene", { netClient, room });
          return;
        } catch {
          // Token was stale / grace expired / DO evicted storage.
          // Drop the bad entry so subsequent reloads don't waste a round-trip.
          clearRoomToken(code);
        }
      }
    }

    // Normal flow: hand off to LobbyScene home view with the code pre-filled.
    this.scene.start("LobbyScene", {
      netClient,
      autoJoinCode: code,
    });
  }
}
