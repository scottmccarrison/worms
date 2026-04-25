import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testGetThrottleMapSize,
  _testResetFwdBudget,
  dlog,
  dlogUnthrottled,
  getLogForwarder,
  isLoggerEnabled,
  setLogContext,
  setLogForwarder,
  setLoggerEnabled,
} from "./logger";

describe("logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Start each test with logger disabled to avoid leaking state.
    setLoggerEnabled(false);
    setLogContext({ room: undefined, turn: undefined });
    setLogForwarder(null);
    _testResetFwdBudget();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    setLoggerEnabled(false);
    setLogContext({ room: undefined, turn: undefined });
    setLogForwarder(null);
    _testResetFwdBudget();
  });

  describe("when disabled", () => {
    it("dlog produces no console output", () => {
      expect(isLoggerEnabled()).toBe(false);
      dlog("scene", "some.event", { x: 1 });
      expect(consoleSpy).not.toHaveBeenCalled();
    });

    it("dlogUnthrottled produces no console output", () => {
      expect(isLoggerEnabled()).toBe(false);
      dlogUnthrottled("net", "some.event", { y: 2 });
      expect(consoleSpy).not.toHaveBeenCalled();
    });
  });

  describe("throttle behavior", () => {
    it("suppresses the second call to the same (scope, event) within 16ms", () => {
      setLoggerEnabled(true);
      // Call twice synchronously - same millisecond, so within 16ms window.
      dlog("sim", "turn_changed", { teamId: "red" });
      dlog("sim", "turn_changed", { teamId: "blue" });
      // Only the first should have emitted.
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    });

    it("does not throttle different events against each other", () => {
      setLoggerEnabled(true);
      dlog("sim", "event_a");
      dlog("sim", "event_b");
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });

    it("dlogUnthrottled always emits even for the same (scope, event) back-to-back", () => {
      setLoggerEnabled(true);
      dlogUnthrottled("scene", "GameScene.create", { isNetworked: false });
      dlogUnthrottled("scene", "GameScene.create", { isNetworked: true });
      expect(consoleSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("prefix format", () => {
    it("logs [scope] event without data when data is undefined", () => {
      setLoggerEnabled(true);
      dlogUnthrottled("net", "state_received");
      expect(consoleSpy).toHaveBeenCalledWith("[net] state_received");
    });

    it("logs [scope] event followed by data when data is provided", () => {
      setLoggerEnabled(true);
      const data = { phase: "lobby" };
      dlogUnthrottled("net", "state_received", data);
      expect(consoleSpy).toHaveBeenCalledWith("[net] state_received", data);
    });

    it("uses the correct scope prefix in the output", () => {
      setLoggerEnabled(true);
      dlogUnthrottled("camera", "follow_target_changed");
      expect(consoleSpy).toHaveBeenCalledWith("[camera] follow_target_changed");
    });
  });

  describe("setLogContext", () => {
    it("injects room and turn into log output", () => {
      setLoggerEnabled(true);
      setLogContext({ room: "WAVE", turn: 3 });
      dlogUnthrottled("scene", "test");
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("room=WAVE turn=3"));
    });

    it("omits room= when room is empty string", () => {
      setLoggerEnabled(true);
      setLogContext({ room: "" });
      dlogUnthrottled("scene", "test");
      const call = consoleSpy.mock.calls[0];
      expect(call).toBeDefined();
      expect((call as unknown[])[0] as string).not.toContain("room=");
    });
  });

  describe("forwarder", () => {
    it("calls forwarder when set (non-net scope)", () => {
      setLoggerEnabled(true);
      const mock = vi.fn();
      setLogForwarder(mock);
      dlogUnthrottled("sim", "evt", { x: 1 });
      expect(mock).toHaveBeenCalledWith("sim", "evt", { x: 1 });
    });

    it("rate-limits forwarder to 20 calls per second per scope", () => {
      vi.useFakeTimers();
      vi.setSystemTime(1000);
      setLoggerEnabled(true);
      const mock = vi.fn();
      setLogForwarder(mock);
      // 25 calls with unique events to avoid 16ms console-throttle.
      for (let i = 0; i < 25; i++) {
        dlogUnthrottled("sim", `e${i}`, { i });
      }
      expect(mock).toHaveBeenCalledTimes(20);
      vi.useRealTimers();
    });

    it("skips forwarding for scope=net to prevent feedback loops", () => {
      setLoggerEnabled(true);
      const mock = vi.fn();
      setLogForwarder(mock);
      dlogUnthrottled("net", "send");
      expect(mock).not.toHaveBeenCalled();
    });

    it("swallows errors thrown by forwarder", () => {
      setLoggerEnabled(true);
      setLogForwarder(() => {
        throw new Error("oops");
      });
      expect(() => dlogUnthrottled("sim", "test")).not.toThrow();
    });
  });

  describe("LRU cap on throttle map", () => {
    it("prunes the throttle map when it exceeds 256 keys", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      setLoggerEnabled(true);
      // Insert 300 unique keys to trigger pruning.
      for (let i = 0; i < 300; i++) {
        vi.setSystemTime(i * 100); // advance time to bypass throttle
        dlog("sim", `ev${i}`);
      }
      // Map should be at most 256 (pruned to half when exceeded, so <= 256).
      expect(_testGetThrottleMapSize()).toBeLessThanOrEqual(256);
      vi.useRealTimers();
    });
  });

  describe("getLogForwarder", () => {
    it("returns null when no forwarder is set", () => {
      expect(getLogForwarder()).toBeNull();
    });

    it("returns the set forwarder", () => {
      const fn = vi.fn();
      setLogForwarder(fn);
      expect(getLogForwarder()).toBe(fn);
    });
  });
});
