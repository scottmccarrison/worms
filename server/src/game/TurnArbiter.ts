import { ArraySchema } from "@colyseus/schema";
import type { LobbyState } from "../state/LobbyState.js";
import { SETTLE_GRACE_MS } from "../state/constants.js";

/**
 * One snapshot entry per worm, as sent by the active client inside a
 * `turn_snapshot` message at the end of its local turn.
 *
 * This is the only authoritative physics state the server sees. It
 * keys drift reconciliation on the `turn_resolved` broadcast.
 */
export interface WormSnapshot {
  id: string; // e.g. "red-0"
  x: number;
  y: number;
  vx: number;
  vy: number;
  hp: number;
  alive: boolean;
}

/** Circular terrain cut, monotonic `seq` for idempotent reapply. */
export interface CircleCut {
  x: number;
  y: number;
  r: number;
  seq: number;
}

/** Payload shape of `turn_snapshot` (C->S from the active player). */
export interface TurnSnapshot {
  worms: WormSnapshot[];
  terrainCuts: CircleCut[];
}

/**
 * Everything TurnArbiter needs from a GameRoom. Kept narrow so the
 * class is unit-testable with a plain object stub (no Colyseus Room
 * instance required in tests).
 */
export interface ArbiterRoomAdapter {
  /** Mutable authoritative state; arbiter writes the turn fields directly. */
  readonly state: LobbyState;
  /** Broadcast a message to every connected client. */
  broadcast(type: string, payload: unknown): void;
  /** Snapshot of session ids currently present; used to skip disconnected team owners. */
  getConnectedSessionIds(): Set<string>;
}

/**
 * One roster entry per team. Populated at `start_game` and kept
 * immutable for the lifetime of the game.
 */
export interface TeamRoster {
  id: string; // "red" | "blue" | "green" | "yellow"
  ownerSessionId: string; // empty string means unowned / skip
  wormIds: string[]; // e.g. ["red-0", "red-1"]
}

/**
 * Server turn arbiter. Decides whose turn is active, advances on
 * snapshot-from-active-player, force-advances on timeout or active
 * player drop.
 *
 * Option C: does NOT run planck. Tracks alive counts purely from the
 * `turn_snapshot` stream. The per-worm `alive` flag + the per-team
 * wormIds list give us enough to detect game_over and skip dead teams.
 */
export class TurnArbiter {
  private readonly room: ArbiterRoomAdapter;
  private teamRosters = new Map<string, TeamRoster>();
  private currentTeamIdx = 0;
  /** Round-robin cursor per team so worms cycle within a team. */
  private teamWormCursor = new Map<string, number>();
  /** Alive count per team, derived from the most recent snapshot. */
  private aliveByTeam = new Map<string, number>();
  /** Last `turn_snapshot` we received, used to synthesize a force-advance resolution. */
  private lastSnapshot: TurnSnapshot | null = null;
  /** True once this turn has received a snapshot; reset each advance. */
  private gotSnapshotThisTurn = false;
  /** True once game_over has been declared; arbiter becomes a no-op. */
  private gameOver = false;
  private turnDurationMs = 0;

  constructor(room: ArbiterRoomAdapter) {
    this.room = room;
  }

  /**
   * Initialise the arbiter at the moment of start_game. `teamOrder`
   * is the canonical cycle; `rosters` supplies worm ids + ownership
   * for each team. The first team in `teamOrder` becomes active.
   */
  start(teamOrder: string[], rosters: TeamRoster[], turnDurationMs: number): void {
    this.teamRosters.clear();
    this.teamWormCursor.clear();
    this.aliveByTeam.clear();
    for (const r of rosters) {
      this.teamRosters.set(r.id, r);
      this.teamWormCursor.set(r.id, 0);
      this.aliveByTeam.set(r.id, r.wormIds.length);
    }

    // Mirror teamOrder into replicated state. ArraySchema doesn't
    // accept a spread constructor in 2.x; push one-by-one.
    this.room.state.teamOrder = new ArraySchema<string>();
    for (const id of teamOrder) this.room.state.teamOrder.push(id);

    this.currentTeamIdx = 0;
    this.turnDurationMs = turnDurationMs;
    this.gameOver = false;
    this.lastSnapshot = null;
    this.gotSnapshotThisTurn = false;

    const firstTeamId = teamOrder[0] ?? "";
    this.room.state.currentTeamId = firstTeamId;
    this.room.state.currentWormId = this.pickNextWormInTeam(firstTeamId);
    this.room.state.turnSeq = 1;
    this.room.state.turnEndsAt = Date.now() + turnDurationMs;
  }

  /**
   * Called from a plain setInterval in GameRoom (20Hz). If the turn
   * ran long AND no snapshot arrived, force-advance with last-known
   * positions. Otherwise a no-op (clients drive turn end via
   * `turn_snapshot`).
   */
  onTick(_dtMs: number): void {
    if (this.gameOver) return;
    if (this.gotSnapshotThisTurn) return;
    const now = Date.now();
    if (now > this.room.state.turnEndsAt + SETTLE_GRACE_MS) {
      this.forceAdvance();
    }
  }

  /**
   * Accept a snapshot from the active player. Updates the alive-count
   * tally, broadcasts `turn_resolved`, and advances to the next turn.
   */
  onSnapshot(snap: TurnSnapshot): void {
    if (this.gameOver) return;
    this.lastSnapshot = snap;
    this.gotSnapshotThisTurn = true;
    this.applySnapshotToAliveTally(snap);
    const nextResolution = this.advanceTurn(snap);
    if (nextResolution) {
      this.room.broadcast("turn_resolved", {
        turnSeq: nextResolution.turnSeq,
        worms: snap.worms,
        terrainCuts: snap.terrainCuts,
        nextTeamId: nextResolution.nextTeamId,
        nextWormId: nextResolution.nextWormId,
      });
    }
  }

