import { describe, expect, it } from "vitest";
import {
  validateMattermostCallbackHandle,
  validateMattermostId,
  validateMattermostOpaqueToken,
  validateMattermostResponseUrl,
} from "../validate-ids.ts";

const ADVERSARIAL_STRINGS = [
  "",
  "a".repeat(1_000_000),
  "abc\u0000def",
  "abc\r\ndef",
  "\u001b[31mabcdef\u001b[0m",
  "abc\u202edef",
  "１２３４５６",
  "a".repeat(8192) + "!",
];

describe("Mattermost identifier validators", () => {
  it("accepts known-good identifiers", () => {
    expect(validateMattermostId("abcdefghijklmnopqrstu12345")).toEqual({
      ok: true,
    });
    expect(validateMattermostCallbackHandle("mattermost:abcdefghijklmnopqr")).toEqual({
      ok: true,
    });
    expect(validateMattermostOpaqueToken("tk_ABC.123-xyz")).toEqual({ ok: true });
    expect(validateMattermostResponseUrl("https://mattermost.example.com/hooks/x")).toEqual({
      ok: true,
    });
  });

  it("rejects adversarial malformed identifiers without throwing", () => {
    for (const input of ADVERSARIAL_STRINGS) {
      expect(() => validateMattermostId(input)).not.toThrow();
      expect(validateMattermostId(input).ok).toBe(false);
      expect(() => validateMattermostCallbackHandle(input)).not.toThrow();
      expect(validateMattermostCallbackHandle(input).ok).toBe(false);
      expect(() => validateMattermostOpaqueToken(input)).not.toThrow();
      expect(validateMattermostOpaqueToken(input).ok).toBe(false);
    }
  });

  it("fuzzes arbitrary strings without accepting non-base32 IDs", () => {
    for (let seed = 0; seed < 20_000; seed += 1) {
      const input = fuzzString(seed);
      expect(() => validateMattermostId(input)).not.toThrow();
      const result = validateMattermostId(input);
      if (result.ok) {
        expect(input).toMatch(/^[a-z0-9]{26}$/);
      }
    }
  });

  it("keeps adversarial validation linear-time", () => {
    const started = process.hrtime.bigint();
    for (const input of ADVERSARIAL_STRINGS) {
      validateMattermostId(input);
      validateMattermostCallbackHandle(input);
      validateMattermostOpaqueToken(input);
      validateMattermostResponseUrl(input);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    expect(elapsedMs).toBeLessThan(250);
  });
});

function fuzzString(seed: number): string {
  let state = seed + 1;
  const length = state % 260;
  let output = "";
  for (let index = 0; index < length; index += 1) {
    state = (state * 22695477 + 1) >>> 0;
    output += String.fromCharCode(state % 128);
  }
  return output;
}
