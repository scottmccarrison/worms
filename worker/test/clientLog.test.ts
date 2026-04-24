/**
 * Unit tests for the client_log rate-limit and validation logic.
 *
 * The core logic is extracted as a pure helper so it's testable without
 * spinning up a full Durable Object.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Pure helper mirroring the onClientLog logic in Room
// ---------------------------------------------------------------------------

interface BudgetEntry {
  count: number;
  windowStart: number;
}

/**
 * Process a client_log message. Returns the log object that would be passed
 * to dlog, or null if the message is dropped (invalid or rate-limited).
 */
function processClientLog(
  msg: unknown,
  sessionId: string,
  budget: Map<symbol, BudgetEntry>,
  socketKey: symbol,
  now: number,
): { event: string; data: Record<string, unknown> } | null {
  const m = msg as { scope?: string; event?: string; data?: unknown };
  if (typeof m.scope !== "string" || typeof m.event !== "string") return null;

  const b = budget.get(socketKey);
  if (!b || now - b.windowStart > 1000) {
    budget.set(socketKey, { count: 1, windowStart: now });
  } else if (b.count >= 30) {
    return null; // drop
  } else {
    b.count++;
  }

  const scope = m.scope.slice(0, 16);
  const event = m.event.slice(0, 64);
  const sid = sessionId.slice(0, 8);
  const safeData =
    typeof m.data === "object" && m.data !== null ? (m.data as Record<string, unknown>) : {};

  return {
    event,
    data: { ...safeData, clientScope: scope, sid },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("clientLog processing", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("valid msg emits with clientScope and sid fields", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const result = processClientLog(
      { scope: "sim", event: "test", data: { x: 1 }, ts: 123 },
      "abc12345xyz",
      budget,
      key,
      Date.now(),
    );
    expect(result).not.toBeNull();
    expect(result!.event).toBe("test");
    expect(result!.data.clientScope).toBe("sim");
    expect(result!.data.sid).toBe("abc12345");
    expect(result!.data.x).toBe(1);
  });

  it("non-string scope returns null (silent drop)", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const result = processClientLog(
      { scope: 42, event: "test" },
      "abc",
      budget,
      key,
      Date.now(),
    );
    expect(result).toBeNull();
  });

  it("non-string event returns null (silent drop)", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const result = processClientLog(
      { scope: "sim", event: null },
      "abc",
      budget,
      key,
      Date.now(),
    );
    expect(result).toBeNull();
  });

  it("truncates scope to 16 chars and event to 64 chars", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const longScope = "a".repeat(30);
    const longEvent = "b".repeat(100);
    const result = processClientLog(
      { scope: longScope, event: longEvent },
      "sid",
      budget,
      key,
      Date.now(),
    );
    expect(result).not.toBeNull();
    expect(result!.data.clientScope).toHaveLength(16);
    expect(result!.event).toHaveLength(64);
  });

  it("spread-first protection: trusted fields (sid, clientScope) overwrite client data", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const result = processClientLog(
      { scope: "sim", event: "test", data: { sid: "evil", clientScope: "evil" } },
      "trustedSid",
      budget,
      key,
      Date.now(),
    );
    expect(result).not.toBeNull();
    // sid and clientScope should come from trusted fields, NOT from client data
    expect(result!.data.sid).toBe("trustedS"); // first 8 chars of "trustedSid"
    expect(result!.data.clientScope).toBe("sim");
    expect(result!.data.sid).not.toBe("evil");
    expect(result!.data.clientScope).not.toBe("evil");
  });

  it("rate limits: 35 calls in same second -> only 30 emit", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const now = Date.now();
    let emitted = 0;
    for (let i = 0; i < 35; i++) {
      const result = processClientLog(
        { scope: "sim", event: `ev${i}` },
        "sid",
        budget,
        key,
        now, // same timestamp = same second window
      );
      if (result !== null) emitted++;
    }
    expect(emitted).toBe(30);
  });

  it("rate limit resets after 1000ms window", () => {
    const budget = new Map<symbol, BudgetEntry>();
    const key = Symbol("ws");
    const now = 1000;
    // Fill up the budget
    for (let i = 0; i < 30; i++) {
      processClientLog({ scope: "sim", event: `ev${i}` }, "sid", budget, key, now);
    }
    // Should be rate-limited now
    const blocked = processClientLog({ scope: "sim", event: "blocked" }, "sid", budget, key, now);
    expect(blocked).toBeNull();
    // After 1001ms, window resets
    const after = processClientLog(
      { scope: "sim", event: "allowed" },
      "sid",
      budget,
      key,
      now + 1001,
    );
    expect(after).not.toBeNull();
  });
});
