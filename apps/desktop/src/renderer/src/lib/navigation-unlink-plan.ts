import { sortSubthreadSummaries } from "@pwragent/shared";
import type { FederationTarget, NavigationIdentity, NavigationThreadSummary, SetThreadParentRequest } from "@pwragent/shared";
import type { DesktopApi } from "./desktop-api";
import { threadSummaryIdentityKey } from "./federated-thread-events";
import { readNavigationActionThread } from "./navigation-action-authority";

export type NavigationUnlinkMember = {
  thread: NavigationThreadSummary;
  target: FederationTarget;
  expectedParent: NonNullable<SetThreadParentRequest["expectedParent"]>;
  pinBefore?: string;
};
let nextRead = 0;

/** Resolve relationship/order on each owner and pin placement on the window's pin owner. */
export async function readNavigationUnlinkPlan(params: {
  api: DesktopApi;
  threads: NavigationThreadSummary[];
  windowTarget?: FederationTarget;
  signal?: AbortSignal;
}): Promise<NavigationUnlinkMember[]> {
  if (params.threads.length > 100) throw new Error("Unlink at most 100 threads at a time.");
  if (!params.api.getNavigationQueryPage) throw new Error("Upgrade this instance before unlinking thread groups.");
  const localId = params.api.readFederationHealth ? (await params.api.readFederationHealth()).health.instanceId : undefined;
  const targetFor = (instanceId?: string): FederationTarget => instanceId && instanceId !== localId
    ? { scope: "remote", instanceId } : { scope: "local" };
  const owners = new Set<string>();
  const parents = new Map<string, { thread: NavigationThreadSummary; pinBefore?: string; children: NavigationUnlinkMember[] }>();
  const selected = new Set<string>();
  const token = `unlink-group:${++nextRead}`;
  const deadlineAt = Date.now() + 10_000;
  let retainedBytes = 0;
  const admit = (target: FederationTarget): void => {
    params.signal?.throwIfAborted();
    if (Date.now() >= deadlineAt) throw new Error("Thread group lookup timed out. Refresh and try again.");
    owners.add(target.scope === "remote" ? target.instanceId : "");
    if (owners.size > 8) throw new Error("Unlink groups from at most eight owners at a time.");
  };
  const retain = (thread: NavigationThreadSummary): void => {
    retainedBytes += new TextEncoder().encode(JSON.stringify(thread)).byteLength;
    if (retainedBytes > 1024 * 1024) throw new Error("Thread group configuration exceeds the 1 MiB action budget. Select fewer threads.");
  };
  try {
    for (const hint of params.threads) {
      const target = hint.federation?.ref.target ?? params.windowTarget ?? { scope: "local" as const };
      admit(target);
      const thread = await readNavigationActionThread({ api: params.api, thread: hint, target, signal: params.signal });
      const key = threadSummaryIdentityKey(thread);
      if (selected.has(key) || !thread.parentThreadId) continue;
      selected.add(key);
      retain(thread);
      const expectedParent = { threadId: thread.parentThreadId, backend: thread.parentThreadBackend ?? thread.source,
        instanceId: thread.parentThreadInstanceId };
      const parentTarget = expectedParent.instanceId ? targetFor(expectedParent.instanceId) : target;
      admit(parentTarget);
      const ref: NavigationIdentity = { backend: expectedParent.backend, threadId: expectedParent.threadId,
        ...(parentTarget.scope === "remote" ? { ownerInstanceId: parentTarget.instanceId } : {}) };
      const parentKey = JSON.stringify(ref);
      let parent = parents.get(parentKey);
      if (!parent) {
        const parentThread = await readNavigationActionThread({ api: params.api, thread: { id: ref.threadId, source: ref.backend },
          target: parentTarget, signal: params.signal });
        retain(parentThread);
        // A peer's own pin rank must never become a viewer pin rank.
        const pinTarget = params.windowTarget ?? { scope: "local" as const };
        admit(pinTarget);
        const page = await params.api.getNavigationQueryPage({ protocol: 2, consumer: "main-sidebar", pageSize: 1,
          federationTarget: pinTarget, inventory: params.windowTarget?.scope === "remote" ? "owner" : "viewer",
          query: { kind: "exact", identities: [ref] }, deadlineAt }, token);
        admit(pinTarget);
        if (page.protocol !== 2 || page.unchanged || page.coverage.state !== "complete" || page.nextCursor || page.entries.length > 1) {
          throw new Error("Parent pin placement is not ready. Refresh before unlinking.");
        }
        const row = page.entries[0]?.row;
        if (row && (row.ref.backend !== ref.backend || row.ref.threadId !== ref.threadId
          || row.ref.ownerInstanceId !== ref.ownerInstanceId)) throw new Error("Parent pin belongs to a different owner.");
        parent = { thread: parentThread, children: [], pinBefore: row?.pinnedRank ? threadSummaryIdentityKey(row) : undefined };
        parents.set(parentKey, parent);
      }
      // Mount metadata belongs to the viewer, independently of exact owner detail.
      const retainedThread = hint.federation?.derivedFromMountedParent && thread.federation
        ? { ...thread, federation: { ...thread.federation, derivedFromMountedParent: true } } : thread;
      parent.children.push({ thread: retainedThread, target, expectedParent, pinBefore: parent.pinBefore });
    }
    return [...parents.values()].flatMap((parent) => {
      const members = new Map(parent.children.map((member) => [threadSummaryIdentityKey(member.thread), member]));
      return sortSubthreadSummaries(parent.thread, parent.children.map((member) => member.thread))
        .map((thread) => members.get(threadSummaryIdentityKey(thread))!);
    });
  } finally { await params.api.releaseNavigationQuery?.(token).catch(() => undefined); }
}