  /**
   * Timeout path + active-player-left path. Synthesizes a resolution
   * from the last known snapshot (empty snapshot if we never got one).
   */
  forceAdvance(): void {
    if (this.gameOver) return;
    const synth: TurnSnapshot = this.lastSnapshot ?? { worms: [], terrainCuts: [] };
    this.gotSnapshotThisTurn = true;
    this.applySnapshotToAliveTally(synth);
    const nextResolution = this.advanceTurn(synth);
    if (nextResolution) {
      this.room.broadcast("turn_resolved", {
        turnSeq: nextResolution.turnSeq,
        worms: synth.worms,
        // No new cuts on a synthetic advance.
        terrainCuts: [],
        nextTeamId: nextResolution.nextTeamId,
        nextWormId: nextResolution.nextWormId,
      });
    }
  }

  /**
   * Notify the arbiter that a player left the room mid-game. If they
   * owned the active team we force-advance so everyone else can keep
   * playing. Other leaves are handled lazily: `advanceTurn` re-checks
   * connected session ids each turn.
   */
  onPlayerLeft(sessionId: string): void {
    if (this.gameOver) return;
    const activeTeamId = this.room.state.currentTeamId;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (activeTeam && activeTeam.ownerSessionId === sessionId) {
      this.forceAdvance();
    }
  }

  // ---- private helpers ----

  /**
   * Pick the next team in `teamOrder` that (a) has an owner still
   * connected AND (b) still has alive worms. If only one team qualifies
   * on the "alive worms" axis, emit game_over instead of advancing.
   *
   * Returns the next-turn info, or null if the game ended.
   */
  private advanceTurn(
    _snap: TurnSnapshot,
  ): { turnSeq: number; nextTeamId: string; nextWormId: string } | null {
    // First: detect game_over purely on alive worms (ignoring ownership;
    // we want the game to end if only one team has worms left even if
    // that team's owner is still here).
    const teamsWithAliveWorms: string[] = [];
    for (const teamId of this.room.state.teamOrder) {
      if ((this.aliveByTeam.get(teamId) ?? 0) > 0) {
        teamsWithAliveWorms.push(teamId);
      }
    }
    if (teamsWithAliveWorms.length <= 1) {
      const winnerTeamId = teamsWithAliveWorms[0] ?? null;
      this.declareGameOver(winnerTeamId);
      return null;
    }

    // Find the next team in teamOrder that's eligible: alive worms AND
    // a connected owner. Skip ownerless / disconnected entries.
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
      if ((this.aliveByTeam.get(candidate) ?? 0) <= 0) continue;
      this.currentTeamIdx = idx;
      nextTeamId = candidate;
      break;
    }

    if (!nextTeamId) {
      // No eligible team to hand off to (everyone who had alive worms
      // disconnected). Declare game_over with no winner.
      this.declareGameOver(null);
      return null;
    }

    const nextWormId = this.pickNextWormInTeam(nextTeamId);

    this.room.state.currentTeamId = nextTeamId;
    this.room.state.currentWormId = nextWormId;
    this.room.state.turnSeq += 1;
    this.room.state.turnEndsAt = Date.now() + this.turnDurationMs;
    this.gotSnapshotThisTurn = false;

    return {
      turnSeq: this.room.state.turnSeq,
      nextTeamId,
      nextWormId,
    };
  }

  /**
   * Round-robin through a team's worm list, skipping dead worms (per
   * the latest snapshot). If every worm is dead, returns "".
   */
  private pickNextWormInTeam(teamId: string): string {
    const roster = this.teamRosters.get(teamId);
    if (!roster || roster.wormIds.length === 0) return "";

    const deadIds = this.deadWormIds();
    const startCursor = this.teamWormCursor.get(teamId) ?? 0;

    for (let step = 0; step < roster.wormIds.length; step++) {
      const idx = (startCursor + step) % roster.wormIds.length;
      const wormId = roster.wormIds[idx];
      if (!deadIds.has(wormId)) {
        this.teamWormCursor.set(teamId, (idx + 1) % roster.wormIds.length);
        return wormId;
      }
    }
    return "";
  }

  private deadWormIds(): Set<string> {
    const out = new Set<string>();
    if (!this.lastSnapshot) return out;
    for (const w of this.lastSnapshot.worms) {
      if (!w.alive) out.add(w.id);
    }
    return out;
  }

  private applySnapshotToAliveTally(snap: TurnSnapshot): void {
    // Re-derive alive counts from scratch so a snapshot that revives a
    // worm (e.g. hp clamp edge case) is respected. If a worm id from
    // the roster isn't in the snapshot, assume its last-known alive
    // state (no change).
    if (snap.worms.length === 0) return;
    // Build quick lookup of "this snapshot's alive list" per worm id.
    const snapAlive = new Map<string, boolean>();
    for (const w of snap.worms) snapAlive.set(w.id, w.alive);

    for (const [teamId, roster] of this.teamRosters) {
      let alive = 0;
      for (const wormId of roster.wormIds) {
        const explicit = snapAlive.get(wormId);
        if (explicit === undefined) {
          // Worm not reported this snapshot; keep previous alive tally
          // for this slot (approximate: assume alive unless we already
          // recorded it dead via lastSnapshot).
          const priorDead = this.lastSnapshot
            ? this.lastSnapshot.worms.find((w) => w.id === wormId && !w.alive)
            : undefined;
          if (!priorDead) alive += 1;
        } else if (explicit) {
          alive += 1;
        }
      }
      this.aliveByTeam.set(teamId, alive);
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
