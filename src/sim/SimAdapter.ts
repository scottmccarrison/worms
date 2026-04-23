/**
 * Epic 45 - SimAdapter interface.
 *
 * The sim adapter is the seam between the GameScene renderer and whichever
 * flavour of simulation is actually driving the match. There are two concrete
 * implementations:
 *
 * - OfflineSimAdapter wraps the pre-Epic-45 local planck sim so
 *   `?offline=1` and single-device dev keep working after the networked
 *   path ships.
 * - NetworkedSimAdapter reads from the server's `sim_state` + event
 *   messages and surfaces a read-only view to the renderer.
 *
 * GameScene doesn't know which adapter it has; it reads
 * `adapter.allWorms[].x/y/aimAngle/...` every frame, subscribes to events
 * via `onEvent`, and forwards input via `walk/jump/...`. Offline mode
 * applies the input immediately to the local world; networked mode forwards
 * the input to the server and waits for the next `sim_state`.
 */
import type { DamageEvent, FireEvent, TerrainCutEvent, WormDiedEvent } from "../../shared/protocol";
import type { Team } from "../worm/Team";

/** Union of event types an adapter can emit upstream to the renderer. */
export type SimEvent =
  | ({ type: "terrain_cut" } & TerrainCutEvent)
  | ({ type: "fire_event" } & FireEvent)
  | ({ type: "damage_event" } & DamageEvent)
  | ({ type: "worm_died" } & WormDiedEvent);

/**
 * Renderer's view of a worm. Pixel-space coords so the renderer never
 * needs to know about physics meters. Offline adapter converts its
 * planck meters to pixels before exposing the struct; networked adapter
 * already receives server pixels per the protocol choice documented in
 * `shared/protocol.ts`.
 */
export interface RenderableWorm {
  readonly id: string;
  readonly team: Team;
  readonly xPx: number;
  readonly yPx: number;
  readonly facing: -1 | 1;
  readonly aimAngle: number;
  readonly aimPower: number;
  readonly hp: number;
  readonly isAlive: boolean;
  readonly name: string;
}

/**
 * Opaque handle into the renderer-facing simulation. Renderer calls the
 * input methods whenever the local player acts; offline adapter mutates
 * the local planck world, networked adapter forwards to the server via
 * `room.send(...)` and no-ops locally.
 *
 * Rope / jetpack are only wired in offline mode (per plan `#65` follow-up);
 * NetworkedSimAdapter logs a warning and drops the call.
 */
export interface SimAdapter {
  readonly kind: "offline" | "networked";
  /** Teams in draw order; mirrors server-side TeamInit[] in networked mode. */
  readonly teams: Team[];
  /** Flat list of all worms to render. Positions update per frame. */
  readonly allWorms: RenderableWorm[];

  getActiveWormId(): string;
  getActiveTeamId(): string;
  /** Weapon id currently selected by the active worm, empty if none. */
  getActiveWeaponId(): string;
  /** Seconds remaining on the active turn. Server-authoritative when networked. */
  getTurnSecondsRemaining(): number;
  /** Wind strength -1..1; negative = leftward. Zero in offline mode. */
  getWind(): number;
  /** Water level in pixels. Number.MAX_SAFE_INTEGER means no water. */
  getWaterLevelPx(): number;

  // ---- Input accepters (caller is whoever holds the local input device) ----
  walk(dir: -1 | 0 | 1): void;
  jump(): void;
  backflip(): void;
  setAimAngle(rad: number): void;
  setAimPower(p: number): void;
  setFacing(dir: -1 | 1): void;
  selectWeapon(id: string): void;
  fire(): void;
  endTurn(): void;
  /** Rope / jetpack toggle. Offline-only per plan #65; networked adapter no-ops. */
  toggleRope(): void;
  toggleJetPack(): void;
  setJetPackThrust(active: boolean): void;
  setJetPackHorizontal(dir: -1 | 0 | 1): void;
  isJetPacking(): boolean;
  /** Current jetpack fuel level, 0..100. */
  getJetPackFuel(): number;

  // ---- Lifecycle ----
  /** Per-frame update. Offline: drives planck step + settle. Networked: advances interpolation clock. */
  update(dtMs: number): void;
  /** Tear down all subsystems owned by the adapter. Safe to call multiple times. */
  destroy(): void;

  // ---- Event hooks ----
  /** Subscribe to sim events for VFX. Returns an unsubscribe fn. */
  onEvent(cb: (ev: SimEvent) => void): () => void;
  /** Subscribe to game-over. winnerTeamId === null means draw. */
  onGameOver(cb: (winnerTeamId: string | null) => void): () => void;
  /** Called once per adapter-computed "turn flipped" boundary (so renderer can swap HUDs). */
  onTurnChanged(cb: (activeTeamId: string, activeWormId: string) => void): () => void;
  /** Called when input-allowed changes (e.g. we become active, or turn-end lands). */
  onInputAllowedChanged(cb: (allowed: boolean) => void): () => void;
  /**
   * Fires once per turn-change when the sim's next-turn state is
   * "committed". Offline: fires on next microtask after onTurnChanged.
   * Networked: fires after N consecutive sim_state frames report the
   * same active team/worm as the latest turn_changed.
   * Used by TurnTransition to stretch the hold-at-overview phase
   * adaptively across flaky connections.
   */
  onStateStable(cb: () => void): () => void;
}

/**
 * Minimal projectile view, used by the scene to spawn / update / despawn
 * sprites. Offline adapter feeds these from its internal ProjectileManager;
 * networked adapter builds them from the server's `ProjectileRenderState[]`.
 */
export interface RenderableProjectile {
  readonly id: string;
  readonly xPx: number;
  readonly yPx: number;
  readonly type: string;
}
