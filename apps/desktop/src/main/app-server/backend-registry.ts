import { app } from "electron";
import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { OverlayStoreLike } from "../state/overlay-store-sqlite";
import {
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
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAccountSummary,
  type BackendCapabilities,
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
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreWorktreeRequest,
  type RestoreWorktreeResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type SetThreadExecutionModeRequest,
  type SetThreadExecutionModeResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadResponse,
  type SubmitServerRequestRequest,
  type SubmitServerRequestResponse,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type UpdateThreadExpectedBranchRequest,
  type UpdateThreadExpectedBranchResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
} from "@pwragent/shared";
import { CodexAppServerClient } from "../codex-app-server/client";
import { GrokAppServerClient } from "../grok-app-server/client";
import { createScratchProjectDirectory } from "./scratch-projects";
import { getDesktopOverlayStore } from "./desktop-overlay-store";
import { createProtocolCaptureFromEnv } from "../testing/protocol-capture";
import type { ProtocolCaptureStore } from "../testing/capture-store";
import { createReplayClientsFromEnv } from "../testing/replay-runtime";
import { CodexSessionMetadataService } from "./codex-session-metadata-service";
import { GitDirectoryService } from "./git-directory-service";
import { GitWorkspaceHandoffService } from "./git-workspace-handoff-service";
import { WorktreeArchiveService } from "./worktree-archive-service";
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

type InitializeResult = {
  serverInfo?: {
    name?: string;
    version?: string;
  };
  methods?: string[];
};

const isDevelopment = process.env.NODE_ENV !== "production";
const REPLAY_THREAD_TITLE_ENV = "PWRAGENT_REPLAY_THREAD_TITLE";
const THREAD_LIST_REUSE_WINDOW_MS = 750;
const backendRegistryLog = getMainLogger("pwragent:backend-registry");
const execFile = promisify(execFileCallback);

function logDebug(event: string, payload: Record<string, unknown>): void {
  if (!isDevelopment) {
    return;
  }

  backendRegistryLog.info(event, payload);
}

type BackendClient = {
  close(): Promise<void>;
  getInitializeResult(): Promise<InitializeResult>;
  listThreads(
    params?: { archived?: boolean; filter?: string },
    diagnostics?: { callerReason?: string; ownerId?: string },
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
  }): Promise<{ threadId: string; turnId: string }>;
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

function resolveThreadGitSourcePath(
  thread: AppServerThreadSummary | undefined,
  overlayDirectories: AppServerThreadSummary["linkedDirectories"] = [],
): string | undefined {
  if (!thread) {
    return undefined;
  }

  const linkedDirectories = [
    ...overlayDirectories,
    ...thread.linkedDirectories,
  ];

  return resolveLinkedDirectoryCwd(linkedDirectories) ?? thread.projectKey;
}

