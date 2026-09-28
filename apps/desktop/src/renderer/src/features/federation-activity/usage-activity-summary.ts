import { usageActivityCoverage, usageActivityIdentity, type FederationTarget, type UsageActivityRow } from "@pwragent/shared";

export type OwnedUsageRow = UsageActivityRow & { owner: string; target: FederationTarget };

export function summarizeUsageActivity(rows: OwnedUsageRow[], from: number, to: number) {
  const unique = new Map<string, OwnedUsageRow>();
  for (const row of rows) {
    const key = usageActivityIdentity(row);
    const existing = unique.get(key);
    const authoritative = row.line.scope === "turn" && row.line.turnUsageAttributed === true;
    const existingAuthoritative = existing?.line.scope === "turn" && existing.line.turnUsageAttributed === true;
    if (!existing || (authoritative && !existingAuthoritative)
      || (authoritative === existingAuthoritative && row.updatedAt > existing.updatedAt)) unique.set(key, row);
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
  const groups = new Map<string, { key: string; title: string; rows: OwnedUsageRow[]; cost: number; unpriced: number;
    uncached: number; cached: number; cacheWrite: number; output: number; reasoning: number }>();
  for (const row of contained) {
    const line = row.line;
    const key = JSON.stringify([line.backend, line.threadId]);
    let group = groups.get(key);
    if (!group) {
      group = { key, title: row.title, rows: [], cost: 0, unpriced: 0, uncached: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    if (line.priceStatus === "priced" && line.currency === "USD") group.cost += line.totalCostMicros;
    else group.unpriced += 1;
    group.uncached += line.uncachedInputTokens;
    group.cached += line.cachedInputTokens;
    group.cacheWrite += line.cacheWriteInputTokens ?? 0;
    group.output += line.outputTokens;
    group.reasoning += line.reasoningOutputTokens;
  }
  return { groups: [...groups.values()].sort((a, b) => b.cost - a.cost), boundary, unattributed,
    duplicates: rows.length - unique.size, contained: contained.length,
    rows: [...unique.values()],
    excluded: [...unique.values()].filter((row) => usageActivityCoverage(row, from, to) !== "contained")
      .sort((a, b) => b.line.totalCostMicros - a.line.totalCostMicros) };
}
