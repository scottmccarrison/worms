/**
 * Pure Web Share / clipboard flow for the room invite link.
 *
 * Extracted from LobbyScene so it can be unit-tested without Phaser: the
 * function only touches the subset of `window` it needs (`location` +
 * `navigator`). The caller is responsible for reacting to the return value
 * (e.g. showing a "Link copied" toast on `"copied"`, or revealing a raw
 * URL text field on `"failed"`).
 *
 * Return values:
 * - `"shared"`  - navigator.share resolved successfully (or user cancelled,
 *                 which rejects with AbortError; we treat that as a success
 *                 because the user saw the sheet).
 * - `"copied"`  - clipboard fallback wrote the URL.
 * - `"failed"`  - neither share nor clipboard worked; caller should show the
 *                 raw URL for manual copy.
 */

export type ShareResult = "shared" | "copied" | "failed";

export interface ShareWindow {
  location: { origin: string; pathname: string };
  navigator: {
    share?: (data: { title?: string; text?: string; url?: string }) => Promise<void>;
    clipboard?: { writeText?: (text: string) => Promise<void> };
  };
}

/** Build the deep-link URL for a given room code. */
export function buildInviteUrl(code: string, win: ShareWindow): string {
  return `${win.location.origin}${win.location.pathname}?room=${code}`;
}

function isAbortError(err: unknown): boolean {
  if (err && typeof err === "object" && "name" in err) {
    const name = (err as { name?: unknown }).name;
    return name === "AbortError";
  }
  return false;
}

/**
 * Attempt to share the invite URL via the Web Share API, then the Clipboard
 * API, then fail. See module doc for return-value semantics.
 */
export async function shareInvite(code: string, win: ShareWindow): Promise<ShareResult> {
  const url = buildInviteUrl(code, win);
  const share = win.navigator.share;
  if (typeof share === "function") {
    try {
      await share.call(win.navigator, {
        title: "Join my worms game",
        text: `Room code: ${code}`,
        url,
      });
      return "shared";
    } catch (err) {
      // User dismissed the share sheet. Treat as success - they made a choice.
      if (isAbortError(err)) return "shared";
      // Any other share failure (e.g. permission denied, not supported despite
      // the function existing) falls through to clipboard.
    }
  }

  const writeText = win.navigator.clipboard?.writeText;
  if (typeof writeText === "function") {
    try {
      await writeText.call(win.navigator.clipboard, url);
      return "copied";
    } catch {
      // Clipboard rejected (insecure context, permission denied). Fall through.
    }
  }

  return "failed";
}
