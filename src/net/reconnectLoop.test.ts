import { describe, expect, it, vi } from "vitest";
import { runReconnectLoop } from "./reconnectLoop";

type FakeClient = {
  reconnect: ReturnType<typeof vi.fn>;
};

function makeClient(responses: Array<"ok" | "fail">): FakeClient {
  let i = 0;
  return {
    reconnect: vi.fn(() => {
      const r = responses[i++];
      if (r === "ok") {
        return Promise.resolve({ fake: true, reconnectionToken: "new" });
      }
      return Promise.reject(new Error("reconnect failed"));
    }),
  };
}

describe("runReconnectLoop", () => {
  it("returns the room on first attempt success", async () => {
    const client = makeClient(["ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    const onAttempt = vi.fn();
    const result = await runReconnectLoop({
      client: client as unknown as Parameters<typeof runReconnectLoop>[0]["client"],
      token: "room1:tok1",
      backoffs: [0, 0, 0],
      sleep,
      onAttempt,
    });
    expect(result.ok).toBe(true);
    expect(result.room).toBeDefined();
    expect(client.reconnect).toHaveBeenCalledTimes(1);
    expect(onAttempt).toHaveBeenCalledWith(1);
  });

  it("retries on failure then succeeds", async () => {
    const client = makeClient(["fail", "fail", "ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    const onAttempt = vi.fn();
    const result = await runReconnectLoop({
      client: client as unknown as Parameters<typeof runReconnectLoop>[0]["client"],
      token: "room1:tok1",
      backoffs: [0, 0, 0, 0],
      sleep,
      onAttempt,
    });
    expect(result.ok).toBe(true);
    expect(client.reconnect).toHaveBeenCalledTimes(3);
    expect(onAttempt.mock.calls).toEqual([[1], [2], [3]]);
  });

  it("returns { ok: false } when all attempts fail", async () => {
    const client = makeClient(["fail", "fail", "fail"]);
    const sleep = vi.fn(() => Promise.resolve());
    const result = await runReconnectLoop({
      client: client as unknown as Parameters<typeof runReconnectLoop>[0]["client"],
      token: "room1:tok1",
      backoffs: [0, 0, 0],
      sleep,
    });
    expect(result.ok).toBe(false);
    expect(result.room).toBeUndefined();
    expect(client.reconnect).toHaveBeenCalledTimes(3);
  });

  it("honours the sleep schedule", async () => {
    const client = makeClient(["fail", "ok"]);
    const sleep = vi.fn(() => Promise.resolve());
    await runReconnectLoop({
      client: client as unknown as Parameters<typeof runReconnectLoop>[0]["client"],
      token: "room1:tok1",
      backoffs: [500, 1000, 2000],
      sleep,
    });
    expect(sleep).toHaveBeenNthCalledWith(1, 500);
    expect(sleep).toHaveBeenNthCalledWith(2, 1000);
  });
});
