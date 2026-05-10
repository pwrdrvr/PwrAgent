import { describe, expect, it } from "vitest";
import {
  validateDiscordSnowflake,
  validateLineGroupId,
  validateLineRoomId,
  validateLineUserId,
  validateMattermostId,
  validateTelegramGroupChatId,
  validateTelegramPositiveId,
  validateTelegramSupergroupId,
} from "../messaging-id-validation";

describe("messaging ID validators", () => {
  it("accepts known-good settings identifiers", () => {
    expect(validateTelegramPositiveId("8460800771")).toEqual({ ok: true });
    expect(validateTelegramGroupChatId("-3841603622")).toEqual({ ok: true });
    expect(validateTelegramSupergroupId("-1003841603622")).toEqual({ ok: true });
    expect(validateDiscordSnowflake("1177378744822943744")).toEqual({
      ok: true,
    });
    expect(validateDiscordSnowflake("1480554271907905731")).toEqual({
      ok: true,
    });
    expect(validateMattermostId("abcdefghijklmnopqrstu12345")).toEqual({
      ok: true,
    });
    expect(validateLineUserId("U0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
    expect(validateLineGroupId("C0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
    expect(validateLineRoomId("R0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
  });

  it("rejects username confusions and mixed-shape values", () => {
    for (const value of ["@huntharo", "huntharo", " 8460800771", "8460800771 "]) {
      expect(validateTelegramPositiveId(value).ok).toBe(false);
    }
    expect(validateTelegramSupergroupId("8460800771").ok).toBe(false);
    expect(validateTelegramSupergroupId("-3841603622").ok).toBe(false);
    expect(validateTelegramGroupChatId("8460800771").ok).toBe(false);
    expect(validateDiscordSnowflake("@huntharo").ok).toBe(false);
    expect(validateDiscordSnowflake("8460800771").ok).toBe(false);
    expect(validateMattermostId("UserName").ok).toBe(false);
    expect(validateMattermostId("abcdefghijklmnopqrstu1234").ok).toBe(false);
    expect(validateLineUserId("U0123456789ABCDEF0123456789ABCDEF").ok).toBe(false);
    expect(validateLineGroupId("U0123456789abcdef0123456789abcdef").ok).toBe(false);
    expect(validateLineRoomId("R0123456789abcdef0123456789abcde").ok).toBe(false);
  });
});
