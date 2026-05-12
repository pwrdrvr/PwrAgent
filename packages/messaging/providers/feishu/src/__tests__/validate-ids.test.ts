import { describe, expect, it } from "vitest";
import {
  validateFeishuCallbackHandle,
  validateFeishuChatId,
  validateFeishuMessageId,
  validateFeishuOpenId,
  validateFeishuTenantKey,
} from "../validate-ids.ts";

describe("Feishu ID validators", () => {
  it("accepts known Feishu identifier shapes", () => {
    expect(validateFeishuOpenId("ou_123abcABC-_")).toEqual({ ok: true });
    expect(validateFeishuChatId("oc_123abcABC-_")).toEqual({ ok: true });
    expect(validateFeishuMessageId("om_123abcABC-_")).toEqual({ ok: true });
    expect(validateFeishuTenantKey("tenant_123ABC")).toEqual({ ok: true });
    expect(validateFeishuCallbackHandle("feishu:abcDEF123-_abcDEFx")).toEqual({
      ok: true,
    });
  });

  it("rejects malformed values without complex regexes", () => {
    expect(validateFeishuOpenId("oc_123")).toEqual({ ok: false, reason: "format" });
    expect(validateFeishuChatId("oc_")).toEqual({ ok: false, reason: "format" });
    expect(validateFeishuTenantKey("tenant key")).toEqual({
      ok: false,
      reason: "format",
    });
    expect(validateFeishuCallbackHandle("feishu:short")).toEqual({
      ok: false,
      reason: "length",
    });
  });
});
