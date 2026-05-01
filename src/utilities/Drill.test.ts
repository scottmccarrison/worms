import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Worm } from "../worm/Worm";
import { Drill } from "./Drill";

function makeWormStub(): Worm {
  return {} as Worm;
}

describe("Drill utility", () => {
  let drill: Drill;
  let worm: Worm;
  let firedArgs: Array<{ worm: Worm; angleRad: number; nowMs: number }>;

  beforeEach(() => {
    worm = makeWormStub();
    firedArgs = [];
    drill = new Drill(worm, {
      onFire: (w, angleRad, nowMs) => {
        firedArgs.push({ worm: w, angleRad, nowMs });
      },
    });
  });

  describe("arm / disarm / isArmed", () => {
    it("starts disarmed", () => {
      expect(drill.isArmed()).toBe(false);
    });

    it("arm() makes isArmed return true", () => {
      drill.arm();
      expect(drill.isArmed()).toBe(true);
    });

    it("disarm() after arm makes isArmed return false", () => {
      drill.arm();
      drill.disarm();
      expect(drill.isArmed()).toBe(false);
    });

    it("disarm() on already-disarmed drill is a no-op", () => {
      drill.disarm();
      expect(drill.isArmed()).toBe(false);
    });
  });

  describe("fire()", () => {
    it("calls onFire callback with correct worm, angle, and timestamp", () => {
      drill.arm();
      drill.fire(Math.PI / 4, 1000);
      expect(firedArgs).toHaveLength(1);
      expect(firedArgs[0]?.worm).toBe(worm);
      expect(firedArgs[0]?.angleRad).toBeCloseTo(Math.PI / 4);
      expect(firedArgs[0]?.nowMs).toBe(1000);
    });

    it("auto-disarms after fire", () => {
      drill.arm();
      drill.fire(0, 500);
      expect(drill.isArmed()).toBe(false);
    });

    it("fires even when not armed (no gate at this level)", () => {
      drill.fire(0, 500);
      expect(firedArgs).toHaveLength(1);
    });
  });

  describe("cooldown", () => {
    it("is not on cooldown before first fire", () => {
      expect(drill.isOnCooldown(0, 800)).toBe(false);
    });

    it("is on cooldown immediately after fire", () => {
      drill.fire(0, 1000);
      expect(drill.isOnCooldown(1000, 800)).toBe(true);
    });

    it("is on cooldown when elapsed < cooldownMs", () => {
      drill.fire(0, 1000);
      expect(drill.isOnCooldown(1799, 800)).toBe(true);
    });

    it("is off cooldown when elapsed >= cooldownMs", () => {
      drill.fire(0, 1000);
      expect(drill.isOnCooldown(1800, 800)).toBe(false);
    });
  });

  describe("resetForNewTurn()", () => {
    it("clears armed state", () => {
      drill.arm();
      drill.resetForNewTurn();
      expect(drill.isArmed()).toBe(false);
    });

    it("does not reset lastFiredAtMs (cooldown persists across turns)", () => {
      drill.fire(0, 1000);
      drill.arm();
      drill.resetForNewTurn();
      // Still on cooldown right after turn reset
      expect(drill.isOnCooldown(1000, 800)).toBe(true);
    });

    it("clears usesThisTurn so drill is available again next turn", () => {
      drill.fire(0, 1000);
      expect(drill.hasUsesRemaining(1)).toBe(false);
      drill.resetForNewTurn();
      expect(drill.hasUsesRemaining(1)).toBe(true);
    });

    it("is idempotent when already disarmed", () => {
      drill.resetForNewTurn();
      expect(drill.isArmed()).toBe(false);
    });
  });

  describe("hasUsesRemaining() / per-turn cap", () => {
    it("starts with all uses remaining", () => {
      expect(drill.hasUsesRemaining(1)).toBe(true);
      expect(drill.hasUsesRemaining(3)).toBe(true);
    });

    it("returns false after the cap is reached", () => {
      drill.fire(0, 100);
      expect(drill.hasUsesRemaining(1)).toBe(false);
    });

    it("respects the cap argument independently of how many fires happened", () => {
      drill.fire(0, 100);
      expect(drill.hasUsesRemaining(2)).toBe(true);
      drill.fire(0, 200);
      expect(drill.hasUsesRemaining(2)).toBe(false);
    });
  });

  describe("vi.fn callback variant", () => {
    it("onFire is called exactly once per fire call", () => {
      const onFire = vi.fn();
      const d = new Drill(worm, { onFire });
      d.fire(1.2, 500);
      expect(onFire).toHaveBeenCalledTimes(1);
      d.fire(0.5, 600);
      expect(onFire).toHaveBeenCalledTimes(2);
    });
  });
});
