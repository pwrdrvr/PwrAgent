import { getAppStateDb, getAppStateMode, isAppStateInitialized, getAppScheduledThreadActionStore } from "../state/app-state";
import { ArchiveCleanupCheckpointStore } from "../state/archive-cleanup-checkpoint";
import { ProjectHeldWakeupStore } from "../state/project-held-wakeup-store";
import { RestartContinuationStore } from "../state/restart-continuation-store";
import { ThreadDependencyStore } from "../state/thread-dependency-store";
import { ThreadSandboxStore } from "../state/thread-sandbox-store";
import { runOneTimeArchivedWorktreeRepair as runRepair } from "../state/archived-worktree-repair";
import { AcpAgentStore } from "../acp/acp-agent-store";
import { AcpSessionStore } from "../acp/acp-session-store";
import { AcpAvailableCommandsStore } from "../acp/acp-available-commands-store";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { TokenMiserStore, type TokenMiserStoreOptions } from "../token-miser/token-miser-store";
import { ProviderThreadSnapshotStore } from "./provider-thread-snapshot-store";
import { CodexEnvironmentHydrationStore } from "./codex-environment-hydration-store";

export type { ArchiveCleanupIntent } from "../state/archive-cleanup-checkpoint";
export type { StoredProjectHeldWakeup } from "../state/project-held-wakeup-store";
export type { StoredRestartContinuation } from "../state/restart-continuation-store";
export type { MessagingStoreLike } from "../state/messaging-store-sqlite";
export type ArchiveCleanupCheckpointStorage = Pick<ArchiveCleanupCheckpointStore, "save" | "recover">;
export type ProjectHeldWakeupStorage = Pick<ProjectHeldWakeupStore, "save" | "update" | "remove" | "claimOrphaned">;
export type RestartContinuationStorage = Pick<RestartContinuationStore, "saveAll" | "remove" | "claimOrphaned">;
export type ThreadDependencyStorage = Pick<ThreadDependencyStore, keyof ThreadDependencyStore>;

// Bind each store at its existing construction boundary, without caching a
// database in this module or giving callers access to its handle.
export { getAppStateMode, isAppStateInitialized, getAppScheduledThreadActionStore };
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
export function createThreadSandboxStorage() {
  return new ThreadSandboxStore(getAppStateDb().raw);
}
export function createProviderThreadSnapshotStorage() {
  return new ProviderThreadSnapshotStore(getAppStateDb());
}
export function createCodexEnvironmentHydrationStorage() {
  return new CodexEnvironmentHydrationStore(getAppStateDb());
}
export function createAcpAgentStorage() { return new AcpAgentStore(getAppStateDb()); }
export function createAcpSessionStorage() { return new AcpSessionStore(getAppStateDb()); }
export function createAcpAvailableCommandsStorage() { return new AcpAvailableCommandsStore(getAppStateDb()); }
export function createThreadSearchStorage() { return new ThreadSearchStore(getAppStateDb()); }
export function createTokenMiserStorage(directory: string, options: Omit<TokenMiserStoreOptions, "stateDb">) {
  return new TokenMiserStore(directory, { ...options, stateDb: getAppStateDb() });
}
export function runOneTimeArchivedWorktreeRepair(options: Omit<Parameters<typeof runRepair>[0], "db">) {
  return runRepair({ ...options, db: getAppStateDb().raw });
}
