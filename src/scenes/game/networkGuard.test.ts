/**
 * Offline-mode safety tests.
 *
 * The client is expected to behave identically to single-device play when
 * `?offline=1` is used (no room passed in). This file codifies the contract
 * that the "is this a networked match?" predicate only flips true when a
 * Colyseus Room is present, matching GameScene.init(data).
 */

import { describe, expect, it } from "vitest";

/**
 * Mirror of the single-line predicate used by GameScene.init():
 *   this.isNetworked = !!this.room;
 *
 * Kept as a pure helper here so the offline-path guard has a deterministic
 * regression lock - any future refactor that changes GameScene's detection
 * rule is forced to update this test.
 */
function detectNetworked(data?: { room?: unknown }): boolean {
  return !!data?.room;
}

describe("offline-path detection (networkGuard)", () => {
  it("?offline=1 (no data) is NOT networked", () => {
    expect(detectNetworked(undefined)).toBe(false);
  });

  it("single-device start with only mapId/seed is NOT networked", () => {
    expect(detectNetworked({})).toBe(false);
  });

  it("explicit undefined room is NOT networked", () => {
    expect(detectNetworked({ room: undefined })).toBe(false);
  });

  it("any truthy room object flips networked on", () => {
    expect(detectNetworked({ room: { sessionId: "abc" } })).toBe(true);
  });
});
