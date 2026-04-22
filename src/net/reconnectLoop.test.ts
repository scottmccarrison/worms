import { describe, expect, it, vi } from "vitest";
import type { NetClient } from "./client";
import { runReconnectLoop } from "./reconnectLoop";

/**
 * Mock NetClient that returns a scripted sequence of ok/fail for joinRoom.
 * Each call pops one response off the front of the list.
 */
function makeNetClient(responses: Array<"ok" | "fail">): NetClient {
  let i = 0;
  const joinRoom = vi.fn(() => {
    const r = responses[i++];
    if (r === "ok") {
      // Minimal shape - tests only assert `ok` + presence of `room`.
      return Promise.resolve({
        sessionId: "sid",
        code: "WAVE",
        resumeToken: "resume-new",
        state: {
          code: "WAVE",
          phase: "lobby",
          hostSessionId: "sid",
          selectedMapId: "flat",
          players: {},
          teamOrder: [],
          currentTeamId: "",
          currentWormId: "",
          turnSeq: 0,
          turnEndsAt: 0,
        },
        onStateChange: () => () => {},
        onMessage: () => () => {},
        send: () => {},
        leave: () => {},
        onClose: () => () => {},
      } as unknown as Awaited<ReturnType<NetClient["joinRoom"]>>);
    }
    return Promise.reject(new Error("joinRoom failed"));
  });
  return {
    httpBase: "http://test",
    wsBase: "ws://test",
    createRoom: vi.fn(),
    joinRoom,
  } as unknown as NetClient;
}

describe("runReconnectLoop", () => {
  it("returns the room on first attempt success", async () => {
    const netClient = makeNetClient(["ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    const onAttempt = vi.fn();
    const result = await runReconnectLoop({
      netClient,
      code: "WAVE",
      nickname: "p",
      color: "#ff4444",
      resumeToken: "tok",
      backoffs: [0, 0, 0],
      sleep,
      onAttempt,
    });
    expect(result.ok).toBe(true);
    expect(result.room).toBeDefined();
    expect(netClient.joinRoom).toHaveBeenCalledTimes(1);
    expect(netClient.joinRoom).toHaveBeenCalledWith("WAVE", "p", "#ff4444", "tok");
    expect(onAttempt).toHaveBeenCalledWith(1);
  });

  it("retries on failure then succeeds", async () => {
    const netClient = makeNetClient(["fail", "fail", "ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    const onAttempt = vi.fn();
    const result = await runReconnectLoop({
      netClient,
      code: "WAVE",
      nickname: "p",
      color: "#ff4444",
      resumeToken: "tok",
      backoffs: [0, 0, 0, 0],
      sleep,
      onAttempt,
    });
    expect(result.ok).toBe(true);
    expect(netClient.joinRoom).toHaveBeenCalledTimes(3);
    expect(onAttempt.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("returns { ok: false } when all attempts fail", async () => {
    const netClient = makeNetClient(["fail", "fail", "fail"]);
    const sleep = vi.fn(() => Promise.resolve());
    const result = await runReconnectLoop({
      netClient,
      code: "WAVE",
      nickname: "p",
      color: "#ff4444",
      resumeToken: "tok",
      backoffs: [0, 0, 0],
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(result.room).toBeUndefined();
    expect(netClient.joinRoom).toHaveBeenCalledTimes(3);
  });

  it("honours the sleep schedule", async () => {
    const netClient = makeNetClient(["fail", "ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    await runReconnectLoop({
      netClient,
      code: "WAVE",
      nickname: "p",
      color: "#ff4444",
      resumeToken: "tok",
      backoffs: [500, 1000, 2000],
      sleep,
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });

  it("forwards the resume token on every attempt", async () => {
    const netClient = makeNetClient(["fail", "ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    await runReconnectLoop({
      netClient,
      code: "WAVE",
      nickname: "p",
      color: "#ff4444",
      resumeToken: "resume-xyz",
      backoffs: [0, 0],
      sleep,
    });
    const calls = (netClient.joinRoom as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0]).toEqual(["WAVE", "p", "#ff4444", "resume-xyz"]);
    expect(calls[1]).toEqual(["WAVE", "p", "#ff4444", "resume-xyz"]);
  });
});
