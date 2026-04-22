/**
 * Epic 45 - NetworkedSimAdapter.
 *
 * Subscribes to the server's `sim_state` stream + event messages and
 * surfaces a read-only SimAdapter view to the renderer. All input methods
 * forward to the room via `room.send(...)`; none of them mutate local
 * state synchronously. The next `sim_state` frame lands within ~50ms and
 * updates the render positions.
 *
 * This adapter does NOT import the client-side planck world, Worm body,
 * Terrain bodies, ProjectileManager, fire or explode. In the networked
 * path those only run on the server; the client is a pure renderer.
 *
 * Rope + jetpack are gated off in networked mode (plan #65 follow-up).
 * Calls log a warning and drop.
 */

import type {
  ClientMsg,
  DamageEventMessage,
  FireEventMessage,
  SimStateMessage,
  TeamInit,
  TerrainCutMessage,
  WormDiedMessage,
} from "../net/types";
import type { RoomHandle } from "../net/wsClient";
import { Team } from "../worm/Team";
import type { RenderableProjectile, RenderableWorm, SimAdapter, SimEvent } from "./SimAdapter";

/**
 * Two-frame buffer slot. Carries the server tick, arrival wall-clock, and
 * the actual state. Interpolation blends from `prev` to `curr` based on
 * wall-clock time since `curr.receivedAt`.
 */
interface FrameBufferSlot {
  readonly receivedAt: number;
  readonly state: SimStateMessage;
}

export interface NetworkedSimAdapterInit {
  room: RoomHandle;
  teams: TeamInit[];
  /**
   * Time window between consecutive sim_state frames in ms. Used as the
   * interpolation horizon; defaults to 50ms (20Hz server tick).
   */
  frameIntervalMs?: number;
}

export class NetworkedSimAdapter implements SimAdapter {
  readonly kind = "networked" as const;
  readonly teams: Team[] = [];
  readonly allWorms: RenderableWorm[] = [];

  private readonly room: RoomHandle;
  /** ms between consecutive sim_state frames; commit 3 uses this as the lerp horizon. */
  protected readonly frameIntervalMs: number;
  private readonly unsubs: Array<() => void> = [];
  private readonly eventSubs = new Set<(ev: SimEvent) => void>();
  private readonly gameOverSubs = new Set<(winnerTeamId: string | null) => void>();
  private readonly turnChangedSubs = new Set<(teamId: string, wormId: string) => void>();
  private readonly inputAllowedSubs = new Set<(allowed: boolean) => void>();

  /**
   * Two-frame interpolation buffer. `prev` is the previous sim_state;
   * `curr` is the latest. Renderer lerps positions at alpha =
   * clamp01((now - curr.receivedAt) / frameIntervalMs).
   *
   * Null before the first sim_state arrives. See Commit 3 for the full
   * interpolation path (this commit just hands positions from curr to
   * the renderer unchanged).
   */
  protected prevFrame: FrameBufferSlot | null = null;
  protected currFrame: FrameBufferSlot | null = null;

  /**
   * Mutable render views, one per worm from the authoritative team init.
   * The render views are created once at adapter construction so the
   * array reference stays stable for the scene's sprite map. Values are
   * updated every frame from `currFrame.state` during update().
   */
  private readonly renderState = new Map<
    string,
    {
      xPx: number;
      yPx: number;
      facing: -1 | 1;
      aimAngle: number;
      aimPower: number;
      hp: number;
      alive: boolean;
    }
  >();

  private inputSeq = 0;
  private inputAllowed = false;
  private lastActiveTeamId = "";
  private lastActiveWormId = "";
  private lastTurnEndsAt = 0;

  // Aim throttling: drag-to-aim fires at 60+Hz but we only send max
  // one input_aim_{angle,power} pair every 50ms (20Hz). The last value
  // is remembered so a subsequent flush lands the final state before
  // the fire message.
  private lastAimSendMs = 0;
  private pendingAimAngle: number | null = null;
  private pendingAimPower: number | null = null;
  /** Cache last walk dir so a second walk(0) after a walk(1) doesn't re-send. */
  private lastWalkDir: -1 | 0 | 1 | null = null;
  /** Cache last jetpack thrust so sustained presses don't re-send every frame. */
  private lastJetThrustV: boolean | null = null;
  /** Cache last jetpack horizontal dir for the same reason. */
  private lastJetThrustH: -1 | 0 | 1 | null = null;

