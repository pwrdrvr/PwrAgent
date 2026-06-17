import { app } from "electron";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { DynamicToolSpec as CodexDynamicToolSpec } from "@pwrdrvr/codex-app-server-protocol/v2";
import type { MessagingApprovalDecision } from "@pwragent/messaging-interface";
import { getAppStateDb, getAppStateMode } from "../state/app-state";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import { requestShowThread } from "../window-show-thread";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import {
  type AcpBackendId,
  estimateOpenAiTokenUsageCost,
  formatTokenUsageUsd,
  isToolManagedWorktreePath,
  resolveOpenAiPricingServiceTier,
  shortenDerivedThreadTitle,
  type AgentEvent,
  type ArchiveWorktreeRequest,
  type ArchiveWorktreeResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadCleanupResult,
  type ArchiveThreadResponse,
  type AppServerListSkillsResponse,
  type AppServerNotification,
  type AppServerPendingRequestNotification,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadActivityEntry,
  type AppServerThreadEntry,
  type AppServerThreadReplay,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerThreadTitleSource,
  type AppServerTurnInputItem,
  type AppServerAvailableCommandSummary,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAccountSummary,
  type BackendAcpRuntimeCapabilities,
  type BackendAcpRuntimeOptionSource,
  type BackendAcpSessionRuntimeState,
  type BackendCapabilities,
  type CodexEnvironmentActionRun,
  type CodexEnvironmentOption,
  type CodexEnvironmentSetupProgressEvent,
  type CodexThreadEnvironmentRuntime,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendRateLimitSummary,
  type BackendSummary,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  type ForkThreadRequest,
  type ForkThreadResponse,
  isBranchDrifted,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type LatestCodexConfigWarningResponse,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type EditGroupCommitInput,
  type EditGroupCommitState,
  type LinkedDirectorySummary,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadOptions,
  type MaterializeDirectoryLaunchpadResponse,
  type MaterializedDirectoryLaunchpadThread,
  type LaunchpadWorkMode,
  type NavigationDirectoryGitStatus,
  type NavigationDirectorySummary,
  type NavigationLaunchpadDraft,
  type NavigationLaunchpadDefaults,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type RetainThreadBranchDriftRequest,
  type RetainThreadBranchDriftResponse,
  type RunCodexEnvironmentActionRequest,
  type RunCodexEnvironmentActionResponse,
  type StopCodexEnvironmentActionRequest,
  type StopCodexEnvironmentActionResponse,
  type SetCodexThreadEnvironmentRequest,
  type SetCodexThreadEnvironmentResponse,
  type SetAcpSessionRuntimeOptionRequest,
  type SetAcpSessionRuntimeOptionResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
  applyNavigationLaunchpadProviderSettingsPatch,
  projectNavigationLaunchpadProviderSettings,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type RestoreThreadWorktreeResult,
  type SetThreadExecutionModeRequest,
  type SetThreadExecutionModeResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
  type QueueThreadExecutionModeRequest,
  type QueueThreadExecutionModeResponse,
  type CancelThreadExecutionModeQueueRequest,
  type CancelThreadExecutionModeQueueResponse,
  type ThreadMessagingBindingTransition,
  type ThreadPermissionTransition,
  type ThreadPermissionTransitionStatus,
  type ThreadTurnFailure,
  type ThreadAgentMetadata,
  type PwrAgentThreadInspectionRequest,
  type PwrAgentThreadInspectionResponse,
  type ThreadInspectionSummary,
  type ThreadSearchFilters,
  type ThreadSearchResult,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadRequest,
  type StartThreadResponse,
  type SubmitServerRequestRequest,
  type SubmitServerRequestResponse,
  type TrustCodexProjectRequest,
  type TrustCodexProjectResponse,
  type ThreadExecutionMode,
  type ThreadIdentifier,
  type ThreadOverlayState,
  type ThreadPricingSummary,
  type ThreadSubAgentSummary,
  type ThreadUsageLineRecord,
  type WorktreeSnapshotSummary,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateThreadExpectedBranchRequest,
  type UpdateThreadExpectedBranchResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  applyCodexEnvironmentActionRunUpdate,
  buildPendingRequestResponse,
  buildThreadIdentityKey,
  isAcpBackendId,
  isAppServerBackendKind,
  DEFAULT_THREAD_INSPECTION_RECENT_LIMIT,
  DEFAULT_THREAD_INSPECTION_SEARCH_LIMIT,
  MAX_THREAD_INSPECTION_SEARCH_LIMIT,
  PWRAGENT_MESSAGING_TOOL_NAMESPACE,
  PWRAGENT_THREAD_TOOL_NAMESPACE,
  isThreadSearchContentMode,
  isThreadSearchSemanticMode,
  type PendingRequestDecision,
  readCodexEnvironmentActionRuns,
  DEFAULT_TASK_MONITOR_MODEL,
  DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS,
  DEFAULT_TASK_MONITOR_REASONING_EFFORT,
  DEFAULT_TASK_MONITOR_STARTUP_TIMEOUT_SECONDS,
  TASK_MONITOR_TOOL_NAMESPACE,
  type CompleteMonitoringToolArgs,
  type CreateMonitorDelegationToolArgs,
  type InjectMonitorProgressToolArgs,
  type TaskMonitorCompletionSource,
  type TaskMonitorRequest,
  type TaskMonitorResponse,
  type TaskMonitorUsageSnapshot,
} from "@pwragent/shared";
import {
  ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR,
  AcpBackendAdapter,
  acpRuntimeValueLooksPrivileged,
  acpSessionHasConversationHistory,
  acpSessionToThreadSummary,
  formatAcpRuntimeLabel,
  inputToAcpPrompt,
  acpAdvertisesRuntimeModeSelector,
  isAcpSessionMissingForProjectError,
  mergeAcpRuntimeState,
  readKimiYoloExecutionModeFromText,
  withAcpModelRuntimeSelection,
  type AcpBackendAdapterOptions,
  type AcpClientFactory,
  type AcpRuntimeClient,
  type AcpSessionMetadata,
  type AcpSessionStoreLike,
  type LocalAcpDiscovery,
} from "./acp-backend-adapter";
import { CodexAppServerClient } from "../codex-app-server/client";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import { ThreadSearchStore } from "../thread-search/thread-search-store";
import { GrokAppServerClient } from "../grok-app-server/client";
import {
  buildAutomationInspectionDynamicToolErrorResponse,
  handleAutomationInspectionDynamicToolCall,
  readAutomationInspectionDynamicToolCall,
  type AutomationInspectionHandler,
} from "../automations/automation-inspection-codex-tools";
import {
  buildMonitorParentAgentGuidance,
  buildMonitorDelegationPrompt,
  buildTaskMonitorDynamicToolErrorResponse,
  buildTaskMonitorDynamicToolSpecs,
  findUnsupportedCodexExecSessionReference,
  handleTaskMonitorDynamicToolCall,
  normalizeHeartbeatIntervalSeconds,
  normalizePollIntervalSeconds,
  normalizePreferredMonitorModel,
  normalizePreferredMonitorReasoningEffort,
  readTaskMonitorDynamicToolCall,
} from "./task-monitor-codex-tools";
import {
  buildPwrAgentThreadDynamicToolErrorResponse,
  handlePwrAgentThreadDynamicToolCall,
  readPwrAgentThreadDynamicToolCall,
} from "../agent-tools/pwragent-thread-codex-tools";
import type { PwrAgentThreadInspectionHandler } from "../agent-tools/pwragent-thread-agent-tools";
import {
  buildPwrAgentMessagingDynamicToolErrorResponse,
  handlePwrAgentMessagingDynamicToolCall,
  readPwrAgentMessagingDynamicToolCall,
} from "../agent-tools/pwragent-messaging-codex-tools";
import type { PwrAgentMessagingHandler } from "../agent-tools/pwragent-messaging-agent-tools";
import type { MessagingAgentToolService } from "../messaging/messaging-agent-tool-service";
import { resolveAutomationInspectionMcpCommand } from "../automations/automation-inspection-cli";
import { resolveAgentToolCatalogs } from "../agent-tools/agent-tool-catalog-registry";
import { createScratchProjectDirectory } from "./scratch-projects";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";
import { GitDirectoryService } from "./git-directory-service";
import type { DirectoryGitStatusEntry } from "./git-directory-service";
import { GitWorkingStateService } from "./git-working-state-service";
import type {
  GitWorkingStateEntryOptions,
  ResolveEditCommitStatesOptions,
  WorktreeWorkingStateEntry,
} from "./git-working-state-service";
import { resolveWorktreeRepositoryDirectory } from "./thread-directory-enricher";
import { GitWorkspaceHandoffService } from "./git-workspace-handoff-service";
import { WorktreeArchiveService } from "./worktree-archive-service";
import { getDesktopMessagingStore } from "../messaging/desktop-messaging-store";
import {
  createCompositeJsonRpcObserver,
  createProtocolLogObserverFromEnv,
} from "./protocol-log-observer";
import {
  ThreadTitleGenerationService,
  GrokThreadTitleGenerator,
  type ThreadTitleGenerator,
  type ThreadTitleGenerationResult,
} from "./thread-title-generation-service";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getDesktopNotificationService } from "../notifications/desktop-notification-service";
import { buildApprovalIntent } from "../messaging/core/messaging-approval-renderer";
import { resolveAgentCoreGrokEnabled } from "../settings/desktop-config";
import {
  BackendModelCatalog,
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  listCodexEnvironmentOptions,
  pruneCodexEnvironmentActionMap,
  resolveCodexEnvironmentActionId,
  withCodexEnvironmentOptions,
} from "./codex-environment-config";
import {
  applyLocalCodexEnvironmentSelection,
  CodexEnvironmentStartupError,
  startLocalCodexEnvironmentAction,
  stopCodexEnvironmentDetachedCommand,
  type CodexEnvironmentCommandRunner,
  type CodexEnvironmentDetachedExit,
  type CodexEnvironmentDetachedOutput,
  type CodexEnvironmentSelection,
} from "./codex-environment-runtime";
import {
  CodexEnvironmentHydrationStore,
  type CodexEnvironmentHydrationStoreLike,
} from "./codex-environment-hydration-store";
import {
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueLifecycleEvent,
  type ThreadTurnQueueOrigin,
  type ThreadTurnQueueSubmissionResult,
} from "./thread-turn-queue";
import { materializeLocalImageInputs } from "./image-input-files";
import type { MessagingStoreLike } from "../state/messaging-store-sqlite";

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

const isDevelopment = process.env.NODE_ENV !== "production";
const REPLAY_THREAD_TITLE_ENV = "PWRAGENT_REPLAY_THREAD_TITLE";
// Keep expensive Codex thread-list walks reusable across focus/navigation bursts.
// Thread lifecycle notifications still invalidate this cache when list metadata
// changes, so this window can cover ordinary foreground idle time while
// background polling catches external Codex changes on a slower cadence.
const THREAD_LIST_REUSE_WINDOW_MS = 5 * 60_000;
const ACTIVE_TURN_HANDOFF_ERROR =
  "Worktree/local migration is not available while a turn is in progress. Resubmit when the turn completes.";
/**
 * Number of consecutive queued-execution-mode flush failures tolerated
 * before the queue is auto-cancelled and an explanatory `cancelled`
 * audit entry is appended. Codex's `thread/resume` is normally
 * idempotent, so repeated failure here implies a deeper protocol
 * problem the user needs visibility into.
 */
const MAX_QUEUE_FLUSH_ATTEMPTS = 3;
const backendRegistryLog = getMainLogger("pwragent:backend-registry");
const ATTENTION_NOTIFICATION_METHODS = new Set([
  "turn/requestApproval",
  "review/requestApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
  "mcpServer/elicitation/request",
  "applyPatchApproval",
  "execCommandApproval",
]);
const execFile = promisify(execFileCallback);

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  backendRegistryLog.info(event, payload);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

function assistantOutputForTurn(
  replay: AppServerThreadReplay,
  turnId: string,
): Array<{ type: "text"; text: string }> {
  for (let index = replay.entries.length - 1; index >= 0; index -= 1) {
    const entry = replay.entries[index];
    if (
      entry?.type === "message" &&
      entry.role === "assistant" &&
      entry.turn?.id === turnId &&
      entry.turn.status === "completed" &&
      entry.text.trim()
    ) {
      return [{ type: "text", text: entry.text }];
    }
  }

  return [];
}

type BackendClient = {
  close(): Promise<void>;
  getInitializeResult(): Promise<InitializeResult>;
  listThreads(
    params?: { archived?: boolean; enrichDirectories?: boolean; filter?: string },
    diagnostics?: { callerReason?: string; ownerId?: string },
  ): Promise<AppServerThreadSummary[]>;
  enrichThreadDirectories?(
    threads: AppServerThreadSummary[],
  ): Promise<AppServerThreadSummary[]>;
  archiveThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  restoreThread?(params: { threadId: string }): Promise<{ threadId: string }>;
  renameThread?(params: { threadId: string; name: string }): Promise<{ threadId: string }>;
  updateThreadMetadata?(params: {
    threadId: string;
    gitInfo?: {
      branch?: string | null;
      originUrl?: string | null;
      sha?: string | null;
    } | null;
  }): Promise<{ threadId: string }>;
  generateTitle?: ThreadTitleGenerator["generateTitle"];
  listSkills(params?: {
    cwd?: string;
    cwds?: string[];
  }): Promise<AppServerListSkillsResponse["data"]>;
  onNotification(
    listener: (notification: AppServerNotification) => void | Promise<void>
  ): () => void;
  onRequest?(
    listener: (
      request: AppServerPendingRequestNotification
    ) => Promise<unknown> | unknown
  ): () => void;
  readThread(params: {
    threadId: string;
    before?: string;
    limit?: number;
  }): Promise<AppServerReadThreadResponse["replay"]>;
  injectThreadItems?(params: { threadId: string; items: unknown[] }): Promise<void>;
  startThread(params: {
    cwd?: string;
    ephemeral?: boolean;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: CodexDynamicToolSpec[];
  }): Promise<{ threadId: string }>;
  forkThread?(params: {
    threadId: string;
    path?: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  }): Promise<{ threadId: string }>;
  startTurn(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    cwd?: string;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    defaultModeRequestUserInput?: boolean;
    dynamicTools?: CodexDynamicToolSpec[];
  }): Promise<{
    threadId: string;
    turnId: string;
  }>;
  startReview?(params: {
    threadId: string;
    target: StartReviewRequest["target"];
    delivery?: StartReviewRequest["delivery"];
    model?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    cwd?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }>;
  listModels?(diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<BackendModelOption[]>;
  readAccount?(): Promise<BackendAccountSummary>;
  readRateLimits?(): Promise<BackendRateLimitSummary[]>;
  interruptTurn(params: {
    threadId: string;
    turnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  compactThread?(params: {
    threadId: string;
  }): Promise<{ threadId: string; turnId: string; itemId?: string }>;
  steerTurn?(params: {
    threadId: string;
    input: AppServerTurnInputItem[];
    expectedTurnId: string;
  }): Promise<{ threadId: string; turnId: string }>;
  setThreadPermissions?(params: {
    threadId: string;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ threadId: string }>;
  trustProject?(params: {
    projectPath: string;
    configPath?: string;
  }): Promise<{ projectPath: string; configPath?: string }>;
};

type BackendRegistryForkThreadRequest = ForkThreadRequest & {
  onPreparedWorkspaceRollback?: (rollback: (() => Promise<void>) | undefined) => void;
  sourceThreadPath?: string;
};

/**
 * Resolve the live workspace CWD for thread-scoped commands.
 *
 * Worktree threads must run from LinkedDirectorySummary.worktreePath; Local
 * threads run from LinkedDirectorySummary.path. Persisted environment runtime
 * cwd is intentionally not consulted here because it can lag behind a
 * Local/Worktree handoff.
 */
function resolveThreadWorkspaceCwd(
  thread: AppServerThreadSummary | undefined,
  overlayDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): string | undefined {
  if (!thread) {
    return undefined;
  }

  return resolveLinkedDirectoryWorkspaceCwd([
    ...overlayDirectories,
    ...thread.linkedDirectories,
  ]) ?? thread.projectKey;
}

function resolveLinkedDirectoryWorkspaceCwd(
  linkedDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): string | undefined {
  const directory =
    linkedDirectories.find((candidate) => candidate.kind === "worktree") ??
    linkedDirectories.find((candidate) => candidate.kind === "local") ??
    linkedDirectories[0];

  return directory?.worktreePath ?? directory?.path;
}

function hasHandoffWorkspace(
  directories: AppServerThreadSummary["linkedDirectories"] = [],
): boolean {
  return directories.some(isHandoffDirectory);
}

function overlayHasHandoffWorkspace(
  overlay: ThreadOverlayState | undefined,
): boolean {
  return Boolean(overlay?.extraLinkedDirectories.some(isHandoffDirectory));
}

function isHandoffDirectory(directory: LinkedDirectorySummary): boolean {
  return (
    directory.id.startsWith("pwragent-handoff:") ||
    directory.id.startsWith("pwragnt-handoff:")  // legacy prefix from pre-rebrand data
  );
}

/**
 * Normalize a resolved path to forward slashes for use as a cross-platform
 * directory identifier. No-op on POSIX; on Windows turns `C:\Users\…` into
 * `C:/Users/…` so ids/keys read identically across hosts and match the
 * thread-directory-enricher's normalized identifiers.
 */
function toDirectoryId(value: string): string {
  return value.replace(/\\/g, "/");
}

function buildLocalLinkedDirectory(cwd: string | undefined): LinkedDirectorySummary[] {
  const normalized = cwd?.trim();
  if (!normalized) {
    return [];
  }
  const directoryPath = path.resolve(normalized);
  return [
    {
      id: toDirectoryId(directoryPath),
      kind: "local",
      label: path.basename(directoryPath) || directoryPath,
      path: toDirectoryId(directoryPath),
    },
  ];
}

function buildWorktreeLinkedDirectory(params: {
  repositoryPath?: string;
  worktreePath?: string;
  label?: string;
}): LinkedDirectorySummary[] {
  const normalizedWorktreePath = params.worktreePath?.trim();
  if (!normalizedWorktreePath) {
    return [];
  }

  const worktreePath = path.resolve(normalizedWorktreePath);
  const repositoryPath = path.resolve(params.repositoryPath?.trim() || worktreePath);
  const label = params.label?.trim() || path.basename(repositoryPath) || repositoryPath;

  return [
    {
      id: toDirectoryId(repositoryPath),
      kind: "worktree",
      label,
      path: toDirectoryId(repositoryPath),
      worktreePath: toDirectoryId(worktreePath),
    },
  ];
}

function isLikelyToolManagedWorktreePath(projectKey: string | undefined): boolean {
  const normalized = projectKey?.trim();
  if (!normalized) {
    return false;
  }

  return isToolManagedWorktreePath(normalized) || /[\\/]\.worktrees[\\/]/.test(normalized);
}

function hasCachedWorktreeDirectory(
  overlay: ThreadOverlayState | undefined,
  projectPath: string,
): boolean {
  const resolvedProjectPath = path.resolve(projectPath);
  return Boolean(
    overlay?.extraLinkedDirectories.some((directory) => {
      // directory.id is forward-slash normalized; re-resolve both sides so the
      // comparison is separator-agnostic across platforms.
      if (path.resolve(directory.id) !== resolvedProjectPath) {
        return false;
      }
      return Boolean(directory.worktreePath?.trim());
    }),
  );
}

function hasEquivalentLinkedDirectory(
  overlay: ThreadOverlayState | undefined,
  directory: LinkedDirectorySummary,
): boolean {
  return Boolean(
    overlay?.extraLinkedDirectories.some((candidate) => {
      if (candidate.id !== directory.id || candidate.kind !== directory.kind) {
        return false;
      }

      const candidatePath = path.resolve(candidate.path);
      const directoryPath = path.resolve(directory.path);
      const candidateWorktreePath = candidate.worktreePath?.trim()
        ? path.resolve(candidate.worktreePath)
        : undefined;
      const directoryWorktreePath = directory.worktreePath?.trim()
        ? path.resolve(directory.worktreePath)
        : undefined;

      return (
        candidatePath === directoryPath &&
        candidateWorktreePath === directoryWorktreePath
      );
    }),
  );
}

function pathContainsOrEquals(parentPath: string, childPath: string): boolean {
  const relativePath = path.relative(parentPath, childPath);
  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.isAbsolute(relativePath))
  );
}

function buildCachedWorktreeDirectory(
  thread: AppServerThreadSummary,
): LinkedDirectorySummary | undefined {
  const projectKey = thread.projectKey?.trim();
  if (!projectKey) {
    return undefined;
  }

  const projectPath = path.resolve(projectKey);
  const directory = thread.linkedDirectories.find((candidate) => {
    const worktreePath = candidate.worktreePath?.trim();
    if (!worktreePath) {
      return false;
    }
    return pathContainsOrEquals(path.resolve(worktreePath), projectPath);
  });
  if (!directory) {
    return undefined;
  }

  const repositoryPath = path.resolve(directory.path);
  const worktreePath = path.resolve(directory.worktreePath!);
  if (repositoryPath === projectPath) {
    return undefined;
  }

  return {
    ...directory,
    id: toDirectoryId(projectPath),
    kind: "worktree",
    label: directory.label || path.basename(repositoryPath) || repositoryPath,
    path: toDirectoryId(repositoryPath),
    worktreePath: toDirectoryId(worktreePath),
  };
}

function buildCachedDirectoryRelationship(
  thread: AppServerThreadSummary,
): LinkedDirectorySummary | undefined {
  const worktreeDirectory = buildCachedWorktreeDirectory(thread);
  if (worktreeDirectory) {
    return worktreeDirectory;
  }

  const projectKey = thread.projectKey?.trim();
  if (!projectKey) {
    return undefined;
  }

  if (isLikelyToolManagedWorktreePath(projectKey)) {
    return undefined;
  }

  const projectPath = path.resolve(projectKey);
  const localDirectory = thread.linkedDirectories.find((candidate) => {
    if (candidate.worktreePath?.trim()) {
      return false;
    }
    return path.resolve(candidate.path) === projectPath;
  });
  if (!localDirectory) {
    return undefined;
  }

  return {
    ...localDirectory,
    id: toDirectoryId(projectPath),
    kind: "local",
    label: localDirectory.label || path.basename(projectPath) || projectPath,
    path: toDirectoryId(projectPath),
    worktreePath: undefined,
  };
}

function shouldRepairCachedDirectoryRelationship(params: {
  directory: LinkedDirectorySummary;
  overlay: ThreadOverlayState | undefined;
}): boolean {
  if (hasEquivalentLinkedDirectory(params.overlay, params.directory)) {
    return false;
  }

  if (overlayHasHandoffWorkspace(params.overlay)) {
    return false;
  }

  if (params.directory.kind === "worktree") {
    return true;
  }

  return Boolean(
    params.overlay?.extraLinkedDirectories.some((candidate) => {
      if (candidate.id === params.directory.id) {
        return true;
      }
      if (isHandoffDirectory(candidate)) {
        return false;
      }

      return path.resolve(candidate.path) === path.resolve(params.directory.path);
    }),
  );
}

function normalizeLinkedDirectoryKind(
  directory: LinkedDirectorySummary,
): LinkedDirectorySummary {
  if (
    directory.kind === "local" &&
    (directory.worktreePath?.trim() || isToolManagedWorktreePath(directory.path))
  ) {
    const worktreePath = directory.worktreePath?.trim() || directory.path;
    return {
      ...directory,
      kind: "worktree",
      worktreePath,
    };
  }

  return directory;
}

function pendingStartedThreadMatchesFilter(
  thread: AppServerThreadSummary,
  filter: string | undefined,
): boolean {
  const normalized = filter?.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    thread.id,
    thread.title,
    thread.summary,
    thread.projectKey,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .filter(Boolean)
    .some((value) => value!.toLowerCase().includes(normalized));
}

function resolveExpectedThreadBranch(params: {
  overlay?: ThreadOverlayState;
  thread?: Pick<AppServerThreadSummary, "gitBranch">;
}): string | undefined {
  const overlayBranch = params.overlay?.gitBranch?.trim();
  if (overlayBranch) {
    return overlayBranch;
  }

  const overlayObservedBranch = params.overlay?.observedGitBranch?.trim();
  if (
    overlayObservedBranch &&
    hasHandoffWorkspace(params.overlay?.extraLinkedDirectories)
  ) {
    return overlayObservedBranch;
  }

  return params.thread?.gitBranch?.trim() || undefined;
}

async function readCurrentGitBranch(sourcePath: string): Promise<string | undefined> {
  const result = await execFile(
    "git",
    ["-C", sourcePath, "rev-parse", "--abbrev-ref", "HEAD"],
    { env: process.env },
  );
  const branch = result.stdout.trim();
  return branch || undefined;
}

type PendingServerRequest = {
  resolve: (response: SubmitServerRequestRequest["response"]) => void;
  reject: (error: Error) => void;
};

type ThreadTitleService = Pick<ThreadTitleGenerationService, "generateTitle">;

type ThreadTitleGenerationLogStatus =
  | ThreadTitleGenerationResult["status"]
  | "applied"
  | "requesting"
  | "skipped";

type WorktreeArchiveCandidate = {
  repositoryPath: string;
  worktreePath: string;
};

type ArchiveCleanupMetadata = {
  activeThreads: AppServerThreadSummary[];
  archivedThreads: AppServerThreadSummary[];
  thread: AppServerThreadSummary;
};

type WorktreeRestoreCandidate = {
  branch?: string;
  repositoryPath?: string;
  snapshot?: WorktreeSnapshotSummary;
  worktreePath: string;
};

function linkedDirectoryWorktreePath(
  directory: LinkedDirectorySummary,
): string | undefined {
  const explicitWorktreePath = directory.worktreePath?.trim();
  if (explicitWorktreePath) {
    return explicitWorktreePath;
  }

  if (directory.kind === "worktree") {
    return directory.path;
  }

  if (directory.kind === "local" && isLikelyToolManagedWorktreePath(directory.path)) {
    return directory.path;
  }

  return undefined;
}

function normalizeWorktreePathForComparison(worktreePath: string): string {
  return path.normalize(worktreePath.trim());
}

const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "OpenAI",
  grok: "AgentCore - Grok",
};

const OPENAI_FALLBACK_MODELS: BackendModelOption[] = [
  {
    id: "gpt-5.5",
    label: "GPT-5.5",
    current: true,
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.4",
    label: "GPT-5.4",
    supportsReasoning: true,
    supportsFast: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.4-mini",
    label: "GPT-5.4-Mini",
    supportsReasoning: true,
    supportsSteering: true,
  },
  {
    id: "gpt-5.2",
    label: "GPT-5.2",
    supportsReasoning: true,
    supportsSteering: true,
  },
];

const GROK_FALLBACK_MODELS: BackendModelOption[] = [
  {
    id: "grok-4.20-reasoning",
    label: "Grok 4.20 Reasoning",
    current: true,
    supportsReasoning: false,
    supportsSteering: false,
  },
  {
    id: "grok-4.20-non-reasoning",
    label: "Grok 4.20 Non-Reasoning",
    supportsReasoning: false,
    supportsSteering: false,
  },
  {
    id: "grok-4-1-fast-reasoning",
    label: "Grok 4.1 Fast Reasoning",
    supportsReasoning: false,
    supportsFast: true,
    supportsSteering: false,
  },
  {
    id: "grok-4-1-fast-non-reasoning",
    label: "Grok 4.1 Fast Non-Reasoning",
    supportsReasoning: false,
    supportsFast: true,
    supportsSteering: false,
  },
  {
    id: "grok-4-fast-reasoning",
    label: "Grok 4 Fast Reasoning",
    supportsReasoning: false,
    supportsFast: true,
    supportsSteering: false,
  },
  {
    id: "grok-4-fast-non-reasoning",
    label: "Grok 4 Fast Non-Reasoning",
    supportsReasoning: false,
    supportsFast: true,
    supportsSteering: false,
  },
];

const OPENAI_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"];
const GROK_REASONING_EFFORTS = ["low", "medium", "high"];
const DEFAULT_REASONING_EFFORT = "medium";

const EXECUTION_MODE_SUMMARIES: Record<
  ThreadExecutionMode,
  {
    label: string;
    approvalPolicy: string;
    sandbox: string;
  }
> = {
  default: {
    label: "Default Access",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "full-access": {
    label: "Full Access",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
  },
};

const GEMINI_PRIVILEGED_APPROVAL_MODES = new Set([
  "yolo",
]);

function acpRuntimeStateRequiresFullAccess(params: {
  runtime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
}): boolean {
  const { runtime, runtimeCapabilities } = params;
  if (!runtime) {
    return false;
  }
  if (acpRuntimeValueLooksPrivileged(runtime.currentModeId)) {
    return true;
  }

  const configValues = runtime.configValues ?? {};
  const modeOptionIds = new Set(
    runtimeCapabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id) ?? [],
  );
  for (const key of ["mode", "approval-mode", "approval_mode"]) {
    modeOptionIds.add(key);
  }

  for (const optionId of modeOptionIds) {
    if (acpRuntimeValueLooksPrivileged(configValues[optionId])) {
      return true;
    }
  }

  return false;
}

function acpRuntimeModeDefaultsFromCapabilities(
  runtimeCapabilities: BackendAcpRuntimeCapabilities | undefined,
  now: number,
): BackendAcpSessionRuntimeState | undefined {
  const modeConfigOptions =
    runtimeCapabilities?.configOptions?.filter(
      (option) => option.category === "mode",
    ) ?? [];
  const configValues = Object.fromEntries(
    modeConfigOptions.flatMap((option) =>
      typeof option.currentValue === "string"
        ? [[option.id, option.currentValue] as const]
        : [],
    ),
  );
  const state: BackendAcpSessionRuntimeState = {
    updatedAt: now,
    ...(Object.keys(configValues).length > 0 ? { configValues } : {}),
    ...(modeConfigOptions.length === 0 && runtimeCapabilities?.modes?.currentModeId
      ? { currentModeId: runtimeCapabilities.modes.currentModeId }
      : {}),
  };
  return Object.keys(state).length > 1 ? state : undefined;
}

function sanitizeAcpRuntimeForExecutionMode(params: {
  backend: AppServerBackendKind;
  executionMode: ThreadExecutionMode;
  runtime?: BackendAcpSessionRuntimeState;
}): BackendAcpSessionRuntimeState | undefined {
  const { backend, executionMode, runtime } = params;
  if (backend !== "acp:gemini" || executionMode !== "default" || !runtime) {
    return runtime;
  }

  let changed = false;
  const configValues = runtime.configValues
    ? { ...runtime.configValues }
    : undefined;
  if (
    configValues?.["approval-mode"] &&
    GEMINI_PRIVILEGED_APPROVAL_MODES.has(configValues["approval-mode"])
  ) {
    configValues["approval-mode"] = "default";
    changed = true;
  }

  const currentModeId =
    runtime.currentModeId &&
    GEMINI_PRIVILEGED_APPROVAL_MODES.has(runtime.currentModeId)
      ? "default"
      : runtime.currentModeId;
  if (currentModeId !== runtime.currentModeId) {
    changed = true;
  }

  return changed
    ? {
        ...runtime,
        ...(configValues ? { configValues } : {}),
        ...(currentModeId ? { currentModeId } : {}),
      }
    : runtime;
}

function buildCapabilities(methods: string[], backend: AppServerBackendKind): BackendCapabilities {
  const supported = new Set(methods);
  const assumeCodexAppServerSurface = backend === "codex" && methods.length === 0;

  return {
    listThreads:
      supported.has("thread/list") ||
      supported.has("thread/loaded/list") ||
      assumeCodexAppServerSurface,
    createThread:
      supported.has("thread/start") ||
      supported.has("thread/new") ||
      assumeCodexAppServerSurface,
    // Empty Codex method lists are emitted by older supported app-server
    // surfaces that predate method discovery. PwrAgent's supported Codex
    // floor includes thread/fork, so keep the legacy "assume app-server
    // surface" behavior for empty lists while respecting explicit method
    // lists from feature-gated builds.
    forkThread: supported.has("thread/fork") || assumeCodexAppServerSurface,
    resumeThread: supported.has("thread/resume") || assumeCodexAppServerSurface,
    archiveThread: supported.has("thread/archive") || assumeCodexAppServerSurface,
    restoreThread: supported.has("thread/unarchive") || assumeCodexAppServerSurface,
    archiveWorktree: true,
    restoreWorktree: true,
    renameThread: supported.has("thread/name/set") || assumeCodexAppServerSurface,
    readThread: supported.has("thread/read") || assumeCodexAppServerSurface,
    startTurn: supported.has("turn/start") || assumeCodexAppServerSurface,
    startReview: supported.has("review/start") || assumeCodexAppServerSurface,
    interruptTurn: supported.has("turn/interrupt"),
    steerTurn: backend === "codex" || supported.has("turn/steer"),
    transcriptPagination: false,
    toolUse: false,
    approvalRequests: true,
    multiDirectoryThreads: backend === "codex",
  };
}

function backendMethodCommands(
  backend: AppServerBackendKind,
  methods: string[],
): AppServerAvailableCommandSummary[] {
  if (backend !== "codex") {
    return [];
  }

  const supported = new Set(methods);
  const assumeCodexAppServerSurface = methods.length === 0;
  const commands: AppServerAvailableCommandSummary[] = [];

  if (supported.has("thread/compact/start") || assumeCodexAppServerSurface) {
    commands.push({
      name: "compact",
      description: "Compact this thread's context.",
      backend,
      scope: "backend",
      source: "provider",
    });
  }

  return commands;
}

function mergeCommandSummaries(
  current: AppServerAvailableCommandSummary[] | undefined,
  incoming: AppServerAvailableCommandSummary[],
): AppServerAvailableCommandSummary[] {
  const merged: AppServerAvailableCommandSummary[] = [];
  const seen = new Set<string>();

  for (const command of [...(current ?? []), ...incoming]) {
    const commandName = command.name.startsWith("/")
      ? command.name.slice(1)
      : command.name;
    const key = `${command.backend ?? ""}:${commandName}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(command);
  }

  return merged;
}

export function buildCodexClientArgs(env?: NodeJS.ProcessEnv): string[] {
  const args = [
    "-c",
    'approval_policy="on-request"',
    "-c",
    'sandbox_mode="workspace-write"',
  ];
  const pathValue = env?.PATH?.trim();
  if (pathValue) {
    args.push(
      "-c",
      `shell_environment_policy.set.PATH=${formatTomlString(pathValue)}`,
    );
  }
  return args;
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildPendingRequestKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
  requestId: string;
}): string {
  return `${params.backend}:${params.threadId}:${params.requestId}`;
}

function buildTerminalNotificationKey(params: {
  backend: AppServerBackendKind;
  threadId: string;
}): string {
  return `${params.backend}:${params.threadId}:turn-terminal`;
}

function readNotificationProjectLabel(
  thread: Record<string, unknown> | undefined,
): string | undefined {
  if (!thread) {
    return undefined;
  }
  const linkedDirectories = Array.isArray(thread.linkedDirectories)
    ? thread.linkedDirectories
    : [];
  for (const directory of linkedDirectories) {
    if (!directory || typeof directory !== "object" || Array.isArray(directory)) {
      continue;
    }
    const record = directory as Record<string, unknown>;
    const label = readNonEmptyString(record.label);
    if (label) {
      return label;
    }
    const directoryPath = readNonEmptyString(record.path);
    if (directoryPath) {
      return path.basename(directoryPath);
    }
  }
  const projectKey = readNonEmptyString(thread.projectKey);
  return projectKey ? path.basename(projectKey) : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isAcpPermissionRequest(
  request: AppServerPendingRequestNotification,
): boolean {
  return (
    request.method === "item/commandExecution/requestApproval" &&
    request.params.acpMethod === "session/request_permission"
  );
}

function pendingRequestDecisionFromMessagingApproval(
  decision: MessagingApprovalDecision,
): PendingRequestDecision {
  switch (decision) {
    case "accept":
    case "accept_for_session":
    case "accept_with_execpolicy_amendment":
    case "apply_network_policy_amendment":
      return "approve";
    case "decline":
      return "decline";
    case "cancel":
      return "cancel";
  }
}

function acpRuntimeHasExecutionModeSelection(params: {
  runtime?: BackendAcpSessionRuntimeState;
  runtimeCapabilities?: BackendAcpRuntimeCapabilities;
}): boolean {
  const { runtime, runtimeCapabilities } = params;
  if (!runtime) {
    return false;
  }
  if (runtime.currentModeId) {
    return true;
  }

  const configValues = runtime.configValues ?? {};
  const modeOptionIds = new Set(
    runtimeCapabilities?.configOptions
      ?.filter((option) => option.category === "mode")
      .map((option) => option.id) ?? [],
  );
  for (const key of ["mode", "approval-mode", "approval_mode"]) {
    modeOptionIds.add(key);
  }

  return [...modeOptionIds].some((optionId) => configValues[optionId]);
}

function executionModeQueueKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return buildThreadIdentityKey(backend, threadId);
}

function formatExecutionModeForError(mode: ThreadExecutionMode): string {
  return mode === "full-access" ? "Full Access" : "Default Access";
}

function buildActiveTurnModeKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function buildActiveTurnKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

function buildReviewSubAgentKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return buildActiveTurnKey(backend, threadId, turnId);
}

function reviewSubAgentId(turnId: string): string {
  return `review:${turnId}`;
}

function reviewTaskLabel(target: StartReviewRequest["target"]): string {
  switch (target.type) {
    case "baseBranch":
      return `Review changes against ${target.branch}`;
    case "commit":
      return `Review commit ${target.sha.slice(0, 7)}`;
    case "custom":
      return target.instructions.trim() || "Review changes";
    case "uncommittedChanges":
      return "Review current changes";
  }
}

function parseThreadTurnKeyBody(
  body: string,
): { threadId: string; turnId: string } | undefined {
  const pendingSeparator = body.indexOf(":pending:");
  if (pendingSeparator > 0) {
    const beforePending = body.slice(0, pendingSeparator);
    const afterPending = body.slice(pendingSeparator + ":pending:".length);
    if (beforePending === afterPending || afterPending.startsWith(`${beforePending}:`)) {
      return { threadId: beforePending, turnId: `pending:${afterPending}` };
    }
  }
  const turnSeparator = body.lastIndexOf(":");
  if (turnSeparator <= 0) return undefined;
  return {
    threadId: body.slice(0, turnSeparator),
    turnId: body.slice(turnSeparator + 1),
  };
}

function parseActiveTurnKey(
  key: string,
): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined {
  if (key.startsWith("acp:")) {
    const registrySeparator = key.indexOf(":", "acp:".length);
    if (registrySeparator <= "acp:".length) return undefined;
    const backend = key.slice(0, registrySeparator);
    if (!isAcpBackendId(backend)) return undefined;
    const parsed = parseThreadTurnKeyBody(
      key.slice(registrySeparator + 1),
    );
    return parsed ? { backend, ...parsed } : undefined;
  }

  const backendSeparator = key.indexOf(":");
  if (backendSeparator <= 0) return undefined;
  const backend = key.slice(0, backendSeparator);
  if (backend !== "codex" && backend !== "grok") return undefined;
  const parsed = parseThreadTurnKeyBody(
    key.slice(backendSeparator + 1),
  );
  return parsed ? { backend, ...parsed } : undefined;
}

function parseThreadIdFromThreadTurnKeyBody(body: string): string | undefined {
  return parseThreadTurnKeyBody(body)?.threadId;
}

function buildHeadlessAutomationTurnKey(
  backend: AppServerBackendKind,
  threadId: string,
  turnId: string,
): string {
  return `${backend}:${threadId}:${turnId}`;
}

function buildTurnStartReservationKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `${backend}\u0000${threadId}`;
}

function parseReservedAcpStartThreadKey(
  key: string,
): { backend: AppServerBackendKind; threadId: string } | undefined {
  const [backend, threadId] = key.split("\u0000");
  if (!backend || !threadId || !isAcpBackendId(backend)) {
    return undefined;
  }
  return { backend, threadId };
}

function formatQuitThreadKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `${backend}:${threadId}`;
}

function prependAutomationRuntimeContext(params: {
  approvalPolicy: string;
  executionMode: ThreadExecutionMode;
  input: AppServerTurnInputItem[];
  label: string;
  sandbox: string;
}): AppServerTurnInputItem[] {
  const accessNote =
    params.sandbox === "danger-full-access"
      ? "Shell commands may run with Full Access. Permission prompts are unavailable; do not ask the user for approval."
      : "Shell commands run in the Default Access workspace-write sandbox. Shell network access is unavailable, and permission prompts are unavailable; do not ask the user for approval or wait for one. Use built-in hosted tools such as web search when available, or return a concise failure explaining that the automation needs Full Access.";

  return [
    {
      type: "text",
      text: [
        "Automation runtime context:",
        `Access mode: ${params.label} (${params.executionMode}).`,
        `Approval policy: ${params.approvalPolicy}.`,
        `Sandbox: ${params.sandbox}.`,
        accessNote,
      ].join("\n"),
    },
    ...params.input,
  ];
}

function buildHeadlessAutomationRequestCancelResponse(
  request: AppServerPendingRequestNotification,
): Record<string, unknown> {
  if (request.method === "mcpServer/elicitation/request") {
    return {
      action: "cancel",
      content: null,
      _meta: null,
    };
  }

  if (request.method === "item/tool/requestUserInput") {
    return {
      answers: {},
    };
  }

  return { decision: "cancel" };
}

function readStatusType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return undefined;
  }

  const type = value.type;
  return typeof type === "string" ? type : undefined;
}

function readNotificationItemType(notification: AppServerNotification): string | undefined {
  if (
    notification.method !== "item/started" &&
    notification.method !== "item/completed"
  ) {
    return undefined;
  }
  const params = readRecord(notification.params);
  const item = readRecord(params?.item);
  const type = item?.type;
  return typeof type === "string" ? type : undefined;
}

const TASK_MONITOR_STALE_CHECK_INTERVAL_MS = 15_000;
const TASK_MONITOR_STALE_GRACE_MS = 15_000;

type TaskMonitorDelegationRecord = {
  activeCommandCount: number;
  backend: "codex";
  createdAt: number;
  cwd?: string;
  executionMode?: ThreadExecutionMode;
  finalHandoffPrompt?: string;
  lastActivityAt: number;
  latestUsage?: TaskMonitorUsageSnapshot;
  monitorId: string;
  monitorThreadId?: string;
  monitorTurnId?: string;
  parentThreadId: string;
  heartbeatIntervalSeconds: number;
  pollIntervalSeconds: number;
  preferredModel: string;
  preferredReasoningEffort: string;
  recoveryAttempted?: boolean;
  staleInterruptAttempted?: boolean;
  startupTimeoutSeconds: number;
  task: string;
};

type ReviewSubAgentRecord = {
  backend: Exclude<AppServerBackendKind, AcpBackendId>;
  createdAt: number;
  fastMode?: boolean;
  latestUsage?: TaskMonitorUsageSnapshot;
  model?: string;
  parentThreadId: string;
  serviceTier?: string;
  reviewThreadId: string;
  task: string;
  turnId: string;
};

function taskMonitorFailure<TOperation extends TaskMonitorRequest["operation"]>(
  operation: TOperation,
  code: "forbidden" | "internal_error" | "invalid_arguments" | "not_found" | "unsupported_operation",
  message: string,
): TaskMonitorResponse<TOperation> {
  return {
    ok: false,
    operation,
    error: {
      code,
      message,
    },
  } as TaskMonitorResponse<TOperation>;
}

function formatTaskMonitorProgressMessage(params: {
  message: string;
  status?: InjectMonitorProgressToolArgs["status"];
  task: string;
}): string {
  return [
    "PwrAgent monitor update",
    `Task: ${params.task}`,
    params.status ? `Status: ${params.status}` : undefined,
    params.message,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatTaskMonitorCompletionMessage(params: {
  completionSource?: TaskMonitorCompletionSource;
  details?: string;
  outcome: CompleteMonitoringToolArgs["outcome"];
  summary: string;
  task: string;
}): string {
  return [
    "PwrAgent monitor complete",
    `Task: ${params.task}`,
    `Outcome: ${params.outcome}`,
    params.completionSource?.type === "pwragent_fallback"
      ? "Completion source: PwrAgent fallback"
      : undefined,
    params.summary,
    params.details?.trim() ? `Details:\n${params.details.trim()}` : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTaskMonitorFinalHandoffInput(params: {
  completionSource?: TaskMonitorCompletionSource;
  details?: string;
  finalHandoffPrompt?: string;
  outcome: CompleteMonitoringToolArgs["outcome"];
  summary: string;
  task: string;
}): string {
  return [
    "A lightweight PwrAgent monitor subagent finished a long-running task.",
    "",
    `Task: ${params.task}`,
    `Outcome: ${params.outcome}`,
    params.completionSource?.type === "pwragent_fallback"
      ? "Completion source: pwragent_fallback"
      : undefined,
    `Summary: ${params.summary}`,
    params.details?.trim() ? `Details:\n${params.details.trim()}` : undefined,
    params.finalHandoffPrompt?.trim()
      ? ["", "Requested parent-agent follow-up:", params.finalHandoffPrompt.trim()].join("\n")
      : "",
    "",
    "Process this final monitor result. Do not resume polling unless the result explicitly says monitoring is still required.",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTaskMonitorRecoveryPrompt(params: {
  monitorId: string;
  task: string;
  terminalStatus: "completed" | "failed" | "cancelled";
}): string {
  return [
    "PwrAgent monitor recovery instruction:",
    "",
    `The previous monitor turn ended with status \"${params.terminalStatus}\" before it called pwragent_task_monitors.complete_monitoring.`,
    "You must now report the final monitor result. Use only the monitor task context you already have.",
    "",
    `Monitor id: ${params.monitorId}`,
    `Task: ${params.task}`,
    "",
    "Call pwragent_task_monitors.complete_monitoring exactly once.",
    "If you cannot determine a successful final outcome from the context you have, use outcome \"failure\" and explain that monitoring ended without a determinate result.",
    "Do not sleep, poll indefinitely, or do unrelated work in this recovery turn.",
  ].join("\n");
}

type TaskMonitorTokenUsageBreakdown = {
  cachedInputTokens?: number;
  inputTokens?: number;
  uncachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
};

type TaskMonitorTokenUsageRecords = {
  currentUsage?: TaskMonitorTokenUsageBreakdown;
  latestUsage?: TaskMonitorTokenUsageBreakdown;
  totalUsage?: TaskMonitorTokenUsageBreakdown;
};

function buildTaskMonitorUsageSnapshot(params: {
  fastMode?: boolean;
  model?: string;
  serviceTier?: string;
  tokenUsage: unknown;
}): TaskMonitorUsageSnapshot | undefined {
  const tokens = normalizeTaskMonitorTokenUsage(params.tokenUsage);
  if (!tokens) {
    return undefined;
  }

  const cachedInputTokens = Math.max(0, tokens.cachedInputTokens ?? 0);
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokens.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  const cost = estimateTaskMonitorUsageCost({
    cachedInputTokens,
    fastMode: params.fastMode,
    model: params.model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });

  const summary = [
    `${formatTaskMonitorTokenCount(uncachedInputTokens)} uncached in`,
    `${formatTaskMonitorTokenCount(cachedInputTokens)} cached`,
    reasoningOutputTokens > 0
      ? `${formatTaskMonitorTokenCount(outputTokens)} out (${formatTaskMonitorTokenCount(
          reasoningOutputTokens,
        )} reasoning)`
      : `${formatTaskMonitorTokenCount(outputTokens)} out`,
    cost ? `${formatTokenUsageUsd(cost.totalUsd)} list price` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    ...(cost ? { cost } : {}),
    ...(params.model ? { model: params.model } : {}),
    summary,
    tokenUsage: {
      cachedInputTokens,
      inputTokens,
      outputTokens,
      reasoningOutputTokens,
      totalTokens,
      uncachedInputTokens,
    },
  };
}

function normalizeTaskMonitorTokenUsage(
  tokenUsage: unknown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const root = readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const container =
    readRecord(root.tokenUsage) ??
    readRecord(root.token_usage) ??
    readRecord(root.info) ??
    root;
  const current =
    readRecord(container.total) ??
    readRecord(container.total_token_usage) ??
    readRecord(container.last) ??
    readRecord(container.last_token_usage) ??
    container;
  const direct = readTaskMonitorTokenBreakdown(current);
  if (direct) {
    return direct;
  }

  for (const key of ["data", "payload", "info", "usage", "result"]) {
    const nested = normalizeTaskMonitorTokenUsage(root[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function readTaskMonitorTokenUsageRecords(
  tokenUsage: unknown,
): TaskMonitorTokenUsageRecords | undefined {
  const root = readRecord(tokenUsage);
  if (!root) {
    return undefined;
  }

  const container =
    readRecord(root.tokenUsage) ??
    readRecord(root.token_usage) ??
    readRecord(root.info) ??
    root;
  const latestUsage =
    readTaskMonitorTokenBreakdownFromUnknown(container.last) ??
    readTaskMonitorTokenBreakdownFromUnknown(container.last_token_usage);
  const totalUsage =
    readTaskMonitorTokenBreakdownFromUnknown(container.total) ??
    readTaskMonitorTokenBreakdownFromUnknown(container.total_token_usage);
  const currentUsage =
    latestUsage ?? totalUsage ?? readTaskMonitorTokenBreakdown(container);
  if (latestUsage || totalUsage || currentUsage) {
    return {
      ...(currentUsage ? { currentUsage } : {}),
      ...(latestUsage ? { latestUsage } : {}),
      ...(totalUsage ? { totalUsage } : {}),
    };
  }

  for (const key of ["data", "payload", "info", "usage", "result"]) {
    const nested = readTaskMonitorTokenUsageRecords(root[key]);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function readTaskMonitorTokenBreakdownFromUnknown(
  value: unknown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const record = readRecord(value);
  return record ? readTaskMonitorTokenBreakdown(record) : undefined;
}

function readTaskMonitorTokenBreakdown(
  record: Record<string, unknown>,
): TaskMonitorTokenUsageBreakdown | undefined {
  const explicitTotal = readTaskMonitorNumber(record, "totalTokens", "total_tokens");
  const inputTokens = readTaskMonitorNumber(record, "inputTokens", "input_tokens");
  const cachedInputTokens = readTaskMonitorNumber(
    record,
    "cachedInputTokens",
    "cached_input_tokens",
  );
  const outputTokens = readTaskMonitorNumber(record, "outputTokens", "output_tokens");
  const reasoningOutputTokens = readTaskMonitorNumber(
    record,
    "reasoningOutputTokens",
    "reasoning_output_tokens",
  );
  const derivedTotal =
    (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningOutputTokens ?? 0);
  const totalTokens = explicitTotal ?? (derivedTotal > 0 ? derivedTotal : undefined);
  if (
    totalTokens === undefined &&
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    reasoningOutputTokens === undefined
  ) {
    return undefined;
  }
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
  };
}

function subtractTaskMonitorTokenUsage(
  total: TaskMonitorTokenUsageBreakdown,
  baseline: TaskMonitorTokenUsageBreakdown,
): TaskMonitorTokenUsageBreakdown | undefined {
  const result: TaskMonitorTokenUsageBreakdown = {};
  for (const key of [
    "cachedInputTokens",
    "inputTokens",
    "uncachedInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
  ] as const) {
    const totalValue = total[key];
    if (typeof totalValue === "number" && Number.isFinite(totalValue)) {
      const baselineValue = baseline[key] ?? 0;
      result[key] = Math.max(0, totalValue - baselineValue);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTaskMonitorPricingTokens(
  tokens: TaskMonitorTokenUsageBreakdown,
): Required<TaskMonitorTokenUsageBreakdown> {
  const inputTokens = Math.max(0, tokens.inputTokens ?? 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, tokens.cachedInputTokens ?? 0),
  );
  const uncachedInputTokens = Math.max(
    0,
    tokens.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = Math.max(0, tokens.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokens.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokens.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  return {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    uncachedInputTokens,
  };
}

function readTaskMonitorNumber(
  record: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function estimateTaskMonitorUsageCost(params: {
  cachedInputTokens: number;
  fastMode?: boolean;
  model?: string;
  outputTokens: number;
  reasoningOutputTokens?: number;
  serviceTier?: string;
  uncachedInputTokens: number;
}): { model: string; totalUsd: number } | undefined {
  const cost = estimateOpenAiTokenUsageCost(params);
  return cost ? { model: cost.model, totalUsd: cost.totalUsd } : undefined;
}

function formatTaskMonitorTokenCount(value: number): string {
  return Math.round(value).toLocaleString();
}

function collectThreadUsageLinesFromReplay(
  replay: AppServerThreadReplay,
): ThreadUsageLineRecord[] {
  const lines: ThreadUsageLineRecord[] = [];
  const seen = new Set<string>();
  for (const entry of replay.entries) {
    if (entry.type !== "activity" || !entry.usageLine) {
      continue;
    }
    if (seen.has(entry.usageLine.usageLineId)) {
      continue;
    }
    seen.add(entry.usageLine.usageLineId);
    lines.push(entry.usageLine);
  }
  return lines;
}

function buildTaskMonitorUsageLine(params: {
  backend: AppServerBackendKind;
  fastMode?: boolean;
  model?: string;
  monitorId: string;
  monitorThreadId: string;
  monitorTurnId?: string;
  parentThreadId: string;
  serviceTier?: string;
  source: ThreadUsageLineRecord["source"];
  usage: TaskMonitorUsageSnapshot;
}): ThreadUsageLineRecord {
  const tokenUsage = params.usage.tokenUsage;
  const inputTokens = Math.max(0, tokenUsage.inputTokens ?? 0);
  const cachedInputTokens = Math.min(
    inputTokens,
    Math.max(0, tokenUsage.cachedInputTokens ?? 0),
  );
  const uncachedInputTokens = Math.max(
    0,
    tokenUsage.uncachedInputTokens ?? inputTokens - cachedInputTokens,
  );
  const outputTokens = Math.max(0, tokenUsage.outputTokens ?? 0);
  const reasoningOutputTokens = Math.max(0, tokenUsage.reasoningOutputTokens ?? 0);
  const totalTokens = Math.max(
    0,
    tokenUsage.totalTokens ?? inputTokens + outputTokens + reasoningOutputTokens,
  );
  const model = params.model ?? params.usage.model ?? params.usage.cost?.model;
  const cost = estimateOpenAiTokenUsageCost({
    cachedInputTokens,
    fastMode: params.fastMode,
    model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });
  const pricingServiceTier = resolveOpenAiPricingServiceTier({
    fastMode: params.fastMode,
    serviceTier: params.serviceTier,
  });
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost
      ? undefined
      : !model
        ? "missing-model"
        : pricingServiceTier === undefined
          ? "unsupported-service-tier"
          : "missing-rate";

  return {
    backend: params.backend,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens,
    createdAt: Date.now(),
    currency: cost?.currency ?? "USD",
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    inputTokens,
    ...(model ? { model } : {}),
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens,
    parentThreadId: params.parentThreadId,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? "openai",
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    reasoningOutputTokens,
    scope: "monitor",
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    settingsConfidence: model ? "fallback" : "unknown",
    settingsSource: "monitor",
    source: params.source,
    sourceItemId: params.monitorId,
    status: "finalized",
    threadId: params.monitorThreadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    ...(params.monitorTurnId ? { turnId: params.monitorTurnId } : {}),
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens,
    usageLineId: [
      params.backend,
      params.parentThreadId,
      params.monitorId,
      params.monitorThreadId,
      params.monitorTurnId ?? "no-turn",
      "monitor",
    ].join(":"),
  };
}

function findNestedUsageValue(value: unknown, keys: string[]): unknown {
  const record = readRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  for (const child of Object.values(record)) {
    const nested = findNestedUsageValue(child, keys);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function readUsageString(value: unknown, keys: string[]): string | undefined {
  const nested = findNestedUsageValue(value, keys);
  return typeof nested === "string" && nested.trim() ? nested.trim() : undefined;
}

function readUsageBoolean(value: unknown, keys: string[]): boolean | undefined {
  const nested = findNestedUsageValue(value, keys);
  return typeof nested === "boolean" ? nested : undefined;
}

function readTaskMonitorUsageModel(params: {
  notificationModel?: unknown;
  tokenUsage: unknown;
}): string | undefined {
  return (
    (typeof params.notificationModel === "string" && params.notificationModel.trim()
      ? params.notificationModel.trim()
      : undefined) ??
    readUsageString(params.tokenUsage, ["model", "modelId", "model_id"])
  );
}

function readTaskMonitorUsageServiceTier(tokenUsage: unknown): string | undefined {
  return readUsageString(tokenUsage, ["serviceTier", "service_tier"]);
}

function readTaskMonitorUsageFastMode(tokenUsage: unknown): boolean | undefined {
  return readUsageBoolean(tokenUsage, ["fastMode", "fast_mode"]);
}

function logUnpricedThreadUsageLine(line: ThreadUsageLineRecord): void {
  if (line.priceStatus !== "unpriced") {
    return;
  }
  backendRegistryLog.warn("thread usage line persisted without list price", {
    backend: line.backend,
    cachedInputTokens: line.cachedInputTokens,
    fastMode: line.fastMode,
    model: line.model,
    outputTokens: line.outputTokens,
    parentThreadId: line.parentThreadId,
    priceUnavailableReason: line.priceUnavailableReason,
    reasoningEffort: line.reasoningEffort,
    reasoningOutputTokens: line.reasoningOutputTokens,
    scope: line.scope,
    serviceTier: line.serviceTier,
    settingsConfidence: line.settingsConfidence,
    settingsSource: line.settingsSource,
    source: line.source,
    threadId: line.threadId,
    turnId: line.turnId,
    uncachedInputTokens: line.uncachedInputTokens,
    usageLineId: line.usageLineId,
  });
}

function readUuidV7Timestamp(id: string | undefined): number | undefined {
  if (!id) {
    return undefined;
  }
  const hex = id.replace(/-/g, "").slice(0, 12);
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) {
    return undefined;
  }
  const timestamp = Number.parseInt(hex, 16);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function resolveLiveThreadUsageTiming(params: {
  overlay?: ThreadOverlayState;
  turnId?: string;
}): {
  completedAt?: number;
  createdAt?: number;
  startedAt?: number;
} {
  if (!params.turnId) {
    return {};
  }

  const activity = params.overlay?.immutableUsageActivities?.find(
    (entry) => entry.turn?.id === params.turnId,
  );
  const turn = activity?.turn;
  const startedAt = turn?.startedAt ?? readUuidV7Timestamp(params.turnId);
  const completedAt = turn?.completedAt;
  const createdAt = completedAt ?? activity?.createdAt;
  return {
    ...(typeof completedAt === "number" ? { completedAt } : {}),
    ...(typeof createdAt === "number" ? { createdAt } : {}),
    ...(typeof startedAt === "number" ? { startedAt } : {}),
  };
}

function buildLiveThreadUsageLine(params: {
  backend: AppServerBackendKind;
  cumulativeTokenUsage?: TaskMonitorTokenUsageBreakdown;
  completedAt?: number;
  createdAt?: number;
  fastMode?: boolean;
  model?: string;
  serviceTier?: string;
  startedAt?: number;
  threadId: string;
  tokenUsage: unknown;
  turnId?: string;
}): ThreadUsageLineRecord | undefined {
  const tokens = normalizeTaskMonitorTokenUsage(params.tokenUsage);
  if (!tokens) {
    return undefined;
  }

  const {
    cachedInputTokens,
    inputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    uncachedInputTokens,
  } = normalizeTaskMonitorPricingTokens(tokens);
  const cumulativeTokens = params.cumulativeTokenUsage
    ? normalizeTaskMonitorPricingTokens(params.cumulativeTokenUsage)
    : undefined;
  const cost = estimateOpenAiTokenUsageCost({
    cachedInputTokens,
    fastMode: params.fastMode,
    model: params.model,
    outputTokens,
    reasoningOutputTokens,
    serviceTier: params.serviceTier,
    uncachedInputTokens,
  });
  const cumulativeCost = cumulativeTokens
    ? estimateOpenAiTokenUsageCost({
        cachedInputTokens: cumulativeTokens.cachedInputTokens,
        fastMode: params.fastMode,
        model: params.model,
        outputTokens: cumulativeTokens.outputTokens,
        reasoningOutputTokens: cumulativeTokens.reasoningOutputTokens,
        serviceTier: params.serviceTier,
        uncachedInputTokens: cumulativeTokens.uncachedInputTokens,
      })
    : undefined;
  const pricingServiceTier = resolveOpenAiPricingServiceTier({
    fastMode: params.fastMode,
    serviceTier: params.serviceTier,
  });
  const priceUnavailableReason: ThreadUsageLineRecord["priceUnavailableReason"] | undefined =
    cost
      ? undefined
      : !params.model
        ? "missing-model"
        : pricingServiceTier === undefined
          ? "unsupported-service-tier"
          : "missing-rate";

  return {
    backend: params.backend,
    cachedInputCostMicros: cost?.cachedInputCostMicros ?? 0,
    cachedInputTokens,
    ...(typeof params.completedAt === "number" ? { completedAt: params.completedAt } : {}),
    createdAt: params.createdAt ?? params.completedAt ?? Date.now(),
    currency: cost?.currency ?? "USD",
    ...(cumulativeTokens
      ? {
          cumulativeCachedInputTokens: cumulativeTokens.cachedInputTokens,
          cumulativeInputTokens: cumulativeTokens.inputTokens,
          cumulativeOutputTokens: cumulativeTokens.outputTokens,
          cumulativeReasoningOutputTokens: cumulativeTokens.reasoningOutputTokens,
          ...(cumulativeCost
            ? { cumulativeTotalCostMicros: cumulativeCost.totalCostMicros }
            : {}),
          cumulativeTotalTokens: cumulativeTokens.totalTokens,
          cumulativeUncachedInputTokens: cumulativeTokens.uncachedInputTokens,
        }
      : {}),
    ...(params.fastMode !== undefined ? { fastMode: params.fastMode } : {}),
    inputTokens,
    ...(params.model ? { model: params.model } : {}),
    outputCostMicros: cost?.outputCostMicros ?? 0,
    outputTokens,
    priceStatus: cost ? "priced" : "unpriced",
    ...(priceUnavailableReason ? { priceUnavailableReason } : {}),
    provider: cost?.provider ?? "openai",
    ...(cost?.catalogId ? { pricingCatalogId: cost.catalogId } : {}),
    ...(cost?.catalogVersion ? { pricingCatalogVersion: cost.catalogVersion } : {}),
    ...(cost?.rateId ? { pricingRateId: cost.rateId } : {}),
    reasoningOutputTokens,
    scope: "turn",
    ...(params.serviceTier ? { serviceTier: params.serviceTier } : {}),
    settingsConfidence: params.model ? "fallback" : "unknown",
    settingsSource: "thread-overlay",
    source: "live",
    sourceItemId: "thread-token-usage",
    ...(typeof params.startedAt === "number" ? { startedAt: params.startedAt } : {}),
    status: "pending",
    threadId: params.threadId,
    totalCostMicros: cost?.totalCostMicros ?? 0,
    totalTokens,
    ...(params.turnId ? { turnId: params.turnId } : {}),
    uncachedInputCostMicros: cost?.uncachedInputCostMicros ?? 0,
    uncachedInputTokens,
    usageLineId: [
      params.backend,
      params.threadId,
      params.turnId ?? "no-turn",
      "live-token-usage",
    ].join(":"),
  };
}

function readTurnStatus(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("status" in value)) {
    return undefined;
  }

  const status = value.status;
  return typeof status === "string" ? status : undefined;
}

function turnIdFromStartedNotification(
  notification: {
    params: {
      turnId?: string;
      turn: {
        id: string;
      };
    };
  },
): string {
  return notification.params.turnId ?? notification.params.turn.id;
}

function turnIdFromTerminalNotification(
  notification: {
    params: {
      turnId?: string | null;
      turn?: {
        id?: string | null;
      };
    };
  },
): string | undefined {
  return notification.params.turnId ?? notification.params.turn?.id ?? undefined;
}

function normalizeNotificationTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function completedAtFromTerminalNotification(
  notification: AppServerNotification,
): number | undefined {
  if (
    notification.method !== "turn/completed" &&
    notification.method !== "turn/failed" &&
    notification.method !== "turn/cancelled"
  ) {
    return undefined;
  }

  return normalizeNotificationTimestamp(
    readRecord(notification.params.turn)?.completedAt ??
      readRecord(notification.params.turn)?.completed_at,
  );
}

function finalTextFromTerminalNotification(
  notification: AppServerNotification,
): string | undefined {
  if (notification.method !== "turn/completed") {
    return undefined;
  }
  const completed = notification as Extract<
    AppServerNotification,
    { method: "turn/completed" }
  >;
  const text = completed.params.turn.output
    .filter((item) => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim();
  return text || undefined;
}

function errorMessageFromTerminalNotification(
  notification: AppServerNotification,
): string | undefined {
  if (notification.method !== "turn/failed") {
    return undefined;
  }
  const failed = notification as Extract<
    AppServerNotification,
    { method: "turn/failed" }
  >;
  return failed.params.turn.error.message;
}

function logBackendLifecycleNotification(
  backend: AppServerBackendKind,
  notification: AppServerNotification,
): void {
  if (
    notification.method !== "turn/completed" &&
    notification.method !== "turn/failed" &&
    notification.method !== "turn/cancelled" &&
    notification.method !== "thread/status/changed"
  ) {
    return;
  }

  if (notification.method === "thread/status/changed") {
    backendRegistryLog.info("backend lifecycle notification", {
      backend,
      method: notification.method,
      status: readStatusType(notification.params.status),
      threadId: notification.params.threadId,
    });
    return;
  }

  if (
    notification.method === "turn/completed" ||
    notification.method === "turn/failed" ||
    notification.method === "turn/cancelled"
  ) {
    backendRegistryLog.info("backend lifecycle notification", {
      backend,
      method: notification.method,
      status: readTurnStatus(notification.params.turn),
      threadId: notification.params.threadId,
      turnId: notification.params.turnId,
    });
  }
}

function mergeMethods(results: InitializeResult[]): string[] {
  return [...new Set(results.flatMap((result) => result.methods ?? []))];
}

function inferSupportsReasoning(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsReasoning === "boolean") {
    return model.supportsReasoning;
  }

  const id = model.id.toLowerCase();
  if (backend === "grok") {
    return id.includes("reasoning");
  }

  return id.startsWith("gpt-5") || id.startsWith("o");
}

function inferSupportsFast(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsFast === "boolean") {
    return model.supportsFast;
  }

  const id = model.id.toLowerCase();
  return backend === "codex" && (id === "gpt-5.5" || id === "gpt-5.4");
}

function inferSupportsSteering(
  backend: AppServerBackendKind,
  model: BackendModelOption,
): boolean {
  if (typeof model.supportsSteering === "boolean") {
    return model.supportsSteering;
  }

  return backend === "codex";
}

function getBackendFallbackModels(backend: AppServerBackendKind): BackendModelOption[] {
  return backend === "codex" ? OPENAI_FALLBACK_MODELS : GROK_FALLBACK_MODELS;
}

function getPreferredModelId(backend: AppServerBackendKind): string {
  return backend === "codex" ? "gpt-5.5" : "grok-4.20-reasoning";
}

function dedupeModelOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
): BackendModelOption[] {
  const byId = new Map<string, BackendModelOption>();
  for (const model of models) {
    if (!model.id.trim()) {
      continue;
    }

    const normalizedModel = {
      ...model,
      supportsReasoning: inferSupportsReasoning(backend, model),
      supportsFast: inferSupportsFast(backend, model),
      supportsSteering: inferSupportsSteering(backend, model),
    };
    const current = byId.get(model.id);
    byId.set(model.id, {
      ...current,
      ...normalizedModel,
      current: current?.current || normalizedModel.current,
      supportsReasoning: current?.supportsReasoning || normalizedModel.supportsReasoning,
      supportsFast: current?.supportsFast || normalizedModel.supportsFast,
      supportsSteering: current?.supportsSteering || normalizedModel.supportsSteering,
    });
  }

  const deduped = [...byId.values()];
  if (deduped.some((model) => model.current)) {
    return deduped;
  }

  const preferredModelId = getPreferredModelId(backend);
  return deduped.map((model) => ({
    ...model,
    current: model.id === preferredModelId,
  }));
}

function buildLaunchpadOptions(
  backend: AppServerBackendKind,
  models: BackendModelOption[],
  options: { allowFallbackModels?: boolean } = {},
): BackendLaunchpadOptions | undefined {
  const allowFallbackModels = options.allowFallbackModels ?? true;
  const normalizedModels = dedupeModelOptions(
    backend,
    models.length > 0
      ? models
      : allowFallbackModels
        ? getBackendFallbackModels(backend)
        : [],
  );
  if (normalizedModels.length === 0) {
    return undefined;
  }

  const supportsReasoning = normalizedModels.some((model) => model.supportsReasoning);
  const supportsFastMode =
    backend === "codex" && normalizedModels.some((model) => model.supportsFast);

  return {
    models: normalizedModels,
    reasoningEfforts: supportsReasoning
      ? backend === "codex"
        ? OPENAI_REASONING_EFFORTS
        : GROK_REASONING_EFFORTS
      : undefined,
    supportsFastMode,
  };
}

async function readClientModels(client: BackendClient): Promise<BackendModelOption[]> {
  if (!client.listModels) {
    return [];
  }
  return await client.listModels();
}

async function readClientAccount(
  client: BackendClient
): Promise<BackendAccountSummary | undefined> {
  if (!client.readAccount) {
    return undefined;
  }
  return await client.readAccount();
}

function isMeaningfulAccountSummary(
  account: BackendAccountSummary | undefined
): account is BackendAccountSummary {
  return Boolean(
    account?.type ||
      account?.email ||
      account?.planType ||
      typeof account?.requiresOpenaiAuth === "boolean"
  );
}

async function readClientRateLimits(client: BackendClient): Promise<BackendRateLimitSummary[]> {
  if (!client.readRateLimits) {
    return [];
  }
  return await client.readRateLimits();
}

type ModelSettings = {
  model?: string;
  reasoningEffort?: string;
  serviceTier?: string;
  fastMode?: boolean;
};

function hasExplicitModelSettings(settings: ModelSettings): boolean {
  return (
    settings.model !== undefined ||
    settings.reasoningEffort !== undefined ||
    settings.serviceTier !== undefined ||
    settings.fastMode !== undefined
  );
}

type CodexFastModeMismatchWarning = {
  threadId: string;
  turnId: string;
  expectedFastMode: boolean;
  observedFastMode: boolean;
  observedServiceTier?: string | null;
};

type ObservedCodexSettings = {
  fastMode?: boolean;
  serviceTier?: string | null;
  rawServiceTier?: string | null;
  observedAt: number;
};

type ThreadListCallerReason =
  | "archive-cleanup"
  | "branch-drift"
  | "ipc-list-threads"
  | "messaging-navigation-snapshot"
  | "navigation-snapshot"
  | "startup-prewarm"
  | "title-generation"
  | "workspace-handoff"
  | (string & {});

type ThreadListCacheState = {
  expiresAt?: number;
  promise?: Promise<AppServerThreadSummary[]>;
  threads?: AppServerThreadSummary[];
};

type ThreadListCacheHit = {
  cacheKey: string;
  expiresInMs?: number;
  pending: boolean;
  source: "exact" | "navigation-shared";
  threadCount?: number;
  value: Promise<AppServerThreadSummary[]> | AppServerThreadSummary[];
};

let threadListCacheSequence = 0;

function shouldEnrichThreadDirectories(
  callerReason?: ThreadListCallerReason,
): boolean {
  switch (callerReason) {
    case "active-turn-branch-adoption":
    case "branch-drift":
    case "messaging-navigation-snapshot":
    case "navigation-snapshot":
    case "startup-prewarm":
    case "title-generation":
    case "turn-cwd":
      return false;
    default:
      return true;
  }
}

function shouldBackfillCodexDirectoryRelationships(
  callerReason?: ThreadListCallerReason,
): boolean {
  switch (callerReason) {
    case "directory-relationship-reconcile":
    case "messaging-navigation-snapshot":
    case "navigation-snapshot":
    case "startup-prewarm":
      return true;
    default:
      return false;
  }
}

type MessagingArchiveCleanupStore = Pick<
  MessagingStoreLike,
  | "deletePendingIntentsForThread"
  | "findActiveBindingsForBackend"
  | "findActiveBindingsForThread"
  | "revokeBinding"
>;

type MessagingArchiveCleaner = {
  requestBindingRevokeAllForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "thread-archive";
  }): Promise<{
    notifiedCount: number;
    revokedCount: number;
  }>;
};

type MessagingArchiveCleanupResult = {
  notifiedCount?: number;
  pendingIntentCount: number;
  revokedCount: number;
};

function isEmptyDirectoryLaunchpadDraft(launchpad: NavigationLaunchpadDraft): boolean {
  return (
    launchpad.prompt.trim().length === 0 &&
    (launchpad.imageAttachments?.length ?? 0) === 0 &&
    launchpad.settingsTouchedAt === undefined
  );
}

function defaultLaunchpadWorkMode(
  request: Pick<EnsureDirectoryLaunchpadRequest, "directoryKind" | "directoryPath">,
  defaults: NavigationLaunchpadDefaults
): NavigationLaunchpadDraft["workMode"] {
  return request.directoryKind === "directory" && request.directoryPath
    ? defaults.workMode ?? "local"
    : "local";
}

function resolveCodexEnvironmentSelection(
  launchpad: NavigationLaunchpadDraft,
  options: CodexEnvironmentOption[],
): CodexEnvironmentSelection | undefined {
  if (!launchpad.codexEnvironmentId) {
    return undefined;
  }

  const environment = options.find(
    (candidate) => candidate.id === launchpad.codexEnvironmentId,
  );
  if (!environment) {
    return undefined;
  }

  return {
    environment,
    executionTarget: launchpad.codexEnvironmentExecutionTarget ?? "local",
    setupEnabled: Boolean(environment.setupScript),
  };
}

async function resetLaunchpadAfterMaterialize(params: {
  defaults: NavigationLaunchpadDefaults;
  launchpad: NavigationLaunchpadDraft;
  overlayStore: OverlayStoreLike;
}): Promise<void> {
  const { defaults, launchpad, overlayStore } = params;
  await overlayStore.resetDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
  });

  if (!launchpad.codexEnvironmentId) {
    return;
  }

  const now = Date.now();
  await overlayStore.upsertDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
    directoryKind: launchpad.directoryKind,
    directoryLabel: launchpad.directoryLabel,
    directoryPath: launchpad.directoryPath,
    backend: defaults.backend,
    executionMode: defaults.executionMode,
    model: defaults.model,
    reasoningEffort: defaults.reasoningEffort,
    serviceTier: defaults.serviceTier,
    fastMode: defaults.fastMode,
    prompt: "",
    workMode: defaultLaunchpadWorkMode(launchpad, defaults),
    branchName: launchpad.branchName,
    codexEnvironmentId: launchpad.codexEnvironmentId,
    codexEnvironmentExecutionTarget:
      launchpad.codexEnvironmentExecutionTarget ?? "local",
    createdAt: now,
    updatedAt: now,
  });
}

function buildCodexEnvironmentSetupActivity(
  runtime: CodexThreadEnvironmentRuntime | undefined,
): AppServerThreadReplay["entries"][number] | undefined {
  if (!runtime?.setupEnabled || !runtime.setupCommand) {
    return undefined;
  }

  const completed = runtime.setupStatus === "completed";
  const failed = runtime.setupStatus === "failed";
  return {
    type: "activity",
    id: `codex-environment-setup-${runtime.environmentId}`,
    summary: completed
      ? `Environment setup completed: ${runtime.environmentName}`
      : failed
        ? `Environment setup failed: ${runtime.environmentName}`
        : `Environment setup skipped: ${runtime.environmentName}`,
    status: failed ? "failed" : "completed",
    details: [
      {
        id: "setup",
        kind: "command",
        label: "Setup command",
        status: failed ? "failed" : "completed",
        command: {
          displayCommand: runtime.setupCommand,
          rawCommand: runtime.setupCommand,
          cwd: runtime.cwd,
          output: runtime.setupOutput,
          exitCode: runtime.setupExitCode,
          durationMs: runtime.setupDurationMs,
        },
      },
    ],
  };
}

function appendCodexEnvironmentSetupActivity(params: {
  replay: AppServerThreadReplay;
  runtime?: CodexThreadEnvironmentRuntime;
}): AppServerThreadReplay {
  const activity = buildCodexEnvironmentSetupActivity(params.runtime);
  if (!activity) {
    return params.replay;
  }
  if (params.replay.entries.some((entry) => entry.id === activity.id)) {
    return params.replay;
  }
  return {
    ...params.replay,
    entries: [activity, ...params.replay.entries],
  };
}

function createDefaultCodexEnvironmentHydrationStore():
  | CodexEnvironmentHydrationStore
  | undefined {
  try {
    return new CodexEnvironmentHydrationStore(getAppStateDb());
  } catch {
    return undefined;
  }
}

function cloneCodexEnvironmentRuntimeForFork(
  runtime: CodexThreadEnvironmentRuntime,
  cwd?: string,
): CodexThreadEnvironmentRuntime {
  const {
    actionRuns: _actionRuns,
    actionId: _actionId,
    actionName: _actionName,
    actionCommand: _actionCommand,
    actionStatus: _actionStatus,
    actionPid: _actionPid,
    actionStartedAt: _actionStartedAt,
    actionExitedAt: _actionExitedAt,
    actionExitCode: _actionExitCode,
    actionExitSignal: _actionExitSignal,
    actionDurationMs: _actionDurationMs,
    actionOutput: _actionOutput,
    selectedActionIdByEnvironmentId,
    ...rest
  } = runtime;
  const inheritedSelectedActionIdByEnvironmentId =
    selectedActionIdByEnvironmentId ??
    (_actionId ? { [runtime.environmentId]: _actionId } : undefined);
  const next: CodexThreadEnvironmentRuntime = {
    ...rest,
    ...(inheritedSelectedActionIdByEnvironmentId
      ? {
          selectedActionIdByEnvironmentId: {
            ...inheritedSelectedActionIdByEnvironmentId,
          },
        }
      : {}),
    ...(runtime.actions
      ? { actions: runtime.actions.map((action) => ({ ...action })) }
      : {}),
    ...(runtime.shellEnvironment
      ? { shellEnvironment: { ...runtime.shellEnvironment } }
      : {}),
  };
  const trimmedCwd = cwd?.trim();
  if (trimmedCwd) {
    next.cwd = trimmedCwd;
  }
  return next;
}

function readSelectedActionIdByEnvironmentIdForFork(
  runtime: CodexThreadEnvironmentRuntime,
): Record<string, string> | undefined {
  if (runtime.selectedActionIdByEnvironmentId) {
    return { ...runtime.selectedActionIdByEnvironmentId };
  }
  if (runtime.actionId) {
    return { [runtime.environmentId]: runtime.actionId };
  }
  return undefined;
}

function isUsageActivityEntry(
  entry: AppServerThreadEntry,
): entry is AppServerThreadActivityEntry {
  return (
    entry.type === "activity" &&
    (entry.id.startsWith("live-token-usage-") ||
      entry.id.startsWith("live-turn-usage-") ||
      entry.summary.startsWith("Latest request usage:") ||
      entry.summary.startsWith("Turn usage:") ||
      entry.summary.startsWith("Monitor usage:") ||
      entry.summary.startsWith("Usage:"))
  );
}

function usageActivityScope(
  entry: AppServerThreadActivityEntry,
): "latest-request" | "monitor" | "total" | "turn" | undefined {
  if (entry.id.startsWith("live-turn-usage-") || entry.summary.startsWith("Turn usage:")) {
    return "turn";
  }
  if (entry.summary.startsWith("Monitor usage:")) {
    return "monitor";
  }
  if (entry.summary.startsWith("Latest request usage:")) {
    return "latest-request";
  }
  if (entry.summary.startsWith("Usage:")) {
    return "total";
  }
  if (entry.id.startsWith("live-token-usage-")) {
    return "latest-request";
  }
  return undefined;
}

function insertTranscriptEntry(
  entries: AppServerThreadEntry[],
  activity: AppServerThreadActivityEntry,
): AppServerThreadEntry[] {
  const nextEntries = [...entries];
  const turnId = activity.turn?.id;
  if (turnId) {
    const sameTurnIndex = nextEntries.findLastIndex((entry) => entry.turn?.id === turnId);
    if (sameTurnIndex !== -1) {
      nextEntries.splice(sameTurnIndex + 1, 0, activity);
      return nextEntries;
    }
  }

  if (typeof activity.createdAt === "number") {
    const timedIndex = nextEntries.findIndex(
      (entry) =>
        typeof entry.createdAt === "number" &&
        entry.createdAt > (activity.createdAt as number),
    );
    if (timedIndex !== -1) {
      nextEntries.splice(timedIndex, 0, activity);
      return nextEntries;
    }
  }

  nextEntries.push(activity);
  return nextEntries;
}

function mergeImmutableUsageActivities(params: {
  replay: AppServerThreadReplay;
  activities?: AppServerThreadActivityEntry[];
}): AppServerThreadReplay {
  const immutableUsageActivities = params.activities?.filter(
    (activity) => {
      const scope = usageActivityScope(activity);
      return scope === "turn" || scope === "monitor";
    },
  );
  if (!immutableUsageActivities?.length) {
    return params.replay;
  }

  let entries = params.replay.entries;
  for (const activity of immutableUsageActivities) {
    const activityScope = usageActivityScope(activity);
    const activityTurnId = activity.turn?.id;
    entries = entries.filter((entry) => {
      if (entry.id === activity.id) {
        return false;
      }
      if (
        activityScope === "turn" &&
        activityTurnId &&
        isUsageActivityEntry(entry) &&
        entry.turn?.id === activityTurnId
      ) {
        const entryScope = usageActivityScope(entry);
        return entryScope !== "latest-request" && entryScope !== "total";
      }
      return true;
    });
    entries = insertTranscriptEntry(entries, activity);
  }

  return {
    ...params.replay,
    entries,
  };
}

function extractFirstMeaningfulTextInput(input: AppServerTurnInputItem[]): string | undefined {
  const text = input
    .filter((item): item is Extract<AppServerTurnInputItem, { type: "text" }> => item.type === "text")
    .map((item) => item.text.trim())
    .filter(Boolean)
    .join("\n");
  return text || undefined;
}

function buildTitleGenerationKey(
  backend: AppServerBackendKind,
  threadId: string,
): string {
  return `${backend}:${threadId}`;
}

function buildPromptHash(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().toLowerCase();
}

function isEligibleForGeneratedTitle(
  thread: AppServerThreadSummary | undefined,
  prompt: string,
): boolean {
  if (!thread) {
    return true;
  }
  if (isPromptPlaceholderTitle(thread.title, prompt)) {
    return true;
  }
  if (thread.titleSource === "explicit") {
    return false;
  }
  if (isInjectedContextPlaceholderTitle(thread.title)) {
    return true;
  }
  if (thread.titleSource === "fallback") {
    return (
      !isAcpBackendId(thread.source) ||
      isAcpFallbackPlaceholderTitle(thread.title)
    );
  }
  if (isGenericPlaceholderTitle(thread.title)) {
    return true;
  }

  const derivedTitle = shortenDerivedThreadTitle(prompt) ?? prompt;
  return normalizeTitleForComparison(thread.title) === normalizeTitleForComparison(derivedTitle);
}

function normalizeTitleForComparison(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function isPromptPlaceholderTitle(title: string, prompt: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  const normalizedPrompt = normalizeTitleForComparison(prompt);
  const derivedTitle = shortenDerivedThreadTitle(prompt) ?? prompt;
  return (
    normalizedTitle === normalizedPrompt ||
    normalizedTitle === normalizeTitleForComparison(derivedTitle)
  );
}

function isInjectedContextPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return (
    normalizedTitle.startsWith("# agents.md instructions") ||
    normalizedTitle.startsWith("agents.md instructions for")
  );
}

function isAcpFallbackPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return normalizedTitle === "acp session";
}

function isGenericPlaceholderTitle(title: string): boolean {
  const normalizedTitle = normalizeTitleForComparison(title);
  return normalizedTitle === "untitled thread";
}

function truncateLogValue(value: string | undefined): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > 160 ? `${normalized.slice(0, 157)}...` : normalized;
}

function buildTitleEligibilityLogDetails(
  thread: AppServerThreadSummary | undefined,
  prompt: string,
): Record<string, unknown> {
  return {
    currentTitle: truncateLogValue(thread?.title),
    currentTitleSource: thread?.titleSource ?? null,
    promptTitle: truncateLogValue(shortenDerivedThreadTitle(prompt) ?? prompt),
    promptMatchesCurrentTitle: thread ? isPromptPlaceholderTitle(thread.title, prompt) : null,
    injectedContextPlaceholderTitle: thread
      ? isInjectedContextPlaceholderTitle(thread.title)
      : null,
  };
}

function createReplayThreadTitleService(): ThreadTitleService | undefined {
  const title = process.env[REPLAY_THREAD_TITLE_ENV]?.trim();
  if (!title) {
    return undefined;
  }

  return {
    generateTitle: async () => ({
      status: "generated",
      title,
    }),
  };
}

function getDefaultModelOption(
  backend: AppServerBackendKind,
  options?: BackendLaunchpadOptions,
): BackendModelOption | undefined {
  const models = options?.models ?? [];
  if (models.length === 0) {
    return undefined;
  }

  const preferredModelId = getPreferredModelId(backend);
  return (
    models.find((model) => model.current) ??
    models.find((model) => model.id === preferredModelId) ??
    models.find((model) => model.supportsReasoning) ??
    models[0]
  );
}

function getDefaultReasoningEffort(options?: BackendLaunchpadOptions): string | undefined {
  const reasoningEfforts = options?.reasoningEfforts ?? [];
  return reasoningEfforts.includes(DEFAULT_REASONING_EFFORT)
    ? DEFAULT_REASONING_EFFORT
    : reasoningEfforts[0];
}

function resolveModelSettingsFromOptions(
  backend: AppServerBackendKind,
  options: BackendLaunchpadOptions | undefined,
  settings: ModelSettings,
): ModelSettings {
  const models = options?.models ?? [];
  if (models.length === 0 && isAcpBackendId(backend)) {
    return {
      model: settings.model,
      reasoningEffort: undefined,
      serviceTier: settings.serviceTier,
      fastMode: undefined,
    };
  }
  const selectedModel =
    models.find((model) => model.id === settings.model) ??
    getDefaultModelOption(backend, options);
  const supportsReasoning = Boolean(selectedModel?.supportsReasoning);
  const reasoningEfforts = options?.reasoningEfforts ?? [];
  const reasoningEffort = supportsReasoning
    ? reasoningEfforts.includes(settings.reasoningEffort ?? "")
      ? settings.reasoningEffort
      : getDefaultReasoningEffort(options)
    : undefined;
  const supportsFast = backend === "codex" && Boolean(selectedModel?.supportsFast);
  const shouldClearCodexFastTier =
    backend === "codex" &&
    !supportsFast &&
    (settings.serviceTier === "fast" ||
      settings.serviceTier === "priority" ||
      settings.fastMode === false);

  return {
    model: selectedModel?.id,
    reasoningEffort,
    serviceTier: resolveCodexFastModeServiceTier({
      backend,
      serviceTier: settings.serviceTier,
      fastMode: settings.fastMode,
      supportsFast,
    }),
    fastMode: supportsFast
      ? settings.fastMode
      : shouldClearCodexFastTier
        ? false
        : undefined,
  };
}

function resolveCodexFastModeServiceTier(params: {
  backend: AppServerBackendKind;
  fastMode?: boolean;
  serviceTier?: string;
  supportsFast: boolean;
}): string | undefined {
  if (params.backend !== "codex") {
    return params.serviceTier;
  }
  if (params.fastMode === true && params.supportsFast) {
    return "priority";
  }
  if (params.fastMode === false) {
    return params.serviceTier &&
      params.serviceTier !== "fast" &&
      params.serviceTier !== "priority"
      ? params.serviceTier
      : undefined;
  }
  if (
    !params.supportsFast &&
    (params.serviceTier === "fast" || params.serviceTier === "priority")
  ) {
    return undefined;
  }
  return params.serviceTier;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readStringLike(
  record: Record<string, unknown> | undefined,
  keys: string[],
): string | null | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (!(key in record)) {
      continue;
    }
    const value = record[key];
    if (value === null) {
      return null;
    }
    if (typeof value === "string") {
      return value.trim() || null;
    }
  }
  return undefined;
}

function readBooleanLike(
  record: Record<string, unknown> | undefined,
  keys: string[],
): boolean | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function firstDefinedStringLike(
  ...values: Array<string | null | undefined>
): string | null | undefined {
  for (const value of values) {
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function readObservedCodexFastMode(
  notificationParams: unknown,
): { fastMode?: boolean; serviceTier?: string | null } {
  const params = readRecord(notificationParams);
  const turn = readRecord(params?.turn);
  const config = readRecord(params?.config) ?? readRecord(turn?.config);
  const serviceTier = firstDefinedStringLike(
    readStringLike(params, ["serviceTier", "service_tier"]),
    readStringLike(turn, ["serviceTier", "service_tier"]),
    readStringLike(config, ["service_tier", "serviceTier"]),
  );
  if (serviceTier !== undefined) {
    const normalizedServiceTier =
      typeof serviceTier === "string" ? serviceTier.toLowerCase() : serviceTier;
    return {
      fastMode: normalizedServiceTier === "fast" || normalizedServiceTier === "priority",
      serviceTier,
    };
  }

  const fastMode =
    readBooleanLike(params, ["fastMode", "fast_mode"]) ??
    readBooleanLike(turn, ["fastMode", "fast_mode"]) ??
    readBooleanLike(config, ["fastMode", "fast_mode"]);
  return { fastMode };
}

export function getCodexFastModeMismatchWarning(params: {
  expectedFastMode: boolean;
  notificationParams: unknown;
  threadId: string;
  turnId: string;
}): CodexFastModeMismatchWarning | undefined {
  const observed = readObservedCodexFastMode(params.notificationParams);
  if (observed.fastMode === undefined) {
    return undefined;
  }
  if (observed.fastMode === params.expectedFastMode) {
    return undefined;
  }
  return {
    threadId: params.threadId,
    turnId: params.turnId,
    expectedFastMode: params.expectedFastMode,
    observedFastMode: observed.fastMode,
    observedServiceTier: observed.serviceTier,
  };
}

export function buildCodexFastModeMismatchNotificationParams(
  notificationParams: unknown,
  observedSettings?: { fastMode?: boolean; serviceTier?: string | null },
): unknown {
  const base = readRecord(notificationParams) ?? {};
  if (!observedSettings) {
    return base;
  }
  const hasTerminalFastMode =
    "fastMode" in base ||
    "fast_mode" in base ||
    readRecord(base.turn)?.fastMode !== undefined ||
    readRecord(base.turn)?.fast_mode !== undefined;
  const hasTerminalServiceTier =
    "serviceTier" in base ||
    "service_tier" in base ||
    readRecord(base.turn)?.serviceTier !== undefined ||
    readRecord(base.turn)?.service_tier !== undefined;

  return {
    ...base,
    ...(!hasTerminalFastMode && observedSettings.fastMode !== undefined
      ? { fastMode: observedSettings.fastMode }
      : {}),
    ...(!hasTerminalServiceTier && observedSettings.serviceTier !== undefined
      ? { serviceTier: observedSettings.serviceTier }
      : {}),
  };
}

function getAvailableExecutionMode(
  backend: BackendSummary,
  preferred: ThreadExecutionMode,
): ThreadExecutionMode {
  return (
    backend.executionModes.find((mode) => mode.available && mode.mode === preferred)?.mode ??
    backend.executionModes.find((mode) => mode.available && mode.isDefault)?.mode ??
    backend.executionModes.find((mode) => mode.available)?.mode ??
    preferred
  );
}

function launchpadDefaultsEqual(
  left: NavigationLaunchpadDefaults,
  right: NavigationLaunchpadDefaults,
): boolean {
  return (
    left.backend === right.backend &&
    left.executionMode === right.executionMode &&
    left.workMode === right.workMode &&
    left.model === right.model &&
    left.reasoningEffort === right.reasoningEffort &&
    left.serviceTier === right.serviceTier &&
    left.fastMode === right.fastMode &&
    JSON.stringify(left.acpRuntime ?? {}) === JSON.stringify(right.acpRuntime ?? {})
  );
}

function resolveGrokApiKeyForLiveClient(): string | undefined {
  try {
    return getDesktopSettingsService().resolveGrokApiKeySync();
  } catch (error) {
    backendRegistryLog.warn("grok_api_key_unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

function buildCodexParentDynamicToolSpecs(
  agentToolCatalogs: Array<{ dynamicTools: CodexDynamicToolSpec[] }> = [],
): CodexDynamicToolSpec[] {
  return [
    ...agentToolCatalogs.flatMap((catalog) => catalog.dynamicTools),
    ...buildTaskMonitorDynamicToolSpecs("parent"),
  ];
}

export class DesktopBackendRegistry {
  private readonly codexClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly overlayStore: OverlayStoreLike;
  private readonly gitDirectoryService: GitDirectoryService;
  private readonly gitWorkingStateService: GitWorkingStateService;
  private readonly gitWorkspaceHandoffService: GitWorkspaceHandoffService;
  private readonly worktreeArchiveService: WorktreeArchiveService;
  private readonly acpBackend: AcpBackendAdapter;
  // Resolves a managed-worktree ACP cwd to its repository checkout so ACP
  // (e.g. Grok) worktree threads group under the same directory row as their
  // repo, exactly like Codex threads do. Codex backends carry a repo-rooted
  // linked directory from their own enricher; ACP sessions only know their cwd,
  // so without this every ACP worktree session lands in its own folder. Pure
  // filesystem — follows the worktree's `.git` link and NEVER spawns git. The
  // repo↔worktree mapping is immutable, so the result is cached durably on the
  // thread overlay (`acpWorktreeDirectory`) and this resolver only runs on the
  // first sighting of a given cwd. Injectable for deterministic tests.
  private readonly acpWorktreeRepositoryResolver: (
    cwd: string,
  ) => Promise<LinkedDirectorySummary | undefined>;
  private readonly messagingStore?: MessagingArchiveCleanupStore | null;
  private messagingArchiveCleaner?: MessagingArchiveCleaner | null;
  private readonly archivedMessagingCleanupInFlight = new Map<
    string,
    Promise<MessagingArchiveCleanupResult>
  >();
  private readonly archivedMessagingCleanupCompleted = new Set<string>();
  private readonly archivedMessagingCleanupGeneration = new Map<string, number>();
  private readonly createScratchProjectDirectory: () => Promise<string>;
  private readonly threadTitleGenerationService?: ThreadTitleService;
  private readonly modelCatalog: BackendModelCatalog;
  private readonly codexEnvironmentCommandEnv?: NodeJS.ProcessEnv;
  private readonly codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  private readonly codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;
  private readonly threadListCacheOwnerId = `backend-thread-list-cache-${++threadListCacheSequence}`;
  private readonly threadListCache = new Map<string, ThreadListCacheState>();
  private readonly activeThreadIdsByBackend = new Map<AppServerBackendKind, Set<string>>();
  private readonly pendingStartedThreads = new Map<string, AppServerThreadSummary>();
  private readonly captureStores: ProtocolCaptureStore[] = [];
  private readonly eventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private latestCodexConfigWarning?: AgentEvent;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly pendingServerRequests = new Map<string, PendingServerRequest>();
  private readonly pendingTitleGenerations = new Map<
    string,
    {
      promptHash: string;
      token: number;
    }
  >();
  private readonly activeCodexTurnModes = new Map<string, ThreadExecutionMode>();
  private readonly activeCodexReviewTurnKeys = new Set<string>();
  private readonly activeCodexReviewInterruptTurnIds = new Map<string, string>();
  private readonly activeReviewSubAgents = new Map<string, ReviewSubAgentRecord>();
  private readonly reviewSubAgentsByReviewTurn = new Map<
    string,
    ReviewSubAgentRecord
  >();
  private readonly observedCodexSettingsByThread = new Map<string, ObservedCodexSettings>();
  private readonly reservedCodexStartThreadIds = new Set<string>();
  private readonly reservedAcpStartThreadKeys = new Set<string>();
  private readonly activeTurnKeys = new Set<string>();
  private readonly liveThreadUsageBaselines = new Map<
    string,
    TaskMonitorTokenUsageBreakdown
  >();
  private readonly taskMonitorDelegations = new Map<
    string,
    TaskMonitorDelegationRecord
  >();
  private readonly taskMonitorWatchdogTimer?: NodeJS.Timeout;
  /**
   * Best-effort cache of thread labels keyed by `${backend}:${threadId}`, used
   * only to label native attention/terminal notifications so multiple
   * background turns are distinguishable. Populated from `thread/started` and
   * `thread/name/updated` notifications as they fan out through `emit()`.
   * Falls back to a thread-list lookup, then a generic body when context still
   * isn't available.
   */
  private readonly notificationThreadTitles = new Map<string, string>();
  private readonly notificationThreadProjectLabels = new Map<string, string>();
  private hasLoggedNotificationsEnabledError = false;
  private readonly threadTurnQueue: ThreadTurnQueue;
  private automationInspectionHandler?: AutomationInspectionHandler;
  private messagingAgentToolService?: MessagingAgentToolService;
  private readonly messagingHandler: PwrAgentMessagingHandler =
    async (request) => {
      if (!this.messagingAgentToolService) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "PwrAgent messaging context tools are not available.",
          },
        };
      }
      return await this.messagingAgentToolService.handlePwrAgentMessagingRequest(
        request,
      );
    };
  private readonly threadInspectionHandler: PwrAgentThreadInspectionHandler =
    async (request) => await this.handleThreadInspectionRequest(request);
  private threadInspectionSearchService: ThreadSearchService | null | undefined;
  private readonly headlessAutomationTurns = new Map<
    string,
    {
      agentThreadId: string;
      automationName?: string;
      automationRunId: string;
      executionMode: ThreadExecutionMode;
      queueEntryId: string;
    }
  >();
  /**
   * In-memory queue of pending permission-mode changes, keyed by
   * threadId. Populated when a user toggles execution mode while a turn
   * is active; flushed at the resume boundary (turn-end, or just before
   * the next turn-start). Not persisted across app restart by design —
   * the corresponding audit-log entries on overlay state carry the
   * historical record.
   */
  private readonly queuedExecutionModes = new Map<
    string,
    {
      backend: AppServerBackendKind;
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    }
  >();
  private readonly queuedExecutionModeFlushes = new Map<string, Promise<void>>();
  private readonly acpSessionPromptLocks = new PerKeyAsyncLock();
  private readonly queuedAcpRuntimeOptions = new Map<
    string,
    {
      source: BackendAcpRuntimeOptionSource;
      optionId: string;
      value: string;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    }
  >();
  private readonly queuedAcpRuntimeOptionFlushes = new Map<string, Promise<void>>();
  /**
   * Per-thread async chain serialising read-modify-write of
   * codexEnvironmentRuntime. Concurrent Run-button clicks and
   * concurrent detached-child exit/output callbacks all funnel through
   * this so two simultaneous overlay writes can't clobber each other.
   * Keyed by `${backend}:${threadId}`. Implementation details and
   * failure-poisoning semantics live in PerKeyAsyncLock.
   */
  private readonly codexEnvironmentRuntimeLocks = new PerKeyAsyncLock();
  private readonly attemptedTitleGenerations = new Set<string>();
  private readonly repairedDirectoryThreadKeys = new Set<string>();
  private readonly failedDirectoryRelationshipLogKeys = new Set<string>();
  private fullDirectoryReconcileDispatched = false;
  private titleGenerationSequence = 0;
  /**
   * Gate for the Codex `listThreads` probe. Returns `true` while the
   * first-run wizard is still asking the operator which Codex profile
   * model to use; in that window we must not slurp Codex threads under
   * an arbitrary identity. Tests inject a fixed value; production wires
   * it to `DesktopSettingsService.isCodexBootstrapDeferred`, which is
   * itself dormant (always returns `false`) until the wizard PR flips
   * `ONBOARDING_CODEX_GATE_ENABLED`.
   */
  private readonly isCodexBootstrapDeferredFn: () => boolean;
  private readonly resolveCodexDefaultModeRequestUserInputFn: () => boolean;
  /**
   * Reports whether the registry is running inside the throwaway
   * bootstrap profile (`.bootstrap/`). When `true`, `listThreads`
   * hard-fails to an empty result regardless of any other gate —
   * the bootstrap profile's `models.codex.profile` is unset and
   * would otherwise resolve to the operator's real Codex install,
   * leaking their real thread list into the to-be-discarded
   * bootstrap window. Tests inject a fixed value; production wires
   * it to `state/app-state.getAppStateMode()`.
   */
  private readonly isBootstrapModeFn: () => boolean;

  constructor(options?: {
    codexClient?: BackendClient;
    grokClient?: BackendClient;
    overlayStore?: OverlayStoreLike;
    gitDirectoryService?: GitDirectoryService;
    gitWorkingStateService?: GitWorkingStateService;
    gitWorkspaceHandoffService?: GitWorkspaceHandoffService;
    worktreeArchiveService?: WorktreeArchiveService;
    acpAgentStore?: AcpBackendAdapterOptions["acpAgentStore"];
    acpSessionStore?: AcpSessionStoreLike | null;
    discoverLocalAcpAgents?: LocalAcpDiscovery;
    createAcpClient?: AcpClientFactory;
    messagingStore?: MessagingArchiveCleanupStore | null;
    messagingArchiveCleaner?: MessagingArchiveCleaner | null;
    automationInspectionMcpCommand?: string;
    createScratchProjectDirectory?: () => Promise<string>;
    codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
    codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;
    threadTitleGenerationService?: ThreadTitleService | null;
    threadSearchService?: ThreadSearchService | null;
    isCodexBootstrapDeferred?: () => boolean;
    isBootstrapMode?: () => boolean;
    resolveCodexDefaultModeRequestUserInput?: () => boolean;
    acpWorktreeRepositoryResolver?: (
      cwd: string,
    ) => Promise<LinkedDirectorySummary | undefined>;
  }) {
    const replayClients = createReplayClientsFromEnv();
    const codexCapture = options?.codexClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "codex",
          backendInstance: "default",
        });
    if (codexCapture) {
      this.captureStores.push(codexCapture.store);
    }
    const codexObserver = createCompositeJsonRpcObserver([
      codexCapture?.observer,
      createProtocolLogObserverFromEnv({
        backend: "codex",
      }),
    ]);
    const grokCapture = options?.grokClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "grok",
          backendInstance: "default",
        });
    if (grokCapture) {
      this.captureStores.push(grokCapture.store);
    }
    const grokObserver = createCompositeJsonRpcObserver([
      grokCapture?.observer,
      createProtocolLogObserverFromEnv({
        backend: "grok",
      }),
    ]);
    const createsLiveCodexClient =
      !options?.codexClient && !replayClients?.codexClient;
    const settingsService = createsLiveCodexClient
      ? getDesktopSettingsService()
      : undefined;
    this.resolveCodexDefaultModeRequestUserInputFn =
      options?.resolveCodexDefaultModeRequestUserInput ??
      (() => {
        try {
          return (
            settingsService?.resolveCodexDefaultModeRequestUserInput() ?? false
          );
        } catch (error) {
          backendRegistryLog.warn(
            "failed to resolve Codex default-mode request_user_input setting",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return false;
        }
      });
    const codexCommand = settingsService?.resolveCodexCommandPreference();
    const codexEnv =
      typeof settingsService?.resolveCodexSpawnEnv === "function"
        ? settingsService.resolveCodexSpawnEnv()
        : undefined;
    this.codexEnvironmentCommandEnv = codexEnv;
    this.codexEnvironmentCommandRunner = options?.codexEnvironmentCommandRunner;
    this.codexEnvironmentHydrationStore =
      options?.codexEnvironmentHydrationStore ??
      createDefaultCodexEnvironmentHydrationStore();
    const codexHome = codexEnv?.CODEX_HOME?.trim() || undefined;
    const createsLiveGrokClient = !options?.grokClient && !replayClients?.grokClient;
    const grokApiKey = createsLiveGrokClient
      ? resolveGrokApiKeyForLiveClient()
      : undefined;

    const clientVersion =
      typeof app?.getVersion === "function" ? app.getVersion() : "0.0.0";
    this.codexClient =
      options?.codexClient ??
      replayClients?.codexClient ??
      new CodexAppServerClient({
        args: settingsService ? undefined : buildCodexClientArgs(codexEnv),
        command: codexCommand,
        connectionObserver: codexObserver,
        env: codexEnv,
        resolveArgs: settingsService
          ? async (env) => buildCodexClientArgs(env)
          : undefined,
        resolveEnv: settingsService
          ? async () => await settingsService.resolveCodexSpawnEnvAsync()
          : undefined,
        clientVersion,
        // Fire the gate at the client level too, not just the
        // listThreads layer. Without this, `describeCodexBackend`
        // (called by `listBackends` on app startup) would call
        // `ensureInitialized` → spawn the Codex CLI subprocess —
        // even on a fresh PwrAgent profile mid-wizard, and on
        // machines where the operator doesn't have Codex installed
        // yet. The client throws `CodexBootstrapDeferredError` which
        // `describeCodexBackend` catches via `Promise.allSettled` and
        // surfaces as `available: false` with a clean reason.
        isCodexBootstrapDeferred: () => this.isCodexBootstrapDeferredFn(),
      });
    this.grokClient =
      options?.grokClient ??
      replayClients?.grokClient ??
      new GrokAppServerClient({
        apiKey: grokApiKey,
        connectionObserver: grokObserver,
      });
    this.acpWorktreeRepositoryResolver =
      options?.acpWorktreeRepositoryResolver ??
      resolveWorktreeRepositoryDirectory;
    this.overlayStore = options?.overlayStore ?? getDesktopOverlayStore();
    this.gitDirectoryService =
      options?.gitDirectoryService ??
      new GitDirectoryService({
        codexHome,
        gitEnv: codexEnv,
        resolveWorktreeStorage: () =>
          getDesktopSettingsService().resolveWorktreeStorage(),
      });
    this.gitWorkingStateService =
      options?.gitWorkingStateService ??
      new GitWorkingStateService({ gitEnv: codexEnv });
    this.worktreeArchiveService =
      options?.worktreeArchiveService ??
      new WorktreeArchiveService({ gitEnv: codexEnv });
    this.acpBackend = new AcpBackendAdapter({
      acpAgentStore: options?.acpAgentStore,
      acpSessionStore: options?.acpSessionStore,
      captureStores: this.captureStores,
      createAcpClient: options?.createAcpClient,
      discoverLocalAcpAgents: options?.discoverLocalAcpAgents,
      emit: async (event) => await this.emit(event),
      handleServerRequest: async (backend, request) =>
        await this.handleServerRequest(backend, request),
      automationInspectionMcpCommand:
        options?.automationInspectionMcpCommand ??
        resolveAutomationInspectionMcpCommand(),
    });
    this.messagingStore = options?.messagingStore;
    this.messagingArchiveCleaner = options?.messagingArchiveCleaner;
    this.gitWorkspaceHandoffService =
      options?.gitWorkspaceHandoffService ??
      new GitWorkspaceHandoffService({
        gitEnv: codexEnv,
        worktreeArchiveService: this.worktreeArchiveService,
        resolveWorktreeStorage: () =>
          getDesktopSettingsService().resolveWorktreeStorage(),
      });
    this.createScratchProjectDirectory =
      options?.createScratchProjectDirectory ?? createScratchProjectDirectory;
    this.threadTitleGenerationService =
      options?.threadTitleGenerationService === null
        ? undefined
        : options?.threadTitleGenerationService ??
          (replayClients
            ? createReplayThreadTitleService()
            : new ThreadTitleGenerationService({
                generators: {
                  codex: this.codexClient.generateTitle
                    ? {
                        generateTitle: (params) =>
                          this.codexClient.generateTitle!(params),
                      }
                    : undefined,
                  grok: createsLiveGrokClient
                    ? new GrokThreadTitleGenerator({
                        apiKey: grokApiKey,
                      })
                    : undefined,
                },
              }));
    this.threadInspectionSearchService =
      options && "threadSearchService" in options
        ? options.threadSearchService ?? null
        : options?.codexClient || options?.grokClient || replayClients
          ? null
          : undefined;
    this.modelCatalog = new BackendModelCatalog({
      codex: this.codexClient,
      grok: this.grokClient,
    });
    this.threadTurnQueue = new ThreadTurnQueue({
      startTurn: async (entry) => await this.startTurnNow(entry),
      isThreadActive: ({ backend, threadId }) =>
        backend === "codex" ? this.threadHasActiveTurn(threadId) : false,
      onLifecycle: async (event) => await this.emitTurnQueueLifecycle(event),
    });
    this.taskMonitorWatchdogTimer = setInterval(() => {
      void this.checkStaleTaskMonitors().catch((error) => {
        backendRegistryLog.warn("task monitor stale watchdog failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, TASK_MONITOR_STALE_CHECK_INTERVAL_MS);
    this.taskMonitorWatchdogTimer.unref?.();

    this.isCodexBootstrapDeferredFn =
      options?.isCodexBootstrapDeferred ??
      (() => {
        try {
          return getDesktopSettingsService().isCodexBootstrapDeferred();
        } catch (error) {
          // The settings singleton can only throw if app-state init
          // never ran. That should not be reachable in production —
          // `initializeAppState()` runs before any IPC handler that
          // reaches the registry. If it does happen, default to "gate
          // off" so we fall back to the historical behavior (Codex
          // prewarm runs) rather than presenting an empty sidebar that
          // the operator has no way to unstick. Surface the failure
          // loudly so the underlying init bug is fixable.
          backendRegistryLog.warn(
            "isCodexBootstrapDeferred fell back to false; settings service unavailable",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return false;
        }
      });
    this.isBootstrapModeFn =
      options?.isBootstrapMode ?? (() => getAppStateMode() === "bootstrap");

    this.subscribeClient("codex", this.codexClient);
    this.subscribeClient("grok", this.grokClient);

    // Kick off a one-shot scan of persisted codexEnvironmentRuntime
    // entries: zombie "started" runs from a prior session become
    // "failed", and output bytes get cleared on anything finished
    // before this session started. Fire-and-forget — the renderer's
    // session-startedAt filter already hides stale entries from view,
    // so this is purely about reclaiming sqlite bytes and tidying
    // persisted state. Errors are swallowed; this can't break startup.
    void this.cleanupStaleCodexEnvironmentRuntimes().catch((error) => {
      backendRegistryLog.warn("codex-environment-startup-cleanup-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * Captured at registry construction. Action-run entries from before
   * this moment are treated as historical: their `output` is shed and
   * any "started" entries are downgraded to "failed", since the child
   * process didn't survive the parent restart.
   */
  private readonly registrySessionStartedAt = Date.now();

  private async cleanupStaleCodexEnvironmentRuntimes(): Promise<void> {
    const lister = this.overlayStore.listThreadOverlaysWithCodexEnvironmentRuntime;
    if (!lister) {
      // Test overlay mocks or older overlay-store implementations may
      // not expose the bulk reader. Skip cleanup silently.
      return;
    }
    const overlays = await lister.call(this.overlayStore);
    const sessionStartedAt = this.registrySessionStartedAt;
    let cleanedThreads = 0;
    let bytesShed = 0;
    let zombiesConverted = 0;
    for (const overlayHint of overlays) {
      // Run each thread's clean under the per-thread lock and re-read
      // overlay state inside it, so a concurrent runCodexEnvironmentAction
      // can't append a fresh run that we then overwrite with a stale
      // snapshot. The hint we got from `lister` is point-in-time; the
      // re-read is the source of truth.
      await this.withCodexEnvironmentRuntimeLock(
        overlayHint.backend,
        overlayHint.threadId,
        async () => {
          const overlay = await this.overlayStore.getThreadOverlayState({
            backend: overlayHint.backend,
            threadId: overlayHint.threadId,
          });
          const runtime = overlay?.codexEnvironmentRuntime;
          if (!runtime) return;
          const runs = readCodexEnvironmentActionRuns(runtime);
          if (runs.length === 0) return;
          let changed = false;
          const nextRuns = runs.map((run) => {
        // For "started" runs, decide ownership by timestamp: anything
        // started before this registry session is a zombie (detached
        // children with piped stdio died via SIGPIPE when the prior
        // process exited). Anything started at or after sessionStartedAt
        // was kicked off by this session and must be left alone — the
        // cleanup is fire-and-forget so a fast user Run-click could
        // land a fresh entry before this iteration commits.
        //
        // Legacy-synthesised runs (from overlays written before
        // actionStartedAt existed) carry startedAt=0, which correctly
        // falls into the "before this session" bucket and gets
        // converted — fixing the regression where the renderer would
        // show a stale, undismissable "running" anchor after a parent
        // crash.
        if (run.status === "started") {
          const startedAt = run.startedAt ?? 0;
          if (startedAt >= sessionStartedAt) {
            return run;
          }
          changed = true;
          bytesShed += run.output?.length ?? 0;
          zombiesConverted += 1;
          return {
            ...run,
            status: "failed" as const,
            output: undefined,
            exitedAt: run.exitedAt ?? run.startedAt ?? sessionStartedAt,
            durationMs:
              run.durationMs ??
              Math.max(0, (run.exitedAt ?? sessionStartedAt) - startedAt),
          };
        }
        // Finished runs: shed bytes only if their latest activity
        // predates this session.
        const latestAt = Math.max(run.exitedAt ?? 0, run.startedAt ?? 0);
        if (latestAt > 0 && latestAt < sessionStartedAt && run.output) {
          changed = true;
          bytesShed += run.output.length;
          return { ...run, output: undefined };
        }
        return run;
      });
          if (!changed) return;
          cleanedThreads += 1;
          const nextRuntime: CodexThreadEnvironmentRuntime = {
            ...runtime,
            actionRuns: nextRuns,
          };
          await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
            backend: overlayHint.backend,
            threadId: overlayHint.threadId,
            codexEnvironmentRuntime: nextRuntime,
          });
        },
      );
    }
    if (cleanedThreads > 0) {
      backendRegistryLog.info("codex-environment-startup-cleanup", {
        cleanedThreads,
        zombiesConverted,
        bytesShed,
        sessionStartedAt,
      });
    }
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  setMessagingArchiveCleaner(
    cleaner: MessagingArchiveCleaner | null | undefined,
  ): void {
    this.messagingArchiveCleaner = cleaner;
  }

  setMessagingAgentToolService(
    service: MessagingAgentToolService | null | undefined,
  ): void {
    this.messagingAgentToolService = service ?? undefined;
  }

  setAutomationInspectionHandler(
    handler: AutomationInspectionHandler | null | undefined,
  ): void {
    this.automationInspectionHandler = handler ?? undefined;
  }

  async publishLocalEvent(event: AgentEvent): Promise<void> {
    await this.emit(event);
  }

  async startAutomationHeadlessTurn(params: {
    backend: AppServerBackendKind;
    agentThreadId: string;
    automationName?: string;
    automationRunId: string;
    input: AppServerTurnInputItem[];
  }): Promise<{
    backend: AppServerBackendKind;
    headlessThreadId: string;
    queueEntryId: string;
    threadId: string;
    turnId: string;
  }> {
    this.assertNotBootstrap("startAutomationHeadlessTurn");
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.agentThreadId,
    });
    const executionMode = overlay?.executionMode ?? "default";
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const approvalPolicy = "never";
    const sandbox = modeSettings.sandbox;
    const modelSettings = await this.resolveModelSettings(params.backend, {
      model: overlay?.model,
      serviceTier: overlay?.serviceTier,
      reasoningEffort: overlay?.reasoningEffort,
      fastMode: params.backend === "codex" ? overlay?.fastMode : undefined,
    });
    const cwd =
      params.backend === "codex"
        ? await this.resolveThreadEnvironmentCwd(
            params.backend,
            params.agentThreadId,
            overlay,
          )
        : undefined;
    const input = prependAutomationRuntimeContext({
      approvalPolicy,
      executionMode,
      input: params.input,
      label: modeSettings.label,
      sandbox,
    });
    const client = this.getClient(params.backend, executionMode);
    const submittedPrompt = extractFirstMeaningfulTextInput(params.input);
    backendRegistryLog.info("starting automation headless thread", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      approvalPolicy,
      backend: params.backend,
      cwd,
      executionMode,
      ephemeral: params.backend === "codex",
      inputItemCount: input.length,
      promptLength: submittedPrompt?.length ?? 0,
      sandbox,
    });
    const headlessThread = await client.startThread({
      ...(cwd ? { cwd } : {}),
      ...modelSettings,
      approvalPolicy,
      ephemeral: params.backend === "codex" ? true : undefined,
      sandbox,
    });
    backendRegistryLog.info("automation headless thread created", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      backend: params.backend,
      executionMode,
      headlessThreadId: headlessThread.threadId,
    });
    const turn = await client.startTurn({
      threadId: headlessThread.threadId,
      input,
      ...(cwd ? { cwd } : {}),
      ...modelSettings,
      approvalPolicy,
      sandbox,
    });
    const queueEntryId = `headless:${params.automationRunId}`;
    backendRegistryLog.info("automation headless turn started", {
      agentThreadId: params.agentThreadId,
      automationName: params.automationName,
      automationRunId: params.automationRunId,
      approvalPolicy,
      backend: params.backend,
      executionMode,
      headlessThreadId: turn.threadId,
      queueEntryId,
      sandbox,
      turnId: turn.turnId,
    });
    this.headlessAutomationTurns.set(
      buildHeadlessAutomationTurnKey(params.backend, turn.threadId, turn.turnId),
      {
        agentThreadId: params.agentThreadId,
        automationName: params.automationName,
        automationRunId: params.automationRunId,
        executionMode,
        queueEntryId,
      },
    );
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: params.agentThreadId,
          queueEntryId,
          origin: "automation",
          automationRunId: params.automationRunId,
          automationName: params.automationName,
          status: "started",
          backendThreadId: turn.threadId,
          turnId: turn.turnId,
        },
      },
    });
    return {
      backend: params.backend,
      headlessThreadId: turn.threadId,
      queueEntryId,
      threadId: params.agentThreadId,
      turnId: turn.turnId,
    };
  }

  private async emitTurnQueueLifecycle(
    event: ThreadTurnQueueLifecycleEvent,
  ): Promise<void> {
    const baseParams = {
      threadId: event.entry.threadId,
      queueEntryId: event.entry.id,
      origin: event.entry.origin,
      automationRunId: event.entry.automationRunId,
      automationName: event.entry.automationName,
    };

    await this.emit({
      backend: event.entry.backend,
      notification: {
        method: "thread/turnQueue/updated",
        params:
          event.type === "queued"
            ? {
                ...baseParams,
                status: "queued",
                position: event.position,
              }
            : event.type === "started"
              ? {
                  ...baseParams,
                  status: "started",
                  turnId: event.turnId,
                }
              : event.type === "failed"
                ? {
                    ...baseParams,
                    status: "failed",
                    errorMessage: event.error.message,
                  }
                : event.type === "cancelled"
                  ? {
                      ...baseParams,
                      status: "cancelled",
                    }
                  : {
                      ...baseParams,
                      status: "terminal",
                      turnId: event.turnId,
                      terminalStatus: event.status,
                    },
      },
    });
  }

  getLatestCodexConfigWarning(): LatestCodexConfigWarningResponse {
    return this.latestCodexConfigWarning
      ? { event: this.latestCodexConfigWarning }
      : {};
  }

  async trustCodexProject(
    request: TrustCodexProjectRequest,
  ): Promise<TrustCodexProjectResponse> {
    if (!this.codexClient.trustProject) {
      throw new Error("Codex project trust is not available.");
    }

    const result = await this.codexClient.trustProject({
      projectPath: request.projectPath,
      ...(request.configPath ? { configPath: request.configPath } : {}),
    });
    if (
      this.latestCodexConfigWarning?.notification.method === "configWarning" &&
      this.latestCodexConfigWarning.notification.params.trustedProjectPath ===
        request.projectPath &&
      (!request.configPath ||
        this.latestCodexConfigWarning.notification.params.configPath ===
          request.configPath)
    ) {
      this.latestCodexConfigWarning = undefined;
    }
    return {
      projectPath: result.projectPath,
      ...(result.configPath ? { configPath: result.configPath } : {}),
      trusted: true,
    };
  }

  async listBackends(
    request: ListBackendsRequest = {}
  ): Promise<ListBackendsResponse> {
    const agentCoreGrokEnabled = resolveAgentCoreGrokEnabled();
    // When the experimental agent-core Grok feature is off, omit the backend
    // entirely rather than emitting a disabled placeholder — a turned-off
    // experimental feature isn't an app server, so it shouldn't clutter the
    // provider list (or any backend picker). Settings → Experimental is where
    // it gets enabled.
    const summaries = (
      await Promise.all([
        this.describeCodexBackend(),
        agentCoreGrokEnabled
          ? this.describeSingleBackend("grok", this.grokClient)
          : Promise.resolve(undefined),
      ])
    ).filter((summary): summary is BackendSummary => summary !== undefined);
    const acpSummaries = await this.acpBackend.describeInstalledBackends();

    return {
      fetchedAt: Date.now(),
      backends: request.includeUnavailable
        ? [...summaries, ...acpSummaries]
        : [...summaries, ...acpSummaries].filter((backend) => backend.available),
    };
  }

  /**
   * Throw if any method that reads or writes Codex thread data is
   * reached in bootstrap mode. Companion to the silent empty-return
   * in `listThreads` — that path needs to keep the sidebar quiet
   * for the focus listener, but explicit operator actions
   * (readThread, startThread, startTurn, startReview,
   * submitServerRequest, repairCodexThreadDirectoryRelationship)
   * should never reach the registry from a bootstrap window. The
   * wizard occupies the entire renderer in bootstrap mode; if any
   * of these fire, it's a code bug and we want a loud failure, not
   * silent contamination of the operator's real Codex install.
   */
  private assertNotBootstrap(method: string): void {
    if (this.isBootstrapModeFn()) {
      throw new Error(
        `backend-registry.${method} is forbidden in bootstrap mode`,
      );
    }
  }

  async listThreads(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
    forceRefresh?: boolean;
  } = {}): Promise<AppServerThreadSummary[]> {
    // Hard gate: the bootstrap profile MUST NEVER serve thread data,
    // regardless of what the bootstrap config.toml's onboarding
    // flags say. Concretely this guards the post-wizard dev window:
    // in dev we leave the bootstrap Electron alive (Vite dev-server
    // race — see ipc/boot-info.ts), and if the operator focuses
    // that window, `useThreadNavigation`'s focus listener triggers
    // a `getNavigationSnapshot` → listThreads call. The bootstrap
    // profile's `models.codex.profile` is unset, which means
    // "use ~/.codex/" — i.e. the operator's real Codex Desktop
    // session, with all their real threads. This check makes that
    // contamination unreachable even if `isCodexBootstrapDeferredFn`
    // gets misconfigured or the onboarding-completed flag gets
    // flipped accidentally on the bootstrap profile.
    if (this.isBootstrapModeFn()) {
      return [];
    }
    // Gate the deferred Codex probe. When the first-run wizard hasn't
    // picked a Codex profile model yet, an explicit codex query returns
    // empty; an unfiltered query falls through to the grok-only path so
    // grok threads still load and the renderer can render a clean
    // "Finish setup to see your threads" empty state for Codex without
    // contaminating it with arbitrary-identity Codex data.
    if (
      (params.backend === "codex" || params.backend === undefined) &&
      this.isCodexBootstrapDeferredFn()
    ) {
      if (params.backend === "codex") {
        return [];
      }
      return await this.listThreads({ ...params, backend: "grok" }).catch(
        () => [],
      );
    }
    const normalizedParams = {
      ...params,
      enrichDirectories:
        params.enrichDirectories ?? shouldEnrichThreadDirectories(params.callerReason),
    };
    const cacheKey = this.buildThreadListCacheKey(normalizedParams);
    const now = Date.now();
    const cached = this.findReusableThreadListCache(normalizedParams, cacheKey, now);
    if (cached) {
      logDebug("threadListCache:hit", {
        archived: normalizedParams.archived === true,
        backend: normalizedParams.backend ?? "all",
        callerReason: normalizedParams.callerReason ?? "thread-list",
        enrichDirectories: normalizedParams.enrichDirectories,
        expiresInMs: cached.expiresInMs,
        filterPresent: Boolean(normalizedParams.filter?.trim()),
        forceRefresh: normalizedParams.forceRefresh === true,
        pending: cached.pending,
        source: cached.source,
        threadCount: cached.threadCount,
      });
      return await cached.value;
    }

    const startedAt = Date.now();
    logDebug("threadListCache:miss", {
      archived: normalizedParams.archived === true,
      backend: normalizedParams.backend ?? "all",
      callerReason: normalizedParams.callerReason ?? "thread-list",
      enrichDirectories: normalizedParams.enrichDirectories,
      filterPresent: Boolean(normalizedParams.filter?.trim()),
      forceRefresh: normalizedParams.forceRefresh === true,
    });
    const promise = this.readThreadList(normalizedParams)
      .then((threads) => {
        this.threadListCache.set(cacheKey, {
          expiresAt: Date.now() + THREAD_LIST_REUSE_WINDOW_MS,
          threads,
        });
        logDebug("threadListCache:store", {
          archived: normalizedParams.archived === true,
          backend: normalizedParams.backend ?? "all",
          callerReason: normalizedParams.callerReason ?? "thread-list",
          durationMs: Date.now() - startedAt,
          enrichDirectories: normalizedParams.enrichDirectories,
          expiresInMs: THREAD_LIST_REUSE_WINDOW_MS,
          filterPresent: Boolean(normalizedParams.filter?.trim()),
          forceRefresh: normalizedParams.forceRefresh === true,
          threadCount: threads.length,
        });
        return threads;
      })
      .catch((error) => {
        this.threadListCache.delete(cacheKey);
        logDebug("threadListCache:error", {
          archived: normalizedParams.archived === true,
          backend: normalizedParams.backend ?? "all",
          callerReason: normalizedParams.callerReason ?? "thread-list",
          durationMs: Date.now() - startedAt,
          enrichDirectories: normalizedParams.enrichDirectories,
          error: error instanceof Error ? error.message : String(error),
          filterPresent: Boolean(normalizedParams.filter?.trim()),
          forceRefresh: normalizedParams.forceRefresh === true,
        });
        throw error;
      });
    this.threadListCache.set(cacheKey, { promise });
    return await promise;
  }

  async getThreadAgentMetadata(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadAgentMetadata | undefined> {
    const overlay = await this.overlayStore.getThreadOverlayState(params);
    return overlay?.agent;
  }

  private async readThreadList(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories: boolean;
    filter?: string;
  }): Promise<AppServerThreadSummary[]> {
    const diagnostics = {
      callerReason: params.callerReason ?? "thread-list",
      ownerId: this.threadListCacheOwnerId,
    };
    if (params.backend === "codex") {
      const threads = await this.filterArchivedThreadsPresentInActiveList({
        archived: params.archived,
        backend: "codex",
        diagnostics,
        filter: params.filter,
        threads: await this.listCodexThreads({
          archived: params.archived,
          enrichDirectories: params.enrichDirectories,
          filter: params.filter,
        }, diagnostics),
      });
      this.scheduleThreadListArchiveStateCleanup({
        backend: "codex",
        filter: params.filter,
        archived: params.archived,
        threads,
      });
      return threads;
    }

    if (params.backend === "grok") {
      const threads = await this.filterArchivedThreadsPresentInActiveList({
        archived: params.archived,
        backend: "grok",
        diagnostics,
        filter: params.filter,
        threads: this.withPendingStartedThreads(
          "grok",
          await this.grokClient.listThreads({
            archived: params.archived,
            filter: params.filter,
          }, diagnostics),
          params,
        ),
      });
      this.scheduleThreadListArchiveStateCleanup({
        backend: "grok",
        filter: params.filter,
        archived: params.archived,
        threads,
      });
      return threads;
    }

    if (params.backend && isAcpBackendId(params.backend)) {
      return this.listInstalledAcpThreads(
        params.backend,
        params.filter,
        params.archived,
      );
    }

    const threadLists = await Promise.all([
      this.listThreads({
        backend: "codex",
        archived: params.archived,
        callerReason: params.callerReason,
        enrichDirectories: params.enrichDirectories,
        filter: params.filter,
      }),
      this.listThreads({
        backend: "grok",
        archived: params.archived,
        callerReason: params.callerReason,
        enrichDirectories: params.enrichDirectories,
        filter: params.filter,
      }).catch(() => []),
      this.listAllInstalledAcpThreads(params.filter, params.archived),
    ]);

    return threadLists
      .flat()
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
  }

  private async filterArchivedThreadsPresentInActiveList(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    diagnostics: {
      callerReason: ThreadListCallerReason;
      ownerId: string;
    };
    filter?: string;
    threads: AppServerThreadSummary[];
  }): Promise<AppServerThreadSummary[]> {
    if (params.archived !== true || params.threads.length === 0) {
      return params.threads;
    }

    try {
      const activeThreads =
        params.backend === "codex"
          ? await this.listCodexThreads({
              archived: false,
              enrichDirectories: false,
              filter: params.filter,
            }, {
              ...params.diagnostics,
              callerReason: `${params.diagnostics.callerReason}:active-archive-filter`,
            })
          : this.withPendingStartedThreads(
              "grok",
              await this.grokClient.listThreads({
                archived: false,
                filter: params.filter,
              }, {
                ...params.diagnostics,
                callerReason: `${params.diagnostics.callerReason}:active-archive-filter`,
              }),
              { archived: false, filter: params.filter },
            );
      const activeThreadIds = new Set(activeThreads.map((thread) => thread.id));
      const filteredThreads = params.threads.filter(
        (thread) => !activeThreadIds.has(thread.id),
      );
      const filteredCount = params.threads.length - filteredThreads.length;
      if (filteredCount > 0) {
        backendRegistryLog.info("archived thread list filtered active duplicates", {
          backend: params.backend,
          filteredCount,
          threadIds: params.threads
            .filter((thread) => activeThreadIds.has(thread.id))
            .slice(0, 10)
            .map((thread) => thread.id),
        });
      }
      return filteredThreads;
    } catch (error) {
      backendRegistryLog.warn("archived thread active-state filter failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return params.threads;
    }
  }

  async listSkills(params: {
    backend?: AppServerBackendKind;
    cwd?: string;
    cwds?: string[];
    threadId?: string;
  } = {}): Promise<Pick<AppServerListSkillsResponse, "data">> {
    const backend = params.backend ?? "codex";
    if (isAcpBackendId(backend)) {
      if (!params.threadId) {
        return { data: [] };
      }
      const session = this.acpBackend.getSession(backend, params.threadId);
      return {
        data: [
          {
            commands: session?.availableCommands ?? [],
            skills: [],
          },
        ],
      };
    }

    const client = this.getClient(backend);
    const data = await client.listSkills({
      cwd: params.cwd,
      cwds: params.cwds,
    });
    const commands = backendMethodCommands(
      backend,
      (await client.getInitializeResult()).methods ?? [],
    );

    if (commands.length === 0) {
      return { data };
    }

    if (data.length === 0) {
      return {
        data: [
          {
            commands,
            skills: [],
          },
        ],
      };
    }

    return {
      data: data.map((entry, index) =>
        index === 0
          ? {
              ...entry,
              commands: mergeCommandSummaries(entry.commands, commands),
            }
          : entry,
      ),
    };
  }

  private async listAllInstalledAcpThreads(
    filter?: string,
    archived?: boolean,
  ): Promise<AppServerThreadSummary[]> {
    const threadLists = await Promise.all(
      (await this.acpBackend.listAvailableAgents()).map((agent) =>
        this.listInstalledAcpThreads(agent.backendId, filter, archived),
      ),
    );
    return threadLists.flat();
  }

  private async listInstalledAcpThreads(
    backendId: AppServerBackendKind,
    filter?: string,
    archived?: boolean,
  ): Promise<AppServerThreadSummary[]> {
    if (!isAcpBackendId(backendId)) {
      return [];
    }
    const normalizedFilter = filter?.trim().toLowerCase();
    const threads = this.acpBackend
      .listSessions(backendId, { archived })
      .map((session) => this.acpBackend.sessionToThreadSummary(session));
    const enrichedThreads = await Promise.all(
      threads.map(async (thread) => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: backendId,
          threadId: thread.id,
        });
        const executionMode =
          this.latestAppliedExecutionModeFromOverlay(overlay) ??
          thread.executionMode;
        const cwd = resolveThreadWorkspaceCwd(
          thread,
          overlay?.extraLinkedDirectories ?? [],
        );
        const linkedDirectories = await this.resolveAcpLinkedDirectories(
          thread,
          cwd,
          overlay,
          backendId,
        );
        const codexEnvironmentOptions = cwd
          ? await listCodexEnvironmentOptions(cwd).catch(() => [])
          : [];
        return {
          ...thread,
          executionMode,
          linkedDirectories,
          codexEnvironmentOptions,
        };
      }),
    );
    return enrichedThreads.filter(
      (thread) =>
        !normalizedFilter ||
        thread.title.toLowerCase().includes(normalizedFilter) ||
        thread.id.toLowerCase().includes(normalizedFilter),
    );
  }

  /**
   * ACP sessions only know their working directory. When that cwd is a
   * tool-managed worktree (`.codex/.../worktrees/...`, `.pwragent/.../worktrees/...`,
   * `<repo>/.worktrees/...`), resolve the underlying repository checkout by
   * following the worktree's `.git` link (filesystem only — this NEVER spawns
   * git) so the thread's linked directory is repo-rooted (`path` = repo,
   * `worktreePath` = cwd). That makes ACP worktree threads group under the same
   * directory row as their repo — matching Codex — instead of each worktree
   * getting its own folder.
   *
   * The repo↔worktree mapping is immutable for a given worktree path, so a
   * successful resolution is cached durably on the thread overlay
   * (`acpWorktreeDirectory`, keyed by cwd) and reused on every later list read
   * without touching the filesystem again. The resolver therefore runs at most
   * once per worktree thread, not once per refresh.
   *
   * Falls back to the session's own linked directories when the cwd is a plain
   * local checkout (already repo-rooted), is not a managed worktree, or resolves
   * to nothing (e.g. the worktree was deleted). A miss is deliberately left
   * uncached so a transient failure is retried cheaply, and a vanished
   * worktree's thread stays on its row rather than dropping to "unlinked".
   */
  private async resolveAcpLinkedDirectories(
    thread: AppServerThreadSummary,
    cwd: string | undefined,
    overlay: ThreadOverlayState | undefined,
    backendId: AppServerBackendKind,
  ): Promise<AppServerThreadSummary["linkedDirectories"]> {
    if (!cwd || !isLikelyToolManagedWorktreePath(cwd)) {
      return thread.linkedDirectories;
    }

    // Reuse the durably-cached resolution while the session cwd is unchanged.
    const cached = overlay?.acpWorktreeDirectory;
    if (cached && cached.cwd === cwd) {
      return [cached.directory];
    }

    try {
      const directory = await this.acpWorktreeRepositoryResolver(cwd);
      if (directory) {
        await this.overlayStore.setAcpWorktreeDirectory({
          backend: backendId,
          threadId: thread.id,
          cwd,
          directory,
        });
        return [directory];
      }
    } catch (error) {
      backendRegistryLog.warn("ACP worktree repository resolution failed", {
        threadId: thread.id,
        backend: thread.source,
        cwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return thread.linkedDirectories;
  }

  private async readAcpThread(
    request: AppServerReadThreadRequest,
    backend: AcpBackendId,
  ): Promise<AppServerReadThreadResponse> {
    const session = this.acpBackend.getSession(backend, request.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${request.threadId}`);
    }

    const replay = await this.acpBackend.readReplay(backend, request.threadId);
    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      ...(replay.threadStatus ? { threadStatus: replay.threadStatus } : {}),
      replay,
    };
  }

  private async startAcpSession(params: {
    backend: AcpBackendId;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    acpRuntime?: BackendAcpSessionRuntimeState;
  }): Promise<{ threadId: string }> {
    const client = await this.acpBackend.getClient(params.backend);
    const initialExecutionMode = this.usesSlashControlledAcpExecutionModes(
      params.backend,
    )
      ? "default"
      : params.executionMode;
    const session = await client.startSession({
      cwd: params.cwd,
      executionMode: initialExecutionMode,
      acpRuntime: params.acpRuntime,
    });
    if (
      this.usesSlashControlledAcpExecutionModes(params.backend) &&
      params.executionMode !== "default"
    ) {
      await this.applySlashControlledAcpThreadExecutionMode({
        backend: params.backend,
        threadId: session.sessionId,
        executionMode: params.executionMode,
      });
    }
    await this.applyAcpRuntimeSelection(client, session.sessionId, params.acpRuntime);
    return { threadId: session.sessionId };
  }

  private async startAcpTurn(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    return await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.threadId),
      async () => await this.startAcpTurnLocked(params),
    );
  }

  private async startAcpTurnLocked(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    const promptPayload = inputToAcpPrompt(params.input);
    if (!promptPayload) {
      throw new Error("ACP turns require text or image input");
    }

    const client = await this.acpBackend.getClient(params.backend);
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    let sessionForTurn = await this.resolveAcpSessionForTurn(params.backend, session);
    if (
      sessionForTurn.requiresAgentSessionRebind ||
      (sessionForTurn.cwd && sessionForTurn.cwd !== session.cwd)
    ) {
      await this.assertAcpSessionCanRebindForWorkspace(params.backend, sessionForTurn);
      sessionForTurn = await this.rebindAcpSessionForWorkspace(client, sessionForTurn);
    } else {
      try {
        await client.ensureSession(sessionForTurn);
      } catch (error) {
        if (!isAcpSessionMissingForProjectError(error)) {
          throw error;
        }
        await this.assertAcpSessionCanRebindForWorkspace(params.backend, sessionForTurn);
        sessionForTurn = await this.rebindAcpSessionForWorkspace(client, sessionForTurn);
      }
    }
    const syntheticStartedTurnId = `pending:${params.threadId}:${Date.now()}`;
    await this.emit({
      backend: params.backend,
      notification: {
        method: "turn/started",
        params: {
          threadId: params.threadId,
          turnId: syntheticStartedTurnId,
          turn: {
            id: syntheticStartedTurnId,
            status: "in_progress",
            startedAt: Date.now(),
          },
        },
      },
    });

    try {
      const result = client.startPrompt({
        sessionId: params.threadId,
        prompt: promptPayload.prompt,
        promptContent: promptPayload.promptContent,
        parts: promptPayload.parts,
        turnId: syntheticStartedTurnId,
      });
      this.invalidateThreadListCache(params.backend);
      return {
        backend: params.backend,
        threadId: result.sessionId,
        turnId: result.turnId,
      };
    } catch (error) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "turn/failed",
          params: {
            threadId: params.threadId,
            turnId: syntheticStartedTurnId,
            turn: {
              id: syntheticStartedTurnId,
              status: "failed",
              completedAt: Date.now(),
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          },
        },
      });
      throw error;
    }
  }

  private async applyAcpRuntimeSelection(
    client: AcpRuntimeClient,
    sessionId: string,
    runtime: BackendAcpSessionRuntimeState | undefined,
  ): Promise<void> {
    for (const [optionId, value] of Object.entries(runtime?.configValues ?? {})) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "configOption",
        optionId,
        value,
      });
    }
    if (runtime?.currentModeId) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "mode",
        optionId: "mode",
        value: runtime.currentModeId,
      });
    }
    if (runtime?.currentModelId) {
      await client.setRuntimeOption?.({
        sessionId,
        source: "model",
        optionId: "model",
        value: runtime.currentModelId,
      });
    }
  }

  async setAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    if (!isAcpBackendId(params.backend)) {
      throw new Error("ACP runtime options are only available for ACP backends");
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }

    const currentValue = this.readAcpRuntimeOptionValue(session.acpRuntime, params);
    if (currentValue === params.value) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        runtimeState: session.acpRuntime,
      };
    }

    if (this.threadHasActiveTurn(params.threadId, params.backend)) {
      await this.queueAcpSessionRuntimeOption(params, currentValue);
      return {
        backend: params.backend,
        threadId: params.threadId,
        runtimeState: session.acpRuntime,
      };
    }

    return await this.applyAcpSessionRuntimeOption(params);
  }

  private async queueAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
    fromValue: string | undefined,
  ): Promise<void> {
    if (!isAcpBackendId(params.backend)) {
      return;
    }
    const queuedAt = Date.now();
    const queueId = randomUUID();
    const queueKey = this.buildAcpRuntimeQueueKey(params.backend, params.threadId);
    const fromLabel = this.formatAcpRuntimeOptionLabel(params.backend, params, fromValue);
    const toLabel = this.formatAcpRuntimeOptionLabel(params.backend, params, params.value);
    this.queuedAcpRuntimeOptions.set(queueKey, {
      source: params.source,
      optionId: params.optionId,
      value: params.value,
      queuedAt,
      queueId,
      flushAttempts: 0,
      fromValue,
      fromLabel,
      toLabel,
    });

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: acpRuntimeValueLooksPrivileged(fromValue)
          ? "full-access"
          : "default",
        toExecutionMode: acpRuntimeValueLooksPrivileged(params.value)
          ? "full-access"
          : "default",
        fromLabel,
        toLabel,
        status: "queued",
        occurredAt: queuedAt,
        queueId,
      },
    });

    backendRegistryLog.info("queued ACP runtime option change", {
      backend: params.backend,
      threadId: params.threadId,
      source: params.source,
      optionId: params.optionId,
      from: fromValue,
      to: params.value,
      queueId,
    });
  }

  private async applyAcpSessionRuntimeOption(
    params: SetAcpSessionRuntimeOptionRequest,
    options?: {
      fromQueue?: boolean;
      queueId?: string;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    },
  ): Promise<SetAcpSessionRuntimeOptionResponse> {
    if (!isAcpBackendId(params.backend)) {
      throw new Error("ACP runtime options are only available for ACP backends");
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    const client = await this.acpBackend.getClient(params.backend);
    await client.ensureSession?.(session);
    const fromValue =
      options?.fromValue ?? this.readAcpRuntimeOptionValue(session.acpRuntime, params);
    const runtimeState = this.normalizeAcpRuntimeSelectionState(
      params,
      await client.setRuntimeOption?.({
        sessionId: params.threadId,
        source: params.source,
        optionId: params.optionId,
        value: params.value,
      }),
    );
    const mergedRuntime = mergeAcpRuntimeState(session.acpRuntime, runtimeState);
    const nextExecutionMode = this.isAcpRuntimeExecutionModeOption(params)
      ? acpRuntimeValueLooksPrivileged(params.value)
        ? "full-access"
        : "default"
      : session.executionMode;
    this.acpBackend.upsertSession({
      ...session,
      acpRuntime: mergedRuntime,
      executionMode: nextExecutionMode,
      updatedAt: Math.max(session.updatedAt, runtimeState?.updatedAt ?? Date.now()),
    });

    const fromLabel =
      options?.fromLabel ??
      this.formatAcpRuntimeOptionLabel(params.backend, params, fromValue);
    const toLabel =
      options?.toLabel ??
      this.formatAcpRuntimeOptionLabel(params.backend, params, params.value);
    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: acpRuntimeValueLooksPrivileged(fromValue)
          ? "full-access"
          : "default",
        toExecutionMode: acpRuntimeValueLooksPrivileged(params.value)
          ? "full-access"
          : "default",
        fromLabel,
        toLabel,
        status: "applied",
        occurredAt: Date.now(),
        queueId: options?.queueId,
      },
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/acpRuntime/updated",
        params: {
          threadId: params.threadId,
          acpRuntime: mergedRuntime,
        },
      },
    });
    if (nextExecutionMode !== session.executionMode) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/updated",
          params: {
            threadId: params.threadId,
            executionMode: nextExecutionMode,
          },
        },
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      runtimeState: mergedRuntime,
    };
  }

  private async flushQueuedAcpRuntimeOptionIfPresent(
    backend: AcpBackendId,
    threadId: string,
  ): Promise<void> {
    const queueKey = this.buildAcpRuntimeQueueKey(backend, threadId);
    const activeFlush = this.queuedAcpRuntimeOptionFlushes.get(queueKey);
    if (activeFlush) {
      await activeFlush;
      return;
    }
    const queue = this.queuedAcpRuntimeOptions.get(queueKey);
    if (!queue) {
      return;
    }
    if (!this.queuedAcpRuntimeOptions.delete(queueKey)) {
      return;
    }
    const flush = this.applyClaimedQueuedAcpRuntimeOption(backend, threadId, queue);
    this.queuedAcpRuntimeOptionFlushes.set(queueKey, flush);
    try {
      await flush;
    } finally {
      if (this.queuedAcpRuntimeOptionFlushes.get(queueKey) === flush) {
        this.queuedAcpRuntimeOptionFlushes.delete(queueKey);
      }
    }
  }

  private async applyClaimedQueuedAcpRuntimeOption(
    backend: AcpBackendId,
    threadId: string,
    queue: {
      source: BackendAcpRuntimeOptionSource;
      optionId: string;
      value: string;
      queueId: string;
      flushAttempts: number;
      fromValue?: string;
      fromLabel?: string;
      toLabel?: string;
    },
  ): Promise<void> {
    try {
      await this.applyAcpSessionRuntimeOption(
        {
          backend,
          threadId,
          source: queue.source,
          optionId: queue.optionId,
          value: queue.value,
        },
        {
          fromQueue: true,
          queueId: queue.queueId,
          fromValue: queue.fromValue,
          fromLabel: queue.fromLabel,
          toLabel: queue.toLabel,
        },
      );
    } catch (error) {
      const attempts = queue.flushAttempts + 1;
      if (attempts >= MAX_QUEUE_FLUSH_ATTEMPTS) {
        await this.appendPermissionTransition({
          backend,
          threadId,
          transition: {
            id: randomUUID(),
            fromExecutionMode: acpRuntimeValueLooksPrivileged(queue.fromValue)
              ? "full-access"
              : "default",
            toExecutionMode: acpRuntimeValueLooksPrivileged(queue.value)
              ? "full-access"
              : "default",
            fromLabel: queue.fromLabel,
            toLabel: queue.toLabel,
            status: "cancelled",
            occurredAt: Date.now(),
            queueId: queue.queueId,
            note: `auto-cancelled after ${MAX_QUEUE_FLUSH_ATTEMPTS} failed flush attempts`,
          },
        });
        backendRegistryLog.error(
          "auto-cancelling queued ACP runtime option change after repeated failures",
          {
            backend,
            threadId,
            queueId: queue.queueId,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        return;
      }
      this.queuedAcpRuntimeOptions.set(this.buildAcpRuntimeQueueKey(backend, threadId), {
        ...queue,
        queuedAt: Date.now(),
        flushAttempts: attempts,
      });
      backendRegistryLog.warn("queued ACP runtime option flush failed; will retry", {
        backend,
        threadId,
        queueId: queue.queueId,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildAcpRuntimeQueueKey(backend: AcpBackendId, threadId: string): string {
    return `${backend}:${threadId}`;
  }

  private readAcpRuntimeOptionValue(
    runtime: BackendAcpSessionRuntimeState | undefined,
    params: Pick<SetAcpSessionRuntimeOptionRequest, "backend" | "source" | "optionId">,
  ): string | undefined {
    if (
      params.source === "configOption" &&
      runtime?.currentModeId &&
      this.isAcpRuntimeModeConfigOption(params.backend, params.optionId)
    ) {
      return runtime.currentModeId;
    }
    if (params.source === "configOption") {
      return runtime?.configValues?.[params.optionId];
    }
    return params.source === "mode"
      ? runtime?.currentModeId
      : runtime?.currentModelId;
  }

  private normalizeAcpRuntimeSelectionState(
    params: SetAcpSessionRuntimeOptionRequest,
    runtimeState: BackendAcpSessionRuntimeState | undefined,
  ): BackendAcpSessionRuntimeState {
    const updatedAt = runtimeState?.updatedAt ?? Date.now();
    const selectedState: BackendAcpSessionRuntimeState =
      params.source === "model"
        ? {
            currentModelId: params.value,
            updatedAt,
          }
        : params.source === "mode" ||
            this.isAcpRuntimeModeConfigOption(params.backend, params.optionId)
          ? {
              configValues:
                params.source === "configOption"
                  ? { [params.optionId]: params.value }
                  : runtimeState?.configValues,
              currentModeId: params.value,
              updatedAt,
            }
          : {
              configValues: { [params.optionId]: params.value },
              updatedAt,
            };
    return mergeAcpRuntimeState(runtimeState, selectedState) ?? selectedState;
  }

  private isAcpRuntimeModeConfigOption(
    backend: AppServerBackendKind,
    optionId: string,
  ): boolean {
    if (!isAcpBackendId(backend)) {
      return false;
    }
    const agent = this.acpBackend.getInstalledAgent(backend);
    return (
      agent?.runtimeCapabilities?.configOptions?.some(
        (option) => option.id === optionId && option.category === "mode",
      ) ?? false
    );
  }

  private isAcpRuntimeExecutionModeOption(
    params: Pick<SetAcpSessionRuntimeOptionRequest, "backend" | "source" | "optionId">,
  ): boolean {
    return (
      params.source === "mode" ||
      this.isAcpRuntimeModeConfigOption(params.backend, params.optionId)
    );
  }

  private formatAcpRuntimeOptionLabel(
    backend: AcpBackendId,
    params: Pick<SetAcpSessionRuntimeOptionRequest, "source" | "optionId">,
    value: string | undefined,
  ): string | undefined {
    if (!value) {
      return undefined;
    }
    const runtime = this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities;
    if (params.source === "configOption") {
      const option = runtime?.configOptions?.find((item) => item.id === params.optionId);
      const label = option?.values.find((item) => item.value === value)?.label;
      return formatAcpRuntimeLabel(label ?? value);
    }
    if (params.source === "model") {
      const label = runtime?.models?.availableModels.find((model) => model.id === value)?.label;
      return formatAcpRuntimeLabel(label ?? value);
    }
    const label = runtime?.modes?.availableModes.find((mode) => mode.id === value)?.label;
    return formatAcpRuntimeLabel(label ?? value);
  }

  private async resolveAcpSessionForTurn(
    backend: AcpBackendId,
    session: AcpSessionMetadata,
  ): Promise<AcpSessionMetadata> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: session.sessionId,
    });
    const workspaceCwd = resolveThreadWorkspaceCwd(
      acpSessionToThreadSummary(session),
      overlay?.extraLinkedDirectories,
    );
    if (!workspaceCwd || workspaceCwd === session.cwd) {
      return session;
    }

    return {
      ...session,
      cwd: workspaceCwd,
      requiresAgentSessionRebind: true,
      updatedAt: Math.max(session.updatedAt, Date.now()),
    };
  }

  private async rebindAcpSessionForWorkspace(
    client: AcpRuntimeClient,
    session: AcpSessionMetadata,
  ): Promise<AcpSessionMetadata> {
    return await client.startSession({
      sessionId: session.sessionId,
      cwd: session.cwd,
      executionMode: session.executionMode,
      title: session.title,
      createdAt: session.createdAt,
    });
  }

  private async assertAcpSessionCanRebindForWorkspace(
    backend: AcpBackendId,
    session: AcpSessionMetadata,
  ): Promise<void> {
    if (!acpSessionHasConversationHistory(session)) {
      return;
    }
    if (await this.acpBackendSupportsLiveWorkspaceHandoff(backend)) {
      return;
    }
    throw new Error(ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR);
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    const backend = request.backend ?? "codex";
    if (isAcpBackendId(backend)) {
      return await this.archiveAcpThread({
        backend,
        threadId: request.threadId,
      });
    }
    let cleanupMetadata: ArchiveCleanupMetadata | undefined;
    let cleanupMetadataError: string | undefined;
    try {
      cleanupMetadata = await this.findThreadForArchiveCleanup({
        backend,
        threadId: request.threadId,
      });
    } catch (error) {
      cleanupMetadataError = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("archive cleanup metadata lookup failed", {
        backend,
        threadId: request.threadId,
        error: cleanupMetadataError,
      });
    }

    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.archiveWithClient(client, request.threadId),
          )
        : await this.archiveWithClient(this.grokClient, request.threadId);
    this.invalidateThreadListCache(backend);
    await this.cleanupMessagingForArchivedThread({
      backend,
      threadId: result.threadId,
      origin: "thread-archive",
    });
    await this.ungroupChildrenOfArchivedThread({
      backend,
      activeThreads: cleanupMetadata?.activeThreads ?? [],
      parentThreadId: result.threadId,
    });
    const cleanup = cleanupMetadata
      ? await this.archiveThreadWorktrees({
          backend,
          activeThreads: cleanupMetadata.activeThreads,
          archivedThreads: cleanupMetadata.archivedThreads,
          thread: cleanupMetadata.thread,
        })
      : this.buildArchiveCleanupMetadataSkippedResult({
          backend,
          threadId: result.threadId,
          error: cleanupMetadataError,
        });

    return {
      backend,
      threadId: result.threadId,
      archivedAt: Date.now(),
      cleanup,
    };
  }

  private buildArchiveCleanupMetadataSkippedResult(params: {
    backend: AppServerBackendKind;
    threadId: string;
    error?: string;
  }): ArchiveThreadCleanupResult[] {
    backendRegistryLog.warn(
      "archive thread worktree cleanup skipped: metadata unavailable",
      {
        backend: params.backend,
        threadId: params.threadId,
        skippedReason: params.error
          ? `Unable to load thread metadata for archive cleanup: ${params.error}`
          : "Unable to load thread metadata for archive cleanup.",
      },
    );

    return [
      {
        removedWorktree: false,
        deletedBranch: false,
        skippedReason: params.error
          ? `Unable to load thread metadata for archive cleanup: ${params.error}`
          : "Unable to load thread metadata for archive cleanup.",
      },
    ];
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    if (isAcpBackendId(backend)) {
      return await this.restoreAcpThread({
        backend,
        threadId: request.threadId,
      });
    }
    const archivedThread = await this.findThreadForRestoreWorktrees({
      backend,
      threadId: request.threadId,
    });
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.restoreWithClient(client, request.threadId),
          )
        : await this.restoreWithClient(this.grokClient, request.threadId);
    this.invalidateThreadListCache(backend);
    this.clearArchivedMessagingCleanupCache({
      backend,
      threadId: result.threadId,
    });
    const worktrees = await this.restoreThreadWorktrees({
      backend,
      threadId: result.threadId,
      thread: archivedThread,
    });

    return {
      backend,
      threadId: result.threadId,
      restoredAt: Date.now(),
      worktrees,
    };
  }

  private async archiveAcpThread(params: {
    backend: AcpBackendId;
    threadId: string;
  }): Promise<ArchiveThreadResponse> {
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP thread not found: ${params.threadId}`);
    }
    const archivedAt = Date.now();
    this.acpBackend.upsertSession({
      ...session,
      archivedAt,
      updatedAt: Math.max(session.updatedAt, archivedAt),
    });
    this.invalidateThreadListCache(params.backend);
    await this.cleanupMessagingForArchivedThread({
      backend: params.backend,
      threadId: params.threadId,
      origin: "thread-archive",
    });
    return {
      backend: params.backend,
      threadId: params.threadId,
      archivedAt,
      cleanup: [],
    };
  }

  private async restoreAcpThread(params: {
    backend: AcpBackendId;
    threadId: string;
  }): Promise<RestoreThreadResponse> {
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP thread not found: ${params.threadId}`);
    }
    const restoredAt = Date.now();
    const restoredSession = { ...session };
    delete restoredSession.archivedAt;
    this.acpBackend.upsertSession({
      ...restoredSession,
      updatedAt: Math.max(session.updatedAt, restoredAt),
    });
    this.invalidateThreadListCache(params.backend);
    this.clearArchivedMessagingCleanupCache({
      backend: params.backend,
      threadId: params.threadId,
    });
    return {
      backend: params.backend,
      threadId: params.threadId,
      restoredAt,
      worktrees: [],
    };
  }

  async archiveWorktree(
    request: ArchiveWorktreeRequest,
  ): Promise<ArchiveWorktreeResponse> {
    const snapshot = await this.worktreeArchiveService.archive({
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      repositoryPath: request.repositoryPath,
    });
    await this.overlayStore.upsertWorktreeSnapshot({
      backend: request.backend,
      threadId: request.threadId,
      snapshot,
    });

    return {
      backend: request.backend,
      threadId: request.threadId,
      archivedAt: snapshot.archivedAt ?? Date.now(),
      snapshot,
    };
  }

  async restoreWorktree(
    request: RestoreWorktreeRequest,
  ): Promise<RestoreWorktreeResponse> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: request.backend,
      threadId: request.threadId,
    });
    const snapshot = (overlay?.worktreeSnapshots ?? []).find((candidate) => {
      if (request.snapshotRef) {
        return candidate.snapshotRef === request.snapshotRef;
      }

      return candidate.worktreePath === request.worktreePath;
    });

    if (!snapshot) {
      throw new Error("No archived worktree snapshot is available for this thread.");
    }

    const restoredSnapshot = await this.worktreeArchiveService.restore({
      backend: request.backend,
      threadId: request.threadId,
      worktreePath: request.worktreePath,
      repositoryPath: request.repositoryPath ?? snapshot.repositoryPath,
      snapshotRef: request.snapshotRef ?? snapshot.snapshotRef,
      snapshotCommit: snapshot.snapshotCommit,
      snapshot,
    });
    await this.overlayStore.upsertWorktreeSnapshot({
      backend: request.backend,
      threadId: request.threadId,
      snapshot: restoredSnapshot,
    });

    return {
      backend: request.backend,
      threadId: request.threadId,
      restoredAt: restoredSnapshot.restoredAt ?? Date.now(),
      snapshot: restoredSnapshot,
    };
  }

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    if (request.backend === "codex" && this.threadHasActiveTurn(request.threadId)) {
      throw new Error(ACTIVE_TURN_HANDOFF_ERROR);
    }
    if (isAcpBackendId(request.backend)) {
      await this.assertAcpWorkspaceHandoffAllowed({
        backend: request.backend,
        threadId: request.threadId,
      });
    }

    const thread = await this.findThreadForWorkspaceHandoff({
      backend: request.backend,
      threadId: request.threadId,
    });
    const candidate = this.resolveHandoffWorkspaceCandidate(thread, request);
    const result = await this.gitWorkspaceHandoffService.handoff({
      ...request,
      repositoryPath: request.repositoryPath ?? candidate.repositoryPath,
      sourcePath: request.sourcePath ?? candidate.sourcePath,
      sourceBranch: request.sourceBranch ?? candidate.sourceBranch,
    });
    const resultBranch = result.strategy === "detached-changes" ? "HEAD" : result.branch;

    await this.overlayStore.replaceWorkspaceLinkedDirectory({
      backend: request.backend,
      threadId: request.threadId,
      directory: result.linkedDirectory,
      gitBranch: resultBranch,
    });
    await this.updateThreadGitBranchMetadata({
      backend: request.backend,
      threadId: request.threadId,
      branch: resultBranch,
    });
    this.updateAcpSessionWorkspaceAfterHandoff({
      backend: request.backend,
      threadId: request.threadId,
      cwd: result.linkedDirectory.worktreePath ?? result.targetPath,
    });
    if (result.workMode === "worktree") {
      await this.recordCodexWorktreeOwnerThread({
        backend: request.backend,
        threadId: request.threadId,
        worktreePath: result.linkedDirectory.worktreePath ?? result.targetPath,
      });
    }
    // Do not rewrite Codex rollout JSONL files here. Codex may still hold the
    // session file open; replacing it can orphan later transcript writes. The
    // next turn resolves cwd from the overlay updated above.
    if (result.archivedSourceWorktree) {
      await this.overlayStore.upsertWorktreeSnapshot({
        backend: request.backend,
        threadId: request.threadId,
        snapshot: result.archivedSourceWorktree,
      });
    }

    return result;
  }

  private async assertAcpWorkspaceHandoffAllowed(params: {
    backend: AcpBackendId;
    threadId: string;
  }): Promise<void> {
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session || !acpSessionHasConversationHistory(session)) {
      return;
    }
    if (await this.acpBackendSupportsLiveWorkspaceHandoff(params.backend)) {
      return;
    }
    throw new Error(ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR);
  }

  private async acpBackendSupportsLiveWorkspaceHandoff(
    backend: AcpBackendId,
  ): Promise<boolean> {
    return await this.acpBackend.supportsLiveWorkspaceHandoff(backend);
  }

  private updateAcpSessionWorkspaceAfterHandoff(params: {
    backend: AppServerBackendKind;
    threadId: string;
    cwd: string;
  }): void {
    if (!isAcpBackendId(params.backend)) {
      return;
    }
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session || session.cwd === params.cwd) {
      return;
    }
    this.acpBackend.upsertSession({
      ...session,
      cwd: params.cwd,
      requiresAgentSessionRebind: true,
      updatedAt: Math.max(session.updatedAt, Date.now()),
    });
  }

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    let result: { threadId: string };
    if (isAcpBackendId(backend)) {
      result = await this.renameAcpSession(backend, request.threadId, request.name);
    } else if (backend === "codex") {
      result = await this.withCodexThreadClient(request.threadId, async (client) =>
        await this.renameWithClient(client, request.threadId, request.name),
      );
    } else {
      result = await this.renameWithClient(
        this.grokClient,
        request.threadId,
        request.name,
      );
    }
    this.invalidateThreadListCache(backend);

    return {
      backend,
      threadId: result.threadId,
      renamedAt: Date.now(),
    };
  }

  private async renameAcpSession(
    backend: AcpBackendId,
    threadId: string,
    name: string,
    options?: { titleSource?: AppServerThreadTitleSource },
  ): Promise<{ threadId: string }> {
    const nextName = name.trim();
    if (!nextName) {
      throw new Error("Thread name cannot be blank.");
    }
    const session = this.acpBackend.getSession(backend, threadId);
    if (!session) {
      throw new Error("Selected ACP thread was not found.");
    }
    const updatedAt = Date.now();
    this.acpBackend.upsertSession({
      ...session,
      title: nextName,
      titleSource: options?.titleSource ?? "explicit",
      updatedAt: Math.max(session.updatedAt, updatedAt),
    });
    await this.emit({
      backend,
      notification: {
        method: "thread/name/updated",
        params: {
          threadId,
          threadName: nextName,
        },
      },
    });
    return { threadId };
  }

  async readDirectoryStatuses(directories: NavigationDirectorySummary[]): Promise<
    Record<string, NavigationDirectoryGitStatus | undefined>
  > {
    return await this.gitDirectoryService.readDirectoryStatuses(directories);
  }

  readDirectoryStatusEntries(
    directories: NavigationDirectorySummary[],
  ): AsyncIterable<DirectoryGitStatusEntry> {
    return this.gitDirectoryService.readDirectoryStatusEntries(directories);
  }

  readWorktreeWorkingStateEntries(
    worktreePaths: string[],
    options?: GitWorkingStateEntryOptions,
  ): AsyncIterable<WorktreeWorkingStateEntry> {
    return this.gitWorkingStateService.readWorkingStateEntries(worktreePaths, options);
  }

  invalidateWorktreeWorkingState(worktreePath?: string): void {
    this.gitWorkingStateService.invalidate(worktreePath);
  }

  async resolveEditCommitStates(
    worktreePath: string,
    groups: EditGroupCommitInput[],
    options?: ResolveEditCommitStatesOptions,
  ): Promise<Record<string, EditGroupCommitState>> {
    return await this.gitWorkingStateService.resolveEditCommitStates(
      worktreePath,
      groups,
      options,
    );
  }

  async listWorktreeOtherChanges(
    worktreePath: string,
    options?: { excludePaths?: string[]; maxFiles?: number },
  ) {
    return await this.gitWorkingStateService.listOtherChanges(worktreePath, options);
  }

  async getWorktreeOtherChangeDiff(
    worktreePath: string,
    filePath: string,
    options?: { maxBytes?: number },
  ) {
    return await this.gitWorkingStateService.getOtherChangeDiff(
      worktreePath,
      filePath,
      options,
    );
  }

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    this.assertNotBootstrap("readThread");
    const backend = request.backend ?? "codex";
    if (isAcpBackendId(backend)) {
      return await this.readAcpThread(request, backend);
    }

    const replay =
      backend === "codex"
        ? await this.withCodexThreadClient(
            request.threadId,
            async (client) =>
              await client.readThread({
                threadId: request.threadId,
                before: request.before,
                limit: request.limit,
              }),
            // Reads are execution-mode-agnostic; skip the routing diagnostic so
            // content search (one readThread per thread) doesn't spew it.
            undefined,
            false,
          )
        : await this.grokClient.readThread({
            threadId: request.threadId,
            before: request.before,
            limit: request.limit,
          });

    if (backend === "codex" && !request.before) {
      await this.repairCodexThreadDirectoryRelationship({
        reason: "selected-thread",
        threadId: request.threadId,
      });
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: request.threadId,
    });
    const replayWithEnvironment = appendCodexEnvironmentSetupActivity({
      replay,
      runtime: overlay?.codexEnvironmentRuntime,
    });
    const replayWithImmutableUsage = request.before
      ? replayWithEnvironment
      : mergeImmutableUsageActivities({
          replay: replayWithEnvironment,
          activities: overlay?.immutableUsageActivities,
        });
    if (!request.before) {
      await this.persistReplayUsageLines(replayWithEnvironment);
    }
    const pricing =
      typeof this.overlayStore.readThreadPricing === "function"
        ? await this.overlayStore.readThreadPricing({
            backend,
            threadId: request.threadId,
          })
        : { lines: [], summaries: [] };

    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      pricing,
      ...(replayWithImmutableUsage.threadStatus
        ? { threadStatus: replayWithImmutableUsage.threadStatus }
        : {}),
      replay: replayWithImmutableUsage,
    };
  }

  private async persistReplayUsageLines(
    replay: AppServerThreadReplay,
  ): Promise<void> {
    if (typeof this.overlayStore.upsertThreadUsageLine !== "function") {
      return;
    }
    const lines = collectThreadUsageLinesFromReplay(replay);
    for (const line of lines) {
      logUnpricedThreadUsageLine(line);
      await this.overlayStore.upsertThreadUsageLine({ line });
    }
  }

  private async emitThreadPricingUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    if (typeof this.overlayStore.readThreadPricing !== "function") {
      return;
    }
    const pricing = await this.overlayStore.readThreadPricing({
      backend: params.backend,
      threadId: params.threadId,
    });
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/pricing/updated",
        params: {
          threadId: params.threadId,
          pricing,
        },
      },
    });
  }

  async startThread(params: {
    backend: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    agent?: StartThreadRequest["agent"];
    acpRuntime?: BackendAcpSessionRuntimeState;
    workMode?: NavigationLaunchpadDraft["workMode"];
    branchName?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    linkedDirectories?: LinkedDirectorySummary[];
  }): Promise<StartThreadResponse> {
    this.assertNotBootstrap("startThread");
    const {
      backend,
      executionMode = "default",
      linkedDirectories,
      workMode,
      branchName,
      ...request
    } = params;
    const modelSettings = await this.resolveModelSettings(backend, request);
    let cwd =
      backend === "codex" && !request.cwd?.trim()
        ? await this.createScratchProjectDirectory()
        : request.cwd;
    let resolvedLinkedDirectories = linkedDirectories;
    let effectiveWorkMode = workMode;
    if (workMode === "worktree" && request.cwd?.trim()) {
      const preparedWorkspace =
        await this.gitDirectoryService.prepareLaunchpadWorkspace({
          backend,
          branchName,
          directoryKind: "directory",
          directoryLabel: path.basename(request.cwd) || request.cwd,
          directoryPath: request.cwd,
          workMode: "worktree",
        });
      cwd = preparedWorkspace.cwd;
      effectiveWorkMode = preparedWorkspace.workMode;
      resolvedLinkedDirectories =
        preparedWorkspace.workMode === "worktree"
          ? buildWorktreeLinkedDirectory({
              label: path.basename(request.cwd) || request.cwd,
              repositoryPath: preparedWorkspace.repositoryPath ?? request.cwd,
              worktreePath: preparedWorkspace.cwd,
            })
          : buildLocalLinkedDirectory(cwd);
    }

    const acpAgent = isAcpBackendId(backend)
      ? this.acpBackend.getInstalledAgent(backend)
      : undefined;
    const acpRuntimeCapabilities = acpAgent?.runtimeCapabilities;
    const acpRuntimeStartedAt = Date.now();
    const acpRuntimeWithDefaults = isAcpBackendId(backend)
      ? mergeAcpRuntimeState(
          acpRuntimeModeDefaultsFromCapabilities(
            acpRuntimeCapabilities,
            acpRuntimeStartedAt,
          ),
          request.acpRuntime,
        )
      : request.acpRuntime;
    const acpRuntimeWithModel = isAcpBackendId(backend)
      ? withAcpModelRuntimeSelection({
          runtime: acpRuntimeWithDefaults,
          runtimeCapabilities: acpRuntimeCapabilities,
          model: modelSettings.model,
          now: acpRuntimeStartedAt,
        })
      : acpRuntimeWithDefaults;
    const effectiveExecutionMode =
      isAcpBackendId(backend) &&
      acpAgent?.registryId === "qwen" &&
      executionMode === "default" &&
      acpRuntimeStateRequiresFullAccess({
        runtime: acpRuntimeWithModel,
        runtimeCapabilities: acpRuntimeCapabilities,
      })
        ? "full-access"
        : executionMode;
    const modeSettings = EXECUTION_MODE_SUMMARIES[effectiveExecutionMode];
    const acpRuntime = sanitizeAcpRuntimeForExecutionMode({
      backend,
      executionMode: effectiveExecutionMode,
      runtime: acpRuntimeWithModel,
    });
    const agentToolCatalogs = resolveAgentToolCatalogs({
      agent: request.agent,
      automationInspectionHandler: this.automationInspectionHandler,
      messagingHandler: this.messagingHandler,
      threadInspectionHandler: this.threadInspectionHandler,
    });
    const resolvedDynamicTools =
      backend === "codex"
        ? buildCodexParentDynamicToolSpecs(agentToolCatalogs)
        : undefined;
    const dynamicTools = resolvedDynamicTools?.length
      ? resolvedDynamicTools
      : undefined;
    if (dynamicTools?.length) {
      backendRegistryLog.info("attaching agent tool catalogs", {
        backend,
        catalogFingerprints: agentToolCatalogs.map(
          (catalog) => catalog.summary.fingerprint,
        ),
        catalogs: agentToolCatalogs.map((catalog) => catalog.id),
        toolCount: dynamicTools.length,
        tools: dynamicTools.map((tool) => tool.name),
      });
    }

    backendRegistryLog.info("startThread", {
      backend,
      cwd,
      executionMode,
      model: modelSettings.model ?? null,
      reasoningEffort: modelSettings.reasoningEffort ?? null,
      serviceTier: modelSettings.serviceTier ?? null,
      fastMode: modelSettings.fastMode ?? null,
    });

    const result = isAcpBackendId(backend)
      ? await this.startAcpSession({
          backend,
          cwd,
          executionMode: effectiveExecutionMode,
          acpRuntime,
        })
      : await this.getClient(backend, effectiveExecutionMode).startThread({
          ...request,
          ...modelSettings,
          cwd,
          approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
          sandbox: request.sandbox ?? modeSettings.sandbox,
          codexEnvironmentRuntime: request.codexEnvironmentRuntime,
          ...(backend === "codex"
            ? {
                defaultModeRequestUserInput:
                  this.resolveCodexDefaultModeRequestUserInputFn(),
              }
            : {}),
          dynamicTools,
        });
    const startedAt = Date.now();
    const gitBranch = cwd ? await readCurrentGitBranch(cwd).catch(() => undefined) : undefined;
    this.pendingStartedThreads.set(
      `${backend}:${result.threadId}`,
      {
        id: result.threadId,
        source: backend,
        title: "Untitled thread",
        titleSource: "fallback",
        projectKey: cwd,
        createdAt: startedAt,
        updatedAt: startedAt,
        executionMode: effectiveExecutionMode,
        ...modelSettings,
        acpRuntime,
        codexEnvironmentRuntime: request.codexEnvironmentRuntime,
        linkedDirectories: (
          resolvedLinkedDirectories?.length ? resolvedLinkedDirectories : buildLocalLinkedDirectory(cwd)
        ).map(normalizeLinkedDirectoryKind),
        gitBranch,
      },
    );
    if (effectiveWorkMode === "worktree") {
      await this.recordCodexWorktreeOwnerThread({
        backend,
        threadId: result.threadId,
        worktreePath: cwd,
      });
    }
    this.invalidateThreadListCache(backend);

    if (backend === "codex") {
      await this.overlayStore.setThreadExecutionMode({
        backend,
        threadId: result.threadId,
        executionMode: effectiveExecutionMode,
      });
      await this.updateThreadGitBranchMetadata({
        backend,
        threadId: result.threadId,
        branch: gitBranch,
      });
    }
    if (request.agent) {
      await this.overlayStore.setThreadAgent({
        backend,
        threadId: result.threadId,
        agent: request.agent,
      });
      this.invalidateThreadListCache(backend);
    }
    if (request.codexEnvironmentRuntime) {
      await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
        backend,
        threadId: result.threadId,
        codexEnvironmentRuntime: request.codexEnvironmentRuntime,
      });
    }
    if (
      modelSettings.model !== undefined ||
      modelSettings.reasoningEffort !== undefined ||
      modelSettings.serviceTier !== undefined ||
      modelSettings.fastMode !== undefined
    ) {
      await this.overlayStore.setThreadModelSettings({
        backend,
        threadId: result.threadId,
        ...modelSettings,
      });
    }

    return {
      backend,
      threadId: result.threadId,
      executionMode: effectiveExecutionMode,
      codexEnvironmentRuntime: request.codexEnvironmentRuntime,
    };
  }

  private async buildForkedCodexEnvironmentRuntime(params: {
    cwd?: string;
    sourceRuntime?: CodexThreadEnvironmentRuntime;
    workMode: LaunchpadWorkMode;
  }): Promise<CodexThreadEnvironmentRuntime | undefined> {
    const { cwd, sourceRuntime, workMode } = params;
    if (!sourceRuntime) {
      return undefined;
    }
    if (
      workMode !== "worktree" ||
      sourceRuntime.executionTarget !== "local" ||
      !cwd?.trim()
    ) {
      return cloneCodexEnvironmentRuntimeForFork(sourceRuntime, cwd);
    }

    const environment = (await listCodexEnvironmentOptions(cwd))
      .find((candidate) => candidate.id === sourceRuntime.environmentId);
    if (!environment) {
      throw new Error(
        `Selected Codex environment '${sourceRuntime.environmentName}' is not available in the forked worktree.`,
      );
    }

    const runtime = await applyLocalCodexEnvironmentSelection({
      commandRunner: this.codexEnvironmentCommandRunner,
      cwd,
      env: this.codexEnvironmentCommandEnv,
      hydrationStore: this.codexEnvironmentHydrationStore,
      selection: {
        environment,
        executionTarget: "local",
        setupEnabled: Boolean(environment.setupScript),
      },
    });
    if (!runtime) {
      return undefined;
    }
    const selectedActionIdByEnvironmentId = pruneCodexEnvironmentActionMap(
      readSelectedActionIdByEnvironmentIdForFork(sourceRuntime),
      [environment],
    );
    return {
      ...runtime,
      ...(Object.keys(selectedActionIdByEnvironmentId).length > 0
        ? { selectedActionIdByEnvironmentId }
        : {}),
    };
  }

  async forkThread(
    request: BackendRegistryForkThreadRequest,
  ): Promise<ForkThreadResponse> {
    this.assertNotBootstrap("forkThread");
    const backend = request.backend ?? "codex";
    if (backend !== "codex") {
      throw new Error("Thread forking is currently supported only by the Codex backend.");
    }

    const executionMode = request.executionMode ?? "default";
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const modelSettings = await this.resolveModelSettings(backend, request);
    const directoryKind =
      request.directoryKind ?? (request.directoryPath?.trim() ? "directory" : "workspace");
    const directoryLabel =
      request.directoryLabel?.trim() ||
      (request.directoryPath ? path.basename(request.directoryPath) : undefined) ||
      "Forked thread";
    const sourceOverlay = await this.overlayStore.getThreadOverlayState({
      backend,
      threadId: request.sourceThreadId,
    });
    const preparedWorkspace = await this.gitDirectoryService.prepareLaunchpadWorkspace({
      backend,
      branchName: request.branchName,
      directoryKind,
      directoryLabel,
      directoryPath: request.directoryPath,
      ...(request.excludedWorktreePaths
        ? { excludedWorktreePaths: request.excludedWorktreePaths }
        : {}),
      worktreeBranchMode: request.worktreeBranchMode,
      workMode: request.workMode ?? "local",
    });
    request.onPreparedWorkspaceRollback?.(preparedWorkspace.rollback);
    const cwd = preparedWorkspace.cwd;
    const linkedDirectories =
      preparedWorkspace.workMode === "worktree"
        ? buildWorktreeLinkedDirectory({
            label: directoryLabel,
            repositoryPath: preparedWorkspace.repositoryPath ?? request.directoryPath,
            worktreePath: cwd,
          })
        : buildLocalLinkedDirectory(cwd);
    const client = this.getClient(backend, executionMode);
    if (!client.forkThread) {
      await preparedWorkspace.rollback?.();
      request.onPreparedWorkspaceRollback?.(undefined);
      throw new Error("Selected backend does not support thread/fork.");
    }

    let result: { threadId: string };
    let forkedCodexEnvironmentRuntime: CodexThreadEnvironmentRuntime | undefined;
    try {
      forkedCodexEnvironmentRuntime = await this.buildForkedCodexEnvironmentRuntime({
        cwd,
        sourceRuntime: sourceOverlay?.codexEnvironmentRuntime,
        workMode: preparedWorkspace.workMode,
      });
      result = await client.forkThread({
        threadId: request.sourceThreadId,
        ...(request.sourceThreadPath?.trim()
          ? { path: request.sourceThreadPath.trim() }
          : {}),
        cwd,
        ...modelSettings,
        approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
        sandbox: request.sandbox ?? modeSettings.sandbox,
        codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
      });
    } catch (error) {
      await preparedWorkspace.rollback?.();
      request.onPreparedWorkspaceRollback?.(undefined);
      throw error;
    }
    try {
      const forkedAt = Date.now();
      const gitBranch = cwd ? await readCurrentGitBranch(cwd).catch(() => undefined) : undefined;
      this.pendingStartedThreads.set(`${backend}:${result.threadId}`, {
        id: result.threadId,
        source: backend,
        title: "Forked thread",
        titleSource: "fallback",
        projectKey: cwd,
        createdAt: forkedAt,
        updatedAt: forkedAt,
        executionMode,
        ...modelSettings,
        ...(forkedCodexEnvironmentRuntime
          ? { codexEnvironmentRuntime: forkedCodexEnvironmentRuntime }
          : {}),
        linkedDirectories: linkedDirectories.map(normalizeLinkedDirectoryKind),
        gitBranch,
      });

      if (preparedWorkspace.workMode === "worktree") {
        await this.recordCodexWorktreeOwnerThread({
          backend,
          threadId: result.threadId,
          worktreePath: cwd,
        });
      }

      await this.overlayStore.setThreadExecutionMode({
        backend,
        threadId: result.threadId,
        executionMode,
      });
      if (
        modelSettings.model !== undefined ||
        modelSettings.reasoningEffort !== undefined ||
        modelSettings.serviceTier !== undefined ||
        modelSettings.fastMode !== undefined
      ) {
        await this.overlayStore.setThreadModelSettings({
          backend,
          threadId: result.threadId,
          ...modelSettings,
        });
      }
      if (forkedCodexEnvironmentRuntime) {
        await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
          backend,
          threadId: result.threadId,
          codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
        });
      }
      if (request.parentThreadId?.trim()) {
        await this.overlayStore.setThreadParent?.({
          backend,
          threadId: result.threadId,
          parentThreadId: request.parentThreadId,
        });
        await this.emit({
          backend,
          notification: {
            method: "thread/parent/set",
            params: {
              threadId: result.threadId,
              parentThreadId: request.parentThreadId,
            },
          },
        });
      }
      await this.updateThreadGitBranchMetadata({
        backend,
        threadId: result.threadId,
        branch: gitBranch,
      });
      this.invalidateThreadListCache(backend);
    } catch (error) {
      this.pendingStartedThreads.delete(`${backend}:${result.threadId}`);
      await preparedWorkspace.rollback?.();
      request.onPreparedWorkspaceRollback?.(undefined);
      throw error;
    }

    return {
      backend,
      sourceThreadId: request.sourceThreadId,
      threadId: result.threadId,
      executionMode,
      linkedDirectory: linkedDirectories[0],
      workMode: preparedWorkspace.workMode,
      codexEnvironmentRuntime: forkedCodexEnvironmentRuntime,
    };
  }

  async submitTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    automationRunId?: string;
  }): Promise<ThreadTurnQueueSubmissionResult> {
    const { origin = "manual", ...entry } = params;
    return await this.threadTurnQueue.submit({
      ...entry,
      origin,
    });
  }

  cancelQueuedTurn(entryId: string, reason?: string): void {
    this.threadTurnQueue.cancelEntry(entryId, reason);
  }

  updateQueuedTurnInput(
    entryId: string,
    input: AppServerTurnInputItem[],
  ): void {
    this.threadTurnQueue.updateQueuedEntryInput(entryId, input);
  }

  canStartThreadTurnImmediately(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean {
    return this.threadTurnQueue.canStartImmediately(params);
  }

  getInProgressThreadSnapshotForQuit(): {
    count: number;
    threadIds: string[];
  } {
    const threadKeys = new Set<string>();
    for (const key of this.activeTurnKeys) {
      const parsed = parseActiveTurnKey(key);
      if (parsed) {
        threadKeys.add(formatQuitThreadKey(parsed.backend, parsed.threadId));
      }
    }
    for (const key of this.activeCodexTurnModes.keys()) {
      const threadId = parseThreadIdFromThreadTurnKeyBody(key);
      if (threadId) {
        threadKeys.add(formatQuitThreadKey("codex", threadId));
      }
    }
    for (const threadId of this.reservedCodexStartThreadIds) {
      threadKeys.add(formatQuitThreadKey("codex", threadId));
    }
    for (const key of this.reservedAcpStartThreadKeys) {
      const parsed = parseReservedAcpStartThreadKey(key);
      if (parsed) {
        threadKeys.add(formatQuitThreadKey(parsed.backend, parsed.threadId));
      }
    }
    for (const entry of this.threadTurnQueue.getAllQueuedEntries()) {
      threadKeys.add(formatQuitThreadKey(entry.backend, entry.threadId));
    }
    const threadIds = [...threadKeys].sort();
    return {
      count: threadIds.length,
      threadIds,
    };
  }

  async startTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    return await this.startTurnNow(params);
  }

  private async startTurnNow(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin?: ThreadTurnQueueOrigin;
    executionMode?: ThreadExecutionMode;
    approvalPolicy?: string;
    sandbox?: string;
    model?: string;
    collaborationMode?: AppServerCollaborationModeRequest;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    this.assertNotBootstrap("startTurn");
    if (isAcpBackendId(params.backend)) {
      const reservationKey = buildTurnStartReservationKey(
        params.backend,
        params.threadId,
      );
      if (this.threadHasActiveTurn(params.threadId, params.backend)) {
        throw new Error("A turn is already active for this thread.");
      }
      this.reservedAcpStartThreadKeys.add(reservationKey);
      try {
        if (this.usesSlashControlledAcpExecutionModes(params.backend)) {
          await this.flushQueuedExecutionModeIfPresent(
            params.threadId,
            params.backend,
          );
        }
        await this.flushQueuedAcpRuntimeOptionIfPresent(
          params.backend,
          params.threadId,
        );
        const result = await this.startAcpTurn({
          backend: params.backend,
          threadId: params.threadId,
          input: params.input,
        });
        this.scheduleThreadTitleGeneration({
          backend: params.backend,
          threadId: result.threadId,
          input: params.input,
        });
        return result;
      } finally {
        this.reservedAcpStartThreadKeys.delete(reservationKey);
      }
    }

    const input = await materializeLocalImageInputs(params.input);
    const reserveCodexStart = params.backend === "codex";
    if (reserveCodexStart) {
      if (this.threadHasActiveTurn(params.threadId)) {
        throw new Error("A turn is already active for this thread.");
      }
      this.reservedCodexStartThreadIds.add(params.threadId);
    }
    // Race-safe flush: if a queued permission-mode change is still
    // pending when the user fires off the next turn (e.g. submit
    // immediately after the previous turn ended), apply it before
    // codex sees the new turn so the new turn runs under the
    // intended profile. The emit-listener flush in `emit()` is the
    // faster path when no immediate user action follows; this is the
    // belt-and-suspenders guarantee. Idempotent — a no-op when no
    // queue is present.
    const syntheticStartedTurnId = `pending:${params.threadId}`;
    let overlay: ThreadOverlayState | undefined;
    let turnParams!: ModelSettings;
    let cwd: string | undefined;
    let activeTurnMode: ThreadExecutionMode | undefined;
    try {
      if (params.backend === "codex") {
        await this.flushQueuedExecutionModeIfPresent(params.threadId);
      }
      overlay = await this.overlayStore.getThreadOverlayState({
        backend: params.backend,
        threadId: params.threadId,
      });
      turnParams = await this.resolveModelSettings(params.backend, {
        ...params,
        model: params.model ?? overlay?.model,
        serviceTier: params.serviceTier ?? overlay?.serviceTier,
        reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
        fastMode: params.backend === "codex" ? params.fastMode ?? overlay?.fastMode : undefined,
      });
      cwd =
        params.backend === "codex"
          ? await this.resolveThreadEnvironmentCwd(
              params.backend,
              params.threadId,
              overlay,
            )
          : undefined;
      await this.emit({
        backend: params.backend,
        notification: {
          method: "turn/started",
          params: {
            threadId: params.threadId,
            turnId: syntheticStartedTurnId,
            turn: {
              id: syntheticStartedTurnId,
              status: "in_progress",
              startedAt: Date.now(),
            },
          },
        },
      });
    } catch (error) {
      this.activeCodexTurnModes.delete(
        buildActiveTurnModeKey(params.threadId, syntheticStartedTurnId),
      );
      if (reserveCodexStart) {
        this.reservedCodexStartThreadIds.delete(params.threadId);
      }
      throw error;
    }

    let result: { threadId: string; turnId: string };
    try {
      result =
        params.backend === "codex"
          ? await this.withCodexThreadClient(params.threadId, async (client, mode) => {
              const effectiveMode = params.executionMode ?? mode;
              const modeSettings = EXECUTION_MODE_SUMMARIES[effectiveMode];
              const agentToolCatalogs = resolveAgentToolCatalogs({
                agent: overlay?.agent,
                automationInspectionHandler: this.automationInspectionHandler,
                messagingHandler: this.messagingHandler,
                threadInspectionHandler: this.threadInspectionHandler,
              });
              const started = await client.startTurn({
                threadId: params.threadId,
                input,
                ...(cwd ? { cwd } : {}),
                collaborationMode: params.collaborationMode,
                ...turnParams,
                approvalPolicy: params.approvalPolicy ?? modeSettings.approvalPolicy,
                sandbox: params.sandbox ?? modeSettings.sandbox,
                ...(overlay?.codexEnvironmentRuntime
                  ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
                  : {}),
                defaultModeRequestUserInput:
                  this.resolveCodexDefaultModeRequestUserInputFn(),
                dynamicTools: buildCodexParentDynamicToolSpecs(agentToolCatalogs),
              });
              activeTurnMode = effectiveMode;
              return started;
            }, params.executionMode)
          : await this.grokClient.startTurn({
              threadId: params.threadId,
              input,
              model: turnParams.model,
              serviceTier: turnParams.serviceTier,
              reasoningEffort: turnParams.reasoningEffort,
              fastMode: turnParams.fastMode,
            });
    } catch (error) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "turn/failed",
          params: {
            threadId: params.threadId,
            turnId: syntheticStartedTurnId,
            turn: {
              id: syntheticStartedTurnId,
              status: "failed",
              completedAt: Date.now(),
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          },
        },
      });
      this.activeCodexTurnModes.delete(
        buildActiveTurnModeKey(params.threadId, syntheticStartedTurnId),
      );
      if (reserveCodexStart) {
        this.reservedCodexStartThreadIds.delete(params.threadId);
      }
      throw error;
    }
    this.activeCodexTurnModes.delete(
      buildActiveTurnModeKey(params.threadId, syntheticStartedTurnId),
    );
    if (params.backend === "codex" && activeTurnMode) {
      this.activeCodexTurnModes.set(
        buildActiveTurnModeKey(result.threadId, result.turnId),
        activeTurnMode,
      );
    }
    if (reserveCodexStart) {
      this.reservedCodexStartThreadIds.delete(params.threadId);
    }

    if (
      turnParams.model !== undefined ||
      turnParams.reasoningEffort !== undefined ||
      turnParams.serviceTier !== undefined ||
      turnParams.fastMode !== undefined
    ) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: result.threadId,
        ...turnParams,
      });
    }
    if (params.backend === "codex" && params.executionMode) {
      await this.overlayStore.setThreadExecutionMode({
        backend: params.backend,
        threadId: result.threadId,
        executionMode: params.executionMode,
      });
    }
    const response = {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    };
    this.scheduleCompletedTurnFromReplay({
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    });
    this.scheduleThreadTitleGeneration({
      backend: params.backend,
      threadId: result.threadId,
      input: params.input,
    });

    return response;
  }

  private scheduleCompletedTurnFromReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): void {
    setTimeout(() => {
      void this.emitCompletedTurnFromReplay(params).catch((error: unknown) => {
        backendRegistryLog.warn("failed to emit completed turn replay event", {
          backend: params.backend,
          threadId: params.threadId,
          turnId: params.turnId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, 0);
  }

  private async emitCompletedTurnFromReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<void> {
    let output: Array<{ type: "text"; text: string }> = [];
    try {
      const replay = await this.readThread({
        backend: params.backend,
        threadId: params.threadId,
      });
      output = assistantOutputForTurn(replay.replay, params.turnId);
    } catch (error) {
      backendRegistryLog.warn("failed to read completed turn replay for local event", {
        backend: params.backend,
        threadId: params.threadId,
        turnId: params.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (output.length === 0) {
      return;
    }

    await this.emit({
      backend: params.backend,
      notification: {
        method: "turn/completed",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          turn: {
            id: params.turnId,
            status: "completed",
            completedAt: Date.now(),
            output,
          },
        },
      },
    });
  }

  async startReview(params: StartReviewRequest): Promise<StartReviewResponse> {
    this.assertNotBootstrap("startReview");
    if (isAcpBackendId(params.backend)) {
      throw new Error("Selected backend does not support review/start");
    }
    const reserveCodexReviewStart = params.backend === "codex";
    if (reserveCodexReviewStart) {
      if (this.threadHasActiveTurn(params.threadId)) {
        throw new Error(`Thread already has an active turn in progress: ${params.threadId}`);
      }
      this.reservedCodexStartThreadIds.add(params.threadId);
    }
    let modelSettings: ModelSettings = {};
    let result: { threadId: string; reviewThreadId: string; turnId: string };
    try {
      modelSettings = hasExplicitModelSettings(params)
        ? await this.resolveReviewModelSettings(params.backend, params)
        : {};
      if (params.backend === "codex") {
        await this.flushQueuedExecutionModeIfPresent(params.threadId);
      }
      const overlay =
        params.backend === "codex"
          ? await this.overlayStore.getThreadOverlayState({
              backend: params.backend,
              threadId: params.threadId,
            })
          : undefined;
      const cwd =
        params.backend === "codex"
          ? await this.resolveThreadEnvironmentCwd(
              params.backend,
              params.threadId,
              overlay,
            )
          : undefined;

      const startWithClient = async (
        client: BackendClient,
      ): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> => {
        if (!client.startReview) {
          throw new Error("Selected backend does not support review/start");
        }
        return await client.startReview({
          threadId: params.threadId,
          target: params.target,
          delivery: params.delivery ?? "inline",
          ...modelSettings,
          ...(cwd ? { cwd } : {}),
          ...(overlay?.codexEnvironmentRuntime
            ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
            : {}),
        });
      };

      result =
        params.backend === "codex"
          ? await this.withCodexThreadClient(params.threadId, startWithClient)
          : await startWithClient(this.getClient(params.backend));
    } catch (error) {
      if (reserveCodexReviewStart) {
        this.reservedCodexStartThreadIds.delete(params.threadId);
      }
      throw error;
    }

    if (params.backend === "codex") {
      try {
        const reviewThreadId = result.reviewThreadId || result.threadId;
        // Codex review/start returns the real review turn id, but current
        // Codex builds can also emit a lone, mismatched turn/started for the
        // same thread. Treat the returned review turn as active so queued
        // turns cannot release in parallel and so the matching terminal
        // review notification clears the active state.
        const activeTurnMode = await this.resolveCodexThreadExecutionModeForActiveTurn(
          reviewThreadId,
        );
        this.activeTurnKeys.add(
          buildActiveTurnKey(params.backend, reviewThreadId, result.turnId),
        );
        this.activeCodexTurnModes.set(
          buildActiveTurnModeKey(reviewThreadId, result.turnId),
          activeTurnMode,
        );
        this.activeCodexReviewTurnKeys.add(
          buildActiveTurnModeKey(reviewThreadId, result.turnId),
        );
      } finally {
        this.reservedCodexStartThreadIds.delete(params.threadId);
      }
    }
    const reviewSubAgentRecord: ReviewSubAgentRecord = {
      backend: params.backend as Exclude<AppServerBackendKind, AcpBackendId>,
      createdAt: Date.now(),
      ...(modelSettings.fastMode !== undefined ? { fastMode: modelSettings.fastMode } : {}),
      ...(modelSettings.model ? { model: modelSettings.model } : {}),
      parentThreadId: result.threadId,
      reviewThreadId: result.reviewThreadId || result.threadId,
      ...(modelSettings.serviceTier ? { serviceTier: modelSettings.serviceTier } : {}),
      task: reviewTaskLabel(params.target),
      turnId: result.turnId,
    };
    const reviewSubAgentKey = buildReviewSubAgentKey(
      reviewSubAgentRecord.backend,
      reviewSubAgentRecord.reviewThreadId,
      reviewSubAgentRecord.turnId,
    );
    this.activeReviewSubAgents.set(reviewSubAgentKey, reviewSubAgentRecord);
    this.reviewSubAgentsByReviewTurn.set(reviewSubAgentKey, reviewSubAgentRecord);
    await this.persistReviewSubAgent(reviewSubAgentRecord);
    if (hasExplicitModelSettings(modelSettings)) {
      await this.overlayStore.setThreadModelSettings({
        backend: params.backend,
        threadId: result.threadId,
        ...modelSettings,
      });
    }

    return {
      backend: params.backend,
      threadId: result.threadId,
      reviewThreadId: result.reviewThreadId,
      turnId: result.turnId,
    };
  }

  async interruptTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }> {
    if (isAcpBackendId(params.backend)) {
      const client = await this.acpBackend.getClient(params.backend);
      await client.cancelSession(params.threadId);
      await this.emit({
        backend: params.backend,
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: params.threadId,
            turnId: params.turnId,
            turn: {
              id: params.turnId,
              status: "cancelled",
              completedAt: Date.now(),
            },
          },
        },
      });
      return params;
    }

    const requestedCodexTurnModeKey =
      params.backend === "codex"
        ? buildActiveTurnModeKey(params.threadId, params.turnId)
        : undefined;
    const codexInterruptTurnId =
      requestedCodexTurnModeKey
        ? this.activeCodexReviewInterruptTurnIds.get(requestedCodexTurnModeKey) ??
          params.turnId
        : params.turnId;
    const interruptParams =
      params.backend === "codex" && codexInterruptTurnId !== params.turnId
        ? { ...params, turnId: codexInterruptTurnId }
        : params;
    const activeCodexTurnMode =
      params.backend === "codex"
        ? this.activeCodexTurnModes.get(
            buildActiveTurnModeKey(params.threadId, codexInterruptTurnId),
          ) ??
          (requestedCodexTurnModeKey
            ? this.activeCodexTurnModes.get(requestedCodexTurnModeKey)
            : undefined)
        : undefined;
    const result =
      params.backend === "codex" && activeCodexTurnMode
        ? await this.getClient("codex", activeCodexTurnMode).interruptTurn(
            interruptParams,
          )
        : params.backend === "codex"
          ? await this.withCodexThreadClient(params.threadId, async (client) =>
              await client.interruptTurn(interruptParams),
            )
        : await this.grokClient.interruptTurn(params);

    if (params.backend === "codex") {
      const activeTurnModeKey = buildActiveTurnModeKey(result.threadId, result.turnId);
      this.activeCodexTurnModes.delete(activeTurnModeKey);
      this.activeCodexReviewTurnKeys.delete(activeTurnModeKey);
      if (requestedCodexTurnModeKey && requestedCodexTurnModeKey !== activeTurnModeKey) {
        this.activeCodexTurnModes.delete(requestedCodexTurnModeKey);
        this.activeCodexReviewTurnKeys.delete(requestedCodexTurnModeKey);
      }
    }

    return {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  }

  async compactThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<{
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
    itemId?: string;
  }> {
    const compactWithClient = async (
      client: BackendClient,
    ): Promise<{ threadId: string; turnId: string; itemId?: string }> => {
      if (!client.compactThread) {
        throw new Error("Selected backend does not support thread compaction");
      }
      return await client.compactThread({
        threadId: params.threadId,
      });
    };

    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, compactWithClient)
        : await compactWithClient(this.grokClient);

    return {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
      itemId: result.itemId,
    };
  }

  async steerTurn(params: SteerTurnRequest): Promise<SteerTurnResponse> {
    const steerWithClient = async (
      client: BackendClient,
    ): Promise<{ threadId: string; turnId: string }> => {
      if (!client.steerTurn) {
        throw new Error("Selected backend does not support turn/steer");
      }
      return await client.steerTurn({
        threadId: params.threadId,
        input: params.input,
        expectedTurnId: params.expectedTurnId,
      });
    };

    const result =
      params.backend === "codex"
        ? await this.withActiveCodexThreadClient(params.threadId, steerWithClient)
        : await steerWithClient(this.grokClient);

    return {
      backend: params.backend,
      threadId: result.threadId,
      turnId: result.turnId,
    };
  }

  /**
   * User-facing entry point for permission-mode changes. Decides
   * queue-vs-apply based on whether a turn is currently in flight on
   * the thread.
   *
   * Codex's `thread/resume` rejects (or warn-and-ignores) permission
   * overrides while a turn is running, so the only legal moment to
   * change a thread's permission profile is the resume boundary — i.e.
   * turn-end. Toggles received during an active turn are queued in
   * registry memory and flushed automatically on `thread/status/changed
   * → idle` (or just before the next `turn/start`, whichever fires
   * first). See the state-machine diagram in the Phase 2 plan for the
   * full transition table.
   */
  async setThreadExecutionMode(
    params: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
      if (
        isAcpBackendId(params.backend) &&
        this.usesSlashControlledAcpExecutionModes(params.backend)
      ) {
        return await this.setSlashControlledAcpExecutionMode({
          ...params,
          backend: params.backend,
        });
      }
      // ACP backends without a slash-driven approval-policy toggle (e.g.
      // Gemini today) currently no-op on execution mode — no overlay
      // write, no backend change. We still emit on the bus so all
      // surfaces stay visually consistent with the user's click. The
      // optimistic UI is the same lie either way; symmetric emission is
      // better than partial fan-out.
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/updated",
          params: {
            threadId: params.threadId,
            executionMode: params.executionMode,
          },
        },
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: params.executionMode,
      };
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.threadId,
    });
    const currentApplied = overlay?.executionMode ?? "default";
    const hasActiveTurn = this.threadHasActiveTurn(params.threadId, "codex");
    const queueKey = executionModeQueueKey("codex", params.threadId);
    const hasQueue = this.queuedExecutionModes.has(queueKey);

    // Toggling back to the currently-applied mode while a queue is
    // pending is a cancel — the user changed their mind. No codex call,
    // no overlay flip.
    if (hasQueue && params.executionMode === currentApplied) {
      await this.cancelThreadExecutionModeQueue({
        backend: "codex",
        threadId: params.threadId,
      });
      return {
        backend: "codex",
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    // Active turn → queue. No codex call, no overlay executionMode flip.
    if (hasActiveTurn && params.executionMode !== currentApplied) {
      const queued = await this.queueThreadExecutionMode(params);
      // The user-facing setThreadExecutionMode response shape is
      // SetThreadExecutionModeResponse — we report the queued mode as
      // the "executionMode" so callers see the thing they intended,
      // even though it isn't applied yet. The queued state is also
      // surfaced via the `thread/executionMode/queued` bus event for
      // surfaces that need to render the pending-state distinct from
      // the applied state.
      return {
        backend: "codex",
        threadId: params.threadId,
        executionMode: queued.queuedExecutionMode,
      };
    }

    // No active turn → apply immediately.
    return await this.applyThreadExecutionMode(params);
  }

  private async setSlashControlledAcpExecutionMode(
    params: SetThreadExecutionModeRequest & { backend: AcpBackendId },
  ): Promise<SetThreadExecutionModeResponse> {
    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );
    const hasActiveTurn = this.threadHasActiveTurn(params.threadId, params.backend);
    const queueKey = executionModeQueueKey(params.backend, params.threadId);
    const hasQueue = this.queuedExecutionModes.has(queueKey);

    if (hasQueue && params.executionMode === currentApplied) {
      await this.cancelThreadExecutionModeQueue({
        backend: params.backend,
        threadId: params.threadId,
      });
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    if (params.executionMode === currentApplied) {
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    if (hasActiveTurn && params.executionMode !== currentApplied) {
      const queued = await this.queueThreadExecutionMode(params);
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: queued.queuedExecutionMode,
      };
    }

    return await this.applyThreadExecutionMode(params);
  }

  /**
   * Snapshot of in-memory queued execution modes keyed by thread identity.
   * Consumed by the navigation snapshot path so the renderer sees
   * queued state on the very first snapshot after restart, without
   * waiting for a follow-up bus event. The queue map itself is not
   * persisted — but the audit log entries are, so historical context
   * survives restarts.
   */
  getQueuedExecutionModesSnapshot(): Record<
    string,
    { mode: ThreadExecutionMode; queuedAt: number } | undefined
  > {
    const snapshot: Record<
      string,
      { mode: ThreadExecutionMode; queuedAt: number }
    > = {};
    for (const [queueKey, entry] of this.queuedExecutionModes) {
      snapshot[queueKey] = {
        mode: entry.mode,
        queuedAt: entry.queuedAt,
      };
    }
    return snapshot;
  }

  private usesKimiSlashExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    if (!isAcpBackendId(backend)) {
      return false;
    }
    const agent = this.acpBackend.getInstalledAgent(backend);
    if (agent?.registryId !== "kimi") {
      return false;
    }
    // Once kimi advertises its own runtime mode selector (Default/Plan/Auto/
    // Yolo via session capabilities), the legacy `/yolo` slash command is both
    // obsolete and rejected by current kimi (#658). The runtime "yolo" mode —
    // set over the standard `session/set_mode` protocol method — is the
    // approval-policy control instead, so never drive kimi through the slash
    // path in that case. Falls back to `/yolo` only for a kimi build that
    // exposes no runtime mode selector of its own.
    return !acpAdvertisesRuntimeModeSelector(agent.runtimeCapabilities);
  }

  private usesGrokSlashExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    return (
      isAcpBackendId(backend) &&
      this.acpBackend.getInstalledAgent(backend)?.registryId === "grok"
    );
  }

  /**
   * Umbrella for ACP backends whose Default/Full Access toggle is driven by
   * a slash command sent over `session/prompt` (rather than a first-class
   * protocol method or a relaunch). Kimi uses `/yolo`; Grok uses
   * `/always-approve on|off`. Both share the same orchestration: queue
   * during active turns, flush at turn-end, write per-thread audit log,
   * emit `thread/executionMode/updated` on the bus. The per-agent slash
   * command text + response handling lives in the apply*ControlPrompt
   * helpers.
   */
  private usesSlashControlledAcpExecutionModes(
    backend: AppServerBackendKind,
  ): backend is AcpBackendId {
    return (
      this.usesKimiSlashExecutionModes(backend) ||
      this.usesGrokSlashExecutionModes(backend)
    );
  }

  private backendUsesQueuedExecutionModes(
    backend: AppServerBackendKind,
  ): boolean {
    return (
      backend === "codex" || this.usesSlashControlledAcpExecutionModes(backend)
    );
  }

  private async readAppliedExecutionMode(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<ThreadExecutionMode> {
    if (backend === "codex") {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend,
        threadId,
      });
      return overlay?.executionMode ?? "default";
    }
    if (this.usesSlashControlledAcpExecutionModes(backend)) {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend,
        threadId,
      });
      return (
        this.latestAppliedExecutionModeFromOverlay(overlay) ??
        this.acpBackend.getSession(backend, threadId)?.executionMode ?? "default"
      );
    }
    return "default";
  }

  private latestAppliedExecutionModeFromOverlay(
    overlay: ThreadOverlayState | undefined,
  ): ThreadExecutionMode | undefined {
    return [...(overlay?.permissionTransitionLog ?? [])]
      .reverse()
      .find((transition) => transition.status === "applied")
      ?.toExecutionMode;
  }

  async queueThreadExecutionMode(
    params: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> {
    if (!this.backendUsesQueuedExecutionModes(params.backend)) {
      // Non-codex backends don't have a queue concept; fall through to
      // immediate apply so the caller observes consistent semantics.
      await this.setThreadExecutionMode(params);
      return {
        backend: params.backend,
        threadId: params.threadId,
        queuedExecutionMode: params.executionMode,
        queuedAt: Date.now(),
      };
    }

    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );
    const queuedAt = Date.now();
    const queueId = randomUUID();

    const queueKey = executionModeQueueKey(params.backend, params.threadId);

    this.queuedExecutionModes.set(queueKey, {
      backend: params.backend,
      mode: params.executionMode,
      queuedAt,
      queueId,
      flushAttempts: 0,
    });

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: currentApplied,
        toExecutionMode: params.executionMode,
        status: "queued",
        occurredAt: queuedAt,
        queueId,
      },
    });

    backendRegistryLog.info("queued thread execution mode change", {
      threadId: params.threadId,
      from: currentApplied,
      to: params.executionMode,
      queueId,
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/queued",
        params: {
          threadId: params.threadId,
          queuedExecutionMode: params.executionMode,
          queuedAt,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      queuedExecutionMode: params.executionMode,
      queuedAt,
    };
  }

  async cancelThreadExecutionModeQueue(
    params: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    const currentApplied = await this.readAppliedExecutionMode(
      params.backend,
      params.threadId,
    );

    const queue =
      this.backendUsesQueuedExecutionModes(params.backend)
        ? this.queuedExecutionModes.get(
            executionModeQueueKey(params.backend, params.threadId),
          )
        : undefined;
    if (!queue) {
      // Idempotent: cancel of nothing is a no-op that returns the
      // current applied mode.
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: currentApplied,
      };
    }

    this.queuedExecutionModes.delete(
      executionModeQueueKey(params.backend, params.threadId),
    );

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: currentApplied,
        toExecutionMode: queue.mode,
        status: "cancelled",
        occurredAt: Date.now(),
        queueId: queue.queueId,
      },
    });

    backendRegistryLog.info("cancelled queued thread execution mode change", {
      threadId: params.threadId,
      from: currentApplied,
      to: queue.mode,
      queueId: queue.queueId,
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/queueCleared",
        params: {
          threadId: params.threadId,
          reason: "cancelled",
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: currentApplied,
    };
  }

  /**
   * Actually apply a permission-mode change to codex. Called from both
   * the immediate-apply path (toggle while idle) and the queue-flush
   * path (turn-end). When called from the queue, `fromQueue: true`
   * propagates the queue's `queueId` into the resulting `applied`
   * audit entry and emits the matching `queueCleared(applied)` event.
   */
  private async applyThreadExecutionMode(
    params: SetThreadExecutionModeRequest,
    options?: { fromQueue?: boolean; queueId?: string },
  ): Promise<SetThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
      if (
        isAcpBackendId(params.backend) &&
        this.usesSlashControlledAcpExecutionModes(params.backend)
      ) {
        return await this.applySlashControlledAcpThreadExecutionMode(
          {
            ...params,
            backend: params.backend,
          },
          options,
        );
      }
      // No-op path for ACP backends without a slash-driven toggle.
      // Direct callers route through setThreadExecutionMode which
      // short-circuits before reaching this method, so we should never
      // get here, but guard anyway.
      return {
        backend: params.backend,
        threadId: params.threadId,
        executionMode: params.executionMode,
      };
    }

    const previousOverlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.threadId,
    });
    const previousApplied = previousOverlay?.executionMode ?? "default";

    const modeSettings = EXECUTION_MODE_SUMMARIES[params.executionMode];
    const result = await this.withCodexThreadClient(
      params.threadId,
      async (client) => {
        if (!client.setThreadPermissions) {
          throw new Error(
            "Selected backend does not support execution mode updates",
          );
        }
        return await client.setThreadPermissions({
          threadId: params.threadId,
          approvalPolicy: modeSettings.approvalPolicy,
          sandbox: modeSettings.sandbox,
        });
      },
    );

    const resolvedThreadId = result.threadId;

    await this.overlayStore.setThreadExecutionMode({
      backend: "codex",
      threadId: resolvedThreadId,
      executionMode: params.executionMode,
    });

    // The queueId (if this apply came from a queue flush) is passed
    // through `options.queueId` because the flush atomically claimed
    // the queue (deleted from the map) before calling apply — so we
    // can't read it back from `queuedExecutionModes` here. Direct
    // applies (idle path) leave it undefined.
    const queueIdForAuditLink = options?.queueId;

    await this.appendPermissionTransition({
      threadId: resolvedThreadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
        status: "applied",
        occurredAt: Date.now(),
        queueId: queueIdForAuditLink,
      },
    });

    await this.emit({
      backend: "codex",
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: resolvedThreadId,
          executionMode: params.executionMode,
        },
      },
    });

    if (options?.fromQueue) {
      // Order matters: clients must see the apply BEFORE the
      // queue-clear. The applied transition is now in the log; the
      // overlay's executionMode is current. The queue map entry was
      // already atomically claimed (deleted) by
      // flushQueuedExecutionModeIfPresent before we ran, so just
      // emit the event for downstream listeners.
      await this.emit({
        backend: "codex",
        notification: {
          method: "thread/executionMode/queueCleared",
          params: {
            threadId: resolvedThreadId,
            reason: "applied",
          },
        },
      });
    }

    return {
      backend: "codex",
      threadId: resolvedThreadId,
      executionMode: params.executionMode,
    };
  }

  private async applySlashControlledAcpThreadExecutionMode(
    params: SetThreadExecutionModeRequest & { backend: AcpBackendId },
    options?: { fromQueue?: boolean; queueId?: string },
  ): Promise<SetThreadExecutionModeResponse> {
    const session = this.acpBackend.getSession(params.backend, params.threadId);
    if (!session) {
      throw new Error(`ACP session not found: ${params.threadId}`);
    }
    const previousApplied = session.executionMode ?? "default";
    const client = await this.acpBackend.getClient(params.backend);
    await client.ensureSession?.(session);
    const registryId = this.acpBackend.getInstalledAgent(params.backend)
      ?.registryId;
    if (registryId === "kimi") {
      await this.applyKimiAcpExecutionModeControlPrompt({
        backend: params.backend,
        client,
        sessionId: params.threadId,
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
      });
    } else if (registryId === "grok") {
      await this.applyGrokAcpExecutionModeControlPrompt({
        backend: params.backend,
        client,
        sessionId: params.threadId,
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
      });
    } else {
      throw new Error(
        `Unsupported slash-controlled ACP registry: ${registryId ?? "<unknown>"}`,
      );
    }

    const updatedAt = Date.now();
    this.acpBackend.upsertSession({
      ...session,
      executionMode: params.executionMode,
      updatedAt: Math.max(session.updatedAt, updatedAt),
    });

    await this.appendPermissionTransition({
      backend: params.backend,
      threadId: params.threadId,
      transition: {
        id: randomUUID(),
        fromExecutionMode: previousApplied,
        toExecutionMode: params.executionMode,
        status: "applied",
        occurredAt: updatedAt,
        queueId: options?.queueId,
      },
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: params.threadId,
          executionMode: params.executionMode,
        },
      },
    });

    if (options?.fromQueue) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/executionMode/queueCleared",
          params: {
            threadId: params.threadId,
            reason: "applied",
          },
        },
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      executionMode: params.executionMode,
    };
  }

  private async applyKimiAcpExecutionModeControlPrompt(params: {
    backend: AcpBackendId;
    client: AcpRuntimeClient;
    sessionId: string;
    fromExecutionMode: ThreadExecutionMode;
    toExecutionMode: ThreadExecutionMode;
  }): Promise<void> {
    if (!this.usesKimiSlashExecutionModes(params.backend)) {
      return;
    }
    if (params.fromExecutionMode === params.toExecutionMode) {
      return;
    }
    const client = params.client;
    if (!client.sendControlPrompt) {
      throw new Error("Kimi ACP execution mode updates require control prompts");
    }
    const result = await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.sessionId),
      async () =>
        await client.sendControlPrompt!({
          sessionId: params.sessionId,
          prompt: "/yolo",
        }),
    );
    const observedMode = readKimiYoloExecutionModeFromText(result.text);
    if (observedMode !== params.toExecutionMode) {
      const target = formatExecutionModeForError(params.toExecutionMode);
      const observed = observedMode
        ? formatExecutionModeForError(observedMode)
        : "unknown state";
      throw new Error(
        `Kimi ACP /yolo did not confirm ${target}; observed ${observed}`,
      );
    }
  }

  /**
   * Grok exposes Default/Full Access via `/always-approve on` and
   * `/always-approve off` (per the `availableCommands` advertised in its
   * `initialize` response — name "always-approve", hint "on|off"). Unlike
   * Kimi's `/yolo`, Grok's slash command returns no `agent_message_chunk`
   * — the only success signal is a clean `end_turn` `session/prompt`
   * response, and `/session-info` does NOT reflect the toggled state
   * (verified by probe). So we trust `sendControlPrompt` resolving
   * without a JSON-RPC error as success; the only failure modes we can
   * detect are transport errors and a non-end_turn stopReason, both of
   * which surface as thrown exceptions from the client.
   */
  private async applyGrokAcpExecutionModeControlPrompt(params: {
    backend: AcpBackendId;
    client: AcpRuntimeClient;
    sessionId: string;
    fromExecutionMode: ThreadExecutionMode;
    toExecutionMode: ThreadExecutionMode;
  }): Promise<void> {
    if (!this.usesGrokSlashExecutionModes(params.backend)) {
      return;
    }
    if (params.fromExecutionMode === params.toExecutionMode) {
      return;
    }
    const client = params.client;
    if (!client.sendControlPrompt) {
      throw new Error("Grok ACP execution mode updates require control prompts");
    }
    const command =
      params.toExecutionMode === "full-access"
        ? "/always-approve on"
        : "/always-approve off";
    await this.acpSessionPromptLocks.run(
      executionModeQueueKey(params.backend, params.sessionId),
      async () =>
        await client.sendControlPrompt!({
          sessionId: params.sessionId,
          prompt: command,
        }),
    );
  }

  /**
   * Returns true iff the registry currently believes a turn is in
   * flight on this thread. `activeCodexTurnModes` is keyed by
   * `${threadId}:${turnId}`; one or more matching keys → active turn.
   */
  private threadHasActiveTurn(
    threadId: string,
    backend: AppServerBackendKind = "codex",
  ): boolean {
    if (backend === "codex") {
      if (this.reservedCodexStartThreadIds.has(threadId)) {
        return true;
      }

      const prefix = `${threadId}:`;
      for (const key of this.activeCodexTurnModes.keys()) {
        if (key.startsWith(prefix)) {
          return true;
        }
      }
      return false;
    }
    if (this.reservedAcpStartThreadKeys.has(
      buildTurnStartReservationKey(backend, threadId),
    )) {
      return true;
    }
    const prefix = `${backend}:${threadId}:`;
    for (const key of this.activeTurnKeys) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  private threadHasActiveCodexReviewTurn(threadId: string): boolean {
    return Boolean(this.findActiveCodexReviewTurnKey(threadId));
  }

  private findActiveCodexReviewTurnKey(threadId: string): string | undefined {
    const prefix = `${threadId}:`;
    for (const key of this.activeCodexReviewTurnKeys) {
      if (key.startsWith(prefix)) {
        return key;
      }
    }
    return undefined;
  }

  private clearCodexReviewInterruptMappingForTurn(
    threadId: string,
    turnId: string,
  ): void {
    const activeTurnModeKey = buildActiveTurnModeKey(threadId, turnId);
    this.activeCodexReviewInterruptTurnIds.delete(activeTurnModeKey);
    for (const [reviewTurnKey, interruptTurnId] of Array.from(
      this.activeCodexReviewInterruptTurnIds.entries()
    )) {
      if (
        reviewTurnKey.startsWith(`${threadId}:`) &&
        interruptTurnId === turnId
      ) {
        this.activeCodexReviewInterruptTurnIds.delete(reviewTurnKey);
      }
    }
  }

  private async resolveCodexThreadExecutionModeForActiveTurn(
    threadId: string,
  ): Promise<ThreadExecutionMode> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId,
    });
    return overlay?.executionMode ?? "default";
  }

  /**
   * Append a permission-transition entry to the overlay-store audit
   * log. Soft-fails on overlay-store errors so a transient persistence
   * failure does not block the queue state machine — the in-memory
   * state remains correct, and the bus notification still fires.
   */
  private async appendPermissionTransition(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    transition: ThreadPermissionTransition;
  }): Promise<void> {
    try {
      await this.overlayStore.appendPermissionTransition({
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        transition: params.transition,
      });
    } catch (error) {
      backendRegistryLog.error("failed to append permission transition", {
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        status: params.transition.status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist a backend `turn/failed` outcome to the thread overlay so the
   * renderer can materialize a durable `turn-failed:<turnId>` transcript
   * entry. Codex does not persist a failure marker in its own transcript,
   * so without this the failure vanishes on the next `readThread`. Called
   * from `emit()` before the renderer fan-out so the entry is present when
   * the navigation snapshot refreshes.
   */
  private async appendTurnFailure(params: {
    backend?: AppServerBackendKind;
    threadId: string;
    failure: ThreadTurnFailure;
  }): Promise<void> {
    try {
      await this.overlayStore.appendTurnFailure({
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        failure: params.failure,
      });
    } catch (error) {
      backendRegistryLog.error("failed to append turn failure", {
        backend: params.backend ?? "codex",
        threadId: params.threadId,
        turnId: params.failure.turnId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Flush any queued permission-mode change for the given thread.
   * Called from two places:
   *  - the `emit()` listener when codex reports `thread/status/changed
   *    → idle` (or `turn/completed`), as the natural turn-end signal.
   *  - the top of `startTurn`/`startReview` for codex, to guarantee
   *    the queue applies BEFORE the next turn or review fires
   *    (race-safe ordering).
   *
   * Idempotent: a no-op when no queue is present. On apply error, the
   * queue is retained and the failure counter is incremented; after
   * `MAX_QUEUE_FLUSH_ATTEMPTS` consecutive failures, the queue is
   * auto-cancelled with an explanatory note in the audit log.
   */
  private async flushQueuedExecutionModeIfPresent(
    threadId: string,
    backend: AppServerBackendKind = "codex",
  ): Promise<void> {
    const queueKey = executionModeQueueKey(backend, threadId);
    const activeFlush = this.queuedExecutionModeFlushes.get(queueKey);
    if (activeFlush) {
      await activeFlush;
      return;
    }

    const queue = this.queuedExecutionModes.get(queueKey);
    if (!queue) return;
    // Atomic claim: in JS's single-threaded event loop, `Map.delete`
    // returning true gives this caller exclusive ownership of the
    // apply. Concurrent flushes (one from the emit-listener turn-end
    // hook, one from startTurn's race-safe prefix) both see the same
    // queue but only one's delete returns true — the other no-ops.
    // Without this, both callers race on applyThreadExecutionMode and
    // each appends a duplicate "applied" transition entry.
    if (!this.queuedExecutionModes.delete(queueKey)) {
      return;
    }

    const flush = this.applyClaimedQueuedExecutionMode(threadId, queueKey, queue);
    this.queuedExecutionModeFlushes.set(queueKey, flush);
    try {
      await flush;
    } finally {
      if (this.queuedExecutionModeFlushes.get(queueKey) === flush) {
        this.queuedExecutionModeFlushes.delete(queueKey);
      }
    }
  }

  private async applyClaimedQueuedExecutionMode(
    threadId: string,
    queueKey: string,
    queue: {
      backend: AppServerBackendKind;
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    },
  ): Promise<void> {
    try {
      await this.applyThreadExecutionMode(
        {
          backend: queue.backend,
          threadId,
          executionMode: queue.mode,
        },
        { fromQueue: true, queueId: queue.queueId },
      );
    } catch (error) {
      const attempts = queue.flushAttempts + 1;
      const stillRetained = this.queuedExecutionModes.get(queueKey);
      if (stillRetained && stillRetained.queueId !== queue.queueId) {
        // The queue was replaced while we were mid-apply (the user
        // queued a different target). Discard our retry — the new
        // state wins.
        return;
      }
      if (attempts >= MAX_QUEUE_FLUSH_ATTEMPTS) {
        backendRegistryLog.error(
          "auto-cancelling queued execution mode change after repeated failures",
          {
            threadId,
            queueId: queue.queueId,
            attempts,
            error: error instanceof Error ? error.message : String(error),
          },
        );
        const overlay = await this.overlayStore
          .getThreadOverlayState({ backend: queue.backend, threadId })
          .catch(() => undefined);
        const currentApplied =
          queue.backend === "codex"
            ? overlay?.executionMode ?? "default"
            : await this.readAppliedExecutionMode(queue.backend, threadId);
        this.queuedExecutionModes.delete(queueKey);
        await this.appendPermissionTransition({
          backend: queue.backend,
          threadId,
          transition: {
            id: randomUUID(),
            fromExecutionMode: currentApplied,
            toExecutionMode: queue.mode,
            status: "cancelled",
            occurredAt: Date.now(),
            queueId: queue.queueId,
            note: `auto-cancelled after ${MAX_QUEUE_FLUSH_ATTEMPTS} failed flush attempts`,
          },
        });
        await this.emit({
          backend: queue.backend,
          notification: {
            method: "thread/executionMode/queueCleared",
            params: {
              threadId,
              reason: "cancelled",
            },
          },
        });
        return;
      }
      this.queuedExecutionModes.set(queueKey, {
        ...queue,
        flushAttempts: attempts,
      });
      backendRegistryLog.warn("queued execution mode flush failed; will retry", {
        threadId,
        queueId: queue.queueId,
        attempts,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async setThreadModelSettings(
    params: SetThreadModelSettingsRequest
  ): Promise<SetThreadModelSettingsResponse> {
    const modelSettings = await this.resolveModelSettings(
      params.backend,
      params,
      "settings-refresh",
    );
    await this.overlayStore.setThreadModelSettings({
      backend: params.backend,
      threadId: params.threadId,
      ...modelSettings,
    });

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/modelSettings/updated",
        params: {
          threadId: params.threadId,
          ...modelSettings,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      ...modelSettings,
    };
  }

  async checkThreadBranchDrift(
    params: CheckThreadBranchDriftRequest,
  ): Promise<CheckThreadBranchDriftResponse> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const thread = await this.findThreadForWorkspaceHandoff({
      backend: params.backend,
      callerReason: "branch-drift",
      threadId: params.threadId,
    });
    const overlayExpectedBranch = overlay?.gitBranch?.trim();
    const requestedExpectedBranch = params.expectedBranch?.trim();
    const expectedBranch =
      overlayExpectedBranch ||
      requestedExpectedBranch ||
      resolveExpectedThreadBranch({
        overlay,
        thread,
      });
    const workspaceCwd = resolveThreadWorkspaceCwd(
      thread,
      overlay?.extraLinkedDirectories ?? [],
    );
    const observedBranch = workspaceCwd
      ? await readCurrentGitBranch(workspaceCwd).catch(() => thread?.observedGitBranch)
      : thread?.observedGitBranch;
    const normalizedObservedBranch = observedBranch?.trim() || undefined;

    const drifted = isBranchDrifted(expectedBranch, normalizedObservedBranch);

    await this.overlayStore.setThreadObservedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
      expectedBranch: drifted ? expectedBranch : undefined,
    });

    if (drifted) {
      backendRegistryLog.debug("checked thread branch drift", {
        backend: params.backend,
        drifted,
        expectedBranch,
        observedBranch: normalizedObservedBranch,
        workspaceCwd,
        threadId: params.threadId,
      });
    }

    return {
      backend: params.backend,
      threadId: params.threadId,
      expectedBranch,
      observedBranch: normalizedObservedBranch,
      drifted,
      checkedAt: Date.now(),
    };
  }

  private async adoptThreadBranchChangeFromActiveTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const thread = await this.findThreadForWorkspaceHandoff({
      backend: params.backend,
      callerReason: "active-turn-branch-adoption",
      threadId: params.threadId,
    });
    const workspaceCwd = resolveThreadWorkspaceCwd(
      thread,
      overlay?.extraLinkedDirectories ?? [],
    );
    const observedBranch = workspaceCwd
      ? await readCurrentGitBranch(workspaceCwd).catch(() => thread?.observedGitBranch)
      : thread?.observedGitBranch;
    const normalizedObservedBranch = observedBranch?.trim() || undefined;

    if (!normalizedObservedBranch) {
      return;
    }

    if (normalizedObservedBranch === "HEAD") {
      await this.overlayStore.setThreadObservedBranch({
        backend: params.backend,
        threadId: params.threadId,
        branch: normalizedObservedBranch,
      });
      return;
    }

    const previousExpectedBranch = resolveExpectedThreadBranch({
      overlay,
      thread,
    });
    await this.overlayStore.setThreadExpectedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
    });
    await this.updateThreadGitBranchMetadata({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
    });
    if (previousExpectedBranch !== normalizedObservedBranch) {
      await this.emit({
        backend: params.backend,
        notification: {
          method: "thread/branch/updated",
          params: {
            threadId: params.threadId,
            branch: normalizedObservedBranch,
          },
        },
      } as unknown as AgentEvent);
    }

    if (previousExpectedBranch !== normalizedObservedBranch) {
      backendRegistryLog.info("adopted active-turn branch change", {
        backend: params.backend,
        observedBranch: normalizedObservedBranch,
        previousExpectedBranch,
        workspaceCwd,
        threadId: params.threadId,
      });
    }
  }

  async updateThreadExpectedBranch(
    params: UpdateThreadExpectedBranchRequest,
  ): Promise<UpdateThreadExpectedBranchResponse> {
    const branch = params.branch.trim();
    if (!branch) {
      throw new Error("Expected branch cannot be blank.");
    }

    await this.overlayStore.setThreadExpectedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch,
    });
    await this.updateThreadGitBranchMetadata({
      backend: params.backend,
      threadId: params.threadId,
      branch,
    });
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/branch/updated",
        params: {
          threadId: params.threadId,
          branch,
        },
      },
    } as unknown as AgentEvent);

    backendRegistryLog.info("updated thread expected branch", {
      backend: params.backend,
      branch,
      threadId: params.threadId,
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      branch,
      updatedAt: Date.now(),
    };
  }

  async retainThreadBranchDrift(
    params: RetainThreadBranchDriftRequest,
  ): Promise<RetainThreadBranchDriftResponse> {
    const retainedAt = Date.now();
    // R14: refuse to persist (HEAD, *) pairs. Each "first named branch
    // after detached HEAD" is a meaningful new context that should
    // re-prompt the user, not be permanently silenced.
    if (params.expectedBranch !== "HEAD") {
      await this.overlayStore.retainThreadBranchDrift({
        backend: params.backend,
        threadId: params.threadId,
        expectedBranch: params.expectedBranch,
        observedBranch: params.observedBranch,
        retainedAt,
      });
    }

    return {
      ...params,
      retainedAt,
    };
  }

  async submitServerRequest(
    params: SubmitServerRequestRequest
  ): Promise<SubmitServerRequestResponse> {
    this.assertNotBootstrap("submitServerRequest");
    const key = buildPendingRequestKey(params);
    const pending = this.pendingServerRequests.get(key);
    if (!pending) {
      throw new Error(`No pending server request found for ${params.requestId}`);
    }

    this.pendingServerRequests.delete(key);
    pending.resolve(params.response);
    await this.emit({
      backend: params.backend,
      notification: {
        method: "serverRequest/resolved",
        params: {
          threadId: params.threadId,
          turnId: params.turnId,
          requestId: params.requestId,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: params.threadId,
      turnId: params.turnId,
      requestId: params.requestId,
    };
  }

  async ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const codexEnvironmentOptions = await listCodexEnvironmentOptions(
      request.directoryPath,
    );
    const existing = await this.overlayStore.getDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    const defaults = await this.resolveLaunchpadDefaults(
      await this.overlayStore.getLaunchpadDefaults(),
      request.preferredBackend,
    );
    if (existing) {
      const registeredAt = existing.registeredAt ?? request.registeredAt;
      const existingLaunchpad = projectNavigationLaunchpadProviderSettings(existing);
      const backend = await this.resolveLaunchpadBackend(existingLaunchpad.backend);
      const modelSettings = await this.resolveLaunchpadModelSettings(
        backend,
        existingLaunchpad,
      );
      const executionMode = getAvailableExecutionMode(
        backend,
        existingLaunchpad.executionMode,
      );
      const normalizedExisting: NavigationLaunchpadDraft = {
        ...existingLaunchpad,
        backend: backend.kind,
        executionMode,
        ...modelSettings,
      };
      const requestParentThreadId =
        request.parentThreadId ?? normalizedExisting.parentThreadId;
      const requestParentThreadTitle =
        request.parentThreadTitle ?? normalizedExisting.parentThreadTitle;
      const identityChanged =
        normalizedExisting.directoryKind !== request.directoryKind ||
        normalizedExisting.directoryLabel !== request.directoryLabel ||
        normalizedExisting.directoryPath !== request.directoryPath;
      const parentChanged =
        request.parentThreadId !== undefined &&
        (normalizedExisting.parentThreadId !== request.parentThreadId ||
          normalizedExisting.parentThreadTitle !== request.parentThreadTitle);

      if (isEmptyDirectoryLaunchpadDraft(existing)) {
        const refreshed: NavigationLaunchpadDraft = {
          ...normalizedExisting,
          directoryKind: request.directoryKind,
          directoryLabel: request.directoryLabel,
          directoryPath: request.directoryPath,
          backend: defaults.backend,
          executionMode: defaults.executionMode,
          model: defaults.model,
          reasoningEffort: defaults.reasoningEffort,
          serviceTier: defaults.serviceTier,
          fastMode: defaults.fastMode,
          acpRuntime: defaults.acpRuntime,
          providerSettings: defaults.providerSettings,
          workMode: defaultLaunchpadWorkMode(request, defaults),
          branchName: existing.branchName ?? request.currentBranch,
          parentThreadId: requestParentThreadId,
          parentThreadTitle: requestParentThreadTitle,
          registeredAt,
          updatedAt: Date.now(),
        };
        return {
          launchpad: withCodexEnvironmentOptions(
            await this.overlayStore.upsertDirectoryLaunchpad(refreshed),
            codexEnvironmentOptions,
          ),
          defaults,
        };
      }

      if (
        identityChanged ||
        normalizedExisting.backend !== existing.backend ||
        normalizedExisting.executionMode !== existing.executionMode ||
        normalizedExisting.model !== existing.model ||
        normalizedExisting.reasoningEffort !== existing.reasoningEffort ||
        normalizedExisting.serviceTier !== existing.serviceTier ||
        normalizedExisting.fastMode !== existing.fastMode ||
        registeredAt !== existing.registeredAt ||
        parentChanged
      ) {
        return {
          launchpad: withCodexEnvironmentOptions(
            await this.overlayStore.upsertDirectoryLaunchpad({
              ...normalizedExisting,
              directoryKind: request.directoryKind,
              directoryLabel: request.directoryLabel,
              directoryPath: request.directoryPath,
              parentThreadId: requestParentThreadId,
              parentThreadTitle: requestParentThreadTitle,
              registeredAt,
              updatedAt: Date.now(),
            }),
            codexEnvironmentOptions,
          ),
          defaults,
        };
      }

      return {
        launchpad: withCodexEnvironmentOptions(existing, codexEnvironmentOptions),
        defaults,
      };
    }

    const launchpad: NavigationLaunchpadDraft = {
      directoryKey: request.directoryKey,
      directoryKind: request.directoryKind,
      directoryLabel: request.directoryLabel,
      directoryPath: request.directoryPath,
      backend: defaults.backend,
      executionMode: defaults.executionMode,
      model: defaults.model,
      reasoningEffort: defaults.reasoningEffort,
      serviceTier: defaults.serviceTier,
      fastMode: defaults.fastMode,
      acpRuntime: defaults.acpRuntime,
      providerSettings: defaults.providerSettings,
      prompt: "",
      registeredAt: request.registeredAt,
      workMode: defaultLaunchpadWorkMode(request, defaults),
      branchName: request.currentBranch,
      parentThreadId: request.parentThreadId,
      parentThreadTitle: request.parentThreadTitle,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return {
      launchpad: withCodexEnvironmentOptions(
        await this.overlayStore.upsertDirectoryLaunchpad(launchpad),
        codexEnvironmentOptions,
      ),
      defaults,
    };
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    const current =
      (await this.overlayStore.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      })) ??
      (await this.ensureDirectoryLaunchpad({
        directoryKey: request.directoryKey,
        directoryKind: "directory",
        directoryLabel: request.directoryKey,
      })).launchpad;

    const patch = {
      ...request.patch,
      ...("fastMode" in request.patch ? { serviceTier: undefined } : {}),
    };
    const nextLaunchpad: NavigationLaunchpadDraft = {
      ...applyNavigationLaunchpadProviderSettingsPatch(current, patch),
      directoryKey: request.directoryKey,
      settingsTouchedAt: request.stickySettingsChanged
        ? Date.now()
        : current.settingsTouchedAt,
      updatedAt: Date.now(),
    };
    const persisted = await this.overlayStore.upsertDirectoryLaunchpad(nextLaunchpad);

    const stickyPatch: Partial<NavigationLaunchpadDefaults> = {};
    if (request.stickySettingsChanged && request.patch.backend) {
      stickyPatch.backend = request.patch.backend;
    }
    if (request.stickySettingsChanged && patch.executionMode) {
      stickyPatch.executionMode = patch.executionMode;
    }
    if (request.stickySettingsChanged && "model" in patch) {
      stickyPatch.model = patch.model;
    }
    if (request.stickySettingsChanged && "reasoningEffort" in patch) {
      stickyPatch.reasoningEffort = patch.reasoningEffort;
    }
    if (request.stickySettingsChanged && "serviceTier" in patch) {
      stickyPatch.serviceTier = patch.serviceTier;
    }
    if (request.stickySettingsChanged && "fastMode" in patch) {
      stickyPatch.fastMode = patch.fastMode;
      stickyPatch.serviceTier = undefined;
    }
    if (request.stickySettingsChanged && "acpRuntime" in patch) {
      stickyPatch.acpRuntime = patch.acpRuntime;
    }
    if (request.stickySettingsChanged && request.patch.workMode) {
      stickyPatch.workMode = request.patch.workMode;
    }

    const defaults =
      Object.keys(stickyPatch).length > 0
        ? await this.overlayStore.setLaunchpadDefaults(stickyPatch)
        : await this.overlayStore.getLaunchpadDefaults();

    return {
      launchpad: withCodexEnvironmentOptions(
        persisted,
        await listCodexEnvironmentOptions(persisted.directoryPath),
      ),
      defaults,
    };
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
  ): Promise<ResetDirectoryLaunchpadResponse> {
    await this.overlayStore.resetDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    return {
      directoryKey: request.directoryKey,
      defaults: await this.overlayStore.getLaunchpadDefaults(),
    };
  }

  async runCodexEnvironmentAction(
    request: RunCodexEnvironmentActionRequest,
  ): Promise<RunCodexEnvironmentActionResponse> {
    // Serialise the read-modify-write under the per-thread lock so two
    // concurrent Run-button clicks can't clobber each other's appended
    // run entry.
    return this.withCodexEnvironmentRuntimeLock(
      request.backend,
      request.threadId,
      async () => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: request.backend,
          threadId: request.threadId,
        });
        const runtime = overlay?.codexEnvironmentRuntime;
        if (!runtime) {
          throw new Error("This thread does not have a selected environment.");
        }

        const currentCwd =
          request.cwd?.trim() ||
          (await this.resolveThreadEnvironmentCwd(
            request.backend,
            request.threadId,
            overlay,
          ));
        const refreshedRuntimeForAction = await this.refreshCodexEnvironmentRuntimeActions(
          currentCwd?.trim() ? { ...runtime, cwd: currentCwd.trim() } : runtime,
          request.actionId,
        );
        const runtimeForAction: CodexThreadEnvironmentRuntime = {
          ...refreshedRuntimeForAction,
          selectedActionIdByEnvironmentId: {
            ...(refreshedRuntimeForAction.selectedActionIdByEnvironmentId ?? {}),
            [refreshedRuntimeForAction.environmentId]: request.actionId,
          },
        };
        const runId = randomUUID();
        let nextRuntime: CodexThreadEnvironmentRuntime;
        try {
          nextRuntime = await startLocalCodexEnvironmentAction({
            actionId: request.actionId,
            runId,
            commandRunner: this.codexEnvironmentCommandRunner,
            env: this.codexEnvironmentCommandEnv,
            runtime: runtimeForAction,
            onDetachedExit: (event) => {
              void this.handleCodexEnvironmentActionDetachedExit({
                backend: request.backend,
                threadId: request.threadId,
                runId,
                event,
              });
            },
            onDetachedOutput: (event) => {
              void this.handleCodexEnvironmentActionDetachedOutput({
                backend: request.backend,
                threadId: request.threadId,
                runId,
                event,
              });
            },
          });
        } catch (error) {
          if (
            error instanceof CodexEnvironmentStartupError &&
            error.phase === "action"
          ) {
            await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
              backend: request.backend,
              threadId: request.threadId,
              codexEnvironmentRuntime: error.runtime,
            });
            this.invalidateThreadListCache(request.backend);
            await this.emitCodexEnvironmentRuntimeUpdated({
              backend: request.backend,
              threadId: request.threadId,
              codexEnvironmentRuntime: error.runtime,
            });
          }
          throw error;
        }
        await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });
        this.invalidateThreadListCache(request.backend);
        await this.emitCodexEnvironmentRuntimeUpdated({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });

        return {
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        };
      },
    );
  }

  async stopCodexEnvironmentAction(
    request: StopCodexEnvironmentActionRequest,
  ): Promise<StopCodexEnvironmentActionResponse> {
    return this.withCodexEnvironmentRuntimeLock(
      request.backend,
      request.threadId,
      async () => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: request.backend,
          threadId: request.threadId,
        });
        const runtime = overlay?.codexEnvironmentRuntime;
        if (!runtime) {
          throw new Error("This thread does not have a selected environment.");
        }

        const currentRuns = readCodexEnvironmentActionRuns(runtime);
        const matchingRun = currentRuns.find((run) => run.runId === request.runId);
        if (!matchingRun) {
          throw new Error("This environment action run is no longer available.");
        }
        if (matchingRun.status !== "started") {
          return {
            backend: request.backend,
            threadId: request.threadId,
            codexEnvironmentRuntime: runtime,
          };
        }

        const nextRuns = applyCodexEnvironmentActionRunUpdate(currentRuns, {
          kind: "patch",
          runId: request.runId,
          patch: {
            terminationMode: request.mode,
            terminationRequestedAt:
              matchingRun.terminationRequestedAt ?? Date.now(),
          },
        });
        const nextRuntime: CodexThreadEnvironmentRuntime = {
          ...runtime,
          actionRuns: nextRuns,
        };
        await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });
        this.invalidateThreadListCache(request.backend);
        await this.emitCodexEnvironmentRuntimeUpdated({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });

        const result = stopCodexEnvironmentDetachedCommand(
          request.runId,
          request.mode,
        );
        if (!result.found) {
          backendRegistryLog.warn("codex-environment-action-stop-missing-process", {
            backend: request.backend,
            threadId: request.threadId,
            runId: request.runId,
            mode: request.mode,
          });
        }

        return {
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        };
      },
    );
  }

  private async refreshCodexEnvironmentRuntimeActions(
    runtime: CodexThreadEnvironmentRuntime,
    _actionId: string,
  ): Promise<CodexThreadEnvironmentRuntime> {
    // Always reload action data from disk before running. The cached
    // runtime.actions was populated when the env was first selected
    // (materializeDirectoryLaunchpad or setCodexThreadEnvironment);
    // env.toml edits made afterwards — adding `nvm use --silent`,
    // `corepack enable`, or otherwise expanding a single-line command
    // into a multi-line script — wouldn't propagate to subsequent
    // runs without this reload. Disk read + TOML parse is fast (single
    // file per environment); correctness wins over a micro-cache.
    const cwd = runtime.cwd?.trim();
    if (!cwd) {
      return runtime;
    }

    const environment = (await listCodexEnvironmentOptions(cwd).catch(() => []))
      .find((candidate) => candidate.id === runtime.environmentId);
    if (!environment) {
      return runtime;
    }

    return {
      ...runtime,
      actions: environment.actions,
      setupCommand: environment.setupScript,
      sourcePath: environment.sourcePath,
    };
  }

  async setCodexThreadEnvironment(
    request: SetCodexThreadEnvironmentRequest,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    if (!request.environmentId) {
      await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime: undefined,
      });
      this.invalidateThreadListCache(request.backend);
      await this.emitCodexEnvironmentRuntimeUpdated({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime: undefined,
      });
      return {
        backend: request.backend,
        threadId: request.threadId,
      };
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: request.backend,
      threadId: request.threadId,
    });
    const cwd = await this.resolveThreadEnvironmentCwd(
      request.backend,
      request.threadId,
      overlay,
    );
    const options = await listCodexEnvironmentOptions(cwd);
    const environment = options.find(
      (candidate) => candidate.id === request.environmentId,
    );
    if (!environment) {
      throw new Error("Selected environment is not available for this thread.");
    }
    const selectedActionIdByEnvironmentId = pruneCodexEnvironmentActionMap(
      overlay?.codexEnvironmentRuntime?.selectedActionIdByEnvironmentId,
      options,
    );
    const selectedActionId = resolveCodexEnvironmentActionId({
      actionId: request.actionId,
      environment,
      selectedActionIdByEnvironmentId,
    });
    if (selectedActionId) {
      selectedActionIdByEnvironmentId[environment.id] = selectedActionId;
    } else {
      delete selectedActionIdByEnvironmentId[environment.id];
    }

    const existingRuntime =
      overlay?.codexEnvironmentRuntime?.environmentId === environment.id
        ? overlay.codexEnvironmentRuntime
        : undefined;
    const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime = {
      ...(existingRuntime ?? {}),
      environmentId: environment.id,
      environmentName: environment.name,
      executionTarget: existingRuntime?.executionTarget ?? "local",
      cwd,
      setupEnabled: existingRuntime?.setupEnabled ?? false,
      setupCommand: environment.setupScript,
      actions: environment.actions,
      selectedActionIdByEnvironmentId:
        Object.keys(selectedActionIdByEnvironmentId).length > 0
          ? selectedActionIdByEnvironmentId
          : undefined,
      sourcePath: environment.sourcePath,
    };
    await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
      backend: request.backend,
      threadId: request.threadId,
      codexEnvironmentRuntime,
    });
    this.invalidateThreadListCache(request.backend);
    await this.emitCodexEnvironmentRuntimeUpdated({
      backend: request.backend,
      threadId: request.threadId,
      codexEnvironmentRuntime,
    });

    return {
      backend: request.backend,
      threadId: request.threadId,
      codexEnvironmentRuntime,
    };
  }

  private async emitCodexEnvironmentRuntimeUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
  }): Promise<void> {
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/codexEnvironment/updated",
        params: {
          threadId: params.threadId,
          codexEnvironmentRuntime: params.codexEnvironmentRuntime,
        },
      },
    });
  }

  /**
   * Serialise codexEnvironmentRuntime read-modify-write operations
   * per-thread via {@link PerKeyAsyncLock}. Two concurrent run-button
   * clicks, or two detached-child exit callbacks firing at once, would
   * otherwise both read the same overlay state, each patch their own
   * run, and the second writer would silently overwrite the first.
   */
  private withCodexEnvironmentRuntimeLock<T>(
    backend: AppServerBackendKind,
    threadId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.codexEnvironmentRuntimeLocks.run(
      `${backend}:${threadId}`,
      task,
    );
  }

  /**
   * Called when a detached env-action child (e.g., `pnpm dev` for the
   * PwrSnap run button) eventually exits. Patches the matching entry in
   * `codexEnvironmentRuntime.actionRuns` so the renderer's anchored
   * env-action output UI shows exit code + output for that specific run,
   * and emits `thread/codexEnvironment/updated` so the UI refreshes.
   *
   * Patches by `runId` rather than `actionId` so a second concurrent run
   * of the same action (e.g. user runs Test, it's still running, user
   * runs Test again) doesn't have its output collide with the first.
   */
  private async handleCodexEnvironmentActionDetachedExit(params: {
    backend: AppServerBackendKind;
    threadId: string;
    runId: string;
    event: CodexEnvironmentDetachedExit;
  }): Promise<void> {
    await this.withCodexEnvironmentRuntimeLock(
      params.backend,
      params.threadId,
      async () => {
        try {
          const overlay = await this.overlayStore.getThreadOverlayState({
            backend: params.backend,
            threadId: params.threadId,
          });
          const current = overlay?.codexEnvironmentRuntime;
          if (!current) {
            return;
          }
          const currentRuns = readCodexEnvironmentActionRuns(current);
          if (!currentRuns.some((run) => run.runId === params.runId)) {
            // The matching run has been evicted (cap exceeded) or this is
            // a stale callback from a previous environment selection.
            // Nothing to patch.
            return;
          }
          const exitedSuccessfully =
            params.event.exitCode === 0 && !params.event.exitSignal;
          const nextRuns = applyCodexEnvironmentActionRunUpdate(currentRuns, {
            kind: "patch",
            runId: params.runId,
            patch: {
              status: exitedSuccessfully ? "exited" : "failed",
              exitCode:
                params.event.exitCode === null
                  ? undefined
                  : params.event.exitCode,
              exitSignal: params.event.exitSignal ?? undefined,
              durationMs: params.event.durationMs,
              exitedAt: Date.now(),
              output: params.event.output,
            },
          });
          const next: CodexThreadEnvironmentRuntime = {
            ...current,
            actionRuns: nextRuns,
          };
          await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
            backend: params.backend,
            threadId: params.threadId,
            codexEnvironmentRuntime: next,
          });
          this.invalidateThreadListCache(params.backend);
          await this.emitCodexEnvironmentRuntimeUpdated({
            backend: params.backend,
            threadId: params.threadId,
            codexEnvironmentRuntime: next,
          });
        } catch (error) {
          backendRegistryLog.warn(
            "codex-environment-action-exit-overlay-update-failed",
            {
              backend: params.backend,
              threadId: params.threadId,
              runId: params.runId,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
      },
    );
  }

  /**
   * Called periodically (throttled to ~500ms) while a detached env-action
   * child is running, with a snapshot of its accumulated stdout+stderr.
   * Patches the matching run's `output` on the overlay so the renderer's
   * anchored UI shows live output. Does not change `status` — that stays
   * "started" until the child closes.
   */
  private async handleCodexEnvironmentActionDetachedOutput(params: {
    backend: AppServerBackendKind;
    threadId: string;
    runId: string;
    event: CodexEnvironmentDetachedOutput;
  }): Promise<void> {
    await this.withCodexEnvironmentRuntimeLock(
      params.backend,
      params.threadId,
      async () => {
        try {
          const overlay = await this.overlayStore.getThreadOverlayState({
            backend: params.backend,
            threadId: params.threadId,
          });
          const current = overlay?.codexEnvironmentRuntime;
          if (!current) {
            return;
          }
          const currentRuns = readCodexEnvironmentActionRuns(current);
          const matching = currentRuns.find((run) => run.runId === params.runId);
          if (!matching) {
            return;
          }
          // Skip the write+emit if the snapshot hasn't actually changed —
          // keeps a quiet child from generating empty IPC noise.
          if (matching.output === params.event.output) {
            return;
          }
          // A null/null close can come from a wrapper path while the useful
          // descendant is still producing output. Fresh output proves the run
          // is not terminal, so keep the UI in a controllable running state.
          const ambiguousTerminalFailure =
            matching.status === "failed" &&
            matching.exitCode === undefined &&
            matching.exitSignal === undefined;
          const patch: Partial<CodexEnvironmentActionRun> = {
            output: params.event.output,
          };
          if (ambiguousTerminalFailure) {
            patch.status = "started";
            patch.durationMs = undefined;
            patch.exitedAt = undefined;
          }
          const nextRuns = applyCodexEnvironmentActionRunUpdate(currentRuns, {
            kind: "patch",
            runId: params.runId,
            patch,
          });
          const next: CodexThreadEnvironmentRuntime = {
            ...current,
            actionRuns: nextRuns,
          };
          await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
            backend: params.backend,
            threadId: params.threadId,
            codexEnvironmentRuntime: next,
          });
          this.invalidateThreadListCache(params.backend);
          await this.emitCodexEnvironmentRuntimeUpdated({
            backend: params.backend,
            threadId: params.threadId,
            codexEnvironmentRuntime: next,
          });
        } catch (error) {
          backendRegistryLog.warn(
            "codex-environment-action-output-overlay-update-failed",
            {
              backend: params.backend,
              threadId: params.threadId,
              runId: params.runId,
              message: error instanceof Error ? error.message : String(error),
            },
          );
        }
      },
    );
  }

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const launchpad =
      request.launchpad ??
      (await this.overlayStore.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      }));
    if (!launchpad) {
      throw new Error(`No launchpad found for ${request.directoryKey}`);
    }

    const preparedWorkspace =
      await this.gitDirectoryService.prepareLaunchpadWorkspace(launchpad);
    const workspace =
      launchpad.directoryKind === "workspace" && !preparedWorkspace.cwd
        ? {
            ...preparedWorkspace,
            cwd: await this.createScratchProjectDirectory(),
          }
        : preparedWorkspace;
    const linkedDirectories =
      workspace.workMode === "worktree"
        ? buildWorktreeLinkedDirectory({
            label: launchpad.directoryLabel,
            repositoryPath: workspace.repositoryPath ?? launchpad.directoryPath,
            worktreePath: workspace.cwd,
          })
        : undefined;
    const codexEnvironmentOptions = await listCodexEnvironmentOptions(
      launchpad.directoryPath,
    );
    const codexEnvironmentSelection = resolveCodexEnvironmentSelection(
      launchpad,
      codexEnvironmentOptions,
    );
    let codexEnvironmentRuntime: CodexThreadEnvironmentRuntime | undefined;
    let codexEnvironmentStartupFailure:
      | MaterializeDirectoryLaunchpadResponse["codexEnvironmentStartupFailure"]
      | undefined;
    // The detached env-action child can exit asynchronously after we've
    // already returned to the caller. Queue any early exits until the
    // thread is started so we can attribute them to the right thread.
    // Pre-generate the runId for the auto-action so the same id flows
    // from the runtime helper into the renderer's actionRuns entry and
    // into the post-startThread output/exit handlers.
    const autoActionRunId = randomUUID();
    let pendingActionThreadId: string | undefined;
    const queuedActionDetachedExits: CodexEnvironmentDetachedExit[] = [];
    const queuedActionDetachedOutputs: CodexEnvironmentDetachedOutput[] = [];
    const codexActionBackend: AppServerBackendKind = launchpad.backend;
    const onActionDetachedExit = (event: CodexEnvironmentDetachedExit) => {
      if (pendingActionThreadId && codexEnvironmentSelection?.action?.id) {
        void this.handleCodexEnvironmentActionDetachedExit({
          backend: codexActionBackend,
          threadId: pendingActionThreadId,
          runId: autoActionRunId,
          event,
        });
        return;
      }
      queuedActionDetachedExits.push(event);
    };
    const onActionDetachedOutput = (event: CodexEnvironmentDetachedOutput) => {
      if (pendingActionThreadId && codexEnvironmentSelection?.action?.id) {
        void this.handleCodexEnvironmentActionDetachedOutput({
          backend: codexActionBackend,
          threadId: pendingActionThreadId,
          runId: autoActionRunId,
          event,
        });
        return;
      }
      // Output snapshots before startThread completes are rare (auto-action
      // commands usually print after a moment) but worth queueing so the
      // first post-start render of the anchor has something to show.
      // Only keep the latest — older snapshots are strict subsets of newer.
      queuedActionDetachedOutputs.length = 0;
      queuedActionDetachedOutputs.push(event);
    };
    try {
      codexEnvironmentRuntime = await applyLocalCodexEnvironmentSelection({
        commandRunner: this.codexEnvironmentCommandRunner,
        cwd: workspace.cwd,
        env: this.codexEnvironmentCommandEnv,
        onSetupProgress: options?.onCodexEnvironmentSetupProgress
          ? (event) => {
              options.onCodexEnvironmentSetupProgress?.({
                directoryKey: launchpad.directoryKey,
                ...event,
              });
            }
          : undefined,
        onActionDetachedExit,
        onActionDetachedOutput,
        actionRunId: autoActionRunId,
        hydrationStore: this.codexEnvironmentHydrationStore,
        selection: codexEnvironmentSelection,
      });
    } catch (error) {
      if (!(error instanceof CodexEnvironmentStartupError)) {
        throw error;
      }
      codexEnvironmentRuntime = error.runtime;
      codexEnvironmentStartupFailure = {
        message: error.message,
        phase: error.phase,
        worktreeCleanupAvailable: workspace.workMode === "worktree",
      };
    }
    const startThreadResponse = await this.startThread({
      backend: launchpad.backend,
      executionMode: launchpad.executionMode,
      agent: request.agent,
      cwd: workspace.cwd,
      linkedDirectories,
      model: launchpad.model,
      reasoningEffort: launchpad.reasoningEffort,
      serviceTier: launchpad.serviceTier,
      fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
      acpRuntime: launchpad.acpRuntime,
      codexEnvironmentRuntime,
    });
    pendingActionThreadId = startThreadResponse.threadId;
    if (request.parentThreadId?.trim()) {
      await this.overlayStore.setThreadParent?.({
        backend: startThreadResponse.backend,
        threadId: startThreadResponse.threadId,
        parentThreadId: request.parentThreadId,
      });
      await this.emit({
        backend: startThreadResponse.backend,
        notification: {
          method: "thread/parent/set",
          params: {
            threadId: startThreadResponse.threadId,
            parentThreadId: request.parentThreadId,
          },
        },
      });
    }
    if (codexEnvironmentSelection?.action?.id) {
      for (const event of queuedActionDetachedOutputs) {
        void this.handleCodexEnvironmentActionDetachedOutput({
          backend: codexActionBackend,
          threadId: startThreadResponse.threadId,
          runId: autoActionRunId,
          event,
        });
      }
      queuedActionDetachedOutputs.length = 0;
      for (const event of queuedActionDetachedExits) {
        void this.handleCodexEnvironmentActionDetachedExit({
          backend: codexActionBackend,
          threadId: startThreadResponse.threadId,
          runId: autoActionRunId,
          event,
        });
      }
      queuedActionDetachedExits.length = 0;
    }
    if (workspace.workMode === "worktree") {
      await this.recordCodexWorktreeOwnerThread({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        worktreePath: workspace.cwd,
      });
    }
    const materializedThread = {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      executionMode: startThreadResponse.executionMode,
      ...(linkedDirectories?.[0] ? { linkedDirectory: linkedDirectories[0] } : {}),
      workMode: workspace.workMode,
      codexEnvironmentRuntime,
      codexEnvironmentStartupFailure,
    } satisfies MaterializedDirectoryLaunchpadThread;
    await options?.onThreadMaterialized?.(materializedThread);

    const input =
      request.input ??
      (launchpad.prompt.trim()
        ? [{ type: "text", text: launchpad.prompt } as const]
        : []);
    let turnId: string | undefined;
    let turnStartFailure:
      | MaterializeDirectoryLaunchpadResponse["turnStartFailure"]
      | undefined;
    if (codexEnvironmentStartupFailure) {
      turnId = undefined;
    } else if (request.reviewTarget) {
      try {
        const reviewResponse = await this.startReview({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          target: request.reviewTarget,
          delivery: "inline",
          model: launchpad.model,
          reasoningEffort: launchpad.reasoningEffort,
          serviceTier: launchpad.serviceTier,
          fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
        });
        turnId = reviewResponse.turnId;
      } catch (error) {
        turnStartFailure = {
          message: error instanceof Error ? error.message : String(error),
          phase: "review",
        };
      }
    } else if (input.length > 0) {
      try {
        const turnResponse = await this.startTurn({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          input,
          model: launchpad.model,
          reasoningEffort: launchpad.reasoningEffort,
          serviceTier: launchpad.serviceTier,
          fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
          collaborationMode: request.collaborationMode,
        });
        turnId = turnResponse.turnId;
      } catch (error) {
        turnStartFailure = {
          message: error instanceof Error ? error.message : String(error),
          phase: "turn",
        };
      }
    }

    await resetLaunchpadAfterMaterialize({
      defaults: await this.resolveLaunchpadDefaults(
        await this.overlayStore.getLaunchpadDefaults(),
        launchpad.backend,
      ),
      launchpad,
      overlayStore: this.overlayStore,
    });

    return {
      ...materializedThread,
      turnId,
      turnStartFailure,
    };
  }

  async close(): Promise<void> {
    if (this.taskMonitorWatchdogTimer) {
      clearInterval(this.taskMonitorWatchdogTimer);
    }
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }

    for (const [key, pending] of this.pendingServerRequests) {
      pending.reject(new Error(`Desktop backend registry closed before ${key} resolved`));
      this.pendingServerRequests.delete(key);
    }

    await this.acpBackend.close();
    await this.codexClient.close();
    await this.grokClient.close();
    await Promise.all(this.captureStores.splice(0).map(async (store) => await store.close()));
  }

  private async resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
    callerReason: BackendModelCatalogCallerReason = "thread-start-defaults",
  ): Promise<ModelSettings> {
    return resolveModelSettingsFromOptions(
      backend,
      await this.getBackendLaunchpadOptions(backend, callerReason),
      settings,
    );
  }

  private async resolveReviewModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
  ): Promise<ModelSettings> {
    if (isAcpBackendId(backend)) {
      return await this.resolveModelSettings(backend, settings, "review-start");
    }

    const models =
      backend === "codex"
        ? await this.readCodexDefaultModelsOnce("review-start")
        : await this.readGrokDefaultModelsOnce("review-start");
    const launchpadOptions = buildLaunchpadOptions(backend, models, {
      allowFallbackModels: false,
    });
    const availableModels = launchpadOptions?.models ?? [];
    if (
      settings.model !== undefined &&
      !availableModels.some((model) => model.id === settings.model)
    ) {
      const available = availableModels.map((model) => model.id).join(", ");
      throw new Error(
        available
          ? `Selected review model is not available for ${backend}: ${settings.model}. Available models: ${available}`
          : `Selected review model is not available for ${backend}: ${settings.model}. Model discovery returned no available models.`,
      );
    }

    return resolveModelSettingsFromOptions(backend, launchpadOptions, settings);
  }

  private async resolveLaunchpadBackend(
    preferred: AppServerBackendKind,
  ): Promise<BackendSummary> {
    const { backends } = await this.listBackends({ includeUnavailable: true });
    const availableBackends = backends.filter(
      (backend) => backend.available && backend.capabilities.createThread,
    );

    return (
      availableBackends.find((backend) => backend.kind === preferred) ??
      availableBackends.find((backend) => backend.kind === "codex") ??
      availableBackends[0] ??
      backends.find((backend) => backend.kind === preferred) ??
      backends.find((backend) => backend.kind === "codex") ??
      backends[0]!
    );
  }

  private async resolveLaunchpadModelSettings(
    backend: BackendSummary,
    settings: ModelSettings,
  ): Promise<ModelSettings> {
    const launchpadOptions =
      backend.launchpadOptions ??
      (await this.getBackendLaunchpadOptions(backend.kind, "launchpad-defaults"));

    return resolveModelSettingsFromOptions(
      backend.kind,
      launchpadOptions,
      settings,
    );
  }

  private async resolveLaunchpadDefaults(
    storedDefaults: NavigationLaunchpadDefaults,
    preferredBackend?: AppServerBackendKind,
  ): Promise<NavigationLaunchpadDefaults> {
    const projectedDefaults =
      projectNavigationLaunchpadProviderSettings(storedDefaults);
    const backend = await this.resolveLaunchpadBackend(
      preferredBackend ?? projectedDefaults.backend,
    );
    const backendDefaults =
      backend.kind === projectedDefaults.backend
        ? projectedDefaults
        : projectNavigationLaunchpadProviderSettings({
            ...projectedDefaults,
            backend: backend.kind,
            executionMode: "default",
            model: undefined,
            reasoningEffort: undefined,
            serviceTier: undefined,
            fastMode: undefined,
            acpRuntime: undefined,
          });
    const modelSettings = await this.resolveLaunchpadModelSettings(
      backend,
      backendDefaults,
    );
    const resolvedDefaults: NavigationLaunchpadDefaults = {
      ...backendDefaults,
      backend: backend.kind,
      executionMode: getAvailableExecutionMode(
        backend,
        backendDefaults.executionMode,
      ),
      ...modelSettings,
    };
    if (
      resolvedDefaults.backend === "codex" &&
      (resolvedDefaults.serviceTier === "fast" ||
        resolvedDefaults.serviceTier === "priority")
    ) {
      delete resolvedDefaults.serviceTier;
    }

    if (launchpadDefaultsEqual(projectedDefaults, resolvedDefaults)) {
      return projectedDefaults;
    }

    return await this.overlayStore.setLaunchpadDefaults(resolvedDefaults);
  }

  private readCodexDefaultModelsOnce(
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendModelOption[]> {
    return this.modelCatalog.readModels("codex", callerReason);
  }

  private readGrokDefaultModelsOnce(
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendModelOption[]> {
    return this.modelCatalog.readModels("grok", callerReason);
  }

  private async getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendLaunchpadOptions | undefined> {
    if (isAcpBackendId(backend)) {
      return this.acpBackend.getLaunchpadOptions(backend);
    }

    if (backend === "codex") {
      const models = await this.readCodexDefaultModelsOnce(callerReason).catch(() => []);
      return buildLaunchpadOptions(backend, models);
    }

    const models = await this.readGrokDefaultModelsOnce(callerReason).catch(() => []);
    return buildLaunchpadOptions(backend, models);
  }

  private subscribeClient(backend: AppServerBackendKind, client: BackendClient): void {
    this.unsubscribers.push(
      client.onNotification(async (notification) => {
        logBackendLifecycleNotification(backend, notification);
        if (
          backend === "codex" &&
          notification.method === "thread/codexSettings/observed"
        ) {
          await this.recordObservedCodexSettings(notification);
        }
        if (this.shouldInvalidateThreadListCacheForNotification(notification.method)) {
          this.invalidateThreadListCache(backend);
        }
        if (notification.method === "thread/archived") {
          await this.cleanupMessagingForArchivedThread({
            backend,
            threadId: notification.params.threadId,
            origin: "thread-archive",
          });
        }
        if (notification.method === "thread/unarchived") {
          this.clearArchivedMessagingCleanupCache({
            backend,
            threadId: notification.params.threadId,
          });
        }
        await this.emitHeadlessAutomationLifecycle(backend, notification);
        await this.emit({ backend, notification });
      }),
    );

    if (client.onRequest) {
      this.unsubscribers.push(
        client.onRequest(async (request) => await this.handleServerRequest(backend, request)),
      );
    }
  }

  private async recordObservedCodexSettings(
    notification: AppServerNotification,
  ): Promise<void> {
    if (notification.method !== "thread/codexSettings/observed") {
      return;
    }
    const params = notification.params as {
      fastMode?: unknown;
      model?: unknown;
      rawServiceTier?: unknown;
      reasoningEffort?: unknown;
      serviceTier?: unknown;
      threadId?: unknown;
    };
    if (typeof params.threadId !== "string") {
      return;
    }
    const observed = {
      ...(typeof params.fastMode === "boolean" ? { fastMode: params.fastMode } : {}),
      ...(typeof params.serviceTier === "string" || params.serviceTier === null
        ? { serviceTier: params.serviceTier }
        : {}),
      ...(typeof params.rawServiceTier === "string" || params.rawServiceTier === null
        ? { rawServiceTier: params.rawServiceTier }
        : {}),
      observedAt: Date.now(),
    };
    this.observedCodexSettingsByThread.set(params.threadId, observed);
    const observedModel = typeof params.model === "string" ? params.model : undefined;
    const observedReasoningEffort =
      typeof params.reasoningEffort === "string" ? params.reasoningEffort : undefined;
    if (observedModel || observedReasoningEffort) {
      const current = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: params.threadId,
      });
      const modelSettings = {
        model: observedModel ?? current?.model,
        reasoningEffort: observedReasoningEffort ?? current?.reasoningEffort,
        serviceTier: current?.serviceTier,
        fastMode: current?.fastMode,
      };
      await this.overlayStore.setThreadModelSettings({
        backend: "codex",
        threadId: params.threadId,
        ...modelSettings,
      });
      this.invalidateThreadListCache("codex");
      await this.emit({
        backend: "codex",
        notification: {
          method: "thread/modelSettings/updated",
          params: {
            threadId: params.threadId,
            ...modelSettings,
          },
        },
      });
    }
    backendRegistryLog.info("codex thread settings observed", {
      threadId: params.threadId,
      model: observedModel ?? null,
      fastMode: observed.fastMode ?? null,
      reasoningEffort: observedReasoningEffort ?? null,
      serviceTier: observed.serviceTier ?? null,
      rawServiceTier: observed.rawServiceTier ?? null,
    });
  }

  private async emitHeadlessAutomationLifecycle(
    backend: AppServerBackendKind,
    notification: AppServerNotification,
  ): Promise<void> {
    if (
      notification.method !== "turn/completed" &&
      notification.method !== "turn/failed" &&
      notification.method !== "turn/cancelled"
    ) {
      return;
    }

    const turnId = turnIdFromTerminalNotification(notification);
    if (!turnId) {
      return;
    }
    const run = this.headlessAutomationTurns.get(
      buildHeadlessAutomationTurnKey(
        backend,
        notification.params.threadId,
        turnId,
      ),
    );
    if (!run) {
      backendRegistryLog.debug("terminal turn did not match a headless automation", {
        backend,
        method: notification.method,
        threadId: notification.params.threadId,
        turnId,
      });
      return;
    }
    this.headlessAutomationTurns.delete(
      buildHeadlessAutomationTurnKey(
        backend,
        notification.params.threadId,
        turnId,
      ),
    );
    backendRegistryLog.info("automation headless turn reached terminal status", {
      agentThreadId: run.agentThreadId,
      automationName: run.automationName,
      automationRunId: run.automationRunId,
      backend,
      finalTextLength: finalTextFromTerminalNotification(notification)?.length ?? 0,
      method: notification.method,
      queueEntryId: run.queueEntryId,
      threadId: notification.params.threadId,
      turnId,
    });

    await this.emit({
      backend,
      notification: {
        method: "thread/turnQueue/updated",
        params: {
          threadId: run.agentThreadId,
          queueEntryId: run.queueEntryId,
          origin: "automation",
          automationRunId: run.automationRunId,
          automationName: run.automationName,
          status: "terminal",
          turnId,
          errorMessage: errorMessageFromTerminalNotification(notification),
          finalText: finalTextFromTerminalNotification(notification),
          terminalStatus: notification.method,
        },
      },
    });
  }

  private findHeadlessAutomationTurnForRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ):
    | {
        agentThreadId: string;
        automationName?: string;
        automationRunId: string;
        executionMode: ThreadExecutionMode;
        queueEntryId: string;
      }
    | undefined {
    const turnId = request.params.turnId?.trim();
    if (turnId) {
      return this.headlessAutomationTurns.get(
        buildHeadlessAutomationTurnKey(backend, request.params.threadId, turnId),
      );
    }

    const keyPrefix = `${backend}:${request.params.threadId}:`;
    let match:
      | {
          agentThreadId: string;
          automationName?: string;
          automationRunId: string;
          executionMode: ThreadExecutionMode;
          queueEntryId: string;
        }
      | undefined;
    for (const [key, run] of this.headlessAutomationTurns.entries()) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      if (match) {
        return undefined;
      }
      match = run;
    }
    return match;
  }

  private getClient(
    backend: AppServerBackendKind,
    // executionMode is retained for documentation symmetry with callers
    // that pass per-turn approvalPolicy/sandboxPolicy overrides; it no
    // longer routes since the dual-client architecture collapsed to one.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executionMode: ThreadExecutionMode = "default",
  ): BackendClient {
    if (backend === "grok") {
      return this.grokClient;
    }
    if (isAcpBackendId(backend)) {
      throw new Error(`ACP backend ${backend} is not available through the built-in client router`);
    }

    return this.codexClient;
  }

  private buildThreadListCacheKey(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
    forceRefresh?: boolean;
  }): string {
    const codexDirectoryBackfill =
      params.backend === "grok" ||
      params.archived ||
      params.enrichDirectories !== false
        ? undefined
        : shouldBackfillCodexDirectoryRelationships(params.callerReason);

    return JSON.stringify({
      archived: params.archived === true,
      backend: params.backend ?? "all",
      codexDirectoryBackfill,
      enrichDirectories:
        params.backend === "grok" ? undefined : params.enrichDirectories === true,
      filter: params.filter?.trim() ?? "",
    });
  }

  private findReusableThreadListCache(
    params: {
      archived?: boolean;
      backend?: AppServerBackendKind;
      callerReason?: ThreadListCallerReason;
      enrichDirectories?: boolean;
      filter?: string;
      forceRefresh?: boolean;
    },
    cacheKey: string,
    now: number,
  ): ThreadListCacheHit | undefined {
    if (params.forceRefresh === true) {
      return this.readPendingThreadListCache(cacheKey, "exact");
    }

    const exact = this.readFreshThreadListCache(cacheKey, now, "exact");
    if (exact) {
      return exact;
    }

    if (
      params.backend !== "codex" ||
      params.archived === true ||
      params.enrichDirectories !== false ||
      shouldBackfillCodexDirectoryRelationships(params.callerReason)
    ) {
      return undefined;
    }

    const backfillCapableKey = this.buildThreadListCacheKey({
      ...params,
      callerReason: "navigation-snapshot",
    });
    if (backfillCapableKey === cacheKey) {
      return undefined;
    }
    return this.readFreshThreadListCache(backfillCapableKey, now, "navigation-shared");
  }

  private readFreshThreadListCache(
    cacheKey: string,
    now: number,
    source: ThreadListCacheHit["source"],
  ): ThreadListCacheHit | undefined {
    const cached = this.threadListCache.get(cacheKey);
    if (cached?.threads && (cached.expiresAt ?? 0) > now) {
      return {
        cacheKey,
        expiresInMs: Math.max(0, (cached.expiresAt ?? 0) - now),
        pending: false,
        source,
        threadCount: cached.threads.length,
        value: cached.threads,
      };
    }
    if (cached?.promise) {
      return {
        cacheKey,
        pending: true,
        source,
        value: cached.promise,
      };
    }
    return undefined;
  }

  private readPendingThreadListCache(
    cacheKey: string,
    source: ThreadListCacheHit["source"],
  ): ThreadListCacheHit | undefined {
    const cached = this.threadListCache.get(cacheKey);
    if (!cached?.promise) {
      return undefined;
    }
    return {
      cacheKey,
      pending: true,
      source,
      value: cached.promise,
    };
  }

  private invalidateThreadListCache(backend?: AppServerBackendKind): void {
    if (!backend) {
      this.threadListCache.clear();
      return;
    }

    for (const key of this.threadListCache.keys()) {
      if (key.includes(`"backend":"${backend}"`) || key.includes('"backend":"all"')) {
        this.threadListCache.delete(key);
      }
    }
  }

  private findCachedCodexThread(threadId: string): AppServerThreadSummary | undefined {
    for (const state of this.threadListCache.values()) {
      const thread = state.threads?.find(
        (candidate) => candidate.source === "codex" && candidate.id === threadId,
      );
      if (thread) {
        return thread;
      }
    }
    return undefined;
  }

  private async readCheapCodexThreadForRepair(
    threadId: string,
  ): Promise<AppServerThreadSummary | undefined> {
    const cached = this.findCachedCodexThread(threadId);
    if (cached) {
      return cached;
    }

    const threads = await this.codexClient.listThreads(
      {
        archived: false,
        enrichDirectories: false,
        filter: threadId,
      },
      {
        callerReason: "selected-thread-directory-repair",
        ownerId: this.threadListCacheOwnerId,
      },
    );
    return threads.find((thread) => thread.id === threadId);
  }

  private async repairCodexThreadDirectoryRelationship(params: {
    reason: "selected-thread";
    threadId: string;
  }): Promise<void> {
    if (!this.codexClient.enrichThreadDirectories) {
      return;
    }

    try {
      const cheapThread = await this.readCheapCodexThreadForRepair(params.threadId);
      if (!cheapThread) {
        return;
      }

      const [enrichedThread] = await this.codexClient.enrichThreadDirectories([
        cheapThread,
      ]);
      if (!enrichedThread) {
        return;
      }

      const directory = buildCachedDirectoryRelationship(enrichedThread);
      if (!directory) {
        return;
      }

      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId: params.threadId,
      });
      if (!shouldRepairCachedDirectoryRelationship({ directory, overlay })) {
        return;
      }

      await this.overlayStore.replaceWorkspaceLinkedDirectory({
        backend: "codex",
        threadId: params.threadId,
        directory,
      });
      this.invalidateThreadListCache("codex");
      await this.emitCodexDirectoryRelationshipsUpdated({
        reason: params.reason,
        threadIds: [params.threadId],
      });
      this.recordCodexDirectoryRelationshipRepair(params.threadId);
    } catch (error) {
      backendRegistryLog.warn("Codex selected thread directory repair failed", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  private recordCodexDirectoryRelationshipRepair(threadId: string): void {
    this.repairedDirectoryThreadKeys.add(`codex:${threadId}`);
    if (
      this.repairedDirectoryThreadKeys.size < 3 ||
      this.fullDirectoryReconcileDispatched
    ) {
      return;
    }

    this.fullDirectoryReconcileDispatched = true;
    void this.reconcileAllCodexDirectoryRelationships().catch((error) => {
      backendRegistryLog.warn("Codex full directory relationship reconcile failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async reconcileAllCodexDirectoryRelationships(): Promise<void> {
    const threads = await this.codexClient.listThreads(
      {
        archived: false,
        enrichDirectories: false,
      },
      {
        callerReason: "directory-relationship-reconcile",
        ownerId: this.threadListCacheOwnerId,
      },
    );
    const overlaysByThreadId = await this.overlayStore.getThreadOverlayStates({
      backend: "codex",
      threadIds: threads.map((thread) => thread.id),
    });
    const updatedOverlaysByThreadId =
      await this.backfillMissingCodexDirectoryRelationships({
        diagnostics: {
          callerReason: "directory-relationship-reconcile",
          ownerId: this.threadListCacheOwnerId,
        },
        overlaysByThreadId,
        threads,
      });
    const threadIds = Object.keys(updatedOverlaysByThreadId);
    if (threadIds.length === 0) {
      return;
    }

    this.invalidateThreadListCache("codex");
    await this.emitCodexDirectoryRelationshipsUpdated({
      reason: "full-reconcile",
      threadIds,
    });
  }

  private async emitCodexDirectoryRelationshipsUpdated(params: {
    reason: "selected-thread" | "full-reconcile";
    threadIds: string[];
  }): Promise<void> {
    await this.emit({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params,
      },
    });
  }

  private shouldInvalidateThreadListCacheForNotification(method: string): boolean {
    return (
      method === "thread/archived" ||
      method === "thread/acpRuntime/updated" ||
      method === "thread/executionMode/queueCleared" ||
      method === "thread/executionMode/queued" ||
      method === "thread/executionMode/updated" ||
      method === "thread/name/updated" ||
      method === "thread/parent/cleared" ||
      method === "thread/parent/set" ||
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/subAgents/updated" ||
      method === "thread/subthreadOrder/updated" ||
      method === "thread/subthreadsCollapsed/updated" ||
      method === "thread/unarchived" ||
      method === "turn/cancelled" ||
      method === "turn/completed" ||
      method === "turn/failed"
    );
  }

  private scheduleThreadListArchiveStateCleanup(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    filter?: string;
    threads: AppServerThreadSummary[];
  }): void {
    void this.handleThreadListArchiveState(params).catch((error) => {
      backendRegistryLog.warn("thread list archive state cleanup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private async handleThreadListArchiveState(params: {
    archived?: boolean;
    backend: AppServerBackendKind;
    filter?: string;
    threads: AppServerThreadSummary[];
  }): Promise<void> {
    if (params.archived === true) {
      await Promise.all(
        params.threads.map((thread) =>
          this.cleanupMessagingForArchivedThread({
            backend: params.backend,
            threadId: thread.id,
            origin: "state-refresh",
          }),
        ),
      );
      return;
    }

    if (params.filter?.trim()) {
      return;
    }

    const nextActiveThreadIds = new Set(params.threads.map((thread) => thread.id));
    const previousActiveThreadIds = this.activeThreadIdsByBackend.get(params.backend);
    this.activeThreadIdsByBackend.set(params.backend, nextActiveThreadIds);
    await this.cleanupArchivedBindingsMissingFromActiveList({
      backend: params.backend,
      activeThreadIds: nextActiveThreadIds,
    });
    if (!previousActiveThreadIds) {
      return;
    }

    const missingThreadIds = [...previousActiveThreadIds].filter(
      (threadId) => !nextActiveThreadIds.has(threadId),
    );
    if (missingThreadIds.length === 0) {
      return;
    }

    try {
      const archivedThreads = await this.getClient(params.backend).listThreads({
        archived: true,
      }, {
        callerReason: "archive-transition-cleanup",
        ownerId: this.threadListCacheOwnerId,
      });
      const archivedThreadIds = new Set(archivedThreads.map((thread) => thread.id));
      await Promise.all(
        missingThreadIds
          .filter((threadId) => archivedThreadIds.has(threadId))
          .map((threadId) =>
            this.cleanupMessagingForArchivedThread({
              backend: params.backend,
              threadId,
              origin: "state-refresh",
            }),
          ),
      );
    } catch (error) {
      backendRegistryLog.warn("archived thread transition cleanup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadIds: missingThreadIds,
      });
    }
  }

  private async cleanupArchivedBindingsMissingFromActiveList(params: {
    activeThreadIds: Set<string>;
    backend: AppServerBackendKind;
  }): Promise<void> {
    const store = this.resolveMessagingArchiveCleanupStore();
    if (!store) return;

    let bindings;
    try {
      bindings = await store.findActiveBindingsForBackend({
        backend: params.backend,
      });
    } catch (error) {
      backendRegistryLog.warn("archived binding lookup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const missingBoundThreadIds = [
      ...new Set(
        bindings
          .map((binding) => binding.threadId)
          .filter((threadId) => !params.activeThreadIds.has(threadId)),
      ),
    ];
    if (missingBoundThreadIds.length === 0) return;

    try {
      const archivedThreads = await this.getClient(params.backend).listThreads({
        archived: true,
      }, {
        callerReason: "archive-bound-binding-cleanup",
        ownerId: this.threadListCacheOwnerId,
      });
      const archivedThreadIds = new Set(archivedThreads.map((thread) => thread.id));
      await Promise.all(
        missingBoundThreadIds
          .filter((threadId) => archivedThreadIds.has(threadId))
          .map((threadId) =>
            this.cleanupMessagingForArchivedThread({
              backend: params.backend,
              threadId,
              origin: "state-refresh",
            }),
          ),
      );
    } catch (error) {
      backendRegistryLog.warn("archived bound binding cleanup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadIds: missingBoundThreadIds,
      });
    }
  }

  private resolveMessagingArchiveCleanupStore(): MessagingArchiveCleanupStore | undefined {
    if (this.messagingStore === null) {
      return undefined;
    }
    if (this.messagingStore) {
      return this.messagingStore;
    }

    try {
      return getDesktopMessagingStore();
    } catch (error) {
      backendRegistryLog.debug("messaging store unavailable for archive cleanup", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async cleanupMessagingForArchivedThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "state-refresh" | "thread-archive";
  }): Promise<MessagingArchiveCleanupResult> {
    const key = this.archivedMessagingCleanupKey(params);
    const existing = this.archivedMessagingCleanupInFlight.get(key);
    if (existing) {
      return await existing;
    }
    if (this.archivedMessagingCleanupCompleted.has(key)) {
      return { pendingIntentCount: 0, revokedCount: 0 };
    }

    const generation = this.archivedMessagingCleanupGeneration.get(key) ?? 0;
    const cleanup = this.runMessagingCleanupForArchivedThread(params)
      .then((result) => {
        if (
          (this.archivedMessagingCleanupGeneration.get(key) ?? 0) === generation &&
          (result.pendingIntentCount > 0 || result.revokedCount > 0)
        ) {
          this.archivedMessagingCleanupCompleted.add(key);
        }
        return result;
      })
      .finally(() => {
        this.archivedMessagingCleanupInFlight.delete(key);
      });
    this.archivedMessagingCleanupInFlight.set(key, cleanup);
    return await cleanup;
  }

  private clearArchivedMessagingCleanupCache(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): void {
    const key = this.archivedMessagingCleanupKey(params);
    this.archivedMessagingCleanupCompleted.delete(key);
    this.archivedMessagingCleanupGeneration.set(
      key,
      (this.archivedMessagingCleanupGeneration.get(key) ?? 0) + 1,
    );
  }

  private archivedMessagingCleanupKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): string {
    return `${params.backend}:${params.threadId}`;
  }

  private async runMessagingCleanupForArchivedThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    origin: "state-refresh" | "thread-archive";
  }): Promise<MessagingArchiveCleanupResult> {
    try {
      const store = this.resolveMessagingArchiveCleanupStore();
      const pendingIntentIds = store
        ? await store.deletePendingIntentsForThread({
            backend: params.backend,
            threadId: params.threadId,
          })
        : [];

      if (this.messagingArchiveCleaner) {
        const revokeResult =
          await this.messagingArchiveCleaner.requestBindingRevokeAllForThread({
            backend: params.backend,
            threadId: params.threadId,
            origin: "thread-archive",
          });

        if (revokeResult.revokedCount > 0 || pendingIntentIds.length > 0) {
          backendRegistryLog.info("archived thread messaging cleanup completed", {
            backend: params.backend,
            notifiedCount: revokeResult.notifiedCount,
            origin: params.origin,
            pendingIntentCount: pendingIntentIds.length,
            revokedCount: revokeResult.revokedCount,
            threadId: params.threadId,
          });
        }

        return {
          notifiedCount: revokeResult.notifiedCount,
          pendingIntentCount: pendingIntentIds.length,
          revokedCount: revokeResult.revokedCount,
        };
      }

      if (!store) {
        return { pendingIntentCount: 0, revokedCount: 0 };
      }

      const bindings = await store.findActiveBindingsForThread({
        backend: params.backend,
        threadId: params.threadId,
      });

      for (const binding of bindings) {
        await store.revokeBinding({ bindingId: binding.id });
        await this.recordMessagingBindingUnbound({
          backend: params.backend,
          binding,
          threadId: params.threadId,
        });
      }

      if (bindings.length > 0 || pendingIntentIds.length > 0) {
        backendRegistryLog.info("archived thread messaging cleanup completed", {
          backend: params.backend,
          origin: params.origin,
          pendingIntentCount: pendingIntentIds.length,
          revokedCount: bindings.length,
          threadId: params.threadId,
        });
      }

      return {
        pendingIntentCount: pendingIntentIds.length,
        revokedCount: bindings.length,
      };
    } catch (error) {
      backendRegistryLog.warn("archived thread messaging cleanup failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        origin: params.origin,
        threadId: params.threadId,
      });
      return { pendingIntentCount: 0, revokedCount: 0 };
    }
  }

  private async recordMessagingBindingUnbound(params: {
    backend: AppServerBackendKind;
    binding: Awaited<ReturnType<MessagingArchiveCleanupStore["findActiveBindingsForThread"]>>[number];
    threadId: string;
  }): Promise<void> {
    const conversation = params.binding.channel.conversation;
    const transition: ThreadMessagingBindingTransition = {
      id: randomUUID(),
      action: "unbound",
      bindingId: params.binding.id,
      platform: params.binding.channel.channel,
      conversationKind: conversation.kind,
      conversationTitle: conversation.title,
      parentTitle: conversation.parentTitle,
      ancestorTitle: conversation.ancestorTitle,
      occurredAt: Date.now(),
    };
    try {
      await this.overlayStore.appendMessagingBindingTransition({
        backend: params.backend,
        threadId: params.threadId,
        transition,
      });
    } catch (error) {
      backendRegistryLog.warn("archived thread messaging audit failed", {
        bindingId: params.binding.id,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  private async listCodexThreads(params: {
    archived?: boolean;
    enrichDirectories?: boolean;
    filter?: string;
  } = {}, diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<AppServerThreadSummary[]> {
    const defaultThreads = await this.codexClient
      .listThreads(params, diagnostics)
      .catch((error) => {
        if (diagnostics?.callerReason === "archive-cleanup") {
          throw error;
        }

        return [];
      });
    const allThreads = defaultThreads.map((thread) => ({
      ...thread,
      executionMode: "default" as const,
    }));
    const threadsWithPending = this.withPendingStartedThreads(
      "codex",
      allThreads,
      params,
    );

    const overlaysByThreadId = await this.overlayStore.getThreadOverlayStates({
      backend: "codex",
      threadIds: threadsWithPending.map((thread) => thread.id),
    });
    const reconciledOverlaysByThreadId =
      await this.reconcileCodexDirectoryRelationshipsFromSource({
        diagnostics,
        overlaysByThreadId,
        threads: threadsWithPending,
      });
    Object.assign(overlaysByThreadId, reconciledOverlaysByThreadId);
    if (
      !params.archived &&
      params.enrichDirectories === false &&
      shouldBackfillCodexDirectoryRelationships(diagnostics?.callerReason)
    ) {
      const updatedOverlaysByThreadId =
        await this.backfillMissingCodexDirectoryRelationships({
          diagnostics,
          overlaysByThreadId,
          threads: threadsWithPending,
        });
      Object.assign(overlaysByThreadId, updatedOverlaysByThreadId);
    }

    const enrichedThreads = await Promise.all(
      threadsWithPending.map(async (thread) => {
        const overlay = overlaysByThreadId[thread.id];
        const cwd = resolveThreadWorkspaceCwd(
          thread,
          overlay?.extraLinkedDirectories ?? [],
        );
        const codexEnvironmentOptions = cwd
          ? await listCodexEnvironmentOptions(cwd).catch(() => [])
          : [];
        return {
          ...thread,
          executionMode: overlay?.executionMode ?? thread.executionMode,
          model: overlay?.model ?? thread.model,
          reasoningEffort: overlay?.reasoningEffort ?? thread.reasoningEffort,
          serviceTier: overlay?.serviceTier ?? thread.serviceTier,
          fastMode: overlay?.fastMode ?? thread.fastMode,
          codexEnvironmentOptions,
        };
      }),
    );

    return enrichedThreads.sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }

  private async reconcileCodexDirectoryRelationshipsFromSource(params: {
    diagnostics?: {
      callerReason?: string;
      ownerId?: string;
    };
    overlaysByThreadId: Record<string, ThreadOverlayState | undefined>;
    threads: AppServerThreadSummary[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    const updatedOverlaysByThreadId: Record<
      string,
      ThreadOverlayState | undefined
    > = {};

    for (const thread of params.threads) {
      const directory = buildCachedDirectoryRelationship(thread);
      if (!directory) {
        continue;
      }

      const overlay = params.overlaysByThreadId[thread.id];
      if (!shouldRepairCachedDirectoryRelationship({ directory, overlay })) {
        continue;
      }

      updatedOverlaysByThreadId[thread.id] =
        await this.overlayStore.replaceWorkspaceLinkedDirectory({
          backend: "codex",
          threadId: thread.id,
          directory,
        });
    }

    const updatedThreadCount = Object.keys(updatedOverlaysByThreadId).length;
    if (updatedThreadCount > 0) {
      logDebug("codexDirectorySourceReconcile:completed", {
        callerReason: params.diagnostics?.callerReason ?? null,
        updatedThreadCount,
      });
    }

    return updatedOverlaysByThreadId;
  }

  private async backfillMissingCodexDirectoryRelationships(params: {
    diagnostics?: {
      callerReason?: string;
      ownerId?: string;
    };
    overlaysByThreadId: Record<string, ThreadOverlayState | undefined>;
    threads: AppServerThreadSummary[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    if (!this.codexClient.enrichThreadDirectories) {
      return {};
    }

    const candidates = params.threads.filter((thread) => {
      if (overlayHasHandoffWorkspace(params.overlaysByThreadId[thread.id])) {
        return false;
      }

      const projectKey = thread.projectKey?.trim();
      if (!isLikelyToolManagedWorktreePath(projectKey)) {
        return false;
      }

      const projectPath = path.resolve(projectKey!);
      return !hasCachedWorktreeDirectory(
        params.overlaysByThreadId[thread.id],
        projectPath,
      );
    });
    if (candidates.length === 0) {
      return {};
    }

    try {
      const enrichedThreads = await this.codexClient.enrichThreadDirectories(candidates);
      const updatedOverlaysByThreadId: Record<
        string,
        ThreadOverlayState | undefined
      > = {};

      for (const thread of enrichedThreads) {
        if (overlayHasHandoffWorkspace(params.overlaysByThreadId[thread.id])) {
          continue;
        }

        const directory = buildCachedWorktreeDirectory(thread);
        if (!directory) {
          const warningKey = `${thread.id}:${thread.projectKey ?? ""}`;
          if (!this.failedDirectoryRelationshipLogKeys.has(warningKey)) {
            this.failedDirectoryRelationshipLogKeys.add(warningKey);
            backendRegistryLog.warn(
              "Codex directory enrichment did not produce a worktree repository relationship",
              {
                callerReason: params.diagnostics?.callerReason ?? null,
                threadId: thread.id,
                projectKey: thread.projectKey,
                linkedDirectories: thread.linkedDirectories,
                overlayExtraLinkedDirectories:
                  params.overlaysByThreadId[thread.id]?.extraLinkedDirectories ?? [],
              },
            );
          }
          continue;
        }

        updatedOverlaysByThreadId[thread.id] =
          await this.overlayStore.replaceWorkspaceLinkedDirectory({
            backend: "codex",
            threadId: thread.id,
            directory,
          });
      }

      const updatedThreadCount = Object.keys(updatedOverlaysByThreadId).length;
      if (updatedThreadCount > 0) {
        logDebug("codexDirectoryBackfill:completed", {
          callerReason: params.diagnostics?.callerReason ?? null,
          candidateCount: candidates.length,
          updatedThreadCount,
        });
      }

      return updatedOverlaysByThreadId;
    } catch (error) {
      backendRegistryLog.warn("Codex directory relationship backfill failed", {
        callerReason: params.diagnostics?.callerReason ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  private withPendingStartedThreads(
    backend: AppServerBackendKind,
    threads: AppServerThreadSummary[],
    params: { archived?: boolean; filter?: string } = {},
  ): AppServerThreadSummary[] {
    const threadIds = new Set(threads.map((thread) => thread.id));
    for (const threadId of threadIds) {
      this.pendingStartedThreads.delete(`${backend}:${threadId}`);
    }
    if (params.archived === true) {
      return threads;
    }

    const pendingThreads = [...this.pendingStartedThreads.values()].filter(
      (thread) =>
        thread.source === backend &&
        !threadIds.has(thread.id) &&
        pendingStartedThreadMatchesFilter(thread, params.filter),
    );
    if (pendingThreads.length === 0) {
      return threads;
    }

    return [...pendingThreads, ...threads].sort(
      (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
    );
  }

  private async describeCodexBackend(): Promise<BackendSummary> {
    const [
      initializeResult,
      defaultModelsResult,
      accountResult,
      rateLimitsResult,
    ] = await Promise.allSettled([
      this.codexClient.getInitializeResult(),
      this.readCodexDefaultModelsOnce("backend-summary"),
      readClientAccount(this.codexClient),
      readClientRateLimits(this.codexClient),
    ]);
    const successful =
      initializeResult.status === "fulfilled" ? [initializeResult.value] : [];
    const methods = mergeMethods(successful);
    const available = successful.length > 0;
    const discoveredModels = [defaultModelsResult].flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const unavailableReason =
      initializeResult.status === "rejected"
        ? initializeResult.reason instanceof Error
          ? initializeResult.reason.message
          : String(initializeResult.reason)
        : "";

    return {
      kind: "codex",
      label: BACKEND_LABELS.codex,
      available,
      account:
        accountResult.status === "fulfilled" &&
        isMeaningfulAccountSummary(accountResult.value)
          ? accountResult.value
          : undefined,
      rateLimits:
        rateLimitsResult.status === "fulfilled"
          ? rateLimitsResult.value
          : undefined,
      serverName: successful[0]?.serverInfo?.name,
      serverVersion: successful[0]?.serverInfo?.version,
      methods,
      capabilities: buildCapabilities(methods, "codex"),
      launchpadOptions: buildLaunchpadOptions(
        "codex",
        discoveredModels.length > 0 ? discoveredModels : OPENAI_FALLBACK_MODELS,
      ),
      executionModes: [
        {
          mode: "default",
          label: EXECUTION_MODE_SUMMARIES.default.label,
          available,
          isDefault: true,
          unavailableReason:
            initializeResult.status === "rejected"
              ? initializeResult.reason instanceof Error
                ? initializeResult.reason.message
                : String(initializeResult.reason)
              : undefined,
        },
        {
          mode: "full-access",
          label: EXECUTION_MODE_SUMMARIES["full-access"].label,
          available,
          unavailableReason:
            initializeResult.status === "rejected"
              ? initializeResult.reason instanceof Error
                ? initializeResult.reason.message
                : String(initializeResult.reason)
              : undefined,
        },
      ],
      unavailableReason: available ? undefined : unavailableReason || "Codex unavailable",
    };
  }

  private async recordTaskMonitorUsage(event: AgentEvent): Promise<void> {
    const notification = event.notification;
    if (notification.method !== "thread/tokenUsage/updated") {
      return;
    }

    if (notification.params.turnId) {
      const reviewKey = buildReviewSubAgentKey(
        event.backend,
        notification.params.threadId,
        notification.params.turnId,
      );
      const reviewRecord = this.activeReviewSubAgents.get(reviewKey);
      const completedReviewRecord = this.reviewSubAgentsByReviewTurn.get(reviewKey);
      const model =
        readTaskMonitorUsageModel({
          notificationModel: notification.params.model,
          tokenUsage: notification.params.tokenUsage,
        }) ??
        reviewRecord?.model ??
        completedReviewRecord?.model;
      const serviceTier =
        readTaskMonitorUsageServiceTier(notification.params.tokenUsage) ??
        reviewRecord?.serviceTier ??
        completedReviewRecord?.serviceTier;
      const fastMode =
        readTaskMonitorUsageFastMode(notification.params.tokenUsage) ??
        reviewRecord?.fastMode ??
        completedReviewRecord?.fastMode;
      const usageSnapshot = buildTaskMonitorUsageSnapshot({
        fastMode,
        model,
        serviceTier,
        tokenUsage: notification.params.tokenUsage,
      });
      if (!usageSnapshot) {
        return;
      }
      if (reviewRecord) {
        reviewRecord.latestUsage = usageSnapshot;
        await this.persistReviewSubAgent(reviewRecord, {
          monitorUsage: usageSnapshot,
        });
        if (typeof this.overlayStore.upsertThreadUsageLine === "function") {
          const line = buildTaskMonitorUsageLine({
            backend: event.backend,
            fastMode,
            model,
            monitorId: reviewSubAgentId(reviewRecord.turnId),
            monitorThreadId: reviewRecord.reviewThreadId,
            monitorTurnId: reviewRecord.turnId,
            parentThreadId: reviewRecord.parentThreadId,
            serviceTier,
            source: "monitor",
            usage: usageSnapshot,
          });
          logUnpricedThreadUsageLine(line);
          await this.overlayStore.upsertThreadUsageLine({ line });
          await this.emitThreadPricingUpdated({
            backend: event.backend,
            threadId: line.parentThreadId ?? line.threadId,
          });
        }
        return;
      }
      const reviewUsagePersisted = await this.persistExistingReviewSubAgentUsage({
        backend: event.backend,
        parentThreadId:
          completedReviewRecord?.parentThreadId ?? notification.params.threadId,
        reviewThreadId:
          completedReviewRecord?.reviewThreadId ?? notification.params.threadId,
        turnId: notification.params.turnId,
        usage: usageSnapshot,
      });
      if (reviewUsagePersisted) {
        if (typeof this.overlayStore.upsertThreadUsageLine === "function") {
          const line = buildTaskMonitorUsageLine({
            backend: event.backend,
            fastMode,
            model,
            monitorId: reviewSubAgentId(notification.params.turnId),
            monitorThreadId:
              completedReviewRecord?.reviewThreadId ?? notification.params.threadId,
            monitorTurnId: notification.params.turnId,
            parentThreadId:
              completedReviewRecord?.parentThreadId ?? notification.params.threadId,
            serviceTier,
            source: "monitor",
            usage: usageSnapshot,
          });
          logUnpricedThreadUsageLine(line);
          await this.overlayStore.upsertThreadUsageLine({ line });
          await this.emitThreadPricingUpdated({
            backend: event.backend,
            threadId: line.parentThreadId ?? line.threadId,
          });
        }
        return;
      }
    }

    if (event.backend !== "codex") {
      return;
    }

    const monitorRecord = Array.from(this.taskMonitorDelegations.values()).find(
      (record) => record.monitorThreadId === notification.params.threadId,
    );
    if (!monitorRecord) {
      return;
    }

    monitorRecord.lastActivityAt = Date.now();
    const usageSnapshot = buildTaskMonitorUsageSnapshot({
      model: monitorRecord.preferredModel,
      tokenUsage: notification.params.tokenUsage,
    });
    if (usageSnapshot) {
      monitorRecord.latestUsage = usageSnapshot;
      await this.persistTaskMonitorSubAgent(monitorRecord, {
        monitorUsage: usageSnapshot,
      });
      if (typeof this.overlayStore.upsertThreadUsageLine === "function") {
        const line = buildTaskMonitorUsageLine({
          backend: event.backend,
          model: monitorRecord.preferredModel,
          monitorId: monitorRecord.monitorId,
          monitorThreadId: monitorRecord.monitorThreadId ?? notification.params.threadId,
          monitorTurnId: monitorRecord.monitorTurnId,
          parentThreadId: monitorRecord.parentThreadId,
          source: "monitor",
          usage: usageSnapshot,
        });
        logUnpricedThreadUsageLine(line);
        await this.overlayStore.upsertThreadUsageLine({ line });
        await this.emitThreadPricingUpdated({
          backend: event.backend,
          threadId: line.parentThreadId ?? line.threadId,
        });
      }
    }
  }

  private deriveLiveThreadTokenUsage(params: {
    backend: AppServerBackendKind;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): {
    cumulativeTokenUsage?: TaskMonitorTokenUsageBreakdown;
    turnTokenUsage: TaskMonitorTokenUsageBreakdown | unknown;
  } {
    const records = readTaskMonitorTokenUsageRecords(params.tokenUsage);
    if (!records) {
      return { turnTokenUsage: params.tokenUsage };
    }

    if (!records.totalUsage || !params.turnId) {
      return {
        ...(records.totalUsage ? { cumulativeTokenUsage: records.totalUsage } : {}),
        turnTokenUsage:
          records.latestUsage ?? records.currentUsage ?? params.tokenUsage,
      };
    }

    const key = [
      params.backend,
      params.threadId,
      params.turnId,
      "live-token-usage",
    ].join(":");
    let baseline = this.liveThreadUsageBaselines.get(key);
    if (!baseline && records.latestUsage) {
      baseline = subtractTaskMonitorTokenUsage(
        records.totalUsage,
        records.latestUsage,
      );
      if (baseline) {
        this.liveThreadUsageBaselines.set(key, baseline);
      }
    }

    const turnTokenUsage = baseline
      ? subtractTaskMonitorTokenUsage(records.totalUsage, baseline)
      : undefined;
    return {
      cumulativeTokenUsage: records.totalUsage,
      turnTokenUsage:
        turnTokenUsage ??
        records.latestUsage ??
        records.currentUsage ??
        records.totalUsage,
    };
  }

  private async recordLiveThreadUsage(event: AgentEvent): Promise<void> {
    const notification = event.notification;
    if (notification.method !== "thread/tokenUsage/updated") {
      return;
    }
    const threadId = notification.params.threadId;
    if (!threadId) {
      return;
    }
    if (
      Array.from(this.taskMonitorDelegations.values()).some(
        (record) => record.monitorThreadId === threadId,
      )
    ) {
      return;
    }
    if (notification.params.turnId) {
      const reviewKey = buildReviewSubAgentKey(
        event.backend,
        threadId,
        notification.params.turnId,
      );
      if (
        this.activeReviewSubAgents.has(reviewKey) ||
        this.reviewSubAgentsByReviewTurn.has(reviewKey)
      ) {
        return;
      }
    }

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: event.backend,
      threadId,
    });
    const tokenUsage = notification.params.tokenUsage;
    const model =
      (typeof notification.params.model === "string" && notification.params.model.trim()
        ? notification.params.model.trim()
        : undefined) ??
      readUsageString(tokenUsage, ["model", "modelId", "model_id"]) ??
      overlay?.model;
    const serviceTier = (
      readUsageString(tokenUsage, ["serviceTier", "service_tier"]) ??
      overlay?.serviceTier
    ) || undefined;
    const fastMode =
      readUsageBoolean(tokenUsage, ["fastMode", "fast_mode"]) ??
      overlay?.fastMode;
    const derivedUsage = this.deriveLiveThreadTokenUsage({
      backend: event.backend,
      threadId,
      tokenUsage,
      turnId: notification.params.turnId ?? undefined,
    });
    const usageTiming = resolveLiveThreadUsageTiming({
      overlay,
      turnId: notification.params.turnId ?? undefined,
    });
    const line = buildLiveThreadUsageLine({
      backend: event.backend,
      cumulativeTokenUsage: derivedUsage.cumulativeTokenUsage,
      ...usageTiming,
      fastMode,
      model,
      serviceTier,
      threadId,
      tokenUsage: derivedUsage.turnTokenUsage,
      turnId: notification.params.turnId ?? undefined,
    });
    if (!line) {
      return;
    }
    if (typeof this.overlayStore.upsertThreadUsageLine === "function") {
      logUnpricedThreadUsageLine(line);
      await this.overlayStore.upsertThreadUsageLine({ line });
      await this.emitThreadPricingUpdated({
        backend: event.backend,
        threadId: line.parentThreadId ?? line.threadId,
      });
    }
  }

  private async persistExistingReviewSubAgentUsage(params: {
    backend: AppServerBackendKind;
    parentThreadId: string;
    reviewThreadId: string;
    turnId: string;
    usage: ThreadSubAgentSummary["monitorUsage"];
  }): Promise<boolean> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.parentThreadId,
    });
    const monitorId = reviewSubAgentId(params.turnId);
    const existing = overlay?.subAgents?.find(
      (subAgent) =>
        subAgent.monitorId === monitorId ||
        (subAgent.monitorThreadId === params.reviewThreadId &&
          subAgent.monitorTurnId === params.turnId),
    );
    if (!existing) {
      return false;
    }

    await this.overlayStore.upsertThreadSubAgent({
      backend: params.backend,
      threadId: params.parentThreadId,
      subAgent: {
        ...existing,
        monitorUsage: params.usage,
        updatedAt: Date.now(),
      },
    });
    this.invalidateThreadListCache(params.backend);
    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: params.parentThreadId,
        },
      },
    });
    return true;
  }

  private async persistTaskMonitorSubAgent(
    record: TaskMonitorDelegationRecord,
    patch: Partial<
      Pick<
        ThreadSubAgentSummary,
        | "completedAt"
        | "completionSource"
        | "lastMessage"
        | "monitorUsage"
        | "outcome"
        | "status"
        | "updatedAt"
      >
    > = {},
  ): Promise<void> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: record.backend,
      threadId: record.parentThreadId,
    });
    const existing = overlay?.subAgents?.find(
      (subAgent) => subAgent.monitorId === record.monitorId,
    );
    const subAgent: ThreadSubAgentSummary = {
      monitorId: record.monitorId,
      task: record.task,
      status:
        patch.status ??
        existing?.status ??
        (record.monitorThreadId ? "running" : "pending"),
      createdAt: record.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
      preferredModel: record.preferredModel,
      preferredReasoningEffort: record.preferredReasoningEffort,
      ...(record.monitorThreadId ? { monitorThreadId: record.monitorThreadId } : {}),
      ...(record.monitorTurnId ? { monitorTurnId: record.monitorTurnId } : {}),
      ...(patch.lastMessage ?? existing?.lastMessage
        ? { lastMessage: patch.lastMessage ?? existing?.lastMessage }
        : {}),
      ...(patch.outcome ?? existing?.outcome
        ? { outcome: patch.outcome ?? existing?.outcome }
        : {}),
      ...(patch.completedAt ?? existing?.completedAt
        ? { completedAt: patch.completedAt ?? existing?.completedAt }
        : {}),
      ...(patch.completionSource ?? existing?.completionSource
        ? { completionSource: patch.completionSource ?? existing?.completionSource }
        : {}),
      ...(patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage
        ? {
            monitorUsage:
              patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage,
          }
        : {}),
      pollIntervalSeconds: record.pollIntervalSeconds,
      heartbeatIntervalSeconds: record.heartbeatIntervalSeconds,
      startupTimeoutSeconds: record.startupTimeoutSeconds,
    };
    await this.overlayStore.upsertThreadSubAgent({
      backend: record.backend,
      threadId: record.parentThreadId,
      subAgent,
    });
    this.invalidateThreadListCache(record.backend);
    await this.emit({
      backend: record.backend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: record.parentThreadId,
        },
      },
    });
  }

  private async persistReviewSubAgent(
    record: ReviewSubAgentRecord,
    patch: Partial<
      Pick<
        ThreadSubAgentSummary,
        | "completedAt"
        | "lastMessage"
        | "monitorUsage"
        | "outcome"
        | "status"
        | "updatedAt"
      >
    > = {},
  ): Promise<void> {
    const existingOverlay = await this.overlayStore.getThreadOverlayState({
      backend: record.backend,
      threadId: record.parentThreadId,
    });
    const monitorId = reviewSubAgentId(record.turnId);
    const existing = existingOverlay?.subAgents?.find(
      (subAgent) => subAgent.monitorId === monitorId,
    );
    const subAgent: ThreadSubAgentSummary = {
      monitorId,
      task: record.task,
      status: patch.status ?? existing?.status ?? "running",
      createdAt: record.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
      monitorThreadId: record.reviewThreadId,
      monitorTurnId: record.turnId,
      ...(patch.lastMessage ?? existing?.lastMessage
        ? { lastMessage: patch.lastMessage ?? existing?.lastMessage }
        : {}),
      ...(patch.outcome ?? existing?.outcome
        ? { outcome: patch.outcome ?? existing?.outcome }
        : {}),
      ...(patch.completedAt ?? existing?.completedAt
        ? { completedAt: patch.completedAt ?? existing?.completedAt }
        : {}),
      ...(patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage
        ? {
            monitorUsage:
              patch.monitorUsage ?? record.latestUsage ?? existing?.monitorUsage,
          }
        : {}),
    };

    await this.overlayStore.upsertThreadSubAgent({
      backend: record.backend,
      threadId: record.parentThreadId,
      subAgent,
    });
    this.invalidateThreadListCache(record.backend);
    await this.emit({
      backend: record.backend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: record.parentThreadId,
        },
      },
    });
  }

  private async completeReviewSubAgent(params: {
    backend: AppServerBackendKind;
    completedAt?: number;
    method: AppServerNotification["method"];
    threadId: string;
    turnId: string;
  }): Promise<void> {
    const activeReview = this.findActiveReviewSubAgentForTerminal(params);
    if (!activeReview) {
      return;
    }

    this.activeReviewSubAgents.delete(activeReview.key);
    const { record } = activeReview;
    const completedAt = params.completedAt ?? Date.now();
    if (params.method === "turn/completed") {
      await this.persistReviewSubAgent(record, {
        completedAt,
        lastMessage: "Review completed.",
        outcome: "success",
        status: "success",
        updatedAt: completedAt,
      });
      return;
    }

    if (params.method === "turn/cancelled") {
      await this.persistReviewSubAgent(record, {
        completedAt,
        lastMessage: "Review cancelled.",
        outcome: "cancelled",
        status: "cancelled",
        updatedAt: completedAt,
      });
      return;
    }

    await this.persistReviewSubAgent(record, {
      completedAt,
      lastMessage: "Review failed.",
      outcome: "failure",
      status: "failed",
      updatedAt: completedAt,
    });
  }

  private findActiveReviewSubAgentForTerminal(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): { key: string; record: ReviewSubAgentRecord } | undefined {
    const exactKey = buildReviewSubAgentKey(
      params.backend,
      params.threadId,
      params.turnId,
    );
    const exactRecord = this.activeReviewSubAgents.get(exactKey);
    if (exactRecord) {
      return { key: exactKey, record: exactRecord };
    }

    if (params.backend !== "codex") {
      return undefined;
    }

    for (const [key, record] of this.activeReviewSubAgents.entries()) {
      if (record.backend !== params.backend || record.reviewThreadId !== params.threadId) {
        continue;
      }
      const reviewTurnKey = buildActiveTurnModeKey(
        record.reviewThreadId,
        record.turnId,
      );
      if (this.activeCodexReviewInterruptTurnIds.get(reviewTurnKey) === params.turnId) {
        return { key, record };
      }
    }

    return undefined;
  }

  private recordTaskMonitorActivity(notification: AppServerNotification): void {
    const params = readRecord(notification.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!threadId) {
      return;
    }

    const monitorRecord = Array.from(this.taskMonitorDelegations.values()).find(
      (record) => record.monitorThreadId === threadId,
    );
    if (!monitorRecord) {
      return;
    }

    monitorRecord.lastActivityAt = Date.now();
    const itemType = readNotificationItemType(notification);
    if (itemType !== "commandExecution") {
      return;
    }

    if (notification.method === "item/started") {
      monitorRecord.activeCommandCount += 1;
    } else if (notification.method === "item/completed") {
      monitorRecord.activeCommandCount = Math.max(
        0,
        monitorRecord.activeCommandCount - 1,
      );
    }
  }

  private async describeSingleBackend(
    kind: AppServerBackendKind,
    client: BackendClient
  ): Promise<BackendSummary> {
    try {
      const initialize = await client.getInitializeResult();
      const models =
        kind === "grok"
          ? await this.readGrokDefaultModelsOnce("backend-summary").catch(() => [])
          : await readClientModels(client).catch(() => []);
      const methods = Array.isArray(initialize.methods)
        ? initialize.methods.filter((method): method is string => typeof method === "string")
        : [];

      return {
        kind,
        label: BACKEND_LABELS[kind],
        available: true,
        serverName: initialize.serverInfo?.name,
        serverVersion: initialize.serverInfo?.version,
        methods,
        capabilities: buildCapabilities(methods, kind),
        launchpadOptions: buildLaunchpadOptions(kind, models),
        executionModes: [
          {
            mode: "default",
            label: EXECUTION_MODE_SUMMARIES.default.label,
            available: true,
            isDefault: true,
          },
        ],
      };
    } catch (error) {
      return {
        kind,
        label: BACKEND_LABELS[kind],
        available: false,
        methods: [],
        capabilities: buildCapabilities([], kind),
        executionModes: [
          {
            mode: "default",
            label: EXECUTION_MODE_SUMMARIES.default.label,
            available: false,
            isDefault: true,
            unavailableReason: error instanceof Error ? error.message : String(error),
          },
        ],
        unavailableReason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    // Whether to emit the routing diagnostic. Reads (readThread) are
    // execution-mode-agnostic and get called once per thread by content
    // search, so they opt out — otherwise a single thread search spews one
    // routing line per thread. Turn/execution paths keep it on (the #203
    // security cross-check in messaging-controller relies on it).
    logRouting = true,
  ): Promise<T> {
    // Single-client passthrough. The mode passed to the operation is no
    // longer a routing decision — it's documentation for callers that
    // want to forward it to codex's per-turn approvalPolicy/sandboxPolicy
    // override on turn/start (PR #213). The cross-mode try/fallback
    // logic is gone because there is no second process to fall back to.
    let mode: ThreadExecutionMode;
    let source: "explicit" | "overlay" | "default-fallback";
    if (requestedMode) {
      mode = requestedMode;
      source = "explicit";
    } else {
      const overlay = await this.overlayStore.getThreadOverlayState({
        backend: "codex",
        threadId,
      });
      if (overlay?.executionMode) {
        mode = overlay.executionMode;
        source = "overlay";
      } else {
        mode = "default";
        source = "default-fallback";
      }
    }
    if (logRouting) {
      backendRegistryLog.debug("codex thread client routing", {
        threadId,
        requestedMode,
        resolvedMode: mode,
        source,
      });
    }
    return await operation(this.codexClient, mode);
  }

  private async withActiveCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
  ): Promise<T> {
    const activeMode = this.findActiveCodexThreadMode(threadId);
    if (activeMode) {
      return await operation(this.getClient("codex", activeMode), activeMode);
    }

    return await this.withCodexThreadClient(threadId, operation);
  }

  private findActiveCodexThreadMode(threadId: string): ThreadExecutionMode | undefined {
    const keyPrefix = `${threadId}:`;
    const modes = new Set<ThreadExecutionMode>();
    for (const [key, mode] of this.activeCodexTurnModes.entries()) {
      if (key.startsWith(keyPrefix)) {
        modes.add(mode);
      }
    }

    return modes.size === 1 ? [...modes][0] : undefined;
  }

  private async archiveWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.archiveThread) {
      throw new Error("Selected backend does not support thread archiving");
    }

    return await client.archiveThread({ threadId });
  }

  private async findThreadForArchiveCleanup(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ArchiveCleanupMetadata> {
    const activeThreads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: "archive-cleanup",
    });
    const activeThread = activeThreads.find((thread) => thread.id === params.threadId);
    let archivedThreads: AppServerThreadSummary[] = [];
    try {
      archivedThreads = await this.listThreads({
        backend: params.backend,
        archived: true,
        callerReason: "archive-cleanup",
      });
    } catch (error) {
      if (!activeThread) {
        throw error;
      }
      backendRegistryLog.warn("archive cleanup archived-thread lookup failed", {
        backend: params.backend,
        threadId: params.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (activeThread) {
      return {
        activeThreads,
        archivedThreads,
        thread: activeThread,
      };
    }

    const archivedThread = archivedThreads.find((thread) => thread.id === params.threadId);
    if (archivedThread) {
      return {
        activeThreads,
        archivedThreads,
        thread: archivedThread,
      };
    }

    throw new Error("Thread metadata was not found.");
  }

  private async findThreadForRestoreWorktrees(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    return await this.listThreads({
      backend: params.backend,
      archived: true,
      callerReason: "thread-restore-worktrees",
    })
      .then((threads) => threads.find((thread) => thread.id === params.threadId))
      .catch((error) => {
        backendRegistryLog.warn("restore thread worktree metadata lookup failed", {
          backend: params.backend,
          threadId: params.threadId,
          error: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      });
  }

  private async findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    return await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: params.callerReason ?? "workspace-handoff",
    })
      .then((threads) => threads.find((thread) => thread.id === params.threadId))
      .catch(() => undefined);
  }

  private async resolveThreadEnvironmentCwd(
    backend: AppServerBackendKind,
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined> {
    const overlayCwd = resolveLinkedDirectoryWorkspaceCwd(
      overlay?.extraLinkedDirectories,
    );
    if (overlayCwd?.trim()) {
      return overlayCwd.trim();
    }

    const pendingThread = this.pendingStartedThreads.get(`${backend}:${threadId}`);
    const pendingCwd = resolveThreadWorkspaceCwd(pendingThread);
    if (pendingCwd?.trim()) {
      return pendingCwd.trim();
    }

    const thread = await this.findThreadForWorkspaceHandoff({
      backend,
      callerReason: "turn-cwd",
      threadId,
    });
    return resolveThreadWorkspaceCwd(thread)?.trim() || undefined;
  }

  private async recordCodexWorktreeOwnerThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
  }): Promise<void> {
    const worktreePath = params.worktreePath?.trim();
    if (params.backend !== "codex" || !worktreePath) {
      return;
    }

    try {
      await this.gitDirectoryService.recordCodexWorktreeOwnerThread({
        worktreePath,
        threadId: params.threadId,
      });
    } catch (error) {
      backendRegistryLog.warn("failed to record Codex worktree owner thread", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
        worktreePath,
      });
    }
  }

  private resolveHandoffWorkspaceCandidate(
    thread: AppServerThreadSummary | undefined,
    request: HandoffThreadWorkspaceRequest,
  ): {
    repositoryPath?: string;
    sourceBranch?: string;
    sourcePath?: string;
  } {
    if (request.repositoryPath && request.sourcePath) {
      return {
        repositoryPath: request.repositoryPath,
        sourceBranch: request.sourceBranch,
        sourcePath: request.sourcePath,
      };
    }

    if (!thread) {
      throw new Error("Thread workspace metadata is unavailable for handoff.");
    }

    const directory =
      request.direction === "worktree-to-local"
        ? thread.linkedDirectories.find((candidate) => candidate.kind === "worktree")
        : thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
          thread.linkedDirectories[0];
    const sourcePath =
      request.direction === "worktree-to-local"
        ? directory?.worktreePath ?? directory?.path
        : directory?.path ?? thread.projectKey;
    const repositoryPath =
      request.direction === "worktree-to-local"
        ? directory?.path ?? request.repositoryPath
        : directory?.path ?? thread.projectKey ?? request.repositoryPath;

    if (!sourcePath || !repositoryPath) {
      throw new Error("Thread does not have an eligible Git workspace for handoff.");
    }

    return {
      repositoryPath,
      sourceBranch: request.sourceBranch,
      sourcePath,
    };
  }

  private async archiveThreadWorktrees(params: {
    activeThreads: AppServerThreadSummary[];
    archivedThreads: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    thread: AppServerThreadSummary;
  }): Promise<ArchiveThreadCleanupResult[]> {
    const candidates: WorktreeArchiveCandidate[] =
      params.thread.linkedDirectories.flatMap((directory) => {
        const worktreePath = linkedDirectoryWorktreePath(directory);
        if (!worktreePath?.trim()) {
          return [];
        }

        return [
          {
            repositoryPath: directory.path,
            worktreePath,
          },
        ];
      });
    const uniqueCandidates: WorktreeArchiveCandidate[] = [
      ...new Map(
        candidates.map((candidate) => [
          `${candidate.repositoryPath}:${candidate.worktreePath}`,
          candidate,
        ]),
      ).values(),
    ];

    if (uniqueCandidates.length === 0) {
      backendRegistryLog.warn("archive thread worktree cleanup skipped: no worktree candidates", {
        backend: params.backend,
        threadId: params.thread.id,
        linkedDirectoryCount: params.thread.linkedDirectories.length,
        projectKey: params.thread.projectKey,
        gitBranch: params.thread.observedGitBranch ?? params.thread.gitBranch,
      });
      return [];
    }

    return await Promise.all(
      uniqueCandidates.map(async (candidate): Promise<ArchiveThreadCleanupResult> => {
        try {
          const activeUsers = this.findActiveThreadsUsingWorktree({
            activeThreads: params.activeThreads,
            archivedThreadId: params.thread.id,
            worktreePath: candidate.worktreePath,
          });
          if (activeUsers.length > 0) {
            const activeThreadIds = activeUsers.map((thread) => thread.id);
            const skippedReason =
              activeThreadIds.length === 1
                ? `Worktree is still used by another active thread: ${activeThreadIds[0]}.`
                : `Worktree is still used by other active threads: ${activeThreadIds.join(", ")}.`;
            backendRegistryLog.info("archive thread worktree cleanup skipped: shared worktree", {
              backend: params.backend,
              threadId: params.thread.id,
              activeThreadIds,
              repositoryPath: candidate.repositoryPath,
              worktreePath: candidate.worktreePath,
            });
            return {
              worktreePath: candidate.worktreePath,
              branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
              removedWorktree: false,
              deletedBranch: false,
              skippedReason,
            };
          }

          backendRegistryLog.info("archive thread worktree cleanup removing worktree", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
          });
          const snapshot = await this.worktreeArchiveService.archive({
            backend: params.backend,
            threadId: params.thread.id,
            worktreePath: candidate.worktreePath,
            repositoryPath: candidate.repositoryPath,
          });
          await this.overlayStore.upsertWorktreeSnapshot({
            backend: params.backend,
            threadId: params.thread.id,
            snapshot,
          });
          await this.retainSharedWorktreeSnapshotForArchivedThreads({
            archivedThreadId: params.thread.id,
            archivedThreads: params.archivedThreads,
            backend: params.backend,
            snapshot,
            worktreePath: candidate.worktreePath,
          });

          let worktreeStillExists = false;
          try {
            worktreeStillExists = await pathExists(snapshot.worktreePath);
          } catch (sentinelError) {
            const error =
              sentinelError instanceof Error ? sentinelError.message : String(sentinelError);
            backendRegistryLog.error("archive thread worktree cleanup sentinel failed", {
              backend: params.backend,
              threadId: params.thread.id,
              repositoryPath: snapshot.repositoryPath,
              worktreePath: snapshot.worktreePath,
              error,
            });
            return {
              worktreePath: snapshot.worktreePath,
              branch: snapshot.sourceBranch,
              removedWorktree: false,
              deletedBranch: false,
              error: `Unable to verify worktree removal: ${error}`,
            };
          }

          if (worktreeStillExists) {
            const error = "Worktree directory still exists after archive cleanup.";
            backendRegistryLog.error("archive thread worktree cleanup left worktree directory", {
              backend: params.backend,
              threadId: params.thread.id,
              repositoryPath: snapshot.repositoryPath,
              worktreePath: snapshot.worktreePath,
              branch: snapshot.sourceBranch,
              snapshotRef: snapshot.snapshotRef,
              snapshotCommit: snapshot.snapshotCommit,
              error,
            });
            return {
              worktreePath: snapshot.worktreePath,
              branch: snapshot.sourceBranch,
              removedWorktree: false,
              deletedBranch: false,
              error,
            };
          }

          return {
            worktreePath: snapshot.worktreePath,
            branch: snapshot.sourceBranch,
            removedWorktree: true,
            deletedBranch: false,
          };
        } catch (error) {
          backendRegistryLog.warn("archive thread worktree cleanup failed", {
            backend: params.backend,
            threadId: params.thread.id,
            repositoryPath: candidate.repositoryPath,
            worktreePath: candidate.worktreePath,
            error: error instanceof Error ? error.message : String(error),
          });
          return {
            worktreePath: candidate.worktreePath,
            branch: params.thread.observedGitBranch ?? params.thread.gitBranch,
            removedWorktree: false,
            deletedBranch: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  }

  private async retainSharedWorktreeSnapshotForArchivedThreads(params: {
    archivedThreadId: string;
    archivedThreads: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    snapshot: WorktreeSnapshotSummary;
    worktreePath: string;
  }): Promise<void> {
    const archivedWorktreePath = normalizeWorktreePathForComparison(params.worktreePath);
    const siblingThreads = params.archivedThreads.filter((thread) => {
      if (thread.source !== params.backend || thread.id === params.archivedThreadId) {
        return false;
      }

      return thread.linkedDirectories.some((directory) => {
        const candidatePath = linkedDirectoryWorktreePath(directory);
        return (
          candidatePath !== undefined &&
          normalizeWorktreePathForComparison(candidatePath) === archivedWorktreePath
        );
      });
    });

    if (siblingThreads.length === 0) {
      return;
    }

    await Promise.all(
      siblingThreads.map((thread) =>
        this.overlayStore.upsertWorktreeSnapshot({
          backend: params.backend,
          threadId: thread.id,
          snapshot: {
            ...params.snapshot,
            threadId: thread.id,
          },
        }),
      ),
    );
  }

  private findActiveThreadsUsingWorktree(params: {
    activeThreads: AppServerThreadSummary[];
    archivedThreadId: string;
    worktreePath: string;
  }): AppServerThreadSummary[] {
    const archivedWorktreePath = normalizeWorktreePathForComparison(params.worktreePath);
    return params.activeThreads.filter((thread) => {
      if (thread.id === params.archivedThreadId) {
        return false;
      }

      return thread.linkedDirectories.some((directory) => {
        const candidatePath = linkedDirectoryWorktreePath(directory);
        return (
          candidatePath !== undefined &&
          normalizeWorktreePathForComparison(candidatePath) === archivedWorktreePath
        );
      });
    });
  }

  private async ungroupChildrenOfArchivedThread(params: {
    activeThreads: AppServerThreadSummary[];
    backend: AppServerBackendKind;
    parentThreadId: string;
  }): Promise<void> {
    const setThreadParent = this.overlayStore.setThreadParent;
    if (!setThreadParent) {
      return;
    }

    const activeThreadIds = params.activeThreads
      .filter((thread) => thread.source === params.backend)
      .map((thread) => thread.id);
    const overlaysByThreadId = await this.overlayStore.getThreadOverlayStates({
      backend: params.backend,
      threadIds: activeThreadIds,
    });
    const childThreadIds = activeThreadIds.filter(
      (threadId) =>
        overlaysByThreadId[threadId]?.parentThreadId === params.parentThreadId,
    );
    if (childThreadIds.length === 0) {
      return;
    }

    await Promise.all(
      childThreadIds.map((threadId) =>
        setThreadParent.call(this.overlayStore, {
          backend: params.backend,
          threadId,
          parentThreadId: undefined,
        }),
      ),
    );
  }

  private async restoreThreadWorktrees(params: {
    backend: AppServerBackendKind;
    threadId: string;
    thread?: AppServerThreadSummary;
  }): Promise<RestoreThreadWorktreeResult[]> {
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const candidates = this.buildRestoreThreadWorktreeCandidates({
      overlay,
      thread: params.thread,
    });

    return await Promise.all(
      candidates.map(
        async (candidate): Promise<RestoreThreadWorktreeResult> => {
          try {
            if (await pathExists(candidate.worktreePath)) {
              return {
                worktreePath: candidate.worktreePath,
                repositoryPath: candidate.repositoryPath,
                snapshotRef: candidate.snapshot?.snapshotRef,
                restored: false,
                skippedReason: "Worktree path already exists.",
              };
            }

            if (!candidate.repositoryPath) {
              return {
                worktreePath: candidate.worktreePath,
                snapshotRef: candidate.snapshot?.snapshotRef,
                restored: false,
                skippedReason:
                  "Repository path is unavailable for this archived worktree.",
              };
            }

            const restoredSnapshot = candidate.snapshot
              ? await this.worktreeArchiveService.restore({
                  backend: params.backend,
                  threadId: params.threadId,
                  worktreePath: candidate.worktreePath,
                  repositoryPath: candidate.repositoryPath,
                  snapshotRef: candidate.snapshot.snapshotRef,
                  snapshotCommit: candidate.snapshot.snapshotCommit,
                  snapshot: candidate.snapshot,
                  allowDetachedFallback: true,
                })
              : await this.worktreeArchiveService.restoreDetached({
                  backend: params.backend,
                  threadId: params.threadId,
                  worktreePath: candidate.worktreePath,
                  repositoryPath: candidate.repositoryPath,
                  restoreRef: candidate.branch,
                });
            await this.overlayStore.upsertWorktreeSnapshot({
              backend: params.backend,
              threadId: params.threadId,
              snapshot: restoredSnapshot,
            });

            return {
              worktreePath: restoredSnapshot.worktreePath,
              repositoryPath: restoredSnapshot.repositoryPath,
              snapshotRef: restoredSnapshot.snapshotRef,
              restored: true,
              snapshot: restoredSnapshot,
            };
          } catch (error) {
            backendRegistryLog.warn("restore thread worktree restore failed", {
              backend: params.backend,
              threadId: params.threadId,
              repositoryPath: candidate.repositoryPath,
              worktreePath: candidate.worktreePath,
              snapshotRef: candidate.snapshot?.snapshotRef,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              worktreePath: candidate.worktreePath,
              repositoryPath: candidate.repositoryPath,
              snapshotRef: candidate.snapshot?.snapshotRef,
              restored: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      ),
    );
  }

  private buildRestoreThreadWorktreeCandidates(params: {
    overlay?: ThreadOverlayState;
    thread?: AppServerThreadSummary;
  }): WorktreeRestoreCandidate[] {
    const snapshotCandidates: WorktreeRestoreCandidate[] = [
      ...(params.overlay?.worktreeSnapshots ?? []),
    ]
      .filter((snapshot) => snapshot.state !== "present")
      .sort(
        (left, right) =>
          (right.archivedAt ?? right.restoredAt ?? right.createdAt) -
          (left.archivedAt ?? left.restoredAt ?? left.createdAt),
      )
      .map((snapshot) => ({
        repositoryPath: snapshot.repositoryPath,
        snapshot,
        worktreePath: snapshot.worktreePath,
      }));
    const metadataCandidates = this.buildRestoreThreadMetadataCandidates(
      params.thread,
      snapshotCandidates,
    );
    const seenWorktreePaths = new Set<string>();
    return [...snapshotCandidates, ...metadataCandidates].filter((candidate) => {
      const resolvedPath = path.resolve(candidate.worktreePath);
      if (seenWorktreePaths.has(resolvedPath)) {
        return false;
      }
      seenWorktreePaths.add(resolvedPath);
      return true;
    });
  }

  private buildRestoreThreadMetadataCandidates(
    thread: AppServerThreadSummary | undefined,
    snapshotCandidates: WorktreeRestoreCandidate[],
  ): WorktreeRestoreCandidate[] {
    if (!thread) {
      return [];
    }

    const fallbackRepositoryPath = snapshotCandidates.find(
      (candidate) => candidate.repositoryPath?.trim(),
    )?.repositoryPath;
    const branch = thread.observedGitBranch ?? thread.gitBranch;

    return thread.linkedDirectories.flatMap((directory): WorktreeRestoreCandidate[] => {
      const worktreePath =
        directory.worktreePath ?? (directory.kind === "worktree" ? directory.path : undefined);
      if (!worktreePath?.trim()) {
        return [];
      }

      const repositoryPath =
        directory.path.trim() &&
        !isToolManagedWorktreePath(directory.path) &&
        path.resolve(directory.path) !== path.resolve(worktreePath)
          ? directory.path
          : fallbackRepositoryPath;

      return [
        {
          branch,
          repositoryPath,
          worktreePath,
        },
      ];
    });
  }

  private async restoreWithClient(
    client: BackendClient,
    threadId: string,
  ): Promise<{ threadId: string }> {
    if (!client.restoreThread) {
      throw new Error("Selected backend does not support thread restore");
    }

    return await client.restoreThread({ threadId });
  }

  private async renameWithClient(
    client: BackendClient,
    threadId: string,
    name: string,
  ): Promise<{ threadId: string }> {
    if (!client.renameThread) {
      throw new Error("Selected backend does not support thread renaming");
    }

    return await client.renameThread({ threadId, name });
  }

  private async updateThreadGitBranchMetadata(params: {
    backend: AppServerBackendKind;
    branch?: string;
    threadId: string;
  }): Promise<void> {
    const branch = params.branch?.trim();
    if (!branch) {
      return;
    }

    const updateWithClient = async (client: BackendClient): Promise<void> => {
      if (!client.updateThreadMetadata) {
        return;
      }

      await client.updateThreadMetadata({
        threadId: params.threadId,
        gitInfo: {
          branch,
        },
      });
    };

    try {
      if (params.backend === "codex") {
        await this.withCodexThreadClient(params.threadId, async (client) => {
          await updateWithClient(client);
        });
      } else {
        await updateWithClient(this.grokClient);
      }
    } catch (error) {
      backendRegistryLog.warn("thread git metadata update failed after handoff", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  private scheduleThreadTitleGeneration(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
  }): void {
    if (!this.threadTitleGenerationService) {
      return;
    }

    const prompt = extractFirstMeaningfulTextInput(params.input);
    if (!prompt) {
      return;
    }

    const key = buildTitleGenerationKey(params.backend, params.threadId);
    if (this.attemptedTitleGenerations.has(key)) {
      return;
    }

    const promptHash = buildPromptHash(prompt);
    const current = this.pendingTitleGenerations.get(key);
    if (current) {
      return;
    }

    this.attemptedTitleGenerations.add(key);
    const token = ++this.titleGenerationSequence;
    this.pendingTitleGenerations.set(key, {
      promptHash,
      token,
    });

    void this.generateAndApplyThreadTitle({
      backend: params.backend,
      threadId: params.threadId,
      prompt,
      key,
      token,
    });
  }

  private async generateAndApplyThreadTitle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prompt: string;
    key: string;
    token: number;
  }): Promise<void> {
    try {
      const currentThread = await this.findThreadForTitleGeneration({
        backend: params.backend,
        callerReason: "title-generation",
        threadId: params.threadId,
      });
      if (!isEligibleForGeneratedTitle(currentThread, params.prompt)) {
        this.logThreadTitleGeneration(
          "skipped",
          params,
          "current_title_not_eligible",
          buildTitleEligibilityLogDetails(currentThread, params.prompt)
        );
        return;
      }

      this.logThreadTitleGeneration("requesting", params, undefined, {
        promptTitle: truncateLogValue(shortenDerivedThreadTitle(params.prompt) ?? params.prompt),
      });
      const result = await this.threadTitleGenerationService?.generateTitle({
        backend: params.backend,
        userPrompt: params.prompt,
      });
      if (!result || result.status !== "generated") {
        this.logThreadTitleGeneration(
          result?.status ?? "unavailable",
          params,
          result?.reason ?? "title_generation_unavailable"
        );
        if (isAcpBackendId(params.backend)) {
          await this.applyPromptDerivedAcpThreadTitle({
            backend: params.backend,
            threadId: params.threadId,
            prompt: params.prompt,
          });
        }
        return;
      }
      this.logThreadTitleGeneration("generated", params, undefined, {
        generatedTitle: truncateLogValue(result.title),
        cachedTokens: result.cachedTokens ?? null,
      });

      const pending = this.pendingTitleGenerations.get(params.key);
      if (!pending || pending.token !== params.token) {
        this.logThreadTitleGeneration("skipped", params, "stale_generation", {
          generatedTitle: truncateLogValue(result.title),
        });
        return;
      }

      const latestThread = await this.findThreadForTitleGeneration({
        backend: params.backend,
        callerReason: "title-generation",
        threadId: params.threadId,
      });
      if (latestThread && !isEligibleForGeneratedTitle(latestThread, params.prompt)) {
        this.logThreadTitleGeneration(
          "skipped",
          params,
          "latest_title_not_eligible",
          buildTitleEligibilityLogDetails(latestThread, params.prompt)
        );
        return;
      }

      await this.applyGeneratedThreadTitle({
        backend: params.backend,
        threadId: params.threadId,
        title: result.title,
      });
      this.logThreadTitleGeneration("applied", params, undefined, {
        generatedTitle: truncateLogValue(result.title),
      });
    } catch (error) {
      this.logThreadTitleGeneration(
        "failed",
        params,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      const pending = this.pendingTitleGenerations.get(params.key);
      if (pending?.token === params.token) {
        this.pendingTitleGenerations.delete(params.key);
      }
    }
  }

  private async applyPromptDerivedAcpThreadTitle(params: {
    backend: AcpBackendId;
    threadId: string;
    prompt: string;
  }): Promise<void> {
    const title = shortenDerivedThreadTitle(params.prompt);
    if (!title) {
      return;
    }
    const latestThread = await this.findThreadForTitleGeneration({
      backend: params.backend,
      callerReason: "title-generation",
      threadId: params.threadId,
    });
    if (latestThread && !isEligibleForGeneratedTitle(latestThread, params.prompt)) {
      return;
    }
    await this.renameAcpSession(params.backend, params.threadId, title, {
      titleSource: "fallback",
    });
    this.logThreadTitleGeneration("applied", params, "prompt_derived_fallback", {
      generatedTitle: truncateLogValue(title),
    });
  }

  private async applyGeneratedThreadTitle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    title: string;
  }): Promise<void> {
    if (isAcpBackendId(params.backend)) {
      await this.renameAcpSession(params.backend, params.threadId, params.title, {
        titleSource: "derived",
      });
    } else if (params.backend === "codex") {
      await this.withCodexThreadClient(params.threadId, async (client) =>
        await this.renameWithClient(client, params.threadId, params.title)
      );
    } else {
      await this.renameWithClient(this.grokClient, params.threadId, params.title);
    }
  }

  private async findThreadForTitleGeneration(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined> {
    const activeThreads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: params.callerReason ?? "title-generation",
    }).catch(() => []);
    return activeThreads.find((thread) => thread.id === params.threadId);
  }

  private logThreadTitleGeneration(
    status: ThreadTitleGenerationLogStatus,
    params: {
      backend: AppServerBackendKind;
      threadId: string;
    },
    reason?: string,
    details?: Record<string, unknown>,
  ): void {
    logDebug("threadTitleGeneration", {
      backend: params.backend,
      threadId: params.threadId,
      status,
      reason: reason ?? null,
      ...details,
    });
  }

  private async handleServerRequest(
    backend: AppServerBackendKind,
    request: AppServerPendingRequestNotification,
  ): Promise<unknown> {
    if (isAcpBackendId(backend) && isAcpPermissionRequest(request)) {
      const session = this.acpBackend.getSession(backend, request.params.threadId);
      const runtimeCapabilities =
        this.acpBackend.getInstalledAgent(backend)?.runtimeCapabilities;
      const runtimeControlsExecutionMode = acpRuntimeHasExecutionModeSelection({
        runtime: session?.acpRuntime,
        runtimeCapabilities,
      });
      const runtimeRequiresFullAccess = acpRuntimeStateRequiresFullAccess({
        runtime: session?.acpRuntime,
        runtimeCapabilities,
      });
      if (
        runtimeControlsExecutionMode
          ? runtimeRequiresFullAccess
          : session?.executionMode === "full-access"
      ) {
        backendRegistryLog.info("auto-approving ACP permission request", {
          backend,
          executionMode: session?.executionMode ?? "default",
          requestId: request.params.requestId,
          runtimeControlsExecutionMode,
          runtimeRequiresFullAccess,
          threadId: request.params.threadId,
          turnId: request.params.turnId,
        });
        return { decision: "approve" };
      }
    }

    const dynamicToolCall = readAutomationInspectionDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (dynamicToolCall?.namespace === "pwragent_automations") {
      if (!this.isLiveDynamicToolCall(backend, dynamicToolCall)) {
        backendRegistryLog.warn("rejecting automation inspection dynamic tool call", {
          backend,
          callId: dynamicToolCall.callId,
          namespace: dynamicToolCall.namespace,
          threadId: dynamicToolCall.threadId,
          tool: dynamicToolCall.tool,
          turnId: dynamicToolCall.turnId,
        });
        return buildAutomationInspectionDynamicToolErrorResponse({
          code: "forbidden",
          message:
            "Automation inspection tool calls must originate from an active turn on the same thread.",
        });
      }
      backendRegistryLog.info("handling automation inspection dynamic tool call", {
        backend,
        callId: dynamicToolCall.callId,
        namespace: dynamicToolCall.namespace,
        threadId: dynamicToolCall.threadId,
        tool: dynamicToolCall.tool,
        turnId: dynamicToolCall.turnId,
      });
      return await handleAutomationInspectionDynamicToolCall({
        backend,
        call: dynamicToolCall,
        handler: this.automationInspectionHandler,
      });
    }
    const threadToolCall = readPwrAgentThreadDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (threadToolCall?.namespace === PWRAGENT_THREAD_TOOL_NAMESPACE) {
      if (!this.isLiveDynamicToolCall(backend, threadToolCall)) {
        backendRegistryLog.warn("rejecting thread inspection dynamic tool call", {
          backend,
          callId: threadToolCall.callId,
          namespace: threadToolCall.namespace,
          threadId: threadToolCall.threadId,
          tool: threadToolCall.tool,
          turnId: threadToolCall.turnId,
        });
        return buildPwrAgentThreadDynamicToolErrorResponse({
          code: "forbidden",
          message:
            "Thread inspection tool calls must originate from an active turn on the same thread.",
        });
      }
      backendRegistryLog.info("handling thread inspection dynamic tool call", {
        backend,
        callId: threadToolCall.callId,
        namespace: threadToolCall.namespace,
        threadId: threadToolCall.threadId,
        tool: threadToolCall.tool,
        turnId: threadToolCall.turnId,
      });
      return await handlePwrAgentThreadDynamicToolCall({
        backend,
        call: threadToolCall,
        handler: this.threadInspectionHandler,
      });
    }
    const messagingToolCall = readPwrAgentMessagingDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (messagingToolCall?.namespace === PWRAGENT_MESSAGING_TOOL_NAMESPACE) {
      if (!this.isLiveDynamicToolCall(backend, messagingToolCall)) {
        backendRegistryLog.warn("rejecting messaging context dynamic tool call", {
          backend,
          callId: messagingToolCall.callId,
          namespace: messagingToolCall.namespace,
          threadId: messagingToolCall.threadId,
          tool: messagingToolCall.tool,
          turnId: messagingToolCall.turnId,
        });
        return buildPwrAgentMessagingDynamicToolErrorResponse({
          code: "forbidden",
          message:
            "Messaging context tool calls must originate from an active turn on the same Agent thread.",
        });
      }
      backendRegistryLog.info("handling messaging context dynamic tool call", {
        backend,
        callId: messagingToolCall.callId,
        namespace: messagingToolCall.namespace,
        threadId: messagingToolCall.threadId,
        tool: messagingToolCall.tool,
        turnId: messagingToolCall.turnId,
      });
      return await handlePwrAgentMessagingDynamicToolCall({
        backend,
        call: messagingToolCall,
        handler: this.messagingHandler,
      });
    }

    const taskMonitorToolCall = readTaskMonitorDynamicToolCall({
      method: request.method,
      params: request.params,
    });
    if (taskMonitorToolCall?.namespace === TASK_MONITOR_TOOL_NAMESPACE) {
      if (backend !== "codex") {
        return buildTaskMonitorDynamicToolErrorResponse({
          code: "forbidden",
          message: "Task monitor dynamic tools are only available for Codex threads.",
        });
      }
      const requiresActiveTurn =
        taskMonitorToolCall.tool === "create_monitor_delegation";
      if (
        requiresActiveTurn &&
        !this.isLiveDynamicToolCall(backend, taskMonitorToolCall)
      ) {
        backendRegistryLog.warn("rejecting task monitor dynamic tool call", {
          backend,
          callId: taskMonitorToolCall.callId,
          namespace: taskMonitorToolCall.namespace,
          threadId: taskMonitorToolCall.threadId,
          tool: taskMonitorToolCall.tool,
          turnId: taskMonitorToolCall.turnId,
        });
        return buildTaskMonitorDynamicToolErrorResponse({
          code: "forbidden",
          message:
            "Task monitor delegations must originate from an active Codex turn.",
        });
      }
      backendRegistryLog.debug("handling task monitor dynamic tool call", {
        backend,
        callId: taskMonitorToolCall.callId,
        namespace: taskMonitorToolCall.namespace,
        threadId: taskMonitorToolCall.threadId,
        tool: taskMonitorToolCall.tool,
        turnId: taskMonitorToolCall.turnId,
      });
      return await handleTaskMonitorDynamicToolCall({
        backend,
        call: taskMonitorToolCall,
        handler: async (monitorRequest) =>
          await this.handleTaskMonitorRequest(monitorRequest),
      });
    }

    const headlessAutomation = this.findHeadlessAutomationTurnForRequest(
      backend,
      request,
    );
    if (headlessAutomation) {
      backendRegistryLog.warn("auto-cancelling headless automation server request", {
        agentThreadId: headlessAutomation.agentThreadId,
        automationName: headlessAutomation.automationName,
        automationRunId: headlessAutomation.automationRunId,
        backend,
        executionMode: headlessAutomation.executionMode,
        method: request.method,
        queueEntryId: headlessAutomation.queueEntryId,
        requestId: request.params.requestId,
        threadId: request.params.threadId,
        turnId: request.params.turnId,
      });
      return buildHeadlessAutomationRequestCancelResponse(request);
    }

    const key = buildPendingRequestKey({
      backend,
      threadId: request.params.threadId,
      requestId: request.params.requestId,
    });

    return await new Promise<SubmitServerRequestRequest["response"]>((resolve, reject) => {
      this.pendingServerRequests.set(key, { resolve, reject });

      void this.emit({
        backend,
        notification: request as AppServerNotification,
      }).catch((error) => {
        backendRegistryLog.error(
          "failed to publish pending server request; keeping request pending",
          {
            backend,
            error: error instanceof Error ? error.message : String(error),
            requestId: request.params.requestId,
            threadId: request.params.threadId,
            turnId: request.params.turnId,
          },
        );
      });
    });
  }

  private isLiveDynamicToolCall(
    backend: AppServerBackendKind,
    call: { threadId: string; turnId?: string },
  ): boolean {
    const turnId = call.turnId?.trim();
    if (!turnId) return false;
    return this.activeTurnKeys.has(buildActiveTurnKey(backend, call.threadId, turnId));
  }

  private async handleTaskMonitorRequest(
    request: TaskMonitorRequest,
  ): Promise<TaskMonitorResponse> {
    if (request.operation === "create_monitor_delegation") {
      return await this.createTaskMonitorDelegation(
        request.context,
        request.args as CreateMonitorDelegationToolArgs,
      );
    }
    if (request.operation === "inject_progress") {
      return await this.injectTaskMonitorProgress(
        request.context.threadId,
        request.args as InjectMonitorProgressToolArgs,
      );
    }
    return await this.completeTaskMonitoring(
      request.context.threadId,
      request.args as CompleteMonitoringToolArgs,
    );
  }

  private async createTaskMonitorDelegation(
    context: TaskMonitorRequest<"create_monitor_delegation">["context"],
    args: CreateMonitorDelegationToolArgs,
  ): Promise<TaskMonitorResponse<"create_monitor_delegation">> {
    const parentThreadId = context.threadId;
    const task = args.task?.trim();
    if (!task) {
      return taskMonitorFailure("create_monitor_delegation", "invalid_arguments", "task is required.");
    }
    const unsupportedSessionReference = findUnsupportedCodexExecSessionReference({
      task,
      monitorContext: args.monitorContext,
    });
    if (unsupportedSessionReference) {
      return taskMonitorFailure(
        "create_monitor_delegation",
        "invalid_arguments",
        [
          `Task monitor delegations cannot use a parent-scoped ${unsupportedSessionReference} as the local-command polling handle.`,
          "Keep polling that already-started Codex exec session in the parent turn, or create a fresh monitor delegation with the command text, cwd, terminal criteria, and desired stdout/stderr capture-file paths so the monitor child starts the command in its own session.",
        ].join(" "),
      );
    }

    const monitorId = `monitor-${randomUUID()}`;
    const pollIntervalSeconds =
      normalizePollIntervalSeconds(args.pollIntervalSeconds) ??
      DEFAULT_TASK_MONITOR_POLL_INTERVAL_SECONDS;
    const heartbeatIntervalSeconds = pollIntervalSeconds;
    const requestedModel = normalizePreferredMonitorModel(args.preferredModel);
    const requestedReasoningEffort = normalizePreferredMonitorReasoningEffort(
      args.preferredReasoningEffort,
    );
    const { preferredModel, preferredReasoningEffort } =
      await this.resolveTaskMonitorModelSettings({
        preferredModel: requestedModel,
        preferredReasoningEffort: requestedReasoningEffort,
      });
    const startupTimeoutSeconds = DEFAULT_TASK_MONITOR_STARTUP_TIMEOUT_SECONDS;
    const parentAgentGuidance = buildMonitorParentAgentGuidance({
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      startupTimeoutSeconds,
    });
    const prompt = buildMonitorDelegationPrompt({
      finalHandoffPrompt: args.finalHandoffPrompt,
      monitorContext: args.monitorContext,
      monitorId,
      parentThreadId,
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      task,
    });
    if (
      preferredModel !== requestedModel ||
      preferredReasoningEffort !== requestedReasoningEffort
    ) {
      backendRegistryLog.info("adjusted task monitor model settings", {
        monitorId,
        parentThreadId,
        preferredModel,
        preferredReasoningEffort,
        requestedModel,
        requestedReasoningEffort,
      });
    }
    const record: TaskMonitorDelegationRecord = {
      activeCommandCount: 0,
      backend: "codex",
      createdAt: Date.now(),
      finalHandoffPrompt: args.finalHandoffPrompt?.trim() || undefined,
      heartbeatIntervalSeconds,
      lastActivityAt: Date.now(),
      monitorId,
      parentThreadId,
      pollIntervalSeconds,
      preferredModel,
      preferredReasoningEffort,
      startupTimeoutSeconds,
      task,
    };
    this.taskMonitorDelegations.set(monitorId, record);
    backendRegistryLog.info("created task monitor delegation", {
      heartbeatIntervalSeconds,
      monitorId,
      parentThreadId,
      pollIntervalSeconds,
      startupTimeoutSeconds,
    });

    let startedMonitor: {
      cwd?: string;
      executionMode: ThreadExecutionMode;
      threadId: string;
      turnId: string;
    };
    try {
      startedMonitor = await this.startManagedTaskMonitor({
        context,
        cwd: args.cwd,
        monitorId,
        preferredModel,
        preferredReasoningEffort,
        prompt,
      });
    } catch (error) {
      this.taskMonitorDelegations.delete(monitorId);
      backendRegistryLog.error("failed to start managed task monitor", {
        error: error instanceof Error ? error.message : String(error),
        monitorId,
        parentThreadId,
      });
      return taskMonitorFailure(
        "create_monitor_delegation",
        "internal_error",
        `Failed to start managed task monitor: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    record.cwd = startedMonitor.cwd;
    record.executionMode = startedMonitor.executionMode;
    record.lastActivityAt = Date.now();
    record.monitorThreadId = startedMonitor.threadId;
    record.monitorTurnId = startedMonitor.turnId;
    await this.persistTaskMonitorSubAgent(record, { status: "running" });

    return {
      ok: true,
      operation: "create_monitor_delegation",
      data: {
        monitorId,
        parentThreadId,
        preferredModel,
        preferredReasoningEffort,
        pollIntervalSeconds,
        heartbeatIntervalSeconds,
        startupTimeoutSeconds,
        startedByPwrAgent: true,
        monitorThreadId: startedMonitor.threadId,
        monitorTurnId: startedMonitor.turnId,
        parentAgentGuidance,
        prompt,
      },
    };
  }

  private async resolveTaskMonitorModelSettings(params: {
    preferredModel?: string;
    preferredReasoningEffort?: string;
  }): Promise<{ preferredModel: string; preferredReasoningEffort: string }> {
    const requestedModel = normalizePreferredMonitorModel(params.preferredModel);
    const requestedReasoningEffort = normalizePreferredMonitorReasoningEffort(
      params.preferredReasoningEffort,
    );
    const discoveredModels = await this.readCodexDefaultModelsOnce("task-monitor");
    const options = buildLaunchpadOptions("codex", discoveredModels, {
      allowFallbackModels: false,
    });
    const models = options?.models ?? [];
    const selectedModel =
      models.find((model) => model.id === requestedModel) ??
      models.find((model) => model.id === DEFAULT_TASK_MONITOR_MODEL) ??
      models.find((model) => model.id.toLowerCase().includes("mini")) ??
      models.find((model) => model.current) ??
      models.find((model) => model.supportsReasoning) ??
      models[0];
    if (!selectedModel) {
      throw new Error(
        "No available Codex models were discovered for task monitor delegation.",
      );
    }

    const preferredModel = selectedModel.id;
    const reasoningEfforts = options?.reasoningEfforts ?? OPENAI_REASONING_EFFORTS;
    const preferredReasoningEffort = reasoningEfforts.includes(
      requestedReasoningEffort,
    )
      ? requestedReasoningEffort
      : reasoningEfforts.includes(DEFAULT_TASK_MONITOR_REASONING_EFFORT)
        ? DEFAULT_TASK_MONITOR_REASONING_EFFORT
        : (reasoningEfforts[0] ?? DEFAULT_TASK_MONITOR_REASONING_EFFORT);

    return {
      preferredModel,
      preferredReasoningEffort,
    };
  }

  private async startManagedTaskMonitor(params: {
    context: TaskMonitorRequest<"create_monitor_delegation">["context"];
    cwd?: string;
    monitorId: string;
    preferredModel: string;
    preferredReasoningEffort: string;
    prompt: string;
  }): Promise<{
    cwd?: string;
    executionMode: ThreadExecutionMode;
    threadId: string;
    turnId: string;
  }> {
    const executionMode =
      this.activeCodexTurnModes.get(
        buildActiveTurnModeKey(params.context.threadId, params.context.turnId),
      ) ??
      (await this.resolveCodexThreadExecutionModeForActiveTurn(
        params.context.threadId,
      ));
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.context.threadId,
    });
    const cwd =
      params.cwd?.trim() ||
      (await this.resolveThreadEnvironmentCwd(
        "codex",
        params.context.threadId,
        overlay,
      ));
    const client = this.getClient("codex", executionMode);
    const dynamicTools = buildTaskMonitorDynamicToolSpecs("monitor");

    backendRegistryLog.info("starting managed task monitor thread", {
      cwd: cwd ?? null,
      executionMode,
      hasCodexEnvironmentRuntime: Boolean(overlay?.codexEnvironmentRuntime),
      shellEnvironmentKeyCount: overlay?.codexEnvironmentRuntime?.shellEnvironment
        ? Object.keys(overlay.codexEnvironmentRuntime.shellEnvironment).length
        : 0,
      monitorId: params.monitorId,
      model: params.preferredModel,
      parentThreadId: params.context.threadId,
      reasoningEffort: params.preferredReasoningEffort,
      toolCount: dynamicTools.length,
    });

    const thread = await client.startThread({
      ...(cwd ? { cwd } : {}),
      approvalPolicy: modeSettings.approvalPolicy,
      dynamicTools,
      ephemeral: true,
      model: params.preferredModel,
      reasoningEffort: params.preferredReasoningEffort,
      sandbox: modeSettings.sandbox,
      ...(overlay?.codexEnvironmentRuntime
        ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
        : {}),
    });
    this.reservedCodexStartThreadIds.add(thread.threadId);
    let turn: { threadId: string; turnId: string };
    try {
      turn = await client.startTurn({
        threadId: thread.threadId,
        input: [{ type: "text", text: params.prompt }],
        ...(cwd ? { cwd } : {}),
        approvalPolicy: modeSettings.approvalPolicy,
        model: params.preferredModel,
        reasoningEffort: params.preferredReasoningEffort,
        sandbox: modeSettings.sandbox,
        ...(overlay?.codexEnvironmentRuntime
          ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
          : {}),
      });
      this.activeTurnKeys.add(
        buildActiveTurnKey("codex", turn.threadId, turn.turnId),
      );
      this.activeCodexTurnModes.set(
        buildActiveTurnModeKey(turn.threadId, turn.turnId),
        executionMode,
      );
    } finally {
      this.reservedCodexStartThreadIds.delete(thread.threadId);
    }

    backendRegistryLog.info("managed task monitor turn started", {
      executionMode,
      hasCodexEnvironmentRuntime: Boolean(overlay?.codexEnvironmentRuntime),
      monitorId: params.monitorId,
      monitorThreadId: turn.threadId,
      monitorTurnId: turn.turnId,
      parentThreadId: params.context.threadId,
    });

    return {
      cwd,
      executionMode,
      threadId: turn.threadId,
      turnId: turn.turnId,
    };
  }

  private async injectTaskMonitorProgress(
    callerThreadId: string,
    args: InjectMonitorProgressToolArgs,
  ): Promise<TaskMonitorResponse<"inject_progress">> {
    const bound = this.bindTaskMonitorCaller(args.monitorId, callerThreadId);
    if (!bound.ok) {
      return taskMonitorFailure("inject_progress", bound.code, bound.message);
    }
    const message = args.message?.trim();
    if (!message) {
      return taskMonitorFailure("inject_progress", "invalid_arguments", "message is required.");
    }

    bound.record.lastActivityAt = Date.now();
    await this.persistTaskMonitorSubAgent(bound.record, {
      lastMessage: message,
      status: args.status ?? "running",
    });
    await this.emitTaskMonitorProgressMessage({
      monitorId: bound.record.monitorId,
      parentThreadId: bound.record.parentThreadId,
      text: formatTaskMonitorProgressMessage({
        message,
        status: args.status,
        task: bound.record.task,
      }),
      usage: bound.record.latestUsage,
    });

    return {
      ok: true,
      operation: "inject_progress",
      data: {
        monitorId: bound.record.monitorId,
        parentThreadId: bound.record.parentThreadId,
        injected: true,
        ...(bound.record.latestUsage
          ? { monitorUsage: bound.record.latestUsage }
          : {}),
      },
    };
  }

  private async completeTaskMonitoring(
    callerThreadId: string,
    args: CompleteMonitoringToolArgs,
  ): Promise<TaskMonitorResponse<"complete_monitoring">> {
    const bound = this.bindTaskMonitorCaller(args.monitorId, callerThreadId);
    if (!bound.ok) {
      return taskMonitorFailure("complete_monitoring", bound.code, bound.message);
    }
    const summary = args.summary?.trim();
    if (!summary) {
      return taskMonitorFailure("complete_monitoring", "invalid_arguments", "summary is required.");
    }

    bound.record.lastActivityAt = Date.now();
    const parentTurn = await this.finishTaskMonitorDelegation({
      completionSource: { type: "monitor_tool" },
      details: args.details,
      outcome: args.outcome,
      record: bound.record,
      summary,
      triggerParentTurn: args.triggerParentTurn !== false,
    });

    return {
      ok: true,
      operation: "complete_monitoring",
      data: {
        monitorId: bound.record.monitorId,
        parentThreadId: bound.record.parentThreadId,
        injected: true,
        outcome: args.outcome,
        completionSource: { type: "monitor_tool" },
        ...(bound.record.latestUsage
          ? { monitorUsage: bound.record.latestUsage }
          : {}),
        ...(parentTurn ? { parentTurn } : {}),
      },
    };
  }

  private async finishTaskMonitorDelegation(params: {
    completionSource: TaskMonitorCompletionSource;
    details?: string;
    outcome: CompleteMonitoringToolArgs["outcome"];
    record: TaskMonitorDelegationRecord;
    summary: string;
    triggerParentTurn: boolean;
  }): Promise<
    | {
        status: "started" | "queued";
        turnId?: string;
        queueEntryId?: string;
        position?: number;
      }
    | undefined
  > {
    const finalText = formatTaskMonitorCompletionMessage({
      completionSource: params.completionSource,
      details: params.details,
      outcome: params.outcome,
      summary: params.summary,
      task: params.record.task,
    });
    await this.persistTaskMonitorSubAgent(params.record, {
      completedAt: Date.now(),
      completionSource: params.completionSource,
      lastMessage: params.summary,
      monitorUsage: params.record.latestUsage,
      outcome: params.outcome,
      status: params.outcome,
    });
    await this.injectCodexMonitorMessage({
      parentThreadId: params.record.parentThreadId,
      text: finalText,
    });
    if (params.record.latestUsage) {
      await this.emitTaskMonitorUsageActivity({
        monitorId: params.record.monitorId,
        parentThreadId: params.record.parentThreadId,
        phase: "completion",
        usage: params.record.latestUsage,
      });
    }
    await this.emitTaskMonitorCompletionState({
      completionSource: params.completionSource,
      monitorId: params.record.monitorId,
      outcome: params.outcome,
      parentThreadId: params.record.parentThreadId,
    });

    let parentTurn:
      | {
          status: "started" | "queued";
          turnId?: string;
          queueEntryId?: string;
          position?: number;
        }
      | undefined;
    if (params.triggerParentTurn) {
      const submitted = await this.submitTurn({
        backend: "codex",
        threadId: params.record.parentThreadId,
        input: [
          {
            type: "text",
            text: buildTaskMonitorFinalHandoffInput({
              completionSource: params.completionSource,
              details: params.details,
              finalHandoffPrompt: params.record.finalHandoffPrompt,
              outcome: params.outcome,
              summary: params.summary,
              task: params.record.task,
            }),
          },
        ],
        origin: "manual",
      });
      parentTurn =
        submitted.status === "started"
          ? {
              status: "started",
              turnId: submitted.turnId,
              queueEntryId: submitted.entry.id,
            }
          : {
              status: "queued",
              queueEntryId: submitted.entry.id,
              position: submitted.position,
            };
    }

    this.taskMonitorDelegations.delete(params.record.monitorId);
    return parentTurn;
  }

  private async handleTaskMonitorTerminalNotification(
    notification: Extract<
      AppServerNotification,
      { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
    >,
  ): Promise<void> {
    const threadId = notification.params.threadId;
    const turnId = turnIdFromTerminalNotification(notification);
    const terminalStatus =
      notification.method === "turn/completed"
        ? "completed"
        : notification.method === "turn/failed"
          ? "failed"
          : "cancelled";
    const record = Array.from(this.taskMonitorDelegations.values()).find(
      (candidate) =>
        candidate.monitorThreadId === threadId &&
        (!candidate.monitorTurnId || !turnId || candidate.monitorTurnId === turnId),
    );
    if (!record) {
      return;
    }

    if (!record.recoveryAttempted) {
      await this.startTaskMonitorRecoveryTurn({
        record,
        terminalStatus,
      });
      return;
    }

    await this.synthesizeTaskMonitorFallbackCompletion({
      record,
      reason: "monitor_recovery_turn_ended_without_completion",
      terminalStatus,
    });
  }

  private async checkStaleTaskMonitors(now = Date.now()): Promise<void> {
    for (const record of Array.from(this.taskMonitorDelegations.values())) {
      if (!record.monitorThreadId || !record.monitorTurnId) {
        continue;
      }
      if (record.activeCommandCount > 0) {
        continue;
      }

      const staleAfterMs =
        Math.max(
          record.heartbeatIntervalSeconds * 2,
          record.pollIntervalSeconds * 2,
          record.startupTimeoutSeconds,
        ) *
          1000 +
        TASK_MONITOR_STALE_GRACE_MS;
      const idleMs = now - record.lastActivityAt;
      if (idleMs < staleAfterMs) {
        continue;
      }

      if (record.recoveryAttempted) {
        await this.synthesizeTaskMonitorFallbackCompletion({
          record,
          reason: "monitor_recovery_turn_stale_without_completion",
        });
        continue;
      }

      if (record.staleInterruptAttempted) {
        await this.synthesizeTaskMonitorFallbackCompletion({
          record,
          reason: "monitor_stale_interrupt_no_terminal",
        });
        continue;
      }

      await this.interruptStaleTaskMonitor(record, idleMs);
    }
  }

  private async interruptStaleTaskMonitor(
    record: TaskMonitorDelegationRecord,
    idleMs: number,
  ): Promise<void> {
    if (!record.monitorThreadId || !record.monitorTurnId) {
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_thread_missing_for_stale_recovery",
      });
      return;
    }

    record.lastActivityAt = Date.now();
    record.staleInterruptAttempted = true;
    backendRegistryLog.warn("task monitor stale; interrupting for recovery", {
      idleMs,
      monitorId: record.monitorId,
      monitorThreadId: record.monitorThreadId,
      monitorTurnId: record.monitorTurnId,
      parentThreadId: record.parentThreadId,
    });

    try {
      const executionMode = record.executionMode ?? "default";
      await this.getClient("codex", executionMode).interruptTurn({
        threadId: record.monitorThreadId,
        turnId: record.monitorTurnId,
      });
    } catch (error) {
      backendRegistryLog.error("failed to interrupt stale task monitor", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
      });
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_stale_interrupt_failed",
      });
    }
  }

  private async startTaskMonitorRecoveryTurn(params: {
    record: TaskMonitorDelegationRecord;
    terminalStatus: "completed" | "failed" | "cancelled";
  }): Promise<void> {
    const { record } = params;
    if (!record.monitorThreadId) {
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_thread_missing_for_recovery",
        terminalStatus: params.terminalStatus,
      });
      return;
    }

    record.recoveryAttempted = true;
    record.activeCommandCount = 0;
    record.lastActivityAt = Date.now();
    record.staleInterruptAttempted = false;
    const executionMode = record.executionMode ?? "default";
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const client = this.getClient("codex", executionMode);
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: record.parentThreadId,
    });

    try {
      const turn = await client.startTurn({
        threadId: record.monitorThreadId,
        input: [
          {
            type: "text",
            text: buildTaskMonitorRecoveryPrompt({
              monitorId: record.monitorId,
              task: record.task,
              terminalStatus: params.terminalStatus,
            }),
          },
        ],
        ...(record.cwd ? { cwd: record.cwd } : {}),
        approvalPolicy: modeSettings.approvalPolicy,
        model: record.preferredModel,
        reasoningEffort: record.preferredReasoningEffort,
        sandbox: modeSettings.sandbox,
        ...(overlay?.codexEnvironmentRuntime
          ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
          : {}),
      });
      record.monitorTurnId = turn.turnId;
      record.lastActivityAt = Date.now();
      backendRegistryLog.warn("started task monitor recovery turn", {
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        monitorTurnId: record.monitorTurnId,
        parentThreadId: record.parentThreadId,
        terminalStatus: params.terminalStatus,
      });
    } catch (error) {
      backendRegistryLog.error("failed to start task monitor recovery turn", {
        error: error instanceof Error ? error.message : String(error),
        monitorId: record.monitorId,
        monitorThreadId: record.monitorThreadId,
        parentThreadId: record.parentThreadId,
      });
      await this.synthesizeTaskMonitorFallbackCompletion({
        record,
        reason: "monitor_recovery_turn_start_failed",
        terminalStatus: params.terminalStatus,
      });
    }
  }

  private async synthesizeTaskMonitorFallbackCompletion(params: {
    record: TaskMonitorDelegationRecord;
    reason: string;
    terminalStatus?: "completed" | "failed" | "cancelled";
  }): Promise<void> {
    const completionSource: TaskMonitorCompletionSource = {
      type: "pwragent_fallback",
      reason: params.reason,
      recoveryAttempted: Boolean(params.record.recoveryAttempted),
      ...(params.terminalStatus ? { terminalStatus: params.terminalStatus } : {}),
    };
    const outcome =
      params.terminalStatus === "cancelled" ? "cancelled" : "failure";
    await this.finishTaskMonitorDelegation({
      completionSource,
      details: [
        "PwrAgent generated this fallback because the monitor subagent stopped without invoking pwragent_task_monitors.complete_monitoring.",
        `Fallback reason: ${params.reason}.`,
        params.terminalStatus
          ? `Last monitor turn status: ${params.terminalStatus}.`
          : "No terminal monitor turn status was observed.",
      ].join("\n"),
      outcome,
      record: params.record,
      summary:
        "Monitor subagent stopped without reporting a final result through the required completion tool.",
      triggerParentTurn: true,
    });
  }

  private bindTaskMonitorCaller(
    monitorId: string,
    callerThreadId: string,
  ):
    | { ok: true; record: TaskMonitorDelegationRecord }
    | { ok: false; code: "forbidden" | "invalid_arguments" | "not_found"; message: string } {
    const normalizedMonitorId = monitorId?.trim();
    if (!normalizedMonitorId) {
      return { ok: false, code: "invalid_arguments", message: "monitorId is required." };
    }
    const record = this.taskMonitorDelegations.get(normalizedMonitorId);
    if (!record) {
      return { ok: false, code: "not_found", message: "Unknown or completed monitorId." };
    }
    if (record.monitorThreadId && record.monitorThreadId !== callerThreadId) {
      return {
        ok: false,
        code: "forbidden",
        message: "This monitorId is already bound to another monitor thread.",
      };
    }
    if (!record.monitorThreadId) {
      record.monitorThreadId = callerThreadId;
    }
    return { ok: true, record };
  }

  private async emitTaskMonitorProgressMessage(params: {
    monitorId: string;
    parentThreadId: string;
    text: string;
    usage?: TaskMonitorUsageSnapshot;
  }): Promise<void> {
    const now = Date.now();
    await this.emit({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:progress:${now}`,
            type: "agentMessage",
            text: params.text,
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              ...(params.usage
                ? {
                    monitorUsage: {
                      ...params.usage,
                      phase: "progress",
                    },
                  }
                : {}),
              transient: true,
            },
          },
        },
      },
    });
  }

  private async emitTaskMonitorUsageActivity(params: {
    monitorId: string;
    parentThreadId: string;
    phase: "completion" | "progress";
    usage: TaskMonitorUsageSnapshot;
  }): Promise<void> {
    const now = Date.now();
    await this.emit({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:usage:${params.phase}:${now}`,
            type: "taskMonitorUsage",
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              monitorUsage: {
                ...params.usage,
                phase: params.phase,
              },
              transient: params.phase !== "completion",
            },
          },
        },
      },
    });
  }

  private async emitTaskMonitorCompletionState(params: {
    completionSource: TaskMonitorCompletionSource;
    monitorId: string;
    outcome: CompleteMonitoringToolArgs["outcome"];
    parentThreadId: string;
  }): Promise<void> {
    const now = Date.now();
    await this.emit({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: params.parentThreadId,
          turnId: `monitor:${params.monitorId}`,
          item: {
            id: `${params.monitorId}:completion:${now}`,
            type: "taskMonitorCompletion",
            data: {
              source: "pwragent_task_monitor",
              monitorId: params.monitorId,
              outcome: params.outcome,
              completionSource: params.completionSource,
              fallbackGenerated:
                params.completionSource.type === "pwragent_fallback",
              transient: false,
            },
          },
        },
      },
    });
  }

  private async injectCodexMonitorMessage(params: {
    parentThreadId: string;
    text: string;
  }): Promise<void> {
    await this.withCodexThreadClient(params.parentThreadId, async (client) => {
      if (!client.injectThreadItems) {
        throw new Error("Codex thread item injection is not available.");
      }
      await client.injectThreadItems({
        threadId: params.parentThreadId,
        items: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: params.text }],
          },
        ],
      });
    });
  }

  private async handleThreadInspectionRequest(
    request: PwrAgentThreadInspectionRequest,
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (request.operation === "search_threads") {
      const backend = readThreadInspectionBackend(request.args.backend);
      if (request.args.backend !== undefined && !backend) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "backend must be all or a known PwrAgent backend.",
          },
        };
      }
      const hasQuery = Boolean(request.args.query?.trim());
      if (
        request.args.contentMode !== undefined &&
        !isThreadSearchContentMode(request.args.contentMode)
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "contentMode must be metadata, available, or required.",
          },
        };
      }
      if (
        request.args.semanticMode !== undefined &&
        !isThreadSearchSemanticMode(request.args.semanticMode)
      ) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "semanticMode must be disabled, available, or required.",
          },
        };
      }
      const limit = clampInteger(
        request.args.limit,
        hasQuery
          ? DEFAULT_THREAD_INSPECTION_SEARCH_LIMIT
          : DEFAULT_THREAD_INSPECTION_RECENT_LIMIT,
        MAX_THREAD_INSPECTION_SEARCH_LIMIT,
      );
      const searchService = this.getThreadInspectionSearchService();
      if (searchService) {
        const projectKeys = nonEmptyStringArray(request.args.projectKeys);
        const directoryPaths = nonEmptyStringArray(request.args.directoryPaths);
        const models = nonEmptyStringArray(request.args.models);
        const filters: ThreadSearchFilters = {
          ...(backend ? { backend } : {}),
          includeArchived: request.args.includeArchived === true,
          ...(projectKeys ? { projectKeys } : {}),
          ...(directoryPaths ? { directoryPaths } : {}),
          ...(models ? { models } : {}),
          ...buildThreadInspectionDateRange({
            updatedAfter: request.args.updatedAfter,
            updatedBefore: request.args.updatedBefore,
          }),
        };
        const searchLimit =
          request.args.agentOnly === true
            ? MAX_THREAD_INSPECTION_SEARCH_LIMIT
            : limit;
        const response = await searchService.search({
          ...(request.args.query !== undefined ? { query: request.args.query } : {}),
          filters,
          limit: searchLimit,
          ...(request.args.contentMode
            ? { contentMode: request.args.contentMode }
            : {}),
          ...(request.args.semanticMode
            ? { semanticMode: request.args.semanticMode }
            : {}),
        });
        const enriched = await this.enrichThreadSearchResults(response.results);
        const filtered =
          request.args.agentOnly === true
            ? enriched.filter((thread) => Boolean(thread.agent))
            : enriched;
        const threads = filtered
          .slice(0, limit)
          .map(toThreadInspectionSearchSummary);
        return {
          ok: true,
          data: {
            threads,
            totalCount: filtered.length,
            limit,
            truncated: response.truncated === true || filtered.length > limit,
            query: response.query,
            searchedScopes: response.searchedScopes,
            unavailableScopes: response.unavailableScopes,
            contentMode: response.contentMode,
            semanticMode: response.semanticMode,
          },
        };
      }
      const listBackend = backend === "all" ? undefined : backend;
      const activeThreads = await this.listThreads({
        backend: listBackend,
        archived: false,
        callerReason: "agent-thread-inspection",
      });
      const threads =
        request.args.includeArchived === true
          ? dedupeThreadInspectionThreadSummaries([
              ...activeThreads,
              ...(await this.listThreads({
                backend: listBackend,
                archived: true,
                callerReason: "agent-thread-inspection:archived",
              })),
            ])
          : activeThreads;
      const enriched = await this.enrichThreadInspectionSummaries(threads);
      const filtered = filterThreadInspectionSummaries(enriched, {
        agentOnly: request.args.agentOnly === true,
        query: request.args.query,
      });
      return {
        ok: true,
        data: {
          threads: filtered.slice(0, limit).map(toThreadInspectionSearchSummary),
          totalCount: filtered.length,
          limit,
          truncated: filtered.length > limit,
        },
      };
    }

    if (request.operation === "get_thread_status") {
      if (!isAppServerBackendKind(request.args.backend)) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "backend must be a known PwrAgent backend.",
          },
        };
      }
      const threadId = request.args.threadId?.trim();
      if (!threadId) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "threadId is required.",
          },
        };
      }
      const activeThreads = await this.listThreads({
        backend: request.args.backend,
        archived: false,
        callerReason: "agent-thread-inspection",
      });
      let candidateThreads = activeThreads.filter((thread) => thread.id === threadId);
      if (candidateThreads.length === 0) {
        candidateThreads = (
          await this.listThreads({
            backend: request.args.backend,
            archived: true,
            callerReason: "agent-thread-inspection:archived",
          })
        ).filter((thread) => thread.id === threadId);
      }
      const [summary] = await this.enrichThreadInspectionSummaries(candidateThreads);
      if (!summary) {
        return {
          ok: false,
          error: {
            code: "not_found",
            message: `Thread ${request.args.backend}:${threadId} was not found.`,
          },
        };
      }
      const status = await this.readThread({
        backend: request.args.backend,
        limit: 0,
        threadId,
      })
        .then((response) => response.threadStatus ?? response.replay.threadStatus)
        .catch((): AppServerThreadStatus | undefined => undefined);
      const queueKey = buildThreadIdentityKey(request.args.backend, threadId);
      const queued = this.getQueuedExecutionModesSnapshot()[queueKey];
      return {
        ok: true,
        data: {
          thread: {
            ...summary,
            status,
            queuedExecutionMode: queued?.mode,
            queuedExecutionModeAt: queued?.queuedAt,
          },
        },
      };
    }

    return {
      ok: false,
      error: {
        code: "unsupported_operation",
        message: "Unsupported PwrAgent thread inspection operation.",
      },
    };
  }

  private getThreadInspectionSearchService(): ThreadSearchService | null {
    if (this.threadInspectionSearchService !== undefined) {
      return this.threadInspectionSearchService;
    }
    this.threadInspectionSearchService = new ThreadSearchService(
      new ThreadSearchStore(getAppStateDb()),
      async ({ backend, archived }) =>
        await this.listThreads({
          backend,
          archived,
          callerReason: "agent-thread-inspection-search",
          enrichDirectories: true,
        }),
      new ProviderTranscriptThreadSearchAdapter(
        async ({ backend, threadId, limit }) =>
          await this.readThread({
            backend,
            threadId,
            limit,
          }),
      ),
    );
    return this.threadInspectionSearchService;
  }

  private async enrichThreadSearchResults(
    results: ThreadSearchResult[],
  ): Promise<ThreadInspectionSummary[]> {
    return await Promise.all(
      results.map(async (result) => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: result.backend,
          threadId: result.threadId,
        });
        return toThreadInspectionSummaryFromSearchResult(result, overlay?.agent);
      }),
    );
  }

  private async enrichThreadInspectionSummaries(
    threads: AppServerThreadSummary[],
  ): Promise<ThreadInspectionSummary[]> {
    return await Promise.all(
      threads.map(async (thread) => {
        const overlay = await this.overlayStore.getThreadOverlayState({
          backend: thread.source,
          threadId: thread.id,
        });
        return toThreadInspectionSummary(thread, overlay?.agent);
      }),
    );
  }

  private notificationsEnabled(): boolean {
    try {
      return getDesktopSettingsService().resolveNotificationsEnabled();
    } catch (error) {
      if (!this.hasLoggedNotificationsEnabledError) {
        this.hasLoggedNotificationsEnabledError = true;
        backendRegistryLog.warn(
          "failed to read notificationsEnabled setting; suppressing notifications",
          {
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return false;
    }
  }

  private rememberThreadTitleFromEvent(event: AgentEvent): void {
    const method = event.notification.method;
    if (method === "thread/name/updated") {
      const params = event.notification.params as {
        threadId?: unknown;
        threadName?: unknown;
      };
      const threadId = params.threadId;
      const threadName = params.threadName;
      if (typeof threadId === "string" && typeof threadName === "string") {
        const trimmed = threadName.trim();
        if (trimmed) {
          this.notificationThreadTitles.set(
            `${event.backend}:${threadId}`,
            trimmed,
          );
        }
      }
      return;
    }
    if (method === "thread/started") {
      const params = event.notification.params as {
        threadId?: unknown;
        thread?: Record<string, unknown>;
      };
      const threadId = params.threadId;
      if (typeof threadId !== "string") {
        return;
      }
      this.rememberThreadNotificationContext(event.backend, threadId, params.thread);
    }
  }

  private rememberThreadNotificationContext(
    backend: AppServerBackendKind,
    threadId: string,
    thread: unknown,
  ): void {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) {
      return;
    }
    const record = thread as Record<string, unknown>;
    const candidate =
      (typeof record.title === "string" ? record.title : undefined) ??
      (typeof record.name === "string" ? record.name : undefined);
    const trimmed = candidate?.trim();
    const key = `${backend}:${threadId}`;
    if (trimmed) {
      this.notificationThreadTitles.set(key, trimmed);
    }
    const projectLabel = readNotificationProjectLabel(record);
    if (projectLabel) {
      this.notificationThreadProjectLabels.set(key, projectLabel);
    }
  }

  private notificationThreadContextLabel(
    backend: AppServerBackendKind,
    threadId: string,
  ): string | undefined {
    const key = `${backend}:${threadId}`;
    const projectLabel = this.notificationThreadProjectLabels.get(key);
    const threadTitle = this.notificationThreadTitles.get(key);
    if (projectLabel && threadTitle) {
      return `${projectLabel} > ${threadTitle}`;
    }
    return threadTitle ?? projectLabel;
  }

  private async notificationThreadContextLabelForTerminal(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<string | undefined> {
    const cached = this.notificationThreadContextLabel(backend, threadId);
    if (cached) {
      return cached;
    }
    try {
      const threads = await this.listThreads({
        backend,
        callerReason: "notification-context",
        enrichDirectories: true,
      });
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread) {
        this.rememberThreadNotificationContext(backend, threadId, thread);
        return this.notificationThreadContextLabel(backend, threadId);
      }
    } catch (error) {
      backendRegistryLog.debug("native terminal notification context lookup failed", {
        backend,
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
    }
    return undefined;
  }

  private notifyForAttentionRequired(event: AgentEvent): void {
    if (!ATTENTION_NOTIFICATION_METHODS.has(event.notification.method)) {
      return;
    }
    const params = event.notification.params as Record<string, unknown>;
    const requestId = params.requestId;
    const threadId = params.threadId;
    if (typeof requestId !== "string" || typeof threadId !== "string") {
      return;
    }
    const isQuestion =
      event.notification.method === "item/tool/requestUserInput";
    const title = isQuestion
      ? "PwrAgent question waiting"
      : "PwrAgent approval needed";
    const threadTitle = this.notificationThreadTitles.get(
      `${event.backend}:${threadId}`,
    );
    const approvalRequest = this.isApprovalAttentionNotification(event.notification)
      ? event.notification
      : undefined;
    const key = `${event.backend}:${threadId}:${requestId}`;
    if (approvalRequest) {
      const intent = buildApprovalIntent({
        createdAt: Date.now(),
        id: key,
        request: approvalRequest,
      });
      intent.requestContext = {
        backend: event.backend,
        method: approvalRequest.method,
        requestId,
        threadId,
        turnId:
          typeof approvalRequest.params.turnId === "string"
            ? approvalRequest.params.turnId
            : undefined,
      };
      try {
        getDesktopNotificationService().notifyApproval({
          enabled: this.notificationsEnabled(),
          key,
          intent,
          onShow: () => {
            requestShowThread({
              backend: event.backend,
              threadId,
            });
          },
          onDecision: (decision) => {
            void this.submitServerRequest({
              backend: event.backend,
              threadId,
              turnId:
                typeof approvalRequest.params.turnId === "string"
                  ? approvalRequest.params.turnId
                  : undefined,
              requestId,
              response: buildPendingRequestResponse(
                approvalRequest,
                pendingRequestDecisionFromMessagingApproval(decision),
              ),
            }).catch((error) => {
              backendRegistryLog.warn("native approval notification decision failed", {
                backend: event.backend,
                error: error instanceof Error ? error.message : String(error),
                requestId,
                threadId,
              });
            });
          },
        });
      } catch (error) {
        backendRegistryLog.warn("native approval notification failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          requestId,
          threadId,
        });
      }
      return;
    }
    const baseBody = isQuestion
      ? "waiting for your response"
      : "waiting for your approval";
    const body = threadTitle ? `${threadTitle} · ${baseBody}.` : `A turn ${baseBody}.`;
    try {
      getDesktopNotificationService().notifyAttention({
        enabled: this.notificationsEnabled(),
        key,
        title,
        body,
      });
    } catch (error) {
      backendRegistryLog.warn("native attention notification failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        requestId,
        threadId,
      });
    }
  }

  private isApprovalAttentionNotification(
    notification: AgentEvent["notification"],
  ): notification is AppServerPendingRequestNotification {
    return (
      notification.method === "turn/requestApproval" ||
      notification.method === "review/requestApproval" ||
      notification.method === "item/commandExecution/requestApproval" ||
      notification.method === "item/fileChange/requestApproval" ||
      notification.method === "item/permissions/requestApproval" ||
      notification.method === "applyPatchApproval" ||
      notification.method === "execCommandApproval"
    );
  }

  private async notifyForTerminalOutcome(event: AgentEvent): Promise<void> {
    if (event.notification.method === "turn/started") {
      const threadId = (event.notification.params as { threadId?: unknown })
        .threadId;
      if (typeof threadId !== "string") {
        return;
      }
      try {
        getDesktopNotificationService().clearAttentionKey(
          buildTerminalNotificationKey({
            backend: event.backend,
            threadId,
          }),
        );
      } catch (error) {
        backendRegistryLog.warn("native terminal notification cleanup failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          threadId,
        });
      }
      return;
    }
    if (
      event.notification.method !== "turn/completed" &&
      event.notification.method !== "turn/failed" &&
      event.notification.method !== "turn/cancelled"
    ) {
      return;
    }
    const status =
      event.notification.method === "turn/completed"
        ? "completed"
        : event.notification.method === "turn/failed"
          ? "failed"
          : "cancelled";
    const threadId = (event.notification.params as { threadId?: unknown })
      .threadId;
    const contextLabel =
      typeof threadId === "string"
        ? await this.notificationThreadContextLabelForTerminal(event.backend, threadId)
        : undefined;
    const body = contextLabel
      ? `${contextLabel} · turn ${status}.`
      : `A turn ${status}.`;
    try {
      getDesktopNotificationService().notifyTerminal({
        enabled: this.notificationsEnabled(),
        key:
          typeof threadId === "string"
            ? buildTerminalNotificationKey({
                backend: event.backend,
                threadId,
              })
            : undefined,
        title: `PwrAgent turn ${status}`,
        body,
        onShow:
          typeof threadId === "string"
            ? () => {
                requestShowThread({
                  backend: event.backend,
                  threadId,
                });
              }
            : undefined,
      });
    } catch (error) {
      backendRegistryLog.warn("native terminal notification failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
    }
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (event.backend === "codex") {
      this.recordTaskMonitorActivity(event.notification);
    }

    if (this.shouldInvalidateThreadListCacheForNotification(event.notification.method)) {
      this.invalidateThreadListCache(event.backend);
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "configWarning"
    ) {
      this.latestCodexConfigWarning = event;
    }

    if (event.notification.method === "turn/started") {
      const notification = event.notification as {
        params: {
          threadId: string;
          turnId?: string;
          turn: {
            id: string;
          };
        };
      };
      const turnId = turnIdFromStartedNotification(notification);
      this.activeTurnKeys.add(
        buildActiveTurnKey(event.backend, notification.params.threadId, turnId),
      );
      if (event.backend === "codex") {
        const key = buildActiveTurnModeKey(
          notification.params.threadId,
          turnId,
        );
        const activeReviewTurnKey = this.findActiveCodexReviewTurnKey(
          notification.params.threadId,
        );
        if (activeReviewTurnKey && activeReviewTurnKey !== key) {
          this.activeCodexReviewInterruptTurnIds.set(activeReviewTurnKey, turnId);
        }
        if (!this.activeCodexTurnModes.has(key)) {
          this.activeCodexTurnModes.set(
            key,
            await this.resolveCodexThreadExecutionModeForActiveTurn(
              notification.params.threadId,
            ),
          );
        }
      }
    }

    if (
      event.notification.method === "turn/completed" ||
      event.notification.method === "turn/failed" ||
      event.notification.method === "turn/cancelled"
    ) {
      const notification = event.notification as {
        params: {
          threadId: string;
          turnId?: string;
          turn?: {
            id?: string;
          };
        };
      };
      const turnId = turnIdFromTerminalNotification(notification);
      if (turnId) {
        await this.completeReviewSubAgent({
          backend: event.backend,
          completedAt: completedAtFromTerminalNotification(event.notification),
          method: event.notification.method,
          threadId: notification.params.threadId,
          turnId,
        });
      }
      if (turnId) {
        this.activeTurnKeys.delete(
          buildActiveTurnKey(event.backend, notification.params.threadId, turnId),
        );
      }
      if (event.backend === "codex" && turnId) {
        const activeTurnModeKey = buildActiveTurnModeKey(
          notification.params.threadId,
          turnId,
        );
        const wasKnownActiveTurn =
          !turnId.startsWith("pending:") &&
          this.activeCodexTurnModes.has(activeTurnModeKey);
        this.clearCodexReviewInterruptMappingForTurn(
          notification.params.threadId,
          turnId,
        );
        this.activeCodexTurnModes.delete(activeTurnModeKey);
        this.activeCodexReviewTurnKeys.delete(activeTurnModeKey);
        if (wasKnownActiveTurn) {
          await this.adoptThreadBranchChangeFromActiveTurn({
            backend: event.backend,
            threadId: notification.params.threadId,
          });
        }
        try {
          const overlay = await this.overlayStore.getThreadOverlayState({
            backend: event.backend,
            threadId: notification.params.threadId,
          });
          const observedSettings = this.observedCodexSettingsByThread.get(
            notification.params.threadId,
          );
          const warning = getCodexFastModeMismatchWarning({
            threadId: notification.params.threadId,
            turnId,
            expectedFastMode: Boolean(overlay?.fastMode),
            notificationParams: buildCodexFastModeMismatchNotificationParams(
              notification.params,
              observedSettings,
            ),
          });
          if (warning) {
            backendRegistryLog.warn("codex fast mode state mismatch", warning);
          }
        } catch (error) {
          backendRegistryLog.warn("codex fast mode state mismatch check failed", {
            error: error instanceof Error ? error.message : String(error),
            threadId: notification.params.threadId,
            turnId,
          });
        }
      }
      void this.threadTurnQueue.releaseThread({
        backend: event.backend,
        threadId: notification.params.threadId,
        turnId,
        status: event.notification.method,
      });
      if (event.backend === "codex") {
        // Turn-end is the resume boundary — flush any queued mode change
        // now. Fire-and-forget; failures are logged + retried inside
        // flushQueuedExecutionModeIfPresent.
        void this.flushQueuedExecutionModeIfPresent(
          notification.params.threadId,
        );
      } else if (isAcpBackendId(event.backend)) {
        if (this.usesSlashControlledAcpExecutionModes(event.backend)) {
          void this.flushQueuedExecutionModeIfPresent(
            notification.params.threadId,
            event.backend,
          );
        }
        void this.flushQueuedAcpRuntimeOptionIfPresent(
          event.backend,
          notification.params.threadId,
        );
      }
    }
    if (
      event.notification.method === "turn/failed" &&
      !isAcpBackendId(event.backend)
    ) {
      // Persist a durable failure marker BEFORE the renderer fan-out below
      // so the next navigation-snapshot refresh carries it. Dedupe lives in
      // the overlay store (by turnId). ACP backends are skipped: their
      // session normalizer already persists a `turn-failed:` transcript
      // entry that readThread returns, so recording here would just be
      // redundant overlay state (the renderer would de-dupe it anyway).
      // Params are cast explicitly here, matching the surrounding terminal-
      // notification handlers — the `AppServerNotification` union is too
      // wide for reliable narrowing.
      const failureParams = event.notification.params as {
        threadId: string;
        turnId: string;
        turn?: { error?: { message?: unknown } };
      };
      const rawMessage = failureParams.turn?.error?.message;
      const errorMessage =
        typeof rawMessage === "string" && rawMessage.trim()
          ? rawMessage
          : "Turn failed.";
      await this.appendTurnFailure({
        backend: event.backend,
        threadId: failureParams.threadId,
        failure: {
          id: randomUUID(),
          turnId: failureParams.turnId,
          error: errorMessage,
          occurredAt:
            completedAtFromTerminalNotification(event.notification) ??
            Date.now(),
        },
      });
    }

    if (
      event.backend === "codex" &&
      (event.notification.method === "turn/completed" ||
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled")
    ) {
      await this.handleTaskMonitorTerminalNotification(
        event.notification as Extract<
          AppServerNotification,
          { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
        >,
      );
    }

    if (
      event.notification.method === "thread/status/changed" &&
      readStatusType(event.notification.params.status) !== "active"
    ) {
      const threadId = event.notification.params.threadId;
      const hasActiveCodexReviewTurn =
        event.backend === "codex" &&
        this.threadHasActiveCodexReviewTurn(threadId);
      const genericKeyPrefix = `${event.backend}:${event.notification.params.threadId}:`;
      for (const key of Array.from(this.activeTurnKeys)) {
        if (key.startsWith(genericKeyPrefix)) {
          const parsed = parseActiveTurnKey(key);
          if (
            hasActiveCodexReviewTurn &&
            parsed?.backend === "codex" &&
            this.activeCodexReviewTurnKeys.has(
              buildActiveTurnModeKey(parsed.threadId, parsed.turnId),
            )
          ) {
            continue;
          }
          this.activeTurnKeys.delete(key);
        }
      }
      if (event.backend !== "codex") {
        if (isAcpBackendId(event.backend)) {
          if (this.usesSlashControlledAcpExecutionModes(event.backend)) {
            void this.flushQueuedExecutionModeIfPresent(
              event.notification.params.threadId,
              event.backend,
            );
          }
          void this.flushQueuedAcpRuntimeOptionIfPresent(
            event.backend,
            event.notification.params.threadId,
          );
        }
      } else {
        const keyPrefix = `${event.notification.params.threadId}:`;
        let hadKnownActiveTurn = false;
        for (const key of this.activeCodexTurnModes.keys()) {
          if (key.startsWith(keyPrefix)) {
            if (this.activeCodexReviewTurnKeys.has(key)) {
              continue;
            }
            if (!key.startsWith(`${keyPrefix}pending:`)) {
              hadKnownActiveTurn = true;
            }
            this.activeCodexTurnModes.delete(key);
          }
        }
        if (hadKnownActiveTurn) {
          await this.adoptThreadBranchChangeFromActiveTurn({
            backend: event.backend,
            threadId: event.notification.params.threadId,
          });
        }
        // Same resume-boundary flush, triggered from the
        // `thread/status/changed → idle` path (codex emits both, depending
        // on the protocol shape; we cover both for resilience). Idempotent
        // when no queue is set.
        if (!hasActiveCodexReviewTurn) {
          void this.flushQueuedExecutionModeIfPresent(
            event.notification.params.threadId,
          );
        }
      }
      if (hasActiveCodexReviewTurn) {
        // Codex review/start currently returns the real review turn id, then
        // may emit a mismatched turn/started and an idle status before the
        // review's own terminal event. Do not release queued turns at that
        // stray idle boundary; the matching review turn/completed is the real
        // point where the thread becomes available again.
        return;
      }
      void this.threadTurnQueue.releaseThread({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        status: readStatusType(event.notification.params.status),
      });
    }

    if (event.notification.method === "serverRequest/resolved") {
      const key = buildPendingRequestKey({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
      });
      if (this.pendingServerRequests.has(key)) {
        backendRegistryLog.warn(
          "serverRequest/resolved received while request is still pending; ignoring premature resolution",
          {
            backend: event.backend,
            threadId: event.notification.params.threadId,
            requestId: event.notification.params.requestId,
          },
        );
        return;
      }
      try {
        getDesktopNotificationService().clearAttentionKey(key);
      } catch (error) {
        backendRegistryLog.warn("native notification cleanup failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          requestId: event.notification.params.requestId,
          threadId: event.notification.params.threadId,
        });
      }
    }

    await this.recordLiveThreadUsage(event);
    await this.recordTaskMonitorUsage(event);

    this.rememberThreadTitleFromEvent(event);
    this.notifyForAttentionRequired(event);
    await this.notifyForTerminalOutcome(event);

    for (const listener of this.eventListeners) {
      try {
        await listener(event);
      } catch (error) {
        backendRegistryLog.error("desktop event listener failed", {
          backend: event.backend,
          error: error instanceof Error ? error.message : String(error),
          method: event.notification.method,
          requestId:
            "requestId" in event.notification.params
              ? event.notification.params.requestId
              : undefined,
          threadId:
            "threadId" in event.notification.params
              ? event.notification.params.threadId
              : undefined,
          turnId:
            "turnId" in event.notification.params
              ? event.notification.params.turnId
              : undefined,
        });
      }
    }
  }
}

function readThreadInspectionBackend(
  value: unknown,
): AppServerBackendKind | "all" | undefined {
  if (value === undefined || value === "all") {
    return "all";
  }
  return typeof value === "string" && isAppServerBackendKind(value)
    ? value
    : undefined;
}

function clampInteger(
  value: unknown,
  defaultValue: number,
  maxValue: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return defaultValue;
  }
  return Math.max(1, Math.min(maxValue, Math.floor(value)));
}

function filterThreadInspectionSummaries(
  threads: ThreadInspectionSummary[],
  options: { agentOnly: boolean; query?: string },
): ThreadInspectionSummary[] {
  const clauses = parseThreadInspectionQuery(options.query);
  return threads
    .filter((thread) => !options.agentOnly || Boolean(thread.agent))
    .map((thread) => ({
      score: scoreThreadInspectionSummary(thread, clauses),
      thread,
    }))
    .filter((entry) => clauses.length === 0 || entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        (right.thread.updatedAt ?? right.thread.createdAt ?? 0) -
          (left.thread.updatedAt ?? left.thread.createdAt ?? 0),
    )
    .map((entry) => entry.thread);
}

function toThreadInspectionSummary(
  thread: AppServerThreadSummary,
  agent: ThreadAgentMetadata | undefined,
): ThreadInspectionSummary {
  return {
    backend: thread.source,
    threadId: thread.id,
    title: thread.title,
    summary: thread.summary,
    projectKey: thread.projectKey,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    archivedAt: thread.archivedAt,
    agent,
    executionMode: thread.executionMode,
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    serviceTier: thread.serviceTier,
    fastMode: thread.fastMode,
    linkedDirectories: thread.linkedDirectories,
  };
}

function toThreadInspectionSummaryFromSearchResult(
  result: ThreadSearchResult,
  agent: ThreadAgentMetadata | undefined,
): ThreadInspectionSummary {
  return {
    backend: result.backend,
    threadId: result.threadId,
    title: result.title,
    summary: result.summary,
    projectKey: result.projectKey,
    createdAt: result.createdAt,
    updatedAt: result.updatedAt,
    archivedAt: result.archivedAt,
    agent,
    model: result.model,
    linkedDirectories: result.linkedDirectories,
    score: result.score,
    confidence: result.confidence,
    matchReasons: result.matchReasons,
    snippets: result.snippets,
  };
}

function dedupeThreadInspectionThreadSummaries(
  threads: AppServerThreadSummary[],
): AppServerThreadSummary[] {
  const seen = new Set<string>();
  const deduped: AppServerThreadSummary[] = [];
  for (const thread of threads) {
    const key = buildThreadIdentityKey(thread.source, thread.id);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(thread);
  }
  return deduped;
}

function parseThreadInspectionQuery(query: string | undefined): string[][] {
  const trimmed = query?.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  return trimmed
    .split(/\s+(?:or)\s+|[|,]/i)
    .map((clause) =>
      clause
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean),
    )
    .filter((tokens) => tokens.length > 0);
}

function scoreThreadInspectionSummary(
  thread: ThreadInspectionSummary,
  clauses: string[][],
): number {
  if (clauses.length === 0) {
    return 0;
  }
  const title = thread.title.toLowerCase();
  const project = `${thread.projectKey ?? ""} ${thread.linkedDirectories
    .flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ])
    .filter(Boolean)
    .join(" ")}`.toLowerCase();
  const haystack = [
    thread.backend,
    thread.threadId,
    thread.title,
    thread.summary,
    thread.projectKey,
    thread.agent?.name,
    thread.agent?.instructions,
    ...thread.linkedDirectories.flatMap((directory) => [
      directory.label,
      directory.path,
      directory.worktreePath,
    ]),
  ]
    .filter((value): value is string => Boolean(value))
    .join(" ")
    .toLowerCase();

  let bestScore = 0;
  for (const tokens of clauses) {
    if (!tokens.every((token) => haystack.includes(token))) {
      continue;
    }
    const phrase = tokens.join(" ");
    const exactTitle = title.includes(phrase) ? 100 : 0;
    const allTitleTokens = tokens.every((token) => title.includes(token))
      ? 75
      : 0;
    const exactProject = project.includes(phrase) ? 60 : 0;
    const allProjectTokens = tokens.every((token) => project.includes(token))
      ? 45
      : 0;
    const exactHaystack = haystack.includes(phrase) ? 35 : 0;
    const tokenScore = Math.min(tokens.length, 5) * 5;
    bestScore = Math.max(
      bestScore,
      exactTitle ||
        allTitleTokens ||
        exactProject ||
        allProjectTokens ||
        exactHaystack ||
        tokenScore,
    );
  }
  return bestScore;
}

function toThreadInspectionSearchSummary(
  thread: ThreadInspectionSummary,
): ThreadInspectionSummary {
  return {
    backend: thread.backend,
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.summary
      ? { summary: truncateThreadInspectionText(thread.summary, 240) }
      : {}),
    ...(thread.projectKey ? { projectKey: thread.projectKey } : {}),
    ...(thread.createdAt !== undefined ? { createdAt: thread.createdAt } : {}),
    ...(thread.updatedAt !== undefined ? { updatedAt: thread.updatedAt } : {}),
    ...(thread.archivedAt !== undefined ? { archivedAt: thread.archivedAt } : {}),
    ...(thread.agent ? { agent: thread.agent } : {}),
    ...(thread.score !== undefined ? { score: thread.score } : {}),
    ...(thread.confidence ? { confidence: thread.confidence } : {}),
    ...(thread.matchReasons?.length
      ? { matchReasons: thread.matchReasons.slice(0, 6) }
      : {}),
    ...(thread.snippets?.length
      ? {
          snippets: thread.snippets.slice(0, 3).map((snippet) => ({
            scope: snippet.scope,
            ...(snippet.field ? { field: snippet.field } : {}),
            text: truncateThreadInspectionText(snippet.text, 360),
            ...(snippet.truncated ? { truncated: true } : {}),
          })),
        }
      : {}),
    linkedDirectories: thread.linkedDirectories.slice(0, 3).map((directory) => ({
      id: directory.id,
      kind: directory.kind,
      label: directory.label,
      path: directory.path,
      ...(directory.worktreePath ? { worktreePath: directory.worktreePath } : {}),
    })),
  };
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  return values.length > 0 ? values : undefined;
}

function buildThreadInspectionDateRange(params: {
  updatedAfter?: number;
  updatedBefore?: number;
}): Pick<ThreadSearchFilters, "dateRange"> {
  const from =
    typeof params.updatedAfter === "number" && Number.isFinite(params.updatedAfter)
      ? Math.floor(params.updatedAfter)
      : undefined;
  const to =
    typeof params.updatedBefore === "number" && Number.isFinite(params.updatedBefore)
      ? Math.floor(params.updatedBefore)
      : undefined;
  return from !== undefined || to !== undefined
    ? {
        dateRange: {
          ...(from !== undefined ? { from } : {}),
          ...(to !== undefined ? { to } : {}),
        },
      }
    : {};
}

function truncateThreadInspectionText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

let registry: DesktopBackendRegistry | null = null;

export function getDesktopBackendRegistry(): DesktopBackendRegistry {
  if (!registry) {
    registry = new DesktopBackendRegistry();
  }

  return registry;
}

export async function disposeDesktopBackendRegistry(): Promise<void> {
  if (!registry) {
    return;
  }

  const current = registry;
  registry = null;
  await current.close();
}
