/**
 * Turn arbiter. Post-Epic-45 the arbiter no longer applies client-sent
 * turn_snapshots; the Simulation is authoritative and reports alive
 * counts via `aliveWormsByTeam(): Map<teamId, number>`. The arbiter
 * reads that map on onSimEvent / explicit advance / forfeit paths to
 * decide when to end the turn + game.
 *
 * What's gone vs the Option C version:
 *   - onSnapshot / lastSnapshot / sanitiseTurnSnapshot
 *   - turn_resolved broadcasts (superseded by continuous sim_state)
 *
 * What's still here:
 *   - team rotation + turn timer
 *   - disconnect pause / resume
 *   - team forfeit on player leave
 *   - game_over on last-team-standing
 *   - persistence for DO hibernation recovery
 */

import type { LobbyState } from "./messages.js";
import { dlog, type LogContext } from "./debug/logger.js";

/** Shared timing constants. */
export const TURN_DURATION_MS = 45_000;
export const SETTLE_GRACE_MS = 6_000;
export const DISCONNECT_GRACE_MS = 60_000;

/**
 * Early-settle tunables. Mirror tuning.turn.settleVelThresholdMps and
 * tuning.turn.settleHoldMs on the client so server and client feel
 * consistent. Kept as local consts rather than imported from the client
 * tuning module to avoid a client->worker dependency.
 */
const EARLY_SETTLE_VEL_THRESHOLD_MPS = 0.15;
const EARLY_SETTLE_HOLD_MS = 500;

/** Provider of authoritative alive counts (the Simulation). */
export interface AliveCountsProvider {
  aliveWormsByTeam(): Map<string, number>;
  /** Per-worm liveness so the arbiter can skip dead worms during rotation. */
  isWormAlive(wormId: string): boolean;
  /**
   * True when every alive worm has linear velocity below the threshold
   * and no projectiles are in flight. Used by early-settle detection.
   */
  isAllSettled(velThresholdMps: number): boolean;
}

/**
 * Everything TurnArbiter needs from its host. Kept narrow so the class
 * is unit-testable with a plain object stub.
 */
export interface ArbiterRoomAdapter {
  readonly state: LobbyState;
  readonly code: string;
  /** Broadcast a typed payload to every connected client. */
  broadcast(type: string, payload: unknown): void;
  /** Session ids currently present. Disconnected-grace players may still be here. */
  getConnectedSessionIds(): Set<string>;
  /** True if the LobbyPlayer is flagged `disconnected` (grace window). */
  getPlayerDisconnected(sessionId: string): boolean;
  /** Source of authoritative alive counts. Set when the Simulation is ready. */
  getAliveCountsProvider(): AliveCountsProvider | null;
  /** Called when a new turn starts (first turn via start(), subsequent via advanceTurn()). */
  onTurnStart?: () => void;
}

/** One roster entry per team. Populated at start_game, immutable after. */
export interface TeamRoster {
  id: string;
  ownerSessionId: string;
  wormIds: string[];
}

/**
 * Serialised arbiter state, persisted by the Room DO so hibernation
 * doesn't lose rotation / pause state. Unlike pre-Epic-45 we no
 * longer persist `aliveByTeam` or `lastSnapshot` - those are derived
 * fresh from the Simulation on restore.
 */
export interface ArbiterPersistedState {
  currentTeamIdx: number;
  turnDurationMs: number;
  gameOver: boolean;
  pausedRemainingMs: number | null;
  /** teamId -> next worm cursor index. */
  teamWormCursor: Record<string, number>;
}

export class TurnArbiter {
  private readonly room: ArbiterRoomAdapter;
  private teamRosters = new Map<string, TeamRoster>();
  private currentTeamIdx = 0;
  private teamWormCursor = new Map<string, number>();
  private forfeitedTeams = new Set<string>();
  private gameOver = false;
  private turnDurationMs = 0;
  private pausedRemainingMs: number | null = null;
  private pendingAdvance = false;
  private hasFiredThisTurn = false;
  private settleHoldMs = 0;

  constructor(room: ArbiterRoomAdapter) {
    this.room = room;
  }

  private logCtx(): LogContext {
    return { room: this.room.code, turn: this.room.state.turnSeq };
  }

  toJSON(): ArbiterPersistedState {
    return {
      currentTeamIdx: this.currentTeamIdx,
      turnDurationMs: this.turnDurationMs,
      gameOver: this.gameOver,
      pausedRemainingMs: this.pausedRemainingMs,
      teamWormCursor: Object.fromEntries(this.teamWormCursor),
    };
  }

