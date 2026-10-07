import { expect, it } from "vitest";
import { buildUsageAccounts, usageAccountKey } from "./usage-activity-accounts";
import { usageFixture } from "./usage-activity-fixture";
import { buildLimitAccounts } from "./usage-limits";

it("merges a recorded account across machines, separates ten accounts, and namespaces them by provider", () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    ...usageFixture(), accountKey: `account-${index}`, owner: `Machine ${index}`,
    target: { scope: "remote" as const, instanceId: `machine-${index}` },
  }));
  const sameAccount = { ...rows[0], owner: "Another profile", target: { scope: "local" as const } };
  const otherProvider = { ...rows[0], line: { ...rows[0].line, provider: "xai" } };
  const accounts = buildUsageAccounts([...rows, sameAccount, otherProvider], []);
  expect(accounts).toHaveLength(11);
  expect(accounts.find((account) => account.key === usageAccountKey(rows[0]))?.owners).toEqual(["Another profile", "Machine 0"]);
  expect(usageAccountKey(otherProvider)).not.toBe(usageAccountKey(rows[0]));
});

it("keeps unkeyed history separate even when the owner's current login is known", () => {
  const row = usageFixture();
  const sameLabel = { ...row, target: { scope: "remote" as const, instanceId: "another-instance" } };
  const limits = buildLimitAccounts([{ owner: row.owner, current: { observedAt: 300, accountKey: "new-login", limits: [] } }]);
  const accounts = buildUsageAccounts([row, sameLabel], limits);
  expect(accounts).toHaveLength(3);
  expect(accounts.filter((account) => account.unknown)).toHaveLength(2);
  expect(usageAccountKey(row)).not.toBe(usageAccountKey(sameLabel));
  expect(accounts.find((account) => !account.unknown)?.limitKey).toBe("account:new-login");
});

it("keeps historical accounts on the same instance selectable alongside the current account", () => {
  const row = usageFixture();
  const accounts = buildUsageAccounts([{ ...row, accountKey: "previous" }, { ...row, accountKey: "current" }],
    buildLimitAccounts([{ owner: row.owner, current: { observedAt: 300, accountKey: "current", limits: [] } }]));
  expect(accounts).toHaveLength(2);
  expect(accounts.find((account) => account.key === usageAccountKey({ ...row, accountKey: "previous" }))?.limitKey).toBeUndefined();
  expect(accounts.find((account) => account.key === usageAccountKey({ ...row, accountKey: "current" }))?.limitKey).toBe("account:current");
});

it("names an account by provider and plan, adding machines, then key, only where names collide", () => {
  const keyed = (accountKey: string, owner: string, provider = "openai") => ({
    ...usageFixture(), accountKey, owner, line: { ...usageFixture().line, provider },
    target: { scope: "remote" as const, instanceId: owner },
  });
  const limits = buildLimitAccounts([
    { owner: "Studio Mac", current: { observedAt: 300, accountKey: "work", planType: "pro", limits: [] } },
    { owner: "Build server", current: { observedAt: 300, accountKey: "work", planType: "pro", limits: [] } },
    { owner: "Travel laptop", current: { observedAt: 300, accountKey: "personal", planType: "pro", limits: [] } },
    { owner: "Lab", current: { observedAt: 300, accountKey: "team", planType: "business", limits: [] } },
  ]);
  const labels = (names?: Record<string, string>) => Object.fromEntries(buildUsageAccounts([
    keyed("work", "Studio Mac"), keyed("personal", "Travel laptop"), keyed("same-a", "Spare"), keyed("same-b", "Spare"),
    keyed("grok", "Studio Mac", "xai"), usageFixture(),
    { ...usageFixture(), line: { ...usageFixture().line, provider: "xai" } },
  ], limits, names).map((account) => [account.label, account.detail]));
  expect(labels()).toEqual({
    "OpenAI Business": "Lab",
    "OpenAI Pro · Build server +1": "Build server, Studio Mac",
    "OpenAI Pro · Travel laptop": "",
    "OpenAI · Spare · same-a": "",
    "OpenAI · Spare · same-b": "",
    xAI: "Studio Mac",
    "OpenAI · No account recorded · Local": "Older turns, or a provider that reports no account",
    "xAI · No account recorded · Local": "Older turns, or a provider that reports no account",
  });
  // An operator name wins, its detail regains the provider and plan, and the
  // account it no longer collides with drops back to the short name.
  expect(labels({ "openai:personal": "Personal" })).toMatchObject({
    Personal: "OpenAI Pro · Travel laptop",
    "OpenAI Pro": "Build server, Studio Mac",
  });
  // A name is never lengthened; the derived name it collides with is.
  expect(labels({ "openai:work": "OpenAI Pro" })).toMatchObject({
    "OpenAI Pro": "OpenAI Pro · Build server, Studio Mac",
    "OpenAI Pro · Travel laptop": "",
  });
});
