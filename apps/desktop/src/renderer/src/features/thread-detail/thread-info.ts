import {
  NAVIGATION_QUERY_PROTOCOL_VERSION,
  type AppServerBackendKind,
  type FederationRemoteTarget,
  type NavigationRow,
  type NavigationThreadSummary,
  type ReadThreadFamilyPricingResponse,
  type ThreadExecutionMode,
} from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";

/** What a thread's hover card shows, from a loaded row or an owner's row. */
export type ThreadInfoFacts = {
  title?: string;
  createdAt?: number;
  updatedAt?: number;
  archivedAt?: number;
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

export function threadInfoFacts(row: NavigationThreadSummary | NavigationRow): ThreadInfoFacts {
  const peerStatus = row.federation?.peerStatus;
  return {
    ...(row.title.trim() ? { title: row.title } : {}),
    ...(row.createdAt ? { createdAt: row.createdAt } : {}),
    ...(row.updatedAt ? { updatedAt: row.updatedAt } : {}),
    ...(row.archivedAt ? { archivedAt: row.archivedAt } : {}),
    running: row.threadStatus === "active" || row.hasActiveSubAgent === true,
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

/**
 * One row for a thread the window has not loaded. A local window reads this
 * machine's copy of the owner's rows, which never waits on a peer; a remote
 * window asks its own owner.
 */
export async function readThreadInfoRow(
  api: Pick<DesktopApi, "getNavigationQueryPage">,
  target: ThreadInfoTarget,
  windowTarget: FederationRemoteTarget | undefined,
): Promise<NavigationRow | undefined> {
  if (!api.getNavigationQueryPage) return undefined;
  const page = await api.getNavigationQueryPage(windowTarget
    ? {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "owner", consumer: "mentions",
        federationTarget: windowTarget, pageSize: 1,
        query: { kind: "exact", identities: [{ backend: target.backend, threadId: target.threadId,
          ...(target.instanceId && target.instanceId !== windowTarget.instanceId
            ? { ownerInstanceId: target.instanceId } : {}) }] },
      }
    : {
        protocol: NAVIGATION_QUERY_PROTOCOL_VERSION, inventory: "viewer", consumer: "mentions", pageSize: 1,
        query: { kind: "exact", resolveFromOwners: true, identities: [{ backend: target.backend, threadId: target.threadId,
          ...(target.instanceId ? { ownerInstanceId: target.instanceId } : {}) }] },
      });
  return page.entries.find((entry) => entry.row.id === target.threadId && entry.row.source === target.backend)?.row;
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
  const cost = read({ backend: target.backend, threadId: target.threadId, ...(owner ? { federationTarget: owner } : {}) })
    .then(threadInfoCost, (): ThreadInfoCost => {
      costCache.delete(key);
      return { state: "unavailable" };
    });
  costCache.set(key, { at: now, cost });
  return cost;
}

export function clearThreadInfoCostCache(): void {
  costCache.clear();
}
