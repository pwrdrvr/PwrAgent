import { describe, expect, it } from "vitest";
import {
  validateDiscordAttachmentUrl,
  validateDiscordCustomId,
  validateDiscordInteractionToken,
  validateDiscordSnowflake,
} from "../validate-ids.ts";

const ADVERSARIAL_STRINGS = [
  "",
  "a".repeat(1_000_000),
  "123\u0000456",
  "123\r\n456",
  "\u001b[31m123\u001b[0m",
  "123\u202e456",
  "１２３４５６",
  "a".repeat(8192) + "!",
];

describe("Discord identifier validators", () => {
  it("accepts known-good identifiers", () => {
    expect(validateDiscordSnowflake("1480556454498009352")).toEqual({ ok: true });
    expect(validateDiscordCustomId("dc:abcdefghijklmnopqrstuvwx")).toEqual({
      ok: true,
    });
    expect(validateDiscordInteractionToken("abc.DEF_123-456")).toEqual({
      ok: true,
    });
    expect(
      validateDiscordAttachmentUrl(
        "https://cdn.discordapp.com/attachments/1480556454498009352/file.png",
      ),
    ).toEqual({ ok: true });
  });

  it("rejects adversarial malformed identifiers without throwing", () => {
    for (const input of ADVERSARIAL_STRINGS) {
      expect(() => validateDiscordSnowflake(input)).not.toThrow();
      expect(validateDiscordSnowflake(input).ok).toBe(false);
      expect(() => validateDiscordCustomId(input)).not.toThrow();
      expect(validateDiscordCustomId(input).ok).toBe(false);
      expect(() => validateDiscordInteractionToken(input)).not.toThrow();
      expect(validateDiscordInteractionToken(input).ok).toBe(false);
    }
  });

  it("fuzzes arbitrary strings without accepting non-snowflakes", () => {
    for (let seed = 0; seed < 20_000; seed += 1) {
      const input = fuzzString(seed);
      expect(() => validateDiscordSnowflake(input)).not.toThrow();
      const result = validateDiscordSnowflake(input);
      if (result.ok) {
        expect(input).toMatch(/^[0-9]{17,19}$/);
      }
    }
  });

  it("rejects attachment URLs outside Discord media hosts", () => {
    expect(validateDiscordAttachmentUrl("https://example.com/file.png").ok).toBe(false);
    expect(validateDiscordAttachmentUrl("http://cdn.discordapp.com/file.png").ok).toBe(false);
  });

  it("keeps adversarial validation linear-time", () => {
    const started = process.hrtime.bigint();
    for (const input of ADVERSARIAL_STRINGS) {
      validateDiscordSnowflake(input);
      validateDiscordCustomId(input);
      validateDiscordInteractionToken(input);
      validateDiscordAttachmentUrl(input);
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
    state = (state * 1664525 + 1013904223) >>> 0;
    output += String.fromCharCode(state % 128);
  }
  return output;
}
