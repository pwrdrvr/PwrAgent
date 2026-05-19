import { app } from "electron";
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import {
  isToolManagedWorktreePath,
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
  type AppServerThreadReplay,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAccountSummary,
  type BackendCapabilities,
  type CodexEnvironmentOption,
  type CodexEnvironmentSetupProgressEvent,
  type CodexThreadEnvironmentRuntime,
  type BackendLaunchpadOptions,
  type BackendModelOption,
  type BackendRateLimitSummary,
  type BackendSummary,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  isBranchDrifted,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type LinkedDirectorySummary,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadResponse,
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
  type SetCodexThreadEnvironmentRequest,
  type SetCodexThreadEnvironmentResponse,
  type RenameThreadRequest,
  type RenameThreadResponse,
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
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadResponse,
  type SubmitServerRequestRequest,
  type SubmitServerRequestResponse,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type WorktreeSnapshotSummary,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateThreadExpectedBranchRequest,
  type UpdateThreadExpectedBranchResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  applyCodexEnvironmentActionRunUpdate,
  readCodexEnvironmentActionRuns,
} from "@pwragent/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { GrokAppServerClient } from "../grok-app-server/client";
import { createScratchProjectDirectory } from "./scratch-projects";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";
import { GitDirectoryService } from "./git-directory-service";
import type { DirectoryGitStatusEntry } from "./git-directory-service";
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
import {
  BackendModelCatalog,
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  listCodexEnvironmentOptions,
  withCodexEnvironmentOptions,
} from "./codex-environment-config";
import {
  applyLocalCodexEnvironmentSelection,
  CodexEnvironmentStartupError,
  startLocalCodexEnvironmentAction,
  type CodexEnvironmentCommandRunner,
  type CodexEnvironmentDetachedExit,
  type CodexEnvironmentDetachedOutput,
  type CodexEnvironmentSelection,
} from "./codex-environment-runtime";
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
// Keep startup prewarm useful through renderer parse/effect scheduling. Thread
// lifecycle notifications still invalidate this cache when the list changes.
const THREAD_LIST_REUSE_WINDOW_MS = 5_000;
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
  startThread(params: {
    cwd?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
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
  }): Promise<{
    threadId: string;
    turnId: string;
  }>;
  startReview?(params: {
    threadId: string;
    target: StartReviewRequest["target"];
    delivery?: StartReviewRequest["delivery"];
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

function buildLocalLinkedDirectory(cwd: string | undefined): LinkedDirectorySummary[] {
  const normalized = cwd?.trim();
  if (!normalized) {
    return [];
  }
  const directoryPath = path.resolve(normalized);
  return [
    {
      id: directoryPath,
      kind: "local",
      label: path.basename(directoryPath) || directoryPath,
      path: directoryPath,
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
      id: repositoryPath,
      kind: "worktree",
      label,
      path: repositoryPath,
      worktreePath,
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
  return Boolean(
    overlay?.extraLinkedDirectories.some((directory) => {
      if (directory.id !== projectPath) {
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
    id: projectPath,
    kind: "worktree",
    label: directory.label || path.basename(repositoryPath) || repositoryPath,
    path: repositoryPath,
    worktreePath,
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
    id: projectPath,
    kind: "local",
    label: localDirectory.label || path.basename(projectPath) || projectPath,
    path: projectPath,
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

type WorktreeRestoreCandidate = {
  branch?: string;
  repositoryPath?: string;
  snapshot?: WorktreeSnapshotSummary;
  worktreePath: string;
};

const BACKEND_LABELS: Record<AppServerBackendKind, string> = {
  codex: "OpenAI",
  grok: "Grok",
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
    id: "gpt-5.3-codex",
    label: "GPT-5.3-Codex",
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

function buildCodexClientArgs(env?: NodeJS.ProcessEnv): string[] {
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

function buildActiveTurnModeKey(threadId: string, turnId: string): string {
  return `${threadId}:${turnId}`;
}

function readStatusType(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return undefined;
  }

  const type = value.type;
  return typeof type === "string" ? type : undefined;
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
      turnId?: string;
      turn?: {
        id?: string;
      };
    };
  },
): string | undefined {
  return notification.params.turnId ?? notification.params.turn?.id;
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
): BackendLaunchpadOptions | undefined {
  const normalizedModels = dedupeModelOptions(
    backend,
    models.length > 0 ? models : getBackendFallbackModels(backend),
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
  if (launchpad.backend !== "codex" || !launchpad.codexEnvironmentId) {
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
    setupEnabled: Boolean(launchpad.codexEnvironmentSetupEnabled),
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

  if (launchpad.backend !== "codex" || !launchpad.codexEnvironmentId) {
    return;
  }

  const now = Date.now();
  await overlayStore.upsertDirectoryLaunchpad({
    directoryKey: launchpad.directoryKey,
    directoryKind: launchpad.directoryKind,
    directoryLabel: launchpad.directoryLabel,
    directoryPath: launchpad.directoryPath,
    backend: "codex",
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
    codexEnvironmentSetupEnabled:
      launchpad.codexEnvironmentSetupEnabled ?? true,
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
  if (thread.titleSource === "fallback" || thread.title === "Untitled thread") {
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

  return {
    model: selectedModel?.id,
    reasoningEffort,
    serviceTier: settings.serviceTier,
    fastMode: supportsFast ? settings.fastMode : undefined,
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
    left.fastMode === right.fastMode
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

export class DesktopBackendRegistry {
  private readonly codexClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly overlayStore: OverlayStoreLike;
  private readonly gitDirectoryService: GitDirectoryService;
  private readonly gitWorkspaceHandoffService: GitWorkspaceHandoffService;
  private readonly worktreeArchiveService: WorktreeArchiveService;
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
  private readonly threadListCacheOwnerId = `backend-thread-list-cache-${++threadListCacheSequence}`;
  private readonly threadListCache = new Map<string, ThreadListCacheState>();
  private readonly activeThreadIdsByBackend = new Map<AppServerBackendKind, Set<string>>();
  private readonly pendingStartedThreads = new Map<string, AppServerThreadSummary>();
  private readonly captureStores: ProtocolCaptureStore[] = [];
  private readonly eventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
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
  /**
   * In-memory queue of pending permission-mode changes, keyed by
   * threadId. Populated when a user toggles execution mode while a turn
   * is active; flushed to codex at the resume boundary (turn-end, or
   * just before the next turn-start). Not persisted across app restart
   * by design — the corresponding audit-log entries on overlay state
   * carry the historical record.
   */
  private readonly queuedExecutionModes = new Map<
    string,
    {
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    }
  >();
  private readonly queuedExecutionModeFlushes = new Map<string, Promise<void>>();
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

  constructor(options?: {
    codexClient?: BackendClient;
    grokClient?: BackendClient;
    overlayStore?: OverlayStoreLike;
    gitDirectoryService?: GitDirectoryService;
    gitWorkspaceHandoffService?: GitWorkspaceHandoffService;
    worktreeArchiveService?: WorktreeArchiveService;
    messagingStore?: MessagingArchiveCleanupStore | null;
    messagingArchiveCleaner?: MessagingArchiveCleaner | null;
    createScratchProjectDirectory?: () => Promise<string>;
    codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
    threadTitleGenerationService?: ThreadTitleService | null;
    isCodexBootstrapDeferred?: () => boolean;
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
    const codexCommand = settingsService?.resolveCodexCommandPreference();
    const codexEnv =
      typeof settingsService?.resolveCodexSpawnEnv === "function"
        ? settingsService.resolveCodexSpawnEnv()
        : undefined;
    this.codexEnvironmentCommandEnv = codexEnv;
    this.codexEnvironmentCommandRunner = options?.codexEnvironmentCommandRunner;
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
        args: buildCodexClientArgs(codexEnv),
        command: codexCommand,
        connectionObserver: codexObserver,
        env: codexEnv,
        clientVersion,
      });
    this.grokClient =
      options?.grokClient ??
      replayClients?.grokClient ??
      new GrokAppServerClient({
        apiKey: grokApiKey,
        connectionObserver: grokObserver,
      });
    this.overlayStore = options?.overlayStore ?? getDesktopOverlayStore();
    this.gitDirectoryService =
      options?.gitDirectoryService ??
      new GitDirectoryService({
        codexHome,
        gitEnv: codexEnv,
        resolveWorktreeStorage: () =>
          getDesktopSettingsService().resolveWorktreeStorage(),
      });
    this.worktreeArchiveService =
      options?.worktreeArchiveService ??
      new WorktreeArchiveService({ gitEnv: codexEnv });
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
    this.modelCatalog = new BackendModelCatalog({
      codex: this.codexClient,
      grok: this.grokClient,
    });

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

  async publishLocalEvent(event: AgentEvent): Promise<void> {
    await this.emit(event);
  }

  async listBackends(
    request: ListBackendsRequest = {}
  ): Promise<ListBackendsResponse> {
    const summaries = await Promise.all([
      this.describeCodexBackend(),
      this.describeSingleBackend("grok", this.grokClient),
    ]);

    return {
      fetchedAt: Date.now(),
      backends: request.includeUnavailable
        ? summaries
        : summaries.filter((backend) => backend.available),
    };
  }

  async listThreads(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
  } = {}): Promise<AppServerThreadSummary[]> {
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
    const cached = this.threadListCache.get(cacheKey);
    const now = Date.now();
    if (cached?.threads && (cached.expiresAt ?? 0) > now) {
      logDebug("threadListCache:hit", {
        backend: params.backend ?? "all",
        callerReason: params.callerReason ?? null,
        ownerId: this.threadListCacheOwnerId,
      });
      return cached.threads;
    }
    if (cached?.promise) {
      logDebug("threadListCache:coalesced", {
        backend: params.backend ?? "all",
        callerReason: params.callerReason ?? null,
        ownerId: this.threadListCacheOwnerId,
      });
      return await cached.promise;
    }

    const promise = this.readThreadList(normalizedParams)
      .then((threads) => {
        this.threadListCache.set(cacheKey, {
          expiresAt: Date.now() + THREAD_LIST_REUSE_WINDOW_MS,
          threads,
        });
        return threads;
      })
      .catch((error) => {
        this.threadListCache.delete(cacheKey);
        throw error;
      });
    this.threadListCache.set(cacheKey, { promise });
    return await promise;
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
  } = {}): Promise<Pick<AppServerListSkillsResponse, "data">> {
    const backend = params.backend ?? "codex";
    const data = await this.getClient(backend).listSkills({
      cwd: params.cwd,
      cwds: params.cwds,
    });

    return { data };
  }

  async archiveThread(
    request: ArchiveThreadRequest,
  ): Promise<ArchiveThreadResponse> {
    const backend = request.backend ?? "codex";
    let thread: AppServerThreadSummary | undefined;
    let cleanupMetadataError: string | undefined;
    try {
      thread = await this.findThreadForArchiveCleanup({
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
    const cleanup = thread
      ? await this.archiveThreadWorktrees({
          backend,
          thread,
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

  async renameThread(
    request: RenameThreadRequest,
  ): Promise<RenameThreadResponse> {
    const backend = request.backend ?? "codex";
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.renameWithClient(client, request.threadId, request.name),
          )
        : await this.renameWithClient(this.grokClient, request.threadId, request.name);
    this.invalidateThreadListCache(backend);

    return {
      backend,
      threadId: result.threadId,
      renamedAt: Date.now(),
    };
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

  async readThread(
    request: AppServerReadThreadRequest
  ): Promise<AppServerReadThreadResponse> {
    const backend = request.backend ?? "codex";
    const replay =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await client.readThread({
              threadId: request.threadId,
              before: request.before,
              limit: request.limit,
            }),
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

    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      ...(replayWithEnvironment.threadStatus
        ? { threadStatus: replayWithEnvironment.threadStatus }
        : {}),
      replay: replayWithEnvironment,
    };
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
    workMode?: NavigationLaunchpadDraft["workMode"];
    branchName?: string;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    linkedDirectories?: LinkedDirectorySummary[];
  }): Promise<StartThreadResponse> {
    const {
      backend,
      executionMode = "default",
      linkedDirectories,
      workMode,
      branchName,
      ...request
    } = params;
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
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

    const result = await this.getClient(backend, executionMode).startThread({
      ...request,
      ...modelSettings,
      cwd,
      approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
      sandbox: request.sandbox ?? modeSettings.sandbox,
      codexEnvironmentRuntime: request.codexEnvironmentRuntime,
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
        executionMode,
        ...modelSettings,
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
        executionMode,
      });
      await this.updateThreadGitBranchMetadata({
        backend,
        threadId: result.threadId,
        branch: gitBranch,
      });
      if (request.codexEnvironmentRuntime) {
        await this.overlayStore.setThreadCodexEnvironmentRuntime?.({
          backend,
          threadId: result.threadId,
          codexEnvironmentRuntime: request.codexEnvironmentRuntime,
        });
      }
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
      executionMode,
      codexEnvironmentRuntime: request.codexEnvironmentRuntime,
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
    // Race-safe flush: if a queued permission-mode change is still
    // pending when the user fires off the next turn (e.g. submit
    // immediately after the previous turn ended), apply it before
    // codex sees the new turn so the new turn runs under the
    // intended profile. The emit-listener flush in `emit()` is the
    // faster path when no immediate user action follows; this is the
    // belt-and-suspenders guarantee. Idempotent — a no-op when no
    // queue is present.
    if (params.backend === "codex") {
      await this.flushQueuedExecutionModeIfPresent(params.threadId);
    }
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const turnParams = await this.resolveModelSettings(params.backend, {
      ...params,
      model: params.model ?? overlay?.model,
      serviceTier: params.serviceTier ?? overlay?.serviceTier,
      reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
      fastMode: params.backend === "codex" ? params.fastMode ?? overlay?.fastMode : undefined,
    });
    const cwd =
      params.backend === "codex"
        ? await this.resolveCodexThreadTurnCwd(params.threadId, overlay)
        : undefined;
    let activeTurnMode: ThreadExecutionMode | undefined;
    const syntheticStartedTurnId = `pending:${params.threadId}`;
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

    let result: { threadId: string; turnId: string };
    try {
      result =
        params.backend === "codex"
          ? await this.withCodexThreadClient(params.threadId, async (client, mode) => {
              const effectiveMode = params.executionMode ?? mode;
              const modeSettings = EXECUTION_MODE_SUMMARIES[effectiveMode];
              const started = await client.startTurn({
                threadId: params.threadId,
                input: params.input,
                ...(cwd ? { cwd } : {}),
                collaborationMode: params.collaborationMode,
                ...turnParams,
                approvalPolicy: params.approvalPolicy ?? modeSettings.approvalPolicy,
                sandbox: params.sandbox ?? modeSettings.sandbox,
              });
              activeTurnMode = effectiveMode;
              return started;
            }, params.executionMode)
          : await this.grokClient.startTurn({
              threadId: params.threadId,
              input: params.input,
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
      throw error;
    }
    this.activeCodexTurnModes.delete(
      buildActiveTurnModeKey(params.threadId, syntheticStartedTurnId),
    );

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
    if (params.backend === "codex" && activeTurnMode) {
      this.activeCodexTurnModes.set(
        buildActiveTurnModeKey(result.threadId, result.turnId),
        activeTurnMode,
      );
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
    if (params.backend === "codex" && this.threadHasActiveTurn(params.threadId)) {
      throw new Error(`Thread already has an active turn in progress: ${params.threadId}`);
    }
    if (params.backend === "codex") {
      await this.flushQueuedExecutionModeIfPresent(params.threadId);
    }

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
      });
    };

    const result =
      params.backend === "codex"
        ? await this.withCodexThreadClient(params.threadId, startWithClient)
        : await startWithClient(this.grokClient);

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
    const activeCodexTurnMode =
      params.backend === "codex"
        ? this.activeCodexTurnModes.get(
            buildActiveTurnModeKey(params.threadId, params.turnId),
          )
        : undefined;
    const result =
      params.backend === "codex" && activeCodexTurnMode
        ? await this.getClient("codex", activeCodexTurnMode).interruptTurn(params)
        : params.backend === "codex"
          ? await this.withCodexThreadClient(params.threadId, async (client) =>
              await client.interruptTurn(params),
            )
        : await this.grokClient.interruptTurn(params);

    if (params.backend === "codex") {
      this.activeCodexTurnModes.delete(
        buildActiveTurnModeKey(result.threadId, result.turnId),
      );
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
      // Non-codex backends (e.g. Grok) currently no-op on execution
      // mode — no overlay write, no backend change. We still emit on
      // the bus so all surfaces stay visually consistent with the
      // user's click. The optimistic UI is the same lie either way;
      // symmetric emission is better than partial fan-out.
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
    const hasActiveTurn = this.threadHasActiveTurn(params.threadId);
    const hasQueue = this.queuedExecutionModes.has(params.threadId);

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

  /**
   * Snapshot of in-memory queued execution modes keyed by `threadId`.
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
    for (const [threadId, entry] of this.queuedExecutionModes) {
      snapshot[threadId] = {
        mode: entry.mode,
        queuedAt: entry.queuedAt,
      };
    }
    return snapshot;
  }

  async queueThreadExecutionMode(
    params: QueueThreadExecutionModeRequest,
  ): Promise<QueueThreadExecutionModeResponse> {
    if (params.backend !== "codex") {
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

    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId: params.threadId,
    });
    const currentApplied = overlay?.executionMode ?? "default";
    const queuedAt = Date.now();
    const queueId = randomUUID();

    this.queuedExecutionModes.set(params.threadId, {
      mode: params.executionMode,
      queuedAt,
      queueId,
      flushAttempts: 0,
    });

    await this.appendPermissionTransition({
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
      backend: "codex",
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
      backend: "codex",
      threadId: params.threadId,
      queuedExecutionMode: params.executionMode,
      queuedAt,
    };
  }

  async cancelThreadExecutionModeQueue(
    params: CancelThreadExecutionModeQueueRequest,
  ): Promise<CancelThreadExecutionModeQueueResponse> {
    const overlay =
      params.backend === "codex"
        ? await this.overlayStore.getThreadOverlayState({
            backend: "codex",
            threadId: params.threadId,
          })
        : undefined;
    const currentApplied = overlay?.executionMode ?? "default";

    const queue =
      params.backend === "codex"
        ? this.queuedExecutionModes.get(params.threadId)
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

    this.queuedExecutionModes.delete(params.threadId);

    await this.appendPermissionTransition({
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
      backend: "codex",
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
      // The non-codex grok no-op path — preserved for symmetry. Direct
      // callers route through setThreadExecutionMode which short-circuits
      // before reaching this method, so we should never get here, but
      // guard anyway.
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

  /**
   * Returns true iff the registry currently believes a turn is in
   * flight on this thread. `activeCodexTurnModes` is keyed by
   * `${threadId}:${turnId}`; one or more matching keys → active turn.
   */
  private threadHasActiveTurn(threadId: string): boolean {
    const prefix = `${threadId}:`;
    for (const key of this.activeCodexTurnModes.keys()) {
      if (key.startsWith(prefix)) {
        return true;
      }
    }
    return false;
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
    threadId: string;
    transition: ThreadPermissionTransition;
  }): Promise<void> {
    try {
      await this.overlayStore.appendPermissionTransition({
        backend: "codex",
        threadId: params.threadId,
        transition: params.transition,
      });
    } catch (error) {
      backendRegistryLog.error("failed to append permission transition", {
        threadId: params.threadId,
        status: params.transition.status,
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
  ): Promise<void> {
    const activeFlush = this.queuedExecutionModeFlushes.get(threadId);
    if (activeFlush) {
      await activeFlush;
      return;
    }

    const queue = this.queuedExecutionModes.get(threadId);
    if (!queue) return;
    // Atomic claim: in JS's single-threaded event loop, `Map.delete`
    // returning true gives this caller exclusive ownership of the
    // apply. Concurrent flushes (one from the emit-listener turn-end
    // hook, one from startTurn's race-safe prefix) both see the same
    // queue but only one's delete returns true — the other no-ops.
    // Without this, both callers race on applyThreadExecutionMode and
    // each appends a duplicate "applied" transition entry.
    if (!this.queuedExecutionModes.delete(threadId)) {
      return;
    }

    const flush = this.applyClaimedQueuedExecutionMode(threadId, queue);
    this.queuedExecutionModeFlushes.set(threadId, flush);
    try {
      await flush;
    } finally {
      if (this.queuedExecutionModeFlushes.get(threadId) === flush) {
        this.queuedExecutionModeFlushes.delete(threadId);
      }
    }
  }

  private async applyClaimedQueuedExecutionMode(
    threadId: string,
    queue: {
      mode: ThreadExecutionMode;
      queuedAt: number;
      queueId: string;
      flushAttempts: number;
    },
  ): Promise<void> {
    try {
      await this.applyThreadExecutionMode(
        {
          backend: "codex",
          threadId,
          executionMode: queue.mode,
        },
        { fromQueue: true, queueId: queue.queueId },
      );
    } catch (error) {
      const attempts = queue.flushAttempts + 1;
      const stillRetained = this.queuedExecutionModes.get(threadId);
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
          .getThreadOverlayState({ backend: "codex", threadId })
          .catch(() => undefined);
        const currentApplied = overlay?.executionMode ?? "default";
        this.queuedExecutionModes.delete(threadId);
        await this.appendPermissionTransition({
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
          backend: "codex",
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
      this.queuedExecutionModes.set(threadId, {
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

    backendRegistryLog.debug("checked thread branch drift", {
      backend: params.backend,
      drifted,
      expectedBranch,
      observedBranch: normalizedObservedBranch,
      workspaceCwd,
      threadId: params.threadId,
    });

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
      const backend = await this.resolveLaunchpadBackend(existing.backend);
      const modelSettings = await this.resolveLaunchpadModelSettings(
        backend,
        existing,
      );
      const executionMode = getAvailableExecutionMode(
        backend,
        existing.executionMode,
      );
      const normalizedExisting: NavigationLaunchpadDraft = {
        ...existing,
        backend: backend.kind,
        executionMode,
        ...modelSettings,
      };
      const identityChanged =
        normalizedExisting.directoryKind !== request.directoryKind ||
        normalizedExisting.directoryLabel !== request.directoryLabel ||
        normalizedExisting.directoryPath !== request.directoryPath;

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
          workMode: defaultLaunchpadWorkMode(request, defaults),
          branchName: existing.branchName ?? request.currentBranch,
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
        registeredAt !== existing.registeredAt
      ) {
        return {
          launchpad: withCodexEnvironmentOptions(
            await this.overlayStore.upsertDirectoryLaunchpad({
              ...normalizedExisting,
              directoryKind: request.directoryKind,
              directoryLabel: request.directoryLabel,
              directoryPath: request.directoryPath,
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
      prompt: "",
      registeredAt: request.registeredAt,
      workMode: defaultLaunchpadWorkMode(request, defaults),
      branchName: request.currentBranch,
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

    const nextLaunchpad: NavigationLaunchpadDraft = {
      ...current,
      ...request.patch,
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
    if (request.stickySettingsChanged && request.patch.executionMode) {
      stickyPatch.executionMode = request.patch.executionMode;
    }
    if (request.stickySettingsChanged && "model" in request.patch) {
      stickyPatch.model = request.patch.model;
    }
    if (request.stickySettingsChanged && "reasoningEffort" in request.patch) {
      stickyPatch.reasoningEffort = request.patch.reasoningEffort;
    }
    if (request.stickySettingsChanged && "serviceTier" in request.patch) {
      stickyPatch.serviceTier = request.patch.serviceTier;
    }
    if (request.stickySettingsChanged && "fastMode" in request.patch) {
      stickyPatch.fastMode = request.patch.fastMode;
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
    if (request.backend !== "codex") {
      throw new Error("Codex environment actions are only available for Codex threads.");
    }

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
          throw new Error(
            "This thread does not have a selected Codex environment.",
          );
        }

        const currentCwd =
          request.cwd?.trim() ||
          (await this.resolveCodexThreadTurnCwd(request.threadId, overlay));
        const runtimeForAction = await this.refreshCodexEnvironmentRuntimeActions(
          currentCwd?.trim() ? { ...runtime, cwd: currentCwd.trim() } : runtime,
          request.actionId,
        );
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
    if (request.backend !== "codex") {
      throw new Error("Codex environments are only available for Codex threads.");
    }

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
    const cwd = await this.resolveCodexThreadTurnCwd(request.threadId, overlay);
    const options = await listCodexEnvironmentOptions(cwd);
    const environment = options.find(
      (candidate) => candidate.id === request.environmentId,
    );
    if (!environment) {
      throw new Error("Selected Codex environment is not available for this thread.");
    }

    const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime = {
      environmentId: environment.id,
      environmentName: environment.name,
      executionTarget: "local",
      cwd,
      setupEnabled: false,
      setupCommand: environment.setupScript,
      actions: environment.actions,
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
          const nextRuns = applyCodexEnvironmentActionRunUpdate(currentRuns, {
            kind: "patch",
            runId: params.runId,
            patch: { output: params.event.output },
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
    options?: {
      onCodexEnvironmentSetupProgress?: (
        event: CodexEnvironmentSetupProgressEvent,
      ) => void;
    },
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const launchpad =
      (await this.overlayStore.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      })) ?? request.launchpad;
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
    if (launchpad.backend === "codex") {
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
    }
    const startThreadResponse = await this.startThread({
      backend: launchpad.backend,
      executionMode: launchpad.executionMode,
      cwd: workspace.cwd,
      linkedDirectories,
      model: launchpad.model,
      reasoningEffort: launchpad.reasoningEffort,
      serviceTier: launchpad.serviceTier,
      fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
      codexEnvironmentRuntime,
    });
    pendingActionThreadId = startThreadResponse.threadId;
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

    const input =
      request.input ??
      (launchpad.prompt.trim()
        ? [{ type: "text", text: launchpad.prompt } as const]
        : []);
    let turnId: string | undefined;
    if (codexEnvironmentStartupFailure) {
      turnId = undefined;
    } else if (request.reviewTarget) {
      const reviewResponse = await this.startReview({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        target: request.reviewTarget,
        delivery: "inline",
      });
      turnId = reviewResponse.turnId;
    } else if (input.length > 0) {
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
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      turnId,
      executionMode: startThreadResponse.executionMode,
      ...(linkedDirectories?.[0] ? { linkedDirectory: linkedDirectories[0] } : {}),
      workMode: workspace.workMode,
      codexEnvironmentRuntime,
      codexEnvironmentStartupFailure,
    };
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }

    for (const [key, pending] of this.pendingServerRequests) {
      pending.reject(new Error(`Desktop backend registry closed before ${key} resolved`));
      this.pendingServerRequests.delete(key);
    }

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
    const backend = await this.resolveLaunchpadBackend(
      preferredBackend ?? storedDefaults.backend,
    );
    const modelSettings = await this.resolveLaunchpadModelSettings(
      backend,
      storedDefaults,
    );
    const resolvedDefaults: NavigationLaunchpadDefaults = {
      ...storedDefaults,
      backend: backend.kind,
      executionMode: getAvailableExecutionMode(
        backend,
        storedDefaults.executionMode,
      ),
      ...modelSettings,
    };

    if (launchpadDefaultsEqual(storedDefaults, resolvedDefaults)) {
      return storedDefaults;
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
        await this.emit({ backend, notification });
      }),
    );

    if (client.onRequest) {
      this.unsubscribers.push(
        client.onRequest(async (request) => await this.handleServerRequest(backend, request)),
      );
    }
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

    return this.codexClient;
  }

  private buildThreadListCacheKey(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
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
      method === "thread/name/updated" ||
      method === "thread/started" ||
      method === "thread/unarchived" ||
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

    logDebug("codexDirectoryBackfill:candidates", {
      callerReason: params.diagnostics?.callerReason ?? null,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, 10).map((thread) => ({
        threadId: thread.id,
        projectKey: thread.projectKey,
        linkedDirectories: thread.linkedDirectories,
        overlayExtraLinkedDirectories:
          params.overlaysByThreadId[thread.id]?.extraLinkedDirectories ?? [],
      })),
    });

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

      logDebug("codexDirectoryBackfill:completed", {
        callerReason: params.diagnostics?.callerReason ?? null,
        candidateCount: candidates.length,
        updatedThreadCount: Object.keys(updatedOverlaysByThreadId).length,
      });

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
    backendRegistryLog.info("codex thread client routing", {
      threadId,
      requestedMode,
      resolvedMode: mode,
      source,
    });
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
  }): Promise<AppServerThreadSummary> {
    const activeThreads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: "archive-cleanup",
    });
    const activeThread = activeThreads.find((thread) => thread.id === params.threadId);
    if (activeThread) {
      return activeThread;
    }

    const archivedThreads = await this.listThreads({
      backend: params.backend,
      archived: true,
      callerReason: "archive-cleanup",
    });
    const archivedThread = archivedThreads.find((thread) => thread.id === params.threadId);
    if (archivedThread) {
      return archivedThread;
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

  private async resolveCodexThreadTurnCwd(
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined> {
    const overlayCwd = resolveLinkedDirectoryWorkspaceCwd(
      overlay?.extraLinkedDirectories,
    );
    if (overlayCwd?.trim()) {
      return overlayCwd.trim();
    }

    const pendingThread = this.pendingStartedThreads.get(`codex:${threadId}`);
    const pendingCwd = resolveThreadWorkspaceCwd(pendingThread);
    if (pendingCwd?.trim()) {
      return pendingCwd.trim();
    }

    const thread = await this.findThreadForWorkspaceHandoff({
      backend: "codex",
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
    backend: AppServerBackendKind;
    thread: AppServerThreadSummary;
  }): Promise<ArchiveThreadCleanupResult[]> {
    const candidates: WorktreeArchiveCandidate[] =
      params.thread.linkedDirectories.flatMap((directory) => {
        const worktreePath =
          directory.worktreePath ?? (directory.kind === "worktree" ? directory.path : undefined);
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

      if (params.backend === "codex") {
        await this.withCodexThreadClient(params.threadId, async (client) =>
          await this.renameWithClient(client, params.threadId, result.title)
        );
      } else {
        await this.renameWithClient(this.grokClient, params.threadId, result.title);
      }
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
    const key = buildPendingRequestKey({
      backend,
      threadId: request.params.threadId,
      requestId: request.params.requestId,
    });

    return await new Promise<SubmitServerRequestRequest["response"]>((resolve, reject) => {
      this.pendingServerRequests.set(key, { resolve, reject });

      this.emit({
        backend,
        notification: request as AppServerNotification,
      }).catch((error) => {
        this.pendingServerRequests.delete(key);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async emit(event: AgentEvent): Promise<void> {
    if (
      event.backend === "codex" &&
      event.notification.method === "turn/started"
    ) {
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
      const key = buildActiveTurnModeKey(
        notification.params.threadId,
        turnId,
      );
      if (!this.activeCodexTurnModes.has(key)) {
        this.activeCodexTurnModes.set(
          key,
          await this.resolveCodexThreadExecutionModeForActiveTurn(
            notification.params.threadId,
          ),
        );
      }
    }

    if (
      event.backend === "codex" &&
      (event.notification.method === "turn/completed" ||
        event.notification.method === "turn/failed" ||
        event.notification.method === "turn/cancelled")
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
        const activeTurnModeKey = buildActiveTurnModeKey(
          notification.params.threadId,
          turnId,
        );
        const wasKnownActiveTurn =
          !turnId.startsWith("pending:") &&
          this.activeCodexTurnModes.has(activeTurnModeKey);
        this.activeCodexTurnModes.delete(activeTurnModeKey);
        if (wasKnownActiveTurn) {
          await this.adoptThreadBranchChangeFromActiveTurn({
            backend: event.backend,
            threadId: notification.params.threadId,
          });
        }
      }
      // Turn-end is the resume boundary — flush any queued mode change
      // now. Fire-and-forget; failures are logged + retried inside
      // flushQueuedExecutionModeIfPresent.
      void this.flushQueuedExecutionModeIfPresent(
        notification.params.threadId,
      );
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "thread/status/changed" &&
      readStatusType(event.notification.params.status) !== "active"
    ) {
      const keyPrefix = `${event.notification.params.threadId}:`;
      let hadKnownActiveTurn = false;
      for (const key of this.activeCodexTurnModes.keys()) {
        if (key.startsWith(keyPrefix)) {
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
      void this.flushQueuedExecutionModeIfPresent(
        event.notification.params.threadId,
      );
    }

    if (event.notification.method === "serverRequest/resolved") {
      const key = buildPendingRequestKey({
        backend: event.backend,
        threadId: event.notification.params.threadId,
        requestId: event.notification.params.requestId,
      });
      const pending = this.pendingServerRequests.get(key);
      if (pending) {
        this.pendingServerRequests.delete(key);
        pending.resolve({ decision: "cancel" });
      }
    }

    for (const listener of this.eventListeners) {
      await listener(event);
    }
  }
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
