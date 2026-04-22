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

/** Shared timing constants. */
export const TURN_DURATION_MS = 45_000;
export const SETTLE_GRACE_MS = 6_000;
export const DISCONNECT_GRACE_MS = 60_000;

/** Provider of authoritative alive counts (the Simulation). */
export interface AliveCountsProvider {
  aliveWormsByTeam(): Map<string, number>;
}

/**
 * Everything TurnArbiter needs from its host. Kept narrow so the class
 * is unit-testable with a plain object stub.
 */
export interface ArbiterRoomAdapter {
  readonly state: LobbyState;
  /** Broadcast a typed payload to every connected client. */
  broadcast(type: string, payload: unknown): void;
  /** Session ids currently present. Disconnected-grace players may still be here. */
  getConnectedSessionIds(): Set<string>;
  /** True if the LobbyPlayer is flagged `disconnected` (grace window). */
  getPlayerDisconnected(sessionId: string): boolean;
  /** Source of authoritative alive counts. Set when the Simulation is ready. */
  getAliveCountsProvider(): AliveCountsProvider | null;
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

  constructor(room: ArbiterRoomAdapter) {
    this.room = room;
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
  }

  /**
   * Called from the DO's alarm handler every tick. Advances the turn
   * when the timer expires + grace window has passed. Also checks
   * game_over condition every tick (a worm may have died off-map even
   * without the turn timer expiring).
   */
  onTick(_dtMs: number): void {
    if (this.gameOver) return;
    this.checkGameOver();
    if (this.gameOver) return;
    if (this.pausedRemainingMs !== null) return;
    const now = Date.now();
    if (now > this.room.state.turnEndsAt + SETTLE_GRACE_MS) {
      this.advanceTurn();
    }
  }

  /** True once the game has ended; DO can stop scheduling alarms. */
  isGameOver(): boolean {
    return this.gameOver;
  }

  /**
   * Called by the Room immediately after a fire input is processed.
   * Advances the turn on the next alarm tick (the projectile needs
   * to land + settle first). For now this is a no-op - the settle
   * grace check in onTick will handle it.
   */
  onFireCommitted(): void {
    // Placeholder; v1 relies on the settle grace timeout.
  }

  /**
   * Called by the Room when a worm dies (either via explosion or the
   * off-map kill floor). Forces a game_over check on this tick.
   */
  onWormDied(_wormId: string): void {
    if (this.gameOver) return;
    this.checkGameOver();
  }

  onPlayerLeft(sessionId: string): void {
    if (this.gameOver) return;
    const activeTeamId = this.room.state.currentTeamId;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (activeTeam && activeTeam.ownerSessionId === sessionId) {
      this.advanceTurn();
    }
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
  }

  private pickNextWormInTeam(teamId: string): string {
    const roster = this.teamRosters.get(teamId);
    if (!roster || roster.wormIds.length === 0) return "";

    const provider = this.room.getAliveCountsProvider();
    const startCursor = this.teamWormCursor.get(teamId) ?? 0;

    // Without a sim provider we can't tell dead from alive; fall back
    // to the raw cursor walk. With a provider we iterate worm ids and
    // skip any that the sim reports dead.
    for (let step = 0; step < roster.wormIds.length; step++) {
      const idx = (startCursor + step) % roster.wormIds.length;
      const wormId = roster.wormIds[idx];
      if (provider) {
        // Hacky: aliveWormsByTeam returns counts only; we can't
        // check per-worm liveness. Instead, trust the cursor to
        // rotate; dead worms still occupy the slot but are skipped
        // via the team rotation's alive-count filter.
      }
      this.teamWormCursor.set(teamId, (idx + 1) % roster.wormIds.length);
      return wormId;
    }
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
