import type { ThreadSandboxStorage } from "@pwragent/owner-core/mcp-connection-storage";
import type { RuntimeLeaseStorage } from "@pwragent/owner-core/runtime-lease-storage";
import type { AcpAgentStorage, AcpAvailableCommandsStorage, AcpSessionStorage } from "@pwragent/owner-core/acp-storage";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../acp/acp-registry-types";
import type { ThreadReviewStorage } from "@pwragent/owner-core/thread-review-storage";
import { SqliteThreadReviewStorage } from "./thread-review-storage-sqlite";
import type { ThreadTodoStorage } from "@pwragent/owner-core/thread-todo-storage";
import { ThreadTodoStore } from "./thread-todo-store";
import type { ProviderThreadSnapshotStorage } from "@pwragent/owner-core/provider-thread-snapshot-storage";
import type { RetainedOwnerThreadStorage } from "@pwragent/owner-core/retained-owner-thread-storage";
import { RetainedOwnerThreadStore } from "./retained-owner-thread-store";
import { resolveActiveProfilePath } from "../profile";
import type { ThreadSearchStorage } from "@pwragent/owner-core/thread-search-storage";
import type { ScheduledThreadActionStorage } from "@pwragent/owner-core/scheduled-thread-action-storage";
import { getAppStateDb, getAppRuntimeInstanceStore, getAppStateMode, getBootDecision, isAppStateInitialized, getAppScheduledThreadActionStore as getScheduledThreadActionStore } from "../state/app-state";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { ProjectHeldWakeupStore } from "../state/project-held-wakeup-store";
import { RestartContinuationStore } from "../state/restart-continuation-store";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadSandboxStore } from "./thread-sandbox-store";
import { runOneTimeArchivedWorktreeRepair as runRepair } from "../state/archived-worktree-repair";
import { AcpAgentStore } from "./acp-agent-store";
import { AcpSessionStore } from "./acp-session-store";
import { AcpAvailableCommandsStore } from "./acp-available-commands-store";
import { ThreadSearchStore } from "./thread-search-store";
import { SqliteTokenMiserStorage } from "./token-miser-storage-sqlite";
import { TokenMiserStore, type TokenMiserStoreOptions } from "../token-miser/token-miser-store";
import { ProviderThreadSnapshotStore } from "./provider-thread-snapshot-store";
import { CodexEnvironmentHydrationStore } from "./codex-environment-hydration-store";

export type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
export type { StoredProjectHeldWakeup } from "../state/project-held-wakeup-store";
export type { StoredRestartContinuation } from "../state/restart-continuation-store";
export type { MessagingStoreLike } from "../messaging/core/messaging-storage";
export type ArchiveCleanupCheckpointStorage = Pick<ArchiveCleanupCheckpointStore, "save" | "recover">;
export type ProjectHeldWakeupStorage = Pick<ProjectHeldWakeupStore, "save" | "update" | "remove" | "claimOrphaned">;
export type RestartContinuationStorage = Pick<RestartContinuationStore, "saveAll" | "remove" | "claimOrphaned">;
export type ThreadDependencyStorage = Pick<ThreadDependencyStore, keyof ThreadDependencyStore>;

// Bind each store at its existing construction boundary, without caching a
// database in this module or giving callers access to its handle.
export { getAppStateMode, getBootDecision, isAppStateInitialized };
export function getAppScheduledThreadActionStore(): ScheduledThreadActionStorage {
  return getScheduledThreadActionStore();
}
export function createArchiveCleanupCheckpointStorage(): ArchiveCleanupCheckpointStorage {
  return new ArchiveCleanupCheckpointStore(getAppStateDb().raw);
}
export function createProjectHeldWakeupStorage(): ProjectHeldWakeupStorage {
  return new ProjectHeldWakeupStore(getAppStateDb().raw);
}
export function createRestartContinuationStorage(): RestartContinuationStorage {
  return new RestartContinuationStore(getAppStateDb().raw);
}
export function createThreadDependencyStorage(): ThreadDependencyStorage {
  return new ThreadDependencyStore(getAppStateDb().raw);
}
export function createThreadSandboxStorage(): ThreadSandboxStorage {
  return new ThreadSandboxStore(getAppStateDb().raw);
}
export function createProviderThreadSnapshotStorage(): ProviderThreadSnapshotStorage {
  return new ProviderThreadSnapshotStore(getAppStateDb());
}
export function createRetainedOwnerThreadStorage(): RetainedOwnerThreadStorage {
  const store = new RetainedOwnerThreadStore(getAppStateDb(), resolveActiveProfilePath("state/headless"));
  return { list: () => store.list(), confirmNativeThreads: ids => store.confirmNativeThreads(ids) };
}
export function createCodexEnvironmentHydrationStorage() {
  return new CodexEnvironmentHydrationStore(getAppStateDb());
}
export function createAcpAgentStorage(): AcpAgentStorage<AcpRegistrySnapshot, AcpInstalledAgentRecord> { return new AcpAgentStore(getAppStateDb()); }
export function createAcpSessionStorage(): AcpSessionStorage { return new AcpSessionStore(getAppStateDb()); }
export function createAcpAvailableCommandsStorage(): AcpAvailableCommandsStorage { return new AcpAvailableCommandsStore(getAppStateDb()); }
export function createThreadSearchStorage(): ThreadSearchStorage { return new ThreadSearchStore(getAppStateDb()); }
export function createTokenMiserStorage(directory: string, options: Omit<TokenMiserStoreOptions, "storage">) {
  return new TokenMiserStore(directory, { ...options, storage: new SqliteTokenMiserStorage(getAppStateDb()) });
}
export function runOneTimeArchivedWorktreeRepair(options: Omit<Parameters<typeof runRepair>[0], "db">) {
  return runRepair({ ...options, db: getAppStateDb().raw });
}

export function createThreadTodoStorage(): ThreadTodoStorage {
  return new ThreadTodoStore(getAppStateDb());
}

export function createThreadReviewStorage(): ThreadReviewStorage {
  return new SqliteThreadReviewStorage(getAppStateDb());
}

export function getDesktopRuntimeLeaseStorage(): RuntimeLeaseStorage {
  return getAppRuntimeInstanceStore();
}
