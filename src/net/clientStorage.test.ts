import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearRoomToken, readRoomToken, saveRoomToken } from "./clientStorage";

/**
 * Minimal in-memory Storage stub that matches the subset of the Web Storage
 * API we care about. Tests install one on globalThis.localStorage for the
 * duration of the test and restore the original afterwards.
 */
function makeMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    getItem: (k: string) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
    },
    removeItem: (k: string) => {
      data.delete(k);
    },
    clear: () => {
      data.clear();
    },
  } as Storage;
}

type Globals = { localStorage?: Storage };
const g = globalThis as unknown as Globals;

describe("clientStorage", () => {
  const originalLocalStorage = g.localStorage;

  beforeEach(() => {
    g.localStorage = makeMemoryStorage();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-21T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    g.localStorage = originalLocalStorage;
  });

  it("round-trips save -> read", () => {
    saveRoomToken("WAVE", "room-1", "tok-abc");
    const got = readRoomToken("WAVE");
    expect(got).not.toBeNull();
    expect(got?.roomId).toBe("room-1");
    expect(got?.token).toBe("tok-abc");
    expect(got?.code).toBe("WAVE");
  });

  it("read is case-insensitive on the code", () => {
    saveRoomToken("wave", "room-1", "tok-abc");
    expect(readRoomToken("WAVE")?.roomId).toBe("room-1");
    expect(readRoomToken("Wave")?.roomId).toBe("room-1");
  });

  it("read returns null for an unknown code", () => {
    saveRoomToken("WAVE", "room-1", "tok-abc");
    expect(readRoomToken("ZZZZ")).toBeNull();
  });

  it("read returns null for an entry older than 10 minutes", () => {
    saveRoomToken("WAVE", "room-1", "tok-abc");
    // Advance just past the 10-minute expiry.
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    expect(readRoomToken("WAVE")).toBeNull();
  });

  it("clear removes the entry", () => {
    saveRoomToken("WAVE", "room-1", "tok-abc");
    clearRoomToken("WAVE");
    expect(readRoomToken("WAVE")).toBeNull();
  });

  it("save prunes expired entries as a side effect", () => {
    saveRoomToken("WAVE", "room-1", "tok-1");
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    // This save should evict WAVE (older than 10 min) while adding SURF.
    saveRoomToken("SURF", "room-2", "tok-2");
    expect(readRoomToken("WAVE")).toBeNull();
    expect(readRoomToken("SURF")?.roomId).toBe("room-2");
  });

  it("does not throw when localStorage.setItem throws (private mode)", () => {
    const throwing: Storage = {
      get length() {
        return 0;
      },
      key: () => null,
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {},
      clear: () => {},
    } as Storage;
    g.localStorage = throwing;
    expect(() => saveRoomToken("WAVE", "room-1", "tok-abc")).not.toThrow();
    expect(() => clearRoomToken("WAVE")).not.toThrow();
    // readRoomToken returns null because getItem returns null.
    expect(readRoomToken("WAVE")).toBeNull();
  });

  it("does not throw and returns null when localStorage is missing entirely", () => {
    g.localStorage = undefined;
    expect(() => saveRoomToken("WAVE", "room-1", "tok-abc")).not.toThrow();
    expect(readRoomToken("WAVE")).toBeNull();
    expect(() => clearRoomToken("WAVE")).not.toThrow();
  });

  it("malformed stored JSON is treated as empty rather than crashing", () => {
    g.localStorage?.setItem("worms.roomTokens.v1", "not json at all");
    expect(readRoomToken("WAVE")).toBeNull();
    // Subsequent save should succeed and overwrite the malformed blob.
    saveRoomToken("WAVE", "room-1", "tok-abc");
    expect(readRoomToken("WAVE")?.token).toBe("tok-abc");
  });
});