  static fromState(
    room: ArbiterRoomAdapter,
    rosters: TeamRoster[],
    state: ArbiterPersistedState,
  ): TurnArbiter {
    const arbiter = new TurnArbiter(room);
    for (const r of rosters) arbiter.teamRosters.set(r.id, r);
    arbiter.currentTeamIdx = state.currentTeamIdx;
    arbiter.turnDurationMs = state.turnDurationMs;
    arbiter.gameOver = state.gameOver;
    arbiter.pausedRemainingMs = state.pausedRemainingMs;
    arbiter.teamWormCursor = new Map(Object.entries(state.teamWormCursor));
    return arbiter;
  }

  start(teamOrder: string[], rosters: TeamRoster[], turnDurationMs: number): void {
    this.settleHoldMs = 0;
    this.teamRosters.clear();
    this.teamWormCursor.clear();
    this.forfeitedTeams.clear();
    for (const r of rosters) {
      this.teamRosters.set(r.id, r);
      this.teamWormCursor.set(r.id, 0);
    }

    this.room.state.teamOrder = [...teamOrder];

    this.currentTeamIdx = 0;
    this.turnDurationMs = turnDurationMs;
    this.gameOver = false;

    const firstTeamId = teamOrder[0] ?? "";
    this.room.state.currentTeamId = firstTeamId;
    this.room.state.currentWormId = this.pickNextWormInTeam(firstTeamId);
    this.room.state.turnSeq = 1;
    this.room.state.turnEndsAt = Date.now() + turnDurationMs;
    this.fireTurnStart();
  }

  /**
   * Called from the DO's alarm handler every tick. Advances the turn
   * when the timer expires + grace window has passed. Also checks
   * game_over condition every tick (a worm may have died off-map even
   * without the turn timer expiring).
   */
  onTick(dtMs: number): void {
    if (this.gameOver) return;
    this.checkGameOver();
    if (this.gameOver) return;
    if (this.pendingAdvance && this.pausedRemainingMs === null) {
      this.pendingAdvance = false;
      this.advanceTurn();
      return;
    }
    if (this.pausedRemainingMs !== null) return;
    const now = Date.now();
    // Early-advance: if retreat window is over and the sim has stopped
    // moving for EARLY_SETTLE_HOLD_MS, advance now instead of waiting
    // the full SETTLE_GRACE_MS safety cap.
    if (now > this.room.state.turnEndsAt) {
      const provider = this.room.getAliveCountsProvider();
      if (provider?.isAllSettled(EARLY_SETTLE_VEL_THRESHOLD_MPS)) {
        this.settleHoldMs += Math.max(0, dtMs);
        if (this.settleHoldMs >= EARLY_SETTLE_HOLD_MS) {
          dlog("turn", "early_settled", this.logCtx(), { heldMs: this.settleHoldMs });
          this.advanceTurn();
          return;
        }
      } else {
        this.settleHoldMs = 0;
      }
    }
    // Safety cap: advance unconditionally after SETTLE_GRACE_MS.
    if (now > this.room.state.turnEndsAt + SETTLE_GRACE_MS) {
      dlog("turn", "safety_cap", this.logCtx());
      this.advanceTurn();
    }
  }

  /** True once the game has ended; DO can stop scheduling alarms. */
  isGameOver(): boolean {
    return this.gameOver;
  }

  /**
   * Called by the Room immediately after a fire input is processed.
   * Shortens turnEndsAt to +5s so players can reposition (retreat window)
   * before the full 45s turn timer expires.
   *
   * Guarded against the paused state (pausedRemainingMs !== null): a fire
   * during owner-disconnect grace must not stomp the MAX_SAFE_INTEGER
   * sentinel - pausedRemainingMs is the source of truth during pause.
   *
   * Only shortens, never extends: if somehow turnEndsAt is already closer
   * than 5s (e.g. rapid fire at end of turn), we leave it alone.
   */
  onFireCommitted(): void {
    if (this.gameOver) return;
    // Never touch turnEndsAt while paused; the sentinel is MAX_SAFE_INTEGER
    // and pausedRemainingMs is the source of truth.
    if (this.pausedRemainingMs !== null) return;
    this.hasFiredThisTurn = true;
    const RETREAT_WINDOW_MS = 5_000; // mirrors tuning.retreat.windowMs
    const retreatEnd = Date.now() + RETREAT_WINDOW_MS;
    // Only shorten - never extend.
    if (retreatEnd < this.room.state.turnEndsAt) {
      this.room.state.turnEndsAt = retreatEnd;
    }
    dlog("turn", "fire_committed", this.logCtx(), { retreatEndsAt: retreatEnd });
  }