function resolveLinkedDirectoryCwd(
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
  return directories.some(
    (directory) =>
      directory.id.startsWith("pwragent-handoff:") ||
      directory.id.startsWith("pwragnt-handoff:"),  // legacy prefix from pre-rebrand data
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

function normalizeLinkedDirectoryKind(
  directory: LinkedDirectorySummary,
): LinkedDirectorySummary {
  if (directory.kind === "local" && directory.worktreePath?.trim()) {
    return {
      ...directory,
      kind: "worktree",
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

function buildCodexClientArgs(mode: ThreadExecutionMode): string[] {
  if (mode !== "full-access") {
    return [];
  }

  return [
    "-c",
    'approval_policy="never"',
    "-c",
    'sandbox_mode="danger-full-access"',
  ];
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
  | "title-generation"
  | "workspace-handoff"
  | (string & {});

type ThreadListCacheState = {
  expiresAt?: number;
  promise?: Promise<AppServerThreadSummary[]>;
  threads?: AppServerThreadSummary[];
};

let threadListCacheSequence = 0;

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
  private readonly codexDefaultClient: BackendClient;
  private readonly codexFullAccessClient: BackendClient;
  private readonly grokClient: BackendClient;
  private readonly overlayStore: OverlayStoreLike;
  private readonly gitDirectoryService: GitDirectoryService;
  private readonly codexSessionMetadataService: CodexSessionMetadataService;
  private readonly gitWorkspaceHandoffService: GitWorkspaceHandoffService;
  private readonly worktreeArchiveService: WorktreeArchiveService;
  private readonly createScratchProjectDirectory: () => Promise<string>;
  private readonly threadTitleGenerationService?: ThreadTitleService;
  private readonly modelCatalog: BackendModelCatalog;
  private readonly threadListCacheOwnerId = `backend-thread-list-cache-${++threadListCacheSequence}`;
  private readonly threadListCache = new Map<string, ThreadListCacheState>();
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
  private readonly attemptedTitleGenerations = new Set<string>();
  private titleGenerationSequence = 0;

  constructor(options?: {
    codexClient?: BackendClient;
    codexFullAccessClient?: BackendClient;
    grokClient?: BackendClient;
    overlayStore?: OverlayStoreLike;
    gitDirectoryService?: GitDirectoryService;
    codexSessionMetadataService?: CodexSessionMetadataService;
    gitWorkspaceHandoffService?: GitWorkspaceHandoffService;
    worktreeArchiveService?: WorktreeArchiveService;
    createScratchProjectDirectory?: () => Promise<string>;
    threadTitleGenerationService?: ThreadTitleService | null;
  }) {
    const replayClients = createReplayClientsFromEnv();
    const codexDefaultCapture = options?.codexClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "codex",
          backendInstance: "default",
        });
    if (codexDefaultCapture) {
      this.captureStores.push(codexDefaultCapture.store);
    }
    const codexDefaultObserver = createCompositeJsonRpcObserver([
      codexDefaultCapture?.observer,
      createProtocolLogObserverFromEnv({
        backend: "codex",
      }),
    ]);
    const codexFullAccessCapture = options?.codexFullAccessClient
      || replayClients
      ? undefined
      : createProtocolCaptureFromEnv({
          backend: "codex",
          backendInstance: "full-access",
        });
    if (codexFullAccessCapture) {
      this.captureStores.push(codexFullAccessCapture.store);
    }
    const codexFullAccessObserver = createCompositeJsonRpcObserver([
      codexFullAccessCapture?.observer,
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
    const createsLiveCodexDefaultClient =
      !options?.codexClient && !replayClients?.codexDefaultClient;
    const createsLiveCodexFullAccessClient =
      !options?.codexFullAccessClient && !replayClients?.codexFullAccessClient;
    const codexCommand =
      createsLiveCodexDefaultClient || createsLiveCodexFullAccessClient
        ? getDesktopSettingsService().resolveCodexCommandPreference()
        : undefined;
    const createsLiveGrokClient = !options?.grokClient && !replayClients?.grokClient;
    const grokApiKey = createsLiveGrokClient
      ? resolveGrokApiKeyForLiveClient()
      : undefined;

    const clientVersion =
      typeof app?.getVersion === "function" ? app.getVersion() : "0.0.0";
    this.codexDefaultClient =
      options?.codexClient ??
      replayClients?.codexDefaultClient ??
      new CodexAppServerClient({
        command: codexCommand,
        connectionObserver: codexDefaultObserver,
        clientVersion,
      });
    this.codexFullAccessClient =
      options?.codexFullAccessClient ??
      replayClients?.codexFullAccessClient ??
      new CodexAppServerClient({
        args: buildCodexClientArgs("full-access"),
        command: codexCommand,
        connectionObserver: codexFullAccessObserver,
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
        resolveWorktreeStorage: () =>
          getDesktopSettingsService().resolveWorktreeStorage(),
      });
    this.codexSessionMetadataService =
      options?.codexSessionMetadataService ?? new CodexSessionMetadataService();
    this.worktreeArchiveService =
      options?.worktreeArchiveService ?? new WorktreeArchiveService();
    this.gitWorkspaceHandoffService =
      options?.gitWorkspaceHandoffService ??
      new GitWorkspaceHandoffService({
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
                  codex: this.codexDefaultClient.generateTitle
                    ? {
                        generateTitle: (params) =>
                          this.codexDefaultClient.generateTitle!(params),
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
      codex: this.codexDefaultClient,
      grok: this.grokClient,
    });

    this.subscribeClient("codex", this.codexDefaultClient);
    this.subscribeClient("codex", this.codexFullAccessClient);
    this.subscribeClient("grok", this.grokClient);
  }

  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
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
    filter?: string;
  } = {}): Promise<AppServerThreadSummary[]> {
    const cacheKey = this.buildThreadListCacheKey(params);
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

    const promise = this.readThreadList(params)
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
    filter?: string;
  }): Promise<AppServerThreadSummary[]> {
    const diagnostics = {
      callerReason: params.callerReason ?? "thread-list",
      ownerId: this.threadListCacheOwnerId,
    };
    if (params.backend === "codex") {
      return await this.listCodexThreads({
        archived: params.archived,
        filter: params.filter,
      }, diagnostics);
    }

    if (params.backend === "grok") {
      return this.withPendingStartedThreads(
        "grok",
        await this.grokClient.listThreads({
          archived: params.archived,
          filter: params.filter,
        }, diagnostics),
        params,
      );
    }

    const threadLists = await Promise.all([
      this.listThreads({
        backend: "codex",
        archived: params.archived,
        callerReason: params.callerReason,
        filter: params.filter,
      }),
      this.listThreads({
        backend: "grok",
        archived: params.archived,
        callerReason: params.callerReason,
        filter: params.filter,
      }).catch(() => []),
    ]);

    return threadLists
      .flat()
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
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
    const thread = await this.findThreadForArchiveCleanup({
      backend,
      threadId: request.threadId,
    });
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.archiveWithClient(client, request.threadId),
          )
        : await this.archiveWithClient(this.grokClient, request.threadId);
    this.invalidateThreadListCache(backend);
    const cleanup = thread
      ? await this.archiveThreadWorktrees({
          backend,
          thread,
        })
      : [];

    return {
      backend,
      threadId: result.threadId,
      archivedAt: Date.now(),
      cleanup,
    };
  }

  async restoreThread(
    request: RestoreThreadRequest,
  ): Promise<RestoreThreadResponse> {
    const backend = request.backend ?? "codex";
    const result =
      backend === "codex"
        ? await this.withCodexThreadClient(request.threadId, async (client) =>
            await this.restoreWithClient(client, request.threadId),
          )
        : await this.restoreWithClient(this.grokClient, request.threadId);
    this.invalidateThreadListCache(backend);

    return {
      backend,
      threadId: result.threadId,
      restoredAt: Date.now(),
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
    await this.updateCodexSessionCwdAfterHandoff({
      backend: request.backend,
      cwd: result.linkedDirectory.worktreePath ?? result.targetPath,
      threadId: request.threadId,
    });

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

    return {
      backend,
      fetchedAt: Date.now(),
      threadId: request.threadId,
      ...(replay.threadStatus ? { threadStatus: replay.threadStatus } : {}),
      replay,
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
    linkedDirectories?: LinkedDirectorySummary[];
  }): Promise<StartThreadResponse> {
    const { backend, executionMode = "default", linkedDirectories, ...request } = params;
    const modeSettings = EXECUTION_MODE_SUMMARIES[executionMode];
    const modelSettings = await this.resolveModelSettings(backend, request);
    const cwd =
      backend === "codex" && !request.cwd?.trim()
        ? await this.createScratchProjectDirectory()
        : request.cwd;

    const result = await this.getClient(backend, executionMode).startThread({
      ...request,
      ...modelSettings,
      cwd,
      approvalPolicy: request.approvalPolicy ?? modeSettings.approvalPolicy,
      sandbox: request.sandbox ?? modeSettings.sandbox,
    });
    const startedAt = Date.now();
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
        linkedDirectories: (
          linkedDirectories?.length ? linkedDirectories : buildLocalLinkedDirectory(cwd)
        ).map(normalizeLinkedDirectoryKind),
        gitBranch: cwd ? await readCurrentGitBranch(cwd).catch(() => undefined) : undefined,
      },
    );
    this.invalidateThreadListCache(backend);

    if (backend === "codex") {
      await this.overlayStore.setThreadExecutionMode({
        backend,
        threadId: result.threadId,
        executionMode,
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
      executionMode,
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
    const result =
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
    this.scheduleThreadTitleGeneration({
      backend: params.backend,
      threadId: result.threadId,
      input: params.input,
    });

    return response;
  }

  async startReview(params: StartReviewRequest): Promise<StartReviewResponse> {
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

  async setThreadExecutionMode(
    params: SetThreadExecutionModeRequest
  ): Promise<SetThreadExecutionModeResponse> {
    let resolvedThreadId = params.threadId;

    if (params.backend === "codex") {
      const modeSettings = EXECUTION_MODE_SUMMARIES[params.executionMode];
      const result = await this.withCodexThreadClient(params.threadId, async (client) => {
        if (!client.setThreadPermissions) {
          throw new Error("Selected backend does not support execution mode updates");
        }

        return await client.setThreadPermissions({
          threadId: params.threadId,
          approvalPolicy: modeSettings.approvalPolicy,
          sandbox: modeSettings.sandbox,
        });
      });

      resolvedThreadId = result.threadId;

      await this.overlayStore.setThreadExecutionMode({
        backend: "codex",
        threadId: result.threadId,
        executionMode: params.executionMode,
      });
    }
    // Non-codex backends (e.g. Grok) currently no-op on execution mode —
    // no overlay write, no backend change. We still emit on the bus so all
    // surfaces stay visually consistent with the user's click. The
    // optimistic UI is the same lie either way; symmetric emission is
    // better than partial fan-out.

    await this.emit({
      backend: params.backend,
      notification: {
        method: "thread/executionMode/updated",
        params: {
          threadId: resolvedThreadId,
          executionMode: params.executionMode,
        },
      },
    });

    return {
      backend: params.backend,
      threadId: resolvedThreadId,
      executionMode: params.executionMode,
    };
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
    const expectedBranch = resolveExpectedThreadBranch({
      overlay,
      thread,
    });
    const sourcePath = resolveThreadGitSourcePath(
      thread,
      overlay?.extraLinkedDirectories ?? [],
    );
    const observedBranch = sourcePath
      ? await readCurrentGitBranch(sourcePath).catch(() => thread?.observedGitBranch)
      : thread?.observedGitBranch;
    const normalizedObservedBranch = observedBranch?.trim() || undefined;

    await this.overlayStore.setThreadObservedBranch({
      backend: params.backend,
      threadId: params.threadId,
      branch: normalizedObservedBranch,
    });

    const drifted = isBranchDrifted(expectedBranch, normalizedObservedBranch);

    backendRegistryLog.debug("checked thread branch drift", {
      backend: params.backend,
      drifted,
      expectedBranch,
      observedBranch: normalizedObservedBranch,
      sourcePath,
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
    const existing = await this.overlayStore.getDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    const defaults = await this.resolveLaunchpadDefaults(
      await this.overlayStore.getLaunchpadDefaults(),
      request.preferredBackend,
    );
    if (existing) {
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
          updatedAt: Date.now(),
        };
        return {
          launchpad: await this.overlayStore.upsertDirectoryLaunchpad(refreshed),
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
        normalizedExisting.fastMode !== existing.fastMode
      ) {
        return {
          launchpad: await this.overlayStore.upsertDirectoryLaunchpad({
            ...normalizedExisting,
            directoryKind: request.directoryKind,
            directoryLabel: request.directoryLabel,
            directoryPath: request.directoryPath,
            updatedAt: Date.now(),
          }),
          defaults,
        };
      }

      return {
        launchpad: existing,
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
      workMode: defaultLaunchpadWorkMode(request, defaults),
      branchName: request.currentBranch,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return {
      launchpad: await this.overlayStore.upsertDirectoryLaunchpad(launchpad),
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
      launchpad: persisted,
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

  async materializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
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
    const startThreadResponse = await this.startThread({
      backend: launchpad.backend,
      executionMode: launchpad.executionMode,
      cwd: workspace.cwd,
      linkedDirectories:
        workspace.workMode === "worktree"
          ? buildWorktreeLinkedDirectory({
              label: launchpad.directoryLabel,
              repositoryPath: workspace.repositoryPath ?? launchpad.directoryPath,
              worktreePath: workspace.cwd,
            })
          : undefined,
      model: launchpad.model,
      reasoningEffort: launchpad.reasoningEffort,
      serviceTier: launchpad.serviceTier,
      fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
    });
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
    if (request.reviewTarget) {
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

    await this.overlayStore.resetDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });

    return {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      turnId,
      executionMode: startThreadResponse.executionMode,
      workMode: workspace.workMode,
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

    await this.codexDefaultClient.close();
    await this.codexFullAccessClient.close();
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
    executionMode: ThreadExecutionMode = "default",
  ): BackendClient {
    if (backend === "grok") {
      return this.grokClient;
    }

    return executionMode === "full-access"
      ? this.codexFullAccessClient
      : this.codexDefaultClient;
  }

  private buildThreadListCacheKey(params: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    filter?: string;
  }): string {
    return JSON.stringify({
      archived: params.archived === true,
      backend: params.backend ?? "all",
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

  private async listCodexThreads(params: {
    archived?: boolean;
    filter?: string;
  } = {}, diagnostics?: {
    callerReason?: string;
    ownerId?: string;
  }): Promise<AppServerThreadSummary[]> {
    const defaultThreads = await this.codexDefaultClient
      .listThreads(params, diagnostics)
      .catch(() => []);
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

    return threadsWithPending
      .map((thread) => {
        const overlay = overlaysByThreadId[thread.id];
        return {
          ...thread,
          executionMode: overlay?.executionMode ?? thread.executionMode,
        };
      })
      .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0));
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
      defaultResult,
      fullAccessResult,
      defaultModelsResult,
      defaultAccountResult,
      defaultRateLimitsResult,
    ] = await Promise.allSettled([
      this.codexDefaultClient.getInitializeResult(),
      this.codexFullAccessClient.getInitializeResult(),
      this.readCodexDefaultModelsOnce("backend-summary"),
      readClientAccount(this.codexDefaultClient),
      readClientRateLimits(this.codexDefaultClient),
    ]);
    const successful = [defaultResult, fullAccessResult].flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const methods = mergeMethods(successful);
    const available = successful.length > 0;
    const discoveredModels = [defaultModelsResult].flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    const unavailableReason = [defaultResult, fullAccessResult]
      .flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : String(result.reason)]
          : [],
      )
      .join(" ");

    return {
      kind: "codex",
      label: BACKEND_LABELS.codex,
      available,
      account:
        defaultAccountResult.status === "fulfilled" &&
        isMeaningfulAccountSummary(defaultAccountResult.value)
          ? defaultAccountResult.value
          : undefined,
      rateLimits:
        defaultRateLimitsResult.status === "fulfilled"
          ? defaultRateLimitsResult.value
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
          available: defaultResult.status === "fulfilled",
          isDefault: true,
          unavailableReason:
            defaultResult.status === "rejected"
              ? defaultResult.reason instanceof Error
                ? defaultResult.reason.message
                : String(defaultResult.reason)
              : undefined,
        },
        {
          mode: "full-access",
          label: EXECUTION_MODE_SUMMARIES["full-access"].label,
          available: fullAccessResult.status === "fulfilled",
          unavailableReason:
            fullAccessResult.status === "rejected"
              ? fullAccessResult.reason instanceof Error
                ? fullAccessResult.reason.message
                : String(fullAccessResult.reason)
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
    const overlay = await this.overlayStore.getThreadOverlayState({
      backend: "codex",
      threadId,
    });
    const preferredMode = requestedMode ?? overlay?.executionMode;
    const modes: ThreadExecutionMode[] = preferredMode
      ? [preferredMode, preferredMode === "default" ? "full-access" : "default"]
      : ["default", "full-access"];

    let lastError: unknown;
    for (const mode of modes) {
      try {
        return await operation(this.getClient("codex", mode), mode);
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
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
  }): Promise<AppServerThreadSummary | undefined> {
    const activeThreads = await this.listThreads({
      backend: params.backend,
      archived: false,
      callerReason: "archive-cleanup",
    }).catch(() => []);
    const archivedThreads = activeThreads.some((thread) => thread.id === params.threadId)
      ? []
      : await this.listThreads({
          backend: params.backend,
          archived: true,
          callerReason: "archive-cleanup",
        }).catch(() => []);

    return [...activeThreads, ...archivedThreads].find(
      (thread) => thread.id === params.threadId,
    );
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
    const overlayCwd = resolveLinkedDirectoryCwd(overlay?.extraLinkedDirectories);
    if (overlayCwd?.trim()) {
      return overlayCwd.trim();
    }

    const pendingThread = this.pendingStartedThreads.get(`codex:${threadId}`);
    const pendingCwd = resolveThreadGitSourcePath(pendingThread);
    if (pendingCwd?.trim()) {
      return pendingCwd.trim();
    }

    const thread = await this.findThreadForWorkspaceHandoff({
      backend: "codex",
      callerReason: "turn-cwd",
      threadId,
    });
    return resolveThreadGitSourcePath(thread)?.trim() || undefined;
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

  private async updateCodexSessionCwdAfterHandoff(params: {
    backend: AppServerBackendKind;
    cwd?: string;
    threadId: string;
  }): Promise<void> {
    const cwd = params.cwd?.trim();
    if (params.backend !== "codex" || !cwd) {
      return;
    }

    try {
      const result = await this.codexSessionMetadataService.updateThreadCwd({
        cwd,
        threadId: params.threadId,
      });
      if (!result.updated && result.reason !== "unchanged") {
        backendRegistryLog.warn("failed to update Codex session cwd after handoff", {
          cwd,
          reason: result.reason,
          sessionPath: result.path,
          threadId: params.threadId,
        });
      }
    } catch (error) {
      backendRegistryLog.warn("failed to update Codex session cwd after handoff", {
        cwd,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
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

    return await Promise.all(
      uniqueCandidates.map(async (candidate): Promise<ArchiveThreadCleanupResult> => {
        try {
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

          return {
            worktreePath: snapshot.worktreePath,
            branch: snapshot.sourceBranch,
            removedWorktree: true,
            deletedBranch: false,
          };
        } catch (error) {
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
      event.notification.method === "turn/completed" &&
      event.notification.params.turnId
    ) {
      this.activeCodexTurnModes.delete(
        buildActiveTurnModeKey(
          event.notification.params.threadId,
          event.notification.params.turnId,
        ),
      );
    }

    if (
      event.backend === "codex" &&
      event.notification.method === "thread/status/changed" &&
      readStatusType(event.notification.params.status) !== "active"
    ) {
      const keyPrefix = `${event.notification.params.threadId}:`;
      for (const key of this.activeCodexTurnModes.keys()) {
        if (key.startsWith(keyPrefix)) {
          this.activeCodexTurnModes.delete(key);
        }
      }
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
