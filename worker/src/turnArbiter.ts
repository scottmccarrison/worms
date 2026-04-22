/**
 * Server-side turn arbiter, ported from server/src/game/TurnArbiter.ts.
 *
 * Changes vs the Colyseus version:
 * - `room.state` is a plain JSON `LobbyState` object (not a Schema), so
 *   we mutate fields directly and the DO broadcasts the full state
 *   afterwards via `broadcastState()`.
 * - The `setInterval`-driven tick loop is gone. The DO's `alarm()`
 *   handler calls `onTick(dtMs)` every ~500ms while the game is in
 *   "playing" phase; the DO reschedules the alarm at the end of each
 *   tick.
 * - Broadcasts go through `ArbiterRoomAdapter.broadcast` which the DO
 *   implements as a helper that serialises JSON and fans out to every
 *   attached hibernatable WebSocket.
 */

import type { CircleCut, LobbyState, WormSnapshot, TeamInit as _TeamInit } from "./messages.js";

/** Payload shape of `turn_snapshot` (C->S from the active player). */
export interface TurnSnapshot {
  worms: WormSnapshot[];
  terrainCuts: CircleCut[];
}

/** Shared timing constants. */
export const TURN_DURATION_MS = 45_000;
export const SETTLE_GRACE_MS = 6_000;
export const DISCONNECT_GRACE_MS = 60_000;

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
}

/** One roster entry per team. Populated at start_game, immutable after. */
export interface TeamRoster {
  id: string;
  ownerSessionId: string;
  wormIds: string[];
}

export class TurnArbiter {
  private readonly room: ArbiterRoomAdapter;
  private teamRosters = new Map<string, TeamRoster>();
  private currentTeamIdx = 0;
  private teamWormCursor = new Map<string, number>();
  private aliveByTeam = new Map<string, number>();
  private lastSnapshot: TurnSnapshot | null = null;
  private gotSnapshotThisTurn = false;
  private gameOver = false;
  private turnDurationMs = 0;
  private pausedRemainingMs: number | null = null;

  constructor(room: ArbiterRoomAdapter) {
    this.room = room;
  }

  start(teamOrder: string[], rosters: TeamRoster[], turnDurationMs: number): void {
    this.teamRosters.clear();
    this.teamWormCursor.clear();
    this.aliveByTeam.clear();
    for (const r of rosters) {
      this.teamRosters.set(r.id, r);
      this.teamWormCursor.set(r.id, 0);
      this.aliveByTeam.set(r.id, r.wormIds.length);
    }

    // Plain array in the JSON state.
    this.room.state.teamOrder = [...teamOrder];

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
   * Called from the DO's alarm handler every ~500ms while phase is
   * "playing". If the turn ran long AND no snapshot arrived, force
   * -advance with last-known positions. Otherwise a no-op.
   */
  onTick(_dtMs: number): void {
    if (this.gameOver) return;
    if (this.gotSnapshotThisTurn) return;
    if (this.pausedRemainingMs !== null) return;
    const now = Date.now();
    if (now > this.room.state.turnEndsAt + SETTLE_GRACE_MS) {
      this.forceAdvance();
    }
  }

  /** True once the game has ended; DO can stop scheduling alarms. */
  isGameOver(): boolean {
    return this.gameOver;
  }

  onSnapshot(snap: TurnSnapshot): void {
    if (this.gameOver) return;
    this.lastSnapshot = snap;
    this.gotSnapshotThisTurn = true;
    this.applySnapshotToAliveTally(snap);
    const nextResolution = this.advanceTurn();
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

  forceAdvance(): void {
    if (this.gameOver) return;
    const synth: TurnSnapshot = this.lastSnapshot ?? { worms: [], terrainCuts: [] };
    this.gotSnapshotThisTurn = true;
    this.applySnapshotToAliveTally(synth);
    const nextResolution = this.advanceTurn();
    if (nextResolution) {
      this.room.broadcast("turn_resolved", {
        turnSeq: nextResolution.turnSeq,
        worms: synth.worms,
        terrainCuts: [],
        nextTeamId: nextResolution.nextTeamId,
        nextWormId: nextResolution.nextWormId,
      });
    }
  }

  onPlayerLeft(sessionId: string): void {
    if (this.gameOver) return;
    const activeTeamId = this.room.state.currentTeamId;
    const activeTeam = this.teamRosters.get(activeTeamId);
    if (activeTeam && activeTeam.ownerSessionId === sessionId) {
      this.forceAdvance();
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
    if ((this.aliveByTeam.get(teamId) ?? 0) === 0) return;
    this.aliveByTeam.set(teamId, 0);

    const forfeitWorms: WormSnapshot[] = [];
    for (const wormId of roster.wormIds) {
      const prior = this.lastSnapshot?.worms.find((w) => w.id === wormId);
      forfeitWorms.push({
        id: wormId,
        x: prior?.x ?? 0,
        y: prior?.y ?? 0,
        vx: 0,
        vy: 0,
        hp: 0,
        alive: false,
      });
    }

    let aliveTeamCount = 0;
    let lastAliveTeamId: string | null = null;
    for (const [tid, count] of this.aliveByTeam) {
      if (count > 0) {
        aliveTeamCount += 1;
        lastAliveTeamId = tid;
      }
    }
    if (aliveTeamCount <= 1) {
      this.declareGameOver(lastAliveTeamId);
      return;
    }

    // Merge forfeit worms into lastSnapshot so future lookups treat them as dead.
    const mergedWorms: WormSnapshot[] = [];
    const forfeitIds = new Set(forfeitWorms.map((w) => w.id));
    if (this.lastSnapshot) {
      for (const w of this.lastSnapshot.worms) {
        if (!forfeitIds.has(w.id)) mergedWorms.push(w);
      }
    }
    for (const w of forfeitWorms) mergedWorms.push(w);
    this.lastSnapshot = { worms: mergedWorms, terrainCuts: [] };

    const nextResolution = this.advanceTurn();
    if (nextResolution) {
      this.room.broadcast("turn_resolved", {
        turnSeq: nextResolution.turnSeq,
        worms: forfeitWorms,
        terrainCuts: [],
        nextTeamId: nextResolution.nextTeamId,
        nextWormId: nextResolution.nextWormId,
      });
    }
  }

  // ---- private ----

  private advanceTurn(): { turnSeq: number; nextTeamId: string; nextWormId: string } | null {
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
      if ((this.aliveByTeam.get(candidate) ?? 0) <= 0) continue;
      this.currentTeamIdx = idx;
      nextTeamId = candidate;
      break;
    }

    if (!nextTeamId) {
      this.declareGameOver(null);
      return null;
    }

    const nextWormId = this.pickNextWormInTeam(nextTeamId);

    this.room.state.currentTeamId = nextTeamId;
    this.room.state.currentWormId = nextWormId;
    this.room.state.turnSeq += 1;
    this.room.state.turnEndsAt = Date.now() + this.turnDurationMs;
    this.gotSnapshotThisTurn = false;
    this.pausedRemainingMs = null;

    return {
      turnSeq: this.room.state.turnSeq,
      nextTeamId,
      nextWormId,
    };
  }

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
    if (snap.worms.length === 0) return;
    const snapAlive = new Map<string, boolean>();
    for (const w of snap.worms) snapAlive.set(w.id, w.alive);

    for (const [teamId, roster] of this.teamRosters) {
      let alive = 0;
      for (const wormId of roster.wormIds) {
        const explicit = snapAlive.get(wormId);
        if (explicit === undefined) {
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