  constructor(init: NetworkedSimAdapterInit) {
    this.room = init.room;
    this.frameIntervalMs = init.frameIntervalMs ?? 50;

    // Parse team color strings to Phaser ints once at construction.
    for (const t of init.teams) {
      this.teams.push(new Team({ id: t.id, name: t.name, color: parseTeamColor(t.color) }));
    }

    // Build allWorms from the authoritative team roster. These are the
    // worms the scene will render; positions start at (0, 0) and update
    // from the first sim_state. Initial hp = maxHealth is a placeholder;
    // the first sim_state reconciles it within ~50ms.
    for (const t of init.teams) {
      const team = this.teams.find((x) => x.id === t.id);
      if (!team) continue;
      for (const wormName of t.wormNames) {
        const state = {
          xPx: 0,
          yPx: 0,
          facing: 1 as -1 | 1,
          aimAngle: -Math.PI / 4,
          aimPower: 0.5,
          hp: 100,
          alive: true,
        };
        this.renderState.set(wormName, state);
        const view: RenderableWorm = {
          id: wormName,
          team,
          name: wormName,
          get xPx() {
            return state.xPx;
          },
          get yPx() {
            return state.yPx;
          },
          get facing() {
            return state.facing;
          },
          get aimAngle() {
            return state.aimAngle;
          },
          get aimPower() {
            return state.aimPower;
          },
          get hp() {
            return state.hp;
          },
          get isAlive() {
            return state.alive;
          },
        };
        this.allWorms.push(view);
      }
    }

    this.wireRoom();
  }

  // -------------------------------------------------------------------------
  // SimAdapter API
  // -------------------------------------------------------------------------

  getActiveWormId(): string {
    return this.currFrame?.state.activeWormId ?? this.lastActiveWormId;
  }

  getActiveTeamId(): string {
    return this.currFrame?.state.activeTeamId ?? this.lastActiveTeamId;
  }

  getTurnSecondsRemaining(): number {
    const endsAt = this.currFrame?.state.turnEndsAt ?? this.lastTurnEndsAt;
    if (endsAt <= 0) return 0;
    return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
  }

  walk(dir: -1 | 0 | 1): void {
    // Transition-only send: walk() is called every frame by InputController
    // while a key is held; the server only needs press/release edges.
    if (dir === this.lastWalkDir) return;
    this.lastWalkDir = dir;
    this.send({ type: "input_walk", dir, seq: this.nextSeq() });
  }

  jump(): void {
    this.send({ type: "input_jump", seq: this.nextSeq() });
  }

  backflip(): void {
    this.send({ type: "input_backflip", seq: this.nextSeq() });
  }

  setAimAngle(rad: number): void {
    this.pendingAimAngle = rad;
    this.maybeFlushAim();
  }

  setAimPower(p: number): void {
    this.pendingAimPower = p;
    this.maybeFlushAim();
  }

  setFacing(_dir: -1 | 1): void {
    // Facing is derived from the server sim (from the last walk dir applied
    // server-side). Client does not own facing authoritatively in networked
    // mode. Intentional no-op.
  }

  selectWeapon(id: string): void {
    this.send({ type: "input_select_weapon", weaponId: id, seq: this.nextSeq() });
  }

  fire(): void {
    // Flush any pending aim state so the server sees the exact release
    // angle + power immediately before the fire message.
    this.flushPendingAim();
    this.send({ type: "input_fire", seq: this.nextSeq() });
  }

  endTurn(): void {
    this.send({ type: "input_end_turn", seq: this.nextSeq() });
  }

  toggleRope(): void {
    // Plan #65: rope + jetpack disabled in networked mode until client-side
    // prediction is wired. Log once per call so dev mode is noticeable, but
    // don't crash or reach for the local sim.
    console.warn("[NetworkedSimAdapter] Rope is not available in networked mode (plan #65).");
  }

  toggleJetPack(): void {
    this.send({ type: "input_jetpack_toggle", seq: this.nextSeq() });
  }

  setJetPackThrust(active: boolean): void {
    if (active === this.lastJetThrustV) return;
    this.lastJetThrustV = active;
    this.send({ type: "input_jetpack_thrust", active, seq: this.nextSeq() });
  }

  setJetPackHorizontal(dir: -1 | 0 | 1): void {
    if (dir === this.lastJetThrustH) return;
    this.lastJetThrustH = dir;
    this.send({ type: "input_jetpack_horizontal", dir, seq: this.nextSeq() });
  }

  isJetPacking(): boolean {
    const activeId = this.getActiveWormId();
    return this.currFrame?.state.worms.find((w) => w.id === activeId)?.jetPackActive ?? false;
  }

  getJetPackFuel(): number {
    const activeId = this.getActiveWormId();
    return this.currFrame?.state.worms.find((w) => w.id === activeId)?.jetPackFuel ?? 0;
  }

  update(_dtMs: number): void {
    this.applyInterpolatedFrameToRenderState(Date.now());
    // If the caller stopped feeding us aim updates but we still have a
    // pending value (e.g. user released the drag gesture), flush now.
    this.maybeFlushAim();
  }

