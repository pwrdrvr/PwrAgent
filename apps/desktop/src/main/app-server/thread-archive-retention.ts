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
  observeArchives: (threads: AppServerThreadSummary[], now: number) => Promise<void>;
  confirmAbsent: (state: ThreadOverlayState) => Promise<boolean>;
  deleteFamily: (family: ThreadArchiveCandidate[], policy: DesktopThreadArchivePolicy) => Promise<void>;
  deleteSnapshot: (snapshot: WorktreeSnapshotSummary) => Promise<void>;
  forgetStates: (states: ThreadOverlayState[]) => Promise<void>;
  isBusy: (candidate: ThreadArchiveCandidate) => boolean;
  onError: (error: unknown, threadId?: string) => void;
};

export function archivedThreadFamily(root: AppServerThreadSummary, threads: AppServerThreadSummary[]): AppServerThreadSummary[] {
  const family: AppServerThreadSummary[] = [];
  const seen = new Set<string>();
  const visit = (thread: AppServerThreadSummary) => {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    if (seen.has(key)) return;
    seen.add(key);
    family.push(thread);
    for (const child of threads) {
      if (child.source === thread.source && child.codexNativeSubAgent?.parentThreadId === thread.id) visit(child);
    }
  };
  visit(root);
  return family;
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
 * its state so the next hourly sweep can retry without relying on an event. */
export async function sweepThreadArchiveRetention(deps: ThreadArchiveRetentionDeps): Promise<void> {
  const policy = deps.getPolicy();
  if (deps.shouldStop?.()) return;
  const threads = await deps.listThreads();
  const archived = threads.filter((thread) => thread.archivedAt !== undefined);
  await deps.observeArchives(archived, Date.now());
  let states = await deps.listStates();
  if (policy.retentionDays === 0) return;
  const byKey = new Map(states.map((state) => [buildThreadIdentityKey(state.backend, state.threadId), state]));
  const providerKeys = new Set(threads.map((thread) => buildThreadIdentityKey(thread.source, thread.id)));
  const removed = new Set<string>();

  const cleanup = async (victims: ThreadOverlayState[]) => {
    const keys = new Set(victims.map((state) => buildThreadIdentityKey(state.backend, state.threadId)));
    // Re-read references after provider deletion: another retained or restored
    // thread sharing the snapshot must keep its recovery ref.
    states = await deps.listStates();
    if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return;
    // A restore or protection change after provider deletion keeps the recovery
    // material. Never overwrite newer overlay state with this sweep's copy.
    for (const victim of victims) {
      const current = states.find((state) => state.backend === victim.backend && state.threadId === victim.threadId);
      if (current && (current.archiveRetentionStartedAt !== victim.archiveRetentionStartedAt
        || current.pinnedRank !== undefined || current.agent)) return;
    }
    const otherRefs = new Set(states.filter((state) => !keys.has(buildThreadIdentityKey(state.backend, state.threadId)))
      .flatMap((state) => (state.worktreeSnapshots ?? []).map((snapshot) => `${snapshot.repositoryPath}:${snapshot.snapshotRef}`)));
    const snapshots = new Map(victims.flatMap((state) => state.worktreeSnapshots ?? [])
      .map((snapshot) => [`${snapshot.repositoryPath}:${snapshot.snapshotRef}`, snapshot]));
    for (const [key, snapshot] of snapshots) {
      if (deps.shouldStop?.()) return;
      if (!otherRefs.has(key)) await deps.deleteSnapshot(snapshot);
    }
    if (deps.shouldStop?.()) return;
    await deps.forgetStates(victims);
    for (const key of keys) removed.add(key);
  };

  for (const root of archived) {
    if (deps.shouldStop?.()) return;
    const rootKey = buildThreadIdentityKey(root.source, root.id);
    const parent = root.codexNativeSubAgent?.parentThreadId;
    if (removed.has(rootKey) || (parent && providerKeys.has(buildThreadIdentityKey(root.source, parent)))) continue;
    const family = archivedThreadFamily(root, threads).map((thread) => ({
      thread, overlay: byKey.get(buildThreadIdentityKey(thread.source, thread.id)),
    }));
    if (!archiveRetentionFamilyEligible(family, policy, deps.isBusy, Date.now())) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return;
      await deps.deleteFamily(family, policy);
      await cleanup(family.map((candidate) => candidate.overlay!));
    } catch (error) { deps.onError(error, root.id); }
  }
  // Missed notifications, provider deletion while the app was closed, and a
  // previous snapshot cleanup failure all converge here after the deadline.
  for (const state of states) {
    if (deps.shouldStop?.()) return;
    const key = buildThreadIdentityKey(state.backend, state.threadId);
    const startedAt = state.archiveRetentionStartedAt;
    if (providerKeys.has(key) || removed.has(key) || startedAt === undefined
      || !Number.isFinite(startedAt) || startedAt <= 0
      || Date.now() < startedAt + policy.retentionDays * 86_400_000
      || state.pinnedRank !== undefined || state.agent) continue;
    try {
      if (JSON.stringify(policy) !== JSON.stringify(deps.getPolicy())) return;
      if (await deps.confirmAbsent(state)) await cleanup([state]);
    } catch (error) { deps.onError(error, state.threadId); }
  }
}
