import { describe, expect, it } from "vitest";
import { usageAccountKey } from "../usage-account-identity";

describe("usage account identity", () => {
  it("distinguishes provider workspaces sharing an email and survives email changes", () => {
    const account = { type: "chatgpt" as const, accountId: "workspace-a", email: "test@example.test" };
    const key = usageAccountKey(account);
    expect(key).toBe(usageAccountKey({ ...account, email: "changed@example.test" }));
    expect(key).not.toBe(usageAccountKey({ ...account, accountId: "workspace-b" }));
    expect(key).toMatch(/^[a-f0-9]{32}$/);
  });

  it("matches explicit groups across profiles without using credentials or generic labels", () => {
    expect(usageAccountKey({ type: "apiKey" }, " team-account "))
      .toBe(usageAccountKey(undefined, "team-account"));
    expect(usageAccountKey(undefined, "team-account"))
      .not.toBe(usageAccountKey(undefined, "personal-account"));
    expect(usageAccountKey({ type: "provider", label: "Grok account" })).toBeUndefined();
    expect(usageAccountKey({ type: "apiKey" })).toBeUndefined();
  });
});
