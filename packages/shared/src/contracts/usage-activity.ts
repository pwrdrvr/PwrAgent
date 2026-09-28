import type { FederationTarget } from "./federation";
import type { AppServerBackendKind } from "./normalized-app-server";
import type { BackendRateLimitSummary } from "./backend";
import type { ThreadUsageLineRecord } from "../token-usage-pricing";

export type ReadUsageActivityRequest = {
  from: number;
  to: number;
  federationTarget?: FederationTarget;
};

export type UsageActivityRow = {
  line: ThreadUsageLineRecord;
  title: string;
  updatedAt: number;
};

export type ReadUsageActivityResponse = {
  rows: UsageActivityRow[];
  truncated: boolean;
  readAt: number;
  rateLimits: BackendRateLimitSummary[];
};

export type AnalyzeUsageActivityRequest = {
  backend: AppServerBackendKind;
  threadId: string;
  model: string;
  /** One recent protocol page; the server also enforces these bounds. */
  entryLimit: number;
  characterLimit: number;
  federationTarget?: FederationTarget;
};

export type AnalyzeUsageActivityResponse = {
  analysis: string;
  model: string;
  entries: number;
  characters: number;
  hasEarlierHistory: boolean;
  truncated: boolean;
};

export function validateUsageActivityWindow(request: ReadUsageActivityRequest): void {
  if (!Number.isFinite(request.from) || !Number.isFinite(request.to)
    || request.from >= request.to || request.to - request.from > 31 * 86_400_000) {
    throw new Error("Select a usage window of at most 31 days.");
  }
}

/** Never add cumulative snapshots, inherited context, or unattributed history. */
export function usageActivityCoverage(row: UsageActivityRow, from: number, to: number): "contained" | "boundary" | "unattributed" {
  const line = row.line;
  if (line.status === "superseded"
    || (line.scope !== "turn" && line.scope !== "monitor")
    || (line.scope === "turn" && line.turnUsageAttributed !== true)
    || line.turnUsageAttributed === false) return "unattributed";
  const start = line.startedAt ?? line.createdAt;
  return start >= from && start < to && line.completedAt !== undefined
    && line.completedAt >= start && line.completedAt < to ? "contained" : "boundary";
}

/** Shared profiles and relayed peers may expose the same durable ledger row. */
export function usageActivityIdentity(row: UsageActivityRow): string {
  // A helper may be recorded both as a parent's monitor and as the helper
  // thread's own live turn, including on a second instance. Those are two
  // views of the same provider turn, not two charges. Monitor backend labels
  // describe the parent, so use the provider's thread/turn identity here.
  if (row.line.status !== "superseded" && row.line.turnId && (row.line.scope === "monitor"
    || (row.line.scope === "turn" && row.line.turnUsageAttributed === true))) {
    return JSON.stringify([row.line.provider, row.line.threadId, row.line.turnId]);
  }
  return JSON.stringify([row.line.backend, row.line.threadId, row.line.usageLineId]);
}
