/**
 * Pure input sanitisers. Post-Epic-45 only nickname handling lives
 * here; turn_snapshot is gone (the server owns the sim
 * authoritatively, so client-sent snapshots have no role).
 */

export const NICKNAME_MIN = 1;
export const NICKNAME_MAX = 16;

/**
 * Strip C0/C1 control chars, zero-width + bidi overrides, and ZWNBSP.
 * Without this a client could send RTL-override characters to spoof
 * display order, or newlines to break the room-view layout.
 */
export function normaliseNickname(input: unknown): string {
  if (typeof input !== "string") return "";
  return (
    input
      // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional; stripping control chars from user input
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
      .trim()
  );
}

/** True when the normalised nickname is within the accepted length. */
export function isValidNickname(nickname: string): boolean {
  return nickname.length >= NICKNAME_MIN && nickname.length <= NICKNAME_MAX;
}
