import { describe, expect, it } from "vitest";
import {
  validateTelegramCallbackData,
  validateTelegramCallbackQueryId,
  validateTelegramChatId,
  validateTelegramFileId,
  validateTelegramPositiveId,
} from "../validate-ids.ts";

const ADVERSARIAL_STRINGS = [
  "",
  "a".repeat(1_000_000),
  "123\u0000456",
  "123\r\n456",
  "\u001b[31m123\u001b[0m",
  "123\u202e456",
  "１２３４５６",
  "а".repeat(8192) + "!",
];

describe("Telegram identifier validators", () => {
  it("accepts known-good identifiers", () => {
    expect(validateTelegramPositiveId(42)).toEqual({ ok: true });
    expect(validateTelegramChatId(-1001234567890)).toEqual({ ok: true });
    expect(validateTelegramCallbackQueryId("AAHdqT4AAAAAAAG")).toEqual({ ok: true });
    expect(validateTelegramCallbackData("tg:abcdefghijklmnopqr")).toEqual({
      ok: true,
    });
    expect(validateTelegramFileId("AgACAgUAAxkBAAIBWmX-abc_def")).toEqual({
      ok: true,
    });
  });

  it("rejects adversarial malformed identifiers without throwing", () => {
    for (const input of ADVERSARIAL_STRINGS) {
      expect(() => validateTelegramPositiveId(input)).not.toThrow();
      expect(validateTelegramPositiveId(input).ok).toBe(false);
      expect(() => validateTelegramChatId(input)).not.toThrow();
      expect(validateTelegramChatId(input).ok).toBe(false);
      expect(() => validateTelegramCallbackQueryId(input)).not.toThrow();
      expect(validateTelegramCallbackQueryId(input).ok).toBe(false);
      expect(() => validateTelegramCallbackData(input)).not.toThrow();
      expect(validateTelegramCallbackData(input).ok).toBe(false);
    }
  });

  it("fuzzes arbitrary strings without accepting controls or oversized values", () => {
    for (let seed = 0; seed < 20_000; seed += 1) {
      const input = fuzzString(seed);
      expect(() => validateTelegramFileId(input)).not.toThrow();
      const result = validateTelegramFileId(input);
      if (result.ok) {
        expect(input.length).toBeGreaterThan(0);
        expect(input.length).toBeLessThanOrEqual(512);
        expect(/^[A-Za-z0-9_-]+$/.test(input)).toBe(true);
      }
    }
  });

  it("keeps adversarial validation linear-time", () => {
    const started = process.hrtime.bigint();
    for (const input of ADVERSARIAL_STRINGS) {
      validateTelegramCallbackData(input);
      validateTelegramFileId(input);
      validateTelegramChatId(input);
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
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    output += String.fromCharCode(state % 128);
  }
  return output;
}
