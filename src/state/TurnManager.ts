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

  // ---------------------------------------------------------------------------
  // Epic 9 - "externally driven" mode for networked matches.
  //
  // When true: the local state machine STILL runs settle detection + timer
  // ticking (so the active player's client can decide when to send its
  // turn_snapshot), but SETTLED / TICK-expired transitions no longer advance
  // currentTeamIdx. Instead, the server emits a turn_resolved message that
  // GameScene feeds into adoptServerTurn(), which sets the active team + worm
  // directly.
  //
  // onLocalTurnFinished fires once per turn when local settle detection would
  // have cycled teams. The active player's GameScene uses this as the cue to
  // send turn_snapshot. Non-active clients' local settle fires too but is a
  // benign no-op because they don't send snapshots.
  // ---------------------------------------------------------------------------
  private externallyDriven = false;
  onLocalTurnFinished: (() => void) | null = null;

  /** Tracks whether we have already emitted the "local turn finished" hook for the current turn. */
  private localTurnFinishedEmitted = false;

  /**
   * Server-authoritative turn index. When externallyDriven, this overrides
   * the xstate machine's currentTeamIdx for getActiveTeam() / getActiveWorm().
   * Negative means "not yet adopted".
   */
  private externalTeamIdx = -1;
  private externalWormByTeamId: Record<string, string> = {};
  private externalTurnSeq = -1;
  /** Seconds remaining surfaced by getTurnSecondsRemaining() when externally driven. */
  private externalTurnEndsAt = 0;

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
    // Suppressed in externallyDriven mode - server owns game-over authority.
    if (!this.externallyDriven) {
      const aliveTeams = this.teams.filter((t) => !t.isEliminated());
      if (aliveTeams.length <= 1) {
        const winnerId = aliveTeams[0]?.id ?? null;
        this.actor.send({ type: "GAME_OVER", winnerId });
        return;
      }
    }

    // Active worm mid-turn death. In externallyDriven mode the server will
    // force-advance and emit turn_resolved when the active worm dies; local
    // detection is suppressed so it can't short-circuit the server's path.
    if (stateName === "turnActive" && !this.externallyDriven) {
      const active = this.getActiveWorm();
      if (active && !active.isAlive) {
        this.actor.send({ type: "ACTIVE_WORM_DIED" });
        return;
      }
    }

    // Settle detection while turnEnding. Runs in BOTH modes so the active
    // player's client knows when to send turn_snapshot (via the callback).
    // Externally-driven mode swallows the SETTLED event to prevent team cycling.
    if (stateName === "turnEnding") {
      const allSettled = this.allWorms.every(
        (w) => !w.isAlive || this.velocityMag(w) < tuning.turn.settleVelThresholdMps,
      );
      if (allSettled) {
        this.settleHoldMs += dtMs;
        if (this.settleHoldMs >= tuning.turn.settleHoldMs) {
          if (this.externallyDriven) {
            // Don't cycle locally - emit the hook and hold in turnEnding until
            // the server's turn_resolved arrives via adoptServerTurn().
            if (!this.localTurnFinishedEmitted) {
              this.localTurnFinishedEmitted = true;
              this.onLocalTurnFinished?.();
            }
          } else {
            this.actor.send({ type: "SETTLED" });
          }
          this.settleHoldMs = 0;
          return;
        }
      } else {
        this.settleHoldMs = 0;
      }
    } else {
      this.settleHoldMs = 0;
    }

    // Tick machine. In externallyDriven mode we drop the tick when it would
    // trigger a local cycle (maxSettleReached) to keep the server in charge.
    if (this.externallyDriven) {
      const willExpireTurn =
        stateName === "turnActive" && snap.context.turnElapsedMs + dtMs >= tuning.turn.durationMs;
      const willExpireSettle =
        stateName === "turnEnding" &&
        snap.context.turnEndingElapsedMs + dtMs >= tuning.turn.maxSettleMs;
      if (willExpireTurn) {
        // Clamp so TICK lands us at durationMs - 1ms: still in turnActive.
        const clamped = Math.max(0, tuning.turn.durationMs - 1 - snap.context.turnElapsedMs);
        if (clamped > 0) this.actor.send({ type: "TICK", dtMs: clamped });
        // Fire the local-turn-finished hook once; active client sends snapshot.
        if (!this.localTurnFinishedEmitted) {
          this.localTurnFinishedEmitted = true;
          this.onLocalTurnFinished?.();
        }
      } else if (willExpireSettle) {
        const clamped = Math.max(0, tuning.turn.maxSettleMs - 1 - snap.context.turnEndingElapsedMs);
        if (clamped > 0) this.actor.send({ type: "TICK", dtMs: clamped });
      } else {
        this.actor.send({ type: "TICK", dtMs });
      }
      return;
    }

    // Tick machine (drives timer + maxSettleMs safety) - local mode.
    this.actor.send({ type: "TICK", dtMs });
  }

  endTurnByPlayer(): void {
    const snap = this.actor.getSnapshot();
    if (String(snap.value) !== "turnActive") return;
    // Transition to turnEnding locally so the visual "turn ending" state runs
    // normally in both modes. The difference is what happens at SETTLED:
    // externally-driven mode swallows SETTLED and emits onLocalTurnFinished
    // instead of cycling to the next team.
    this.actor.send({ type: "END_TURN" });
  }

  /**
   * Epic 9 - externally driven mode.
   * When enabled, the server owns turn rotation; local SETTLED/TICK-expired
   * events no longer cycle teams. Settle detection still runs so the active
   * client can fire `onLocalTurnFinished` as the cue to send turn_snapshot.
   */
  setExternallyDriven(v: boolean): void {
    this.externallyDriven = v;
  }

  isExternallyDriven(): boolean {
    return this.externallyDriven;
  }

  /**
   * Server-authoritative turn adoption. Called from GameScene on `turn_resolved`.
   *
   * Effects:
   * - Records the authoritative team + worm for this turn.
   * - Resets the local xstate machine back to turnActive with a fresh timer.
   * - Clears the localTurnFinishedEmitted flag so the next turn-end can fire again.
   *
   * Idempotent on turnSeq: replaying the same seq is a no-op.
   */
  adoptServerTurn(turnSeq: number, teamId: string, wormId: string, endsAt: number): void {
    if (!this.externallyDriven) {
      console.warn(
        "[TurnManager] adoptServerTurn called outside externally-driven mode; ignoring.",
      );
      return;
    }
    if (turnSeq <= this.externalTurnSeq) {
      // Duplicate / out-of-order turn_resolved; ignore.
      return;
    }
    this.externalTurnSeq = turnSeq;
    this.externalTurnEndsAt = endsAt;
    this.externalWormByTeamId[teamId] = wormId;
    const idx = this.teams.findIndex((t) => t.id === teamId);
    this.externalTeamIdx = idx >= 0 ? idx : this.externalTeamIdx;
    this.localTurnFinishedEmitted = false;
    this.settleHoldMs = 0;

    // Prime the team's current worm pointer so getCurrentWorm() returns the
    // authoritative one. We walk the team's worm list to the named worm.
    const team = this.teams.find((t) => t.id === teamId);
    if (team) {
      const targetIdx = team.worms.findIndex((w) => w.name === wormId);
      if (targetIdx >= 0) {
        // Advance until getCurrentWorm().name matches. Preserves team's
        // round-robin invariant without a new setter on Team.
        for (let i = 0; i < team.worms.length; i++) {
          if (team.getCurrentWorm()?.name === wormId) break;
          team.advanceWorm();
        }
      }
    }

    // Re-enter turnActive by sending START_GAME again would reset everything;
    // instead we ride whatever state the machine is in and let the local
    // timer naturally run from endsAt. The onTurnStart callback fires on
    // state TRANSITION into turnActive; to re-fire for the new turn we push
    // the machine through turnEnding -> SETTLED -> turnActive locally.
    // But in externally-driven mode SETTLED would normally be swallowed by
    // our update() guard. Temporarily bypass by sending SETTLED here, which
    // the machine uses to cycle teams. cycleTeam mutates currentTeamIdx
    // in the internal context, but getActiveTeam/getActiveWorm in networked
    // mode read externalTeamIdx so the local idx doesn't matter for display.
    const state = String(this.actor.getSnapshot().value);
    if (state === "turnEnding") {
      this.actor.send({ type: "SETTLED" });
    } else if (state === "turnActive") {
      // Force a clean transition so onTurnStart fires for the new worm.
      this.actor.send({ type: "END_TURN" });
      this.actor.send({ type: "SETTLED" });
    }
  }

  /**
   * Record self-damage for the active worm. No-op in 6a; wired for 6b
   * retreat-timer logic where self-damage can override the retreat window.
   */
  reportSelfDamage(_amount: number): void {
    // 6b: use _amount to decide retreat timer override
  }

  isInputAllowed(): boolean {
    return String(this.actor.getSnapshot().value) === "turnActive";
  }

  getActiveTeam(): Team | null {
    const snap = this.actor.getSnapshot();
    const state = String(snap.value);
    if (state === "idle" || state === "gameOver") return null;
    if (this.externallyDriven && this.externalTeamIdx >= 0) {
      return this.teams[this.externalTeamIdx] ?? null;
    }
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
    if (this.externallyDriven && this.externalTurnEndsAt > 0) {
      // Server-authoritative timer: ms-epoch endsAt minus current wall clock.
      return Math.max(0, Math.ceil((this.externalTurnEndsAt - Date.now()) / 1000));
    }
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

      // In externally-driven mode the server has already picked the active
      // worm via adoptServerTurn(); do NOT advanceWorm (that would rotate
      // past the target). Use the cursor adoptServerTurn left pointing at
      // the correct worm.
      let worm: Worm | null;
      if (this.externallyDriven) {
        worm = team.getCurrentWorm();
      } else {
        // Team._currentWormIdx starts at -1, so the very first advanceWorm lands on worm 0.
        // On subsequent turns for this team, advanceWorm rotates to the next alive worm.
        // If all worms on this team are dead, advanceWorm returns null - this should be
        // impossible because the update() win check fires first, but log defensively so
        // a silent hang is visible if the invariant ever breaks.
        worm = team.advanceWorm();
      }
      if (worm?.isAlive) {
        this.onTurnStart(team, worm);
      } else {
        console.warn(
          `[TurnManager] turnActive entered for team ${team.id} but no alive worm was available. In externally-driven mode this means the server's currentWormId did not match any alive local worm; otherwise the win check missed a same-frame full-team elimination.`,
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
