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
