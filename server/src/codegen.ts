/**
 * Room-code generator for the lobby.
 *
 * Alphabet deliberately excludes I and O to avoid "is this a 1 / 0?"
 * confusion when friends read codes out loud or over SMS. 23 letters
 * give 23^4 = 279,841 possible codes, which is plenty for our scale
 * (codes are ephemeral: they die with the room).
 */

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // 23 letters: excludes I, O

/** Generate a single 4-letter code from ALPHABET. Not guaranteed unique. */
export function generateCode(): string {
  let out = "";
  for (let i = 0; i < 4; i++) {
    out += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  }
  return out;
}

/**
 * Generate a 4-letter code not present in `taken`.
 * Retries up to `maxAttempts` times to avoid a theoretical hot-loop
 * when the namespace is nearly full, then throws.
 *
 * At realistic room counts (<1000 concurrent) collision probability is
 * ~3.5e-3 per attempt, so the retry loop terminates almost always on
 * the first try.
 */
export function generateUniqueCode(taken: Set<string>, maxAttempts = 100): string {
  for (let i = 0; i < maxAttempts; i++) {
    const c = generateCode();
    if (!taken.has(c)) return c;
  }
  throw new Error(`Failed to generate unique room code after ${maxAttempts} attempts`);
}

/** Exported for tests + potential validation helpers. */
export const CODE_ALPHABET = ALPHABET;
export const CODE_LENGTH = 4;
