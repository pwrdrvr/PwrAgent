import type { OwnedUsageRow } from "./usage-activity-summary";
import type { LimitAccount } from "./usage-limits";
import { formatBackendPlanType } from "../../lib/backend-status-format";

const PROVIDER_LABELS: Record<string, string> = {
  openai: "OpenAI", xai: "xAI", anthropic: "Anthropic", google: "Google", moonshot: "Moonshot", qwen: "Qwen",
};

export const usageProviderLabel = (provider: string) => PROVIDER_LABELS[provider] ?? provider;

export type UsageAccount = {
  key: string;
  /** What every surface calls the account: the operator's name, else a name derived below. */
  label: string;
  /** What the label leaves out: provider and plan for a named account, and its machines. */
  detail: string;
  owners: string[];
  /** The corresponding Codex account-limit series, when available. */
  limitKey?: string;
  unknown: boolean;
  /** Where an operator name is stored (`provider:accountKey`). Absent for unknown accounts. */
  nameKey?: string;
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

/**
 * Build choices from deduplicated ledger rows and known Codex limit accounts,
 * including accounts with no turns.
 *
 * One rule names an account everywhere: the operator's name for it, else the
 * provider and plan. Accounts that would share a name add their first machine
 * and a count, then the start of the opaque key. Unknown rows are named by the
 * machine that recorded them, and by provider only when that collides.
 */
export function buildUsageAccounts(rows: OwnedUsageRow[], limits: LimitAccount[],
  names: Record<string, string> = {}): UsageAccount[] {
  const accounts = new Map<string, { provider: string; accountKey?: string; owners: Set<string>; limitKey?: string; plan?: string }>();
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
    account.plan ??= limit.planType ? formatBackendPlanType({ kind: "codex" }, limit.planType) : undefined;
    for (const owner of limit.owners) account.owners.add(owner);
  }
  const built = [...accounts].map(([key, account]) => {
    const owners = [...account.owners].sort();
    const provider = usageProviderLabel(account.provider);
    const nameKey = account.accountKey ? `${account.provider}:${account.accountKey}` : undefined;
    const name = nameKey ? names[nameKey] : undefined;
    const base = account.plan ? `${provider} ${account.plan}` : provider;
    const machines = owners.length > 1 ? `${owners[0]} +${owners.length - 1}` : owners[0] ?? "";
    const candidates = name ? [name]
      : account.accountKey
        ? [base, `${base} · ${machines}`, `${base} · ${machines} · ${account.accountKey.slice(0, 4)}`,
          `${base} · ${machines} · ${account.accountKey.slice(0, 8)}`]
        : [`No account recorded · ${owners.join(", ")}`, `${provider} · No account recorded · ${owners.join(", ")}`];
    return { key, owners, limitKey: account.limitKey, unknown: !account.accountKey, nameKey, candidates, level: 0,
      named: Boolean(name), base,
      detail: !account.accountKey ? "Older turns, or a provider that reports no account" : owners.join(", ") };
  });
  // Lengthen only the names that collide, until none do or none can grow.
  for (let changed = true; changed;) {
    changed = false;
    const counts = new Map<string, number>();
    for (const account of built) counts.set(account.candidates[account.level], (counts.get(account.candidates[account.level]) ?? 0) + 1);
    for (const account of built) {
      if (counts.get(account.candidates[account.level])! > 1 && account.level < account.candidates.length - 1) {
        account.level += 1;
        changed = true;
      }
    }
  }
  // A derived name already leads with the provider and plan, and a lengthened
  // one names a lone machine; the detail repeats neither.
  return built.map(({ candidates, level, named, base, detail, ...account }) => ({ ...account, label: candidates[level],
    detail: named ? `${base} · ${detail}` : !account.unknown && level > 0 && account.owners.length === 1 ? "" : detail }))
    .sort((a, b) => Number(a.unknown) - Number(b.unknown) || a.label.localeCompare(b.label));
}
