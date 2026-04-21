import { describe, expect, it } from "vitest";
import { ALLOWED_COLORS } from "../../net/types";
import type { LobbyPlayer, LobbyState } from "../../net/types";
import { toViewModel } from "./renderModel";

/**
 * Minimal LobbyState stub. We only need the shape `toViewModel` reads:
 * selectedMapId + players with the LobbyPlayersMap surface.
 */
function makeState(players: LobbyPlayer[], selectedMapId = "flat"): LobbyState {
  const map = new Map<string, LobbyPlayer>(players.map((p) => [p.sessionId, p]));
  return {
    code: "WAVE",
    phase: "lobby",
    hostSessionId: players.find((p) => p.isHost)?.sessionId ?? "",
    selectedMapId,
    players: {
      get size() {
        return map.size;
      },
      forEach: (cb) => map.forEach((v, k) => cb(v, k)),
      get: (k) => map.get(k),
      onAdd: () => {},
      onRemove: () => {},
      onChange: () => {},
    },
    listen: () => () => true,
  };
}

function makePlayer(overrides: Partial<LobbyPlayer> & { sessionId: string }): LobbyPlayer {
  return {
    sessionId: overrides.sessionId,
    nickname: overrides.nickname ?? "player",
    color: overrides.color ?? ALLOWED_COLORS[0],
    ready: overrides.ready ?? false,
    isHost: overrides.isHost ?? false,
  };
}

describe("toViewModel", () => {
  it("marks the current player as host when their sessionId matches", () => {
    const state = makeState([
      makePlayer({ sessionId: "a", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "b", color: "#4488ff" }),
    ]);
    const vm = toViewModel(state, "a");
    expect(vm.iAmHost).toBe(true);
  });

  it("marks a guest view as non-host", () => {
    const state = makeState([
      makePlayer({ sessionId: "a", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "b", color: "#4488ff" }),
    ]);
    const vm = toViewModel(state, "b");
    expect(vm.iAmHost).toBe(false);
  });

  it("places the host first in the player list", () => {
    const state = makeState([
      makePlayer({ sessionId: "guest1" }),
      makePlayer({ sessionId: "host1", isHost: true }),
      makePlayer({ sessionId: "guest2" }),
    ]);
    const vm = toViewModel(state, "guest1");
    expect(vm.players[0]?.sessionId).toBe("host1");
    expect(vm.players[0]?.isHost).toBe(true);
  });

  it("tags the current player row with isMe", () => {
    const state = makeState([
      makePlayer({ sessionId: "a", isHost: true }),
      makePlayer({ sessionId: "b", color: "#4488ff" }),
    ]);
    const vm = toViewModel(state, "b");
    const me = vm.players.find((p) => p.sessionId === "b");
    expect(me?.isMe).toBe(true);
    const other = vm.players.find((p) => p.sessionId === "a");
    expect(other?.isMe).toBe(false);
  });

  it("myReady reflects the current player's ready flag", () => {
    const state = makeState([
      makePlayer({ sessionId: "a", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "b", color: "#4488ff", ready: true }),
    ]);
    expect(toViewModel(state, "b").myReady).toBe(true);
    expect(toViewModel(state, "a").myReady).toBe(false);
  });

  it("canStart requires host + >=2 players + all non-host ready", () => {
    const base = [
      makePlayer({ sessionId: "h", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "g", color: "#4488ff", ready: true }),
    ];
    expect(toViewModel(makeState(base), "h").canStart).toBe(true);
  });

  it("canStart is false when a non-host is not ready", () => {
    const state = makeState([
      makePlayer({ sessionId: "h", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "g", color: "#4488ff", ready: false }),
    ]);
    expect(toViewModel(state, "h").canStart).toBe(false);
  });

  it("canStart is false for a non-host client even when conditions are met", () => {
    const state = makeState([
      makePlayer({ sessionId: "h", isHost: true, color: "#ff4444" }),
      makePlayer({ sessionId: "g", color: "#4488ff", ready: true }),
    ]);
    expect(toViewModel(state, "g").canStart).toBe(false);
  });

  it("canStart is false with only one player", () => {
    const state = makeState([makePlayer({ sessionId: "h", isHost: true })]);
    expect(toViewModel(state, "h").canStart).toBe(false);
  });

  it("availableColors excludes colors taken by other players", () => {
    const state = makeState([
      makePlayer({ sessionId: "me", color: "#ff4444" }),
      makePlayer({ sessionId: "other", color: "#4488ff" }),
    ]);
    const vm = toViewModel(state, "me");
    // My own color is still available (I can re-pick it).
    expect(vm.availableColors).toContain("#ff4444");
    // Other player's color is filtered out.
    expect(vm.availableColors).not.toContain("#4488ff");
  });

  it("availableColors has the full palette when no other player has a color", () => {
    const state = makeState([makePlayer({ sessionId: "me", color: "#ff4444" })]);
    const vm = toViewModel(state, "me");
    expect(vm.availableColors.length).toBe(ALLOWED_COLORS.length);
  });

  it("mapId passes through from state", () => {
    const state = makeState([makePlayer({ sessionId: "a", isHost: true })], "hills");
    expect(toViewModel(state, "a").mapId).toBe("hills");
  });
});
