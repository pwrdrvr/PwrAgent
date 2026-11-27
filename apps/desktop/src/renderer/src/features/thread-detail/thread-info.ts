import {
  type AppServerBackendKind,
  type ThreadExecutionMode,
} from "@pwragent/shared/contracts/normalized-app-server";
import { type FederationRemoteTarget } from "@pwragent/shared/contracts/federation";
import { type ReadThreadFamilyPricingResponse } from "@pwragent/shared/thread-family-pricing";
import type { DesktopApi } from "../../lib/desktop-api";
import type { ThreadLinkRow } from "../../lib/thread-link-rows";
import {
  buildPullRequestStatusKey,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import { getThreadNamedBranch, getThreadPrimaryDirectory } from "../../lib/subthread-launchpads";
import { resolvePrOverflow } from "../pr-status/pr-rollup";
export { readThreadInfoRow } from "../../lib/thread-link-rows";

/** What a thread's hover card shows, from a loaded row or an owner's row. */
export type ThreadInfoFacts = {
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  archived: boolean;
  running: boolean;
  subAgentWorking: boolean;
  gitBranch?: string;
  executionMode?: ThreadExecutionMode;
  model?: string;
  reasoningEffort?: string;
  /** The owner's last known rows, while the owner cannot be reached. */
  ownerOffline: boolean;
};

export type ThreadInfoCost =
  | { state: "loading" }
  | { state: "unavailable" }
  | {
      state: "ready";
      ownMicros: number;
      totalMicros: number;
      subThreadCount: number;
      /** An unpriced or unreachable member makes the total a floor. */
      partial: boolean;
    };

export type ThreadInfoTarget = {
  backend: AppServerBackendKind;
  threadId: string;
  instanceId?: string;
};

const OFFLINE_PEER_STATES = new Set(["disabled", "rejected", "revoked", "disconnected"]);

export function threadInfoFacts(row: ThreadLinkRow): ThreadInfoFacts {
  const peerStatus = row.federation?.peerStatus;
  return {
    ...(row.title.trim() ? { title: row.title } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    archived: row.archiveIdentity ? row.archiveIdentity === "archived" : Boolean(row.archivedAt),
    running: row.threadStatus === "active"
      || row.hasActiveSubAgent === true
      || row.hasBackgroundTasks === true,
    subAgentWorking: row.hasActiveSubAgent === true,
    ...(row.gitBranch ? { gitBranch: row.gitBranch } : {}),
    ...(row.executionMode ? { executionMode: row.executionMode } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    ownerOffline: peerStatus !== undefined && OFFLINE_PEER_STATES.has(peerStatus),
  };
}

export function threadInfoCost(family: ReadThreadFamilyPricingResponse): ThreadInfoCost {
  const self = family.members.find((member) => member.self);
  if (!self || self.unavailable) return { state: "unavailable" };
  const totalMicros = family.members.reduce((sum, member) => sum + member.totalCostMicros, 0);
  return {
    state: "ready",
    ownMicros: self.totalCostMicros,
    totalMicros,
    subThreadCount: family.members.length - 1,
    partial: family.members.some((member) => member.unavailable || member.unpricedUsageLineCount > 0),
  };
}

/**
 * Where a read about this thread goes. A link without an owner names a
 * thread of the instance this window serves, which in a remote window is
 * that window's peer.
 */
export function threadInfoOwner(
  target: ThreadInfoTarget,
  windowTarget: FederationRemoteTarget | undefined,
): FederationRemoteTarget | undefined {
  return target.instanceId ? { scope: "remote", instanceId: target.instanceId } : windowTarget;
}

const COST_TTL_MS = 30_000;
const costCache = new Map<string, { at: number; cost: Promise<ThreadInfoCost> }>();

/** One stored-totals read per thread at most every 30 seconds. */
export function readThreadInfoCost(
  api: Pick<DesktopApi, "readThreadFamilyPricing">,
  target: ThreadInfoTarget,
  owner: FederationRemoteTarget | undefined,
  now = Date.now(),
): Promise<ThreadInfoCost> {
  const read = api.readThreadFamilyPricing;
  if (!read) return Promise.resolve({ state: "unavailable" });
  const key = `${owner?.instanceId ?? "local"}:${target.backend}:${target.threadId}`;
  const cached = costCache.get(key);
  if (cached && now - cached.at < COST_TTL_MS) return cached.cost;
  for (const [entryKey, entry] of costCache) {
    if (now - entry.at >= COST_TTL_MS) costCache.delete(entryKey);
  }
  const cost: Promise<ThreadInfoCost> = read({
    backend: target.backend, threadId: target.threadId, ...(owner ? { federationTarget: owner } : {}),
  }).then(threadInfoCost, (): ThreadInfoCost => {
    // A newer read may have replaced this one; keep that entry.
    if (costCache.get(key)?.cost === cost) costCache.delete(key);
    return { state: "unavailable" };
  });
  costCache.set(key, { at: now, cost });
  return cost;
}

export function clearThreadInfoCostCache(): void {
  costCache.clear();
}

/**
 * What a sidebar row's card shows beyond a chip's card: the row's own
 * folders, machine, branch, Git state, lead PR and model, as icon rows.
 * Everything comes from the navigation row the sidebar already holds; the
 * context bar only from the open thread, which is the only one with a
 * reading today.
 */
export type ThreadInfoRowFacts = {
  backendLabel: string;
  folders: readonly { label: string; path: string; kind: "local" | "worktree" }[];
  machine: { label: string; local: boolean };
  branch?: { name: string; kind: "local" | "worktree" };
  ahead?: { count: number; base?: string };
  dirty?: { additions: number; deletions: number };
  pr?: { pr: PrSummary; more: number };
  model?: string;
  context?: ThreadInfoContext;
};

export type ThreadInfoContext = {
  totalTokens: number;
  modelContextWindow: number;
  usedPercent: number;
};

export function threadInfoRowFacts(
  thread: NavigationThreadSummary,
  options: {
    backendLabel: string;
    machine: ThreadInfoRowFacts["machine"];
    context?: ThreadInfoContext;
  },
): ThreadInfoRowFacts {
  const primary = getThreadPrimaryDirectory(thread);
  const folders = primary
    ? [primary, ...thread.linkedDirectories.filter((directory) => directory !== primary)]
    : [];
  const branchName = getThreadNamedBranch(thread);
  const git = thread.gitWorkingState;
  const ahead = git?.baseAheadCommitCount ?? 0;
  const prs = thread.prs ?? [];
  const lead = (thread.stackLeadPrKey
    ? prs.find((pr) => buildPullRequestStatusKey(pr) === thread.stackLeadPrKey)
    : undefined) ?? resolvePrOverflow(prs)?.lead ?? prs[0];
  const model = thread.model
    ? [thread.model, thread.reasoningEffort, thread.fastMode ? "Fast" : undefined].filter(Boolean).join(" · ")
    : undefined;
  return {
    backendLabel: options.backendLabel,
    folders: folders.map((directory) => ({
      label: directory.label,
      path: directory.worktreePath ?? directory.path,
      kind: directory.kind,
    })),
    machine: options.machine,
    ...(branchName ? { branch: { name: branchName, kind: primary?.kind ?? "local" } } : {}),
    ...(ahead > 0 ? { ahead: { count: ahead, ...(git?.baseBranch ? { base: git.baseBranch } : {}) } } : {}),
    ...(git && (git.dirtyAdditions > 0 || git.dirtyDeletions > 0)
      ? { dirty: { additions: git.dirtyAdditions, deletions: git.dirtyDeletions } }
      : {}),
    ...(lead ? { pr: { pr: lead, more: prs.length - 1 } } : {}),
    ...(model ? { model } : {}),
    ...(options.context && options.context.modelContextWindow > 0 ? { context: options.context } : {}),
  };
}

/** Token counts at card density: 212k, 1.2M. */
export function formatCompactTokens(value: number): string {
  // 999,600 rounds to a thousand thousands: that is 1M, not 1000k.
  if (value >= 999_500) return `${Math.round(value / 100_000) / 10}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}
