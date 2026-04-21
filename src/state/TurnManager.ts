import type * as Phaser from "phaser";
import { type Actor, createActor } from "xstate";
import { tuning } from "../tuning";
import type { Team } from "../worm/Team";
import type { Worm } from "../worm/Worm";
import { turnMachine } from "./turnMachine";

export interface TurnManagerInit {
  scene: Phaser.Scene;
  teams: Team[];
  allWorms: Worm[];
  onTurnStart: (team: Team, worm: Worm) => void;
  onTurnEnd: () => void;
  onGameOver: (winner: Team | null) => void;
}

export class TurnManager {
  private readonly teams: Team[];
  private readonly allWorms: Worm[];
  private readonly actor: Actor<typeof turnMachine>;
  private readonly onTurnStart: (team: Team, worm: Worm) => void;
  private readonly onTurnEnd: () => void;
  private readonly onGameOver: (winner: Team | null) => void;

  private settleHoldMs = 0;
  private lastStateName = "idle";

  constructor(init: TurnManagerInit) {
    this.teams = init.teams;
    this.allWorms = init.allWorms;
    this.onTurnStart = init.onTurnStart;
    this.onTurnEnd = init.onTurnEnd;
    this.onGameOver = init.onGameOver;

    this.actor = createActor(turnMachine);
    this.actor.subscribe((snap) => this.onStateChange(String(snap.value)));
    this.actor.start();
  }

  start(): void {
    // Fisher-Yates shuffle (unbiased; the sort-random-0.5 trick is biased)
    const shuffled = [...this.teams];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i] as Team;
      shuffled[i] = shuffled[j] as Team;
      shuffled[j] = tmp;
    }
    this.actor.send({ type: "START_GAME", teamOrder: shuffled.map((t) => t.id) });
  }

  update(dtMs: number): void {
    const snap = this.actor.getSnapshot();
    const stateName = String(snap.value);

    // Terminal state: stop ticking the actor (it's stopped anyway via type:"final").
    if (stateName === "gameOver" || stateName === "idle") return;

    // Win check runs in turnActive AND turnEnding.
    // Handles mutual-destruction (both teams at zero -> draw via winnerId=null).
    const aliveTeams = this.teams.filter((t) => !t.isEliminated());
    if (aliveTeams.length <= 1) {
      const winnerId = aliveTeams[0]?.id ?? null;
      this.actor.send({ type: "GAME_OVER", winnerId });
      return;
    }

    // Active worm mid-turn death
    if (stateName === "turnActive") {
      const active = this.getActiveWorm();
      if (active && !active.isAlive) {
        this.actor.send({ type: "ACTIVE_WORM_DIED" });
        return;
      }
    }

    // Settle detection while turnEnding
    if (stateName === "turnEnding") {
      const allSettled = this.allWorms.every(
        (w) => !w.isAlive || this.velocityMag(w) < tuning.turn.settleVelThresholdMps,
      );
      if (allSettled) {
        this.settleHoldMs += dtMs;
        if (this.settleHoldMs >= tuning.turn.settleHoldMs) {
          this.actor.send({ type: "SETTLED" });
          this.settleHoldMs = 0;
          return;
        }
      } else {
        this.settleHoldMs = 0;
      }
    } else {
      this.settleHoldMs = 0;
    }

    // Tick machine (drives timer + maxSettleMs safety)
    this.actor.send({ type: "TICK", dtMs });
  }

  endTurnByPlayer(): void {
    const snap = this.actor.getSnapshot();
    if (String(snap.value) !== "turnActive") return;
    this.actor.send({ type: "END_TURN" });
  }

  isInputAllowed(): boolean {
    return String(this.actor.getSnapshot().value) === "turnActive";
  }

  getActiveTeam(): Team | null {
    const snap = this.actor.getSnapshot();
    const state = String(snap.value);
    if (state === "idle" || state === "gameOver") return null;
    const id = snap.context.teamOrder[snap.context.currentTeamIdx];
    return this.teams.find((t) => t.id === id) ?? null;
  }

  getActiveWorm(): Worm | null {
    const state = String(this.actor.getSnapshot().value);
    if (state !== "turnActive") return null;
    return this.getActiveTeam()?.getCurrentWorm() ?? null;
  }

  getTurnSecondsRemaining(): number {
    const snap = this.actor.getSnapshot();
    if (String(snap.value) !== "turnActive") return 0;
    return Math.max(0, Math.ceil((tuning.turn.durationMs - snap.context.turnElapsedMs) / 1000));
  }

  getStateName(): "idle" | "turnActive" | "turnEnding" | "gameOver" {
    return String(this.actor.getSnapshot().value) as
      | "idle"
      | "turnActive"
      | "turnEnding"
      | "gameOver";
  }

  destroy(): void {
    this.actor.stop();
  }

  // ---- Private ----

  private onStateChange(stateName: string): void {
    // subscribe may fire synchronously on initial attach with current state "idle";
    // lastStateName starts as "idle" to no-op that case.
    if (stateName === this.lastStateName) return;

    if (stateName === "turnActive") {
      const team = this.getActiveTeam();
      if (!team) return;

      // Team._currentWormIdx starts at -1, so the very first advanceWorm lands on worm 0.
      // On subsequent turns for this team, advanceWorm rotates to the next alive worm.
      // If all worms on this team are dead, advanceWorm returns null - this should be
      // impossible because the update() win check fires first, but log defensively so
      // a silent hang is visible if the invariant ever breaks.
      const worm = team.advanceWorm();
      if (worm?.isAlive) {
        this.onTurnStart(team, worm);
      } else {
        console.warn(
          `[TurnManager] turnActive entered for team ${team.id} but advanceWorm returned no alive worm. This indicates the win check missed a same-frame full-team elimination.`,
        );
      }
    } else if (stateName === "turnEnding") {
      this.onTurnEnd();
    } else if (stateName === "gameOver") {
      const snap = this.actor.getSnapshot();
      const winnerId = snap.context.winnerId;
      const winner = winnerId ? (this.teams.find((t) => t.id === winnerId) ?? null) : null;
      this.onGameOver(winner);
    }

    this.lastStateName = stateName;
  }

  private velocityMag(w: Worm): number {
    const v = w.body.getLinearVelocity();
    return Math.hypot(v.x, v.y);
  }
}
