import { usageActivityCoverage, usageActivityIdentity, type FederationTarget, type UsageActivityRow } from "@pwragent/shared";

export type OwnedUsageRow = UsageActivityRow & { owner: string; target: FederationTarget };

export type UsageGroup = {
  key: string;
  title: string;
  /** Every contained row counted here, the thread's own and its helpers'. */
  rows: OwnedUsageRow[];
  /** Rows that belong to helper threads rolled up into this one. */
  helperRows: OwnedUsageRow[];
  helperThreads: number;
  helperCost: number;
  cost: number;
  unpriced: number;
  uncached: number;
  cached: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  /** Cold replays observed on the thread's own turns; absent when none were watched. */
  coldReplays?: number;
  /** Largest observed request context as a share of the model's window. */
  peakContextShare?: number;
  fastMode: boolean;
};

/** Ledger rows describe their owner as `backend` + `threadId`. */
const threadKey = (backend: string, threadId: string) => JSON.stringify([backend, threadId]);
const priced = (row: OwnedUsageRow) => row.line.priceStatus === "priced" && row.line.currency === "USD";

export function summarizeUsageActivity(rows: OwnedUsageRow[], from: number, to: number) {
  // A newer peer splits a helper bucket by account. An older peer reports
  // the same ledger bucket as one sum. Select one whole representation before
  // deduplication: prefer the split view unless the old sum is more recent.
  const splitBuckets = new Map<string, number>();
  const legacyBuckets = new Map<string, number>();
  for (const row of rows) {
    if (!row.rollup) continue;
    const buckets = row.rollup.groupKey ? splitBuckets : legacyBuckets;
    const key = JSON.stringify([row.line.backend, row.rollup.groupKey ?? row.line.usageLineId]);
    buckets.set(key, Math.max(buckets.get(key) ?? 0, row.updatedAt));
  }
  const unique = new Map<string, OwnedUsageRow>();
  for (const row of rows) {
    if (row.rollup) {
      const key = JSON.stringify([row.line.backend, row.rollup.groupKey ?? row.line.usageLineId]);
      const splitAt = splitBuckets.get(key);
      const legacyAt = legacyBuckets.get(key);
      if (splitAt !== undefined && legacyAt !== undefined
        && (row.rollup.groupKey ? legacyAt > splitAt : legacyAt <= splitAt)) continue;
    }
    const key = usageActivityIdentity(row);
    const existing = unique.get(key);
    if (!existing) { unique.set(key, row); continue; }
    const authoritative = row.line.scope === "turn" && row.line.turnUsageAttributed === true;
    const existingAuthoritative = existing.line.scope === "turn" && existing.line.turnUsageAttributed === true;
    const replace = (authoritative && !existingAuthoritative)
      || (authoritative === existingAuthoritative && row.updatedAt > existing.updatedAt);
    const preferred = replace ? row : existing;
    // Older peers omit account identity even for the same durable turn. Keep
    // any recorded key while preserving the authoritative/newest copy's usage
    // and routing fields. Neither peer's current login proves attribution.
    const accountKey = preferred.accountKey ?? (replace ? existing.accountKey : row.accountKey);
    unique.set(key, accountKey === preferred.accountKey ? preferred : { ...preferred, accountKey });
  }
  const contained: OwnedUsageRow[] = [];
  let boundary = 0;
  let unattributed = 0;
  for (const row of unique.values()) {
    const coverage = usageActivityCoverage(row, from, to);
    if (coverage === "contained") contained.push(row);
    else if (coverage === "boundary") boundary += 1;
    else unattributed += 1;
  }
  // A helper's rows name its parent. Roll each helper up to the outermost
  // ancestor present in the window; a helper whose parent spent nothing here
  // keeps its own row.
  const parents = new Map<string, string>();
  const present = new Set(contained.map((row) => threadKey(row.line.backend, row.line.threadId)));
  for (const row of contained) {
    const parentThreadId = row.line.parentThreadId;
    if (!parentThreadId || parentThreadId === row.line.threadId) continue;
    const parent = threadKey(row.line.backend, parentThreadId);
    if (present.has(parent)) parents.set(threadKey(row.line.backend, row.line.threadId), parent);
  }
  const rootOf = (key: string) => {
    let current = key;
    for (let depth = 0; depth < 8 && parents.has(current); depth += 1) current = parents.get(current)!;
    return current;
  };
  const groups = new Map<string, UsageGroup & { helperKeys: Set<string>; titleRow?: OwnedUsageRow }>();
  for (const row of contained) {
    const line = row.line;
    const own = threadKey(line.backend, line.threadId);
    const key = rootOf(own);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: row.title, rows: [], helperRows: [], helperThreads: 0, helperCost: 0, cost: 0, unpriced: 0,
        uncached: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0, fastMode: false, helperKeys: new Set() };
      groups.set(key, group);
    }
    group.rows.push(row);
    if (own === key) {
      group.titleRow ??= row;
      if (line.observedColdReplayCount !== undefined) group.coldReplays = (group.coldReplays ?? 0) + line.observedColdReplayCount;
      if (line.peakContextTokens !== undefined && line.modelContextWindow) {
        group.peakContextShare = Math.max(group.peakContextShare ?? 0, line.peakContextTokens / line.modelContextWindow);
      }
    } else {
      group.helperRows.push(row);
      group.helperKeys.add(own);
      if (priced(row)) group.helperCost += line.totalCostMicros;
    }
    if (line.fastMode) group.fastMode = true;
    if (priced(row)) group.cost += line.totalCostMicros;
    else group.unpriced += 1;
    group.uncached += line.uncachedInputTokens;
    group.cached += line.cachedInputTokens;
    group.cacheWrite += line.cacheWriteInputTokens ?? 0;
    group.output += line.outputTokens;
    group.reasoning += line.reasoningOutputTokens;
  }
  const summaries: UsageGroup[] = [...groups.values()].map(({ helperKeys, titleRow, ...group }) => ({
    ...group,
    title: titleRow?.title ?? group.title,
    helperThreads: helperKeys.size,
    // The thread's own rows lead, so `rows[0]` names the thread and its owner.
    rows: titleRow ? [titleRow, ...group.rows.filter((row) => row !== titleRow)] : group.rows,
  }));
  return { groups: summaries.sort((a, b) => b.cost - a.cost), boundary, unattributed,
    duplicates: rows.length - unique.size, contained: contained.length,
    rows: [...unique.values()],
    excluded: [...unique.values()].filter((row) => usageActivityCoverage(row, from, to) !== "contained")
      .sort((a, b) => b.line.totalCostMicros - a.line.totalCostMicros) };
}
