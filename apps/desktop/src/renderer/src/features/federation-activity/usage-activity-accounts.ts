import type { OwnedUsageRow } from "./usage-activity-summary";
import type { LimitAccount } from "./usage-limits";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", xai: "xAI", anthropic: "Anthropic", google: "Google", moonshot: "Moonshot", qwen: "Qwen",
};

export const usageProviderLabel = (provider: string) => PROVIDER_LABELS[provider] ?? provider;

export type UsageAccount = {
  key: string;
  label: string;
  owners: string[];
  /** The corresponding Codex account-limit series, when available. */
  limitKey?: string;
  unknown: boolean;
};

/** Unknown accounts stay on their owner; a profile's current login proves no historical attribution. */
export function usageAccountKey(row: OwnedUsageRow): string {
  const owner = row.target.scope === "local" ? "local" : row.target.instanceId;
  return JSON.stringify([row.line.provider, row.accountKey ? ["account", row.accountKey] : ["owner", owner]]);
}

/** Limit observations currently describe Codex only; keyless limits prove no row attribution. */
export function limitUsageAccountKey(limit: LimitAccount): string | undefined {
  return limit.key.startsWith("account:")
    ? JSON.stringify(["openai", ["account", limit.key.slice("account:".length)]]) : undefined;
}

/** Build choices from deduplicated ledger rows and known Codex limit accounts, including accounts with no turns. */
export function buildUsageAccounts(rows: OwnedUsageRow[], limits: LimitAccount[]): UsageAccount[] {
  const accounts = new Map<string, { provider: string; accountKey?: string; owners: Set<string>; limitKey?: string }>();
  for (const row of rows) {
    const key = usageAccountKey(row);
    let account = accounts.get(key);
    if (!account) accounts.set(key, account = { provider: row.line.provider, accountKey: row.accountKey, owners: new Set() });
    account.owners.add(row.owner);
  }
  for (const limit of limits) {
    // Limit observations currently describe Codex only. A keyless reading
    // cannot identify the account behind any historical row.
    const key = limitUsageAccountKey(limit);
    if (!key) continue;
    const accountKey = limit.key.slice("account:".length);
    let account = accounts.get(key);
    if (!account) accounts.set(key, account = { provider: "openai", accountKey, owners: new Set() });
    account.limitKey = limit.key;
    for (const owner of limit.owners) account.owners.add(owner);
  }
  return [...accounts].map(([key, account]) => {
    const owners = [...account.owners].sort();
    const name = account.accountKey ? `Account ${account.accountKey.slice(0, 8)}` : "Unknown account";
    return { key, label: `${usageProviderLabel(account.provider)} · ${name} · ${owners.join(", ")}`,
      owners, limitKey: account.limitKey, unknown: !account.accountKey };
  }).sort((a, b) => a.label.localeCompare(b.label));
}
