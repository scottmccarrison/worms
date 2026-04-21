import type { Team } from "../worm/Team";
import { getById, getByKey } from "./registry";
import type { WeaponConfig } from "./types";

export class WeaponManager {
  private readonly team: Team;
  private readonly ammo: Record<string, number>;
  private selectedId: string;

  /** How many shots have been fired in the current activation (resets on turn start). */
  shotsFiredThisActivation = 0;

  constructor(team: Team, initialAmmo: Record<string, number>) {
    this.team = team;
    this.ammo = { ...initialAmmo };
    // Default selection: first weapon by key=1
    const first = getByKey(1);
    this.selectedId = first?.id ?? Object.keys(initialAmmo)[0] ?? "";
  }

  /** Currently selected weapon config. */
  getSelected(): WeaponConfig {
    const w = getById(this.selectedId);
    if (!w) throw new Error(`WeaponManager: unknown weapon id "${this.selectedId}"`);
    return w;
  }

  /**
   * Select a weapon by id. Only succeeds if ammo > 0 or infinite (-1).
   * Returns true if selection changed.
   */
  select(id: string): boolean {
    const w = getById(id);
    if (!w) return false;
    if (!this.hasAmmo(id)) return false;
    this.selectedId = id;
    return true;
  }

  /**
   * Select by numeric key. Returns true if selection changed.
   */
  selectByKey(n: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9): boolean {
    const w = getByKey(n);
    if (!w) return false;
    return this.select(w.id);
  }

  /**
   * Returns current ammo for the given weapon id.
   * -1 = infinite.
   */
  ammoFor(id: string): number {
    return this.ammo[id] ?? 0;
  }

  /** Returns true if the weapon has ammo (infinite or > 0). */
  hasAmmo(id: string): boolean {
    const a = this.ammoFor(id);
    return a === -1 || a > 0;
  }

  /**
   * Decrement ammo for finite weapons. No-op for infinite (-1).
   */
  consumeOne(id: string): void {
    const a = this.ammo[id];
    if (a === undefined || a === -1) return; // infinite or unknown
    this.ammo[id] = Math.max(0, a - 1);
  }

  /**
   * Reset per-activation state. Call at the start of each turn.
   */
  resetActivation(): void {
    this.shotsFiredThisActivation = 0;
  }

  get teamId(): string {
    return this.team.id;
  }
}
