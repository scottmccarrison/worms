import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dlog, dlogUnthrottled, isLoggerEnabled, setLoggerEnabled } from "./logger";

describe("logger", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    // Start each test with logger disabled to avoid leaking state.
    setLoggerEnabled(false);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    setLoggerEnabled(false);
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
});
