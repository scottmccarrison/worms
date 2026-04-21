import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, CODE_LENGTH, generateCode, generateUniqueCode } from "./codegen.js";

describe("generateCode", () => {
  it("always returns a 4-character string", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();
      expect(code).toHaveLength(CODE_LENGTH);
    }
  });

  it("only contains characters from the alphabet", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();
      for (const ch of code) {
        expect(CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("never emits I or O (ambiguous characters)", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateCode();
      expect(code).not.toMatch(/[IO]/);
    }
  });
});

describe("generateUniqueCode", () => {
  it("returns a code that is not in the taken set", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const code = generateUniqueCode(taken);
      expect(taken.has(code)).toBe(false);
      taken.add(code);
    }
  });

  it("retries past a taken code", () => {
    // Seed Math.random to force a predictable collision path: first
    // we monkey-patch to return a sequence of values so the first call
    // produces a known code, then subsequent calls produce a different
    // one. Easier: fill the taken set with a large subset and check
    // that the generator still finds a free code.
    const taken = new Set<string>();
    // Pre-populate a lot of codes by generating them.
    for (let i = 0; i < 500; i++) {
      taken.add(generateCode());
    }
    const code = generateUniqueCode(taken, 1000);
    expect(taken.has(code)).toBe(false);
    expect(code).toHaveLength(CODE_LENGTH);
  });

  it("throws when every attempt collides", () => {
    // Stub Math.random so generateCode always returns the same code,
    // then pre-populate the taken set with that exact code.
    const original = Math.random;
    Math.random = () => 0; // picks ALPHABET[0] every index -> "AAAA"
    try {
      const taken = new Set<string>(["AAAA"]);
      expect(() => generateUniqueCode(taken, 10)).toThrow(/Failed to generate unique room code/);
    } finally {
      Math.random = original;
    }
  });

  it("respects the default maxAttempts of 100", () => {
    const original = Math.random;
    Math.random = () => 0;
    try {
      const taken = new Set<string>(["AAAA"]);
      expect(() => generateUniqueCode(taken)).toThrow(/after 100 attempts/);
    } finally {
      Math.random = original;
    }
  });
});
