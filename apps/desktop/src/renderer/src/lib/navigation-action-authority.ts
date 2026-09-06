import { buildFederatedThreadRef } from "@pwragent/shared";
import type { FederationTarget, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { applyNavigationSelectedDetail, selectNavigationIdentity } from "./navigation-query-state";

/** Read action authority from the explicit owner; collection rows only identify the target. */
export async function readNavigationActionThread(params: {
  api?: Pick<DesktopApi, "getNavigationSelectedDetail">;
  thread: Pick<NavigationThreadSummary, "id" | "source" | "federation">;
  target?: FederationTarget;
  signal?: AbortSignal;
}): Promise<NavigationThreadSummary> {
  params.signal?.throwIfAborted();
  if (!params.api?.getNavigationSelectedDetail) {
    throw new Error("Upgrade this instance to load authoritative thread configuration before performing this action.");
  }
  const target = params.thread.federation?.ref.target ?? params.target;
  const ref = { backend: params.thread.source, threadId: params.thread.id,
    ...(target?.scope === "remote" ? { ownerInstanceId: target.instanceId } : {}),
  };
  const started = selectNavigationIdentity(undefined, ref);
  const detail = await params.api.getNavigationSelectedDetail({ protocol: 2, ref, federationTarget: target });
  params.signal?.throwIfAborted();
  const state = applyNavigationSelectedDetail({ state: started, sequence: started.pendingSequence, detail });
  if (state.readiness !== "ready" || detail.identity !== "present" || !detail.thread) {
    throw new Error(`Thread configuration is ${detail.identity === "present" ? "not ready" : detail.identity}. Refresh the thread before performing this action.`);
  }
  const returnedOwner = detail.thread.federation?.ref.target;
  if (returnedOwner?.scope === "remote" && (target?.scope !== "remote" || returnedOwner.instanceId !== target.instanceId)) {
    throw new Error("Thread configuration belongs to a different owner.");
  }
  return target?.scope === "remote" ? { ...detail.thread, federation: {
    ...detail.thread.federation,
    instanceLabel: detail.thread.federation?.instanceLabel ?? params.thread.federation?.instanceLabel ?? target.instanceId,
    ref: buildFederatedThreadRef({ backend: ref.backend, threadId: ref.threadId, instanceId: target.instanceId }),
  } } : detail.thread;
}
