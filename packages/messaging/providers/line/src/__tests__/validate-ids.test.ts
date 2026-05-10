import { describe, expect, it } from "vitest";
import {
  validateLineCallbackHandle,
  validateLineGroupId,
  validateLineRoomId,
  validateLineUserId,
} from "../validate-ids.ts";

describe("LINE identifier validation", () => {
  it("accepts LINE user, group, room, and callback handle shapes", () => {
    expect(validateLineUserId("U0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
    expect(validateLineGroupId("C0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
    expect(validateLineRoomId("R0123456789abcdef0123456789abcdef")).toEqual({
      ok: true,
    });
    expect(validateLineCallbackHandle("line:abcDEF012_-xyz789A")).toEqual({ ok: true });
  });

  it("rejects malformed LINE IDs", () => {
    expect(validateLineUserId("U0123456789ABCDEF0123456789ABCDEF").ok).toBe(false);
    expect(validateLineGroupId("U0123456789abcdef0123456789abcdef").ok).toBe(false);
    expect(validateLineRoomId("R0123456789abcdef0123456789abcde").ok).toBe(false);
    expect(validateLineCallbackHandle("line:abcDEF012_-").ok).toBe(false);
    expect(validateLineCallbackHandle("line:bad/slash").ok).toBe(false);
  });

  it("keeps adversarial validation linear-time", () => {
    const value = `U${"a".repeat(100_000)}`;
    expect(validateLineUserId(value)).toEqual({ ok: false, reason: "length" });
  });
});
