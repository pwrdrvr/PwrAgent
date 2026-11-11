import {
  buildThreadIdentityKey,
  type AppServerThreadSummary,
  type DesktopThreadArchivePolicy,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
} from "@pwragent/shared";
import { isProtectedArchiveCandidate, type ThreadArchiveCandidate } from "./thread-archive-sweeper";

export type ThreadArchiveRetentionDeps = {
  getPolicy: () => DesktopThreadArchivePolicy;
  shouldStop?: () => boolean;
  /** Complete active and archived provider inventories, including native descendants. */
  listThreads: () => Promise<AppServerThreadSummary[]>;
  listStates: () => Promise<ThreadOverlayState[]>;
  /** A fresh superset of the `listStates` rows that belong to these threads
   * or name one of these snapshot refs. Cleanup reads only these when given,
   * rather than every state once per deleted family. */
  listStatesFor?: (threads: ThreadOverlayState[], snapshotRefs: string[]) => Promise<ThreadOverlayState[]>;
  observeArchives: (threads: AppServerThreadSummary[], now: number) => Promise<void>;
  confirmAbsent: (state: ThreadOverlayState) => Promise<boolean>;
  deleteFamily: (family: ThreadArchiveCandidate[], policy: DesktopThreadArchivePolicy) => Promise<void>;
  deleteSnapshot: (snapshot: WorktreeSnapshotSummary) => Promise<void>;
  forgetStates: (states: ThreadOverlayState[]) => Promise<void>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  onError: (error: unknown, threadId?: string) => void;
};

export function archivedThreadFamily(root: AppServerThreadSummary, threads: AppServerThreadSummary[]): AppServerThreadSummary[] {
  return archivedThreadFamilies(threads)(root);
}

/**
 * Families for many roots of one thread list. Each thread's children are
 * found once, so finding every root's family costs one pass over the list
 * rather than one per family member. Same families as scanning the list for
 * each member: a child shares its parent's backend and names the parent's id,
 * children follow list order, and a thread is visited once. Build one per
 * thread list and drop it with the list.
 */
export function archivedThreadFamilies(threads: readonly AppServerThreadSummary[]): (root: AppServerThreadSummary) => AppServerThreadSummary[] {
  // Backend, then parent id: identity keys are not joined into one string.
  const children = new Map<string, Map<string, AppServerThreadSummary[]>>();
  for (const thread of threads) {
    const parentId = thread.codexNativeSubAgent?.parentThreadId;
    if (parentId === undefined) continue;
    let byParent = children.get(thread.source);
    if (!byParent) children.set(thread.source, byParent = new Map());
    const list = byParent.get(parentId);
    if (list) list.push(thread);
    else byParent.set(parentId, [thread]);
  }
  return (root) => {
    const family: AppServerThreadSummary[] = [];
    const seen = new Set<string>();
    const visit = (thread: AppServerThreadSummary) => {
      const key = buildThreadIdentityKey(thread.source, thread.id);
      if (seen.has(key)) return;
      seen.add(key);
      family.push(thread);
      for (const child of children.get(thread.source)?.get(thread.id) ?? []) visit(child);
    };
    visit(root);
    return family;
  };
}

export function archiveRetentionFamilyEligible(
  candidates: ThreadArchiveCandidate[], policy: DesktopThreadArchivePolicy,
  isBusy: (candidate: ThreadArchiveCandidate) => boolean, now: number,
): boolean {
  return policy.retentionDays > 0 && candidates.every((candidate) => {
    const start = candidate.overlay?.archiveRetentionStartedAt;
    return candidate.thread.archivedAt !== undefined && start !== undefined
      && Number.isFinite(start) && start > 0 && now >= start + policy.retentionDays * 86_400_000
      && !isProtectedArchiveCandidate(candidate) && !isBusy(candidate);
  });
}

/** Provider deletion owns conversation files. PwrAgent only releases its own
 * recovery refs and overlay state, after deletion succeeds or an expired
 * thread is absent from a complete provider inventory. Failed cleanup retains
 * its state so the next hourly sweep can retry without relying on an event.
 * Resolves to the number of thread families permanently deleted. */
