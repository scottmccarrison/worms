import { describe, expect, it, vi } from "vitest";
import { buildInviteUrl, shareInvite } from "./shareInvite";
import type { ShareWindow } from "./shareInvite";

function makeWindow(overrides: Partial<ShareWindow["navigator"]> = {}): ShareWindow {
  return {
    location: { origin: "https://example.com", pathname: "/worms/" },
    navigator: overrides,
  };
}

describe("buildInviteUrl", () => {
  it("concatenates origin + pathname + ?room=<code>", () => {
    const win = makeWindow();
    expect(buildInviteUrl("WAVE", win)).toBe("https://example.com/worms/?room=WAVE");
  });
});

describe("shareInvite", () => {
  it("returns 'shared' when navigator.share resolves", async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    const win = makeWindow({ share });
    const result = await shareInvite("WAVE", win);
    expect(result).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    const call = share.mock.calls[0]?.[0] as {
      title?: string;
      text?: string;
      url?: string;
    };
    expect(call?.url).toBe("https://example.com/worms/?room=WAVE");
    expect(call?.text).toContain("WAVE");
  });

  it("returns 'shared' when navigator.share rejects with AbortError (user cancelled)", async () => {
    const abort = Object.assign(new Error("user cancelled"), { name: "AbortError" });
    const share = vi.fn().mockRejectedValue(abort);
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    const win = makeWindow({ share, clipboard });
    const result = await shareInvite("CODE", win);
    expect(result).toBe("shared");
    // Clipboard must not be touched when the user explicitly cancelled.
    expect(clipboard.writeText).not.toHaveBeenCalled();
  });

  it("returns 'copied' when share is unavailable and clipboard succeeds", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const win = makeWindow({ clipboard: { writeText } });
    const result = await shareInvite("WAVE", win);
    expect(result).toBe("copied");
    expect(writeText).toHaveBeenCalledWith("https://example.com/worms/?room=WAVE");
  });

  it("returns 'failed' when neither share nor clipboard is available", async () => {
    const win = makeWindow();
    const result = await shareInvite("WAVE", win);
    expect(result).toBe("failed");
  });

  it("falls back to clipboard when share throws a non-abort error", async () => {
    const share = vi.fn().mockRejectedValue(new Error("not allowed"));
    const writeText = vi.fn().mockResolvedValue(undefined);
    const win = makeWindow({ share, clipboard: { writeText } });
    const result = await shareInvite("WAVE", win);
    expect(result).toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  it("returns 'failed' when share throws and clipboard also throws", async () => {
    const share = vi.fn().mockRejectedValue(new Error("blocked"));
    const writeText = vi.fn().mockRejectedValue(new Error("insecure"));
    const win = makeWindow({ share, clipboard: { writeText } });
    const result = await shareInvite("WAVE", win);
    expect(result).toBe("failed");
  });
});
