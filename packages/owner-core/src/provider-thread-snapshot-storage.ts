import type {
  AppServerBackendKind,
  AppServerThreadSummary,
} from "@pwragent/shared";

export type ProviderThreadSnapshot = Readonly<{
  backend: AppServerBackendKind;
  observedAt: number;
  threads: readonly AppServerThreadSummary[];
}>;

export interface ProviderThreadSnapshotStorage {
  list(): ProviderThreadSnapshot[];
  /** Retire confirmed native identities and publish inventory atomically. */
  replace(snapshot: ProviderThreadSnapshot, retiredThreadIds?: readonly string[]): void;
}

export function projectProviderThreadSummary(
  thread: AppServerThreadSummary,
): AppServerThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    titleSource: thread.titleSource,
    source: thread.source,
    linkedDirectories: thread.linkedDirectories,
    ...(thread.threadStatus ? { threadStatus: thread.threadStatus } : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.gitBranch ? { gitBranch: thread.gitBranch } : {}),
    ...(thread.gitOriginUrl ? { gitOriginUrl: thread.gitOriginUrl } : {}),
    ...(thread.observedGitBranch
      ? { observedGitBranch: thread.observedGitBranch }
      : {}),
    ...(thread.gitWorkingState
      ? { gitWorkingState: thread.gitWorkingState }
      : {}),
    ...(thread.executionMode ? { executionMode: thread.executionMode } : {}),
    ...(thread.model ? { model: thread.model } : {}),
    ...(thread.serviceTier ? { serviceTier: thread.serviceTier } : {}),
    ...(thread.reasoningEffort
      ? { reasoningEffort: thread.reasoningEffort }
      : {}),
    ...(thread.fastMode !== undefined ? { fastMode: thread.fastMode } : {}),
    ...(thread.workspaceHandoff
      ? { workspaceHandoff: thread.workspaceHandoff }
      : {}),
    ...(thread.worktreeSnapshots
      ? { worktreeSnapshots: thread.worktreeSnapshots }
      : {}),
    ...(thread.codexNativeSubAgent
      ? { codexNativeSubAgent: thread.codexNativeSubAgent }
      : {}),
  };
}
