/**
 * Parsed URL params for boot-time scene routing.
 *
 * - `offline`: dev-only flag that skips the lobby and drops straight into
 *   GameScene with local defaults. Matches Epic 7's single-device behaviour.
 * - `autoJoinCode`: 4-letter uppercase room code from `?room=WAVE`. Invalid
 *   codes (wrong length, lowercase, digits, characters outside CODE_ALPHABET)
 *   are rejected to null so we never send garbage into the matchmaker.
 * - `mapId`: optional `?map=hills` hint consumed by GameScene in offline mode.
 */
import { CODE_ALPHABET } from "../../../shared/codeAlphabet";

export interface UrlParams {
  offline: boolean;
  autoJoinCode: string | null;
  mapId: string | null;
}

const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{4}$`);

/**
 * Pure URL query parser. Input is the `search` portion (e.g. `?room=WAVE&offline=1`).
 * Safe to call in tests without a window.
 */
export function parseUrlParams(search: string): UrlParams {
  const params = new URLSearchParams(search);
  const offlineRaw = params.get("offline");
  const offline = offlineRaw === "1" || offlineRaw === "true";

  const rawCode = params.get("room");
  const autoJoinCode = rawCode && CODE_PATTERN.test(rawCode) ? rawCode : null;

  const rawMap = params.get("map");
  const mapId = rawMap && rawMap.length > 0 ? rawMap : null;

  return { offline, autoJoinCode, mapId };
}