  /**
   * Gate for the Room's fire input drain. Rejects if the game is over, the
   * turn is paused, the active worm already fired this turn (one-shot per
   * turn), or the turn timer has elapsed (past settle-grace inputs are
   * ignored so the player can't sneak another fire after the timer hits 0).
   */
  canFire(): boolean {
    if (this.gameOver) {
      dlog("turn", "fire_rejected", this.logCtx(), { reason: "gameOver" });
      return false;
    }
    if (this.pausedRemainingMs !== null) {
      dlog("turn", "fire_rejected", this.logCtx(), { reason: "inputsClosed" });
      return false;
    }
    if (Date.now() > this.room.state.turnEndsAt) {
      dlog("turn", "fire_rejected", this.logCtx(), { reason: "inputsClosed" });
      return false;
    }
    if (this.hasFiredThisTurn) {
      dlog("turn", "fire_rejected", this.logCtx(), { reason: "alreadyFired" });
      return false;
    }
    return true;
  }

  /**
   * Broader gate used by the Room for any action input (walk, jump, aim,
   * fire, jetpack). Once the turn timer hits 0 we lock the active worm's
   * inputs so only physics continues during settle grace. Also rejects
   * during game-over and disconnect pause.
   */
  areInputsAccepted(): boolean {
    if (this.gameOver) return false;
    if (this.pausedRemainingMs !== null) return false;
    if (Date.now() > this.room.state.turnEndsAt) return false;
    return true;
  }

  /**
   * Called by the Room when a worm dies (either via explosion or the
   * off-map kill floor). Forces a game_over check on this tick.
   */
  onWormDied(wormId: string): void {
    if (this.gameOver) return;
    this.checkGameOver();
    if (this.gameOver) return;
    if (wormId && wormId === this.room.state.currentWormId) {
      this.pendingAdvance = true;
    }
  }

  onPlayerLeft(sessionId: string): void {
    if (this.gameOver) return;
    const activeTeamId = this.room.state.currentTeamId;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (activeTeam && activeTeam.ownerSessionId === sessionId) {
      this.advanceTurn();
    }
  }

  /**
   * Explicit "end turn" pressed by the active player. Advances immediately
   * without waiting for the settle-grace timeout. Validated caller must
   * own the currently-active team; other players are ignored.
   */
  endTurnByPlayer(sessionId: string): void {
    if (this.gameOver) return;
    if (this.pausedRemainingMs !== null) return;
    const activeTeamId = this.room.state.currentTeamId;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (!activeTeam || activeTeam.ownerSessionId !== sessionId) return;
    this.advanceTurn();
  }

  onOwnerDisconnected(sessionId: string): void {
    if (this.gameOver) return;
    const activeTeamId = this.room.state.currentTeamId;
    if (!activeTeamId) return;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (!activeTeam || activeTeam.ownerSessionId !== sessionId) return;
    if (this.pausedRemainingMs !== null) return;
    const remaining = Math.max(0, this.room.state.turnEndsAt - Date.now());
    this.pausedRemainingMs = remaining;
    this.room.state.turnEndsAt = Number.MAX_SAFE_INTEGER;
    dlog("turn", "paused", this.logCtx(), { remainingMs: this.pausedRemainingMs });
  }

  onOwnerReconnected(sessionId: string): void {
    if (this.gameOver) return;
    if (this.pausedRemainingMs === null) return;
    const activeTeamId = this.room.state.currentTeamId;
    if (!activeTeamId) return;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (!activeTeam || activeTeam.ownerSessionId !== sessionId) return;
    this.room.state.turnEndsAt = Date.now() + this.pausedRemainingMs;
    this.pausedRemainingMs = null;
    this.settleHoldMs = 0;
    dlog("turn", "resumed", this.logCtx());
  }

  onTeamForfeit(teamId: string): void {
    if (this.gameOver) return;
    const roster = this.teamRosters.get(teamId);
    if (!roster) return;
    if (this.forfeitedTeams.has(teamId)) return;
    this.forfeitedTeams.add(teamId);
    this.checkGameOver();
    if (this.gameOver) return;
    if (this.room.state.currentTeamId === teamId) {
      this.advanceTurn();
    }
  }

