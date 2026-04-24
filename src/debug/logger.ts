/**
 * Client-side diagnostic logger gated by `?debug=1` URL param.
 *
 * Usage:
 *   dlog("scene", "GameScene.create");
 *   dlog("net", "state received", { phase });
 *
 * - Zero cost when disabled (early return before any allocation).
 * - Per (scope, event) 16ms throttle so rAF-rate events don't flood console.
 * - Use dlogUnthrottled for one-shot lifecycle events you ALWAYS want.
 * - Optional context (room, turn) set via setLogContext; appears in every log line.
 * - Optional forwarder sends every log to the server via WebSocket; configured
 *   by wsClient when a socket is open + logger is enabled. Rate-limited 20/sec
 *   per scope, and scope="net" is skipped to avoid feedback loops.
 */

type Scope = "scene" | "net" | "sim" | "camera" | "input";

interface LogContext {
  room?: string;
  turn?: number;
}

type Forwarder = (scope: Scope, event: string, data?: unknown) => void;

const THROTTLE_MS = 16;
const MAX_THROTTLE_KEYS = 256;
const FWD_MAX_PER_SEC = 20;

let enabled = typeof window !== "undefined" && window.location.search.includes("debug=1");
let ctx: LogContext = {};
let forwarder: Forwarder | null = null;
const lastEmit = new Map<string, number>();
const fwdBudget = new Map<Scope, { count: number; windowStart: number }>();

export function setLoggerEnabled(v: boolean): void { enabled = v; }
export function isLoggerEnabled(): boolean { return enabled; }
export function setLogContext(next: Partial<LogContext>): void { ctx = { ...ctx, ...next }; }
export function getLogContext(): LogContext { return { ...ctx }; }
export function setLogForwarder(f: Forwarder | null): void { forwarder = f; }
export function getLogForwarder(): Forwarder | null { return forwarder; }

export function _testGetThrottleMapSize(): number { return lastEmit.size; }
export function _testResetFwdBudget(): void { fwdBudget.clear(); }

function pruneIfNeeded(): void {
  if (lastEmit.size <= MAX_THROTTLE_KEYS) return;
  const keys = Array.from(lastEmit.keys());
  const toDrop = Math.floor(keys.length / 2);
  for (let i = 0; i < toDrop; i++) lastEmit.delete(keys[i]);
}

function formatCtx(): string {
  const parts: string[] = [];
  if (ctx.room !== undefined && ctx.room !== "") parts.push(`room=${ctx.room}`);
  if (ctx.turn !== undefined) parts.push(`turn=${ctx.turn}`);
  return parts.length > 0 ? " " + parts.join(" ") : "";
}

function tryForward(scope: Scope, event: string, data?: unknown): void {
  if (!forwarder) return;
  if (scope === "net") return; // prevent feedback loop via net:send / net:state received
  const now = Date.now();
  const b = fwdBudget.get(scope);
  if (!b || now - b.windowStart > 1000) {
    fwdBudget.set(scope, { count: 1, windowStart: now });
  } else if (b.count >= FWD_MAX_PER_SEC) {
    return;
  } else {
    b.count++;
  }
  try { forwarder(scope, event, data); } catch {}
}

export function dlog(scope: Scope, event: string, data?: unknown): void {
  if (!enabled) return;
  const key = `${scope}:${event}`;
  const now = Date.now();
  if ((lastEmit.get(key) ?? 0) + THROTTLE_MS > now) return;
  lastEmit.set(key, now);
  pruneIfNeeded();
  const prefix = `[${scope}] ${event}${formatCtx()}`;
  if (data !== undefined) console.log(prefix, data);
  else console.log(prefix);
  tryForward(scope, event, data);
}

export function dlogUnthrottled(scope: Scope, event: string, data?: unknown): void {
  if (!enabled) return;
  const prefix = `[${scope}] ${event}${formatCtx()}`;
  if (data !== undefined) console.log(prefix, data);
  else console.log(prefix);
  tryForward(scope, event, data);
}
