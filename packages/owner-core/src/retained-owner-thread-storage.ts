import type { NavigationThreadSummary } from "@pwragent/shared";
import type { OwnerJobRecord } from "./owner-job-storage";
import type { OwnerThreadRecord } from "./thread-storage";

/** Readable owner identities, independent of native provider membership. */
export interface RetainedOwnerThreadStorage {
  list(): NavigationThreadSummary[];
  /** Confirm positive provider evidence without overwriting a later retirement. */
  confirmNativeThreads(threadIds: readonly string[]): void;
}

/** Committed import/acceptance is evidence; presentation metadata alone is not. */
export function retainsOwnerThread(record: OwnerThreadRecord | undefined, imported: boolean, job?: OwnerJobRecord): boolean {
  return Boolean(job?.threadId) || Boolean(imported && record
    && record.nativeMembershipRetired === undefined && record.title?.nativeName === undefined);
}

export function projectRetainedOwnerThread(
  threadId: string,
  record: OwnerThreadRecord | undefined,
  job: OwnerJobRecord | undefined,
  workspace?: string,
): NavigationThreadSummary {
  const cwd = record?.cwd || job?.cwd || workspace;
  const createdAt = record?.createdAt ?? (job?.createdAt ? Date.parse(job.createdAt) : 0);
  const updatedAt = Math.max(record?.updatedAt ?? createdAt, job?.updatedAt ? Date.parse(job.updatedAt) : 0);
  const archiveObservation = Math.max(record?.archivedAt ?? -Infinity, record?.archiveRetentionStartedAt ?? -Infinity);
  const archived = record?.archivedAt !== undefined || record?.archiveRetentionStartedAt !== undefined || record?.restoredAt !== undefined
    ? archiveObservation > (record.restoredAt ?? -Infinity) : record?.archived === true;
  return {
    id: threadId, source: "codex", title: record?.title?.text ?? (record ? "Untitled thread" : `Thread ${threadId.slice(0, 8)}`),
    titleSource: record?.title?.source ?? "fallback", createdAt, updatedAt,
    projectKey: cwd, linkedDirectories: cwd ? [{ id: cwd, kind: "local", path: cwd, label: cwd.split(/[\\/]/).pop() || cwd }] : [],
    ...(archived ? { archivedAt: archiveObservation === -Infinity ? 0 : archiveObservation } : {}),
    executionMode: record?.executionMode ?? (job?.sandbox === "workspace-write" ? "auto" : "default"),
    model: record?.model ?? job?.model ?? undefined, reasoningEffort: record?.reasoningEffort ?? job?.reasoningEffort ?? undefined,
    serviceTier: record?.serviceTier ?? job?.serviceTier ?? undefined, fastMode: record?.fastMode,
    pinnedRank: record?.pinnedRank, parentThreadId: record?.parent?.threadId, parentThreadBackend: record?.parent?.backend,
    parentThreadInstanceId: record?.parent?.instanceId, subthreadOrder: record?.subthreadOrder, subthreadsCollapsed: record?.subthreadsCollapsed,
    threadStatus: "idle", inbox: { inInbox: updatedAt > (record?.seenUpdatedAt ?? record?.seenAt ?? 0), reason: "updated-since-seen" },
  };
}