export async function sweepThreadArchiveRetention(deps: ThreadArchiveRetentionDeps): Promise<number> {
  const policy = deps.getPolicy();
  let deleted = 0;
  if (deps.shouldStop?.()) return deleted;
  const threads = await deps.listThreads();
  const archived = threads.filter((thread) => thread.archivedAt !== undefined);
  await deps.observeArchives(archived, Date.now());
  const states = await deps.listStates();
  if (policy.retentionDays === 0) return deleted;
  const byKey = new Map(states.map((state) => [buildThreadIdentityKey(state.backend, state.threadId), state]));
  const providerKeys = new Set(threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const removed = new Set<string>();

  let cleaned = false;
  const refKey = (snapshot: WorktreeSnapshotSummary) => `${snapshot.repositoryPath}:${snapshot.snapshotRef}`;
  const cleanup = async (victims: ThreadOverlayState[]) => {
    cleaned = true;
    const keys = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
    const snapshots = new Map(victims.flatMap((state) => state.worktreeSnapshots ?? [])
      .map((snapshot) => [refKey(snapshot), snapshot]));
    const refs = [...snapshots.values()].map((snapshot) => snapshot.snapshotRef);
    // Re-read references after provider deletion: another retained or restored
    // thread sharing the snapshot must keep its recovery ref. Only the victims
    // and the states naming their refs can change the outcome.
    const fresh = deps.listStatesFor && refs.every((ref) => typeof ref === "string")
      ? await deps.listStatesFor(victims, refs)
      : await deps.listStates();
    if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return;
    const currentByKey = new Map<string, ThreadOverlayState>();
    for (const state of fresh) {
      const key = buildThreadIdentityKey(state.backend, state.threadId);
      if (!currentByKey.has(key)) currentByKey.set(key, state);
    }
    // A restore or protection change after provider deletion keeps the recovery
    // material. Never overwrite newer overlay state with this sweep's copy.
    for (const victim of victims) {
      const current = currentByKey.get(buildThreadIdentityKey(victim.backend, victim.threadId));
      if (current && (current.archiveRetentionStartedAt !== victim.archiveRetentionStartedAt
        || current.pinnedRank !== undefined || current.agent)) return;
    }
    const otherRefs = new Set(fresh.filter((state) => !keys.has(buildThreadIdentityKey(state.backend, state.threadId)))
      .flatMap((state) => (state.worktreeSnapshots ?? []).map(refKey)));
    for (const [key, snapshot] of snapshots) {
      if (deps.shouldStop?.()) return;
      if (!otherRefs.has(key)) await deps.deleteSnapshot(snapshot);
    }
    if (deps.shouldStop?.()) return;
    await deps.forgetStates(victims);
    for (const key of keys) removed.add(key);
  };

  const familyOf = archivedThreadFamilies(threads);
  for (const root of archived) {
    if (deps.shouldStop?.()) return deleted;
    const rootKey = buildThreadIdentityKey(root.source, root.id);
    const parent = root.codexNativeSubAgent?.parentThreadId;
    if (removed.has(rootKey) || (parent && providerKeys.has(buildThreadIdentityKey(root.source, parent)))) continue;
    const family = familyOf(root).map((thread) => ({
      thread, overlay: byKey.get(buildThreadIdentityKey(thread.source, thread.id)),
    }));
    if (!archiveRetentionFamilyEligible(family, policy, deps.isBusy, Date.now())) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return deleted;
      await deps.deleteFamily(family, policy);
      deleted += 1;
      await cleanup(family.map((candidate) => candidate.overlay!));
    } catch (error) { deps.onError(error, root.id); }
  }
  // Missed notifications, provider deletion while the app was closed, and a
  // previous snapshot cleanup failure all converge here after the deadline.
  // Families deleted above changed the states, so start from a fresh list.
  const orphans = cleaned ? await deps.listStates() : states;
  for (const state of orphans) {
    if (deps.shouldStop?.()) return deleted;
    const key = buildThreadIdentityKey(state.backend, state.threadId);
    const startedAt = state.archiveRetentionStartedAt;
    if (providerKeys.has(key) || removed.has(key) || startedAt === undefined
      || !Number.isFinite(startedAt) || startedAt <= 0
      || Date.now() < startedAt + policy.retentionDays * 86_400_000
      || state.pinnedRank !== undefined || state.agent) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return deleted;
      if (await deps.confirmAbsent(state)) await cleanup([state]);
    } catch (error) { deps.onError(error, state.threadId); }
  }
  return deleted;
}
