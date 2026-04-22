import { describe, expect, it } from "vitest";
import { CODE_ALPHABET, CODE_LENGTH, generateCode, generateUniqueCode } from "../src/codegen.js";

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
    const taken = new Set<string>();
    for (let i = 0; i < 500; i++) {
      taken.add(generateCode());
    }
    const code = generateUniqueCode(taken, 1000);
    expect(taken.has(code)).toBe(false);
    expect(code).toHaveLength(CODE_LENGTH);
  });

  it("throws when every attempt collides", () => {
    const original = Math.random;
    Math.random = () => 0;
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
