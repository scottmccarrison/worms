/**
 * Diagnostic logger gated by `?debug=1` URL param.
 *
 * Usage:
 *   dlog("scene", "GameScene.create");
 *   dlog("net", "state received", { phase });
 *   dlog("sim", "turn_changed", { teamId, wormId });
 *
 * - Zero cost when disabled (early return before any allocation).
 * - Per (scope, event) 16ms throttle so rAF-rate events don't flood console.
 * - Use dlogUnthrottled for one-shot lifecycle events you ALWAYS want.
 */

type Scope = "scene" | "net" | "sim" | "camera" | "input";

let enabled = typeof window !== "undefined" && window.location.search.includes("debug=1");

const lastEmit = new Map<string, number>();

/** Programmatic enable/disable (primarily for tests). */
export function setLoggerEnabled(v: boolean): void {
  enabled = v;
}

export function isLoggerEnabled(): boolean {
  return enabled;
}

export function dlog(scope: Scope, event: string, data?: unknown): void {
  if (!enabled) return;
  const key = `${scope}:${event}`;
  const now = Date.now();
  if ((lastEmit.get(key) ?? 0) + 16 > now) return;
  lastEmit.set(key, now);
  if (data !== undefined) console.log(`[${scope}] ${event}`, data);
  else console.log(`[${scope}] ${event}`);
}

export function dlogUnthrottled(scope: Scope, event: string, data?: unknown): void {
  if (!enabled) return;
  if (data !== undefined) console.log(`[${scope}] ${event}`, data);
  else console.log(`[${scope}] ${event}`);
}