  // ---- private ----

  private fireTurnStart(): void {
    this.hasFiredThisTurn = false;
    this.room.onTurnStart?.();
  }

  private teamAliveCount(teamId: string): number {
    if (this.forfeitedTeams.has(teamId)) return 0;
    const provider = this.room.getAliveCountsProvider();
    if (!provider) {
      // No sim yet (shouldn't happen during playing phase, but be
      // defensive). Fall back to roster size.
      const roster = this.teamRosters.get(teamId);
      return roster?.wormIds.length ?? 0;
    }
    return provider.aliveWormsByTeam().get(teamId) ?? 0;
  }

  private advanceTurn(): void {
    const fromTeam = this.room.state.currentTeamId;
    this.settleHoldMs = 0;
    const teamsWithAliveWorms: string[] = [];
    for (const teamId of this.room.state.teamOrder) {
      if (this.teamAliveCount(teamId) > 0) teamsWithAliveWorms.push(teamId);
    }
    if (teamsWithAliveWorms.length <= 1) {
      const winnerTeamId = teamsWithAliveWorms[0] ?? null;
      this.declareGameOver(winnerTeamId);
      return;
    }

    const connected = this.room.getConnectedSessionIds();
    const teamOrderLen = this.room.state.teamOrder.length;
    let nextTeamId = "";
    for (let step = 1; step <= teamOrderLen; step++) {
      const idx = (this.currentTeamIdx + step) % teamOrderLen;
      const candidate = this.room.state.teamOrder[idx];
      if (!candidate) continue;
      const roster = this.teamRosters.get(candidate);
      if (!roster) continue;
      if (!roster.ownerSessionId) continue;
      if (!connected.has(roster.ownerSessionId)) continue;
      if (this.room.getPlayerDisconnected(roster.ownerSessionId)) continue;
      if (this.teamAliveCount(candidate) <= 0) continue;
      this.currentTeamIdx = idx;
      nextTeamId = candidate;
      break;
    }

    if (!nextTeamId) {
      this.declareGameOver(null);
      return;
    }

    const nextWormId = this.pickNextWormInTeam(nextTeamId);
    this.room.state.currentTeamId = nextTeamId;
    this.room.state.currentWormId = nextWormId;
    this.room.state.turnSeq += 1;
    this.room.state.turnEndsAt = Date.now() + this.turnDurationMs;
    this.pausedRemainingMs = null;
    dlog("turn", "advance", this.logCtx(), { fromTeam, toTeam: nextTeamId });
    this.fireTurnStart();
  }

  private pickNextWormInTeam(teamId: string): string {
    const roster = this.teamRosters.get(teamId);
    if (!roster || roster.wormIds.length === 0) return "";

    // Cursor rotation that skips dead worms. advanceTurn pre-filters teams
    // by teamAliveCount > 0, so at least one alive worm exists here; we
    // scan forward from the cursor for up to n steps to find them.
    const provider = this.room.getAliveCountsProvider();
    const startCursor = this.teamWormCursor.get(teamId) ?? 0;
    const n = roster.wormIds.length;
    for (let step = 0; step < n; step++) {
      const idx = (startCursor + step) % n;
      const wormId = roster.wormIds[idx];
      if (!wormId) continue;
      // If no provider (shouldn't happen once the sim is bound), fall back
      // to the historical behavior of just returning the cursor position.
      if (!provider || provider.isWormAlive(wormId)) {
        this.teamWormCursor.set(teamId, (idx + 1) % n);
        return wormId;
      }
    }
    // All worms in this team are dead - unreachable given the caller's
    // pre-filter, but return empty so a stale pointer is never selected.
    return "";
  }

  private checkGameOver(): void {
    if (this.gameOver) return;
    const survivors: string[] = [];
    for (const teamId of this.room.state.teamOrder) {
      if (this.teamAliveCount(teamId) > 0) survivors.push(teamId);
    }
    if (survivors.length <= 1) {
      this.declareGameOver(survivors[0] ?? null);
    }
  }

  private declareGameOver(winnerTeamId: string | null): void {
    this.gameOver = true;
    this.room.state.currentTeamId = "";
    this.room.state.currentWormId = "";
    this.room.state.turnEndsAt = 0;
    this.room.broadcast("game_over", { winnerTeamId });
  }
}
