/**
 * Server-side diagnostic logger.
 *
 * Always-on (DEBUG=true). Output goes to Cloudflare Worker logs,
 * visible via `wrangler tail`. No user-facing cost, no persistence.
 *
 * Every log line includes correlation IDs (room code + turn seq) so
 * multi-room tails are greppable by room.
 */

const DEBUG = true;
const THROTTLE_MS = 16;
const MAX_THROTTLE_KEYS = 256;

export type ServerScope = "room" | "net" | "sim" | "turn" | "client";

export interface LogContext {
  room?: string;
  turn?: number;
}

const lastEmit = new Map<string, number>();

function pruneIfNeeded(): void {
  if (lastEmit.size <= MAX_THROTTLE_KEYS) return;
  const keys = Array.from(lastEmit.keys());
  const toDrop = Math.floor(keys.length / 2);
  for (let i = 0; i < toDrop; i++) lastEmit.delete(keys[i]);
}

function formatCtx(ctx?: LogContext): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.room !== undefined && ctx.room !== "") parts.push(`room=${ctx.room}`);
  if (ctx.turn !== undefined) parts.push(`turn=${ctx.turn}`);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

export function dlog(scope: ServerScope, event: string, ctx?: LogContext, data?: unknown): void {
  if (!DEBUG) return;
  const key = `${scope}:${event}`;
  const now = Date.now();
  if ((lastEmit.get(key) ?? 0) + THROTTLE_MS > now) return;
  lastEmit.set(key, now);
  pruneIfNeeded();
  const prefix = `[${scope}] ${event}${formatCtx(ctx)}`;
  if (data !== undefined) console.log(`${prefix} |`, data);
  else console.log(prefix);
}

export function dlogUnthrottled(
  scope: ServerScope,
  event: string,
  ctx?: LogContext,
  data?: unknown,
): void {
  if (!DEBUG) return;
  const prefix = `[${scope}] ${event}${formatCtx(ctx)}`;
  if (data !== undefined) console.log(`${prefix} |`, data);
  else console.log(prefix);
}