  destroy(): void {
    for (const unsub of this.unsubs) {
      try {
        unsub();
      } catch {
        // ignore
      }
    }
    this.unsubs.length = 0;
    this.eventSubs.clear();
    this.gameOverSubs.clear();
    this.turnChangedSubs.clear();
    this.inputAllowedSubs.clear();
  }

  onEvent(cb: (ev: SimEvent) => void): () => void {
    this.eventSubs.add(cb);
    return () => {
      this.eventSubs.delete(cb);
    };
  }

  onGameOver(cb: (winnerTeamId: string | null) => void): () => void {
    this.gameOverSubs.add(cb);
    return () => {
      this.gameOverSubs.delete(cb);
    };
  }

  onTurnChanged(cb: (activeTeamId: string, activeWormId: string) => void): () => void {
    this.turnChangedSubs.add(cb);
    return () => {
      this.turnChangedSubs.delete(cb);
    };
  }

  onInputAllowedChanged(cb: (allowed: boolean) => void): () => void {
    this.inputAllowedSubs.add(cb);
    return () => {
      this.inputAllowedSubs.delete(cb);
    };
  }

  /**
   * Latest projectile list for scene rendering. Uses the same two-frame
   * lerp as worms so bullets trail smoothly between 50ms frames instead
   * of teleporting. Projectiles that only exist in curr (newly spawned)
   * render at curr.x/curr.y.
   */
  getProjectiles(): RenderableProjectile[] {
    const curr = this.currFrame;
    if (!curr) return [];
    const prev = this.prevFrame;
    const rawAlpha = (Date.now() - curr.receivedAt) / this.frameIntervalMs;
    const alpha = rawAlpha < 0 ? 0 : rawAlpha > 1 ? 1 : rawAlpha;

    const prevById = new Map<string, (typeof curr.state.projectiles)[number]>();
    if (prev) {
      for (const p of prev.state.projectiles) prevById.set(p.id, p);
    }

    return curr.state.projectiles.map((p) => {
      const pPrev = prevById.get(p.id);
      if (!pPrev) return { id: p.id, xPx: p.x, yPx: p.y, type: p.type };
      return {
        id: p.id,
        xPx: pPrev.x + (p.x - pPrev.x) * alpha,
        yPx: pPrev.y + (p.y - pPrev.y) * alpha,
        type: p.type,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private nextSeq(): number {
    this.inputSeq += 1;
    return this.inputSeq;
  }

  private send(msg: ClientMsg): void {
    this.room.send(msg);
  }

  /** Send the pending aim values now if > 50ms since last send. */
  private maybeFlushAim(): void {
    const now = Date.now();
    if (now - this.lastAimSendMs < 50) return;
    this.flushPendingAim();
  }

  /** Drain pendingAim* and fire the matching input_aim_{angle,power} messages. */
  private flushPendingAim(): void {
    if (this.pendingAimAngle === null && this.pendingAimPower === null) return;
    this.lastAimSendMs = Date.now();
    if (this.pendingAimAngle !== null) {
      this.send({
        type: "input_aim_angle",
        angleRad: this.pendingAimAngle,
        seq: this.nextSeq(),
      });
      this.pendingAimAngle = null;
    }
    if (this.pendingAimPower !== null) {
      this.send({
        type: "input_aim_power",
        power: this.pendingAimPower,
        seq: this.nextSeq(),
      });
      this.pendingAimPower = null;
    }
  }

  /**
   * Ingest a sim_state message: shift currFrame -> prevFrame, set the new
   * frame as curr, fire turn-changed callbacks if activeTeamId/activeWormId
   * flipped, and update input-allowed accordingly (input allowed iff the
   * active team belongs to our sessionId).
   *
   * Package-visible so tests can drive it directly without hand-rolling a
   * RoomHandle.
   */
  ingestSimState(state: SimStateMessage): void {
    const now = Date.now();
    this.prevFrame = this.currFrame;
    this.currFrame = { receivedAt: now, state };

    // Turn-change detection.
    if (
      state.activeTeamId !== this.lastActiveTeamId ||
      state.activeWormId !== this.lastActiveWormId
    ) {
      this.lastActiveTeamId = state.activeTeamId;
      this.lastActiveWormId = state.activeWormId;
      for (const sub of this.turnChangedSubs) sub(state.activeTeamId, state.activeWormId);
    }
    this.lastTurnEndsAt = state.turnEndsAt;
  }

  /**
   * Two-frame linear interpolation. For each worm, pick the prev-frame and
   * curr-frame positions (if both exist), and lerp at
   * alpha = clamp01((now - curr.receivedAt) / frameIntervalMs).
   *
   * alpha = 0 snaps to curr at the moment it arrives; alpha = 1 lands on
   * curr + (curr - prev) extrapolated. We clamp at 1 to avoid runaway
   * extrapolation when the server pauses sending (e.g. player reconnect).
   *
   * Facing / aimAngle / aimPower snap instantly because angular lerp adds
   * little visual value and would break the 180deg flip at facing change.
   * hp / alive likewise snap (discrete steps).
   *
   * This handles four cases:
   *   1. No curr frame: render state untouched (caller saw initial zero
   *      state; renderer draws worms where they spawn until first frame).
   *   2. Curr but no prev: snap to curr (first frame since game start).
   *   3. Prev + curr: lerp.
   *   4. Worm present in curr but not prev: snap to curr (spawn case).
   */
  protected applyInterpolatedFrameToRenderState(nowMs: number): void {
    const curr = this.currFrame;
    if (!curr) return;

    const prev = this.prevFrame;
    // Saturate alpha to [0, 1]. At alpha = 1 we sit on curr exactly.
    const rawAlpha = (nowMs - curr.receivedAt) / this.frameIntervalMs;
    const alpha = rawAlpha < 0 ? 0 : rawAlpha > 1 ? 1 : rawAlpha;

    // Build a quick lookup for prev worms so the per-worm lerp is O(1).
    const prevById = new Map<string, (typeof curr.state.worms)[number]>();
    if (prev) {
      for (const w of prev.state.worms) prevById.set(w.id, w);
    }

    for (const wCurr of curr.state.worms) {
      const slot = this.renderState.get(wCurr.id);
      if (!slot) continue;
      const wPrev = prevById.get(wCurr.id);
      if (!wPrev) {
        // New (or no prior frame): snap directly to curr.
        slot.xPx = wCurr.x;
        slot.yPx = wCurr.y;
      } else {
        slot.xPx = wPrev.x + (wCurr.x - wPrev.x) * alpha;
        slot.yPx = wPrev.y + (wCurr.y - wPrev.y) * alpha;
      }
      // Discrete fields snap to curr.
      slot.facing = wCurr.facing;
      slot.aimAngle = wCurr.aimAngle;
      slot.aimPower = wCurr.aimPower;
      slot.hp = wCurr.hp;
      slot.alive = wCurr.alive;
    }
  }

  /**
   * Flip inputAllowed based on whether the session's team is active.
   * Callers provide their `mySessionId + myTeamId` because the adapter
   * doesn't own that mapping - GameScene does.
   */
  setActive(active: boolean): void {
    if (this.inputAllowed === active) return;
    this.inputAllowed = active;
    for (const sub of this.inputAllowedSubs) sub(active);
  }

  isInputAllowed(): boolean {
    return this.inputAllowed;
  }

  private wireRoom(): void {
    const simStateUnsub = this.room.onMessage("sim_state", (msg: SimStateMessage) => {
      this.ingestSimState(msg);
    });
    this.unsubs.push(simStateUnsub);

    const cutUnsub = this.room.onMessage("terrain_cut", (msg: TerrainCutMessage) => {
      for (const sub of this.eventSubs) {
        sub({ type: "terrain_cut", x: msg.x, y: msg.y, r: msg.r, seq: msg.seq });
      }
    });
    this.unsubs.push(cutUnsub);

    const fireUnsub = this.room.onMessage("fire_event", (msg: FireEventMessage) => {
      for (const sub of this.eventSubs) {
        sub({
          type: "fire_event",
          wormId: msg.wormId,
          weaponId: msg.weaponId,
          angleRad: msg.angleRad,
          power: msg.power,
          facing: msg.facing,
        });
      }
    });
    this.unsubs.push(fireUnsub);

    const dmgUnsub = this.room.onMessage("damage_event", (msg: DamageEventMessage) => {
      for (const sub of this.eventSubs) {
        sub({
          type: "damage_event",
          wormId: msg.wormId,
          amount: msg.amount,
          fromProjectileId: msg.fromProjectileId ?? null,
          impact: msg.impact,
        });
      }
    });
    this.unsubs.push(dmgUnsub);

    const diedUnsub = this.room.onMessage("worm_died", (msg: WormDiedMessage) => {
      for (const sub of this.eventSubs) {
        sub({ type: "worm_died", wormId: msg.wormId });
      }
    });
    this.unsubs.push(diedUnsub);

    const gameOverUnsub = this.room.onMessage("game_over", (msg) => {
      for (const sub of this.gameOverSubs) sub(msg.winnerTeamId);
    });
    this.unsubs.push(gameOverUnsub);
  }
}

function parseTeamColor(input: string | number): number {
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (typeof input === "string") {
    const hex = input.startsWith("#") ? input.slice(1) : input;
    const parsed = Number.parseInt(hex, 16);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0xaaaaaa;
}
