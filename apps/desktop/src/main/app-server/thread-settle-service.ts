import type { AppServerBackendKind } from "@pwragent/shared/contracts/normalized-app-server";
import {
  SETTLE_DIRECTORY_UNPINNED_MAX_THREADS,
  threadSettleRefusal,
  type SetThreadSettledRequest,
  type SetThreadSettledResponse,
  type SettleDirectoryUnpinnedRequest,
  type SettleDirectoryUnpinnedResponse,
} from "@pwragent/shared/contracts/thread-settle";
import { buildThreadIdentityKey, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { listNavigationDirectoryUnpinnedRoots } from "@pwragent/owner-core/navigation-query-projection";
import {
  getDesktopBackendRegistry,
  getExistingDesktopBackendRegistry,
} from "./backend-registry";
import { loadLocalNavigationQueryIndex } from "./navigation-query-source";
import { getDesktopOverlayStore } from "../storage/desktop-overlay-store";

type ThreadRef = { backend: AppServerBackendKind; threadId: string };

/**
 * Settle and Unsettle on a thread this desktop owns, for its own windows or
 * for a peer. Settle files a root away in its project's Settled section: it
 * clears the pin and marks the thread read in one commit, then releases its
 * live session. It never archives at the harness. Refused, it changes
 * nothing and says why.
 */
export async function setLocalThreadSettled(
  request: Omit<SetThreadSettledRequest, "federationTarget">,
): Promise<SetThreadSettledResponse> {
  const backend = request.backend ?? "codex";
  const ref = { backend, threadId: request.threadId };
  const registry = getDesktopBackendRegistry();
  if (request.settled) {
    const busy = registry.threadSettleBusy(ref);
    if (busy) return { ...ref, refusal: busy };
  }
  const write = async () => getDesktopOverlayStore().setThreadsSettled({
    threads: [{ ...ref, ...(request.seenUpdatedAt !== undefined ? { seenUpdatedAt: request.seenUpdatedAt } : {}) }],
    settled: request.settled,
    at: Date.now(),
  });
  const existing = getExistingDesktopBackendRegistry();
  const changed = existing
    ? await existing.withThreadLifecycleMutation(ref, write)
    : await write();
  await announceSettleChanges(changed, request.seenUpdatedAt);
  if (request.settled) void registry.releaseSettledThreadSession(ref).catch(() => {});
  const overlay = await getDesktopOverlayStore().getThreadOverlayState(ref);
  return { ...ref, ...(overlay?.settledAt !== undefined ? { settledAt: overlay.settledAt } : {}) };
}

/**
 * Settle Unpinned…: list a project's idle Unpinned roots, or settle exactly
 * the ones the operator confirmed, in one commit. Threads that started work,
 * were pinned or settled, or left the project since the list was read are
 * skipped, never forced.
 */
export async function settleLocalDirectoryUnpinned(
  request: Omit<SettleDirectoryUnpinnedRequest, "federationTarget">,
): Promise<SettleDirectoryUnpinnedResponse> {
  const registry = getDesktopBackendRegistry();
  const index = await loadLocalNavigationQueryIndex({
    callerReason: "settle-directory-unpinned",
    registry,
  });
  const roots = listNavigationDirectoryUnpinnedRoots(index, request.directoryKey);
  const idle: NavigationThreadSummary[] = [];
  let skippedBusy = 0;
  for (const root of roots) {
    const ref = { backend: root.source, threadId: root.id };
    if (threadSettleRefusal(root) || registry.threadSettleBusy(ref)) skippedBusy += 1;
    else idle.push(root);
  }
  const candidates = idle.slice(0, SETTLE_DIRECTORY_UNPINNED_MAX_THREADS).map((thread) => ({
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
  }));
  if (!request.threads) return { directoryKey: request.directoryKey, candidates, skippedBusy };
  const eligible = new Set(candidates.map((candidate) => buildThreadIdentityKey(candidate.backend, candidate.threadId)));
  const confirmed = request.threads
    .slice(0, SETTLE_DIRECTORY_UNPINNED_MAX_THREADS)
    .filter((thread) => eligible.has(buildThreadIdentityKey(thread.backend, thread.threadId)));
  const changed = getDesktopOverlayStore().setThreadsSettled({
    threads: confirmed,
    settled: true,
    at: Date.now(),
  });
  await announceSettleChanges(changed);
  for (const thread of changed) {
    void registry.releaseSettledThreadSession(thread).catch(() => {});
  }
  return { directoryKey: request.directoryKey, candidates, skippedBusy, settled: changed.length };
}

async function announceSettleChanges(
  changed: ReadonlyArray<ThreadRef & { settledAt?: number; unpinned: boolean }>,
  seenUpdatedAt?: number,
): Promise<void> {
  const registry = getDesktopBackendRegistry();
  for (const thread of changed) {
    const { backend, threadId } = thread;
    if (thread.unpinned) {
      await registry.publishLocalEvent({ backend, notification: { method: "thread/pin/removed", params: { threadId } } });
    }
    if (thread.settledAt !== undefined) {
      await registry.publishLocalEvent({ backend, notification: {
        method: "navigation/thread/seen", params: { threadId, seenUpdatedAt },
      } });
    }
    await registry.publishLocalEvent({ backend, notification: {
      method: "thread/settled/updated",
      params: { threadId, ...(thread.settledAt !== undefined ? { settledAt: thread.settledAt } : {}) },
    } });
  }
}
