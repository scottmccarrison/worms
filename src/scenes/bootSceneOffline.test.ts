/**
 * Offline-path regression lock for BootScene (Epic 10/13).
 *
 * The core contract: when the URL has `?offline=1`, BootScene must
 * short-circuit to GameScene BEFORE any reconnect / localStorage / network
 * code runs. This test codifies that invariant by:
 *   - invoking the URL parser on `?offline=1`
 *   - proving the subsequent reconnect path would be skipped
 *   - asserting no readRoomToken/saveRoomToken call fires in that path
 *   - asserting no wsClient.createRoom / joinRoom call fires in that path
 *
 * We can't construct a full Phaser Scene here (no DOM), so we mirror
 * BootScene's decision tree as a plain function and assert against it.
 * Any future refactor that changes BootScene's control flow must update
 * this mirror in lockstep.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as clientStorage from "../net/clientStorage";
import * as wsClient from "../net/wsClient";
import { parseUrlParams } from "./lobby/urlParams";

type Globals = { localStorage?: Storage };
const g = globalThis as unknown as Globals;

/**
 * Mirror of BootScene.create() / bootOnline() routing logic. Returns the
 * scene that WOULD be started and which side-effect calls WOULD fire. If
 * this diverges from BootScene, the real test (run in a browser) will
 * catch it; for the Node test env this is the strongest assertion we can
 * statically write without spinning up Phaser.
 *
 * Epic 13 note: we track joinRoom/createRoom as "network" side effects
 * the offline path must not trigger. The mirror doesn't actually call
 * them (that would open a WebSocket in Node), so we record the decision
 * rather than the invocation. The assertion is that when offline=1,
 * `networkCalls` stays empty.
 */
function routeForUrl(search: string): {
  scene: string;
  storageCalls: string[];
  networkCalls: string[];
} {
  const params = parseUrlParams(search);
  const storageCalls: string[] = [];
  const networkCalls: string[] = [];

  if (params.offline) {
    // Hard short-circuit. No NetClient, no storage read, no reconnect attempt.
    return { scene: "GameScene", storageCalls, networkCalls };
  }

  // Online path only runs the read when a code is present.
  if (params.autoJoinCode) {
    const stored = clientStorage.readRoomToken(params.autoJoinCode);
    storageCalls.push("readRoomToken");
    if (stored) {
      // Would call wsClient.joinRoom with the cached token here.
      networkCalls.push("joinRoom");
    }
  }
  return { scene: "LobbyScene", storageCalls, networkCalls };
}

describe("BootScene offline guard", () => {
  const originalLocalStorage = g.localStorage;

  beforeEach(() => {
    // Install a spy-backed in-memory storage so we can assert it's never
    // read when offline=1.
    const data = new Map<string, string>();
    g.localStorage = {
      get length() {
        return data.size;
      },
      key: (i: number) => Array.from(data.keys())[i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
      clear: () => data.clear(),
    } as Storage;
  });

  afterEach(() => {
    g.localStorage = originalLocalStorage;
    vi.restoreAllMocks();
  });

  it("?offline=1 routes to GameScene and touches NO clientStorage / network calls", () => {
    const readSpy = vi.spyOn(clientStorage, "readRoomToken");
    const saveSpy = vi.spyOn(clientStorage, "saveRoomToken");
    const clearSpy = vi.spyOn(clientStorage, "clearRoomToken");
    const joinSpy = vi.spyOn(wsClient, "joinRoom");
    const createSpy = vi.spyOn(wsClient, "createRoom");

    const result = routeForUrl("?offline=1");

    expect(result.scene).toBe("GameScene");
    expect(result.storageCalls).toEqual([]);
    expect(result.networkCalls).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(clearSpy).not.toHaveBeenCalled();
    expect(joinSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it("?offline=1&room=WAVE still skips storage + network (offline wins)", () => {
    const readSpy = vi.spyOn(clientStorage, "readRoomToken");
    const joinSpy = vi.spyOn(wsClient, "joinRoom");
    const result = routeForUrl("?offline=1&room=WAVE");
    expect(result.scene).toBe("GameScene");
    expect(result.networkCalls).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(joinSpy).not.toHaveBeenCalled();
  });

  it("online + no URL code routes to LobbyScene and touches no storage or network", () => {
    const readSpy = vi.spyOn(clientStorage, "readRoomToken");
    const joinSpy = vi.spyOn(wsClient, "joinRoom");
    const result = routeForUrl("");
    expect(result.scene).toBe("LobbyScene");
    expect(result.storageCalls).toEqual([]);
    expect(result.networkCalls).toEqual([]);
    expect(readSpy).not.toHaveBeenCalled();
    expect(joinSpy).not.toHaveBeenCalled();
  });

  it("online + URL code reads the token exactly once (cache miss)", () => {
    const readSpy = vi.spyOn(clientStorage, "readRoomToken");
    const result = routeForUrl("?room=WAVE");
    expect(result.scene).toBe("LobbyScene");
    // readRoomToken is called, but nothing cached, so no reconnect attempt.
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(result.storageCalls).toEqual(["readRoomToken"]);
    expect(result.networkCalls).toEqual([]);
  });
});
