import { buildFederatedThreadRef } from "@pwragent/shared";
import type { FederationTarget, NavigationSelectedDetailResponse, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { applyNavigationSelectedDetail, selectNavigationIdentity } from "./navigation-query-state";

class NavigationActionIdentityError extends Error {
  constructor(readonly identity: NavigationSelectedDetailResponse["identity"]) {
    super(`Thread configuration is ${identity}. Refresh the thread before performing this action.`);
  }
}

/** Read action authority from the explicit owner; collection rows only identify the target. */
export async function readNavigationActionDetail(params: {
  api?: Pick<DesktopApi, "getNavigationSelectedDetail">;
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">;
  target?: FederationTarget;
  signal?: AbortSignal;
  includeWorkspaceConfiguration?: boolean;
}): Promise<NavigationSelectedDetailResponse & { thread: NavigationThreadSummary }> {
  params.signal?.throwIfAborted();
  if (!params.api?.getNavigationSelectedDetail) {
    throw new Error("Upgrade this instance to load authoritative thread configuration before performing this action.");
  }
  const target = params.thread.federation?.ref.target ?? params.target;
  const ref = { backend: params.thread.source, threadId: params.thread.id,
    ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}),
  };
  const started = selectNavigationIdentity(undefined, ref);
  const detail = await params.api.getNavigationSelectedDetail({ protocol: 2, ref, federationTarget: target,
    ...(params.includeWorkspaceConfiguration ? { includeWorkspaceConfiguration: true, probeWorkingStates: true } : {}) });
  params.signal?.throwIfAborted();
  const state = applyNavigationSelectedDetail({ state: started, sequence: started.pendingSequence, detail });
  if (detail.readiness === "ready" && detail.identity !== "present") throw new NavigationActionIdentityError(detail.identity);
  if (detail.thread?.archivedAt !== undefined) throw new NavigationActionIdentityError("archived");
  if (state.readiness !== "ready" || detail.identity !== "present" || !detail.thread) {
    throw new Error(`Thread configuration is ${detail.identity === "present" ? "not ready" : detail.identity}. Refresh the thread before performing this action.`);
  }
  const returnedOwner = detail.thread.federation?.ref.target;
  if (returnedOwner?.scope === "remote" && (target?.scope !== "remote" || returnedOwner.instanceId !== target.instanceId)) {
    throw new Error("Thread configuration belongs to a different owner.");
  }
  if (params.includeWorkspaceConfiguration && !detail.workspaceDirectories) {
    throw new Error("Upgrade the owning instance to load exact workspace configuration before performing this action.");
  }
  const thread = target?.scope === "remote" ? { ...detail.thread, federation: {
    ...detail.thread.federation,
    instanceLabel: detail.thread.federation?.instanceLabel ?? params.thread.federation?.instanceLabel ?? target.instanceId,
    ref: buildFederatedThreadRef({ backend: ref.backend, threadId: ref.threadId, instanceId: target.instanceId }),
  } } : detail.thread;
  return { ...detail, thread };
}

export async function readNavigationActionThread(params: Parameters<typeof readNavigationActionDetail>[0]): Promise<NavigationThreadSummary> {
  return (await readNavigationActionDetail(params)).thread;
}

/** Resolve ancestors by owner identity; unloaded rows never make a child a root. */
export async function resolveNavigationActionGroupRoot(params: {
  api?: Pick<DesktopApi, "getNavigationSelectedDetail">;
  thread: NavigationThreadSummary;
  target?: FederationTarget;
  signal?: AbortSignal;
}): Promise<NavigationThreadSummary> {
  let current = params.thread;
  const visited = new Set<string>();
  for (let depth = 0; depth < 32; depth += 1) {
    if (!current.parentThreadId) return current;
    const target = current.parentThreadInstanceId
      ? { scope: "remote" as const, instanceId: current.parentThreadInstanceId }
      : current.federation?.ref.target ?? params.target;
    const source = current.parentThreadBackend ?? current.source;
    const key = JSON.stringify([target?.scope === "remote" ? target.instanceId : null, source, current.parentThreadId]);
    if (visited.has(key)) throw new Error("The owning instance reported a cycle in thread grouping.");
    visited.add(key);
    try {
      current = await readNavigationActionThread({ api: params.api, target, signal: params.signal,
        thread: { source, id: current.parentThreadId } });
    } catch (error) {
      if (error instanceof NavigationActionIdentityError && (error.identity === "archived" || error.identity === "deleted")) return current;
      throw error;
    }
  }
  throw new Error("Thread grouping exceeds the 32-link ancestry budget.");
}
