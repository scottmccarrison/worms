/**
 * Unit tests for the hand-rolled WebSocket transport (Epic 13).
 *
 * Strategy: install a MockWebSocket on globalThis.WebSocket before each
 * test and drive the full lifecycle through its scripted hooks. No real
 * network, no timers. The mock is intentionally minimal: only the event
 * names + `send` / `close` / `readyState` that wsClient actually touches.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMsg, LobbyState, ServerMsg } from "../../shared/protocol";
import { createRoom, joinRoom } from "./wsClient";

// ---------------------------------------------------------------------------
// Mock WebSocket
// ---------------------------------------------------------------------------

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: MockWebSocket[] = [];
  static lastUrl = "";

  readyState: number = MockWebSocket.CONNECTING;
  url: string;
  sent: string[] = [];
  listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
    MockWebSocket.lastUrl = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(name: string, cb: Listener): void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(cb);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code = 1000, _reason?: string): void {
    this.readyState = MockWebSocket.CLOSED;
    const ev = { code, reason: _reason ?? "" };
    this.fire("close", ev);
  }

  // --- test helpers (not part of the real API) ---

  fire(name: string, ev: unknown): void {
    const set = this.listeners.get(name);
    if (!set) return;
    for (const cb of set) cb(ev);
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN;
    this.fire("open", {});
  }

  recv(msg: ServerMsg): void {
    this.fire("message", { data: JSON.stringify(msg) });
  }

  recvRaw(data: string): void {
    this.fire("message", { data });
  }
}

// Convenient baseline state used by happy-path tests.
function baselineState(overrides: Partial<LobbyState> = {}): LobbyState {
  return {
    code: "WAVE",
    phase: "lobby",
    hostSessionId: "sid-1",
    selectedMapId: "flat",
    players: {},
    teamOrder: [],
    currentTeamId: "",
    currentWormId: "",
    turnSeq: 0,
    turnEndsAt: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

type WithWs = typeof globalThis & { WebSocket?: unknown; fetch?: unknown };

const g = globalThis as WithWs;

beforeEach(() => {
  MockWebSocket.instances = [];
  MockWebSocket.lastUrl = "";
  vi.stubGlobal("WebSocket", MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// joinRoom
// ---------------------------------------------------------------------------

describe("joinRoom", () => {
  it("resolves with a handle populated from the welcome message", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    // Drive the mock socket to success.
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    if (!ws) return;
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });

    const room = await p;
    expect(room.sessionId).toBe("sid-1");
    expect(room.resumeToken).toBe("resume-abc");
    expect(room.code).toBe("WAVE");
    expect(room.state.phase).toBe("lobby");
  });

  it("builds the URL with nickname + color + optional resumeToken", async () => {
    const p = joinRoom("ws://example.test", "wave", "alice", "#ff4444", "tok-1");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    await p;
    expect(MockWebSocket.lastUrl).toContain("ws://example.test/api/room/WAVE");
    expect(MockWebSocket.lastUrl).toContain("nickname=alice");
    expect(MockWebSocket.lastUrl).toContain("color=%23ff4444");
    expect(MockWebSocket.lastUrl).toContain("resumeToken=tok-1");
  });

  it("rejects if the socket closes before welcome arrives", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.close(1006);
    await expect(p).rejects.toThrow(/closed before welcome/);
  });

  it("state message updates handle.state and fires onStateChange", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState({ selectedMapId: "flat" }),
    });
    const room = await p;

    const changes: LobbyState[] = [];
    room.onStateChange((s) => changes.push(s));

    ws.recv({ type: "state", state: baselineState({ selectedMapId: "hills" }) });

    expect(room.state.selectedMapId).toBe("hills");
    expect(changes).toHaveLength(1);
    expect(changes[0]?.selectedMapId).toBe("hills");
  });

  it("onMessage dispatches typed payloads by `type`", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    const errors: Array<{ code: string; message: string }> = [];
    room.onMessage("error", (msg) => errors.push({ code: msg.code, message: msg.message }));

    const walks: Array<{ dir: number; seq: number }> = [];
    room.onMessage("input_walk", (msg) => walks.push({ dir: msg.dir, seq: msg.seq }));

    ws.recv({ type: "error", code: "bad_code", message: "nope" });
    ws.recv({ type: "input_walk", dir: 1, seq: 42 });

    expect(errors).toEqual([{ code: "bad_code", message: "nope" }]);
    expect(walks).toEqual([{ dir: 1, seq: 42 }]);
  });

  it("onMessage returns an unsub fn that stops future callbacks", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    const errors: string[] = [];
    const unsub = room.onMessage("error", (msg) => errors.push(msg.code));

    ws.recv({ type: "error", code: "first", message: "" });
    unsub();
    ws.recv({ type: "error", code: "second", message: "" });
    expect(errors).toEqual(["first"]);
  });

  it("send serializes a ClientMsg and calls socket.send when OPEN", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    const msg: ClientMsg = { type: "set_ready", ready: true };
    room.send(msg);

    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0] ?? "")).toEqual(msg);
  });

  it("send is a no-op when the socket is not OPEN", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    ws.readyState = MockWebSocket.CLOSED;
    room.send({ type: "set_ready", ready: false });
    expect(ws.sent).toHaveLength(0);
  });

  it("leave() closes the socket with code 1000 and fires onClose subscribers", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    const closeCodes: number[] = [];
    room.onClose((code) => closeCodes.push(code));

    room.leave();
    expect(closeCodes).toEqual([1000]);
    expect(ws.readyState).toBe(MockWebSocket.CLOSED);
  });

  it("ignores malformed JSON messages instead of crashing", async () => {
    const p = joinRoom("ws://example.test", "WAVE", "alice", "#ff4444");
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("mock socket not created");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    const events: string[] = [];
    room.onMessage("error", () => events.push("error"));
    ws.recvRaw("not-json");
    // Malformed data got logged and swallowed, not dispatched.
    expect(events).toEqual([]);
    err.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// createRoom
// ---------------------------------------------------------------------------

describe("createRoom", () => {
  it("POSTs /api/room, then joins the returned code", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(JSON.stringify({ code: "WAVE" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const p = createRoom("http://example.test", "alice", "#ff4444");
    // Wait until joinRoom has opened the WS. The fetch + JSON parse pipe
    // takes several microtasks; poll a handful of turns to avoid flakiness
    // across Node + Vitest versions.
    for (let i = 0; i < 20 && MockWebSocket.instances.length === 0; i++) {
      await Promise.resolve();
    }
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error("WebSocket never created");
    ws.open();
    ws.recv({
      type: "welcome",
      sessionId: "sid-1",
      resumeToken: "resume-abc",
      state: baselineState(),
    });
    const room = await p;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0];
    if (!call) throw new Error("fetch never called");
    const [urlArg, initArg] = call;
    expect(urlArg).toBe("http://example.test/api/room");
    expect(initArg).toBeDefined();
    if (!initArg) throw new Error("fetch init missing");
    expect(initArg.method).toBe("POST");
    expect(JSON.parse((initArg.body as string) ?? "")).toEqual({
      nickname: "alice",
      color: "#ff4444",
    });
    expect(room.code).toBe("WAVE");
    expect(MockWebSocket.lastUrl).toContain("ws://example.test/api/room/WAVE");
  });

  it("rejects when POST returns non-OK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 500 })),
    );
    await expect(createRoom("http://example.test", "alice", "#ff4444")).rejects.toThrow(/HTTP 500/);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("rejects when worker returns no code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    await expect(createRoom("http://example.test", "alice", "#ff4444")).rejects.toThrow(/no code/);
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});

// Explicit reference to g to satisfy strict-mode no-unused.
void g;
