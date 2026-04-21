import { describe, expect, it } from "vitest";
import { parseUrlParams } from "./urlParams";

describe("parseUrlParams", () => {
  it("returns defaults for an empty query string", () => {
    const parsed = parseUrlParams("");
    expect(parsed).toEqual({
      offline: false,
      autoJoinCode: null,
      mapId: null,
    });
  });

  it("recognizes ?offline=1 as offline mode", () => {
    expect(parseUrlParams("?offline=1").offline).toBe(true);
  });

  it("also recognizes ?offline=true", () => {
    expect(parseUrlParams("?offline=true").offline).toBe(true);
  });

  it("does not treat other offline values as truthy", () => {
    expect(parseUrlParams("?offline=0").offline).toBe(false);
    expect(parseUrlParams("?offline=yes").offline).toBe(false);
    expect(parseUrlParams("?offline=").offline).toBe(false);
  });

  it("accepts a valid 4-letter uppercase room code", () => {
    expect(parseUrlParams("?room=WAVE").autoJoinCode).toBe("WAVE");
    expect(parseUrlParams("?room=ZZZZ").autoJoinCode).toBe("ZZZZ");
  });

  it("rejects lowercase codes", () => {
    expect(parseUrlParams("?room=wave").autoJoinCode).toBeNull();
  });

  it("rejects codes of the wrong length", () => {
    expect(parseUrlParams("?room=ABC").autoJoinCode).toBeNull();
    expect(parseUrlParams("?room=ABCDE").autoJoinCode).toBeNull();
    expect(parseUrlParams("?room=").autoJoinCode).toBeNull();
  });

  it("rejects codes containing non A-Z characters", () => {
    expect(parseUrlParams("?room=WAV3").autoJoinCode).toBeNull();
    expect(parseUrlParams("?room=WAV-").autoJoinCode).toBeNull();
    expect(parseUrlParams("?room=WAV%20").autoJoinCode).toBeNull();
  });

  it("parses ?map=ID through unchanged", () => {
    expect(parseUrlParams("?map=hills").mapId).toBe("hills");
  });

  it("returns null for missing ?map", () => {
    expect(parseUrlParams("?room=WAVE").mapId).toBeNull();
  });

  it("combines flags together", () => {
    const parsed = parseUrlParams("?room=WAVE&offline=1&map=cave");
    expect(parsed).toEqual({
      offline: true,
      autoJoinCode: "WAVE",
      mapId: "cave",
    });
  });
});
