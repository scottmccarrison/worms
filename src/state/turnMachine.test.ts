import { describe, expect, it } from "vitest";
import { createActor } from "xstate";
import { turnMachine } from "./turnMachine";

describe("turnMachine", () => {
  it("1: idle -> turnActive via START_GAME", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnActive");
    expect(snap.context.teamOrder).toEqual(["red", "blue"]);
    expect(snap.context.currentTeamIdx).toBe(0);
    actor.stop();
  });

  it("2: turnActive -> turnEnding via turn-timer expiry", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "TICK", dtMs: 45001 });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnEnding");
    actor.stop();
  });

  it("3: turnActive accumulates turnElapsedMs via multiple ticks", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    for (let i = 0; i < 5; i++) {
      actor.send({ type: "TICK", dtMs: 100 });
    }
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnActive");
    expect(snap.context.turnElapsedMs).toBe(500);
    actor.stop();
  });

  it("4: turnActive -> turnEnding via END_TURN", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "END_TURN" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnEnding");
    actor.stop();
  });

  it("5: turnActive -> turnEnding via ACTIVE_WORM_DIED", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "ACTIVE_WORM_DIED" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnEnding");
    actor.stop();
  });

  it("6: turnEnding -> turnActive via SETTLED + cycleTeam", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "END_TURN" });
    actor.send({ type: "SETTLED" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnActive");
    expect(snap.context.currentTeamIdx).toBe(1);
    actor.stop();
  });

  it("7: turnEnding -> turnActive via maxSettleReached + cycleTeam", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "END_TURN" });
    actor.send({ type: "TICK", dtMs: 5001 });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("turnActive");
    expect(snap.context.currentTeamIdx).toBe(1);
    actor.stop();
  });

  it("8: turnActive -> gameOver via GAME_OVER with winnerId", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "GAME_OVER", winnerId: "red" });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("gameOver");
    expect(snap.context.winnerId).toBe("red");
    actor.stop();
  });

  it("9: turnEnding -> gameOver via GAME_OVER with null (tie)", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    actor.send({ type: "END_TURN" });
    actor.send({ type: "GAME_OVER", winnerId: null });
    const snap = actor.getSnapshot();
    expect(snap.value).toBe("gameOver");
    expect(snap.context.winnerId).toBeNull();
    actor.stop();
  });

  it("10: cycleTeam wraps around at end of teamOrder", () => {
    const actor = createActor(turnMachine).start();
    actor.send({ type: "START_GAME", teamOrder: ["red", "blue"] });
    // First cycle: idx 0 -> 1
    actor.send({ type: "END_TURN" });
    actor.send({ type: "SETTLED" });
    // Second cycle: idx 1 -> 0 (wrap)
    actor.send({ type: "END_TURN" });
    actor.send({ type: "SETTLED" });
    const snap = actor.getSnapshot();
    expect(snap.context.currentTeamIdx).toBe(0);
    actor.stop();
  });
});
