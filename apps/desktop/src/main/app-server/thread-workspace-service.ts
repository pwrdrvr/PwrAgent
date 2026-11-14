import type { RegistryContext, RegistryHost } from "./registry-context";
import type { ThreadArchiveCoordinator } from "./thread-archive-coordinator";
import { ThreadTurnStartLifecycle } from "@pwragent/owner-core/thread-turn-start-lifecycle";
import {
  type ThreadRenameOptions,
} from "@pwragent/owner-core/thread-naming-lifecycle";
import { checkAgentAccessRequest } from "../agent-tools/agent-access-ceiling";
import {
  resolveModelOptionReference,
} from "@pwragent/shared";
import {
  buildProjectPausedThreadMessageRefusal,
  PROJECT_PAUSED_ERROR_CODE,
  projectRefusesThreadMessages,
} from "@pwragent/shared";
import {
  isRemoteLaunchpadStorageKey,
  type FederationTarget,
} from "@pwragent/shared";
import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  type AcpBackendId,
  buildThreadMarkdownLink,
  buildThreadUrl,
  shortenDerivedThreadTitle,
  type AgentEvent,
  type AppServerPendingRequestNotification,
  type AppServerThreadMessageOrigin,
  type AppServerToolRequestUserInputResponse,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAcpSessionRuntimeState,
  type CodexThreadEnvironmentRuntime,
  type CreatedThreadEnvironmentReport,
  type BackendLaunchpadOptions,
  type ForkThreadResponse,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type LinkedDirectorySummary,
  type NavigationLaunchpadDraft,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type MoveThreadToMainCheckoutRequest,
  type MoveThreadToMainCheckoutResponse,
  type RecreateThreadWorktreeRequest,
  type RecreateThreadWorktreeResponse,
  DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY,
  type MoveThreadWorkspacePhase,
  type MoveThreadWorkspaceResult,
  type PendingThreadHandoffPhase,
  type PendingThreadHandoffSummary,
  type PendingThreadWorkspaceMoveSummary,
  type PwrAgentThreadOrchestrationRequest,
  type PwrAgentThreadOrchestrationResponse,
  type HandoffTaskResult,
  type HandoffTaskSeedMode,
  type HandoffTaskGroupingMode,
  type HandoffTaskWorkspaceMode,
  type HandoffTaskInheritedSettings,
  type HandoffTaskMessagingAttachment,
  type ThreadHandoffOriginWorkspace,
  type StartThreadRequest,
  type StartThreadResponse,
  type SubmitServerRequestRequest,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type ThreadWorkspaceHandoffDirection,
  type ThreadWorkspaceHandoffStrategy,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  buildThreadIdentityKey,
  insertSubthreadIdAfter,
  isAcpBackendId,
  isAppServerBackendKind,
  THREAD_ENVIRONMENT_NONE,
} from "@pwragent/shared";
import {
  ACP_LIVE_HANDOFF_UNSUPPORTED_ERROR,
  acpSessionHasConversationHistory,
  type AcpRuntimeClient,
  type AcpSessionMetadata,
} from "./acp-backend-adapter";
import {
  type PwrAgentMessagingHandler,
} from "../agent-tools/pwragent-messaging-agent-tools";
import {
  GitDirectoryService,
  UNPUBLISHED_BASE_BRANCH_WORKTREE_REASON,
} from "./git-directory-service";
import type {
  GitWorkspaceInspection,
  WorktreeBaseSource,
} from "./git-directory-service";
import {
  ThreadInfoStore,
} from "./thread-info-store";
import { GitWorkspaceHandoffService } from "./git-workspace-handoff-service";
import { WorktreeArchiveService } from "./worktree-archive-service";
import { WorktreeRecoveryService } from "./worktree-recovery-service";
import { detectMissingThreadWorkspace } from "./missing-thread-workspace";
import { acpRuntimeSupportsSessionLoad } from "../acp/acp-runtime-capabilities";
import { getMainLogger } from "../log";
import {
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  listCodexEnvironmentOptions,
  resolveCodexEnvironmentSelector,
} from "./codex-environment-config";
import { describeCreatedThreadEnvironment } from "./created-thread-environment";
import {
  ThreadTurnQueue,
} from "@pwragent/owner-core/thread-turn-queue";
import {
  getProjectForgeAutomationIndex,
} from "./project-forge-automation-index";
import {
  type AcceptedThreadControlRequest,
  type BackendClient,
  type BackendRegistryForkThreadRequest,
  type HandoffSourceSettings,
  type ModelSettings,
  type PendingServerRequest,
  type ThreadListCallerReason,
} from "./backend-registry-types";
import {
  ACTIVE_TURN_HANDOFF_ERROR,
  ACTIVE_TURN_WORKSPACE_RECOVERY_ERROR,
  CLAUDE_WORKSPACE_MOVE_FAILED_WARNING,
  CODEX_WORKSPACE_CWD_SYNC_PENDING_WARNING,
  isCodexMissingThreadError,
  pathExists,
  threadOrchestrationFailure,
} from "./backend-registry-runtime-helpers";
import { executionModeSettings } from "./execution-mode-settings";
import {
  buildActiveTurnModeKey,
  buildPendingRequestKey,
} from "./thread-turn-keys";
import {
  HANDOFF_CWD_TRUST_APPROVE_LABEL,
  HANDOFF_CWD_TRUST_QUESTION_ID,
  directoryContainsPath,
  isHandoffDirectory,
  linkedDirectoriesActiveWorkspaceCoversCwd,
  linkedDirectoryMatchesCwd,
  normalizeHandoffTaskCwd,
  normalizeLinkedDirectoryIdentityPath,
  normalizeWorktreePathForComparison,
  readCurrentGitBranch,
  resolveThreadWorkspaceCwd,
  sameHandoffProjectBoundary,
  shouldInheritHandoffCodexEnvironmentRuntime,
  threadWorkspaceIsWorktree,
  toDirectoryId,
  toForwardSlashes,
} from "./linked-directory-identity";
import {
  buildHandoffTaskPrompt,
  buildWorkspaceMoveFailurePrompt,
  buildWorkspaceMoveSuccessPrompt,
} from "./thread-orchestration-prompts";
import {
  parseThreadInspectionQuery,
  pendingThreadHandoffMatchesQuery,
  pendingThreadWorkspaceMoveMatchesQuery,
  truncateThreadInspectionText,
} from "./thread-inspection-summaries";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** The collaborators and the service the composition root supplies to this module. */
export interface ThreadWorkspaceServiceDependencies {
  readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  readonly gitWorkspaceHandoffService: GitWorkspaceHandoffService;
}

/**
 * Registry-owned state and operations the workspace service reads. The
 * registry's construction ports satisfy it; this module never imports the
 * registry. Codex turn activity, the turn queue and starts, accepted
 * tool-call replays, the Git directory service, linked directories and
 * launchpads, and missing Codex thread tracking stay registry-owned.
 */
export interface ThreadWorkspaceServiceHost {
  readonly acceptedHandoffTaskRequests: Map<string, AcceptedThreadControlRequest>;
  readonly activeCodexTurnModes: ReadonlyMap<string, ThreadExecutionMode>;
  readonly gitDirectoryService: GitDirectoryService;
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  readonly pendingStartedThreads: ReadonlyMap<string, AppServerThreadSummary>;
  readonly threadInfoStore: ThreadInfoStore;
  readonly threadStarts: ThreadTurnStartLifecycle;
  readonly threadTurnQueue: ThreadTurnQueue;
  readonly worktreeArchiveService: WorktreeArchiveService;
  readonly worktreeRecoveryService: WorktreeRecoveryService;
  admitNewThreadModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings & { acpRuntime?: BackendAcpSessionRuntimeState },
  ): Promise<ModelSettings>;
  assertThreadNotHandingOff(backend: AppServerBackendKind, threadId: string): void;
  assertThreadNotLocked(backend: AppServerBackendKind, threadId: string): Promise<void>;
  clearMissingCodexThread(threadId: string): void;
  dispatchMessagingRequest(
    request: Parameters<PwrAgentMessagingHandler>[0],
  ): Promise<Awaited<ReturnType<PwrAgentMessagingHandler>>>;
  ensureDirectoryLaunchpad(
    request: EnsureDirectoryLaunchpadRequest,
    options?: {
      /**
       * A remote viewer may persist the draft here, but its matching local path
       * is never a valid source of environment/filesystem metadata.
       */
      skipFilesystemInspection?: boolean;
      /**
       * The same viewer's draft must not take this machine's MCP defaults
       * either. Connection ids are per machine and the two built-ins share
       * theirs everywhere, so a local "PwrSnap for new threads" would select
       * the *remote* machine's PwrSnap on a thread the operator never chose
       * it for there.
       */
      skipMcpConnectionDefaults?: boolean;
      /**
       * The instance that owns `directoryKey`. A peer's draft is stored under
       * a key that names the peer (`launchpadStorageKey`), so it never shares
       * a row with this machine's draft for the same key. The response keeps
       * the owner's key.
       */
      owner?: FederationTarget;
    },
  ): Promise<EnsureDirectoryLaunchpadResponse>;
  findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    freshness?: "last-known" | "provider";
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined>;
  forkThread(
    request: BackendRegistryForkThreadRequest,
  ): Promise<ForkThreadResponse>;
  getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendLaunchpadOptions | undefined>;
  getCachedThreadSummary(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): AppServerThreadSummary | undefined;
  getClient(backend: AppServerBackendKind, executionMode?: ThreadExecutionMode): BackendClient;
  getTurnInputAttachments(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): AppServerTurnInputItem[];
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  isCodexThreadKnownMissing(threadId: string): boolean;
  isLiveDynamicToolCall(
    backend: AppServerBackendKind,
    call: { threadId: string; turnId?: string },
  ): boolean;
  publishIncomingWork(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    messageOrigin?: AppServerThreadMessageOrigin;
  }, turnId: string, recipientTitle?: string): Promise<void>;
  publishLocalEvent(event: AgentEvent): Promise<void>;
  readCausalMessagingContext(context: { backend: AppServerBackendKind; threadId: string; turnId?: string }): Promise<
    Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">
  >;
  readDelegatedTurnAncestry(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<{ parentTurnId?: string; rootTurnId?: string }>;
  recordCodexWorktreeOwnerThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
  }): Promise<void>;
  recordMissingCodexThread(threadId: string): void;
  renameThread(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse>;
  replaceWorkspaceLinkedDirectory(params: {
    resetProjectState?: boolean;
    backend: AppServerBackendKind;
    directory: LinkedDirectorySummary;
    gitBranch?: string;
    threadId: string;
    retainWorktree?: LinkedDirectorySummary;
    preserveOtherWorktrees?: boolean;
  }): Promise<ThreadOverlayState>;
  resolveAgentCallerExecutionMode(context: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode>;
  resolveCodexThreadExecutionModeForActiveTurn(
    threadId: string,
  ): Promise<ThreadExecutionMode>;
  resolveHandoffSourceExecutionMode(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode>;
  resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
    callerReason?: BackendModelCatalogCallerReason,
  ): Promise<ModelSettings>;
  resolveThread(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined>;
  resolveThreadEnvironmentCwd(
    backend: AppServerBackendKind,
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined>;
  startThread(params: {
    backend: AppServerBackendKind;
    executionMode?: ThreadExecutionMode;
    cwd?: string;
    directoryKey?: string;
    model?: string;
    approvalPolicy?: string;
    sandbox?: string;
    serviceTier?: string;
    reasoningEffort?: string;
    fastMode?: boolean;
    mcpConnectionIds?: string[];
    mcpProviderServersEnabled?: boolean;
    agent?: StartThreadRequest["agent"];
    acpRuntime?: BackendAcpSessionRuntimeState;
    workMode?: NavigationLaunchpadDraft["workMode"];
    branchName?: string;
    /** Base for a new worktree when `branchName` is unset. */
    worktreeBase?: WorktreeBaseSource;
    requiredWorkMode?: NavigationLaunchpadDraft["workMode"];
    parentThreadId?: string;
    parentThreadBackend?: AppServerBackendKind;
    parentThreadInstanceId?: string;
    prAutoDispatchEnabled?: boolean;
    tokenMiserEnabled?: boolean;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    /**
     * Run the environment's setup in the new workspace even when it is not a
     * new worktree. A named environment has never run there.
     */
    rerunCodexEnvironmentSetup?: boolean;
    linkedDirectories?: LinkedDirectorySummary[];
  }): Promise<StartThreadResponse>;
  startTurn(params: {
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
    messageOrigin?: AppServerThreadMessageOrigin;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  threadHasActiveTurn(
    threadId: string,
    backend?: AppServerBackendKind,
    ignoreCodexStartReservation?: boolean,
  ): boolean;
  updateThreadGitBranchMetadata(params: {
    backend: AppServerBackendKind;
    branch?: string;
    threadId: string;
  }): Promise<void>;
  withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    // Whether to emit the routing diagnostic. Reads (readThread) are
    // execution-mode-agnostic and get called once per thread by content
    // search, so they opt out — otherwise a single thread search spews one
    // routing line per thread. Turn/execution paths keep it on (the #203
    // security cross-check in messaging-controller relies on it).
    logRouting?: boolean,
  ): Promise<T>;
}

/**
 * The workspace handoff and move domain of the backend registry: handing a
 * thread's workspace to a new or existing checkout, moving it to the main
 * checkout, recreating a missing worktree, the instance handoff reservations,
 * the handoff_task Agent tool with its pending handoffs, the move_thread_workspace
 * Agent tool with its pending moves that wait for a turn to end, the handoff
 * trust confirmation, and the Codex workspace cwd synchronization.
 */
export class ThreadWorkspaceService {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadWorkspaceServiceHost>;
  private readonly threadArchiveCoordinator: ThreadArchiveCoordinator;

  constructor(
    context: RegistryContext,
    dependencies: ThreadWorkspaceServiceDependencies,
    host: RegistryHost<ThreadWorkspaceServiceHost>,
  ) {
    this.context = context;
    this.host = host;
    this.threadArchiveCoordinator = dependencies.threadArchiveCoordinator;
    this.gitWorkspaceHandoffService = dependencies.gitWorkspaceHandoffService;
  }

  /** Threads reserved by an instance handoff, for the registry's busy and live-event checks. */
  get threadHandoffReservationRecords(): ReadonlySet<string> {
    return this.threadHandoffReservations;
  }

  /** Workspace moves by thread, for the registry's in-progress snapshot. */
  get pendingThreadWorkspaceMoveRecords(): ReadonlyMap<string, PendingThreadWorkspaceMoveSummary> {
    return this.pendingThreadWorkspaceMoves;
  }

  /** Codex workspace cwd synchronizations in flight, for the registry's test settle helper. */
  get pendingCodexWorkspaceCwdSyncRecords(): ReadonlyMap<string, { cwd: string; promise: Promise<void> }> {
    return this.pendingCodexWorkspaceCwdSyncs;
  }

  private readonly gitWorkspaceHandoffService: GitWorkspaceHandoffService;

  private readonly pendingThreadHandoffs = new Map<string, PendingThreadHandoffSummary>();

  private readonly pendingThreadWorkspaceMoves = new Map<
    string,
    PendingThreadWorkspaceMoveSummary
  >();

  private readonly threadHandoffReservations = new Set<string>();

  private readonly pendingCodexWorkspaceCwdSyncs = new Map<
    string,
    {
      cwd: string;
      promise: Promise<void>;
    }
  >();

  /**
   * What a thread handed off from this one inherits when the request names
   * nothing: its access mode, model, reasoning effort, and speed. handoff_task
   * and a to-do's Start thread both start from it, so a handoff from a Full
   * Access thread on GPT-6.1-Sol does not quietly become a Default Access
   * thread on the catalog's default model.
   */
  async readThreadHandoffSettings(params: {
    backend: AppServerBackendKind;
    threadId: string;
    /** The live turn asking, whose mode outranks the stored one. */
    turnId?: string;
  }): Promise<HandoffSourceSettings> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    return {
      executionMode: await this.host().resolveHandoffSourceExecutionMode({
        ...params,
        overlay,
      }),
      ...(overlay?.model ? { model: overlay.model } : {}),
      ...(overlay?.reasoningEffort
        ? { reasoningEffort: overlay.reasoningEffort }
        : {}),
      ...(overlay?.serviceTier ? { serviceTier: overlay.serviceTier } : {}),
      ...(overlay?.fastMode !== undefined ? { fastMode: overlay.fastMode } : {}),
      ...(overlay?.codexEnvironmentRuntime?.environmentId
        && overlay.codexEnvironmentRuntime.executionTarget === "local"
        ? { codexEnvironmentRuntime: overlay.codexEnvironmentRuntime }
        : {}),
    };
  }

  async rebindAcpSessionForWorkspace(
    client: AcpRuntimeClient,
    session: AcpSessionMetadata,
  ): Promise<AcpSessionMetadata> {
    if (acpSessionHasConversationHistory(session)) {
      await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([session.cwd ?? ""], async () => await client.ensureSession(session));
      const rebound = { ...session };
      delete rebound.requiresAgentSessionRebind;
      this.context.providers.acp.upsertSession(rebound);
      return rebound;
    }
    return await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([session.cwd ?? ""], async () => await client.startSession({
      sessionId: session.sessionId,
      cwd: session.cwd,
      executionMode: session.executionMode,
      title: session.title,
      createdAt: session.createdAt,
    }));
  }

  async assertAcpSessionCanRebindForWorkspace(
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

  async handoffThreadWorkspace(
    request: HandoffThreadWorkspaceRequest,
  ): Promise<HandoffThreadWorkspaceResponse> {
    return await this.threadArchiveCoordinator.withThreadLifecycleMutation(request, async () => await this.handoffThreadWorkspaceWithoutArchiveLock(request));
  }

  private async handoffThreadWorkspaceWithoutArchiveLock(request: HandoffThreadWorkspaceRequest): Promise<HandoffThreadWorkspaceResponse> {
    await this.host().assertThreadNotLocked(request.backend, request.threadId);
    this.host().assertThreadNotHandingOff(request.backend, request.threadId);
    if (this.host().threadHasActiveTurn(request.threadId, request.backend)) {
      throw new Error(ACTIVE_TURN_HANDOFF_ERROR);
    }
    // Before any file moves: Claude refuses while it runs a turn or a task.
    if (request.backend === "claude") this.context.providers.claude.assertWorkspaceMovable(request.threadId);
    if (isAcpBackendId(request.backend)) {
      await this.assertAcpWorkspaceHandoffAllowed({
        backend: request.backend,
        threadId: request.threadId,
      });
    }

    const thread = await this.host().findThreadForWorkspaceHandoff({
      backend: request.backend,
      threadId: request.threadId,
    });
    if (!thread && request.direction === "to-project") {
      throw new Error("Thread workspace metadata is unavailable for handoff.");
    }
    const projectMoveOverlay = request.direction === "to-project"
      ? await this.context.stores.threads.getThreadOverlayState(request)
      : undefined;
    if (request.direction === "to-project") {
      const runtime = projectMoveOverlay?.codexEnvironmentRuntime;
      if (runtime && (
        runtime.executionTarget !== "local"
        || runtime.actionStatus === "started"
        || runtime.actionRuns?.some((run) => run.status === "started")
      )) {
        throw new Error("Stop environment actions and use a local runtime before moving to another project.");
      }
    }
    const candidate = request.direction === "to-project"
      ? {}
      : this.resolveHandoffWorkspaceCandidate(thread, request);
    const workspaceDirectories = request.direction === "to-project"
      ? [
          ...(thread?.linkedDirectories ?? []),
          ...(projectMoveOverlay?.extraLinkedDirectories ?? []),
        ]
      : undefined;
    const sourceWorkMode: "local" | "worktree" = workspaceDirectories
      && threadWorkspaceIsWorktree(thread, projectMoveOverlay?.extraLinkedDirectories)
      ? "worktree"
      : "local";
    // PR workspace provenance survives an earlier project relink that lost
    // its directory. Git still validates every candidate against the target
    // repository's registered worktrees before it can be reused.
    const workspacePaths = workspaceDirectories ? [
      ...workspaceDirectories.filter((directory) => directory.kind === "worktree")
        .map((directory) => directory.worktreePath ?? directory.path),
      ...(projectMoveOverlay?.prs ?? []).flatMap((pr) => pr.linkedDirectoryPaths ?? []),
    ] : undefined;
    const sourcePath = request.sourcePath ?? candidate.sourcePath;
    const sourceWorktreeIsExternal = request.direction === "worktree-to-worktree"
      && await this.threadWorktreeIsExternal(request, thread, sourcePath);
    const result = await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([sourcePath, request.targetPath].filter((value): value is string => Boolean(value)), async () => await this.gitWorkspaceHandoffService.handoff({
      ...request,
      ...(sourceWorktreeIsExternal ? { keepSourceWorktree: true } : {}),
      ...(workspacePaths ? {
        workspacePaths,
        sourceWorkMode,
        // Persisted links carry ownership. A provider-discovered worktree or
        // PR path alone must not grant cleanup ownership to this thread.
        workspaceDirectories: [
          ...(projectMoveOverlay?.extraLinkedDirectories ?? []),
          ...(workspaceDirectories ?? []).filter((directory) => directory.worktreeOwnership === "external"),
        ],
      } : {}),
      repositoryPath: request.repositoryPath ?? candidate.repositoryPath,
      sourcePath,
      sourceBranch: request.sourceBranch ?? candidate.sourceBranch,
    }));
    // A fresh start leaves the previous worktree on disk, and its changes may
    // not be this thread's. Keep a worktree this thread owns tracked, so
    // archiving the thread still checkpoints and removes it.
    // Spell it the way the handoff service spells worktree paths, so a later
    // move back into it matches and drops it.
    const retainedPath = request.baseRef?.trim()
      && request.direction === "worktree-to-worktree"
      && !sourceWorktreeIsExternal
      && sourcePath
      ? toForwardSlashes(await realpath(sourcePath).catch(() => sourcePath))
      : undefined;
    const retainWorktree: LinkedDirectorySummary | undefined = retainedPath
      ? {
          id: `pwragent-retained-worktree:${request.backend}:${request.threadId}:${retainedPath}`,
          kind: "worktree",
          label: result.linkedDirectory.label,
          path: result.repositoryPath,
          worktreePath: retainedPath,
        }
      : undefined;
    const resultBranch =
      result.strategy === "detached-changes"
        ? (result.workMode === "local"
            ? await readCurrentGitBranch(result.targetPath).catch(() => undefined)
            : undefined) ?? "HEAD"
        : result.branch;

    await this.host().replaceWorkspaceLinkedDirectory({
      backend: request.backend,
      threadId: request.threadId,
      directory: result.linkedDirectory,
      gitBranch: resultBranch,
      ...(request.direction === "to-project" ? { resetProjectState: true } : {}),
      ...(retainWorktree ? { retainWorktree } : {}),
    });
    const workspaceCwd =
      result.linkedDirectory.worktreePath ?? result.targetPath;
    let workspaceCwdSyncPending = false;
    try {
      await this.updateThreadWorkspaceCwd({
        backend: request.backend,
        threadId: request.threadId,
        cwd: workspaceCwd,
        linkedDirectory: result.linkedDirectory,
      });
    } catch (error) {
      workspaceCwdSyncPending = true;
      backendRegistryLog.warn(
        "Codex workspace CWD synchronization failed after committed handoff; will retry",
        {
          error: error instanceof Error ? error.message : String(error),
          threadId: request.threadId,
          workspaceCwd,
        },
      );
    }
    if (request.backend === "codex") {
      this.host().invalidateThreadListCache("codex");
    }
    await this.host().updateThreadGitBranchMetadata({
      backend: request.backend,
      threadId: request.threadId,
      branch: resultBranch,
    });
    this.updateAcpSessionWorkspaceAfterHandoff({
      backend: request.backend,
      threadId: request.threadId,
      cwd: result.linkedDirectory.worktreePath ?? result.targetPath,
    });
    if (result.workMode === "worktree" && result.linkedDirectory.worktreeOwnership !== "external") {
      await this.host().recordCodexWorktreeOwnerThread({
        backend: request.backend,
        threadId: request.threadId,
        worktreePath: result.linkedDirectory.worktreePath ?? result.targetPath,
      });
    }
    // Do not rewrite Codex rollout JSONL files here. Codex may still hold the
    // session file open; replacing it can orphan later transcript writes.
    if (result.archivedSourceWorktree) {
      await this.context.stores.archive.upsertWorktreeSnapshot({
        backend: request.backend,
        threadId: request.threadId,
        snapshot: result.archivedSourceWorktree,
      });
    }

    // Publish only after workspace replacement and CWD/branch synchronization
    // finish, so every selected-detail consumer can revalidate the new owner
    // configuration without depending on a full navigation refresh.
    if (projectMoveOverlay?.parentThreadId) {
      await this.context.emit({
        backend: request.backend,
        notification: {
          method: "thread/parent/cleared",
          params: { threadId: request.threadId },
        },
      });
    }
    await this.host().publishLocalEvent({
      backend: request.backend,
      notification: {
        method: "navigation/threadDirectories/updated",
        params: { reason: "selected-thread", threadIds: [request.threadId] },
      },
    });

    return workspaceCwdSyncPending
      ? {
          ...result,
          warnings: [
            ...result.warnings,
            request.backend === "claude"
              ? CLAUDE_WORKSPACE_MOVE_FAILED_WARNING
              : CODEX_WORKSPACE_CWD_SYNC_PENDING_WARNING,
          ],
        }
      : result;
  }

  /**
   * Puts a thread's deleted worktree folder back at its recorded path, on its
   * branch, with the checkpoint PwrAgent kept when it archived it. Expected
   * refusals come back as `status: "failed"` so every surface can offer the
   * next step; only unexpected errors throw.
   */
  async recreateThreadWorktree(
    request: RecreateThreadWorktreeRequest,
  ): Promise<RecreateThreadWorktreeResponse> {
    return await this.threadArchiveCoordinator.withThreadLifecycleMutation(request, async () => {
      await this.assertWorkspaceRecoveryAllowed(request);
      const { missing } = await this.resolveRecoveryWorktree(request);
      if (!missing) {
        throw new Error("This thread's worktree folder exists again. Reopen the thread to continue.");
      }
      const result = await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([request.worktreePath], async () => await this.host().worktreeRecoveryService.recreate({
        backend: request.backend,
        threadId: request.threadId,
        repositoryPath: missing.repositoryPath,
        worktreePath: missing.worktreePath,
        branch: missing.branch,
        checkpoint: missing.checkpoint,
        skipCheckpoint: request.skipCheckpoint,
        detached: request.detached,
      }));
      if (result.status !== "recreated") {
        return result;
      }

      const overlay = await this.context.stores.threads.getThreadOverlayState(request);
      const snapshot = missing.checkpoint
        ? overlay?.worktreeSnapshots?.find((candidate) =>
            candidate.snapshotRef === missing.checkpoint?.snapshotRef
            && candidate.snapshotCommit === missing.checkpoint.snapshotCommit)
        : undefined;
      if (snapshot && result.checkpoint?.restored) {
        await this.context.stores.archive.upsertWorktreeSnapshot({
          backend: request.backend,
          threadId: request.threadId,
          snapshot: { ...snapshot, state: "restored", restoredAt: result.completedAt },
        });
      }
      await this.host().updateThreadGitBranchMetadata({
        backend: request.backend,
        threadId: request.threadId,
        branch: result.branch ?? "HEAD",
      });
      this.host().invalidateThreadListCache(request.backend, true, request.threadId);
      this.host().threadInfoStore.invalidateSummaries({ backend: request.backend, threadId: request.threadId });
      await this.host().publishLocalEvent({
        backend: request.backend,
        notification: {
          method: "navigation/threadDirectories/updated",
          params: { reason: "selected-thread", threadIds: [request.threadId] },
        },
      });
      return result;
    });
  }

  /**
   * Moves a worktree thread to the main checkout the worktree belongs to,
   * leaving that checkout on whatever branch it is on. A present worktree the
   * thread owns is archived with a checkpoint, as a handoff archives it; a
   * deleted one only has Git's record of it cleared.
   */
  async moveThreadToMainCheckout(
    request: MoveThreadToMainCheckoutRequest,
  ): Promise<MoveThreadToMainCheckoutResponse> {
    return await this.threadArchiveCoordinator.withThreadLifecycleMutation(request, async () => {
      await this.assertWorkspaceRecoveryAllowed(request);
      if (request.backend === "claude") this.context.providers.claude.assertWorkspaceMovable(request.threadId);
      if (isAcpBackendId(request.backend)) {
        await this.assertAcpWorkspaceHandoffAllowed({
          backend: request.backend,
          threadId: request.threadId,
        });
      }
      const { directory } = await this.resolveRecoveryWorktree(request);
      const repositoryPath = directory.path;
      if (!(await pathExists(repositoryPath))) {
        throw new Error(`The main checkout is gone too: ${repositoryPath}`);
      }
      const worktreePath = directory.worktreePath ?? request.worktreePath;
      const warnings: string[] = [];
      let archivedWorktree: MoveThreadToMainCheckoutResponse["archivedWorktree"];
      if (await pathExists(worktreePath)) {
        if (directory.worktreeOwnership === "external") {
          warnings.push("The worktree was created outside PwrAgent, so it was left on disk.");
        } else {
          archivedWorktree = await this.host().worktreeArchiveService.archive({
            backend: request.backend,
            threadId: request.threadId,
            repositoryPath,
            worktreePath,
          });
        }
      } else {
        // Git's record of a deleted folder keeps its branch checked out.
        await this.host().worktreeRecoveryService.releaseMissingWorktree({ repositoryPath, worktreePath })
          .catch((error: unknown) => {
            warnings.push(error instanceof Error ? error.message : String(error));
          });
      }

      const branch = await readCurrentGitBranch(repositoryPath).catch(() => undefined);
      const linkedDirectory: LinkedDirectorySummary = {
        id: `pwragent-handoff:${request.backend}:${request.threadId}`,
        kind: "local",
        label: path.basename(repositoryPath),
        path: repositoryPath,
      };
      await this.host().replaceWorkspaceLinkedDirectory({
        backend: request.backend,
        threadId: request.threadId,
        directory: linkedDirectory,
        gitBranch: branch,
      });
      try {
        await this.updateThreadWorkspaceCwd({
          backend: request.backend,
          threadId: request.threadId,
          cwd: repositoryPath,
          linkedDirectory,
        });
      } catch (error) {
        warnings.push(request.backend === "claude"
          ? CLAUDE_WORKSPACE_MOVE_FAILED_WARNING
          : CODEX_WORKSPACE_CWD_SYNC_PENDING_WARNING);
        backendRegistryLog.warn(
          "Codex workspace CWD synchronization failed after moving to the main checkout; will retry",
          {
            error: error instanceof Error ? error.message : String(error),
            threadId: request.threadId,
            workspaceCwd: repositoryPath,
          },
        );
      }
      this.host().invalidateThreadListCache(request.backend, true, request.threadId);
      await this.host().updateThreadGitBranchMetadata({
        backend: request.backend,
        threadId: request.threadId,
        branch,
      });
      this.updateAcpSessionWorkspaceAfterHandoff({
        backend: request.backend,
        threadId: request.threadId,
        cwd: repositoryPath,
      });
      if (archivedWorktree) {
        await this.context.stores.archive.upsertWorktreeSnapshot({
          backend: request.backend,
          threadId: request.threadId,
          snapshot: archivedWorktree,
        });
      }
      await this.host().publishLocalEvent({
        backend: request.backend,
        notification: {
          method: "navigation/threadDirectories/updated",
          params: { reason: "selected-thread", threadIds: [request.threadId] },
        },
      });
      return {
        backend: request.backend,
        threadId: request.threadId,
        repositoryPath,
        ...(branch ? { branch } : {}),
        linkedDirectory,
        ...(archivedWorktree ? { archivedWorktree } : {}),
        warnings,
        completedAt: Date.now(),
      };
    });
  }

  /**
   * True when the thread's link to this worktree says PwrAgent did not create
   * it, so moving the thread away must leave the folder on disk.
   */
  private async threadWorktreeIsExternal(
    request: { backend: AppServerBackendKind; threadId: string },
    thread: AppServerThreadSummary | undefined,
    worktreePath: string | undefined,
  ): Promise<boolean> {
    if (!worktreePath) return false;
    const overlay = await this.context.stores.threads.getThreadOverlayState(request);
    const target = normalizeWorktreePathForComparison(worktreePath);
    return [...(overlay?.extraLinkedDirectories ?? []), ...(thread?.linkedDirectories ?? [])]
      .some((directory) => directory.kind === "worktree"
        && directory.worktreeOwnership === "external"
        && normalizeWorktreePathForComparison(directory.worktreePath ?? directory.path) === target);
  }

  private async assertWorkspaceRecoveryAllowed(request: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    await this.host().assertThreadNotLocked(request.backend, request.threadId);
    this.host().assertThreadNotHandingOff(request.backend, request.threadId);
    if (this.host().threadHasActiveTurn(request.threadId, request.backend)) {
      throw new Error(ACTIVE_TURN_WORKSPACE_RECOVERY_ERROR);
    }
  }

  /**
   * The worktree the operator acted on, matched by path so a stale card can
   * never act on a different workspace than the one it showed.
   */
  private async resolveRecoveryWorktree(request: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath: string;
  }): Promise<{
    directory: LinkedDirectorySummary;
    missing: Awaited<ReturnType<typeof detectMissingThreadWorkspace>>;
  }> {
    const thread = this.host().getCachedThreadSummary(request) ?? await this.host().resolveThread(request);
    const overlay = await this.context.stores.threads.getThreadOverlayState(request);
    const requested = path.resolve(request.worktreePath);
    const directory = [...(overlay?.extraLinkedDirectories ?? []), ...(thread?.linkedDirectories ?? [])]
      .find((candidate) =>
        candidate.kind === "worktree"
        && candidate.worktreePath
        && path.resolve(candidate.worktreePath) === requested);
    if (!directory) {
      throw new Error("This thread no longer works in that worktree. Reopen the thread to see its current workspace.");
    }
    const missing = await detectMissingThreadWorkspace({
      linkedDirectories: [directory],
      gitBranch: thread?.gitBranch,
      observedGitBranch: thread?.observedGitBranch,
      worktreeSnapshots: overlay?.worktreeSnapshots ?? thread?.worktreeSnapshots,
    }, { readBranch: readCurrentGitBranch, includeHibernated: true });
    return { directory, missing };
  }

  private async assertAcpWorkspaceHandoffAllowed(params: {
    backend: AcpBackendId;
    threadId: string;
  }): Promise<void> {
    const session = this.context.providers.acp.getSession(params.backend, params.threadId);
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
    return await this.context.providers.acp.supportsLiveWorkspaceHandoff(backend);
  }

  private updateAcpSessionWorkspaceAfterHandoff(params: {
    backend: AppServerBackendKind;
    threadId: string;
    cwd: string;
  }): void {
    if (!isAcpBackendId(params.backend)) {
      return;
    }
    const session = this.context.providers.acp.getSession(params.backend, params.threadId);
    if (!session || session.cwd === params.cwd) {
      return;
    }
    this.context.providers.acp.upsertSession({
      ...session,
      cwd: params.cwd,
      requiresAgentSessionRebind: true,
      updatedAt: Math.max(session.updatedAt, Date.now()),
    });
  }

  async withThreadHandoff<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    return await this.threadArchiveCoordinator.withThreadLifecycleMutation({ backend: "codex", threadId }, async () => await this.withThreadHandoffWithoutArchiveLock(threadId, work));
  }

  private async withThreadHandoffWithoutArchiveLock<T>(threadId: string, work: () => Promise<T>): Promise<T> {
    const key = buildThreadIdentityKey("codex", threadId);
    this.host().assertThreadNotHandingOff("codex", threadId);
    if (this.host().threadStarts.hasPending({ backend: "codex", threadId })
      || !this.host().threadTurnQueue.canStartImmediately({ backend: "codex", threadId })
      || this.host().threadTurnQueue.getQueuedEntries({ backend: "codex", threadId }).length) {
      // A paused prompt never finishes on its own.
      const paused = this.host().threadTurnQueue.getQueuedEntries({ backend: "codex", threadId })
        .some((entry) => entry.paused);
      throw new Error(paused
        ? "Resume or delete paused queued prompts, and wait for source turns and queued prompts to finish before handoff."
        : "Wait for source turns and queued prompts to finish before handoff.");
    }
    this.threadHandoffReservations.add(key);
    try {
      return await work();
    } finally {
      this.threadHandoffReservations.delete(key);
    }
  }

  async allocateHandoffWorktreePath(repositoryPath: string): Promise<string> {
    return await this.host().gitDirectoryService.allocateCodexWorktreePath(repositoryPath);
  }

  async exportThreadForHandoff(threadId: string): Promise<import("@pwragent/shared").ThreadHandoffExport> {
    const client = this.host().getClient("codex", "default");
    if (!client.exportThreadForHandoff) throw new Error("This backend does not support protocol thread export.");
    const exported = await client.exportThreadForHandoff(threadId);
    const overlay = await this.context.stores.threads.getThreadOverlayState({ backend: "codex", threadId });
    const cwd = await this.host().resolveThreadEnvironmentCwd("codex", threadId, overlay);
    return { ...exported, cwd: cwd ?? exported.cwd };
  }

  private async requestHandoffCwdTrustConfirmation(params: {
    backend: AppServerBackendKind;
    cwd: string;
    executionMode: ThreadExecutionMode;
    handoffId: string;
    threadId: string;
    turnId?: string;
    itemId?: string;
    cancelLabel?: string;
    cancelDescription?: string;
  }): Promise<boolean> {
    const normalizedCwd = toDirectoryId(path.resolve(params.cwd));
    const modeLabel = executionModeSettings(params.executionMode).label;
    const requestId = `${params.handoffId}:cwd-trust`;
    const key = buildPendingRequestKey({
      backend: params.backend,
      threadId: params.threadId,
      requestId,
    });
    const notification: AppServerPendingRequestNotification = {
      method: "item/tool/requestUserInput",
      params: {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.itemId ? { itemId: params.itemId } : {}),
        requestId,
        questions: [
          {
            id: HANDOFF_CWD_TRUST_QUESTION_ID,
            header: "Trust directory",
            question: `Trust ${normalizedCwd} and allow ${modeLabel} agent threads to read, write, and delete files in it?`,
            isOther: false,
            isSecret: false,
            options: [
              {
                label: HANDOFF_CWD_TRUST_APPROVE_LABEL,
                description:
                  `Trust this directory for future ${modeLabel} agent work.`,
              },
              {
                label: params.cancelLabel ?? "Cancel handoff",
                description:
                  params.cancelDescription ??
                  "Do not add this directory or start the handoff.",
              },
            ],
          },
        ],
      },
    };

    const response = await new Promise<SubmitServerRequestRequest["response"]>(
      (resolve, reject) => {
        this.host().pendingServerRequests.set(key, {
          backend: params.backend,
          notification,
          resolve,
          reject,
        });

        void this.context.emit({
          backend: params.backend,
          notification,
        }).catch((error) => {
          backendRegistryLog.error(
            "failed to publish handoff cwd trust request; keeping request pending",
            {
              backend: params.backend,
              cwd: normalizedCwd,
              error: error instanceof Error ? error.message : String(error),
              requestId,
              threadId: params.threadId,
              turnId: params.turnId,
            },
          );
        });
      },
    );

    const answers = (response as AppServerToolRequestUserInputResponse)?.answers?.[
      HANDOFF_CWD_TRUST_QUESTION_ID
    ]?.answers;
    return Array.isArray(answers)
      ? answers.includes(HANDOFF_CWD_TRUST_APPROVE_LABEL)
      : false;
  }

  private async directoryLaunchpadCoversCwd(cwd: string): Promise<boolean> {
    const resolvedCwd = await realpath(cwd).catch(() => path.resolve(cwd));
    const launchpads = await this.context.stores.workspaces.listDirectoryLaunchpads();
    const trustedPaths: string[] = [];
    for (const launchpad of launchpads) {
      if (
        launchpad.directoryKind !== "directory"
        || !launchpad.directoryPath
        // A draft for a peer's directory names a path on the peer.
        || isRemoteLaunchpadStorageKey(launchpad.directoryKey)
      ) {
        continue;
      }
      const launchpadPath = await realpath(launchpad.directoryPath).catch(() =>
        path.resolve(launchpad.directoryPath!),
      );
      if (directoryContainsPath(launchpadPath, resolvedCwd)) {
        return true;
      }
      trustedPaths.push(launchpadPath);
    }
    if (trustedPaths.length === 0) return false;

    // A .git reference alone does not establish a worktree relationship. Only
    // registered worktrees outside the trusted directory inherit repository trust.
    const primaryPath = await this.host().gitDirectoryService
      .resolvePrimaryWorkspacePath(resolvedCwd, { requireRegisteredWorktree: true })
      .catch(() => undefined);
    if (!primaryPath) return false;
    const resolvedPrimaryPath = await realpath(primaryPath).catch(() => path.resolve(primaryPath));
    return trustedPaths.some((trustedPath) => directoryContainsPath(trustedPath, resolvedPrimaryPath));
  }

  private async ensureHandoffTrustedDirectoryLaunchpad(params: {
    cwd: string;
    parentThreadBackend: AppServerBackendKind;
    preferredBackend: AppServerBackendKind;
    parentThreadId: string;
    parentThreadTitle?: string;
  }): Promise<void> {
    const directoryPath = toDirectoryId(
      await realpath(params.cwd).catch(() => path.resolve(params.cwd)),
    );
    await this.host().ensureDirectoryLaunchpad({
      directoryKey: `directory:${directoryPath}`,
      directoryKind: "directory",
      directoryLabel: path.basename(directoryPath) || directoryPath,
      directoryPath,
      currentBranch: await readCurrentGitBranch(directoryPath).catch(() => undefined),
      parentThreadId: params.parentThreadId,
      parentThreadBackend: params.parentThreadBackend,
      parentThreadTitle: params.parentThreadTitle,
      preferredBackend: params.preferredBackend,
      registeredAt: Date.now(),
    });
  }

  async ensureThreadWorkspacePathTrusted(params: {
    operation?: "move";
    backend: AppServerBackendKind;
    cwd: string;
    executionMode: ThreadExecutionMode;
    sourceOverlay?: ThreadOverlayState;
    sourceThread?: AppServerThreadSummary;
    sourceThreadId: string;
    sourceTurnId: string;
    callId?: string;
  }): Promise<PwrAgentThreadOrchestrationResponse | undefined> {
    if (
      params.executionMode === "full-access" ||
      linkedDirectoriesActiveWorkspaceCoversCwd({
        cwd: params.cwd,
        overlay: params.sourceOverlay,
        thread: params.sourceThread,
      }) ||
      (await this.directoryLaunchpadCoversCwd(params.cwd))
    ) {
      return undefined;
    }

    const normalizedCwd = toDirectoryId(path.resolve(params.cwd));
    const confirmed = await this.requestHandoffCwdTrustConfirmation({
      backend: params.backend,
      cwd: params.cwd,
      executionMode: params.executionMode,
      handoffId: [
        params.operation === "move" ? "move-workspace" : "attach-directory",
        params.backend,
        params.sourceThreadId,
        params.sourceTurnId,
        params.callId?.trim() || randomUUID(),
      ].join(":"),
      threadId: params.sourceThreadId,
      turnId: params.sourceTurnId,
      itemId: params.callId,
      cancelLabel: params.operation === "move" ? "Cancel move" : "Cancel attachment",
      cancelDescription: params.operation === "move"
        ? "Keep the thread in its current workspace."
        : "Do not add this directory to the thread.",
    });
    if (!confirmed) {
      return threadOrchestrationFailure(
        "forbidden",
        `The operator did not approve adding ${normalizedCwd} to the ${executionModeSettings(params.executionMode).label} write scope.`,
        { cwd: normalizedCwd },
      );
    }

    await this.ensureHandoffTrustedDirectoryLaunchpad({
      cwd: params.cwd,
      parentThreadBackend: params.backend,
      preferredBackend: params.backend,
      parentThreadId: params.sourceThreadId,
      parentThreadTitle: params.sourceThread?.title,
    });
    return undefined;
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

    const fromWorktree = request.direction === "worktree-to-local"
      || request.direction === "worktree-to-worktree";
    const directory =
      fromWorktree
        ? thread.linkedDirectories.find((candidate) => candidate.kind === "worktree")
        : thread.linkedDirectories.find((candidate) => candidate.kind === "local") ??
          thread.linkedDirectories[0];
    const sourcePath =
      fromWorktree
        ? directory?.worktreePath ?? directory?.path
        : directory?.path ?? thread.projectKey;
    const repositoryPath =
      fromWorktree
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

  private async updateThreadWorkspaceCwd(params: {
    backend: AppServerBackendKind;
    cwd: string;
    /** The thread's new primary directory; Claude records it with the cwd. */
    linkedDirectory?: LinkedDirectorySummary;
    threadId: string;
  }): Promise<void> {
    const cwd = params.cwd.trim();
    this.threadArchiveCoordinator.recordArchiveWorkspaceChange(buildThreadIdentityKey(params.backend, params.threadId), [cwd]);
    if (params.backend === "claude") {
      if (!cwd || !params.linkedDirectory) {
        throw new Error("Workspace handoff did not produce a target CWD.");
      }
      // Claude reads its cwd from PwrAgent's own session metadata, and the
      // next turn resumes the same session from there.
      const linkedDirectory = params.linkedDirectory;
      await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([cwd], async () => await this.context.providers.claude.moveWorkspace({
        threadId: params.threadId,
        cwd,
        linkedDirectory,
      }));
      this.host().invalidateThreadListCache("claude", true, params.threadId, [cwd]);
      return;
    }
    if (params.backend !== "codex") {
      return;
    }

    if (!cwd) {
      throw new Error("Workspace handoff did not produce a target CWD.");
    }

    await this.host().withCodexThreadClient(params.threadId, async (client) => {
      if (!client.updateThreadWorkspace) {
        throw new Error("Codex does not support updating a thread workspace CWD.");
      }
      await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([cwd], async () => await client.updateThreadWorkspace!({
        threadId: params.threadId,
        cwd,
      }));
    });
    this.threadArchiveCoordinator.invalidateArchiveCleanupReads(params.backend, undefined, true, params.threadId, [cwd]);
    // A thread Codex can write to is a thread Codex still has. Clearing here
    // rather than in the scheduler's success path is what makes this
    // reachable: the scheduler skips every thread already recorded missing, so
    // only a caller that bypasses it — an operator-driven workspace handoff —
    // can prove the thread came back.
    this.host().clearMissingCodexThread(params.threadId);
  }

  schedulePendingCodexWorkspaceCwdSyncs(params: {
    overlaysByThreadId: Record<string, ThreadOverlayState | undefined>;
    threads: AppServerThreadSummary[];
  }): void {
    for (const thread of params.threads) {
      // Codex already told us it cannot open this thread. Retrying the
      // workspace write on every `thread/list` produced one warning per list
      // per thread forever; the missing-thread audit owns the outcome now.
      if (this.host().isCodexThreadKnownMissing(thread.id)) {
        continue;
      }
      const handoffDirectory = params.overlaysByThreadId[
        thread.id
      ]?.extraLinkedDirectories.find(isHandoffDirectory);
      if (!handoffDirectory) {
        continue;
      }

      const workspaceCwd =
        handoffDirectory.worktreePath ?? handoffDirectory.path;
      const providerCwd =
        thread.projectKey?.trim() || resolveThreadWorkspaceCwd(thread);
      if (
        normalizeLinkedDirectoryIdentityPath(providerCwd)
        === normalizeLinkedDirectoryIdentityPath(workspaceCwd)
      ) {
        continue;
      }

      this.scheduleCodexWorkspaceCwdSync({
        threadId: thread.id,
        cwd: workspaceCwd,
      });
    }
  }

  private scheduleCodexWorkspaceCwdSync(params: {
    cwd: string;
    threadId: string;
  }): void {
    const pending = this.pendingCodexWorkspaceCwdSyncs.get(params.threadId);
    if (
      pending
      && normalizeLinkedDirectoryIdentityPath(pending.cwd)
        === normalizeLinkedDirectoryIdentityPath(params.cwd)
    ) {
      return;
    }

    const promise: Promise<void> = this.updateThreadWorkspaceCwd({
      backend: "codex",
      threadId: params.threadId,
      cwd: params.cwd,
    })
      .then(() => {
        this.host().invalidateThreadListCache("codex");
      })
      .catch((error) => {
        if (isCodexMissingThreadError(error, params.threadId)) {
          this.host().recordMissingCodexThread(params.threadId);
          return;
        }
        backendRegistryLog.warn(
          "pending Codex workspace CWD synchronization failed; will retry",
          {
            error: error instanceof Error ? error.message : String(error),
            threadId: params.threadId,
            workspaceCwd: params.cwd,
          },
        );
      })
      .finally(() => {
        const current = this.pendingCodexWorkspaceCwdSyncs.get(params.threadId);
        if (current?.promise === promise) {
          this.pendingCodexWorkspaceCwdSyncs.delete(params.threadId);
        }
      });
    this.pendingCodexWorkspaceCwdSyncs.set(params.threadId, {
      cwd: params.cwd,
      promise,
    });
  }

  private startPendingThreadHandoff(
    handoff: PendingThreadHandoffSummary,
  ): PendingThreadHandoffSummary {
    this.prunePendingThreadHandoffs(handoff.createdAt);
    this.pendingThreadHandoffs.set(handoff.handoffId, handoff);
    return handoff;
  }

  private updatePendingThreadHandoff(
    handoffId: string | undefined,
    patch: Partial<
      Omit<PendingThreadHandoffSummary, "handoffId" | "createdAt">
    > & {
      phase?: PendingThreadHandoffPhase;
    },
  ): void {
    if (!handoffId) {
      return;
    }
    const current = this.pendingThreadHandoffs.get(handoffId);
    if (!current) {
      return;
    }
    const updatedAt = patch.updatedAt ?? Date.now();
    this.pendingThreadHandoffs.set(handoffId, {
      ...current,
      ...patch,
      updatedAt,
    });
  }

  private failPendingThreadHandoff(
    handoffId: string | undefined,
    error: unknown,
  ): void {
    this.updatePendingThreadHandoff(handoffId, {
      status: "failed",
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
      message: "Handoff creation failed. Do not retry unless the failure is understood.",
    });
  }

  getPendingThreadHandoffsForInspection(params: {
    backend?: AppServerBackendKind | "all";
    query?: string;
    sourceThreadId?: string;
    limit?: number;
  } = {}): PendingThreadHandoffSummary[] {
    this.prunePendingThreadHandoffs();
    const clauses = parseThreadInspectionQuery(params.query);
    const backend = params.backend;
    return [...this.pendingThreadHandoffs.values()]
      .filter((handoff) => {
        if (
          backend &&
          backend !== "all" &&
          handoff.backend !== backend &&
          handoff.sourceBackend !== backend
        ) {
          return false;
        }
        if (params.sourceThreadId && handoff.sourceThreadId !== params.sourceThreadId) {
          return false;
        }
        return pendingThreadHandoffMatchesQuery(handoff, clauses);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, params.limit ?? 10);
  }

  private prunePendingThreadHandoffs(now = Date.now()): void {
    const maxAgeMs = 60 * 60 * 1000;
    for (const [handoffId, handoff] of this.pendingThreadHandoffs) {
      if (now - handoff.updatedAt > maxAgeMs) {
        this.pendingThreadHandoffs.delete(handoffId);
      }
    }
  }

  private startPendingThreadWorkspaceMove(
    move: PendingThreadWorkspaceMoveSummary,
  ): PendingThreadWorkspaceMoveSummary {
    this.prunePendingThreadWorkspaceMoves(move.createdAt);
    this.pendingThreadWorkspaceMoves.set(move.workspaceMoveId, move);
    return move;
  }

  private updatePendingThreadWorkspaceMove(
    workspaceMoveId: string | undefined,
    patch: Partial<
      Omit<PendingThreadWorkspaceMoveSummary, "workspaceMoveId" | "createdAt">
    > & {
      phase?: MoveThreadWorkspacePhase;
    },
  ): void {
    if (!workspaceMoveId) {
      return;
    }
    const current = this.pendingThreadWorkspaceMoves.get(workspaceMoveId);
    if (!current) {
      return;
    }
    const updatedAt = patch.updatedAt ?? Date.now();
    this.pendingThreadWorkspaceMoves.set(workspaceMoveId, {
      ...current,
      ...patch,
      updatedAt,
    });
  }

  private failPendingThreadWorkspaceMove(
    workspaceMoveId: string | undefined,
    error: unknown,
    patch: Partial<PendingThreadWorkspaceMoveSummary> = {},
  ): void {
    this.updatePendingThreadWorkspaceMove(workspaceMoveId, {
      ...patch,
      status: "failed",
      phase: "failed",
      error: error instanceof Error ? error.message : String(error),
      message:
        "Workspace move failed. The original runtime workspace remains authoritative.",
    });
  }

  getPendingThreadWorkspaceMovesForInspection(params: {
    backend?: AppServerBackendKind | "all";
    query?: string;
    sourceThreadId?: string;
    limit?: number;
  } = {}): PendingThreadWorkspaceMoveSummary[] {
    this.prunePendingThreadWorkspaceMoves();
    const clauses = parseThreadInspectionQuery(params.query);
    const backend = params.backend;
    return [...this.pendingThreadWorkspaceMoves.values()]
      .filter((move) => {
        if (
          backend &&
          backend !== "all" &&
          move.backend !== backend &&
          move.sourceBackend !== backend
        ) {
          return false;
        }
        if (params.sourceThreadId && move.sourceThreadId !== params.sourceThreadId) {
          return false;
        }
        return pendingThreadWorkspaceMoveMatchesQuery(move, clauses);
      })
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, params.limit ?? 10);
  }

  private prunePendingThreadWorkspaceMoves(now = Date.now()): void {
    const maxAgeMs = 60 * 60 * 1000;
    for (const [workspaceMoveId, move] of this.pendingThreadWorkspaceMoves) {
      if (now - move.updatedAt > maxAgeMs) {
        this.pendingThreadWorkspaceMoves.delete(workspaceMoveId);
      }
    }
  }

  private pendingThreadWorkspaceMoveToResult(
    move: PendingThreadWorkspaceMoveSummary,
  ): MoveThreadWorkspaceResult {
    return {
      backend: move.backend,
      threadId: move.threadId,
      workspaceMoveId: move.workspaceMoveId,
      status: move.status,
      phase: move.phase,
      direction: move.direction,
      ...(move.strategy ? { strategy: move.strategy } : {}),
      ...(move.repositoryPath ? { repositoryPath: move.repositoryPath } : {}),
      ...(move.sourcePath ? { sourcePath: move.sourcePath } : {}),
      ...(move.sourceBranch ? { sourceBranch: move.sourceBranch } : {}),
      ...(move.leaveLocalBranch ? { leaveLocalBranch: move.leaveLocalBranch } : {}),
      ...(move.newBranchName ? { newBranchName: move.newBranchName } : {}),
      ...(move.baseRef ? { baseRef: move.baseRef } : {}),
      ...(move.targetPath ? { targetPath: move.targetPath } : {}),
      ...(move.branch ? { branch: move.branch } : {}),
      ...(move.linkedDirectory ? { linkedDirectory: move.linkedDirectory } : {}),
      ...(move.warnings ? { warnings: move.warnings } : {}),
      ...(move.continuationTurnId
        ? { continuationTurnId: move.continuationTurnId }
        : {}),
      createdAt: move.createdAt,
      updatedAt: move.updatedAt,
      message: move.message ?? "Workspace move is pending.",
      ...(move.error ? { error: move.error } : {}),
    };
  }

  async moveThreadWorkspace(
    request: PwrAgentThreadOrchestrationRequest<"move_thread_workspace">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const sourceBackend = request.context.backend;
    const sourceThreadId = request.context.threadId;
    const sourceTurnId = request.context.turnId?.trim();
    if (
      !sourceTurnId ||
      !this.host().isLiveDynamicToolCall(sourceBackend, {
        threadId: sourceThreadId,
        turnId: sourceTurnId,
      })
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "Thread workspace move tools must be invoked from a live turn.",
      );
    }
    const backend = request.args.backend ?? sourceBackend;
    if (!isAppServerBackendKind(backend)) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "backend must be a known PwrAgent backend.",
      );
    }
    if (backend !== sourceBackend) {
      return threadOrchestrationFailure(
        "unsupported_backend",
        "Thread workspace move currently supports only the invoking thread backend.",
      );
    }

    const requestedDirection = request.args.direction;
    if (requestedDirection === "worktree-to-local") {
      return threadOrchestrationFailure(
        "unsupported_workspace",
        'move_thread_workspace supports direction="local-to-worktree", "worktree-to-worktree", or "to-project".',
      );
    }

    const workspaceMoveId = [
      "workspace-move",
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      request.context.callId?.trim() || randomUUID(),
    ].join(":");
    const existing = this.pendingThreadWorkspaceMoves.get(workspaceMoveId);
    if (existing) {
      return {
        ok: true,
        data: this.pendingThreadWorkspaceMoveToResult(existing),
      };
    }

    const [sourceThread, sourceOverlay] = await Promise.all([
      this.host().findThreadForWorkspaceHandoff({
        backend: sourceBackend,
        callerReason: "agent-workspace-move",
        threadId: sourceThreadId,
      }),
      this.context.stores.threads.getThreadOverlayState({
        backend: sourceBackend,
        threadId: sourceThreadId,
      }),
    ]);

    // Without a direction, a new worktree comes from wherever the thread is.
    const direction = requestedDirection ?? (
      threadWorkspaceIsWorktree(sourceThread, sourceOverlay?.extraLinkedDirectories)
        ? "worktree-to-worktree"
        : "local-to-worktree"
    );
    const strategy = direction === "to-project"
      ? undefined
      : this.resolveMoveThreadWorkspaceStrategy(request.args);

    let targetPath: string | undefined;
    let candidate: {
      repositoryPath?: string;
      sourceBranch?: string;
      sourcePath?: string;
    };
    try {
      if (direction === "to-project") {
        if (!request.args.targetPath || !path.isAbsolute(request.args.targetPath)) {
          throw new Error("Moving to an existing workspace requires an absolute targetPath.");
        }
        targetPath = await realpath(request.args.targetPath);
        if (!(await stat(targetPath)).isDirectory()) {
          throw new Error("targetPath must be an existing directory.");
        }
        candidate = { sourcePath: resolveThreadWorkspaceCwd(sourceThread, sourceOverlay?.extraLinkedDirectories) };
      } else {
        candidate = this.resolveThreadWorkspaceMoveCandidate({
          direction,
          ...(sourceOverlay ? { overlay: sourceOverlay } : {}),
          request,
          ...(sourceThread ? { thread: sourceThread } : {}),
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return threadOrchestrationFailure(
        /ambiguous|multiple eligible/i.test(message)
          ? "ambiguous_workspace"
          : "unsupported_workspace",
        message,
      );
    }

    const duplicateResult = (): PwrAgentThreadOrchestrationResponse | undefined => {
      const duplicateMove = [...this.pendingThreadWorkspaceMoves.values()].find(
        (move) =>
          (move.status === "queued" || move.status === "running") &&
          move.sourceBackend === sourceBackend &&
          move.sourceThreadId === sourceThreadId &&
          move.sourceTurnId === sourceTurnId,
      );
      if (duplicateMove) {
        const sameSource =
          duplicateMove.direction === direction &&
          path.resolve(duplicateMove.targetPath ?? "") === path.resolve(targetPath ?? "") &&
          duplicateMove.strategy === strategy &&
          (duplicateMove.leaveLocalBranch ?? "") ===
            (request.args.leaveLocalBranch ?? "") &&
          (duplicateMove.newBranchName ?? "") ===
            (request.args.newBranchName ?? "") &&
          (duplicateMove.baseRef ?? "") === (request.args.baseRef ?? "") &&
          path.resolve(duplicateMove.sourcePath ?? "") ===
            path.resolve(candidate.sourcePath ?? "") &&
          path.resolve(duplicateMove.repositoryPath ?? "") ===
            path.resolve(candidate.repositoryPath ?? "");
        if (sameSource) {
          return {
            ok: true,
            data: this.pendingThreadWorkspaceMoveToResult(duplicateMove),
          };
        }
        return threadOrchestrationFailure(
          "unsupported_workspace",
          "A workspace move is already queued for this thread turn. Wait for the continuation before requesting another workspace move.",
        );
      }
      return undefined;
    };
    const pendingResult = duplicateResult();
    if (pendingResult) return pendingResult;

    if (targetPath) {
      const executionMode = this.host().activeCodexTurnModes.get(
        buildActiveTurnModeKey(sourceThreadId, sourceTurnId),
      ) ?? sourceOverlay?.executionMode ?? (backend === "codex"
        ? await this.host().resolveCodexThreadExecutionModeForActiveTurn(sourceThreadId)
        : "default");
      const trustFailure = await this.ensureThreadWorkspacePathTrusted({
        operation: "move",
        backend,
        cwd: targetPath,
        executionMode,
        sourceOverlay: sourceOverlay ?? undefined,
        sourceThread,
        sourceThreadId,
        sourceTurnId,
        callId: request.context.callId,
      });
      if (trustFailure) return trustFailure;
    }
    if (!this.host().isLiveDynamicToolCall(sourceBackend, { threadId: sourceThreadId, turnId: sourceTurnId })) {
      return threadOrchestrationFailure("forbidden", "The invoking turn ended before the workspace move could be queued.");
    }

    // Trust confirmation yields to other calls from this turn. Recheck with
    // no await between admission and insertion so only one move can win.
    const admittedResult = duplicateResult();
    if (admittedResult) return admittedResult;

    const now = request.context.now ?? Date.now();
    const move = this.startPendingThreadWorkspaceMove({
      workspaceMoveId,
      status: "queued",
      phase: "waiting_for_turn_boundary",
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      backend,
      threadId: sourceThreadId,
      direction,
      ...(strategy ? { strategy } : {}),
      ...(targetPath ? { targetPath } : {}),
      ...(candidate.repositoryPath ? { repositoryPath: candidate.repositoryPath } : {}),
      ...(candidate.sourcePath ? { sourcePath: candidate.sourcePath } : {}),
      ...(candidate.sourceBranch ? { sourceBranch: candidate.sourceBranch } : {}),
      ...(request.args.leaveLocalBranch
        ? { leaveLocalBranch: request.args.leaveLocalBranch }
        : {}),
      ...(request.args.newBranchName
        ? { newBranchName: request.args.newBranchName }
        : {}),
      ...(request.args.baseRef ? { baseRef: request.args.baseRef } : {}),
      createdAt: now,
      updatedAt: now,
      message:
        "Workspace move queued. Stop this turn and wait for the same-thread continuation before editing from the moved workspace.",
    });
    return {
      ok: true,
      data: this.pendingThreadWorkspaceMoveToResult(move),
    };
  }

  private resolveMoveThreadWorkspaceStrategy(
    args: PwrAgentThreadOrchestrationRequest<"move_thread_workspace">["args"],
  ): ThreadWorkspaceHandoffStrategy {
    if (args.strategy) {
      return args.strategy;
    }
    if (args.newBranchName) {
      return "new-branch";
    }
    if (args.leaveLocalBranch) {
      return "move-branch";
    }
    return DEFAULT_MOVE_THREAD_WORKSPACE_STRATEGY;
  }

  private resolveThreadWorkspaceMoveCandidate(params: {
    direction: ThreadWorkspaceHandoffDirection;
    overlay?: ThreadOverlayState;
    request: PwrAgentThreadOrchestrationRequest<"move_thread_workspace">;
    thread?: AppServerThreadSummary;
  }): {
    repositoryPath?: string;
    sourceBranch?: string;
    sourcePath?: string;
  } {
    const args = params.request.args;
    const linkedDirectories = [
      ...(params.overlay?.extraLinkedDirectories ?? []),
      ...(params.thread?.linkedDirectories ?? []),
    ];
    const sourcePath = args.sourcePath?.trim();
    if (sourcePath) {
      const resolvedSourcePath = path.resolve(sourcePath);
      const directory = linkedDirectories.find((candidate) => {
        const candidatePaths = [
          candidate.path,
          candidate.worktreePath,
        ].filter((value): value is string => Boolean(value?.trim()));
        return candidatePaths.some(
          (candidatePath) => path.resolve(candidatePath) === resolvedSourcePath,
        );
      });
      if (!directory) {
        throw new Error(
          "Workspace move sourcePath must match a linked directory for this thread.",
        );
      }
      const repositoryPath = args.repositoryPath?.trim() ?? directory.path ?? sourcePath;
      if (
        args.repositoryPath?.trim() &&
        directory.path?.trim() &&
        path.resolve(args.repositoryPath) !== path.resolve(directory.path)
      ) {
        throw new Error(
          "Workspace move repositoryPath must match the linked directory repository path for this thread.",
        );
      }
      return {
        repositoryPath,
        ...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
        sourcePath,
      };
    }

    const localDirectories = linkedDirectories.filter(
      (directory) => directory.kind === "local" && directory.path?.trim(),
    );
    const uniqueRepositoryPaths = [
      ...new Map(
        localDirectories.map((directory) => [
          path.resolve(directory.path),
          directory,
        ]),
      ).values(),
    ];
    if (uniqueRepositoryPaths.length > 1) {
      throw new Error(
        "Thread has multiple eligible workspaces for workspace move. Pass sourcePath to choose one.",
      );
    }
    const inferredThread = params.thread
      ? {
          ...params.thread,
          linkedDirectories:
            linkedDirectories.length > 0
              ? linkedDirectories
              : params.thread.linkedDirectories,
        }
      : undefined;
    const candidate = this.resolveHandoffWorkspaceCandidate(inferredThread, {
      backend: params.request.context.backend,
      threadId: params.request.context.threadId,
      direction: params.direction,
      ...(args.repositoryPath ? { repositoryPath: args.repositoryPath } : {}),
      ...(args.sourceBranch ? { sourceBranch: args.sourceBranch } : {}),
      ...(args.sourcePath ? { sourcePath: args.sourcePath } : {}),
    });
    if (!candidate.sourcePath) {
      throw new Error("Thread does not have an eligible Git workspace for handoff.");
    }
    const sourceBranch = args.sourceBranch ?? candidate.sourceBranch;
    const repositoryPath = args.repositoryPath ?? candidate.repositoryPath;
    return {
      ...(repositoryPath ? { repositoryPath } : {}),
      ...(sourceBranch ? { sourceBranch } : {}),
      sourcePath: candidate.sourcePath,
    };
  }

  drainPendingThreadWorkspaceMovesForTerminalTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): void {
    if (!params.turnId) {
      return;
    }
    const moves = [...this.pendingThreadWorkspaceMoves.values()].filter(
      (move) =>
        move.status === "queued" &&
        move.sourceBackend === params.backend &&
        move.sourceThreadId === params.threadId &&
        move.sourceTurnId === params.turnId,
    );
    for (const move of moves) {
      void this.runPendingThreadWorkspaceMove(move.workspaceMoveId);
    }
  }

  drainPendingThreadWorkspaceMovesForTurnIds(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnIds: Iterable<string>;
  }): void {
    for (const turnId of params.turnIds) {
      this.drainPendingThreadWorkspaceMovesForTerminalTurn({
        backend: params.backend,
        threadId: params.threadId,
        turnId,
      });
    }
  }

  threadHasBlockingWorkspaceMove(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): boolean {
    return [...this.pendingThreadWorkspaceMoves.values()].some(
      (move) =>
        move.backend === params.backend &&
        move.threadId === params.threadId &&
        (move.status === "queued" || move.status === "running"),
    );
  }

  private async runPendingThreadWorkspaceMove(
    workspaceMoveId: string,
  ): Promise<void> {
    const move = this.pendingThreadWorkspaceMoves.get(workspaceMoveId);
    if (!move || move.status !== "queued") {
      return;
    }
    this.updatePendingThreadWorkspaceMove(workspaceMoveId, {
      status: "running",
      phase: "preparing_workspace",
      message: "Workspace move is preparing the destination workspace.",
    });

    let handoffResult: HandoffThreadWorkspaceResponse;
    try {
      if (
        move.direction === "to-project"
        && move.targetPath
        && (await realpath(move.targetPath)) !== move.targetPath
      ) {
        throw new Error("The destination workspace changed since the move was requested. Request the move again.");
      }
      handoffResult = await this.handoffThreadWorkspace({
        backend: move.backend,
        threadId: move.threadId,
        direction: move.direction,
        ...(move.targetPath ? { targetPath: move.targetPath } : {}),
        ...(move.strategy ? { strategy: move.strategy } : {}),
        ...(move.repositoryPath ? { repositoryPath: move.repositoryPath } : {}),
        ...(move.sourcePath ? { sourcePath: move.sourcePath } : {}),
        ...(move.sourceBranch ? { sourceBranch: move.sourceBranch } : {}),
        ...(move.leaveLocalBranch ? { leaveLocalBranch: move.leaveLocalBranch } : {}),
        ...(move.newBranchName ? { newBranchName: move.newBranchName } : {}),
        ...(move.baseRef ? { baseRef: move.baseRef } : {}),
      });
      this.updatePendingThreadWorkspaceMove(workspaceMoveId, {
        phase: "updating_metadata",
        repositoryPath: handoffResult.repositoryPath,
        ...(move.sourcePath ? { sourcePath: move.sourcePath } : {}),
        targetPath: handoffResult.targetPath,
        ...(handoffResult.branch ? { branch: handoffResult.branch } : {}),
        linkedDirectory: handoffResult.linkedDirectory,
        warnings: handoffResult.warnings,
        message:
          "Workspace move updated runtime workspace metadata and is waking the same thread.",
      });
    } catch (error) {
      const handoffError = error instanceof Error ? error.message : String(error);
      this.failPendingThreadWorkspaceMove(workspaceMoveId, error);
      try {
        await this.startWorkspaceMoveContinuation({
          error,
          kind: "failure",
          moveId: workspaceMoveId,
        });
      } catch (continuationError) {
        const message =
          continuationError instanceof Error
            ? continuationError.message
            : String(continuationError);
        this.updatePendingThreadWorkspaceMove(workspaceMoveId, {
          status: "failed",
          phase: "failed",
          error: `Workspace handoff failed: ${handoffError}; failure continuation failed: ${message}`,
          message:
            "Workspace move failed, and starting the same-thread failure continuation also failed. The original runtime workspace remains authoritative.",
        });
        backendRegistryLog.warn("workspace move failure continuation failed", {
          error: message,
          workspaceMoveId,
        });
        await this.releaseThreadQueueAfterWorkspaceMoveContinuationFailure(move);
      }
      return;
    }

    try {
      await this.startWorkspaceMoveContinuation({
        kind: "success",
        moveId: workspaceMoveId,
        result: handoffResult,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.updatePendingThreadWorkspaceMove(workspaceMoveId, {
        status: "completed",
        phase: "completed",
        error: message,
        message:
          "Workspace move completed, but starting the same-thread continuation failed. Inspect the move result before retrying.",
      });
      backendRegistryLog.warn("workspace move success continuation failed", {
        error: message,
        workspaceMoveId,
      });
      await this.releaseThreadQueueAfterWorkspaceMoveContinuationFailure(move);
    }
  }

  private async releaseThreadQueueAfterWorkspaceMoveContinuationFailure(
    move: PendingThreadWorkspaceMoveSummary,
  ): Promise<void> {
    await this.host().threadTurnQueue.releaseThread({
      backend: move.backend,
      threadId: move.threadId,
      status: "workspace_move_continuation_failed",
    });
  }

  private async startWorkspaceMoveContinuation(params:
    | {
        kind: "success";
        moveId: string;
        result: HandoffThreadWorkspaceResponse;
      }
    | {
        kind: "failure";
        moveId: string;
        error: unknown;
      },
  ): Promise<void> {
    const move = this.pendingThreadWorkspaceMoves.get(params.moveId);
    if (!move) {
      return;
    }
    this.updatePendingThreadWorkspaceMove(params.moveId, {
      phase: "starting_continuation",
      message:
        params.kind === "success"
          ? "Workspace move completed; starting the same-thread continuation."
          : "Workspace move failed; starting the same-thread failure continuation.",
    });

    const prompt =
      params.kind === "success"
        ? buildWorkspaceMoveSuccessPrompt({
            move,
            result: params.result,
          })
        : buildWorkspaceMoveFailurePrompt({
            error: params.error,
            move,
          });
    const turn = await this.host().startTurn({
      backend: move.backend,
      threadId: move.threadId,
      input: [{ type: "text", text: prompt }],
      messageOrigin: { kind: "pwragent" },
    });
    this.updatePendingThreadWorkspaceMove(params.moveId, {
      status: params.kind === "success" ? "completed" : "failed",
      phase: params.kind === "success" ? "completed" : "failed",
      continuationTurnId: turn.turnId,
      message:
        params.kind === "success"
          ? "Workspace move completed and same-thread continuation started."
          : "Workspace move failed and same-thread continuation started from the original workspace.",
    });
  }

  async handoffTaskToThread(
    request: PwrAgentThreadOrchestrationRequest<"handoff_task">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const callId = request.context.callId?.trim();
    if (!callId || !this.host().isLiveDynamicToolCall(request.context.backend, request.context)) {
      return await this.performHandoffTaskToThread(request);
    }
    const handoffId = [
      "handoff",
      request.context.backend,
      request.context.threadId,
      request.context.turnId,
      callId,
    ].join(":");
    const signature = createHash("sha256")
      .update(JSON.stringify(request.args))
      .digest("hex");
    const accepted = this.host().acceptedHandoffTaskRequests.get(handoffId);
    if (accepted) {
      if (accepted.signature !== signature) {
        return threadOrchestrationFailure(
          "invalid_arguments",
          `Handoff call id ${callId} was reused with different arguments.`,
        );
      }
      return await accepted.promise;
    }

    // Admit the call before the first await in the handoff path. The backend
    // can deliver the same dynamic tool call twice while workspace setup is
    // still running; both deliveries must await one child creation.
    const promise = this.performHandoffTaskToThread(request);
    this.host().acceptedHandoffTaskRequests.set(handoffId, { promise, signature });
    return await promise;
  }

  /**
   * A handoff into a paused project that refuses messages from other
   * threads. A handoff within the source thread's own project is that
   * thread's own work, which the operator is driving, so it passes.
   */
  private handoffProjectRefusal(
    request: PwrAgentThreadOrchestrationRequest<"handoff_task">,
  ): string | undefined {
    const cwd = request.args.cwd?.trim();
    if (!cwd) return undefined;
    const index = getProjectForgeAutomationIndex();
    const target = index.resolvePath(cwd);
    if (!target || !projectRefusesThreadMessages(target.automation)) return undefined;
    const source = index.directoryKeyForThread(
      request.context,
      () => this.host().getCachedThreadSummary(request.context),
    );
    if (source === target.directoryKey) return undefined;
    return buildProjectPausedThreadMessageRefusal({ projectLabel: target.label });
  }

  private async performHandoffTaskToThread(
    request: PwrAgentThreadOrchestrationRequest<"handoff_task">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const sourceBackend = request.context.backend;
    const sourceThreadId = request.context.threadId;
    const sourceTurnId = request.context.turnId?.trim();
    const causalContext = await this.host().readCausalMessagingContext(request.context);
    if (
      !sourceTurnId ||
      !this.host().isLiveDynamicToolCall(sourceBackend, {
        threadId: sourceThreadId,
        turnId: sourceTurnId,
      })
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "Thread handoff tools must be invoked from a live turn.",
      );
    }
    const handoffRefusal = this.handoffProjectRefusal(request);
    if (handoffRefusal) return threadOrchestrationFailure(PROJECT_PAUSED_ERROR_CODE, handoffRefusal);
    const backend = request.args.backend ?? sourceBackend;
    if (!isAppServerBackendKind(backend)) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "backend must be a known PwrAgent backend.",
      );
    }

    const requestedModel = request.args.model?.trim();
    if (requestedModel) {
      const availableModels = (
        await this.host().getBackendLaunchpadOptions(backend, "agent-handoff")
      )?.models ?? [];
      // An Agent may name a provider model the way a person would, such as
      // "Refuseless / GLM-5.3 abliterated"; take it when it fits exactly one.
      const reference = resolveModelOptionReference(availableModels, requestedModel);
      if (reference.id && reference.id !== requestedModel) {
        request = { ...request, args: { ...request.args, model: reference.id } };
      }
      if (reference.candidates.length > 1) {
        return threadOrchestrationFailure(
          "invalid_arguments",
          `model="${requestedModel}" matches several models: ${reference.candidates.map((model) => model.id).join(", ")}. Pass one exact id.`,
        );
      }
      if (
        availableModels.length > 0
        && !reference.id
      ) {
        const available = availableModels.map((model) => model.id).join(", ");
        const grokGuidance =
          /grok/i.test(requestedModel) && backend !== "acp:grok"
            ? ' To request Grok, pass backend="acp:grok" and an exact discovered model ID such as model="grok-4.5".'
            : "";
        return threadOrchestrationFailure(
          "invalid_arguments",
          `model="${requestedModel}" is not available for backend="${backend}". Available models: ${available}.${grokGuidance}`,
        );
      }
    }

    const sourceOverlay =
      (await this.context.stores.threads.getThreadOverlayState({
        backend: sourceBackend,
        threadId: sourceThreadId,
      })) ??
      ({
        backend: sourceBackend,
        threadId: sourceThreadId,
        extraLinkedDirectories: [],
      } satisfies ThreadOverlayState);

    let handoffModelSettings: ModelSettings;
    try {
      // Inherited effort and speed are preferences for the source model.
      // Adapt them to the destination before layering on explicit arguments,
      // which must pass admission without silent correction.
      const inherited = await this.host().resolveModelSettings(backend, {
        ...(backend === sourceBackend ? sourceOverlay : {}),
        model: request.args.model ?? (backend === sourceBackend ? sourceOverlay.model : undefined),
      }, "agent-handoff");
      handoffModelSettings = await this.host().admitNewThreadModelSettings(backend, {
        model: request.args.model ?? inherited.model,
        reasoningEffort: request.args.reasoningEffort ?? inherited.reasoningEffort,
        serviceTier: request.args.serviceTier ?? inherited.serviceTier,
        fastMode: request.args.fastMode ?? inherited.fastMode,
      });
    } catch (error) {
      return threadOrchestrationFailure("invalid_arguments", error instanceof Error ? error.message : String(error));
    }

    const task = request.args.task.trim();
    if (!task) {
      return threadOrchestrationFailure(
        "invalid_arguments",
        "handoff_task requires a non-empty task string.",
      );
    }

    // The child starts at the caller's access or less; only the operator
    // raises it. Omitted, it inherits this mode below.
    const callerExecutionMode = await this.host().resolveAgentCallerExecutionMode({
      backend: sourceBackend,
      threadId: sourceThreadId,
      turnId: sourceTurnId,
      overlay: sourceOverlay,
    });
    const accessRefusal = checkAgentAccessRequest(callerExecutionMode, request.args);
    if (accessRefusal) {
      return threadOrchestrationFailure(accessRefusal.code, accessRefusal.message);
    }

    const seedMode: HandoffTaskSeedMode = request.args.seedMode ?? "clean";
    const requestedGroupingMode: HandoffTaskGroupingMode =
      request.args.groupingMode ?? "subthread";
    const workspaceMode: HandoffTaskWorkspaceMode =
      request.args.workspaceMode === "same"
        ? "same_workspace"
        : (request.args.workspaceMode ?? "new_worktree");
    if (workspaceMode === "same_workspace" && requestedGroupingMode !== "subthread") {
      return threadOrchestrationFailure(
        "invalid_arguments",
        'workspaceMode="same_workspace" is only valid for grouped subthread handoffs. Use workspaceMode="new_worktree" for a delegated thread with an isolated worktree, workspaceMode="project_local" for the project checkout, or workspaceMode="none" for an unscoped local thread.',
      );
    }
    const title =
      request.args.title?.trim() ||
      shortenDerivedThreadTitle(task) ||
      "Delegated task";
    const handoffStartedAt = request.context.now ?? Date.now();
    const handoffId = [
      "handoff",
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      request.context.callId?.trim() || randomUUID(),
    ].join(":");
    this.startPendingThreadHandoff({
      handoffId,
      status: "starting",
      phase: "resolving_source",
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      backend,
      title,
      taskPreview: truncateThreadInspectionText(task, 240),
      seedMode,
      groupingMode: requestedGroupingMode,
      workspaceMode,
      ...(request.args.branchName ? { branchName: request.args.branchName } : {}),
      createdAt: handoffStartedAt,
      updatedAt: handoffStartedAt,
      message:
        "Handoff creation has started. Do not retry this request while it is still starting; inspect pendingHandoffs or wait for the child threadId.",
    });
    const sourceThread = await this.host().findThreadForWorkspaceHandoff({
      backend: sourceBackend,
      callerReason: "agent-handoff",
      threadId: sourceThreadId,
    });
    const callerCwd = await this.host().resolveThreadEnvironmentCwd(
      sourceBackend,
      sourceThreadId,
      sourceOverlay,
    );
    const callerLinkedDirectory = this.resolveHandoffLinkedDirectory({
      cwd: callerCwd,
      overlay: sourceOverlay,
      thread: sourceThread,
    });
    const requestedCwd = normalizeHandoffTaskCwd(request.args.cwd);
    const sourceCwd = requestedCwd ?? callerCwd;
    const sourceLinkedDirectory = this.resolveHandoffLinkedDirectory({
      cwd: sourceCwd,
      fallbackToAnyDirectory: !requestedCwd,
      overlay: sourceOverlay,
      thread: sourceThread,
    });
    const sourceWorkspace = await this.buildThreadHandoffWorkspaceSummary({
      cwd: sourceCwd,
      linkedDirectory: sourceLinkedDirectory,
      mode: "same_workspace",
    });
    // Inheriting takes the same ceiling as asking, so a lower mode the
    // operator queued for this thread is not passed over by omission.
    const requestedOrInheritedExecutionMode =
      request.args.executionMode ?? callerExecutionMode;
    // Auto review belongs to Codex. An implicit cross-provider handoff keeps
    // approvals enabled using ACP's default mode; explicit Auto remains invalid.
    const executionMode =
      request.args.executionMode === undefined
      && isAcpBackendId(backend)
      && requestedOrInheritedExecutionMode === "auto"
        ? "default"
        : requestedOrInheritedExecutionMode;
    const modeSettings = executionModeSettings(executionMode);

    if (
      workspaceMode !== "none" &&
      requestedCwd &&
      !linkedDirectoriesActiveWorkspaceCoversCwd({
        cwd: requestedCwd,
        overlay: sourceOverlay,
        thread: sourceThread,
      }) &&
      executionMode !== "full-access" &&
      !(await this.directoryLaunchpadCoversCwd(requestedCwd))
    ) {
      const normalizedCwd = toDirectoryId(path.resolve(requestedCwd));
      this.updatePendingThreadHandoff(handoffId, {
        phase: "awaiting_input",
        message:
          `Waiting for the operator to confirm the requested directory may be used for ${modeSettings.label} handoffs.`,
      });
      const confirmed = await this.requestHandoffCwdTrustConfirmation({
        backend: sourceBackend,
        cwd: requestedCwd,
        executionMode,
        handoffId,
        threadId: sourceThreadId,
        turnId: sourceTurnId,
        itemId: request.context.callId,
      });
      if (!confirmed) {
        const message = `The operator did not approve adding ${normalizedCwd} to the ${modeSettings.label} write scope.`;
        this.failPendingThreadHandoff(handoffId, new Error(message));
        return threadOrchestrationFailure("forbidden", message, {
          cwd: normalizedCwd,
        });
      }
      await this.ensureHandoffTrustedDirectoryLaunchpad({
        cwd: requestedCwd,
        parentThreadBackend: sourceBackend,
        preferredBackend: backend,
        parentThreadId: sourceThreadId,
        parentThreadTitle: sourceThread?.title,
      });
    }

    if (workspaceMode !== "none" && !sourceCwd?.trim()) {
      this.failPendingThreadHandoff(
        handoffId,
        new Error(
          "The source thread has no current workspace. Ask for workspaceMode=none to create an unscoped handoff thread.",
        ),
      );
      return threadOrchestrationFailure(
        "unsupported_workspace",
        "The source thread has no current workspace. Ask for workspaceMode=none to create an unscoped handoff thread.",
      );
    }
    if (
      workspaceMode === "new_worktree" &&
      !sourceWorkspace.git.worktreeCreationAvailable
    ) {
      this.failPendingThreadHandoff(
        handoffId,
        new Error(
          sourceWorkspace.git.unavailableReason ??
            "The source workspace cannot create a new Git worktree.",
        ),
      );
      return threadOrchestrationFailure(
        "unsupported_workspace",
        sourceWorkspace.git.unavailableReason ??
          "The source workspace cannot create a new Git worktree.",
        { workspace: sourceWorkspace },
      );
    }

    const requestedEnvironment = request.args.environment?.trim() || undefined;
    // An ACP agent takes an environment by reloading its session into a new
    // process on the first turn. One that cannot load a session cannot take
    // one, so inheriting it would fail the child's first turn.
    const childEnvironmentUnavailable =
      isAcpBackendId(backend)
      && !acpRuntimeSupportsSessionLoad(
        this.context.providers.acp.getInstalledAgent(backend)?.runtimeCapabilities,
      )
        ? `backend="${backend}" cannot start with an environment, because its agent cannot reload a session.`
        : undefined;
    const callerProjectBoundary = await this.resolveHandoffProjectBoundaryPath({
      cwd: callerCwd,
      linkedDirectory: callerLinkedDirectory,
    });
    const requestedProjectBoundary = requestedCwd
      ? await this.resolveHandoffProjectBoundaryPath({
          cwd: sourceCwd,
          linkedDirectory: sourceLinkedDirectory,
        })
      : undefined;
    // A same-project child inherits the parent's environment, whatever its
    // provider. A named environment, or none, replaces it.
    const parentEnvironmentApplies =
      !requestedEnvironment
      && Boolean(sourceOverlay.codexEnvironmentRuntime?.environmentId)
      && shouldInheritHandoffCodexEnvironmentRuntime({
        callerCwd,
        callerProjectBoundary,
        requestedCwd,
        requestedProjectBoundary,
        workspaceMode,
      });
    const inheritedSettings: HandoffTaskInheritedSettings = {
      backend,
      executionMode,
      ...handoffModelSettings,
      approvalPolicy: request.args.approvalPolicy ?? modeSettings.approvalPolicy,
      sandbox: request.args.sandbox ?? modeSettings.sandbox,
      codexEnvironmentRuntime:
        parentEnvironmentApplies && !childEnvironmentUnavailable
          ? sourceOverlay.codexEnvironmentRuntime
          : undefined,
    };
    const projectLocalCwd =
      workspaceMode === "project_local"
        ? await this.resolveProjectLocalHandoffCwd({
            sourceCwd,
            sourceLinkedDirectory,
          })
        : undefined;
    if (workspaceMode === "project_local" && !projectLocalCwd?.trim()) {
      this.failPendingThreadHandoff(
        handoffId,
        new Error(
          "The source thread has no project checkout available for workspaceMode=project_local.",
        ),
      );
      return threadOrchestrationFailure(
        "unsupported_workspace",
        "The source thread has no project checkout available for workspaceMode=project_local.",
        { workspace: sourceWorkspace },
      );
    }
    const cwdForChild =
      workspaceMode === "none"
        ? undefined
        : workspaceMode === "project_local"
          ? projectLocalCwd
          : sourceCwd;
    let environmentSource: CreatedThreadEnvironmentReport["source"] =
      inheritedSettings.codexEnvironmentRuntime?.environmentId ? "inherited" : "none";
    if (
      requestedEnvironment
      && requestedEnvironment.toLowerCase() !== THREAD_ENVIRONMENT_NONE
    ) {
      // Resolve before creating anything, so a typo costs no worktree. The
      // child's checkout carries the same config as its source.
      const resolution = childEnvironmentUnavailable
        ? {
            kind: "missing" as const,
            message: `${childEnvironmentUnavailable} Pass environment="none", or choose another backend.`,
          }
        : cwdForChild?.trim()
          ? await listCodexEnvironmentOptions(cwdForChild).then(
              (options) => resolveCodexEnvironmentSelector(
                requestedEnvironment,
                options,
                sourceLinkedDirectory?.label || path.basename(cwdForChild),
              ),
              (error: unknown) => ({
                kind: "missing" as const,
                message: `Could not read the project's environments in ${cwdForChild}: ${error instanceof Error ? error.message : String(error)}`,
              }),
            )
          : {
              kind: "missing" as const,
              message: `environment="${requestedEnvironment}" needs a project workspace, and workspaceMode="none" has none. Pass cwd for the project, or omit environment.`,
            };
      if (resolution.kind === "missing") {
        this.failPendingThreadHandoff(handoffId, new Error(resolution.message));
        return threadOrchestrationFailure("invalid_arguments", resolution.message);
      }
      inheritedSettings.codexEnvironmentRuntime = {
        environmentId: resolution.environment.id,
        environmentName: resolution.environment.name,
        executionTarget: "local",
      };
      environmentSource = "requested";
    }
    const childProjectBoundary =
      workspaceMode === "none"
        ? undefined
        : requestedProjectBoundary
          ?? await this.resolveHandoffProjectBoundaryPath({
            cwd: cwdForChild,
            linkedDirectory:
              workspaceMode === "project_local"
                ? sourceLinkedDirectory?.kind === "local"
                  ? sourceLinkedDirectory
                  : undefined
                : sourceLinkedDirectory,
          });
    const groupingMode: HandoffTaskGroupingMode =
      requestedGroupingMode === "subthread" &&
      sameHandoffProjectBoundary(callerProjectBoundary, childProjectBoundary)
        ? "subthread"
        : "none";
    if (groupingMode !== requestedGroupingMode) {
      this.updatePendingThreadHandoff(handoffId, {
        groupingMode,
        message:
          "Requested subthread grouping crosses a project boundary, so the child thread will be created ungrouped.",
      });
      if (workspaceMode === "same_workspace") {
        const message =
          'workspaceMode="same_workspace" is only valid for same-project grouped subthread handoffs. Use workspaceMode="new_worktree" for an isolated handoff, workspaceMode="project_local" for the project checkout, or workspaceMode="none" for an unscoped local thread.';
        this.failPendingThreadHandoff(handoffId, new Error(message));
        return threadOrchestrationFailure("invalid_arguments", message);
      }
    }
    // A handoff's child belongs to the thread that created it. This used to
    // walk the source's parent chain to its root and adopt the child there,
    // which made the child a *sibling* of its own creator — and when that root
    // was a peer's thread, or otherwise not a row in this directory, the child
    // had nothing to nest under and landed loose in the list. Depth is the
    // renderer's problem to present, not a reason to record the wrong parent.
    const groupedParentThread =
      groupingMode === "subthread"
        ? { backend: sourceBackend, threadId: sourceThreadId }
        : undefined;
    const groupedParentThreadId = groupedParentThread?.threadId;
    const groupedParentBackend = groupedParentThread?.backend;

    let threadId: string;
    let createdLinkedDirectory: LinkedDirectorySummary | undefined;
    let createdWorkspaceMode = workspaceMode;
    let codexEnvironmentStartupFailure:
      | HandoffTaskResult["codexEnvironmentStartupFailure"]
      | undefined;
    let autoPinFailure: HandoffTaskResult["autoPinFailure"];
    try {
      this.updatePendingThreadHandoff(handoffId, {
        phase: "preparing_workspace",
        message:
          "Preparing the handoff workspace. Environment setup can take several minutes; do not retry while this is starting.",
      });
      if (seedMode === "fork") {
        this.updatePendingThreadHandoff(handoffId, {
          phase: "starting_thread",
          message:
            "Forking the child thread and preparing its runtime. Do not retry this handoff.",
        });
        const forked = await this.host().forkThread({
          backend,
          sourceThreadId,
          ...(groupedParentThreadId
            ? {
                parentThreadId: groupedParentThreadId,
                parentThreadBackend: groupedParentBackend,
              }
            : {}),
          executionMode,
          directoryLabel:
            sourceLinkedDirectory?.label ||
            (sourceCwd ? path.basename(sourceCwd) : undefined) ||
            title,
          directoryPath: cwdForChild,
          workMode: workspaceMode === "new_worktree" ? "worktree" : "local",
          branchName: request.args.branchName,
          model: inheritedSettings.model,
          reasoningEffort: inheritedSettings.reasoningEffort,
          serviceTier: inheritedSettings.serviceTier,
          fastMode: inheritedSettings.fastMode,
          approvalPolicy: inheritedSettings.approvalPolicy,
          sandbox: inheritedSettings.sandbox,
          codexEnvironmentRuntime: inheritedSettings.codexEnvironmentRuntime,
          rerunCodexEnvironmentSetup: environmentSource === "requested",
        });
        threadId = forked.threadId;
        this.updatePendingThreadHandoff(handoffId, { threadId });
        createdLinkedDirectory = forked.linkedDirectory;
        inheritedSettings.codexEnvironmentRuntime = forked.codexEnvironmentRuntime;
        codexEnvironmentStartupFailure = forked.codexEnvironmentStartupFailure;
        autoPinFailure = forked.autoPinFailure;
        createdWorkspaceMode =
          forked.workMode === "worktree" ? "new_worktree" : workspaceMode;
      } else {
        this.updatePendingThreadHandoff(handoffId, {
          phase: "starting_thread",
          message:
            "Starting the child thread and preparing its runtime. Do not retry this handoff.",
        });
        const started = await this.host().startThread({
          backend,
          executionMode,
          cwd: cwdForChild,
          workMode: workspaceMode === "new_worktree" ? "worktree" : "local",
          branchName: request.args.branchName,
          requiredWorkMode: workspaceMode === "new_worktree" ? "worktree" : undefined,
          model: inheritedSettings.model,
          reasoningEffort: inheritedSettings.reasoningEffort,
          serviceTier: inheritedSettings.serviceTier,
          fastMode: inheritedSettings.fastMode,
          approvalPolicy: inheritedSettings.approvalPolicy,
          sandbox: inheritedSettings.sandbox,
          codexEnvironmentRuntime: inheritedSettings.codexEnvironmentRuntime,
          rerunCodexEnvironmentSetup: environmentSource === "requested",
          parentThreadId: groupedParentThreadId,
          parentThreadBackend: groupedParentBackend,
        });
        threadId = started.threadId;
        this.updatePendingThreadHandoff(handoffId, { threadId });
        inheritedSettings.codexEnvironmentRuntime = started.codexEnvironmentRuntime;
        codexEnvironmentStartupFailure = started.codexEnvironmentStartupFailure;
        autoPinFailure = started.autoPinFailure;
      }
      if (groupedParentThreadId && this.context.stores.threads.updateSubthreadOrder) {
        const parentOverlay = await this.context.stores.threads.getThreadOverlayState({
          backend: groupedParentBackend ?? backend,
          threadId: groupedParentThreadId,
        });
        // The source owns this tray, so it never appears in its own order —
        // `insertSubthreadIdAfter` prepends, putting the newest child directly
        // under the thread that created it.
        const nextOrder = insertSubthreadIdAfter(
          parentOverlay?.subthreadOrder ?? [],
          sourceThreadId,
          threadId,
        );
        await this.context.stores.threads.updateSubthreadOrder({
          backend: groupedParentBackend ?? backend,
          parentThreadId: groupedParentThreadId,
          threadIds: nextOrder,
        });
      }
      await this.host().renameThread({ backend, threadId, name: title }).catch(
        (error) => {
          backendRegistryLog.warn("thread handoff rename failed", {
            backend,
            error: error instanceof Error ? error.message : String(error),
            threadId,
          });
        },
      );
    } catch (error) {
      const baseMessage = error instanceof Error ? error.message : String(error);
      const message =
        workspaceMode === "new_worktree" && !requestedCwd
          ? `${baseMessage} cwd was omitted, so PwrAgent used the current project as the worktree source. If the user named a different local project, retry with cwd set to that project path. Do not switch to workspaceMode="none".`
          : baseMessage;
      this.failPendingThreadHandoff(handoffId, new Error(message));
      return threadOrchestrationFailure(
        workspaceMode === "new_worktree" ? "unsupported_workspace" : "internal_error",
        message,
      );
    }

    const pendingThread = this.host().pendingStartedThreads.get(
      buildThreadIdentityKey(backend, threadId),
    );
    const childCwd =
      resolveThreadWorkspaceCwd(pendingThread) ||
      createdLinkedDirectory?.worktreePath ||
      createdLinkedDirectory?.path ||
      cwdForChild;
    const childLinkedDirectory =
      createdLinkedDirectory ??
      this.resolveHandoffLinkedDirectory({
        cwd: childCwd,
        overlay: await this.context.stores.threads.getThreadOverlayState({ backend, threadId }),
        thread: pendingThread,
      });
    const workspace = await this.buildThreadHandoffWorkspaceSummary({
      cwd: childCwd,
      linkedDirectory: childLinkedDirectory,
      mode: createdWorkspaceMode,
    });
    this.updatePendingThreadHandoff(handoffId, { workspace });
    const environment = describeCreatedThreadEnvironment({
      source: environmentSource,
      requested: requestedEnvironment,
      ...(parentEnvironmentApplies && childEnvironmentUnavailable
        ? { noneReason: childEnvironmentUnavailable }
        : {}),
      runtime: inheritedSettings.codexEnvironmentRuntime,
      failure: codexEnvironmentStartupFailure,
      setupRan:
        environmentSource === "requested"
        || createdWorkspaceMode === "new_worktree",
    });
    const createdAt = request.context.now ?? Date.now();
    const origin = {
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      sourceTitle: sourceThread?.title,
      taskTitle: title,
      seedMode,
      groupingMode,
      createdAt,
      workspace,
    };
    await this.context.stores.threads.setThreadHandoffOrigin({
      backend,
      threadId,
      handoffOrigin: origin,
    });
    this.host().invalidateThreadListCache(backend);

    const prompt = buildHandoffTaskPrompt({
      task,
      context: request.args.context,
      codexEnvironmentStartupFailure,
    });
    const ancestry = await this.host().readDelegatedTurnAncestry({
      backend: sourceBackend, threadId: sourceThreadId, turnId: sourceTurnId,
    });
    const messageOrigin: AppServerThreadMessageOrigin = {
      kind: "agent",
      ...causalContext,
      sourceThread: {
        backend: sourceBackend,
        threadId: sourceThreadId,
        ...(ancestry.parentTurnId ? { turnId: ancestry.parentTurnId } : {}),
        ...(ancestry.rootTurnId ? { rootTurnId: ancestry.rootTurnId } : {}),
        ...(sourceThread?.title ? { title: sourceThread.title } : {}),
      },
    };
    let turnId: string | undefined;
    let turnStartFailure: HandoffTaskResult["turnStartFailure"];
    try {
      this.updatePendingThreadHandoff(handoffId, {
        phase: "starting_turn",
        message:
          "Child thread exists; starting the delegated turn. Do not create a replacement handoff.",
      });
      const turn = await this.host().startTurn({
        backend,
        threadId,
        input: [
          { type: "text", text: prompt },
          ...this.host().getTurnInputAttachments({
            backend: sourceBackend,
            threadId: sourceThreadId,
            turnId: sourceTurnId,
          }),
        ],
        messageOrigin,
        executionMode,
        model: inheritedSettings.model,
        reasoningEffort: inheritedSettings.reasoningEffort,
        serviceTier: inheritedSettings.serviceTier,
        fastMode: inheritedSettings.fastMode,
        approvalPolicy: inheritedSettings.approvalPolicy,
        sandbox: inheritedSettings.sandbox,
      });
      turnId = turn.turnId;
      this.updatePendingThreadHandoff(handoffId, { turnId });
    } catch (error) {
      turnStartFailure = {
        phase: "turn",
        message: error instanceof Error ? error.message : String(error),
      };
      backendRegistryLog.warn("thread handoff created thread but turn failed", {
        backend,
        error: turnStartFailure.message,
        threadId,
      });
    }

    this.updatePendingThreadHandoff(handoffId, {
      phase: "attaching_messaging",
      message:
        "Child thread exists; finalizing optional messaging attachment. Do not create a replacement handoff.",
    });
    const messagingAttachment = await this.attachHandoffThreadToMessaging({
      mode: request.args.messagingAttachment,
      sourceBackend,
      sourceThreadId,
      sourceTurnId,
      backend,
      threadId,
      title,
    });
    if (turnId && (messagingAttachment.outcome === "attached"
      || messagingAttachment.outcome === "created_and_attached")) {
      // The start event precedes creation of a handoff's messaging binding.
      // Republish with the same delivery id; existing bindings deduplicate it.
      await this.host().publishIncomingWork({
        backend, threadId, input: [{ type: "text", text: prompt }], messageOrigin,
      }, turnId, title);
    }
    this.updatePendingThreadHandoff(handoffId, {
      status: turnStartFailure ? "failed" : "completed",
      phase: turnStartFailure ? "failed" : "completed",
      ...(turnStartFailure ? { error: turnStartFailure.message } : {}),
      message: turnStartFailure
        ? "The child thread was created, but its initial turn failed. Use the returned threadId instead of retrying the handoff."
        : "Handoff creation completed. Use the returned threadId for follow-up status checks.",
    });
    return {
      ok: true,
      data: {
        backend,
        threadId,
        turnId,
        handoffId,
        title,
        threadUrl: buildThreadUrl({ backend, threadId }),
        threadLink: buildThreadMarkdownLink({ backend, threadId, title }),
        seedMode,
        groupingMode,
        ...(groupedParentThreadId
          ? { groupedUnderThreadId: groupedParentThreadId }
          : {}),
        inheritedSettings,
        origin,
        workspace,
        messagingAttachment,
        environment,
        ...(codexEnvironmentStartupFailure
          ? { codexEnvironmentStartupFailure }
          : {}),
        ...(autoPinFailure ? { autoPinFailure } : {}),
        ...(turnStartFailure ? { turnStartFailure } : {}),
      },
    };
  }

  private async attachHandoffThreadToMessaging(params: {
    mode?: "none" | "auto" | "current_conversation" | "new_child";
    sourceBackend: AppServerBackendKind;
    sourceThreadId: string;
    sourceTurnId: string;
    backend: AppServerBackendKind;
    threadId: string;
    title: string;
  }): Promise<HandoffTaskMessagingAttachment> {
    if (params.mode === "none") {
      return { requested: false, outcome: "not_requested" };
    }
    const placement =
      params.mode === "new_child"
        ? "new_child"
        : params.mode === "current_conversation"
          ? "current_conversation"
          : "auto";
    const explicitRequest = params.mode !== undefined;
    // An ordinary thread may still attach the child it just created through
    // handoff_task. This internal path is not the unrestricted attachment tool.
    const response = await this.host().dispatchMessagingRequest({
      operation: "attach_thread_here",
      context: {
        backend: params.sourceBackend,
        threadId: params.sourceThreadId,
        turnId: params.sourceTurnId,
      },
      args: {
        backend: params.backend,
        threadId: params.threadId,
        placement,
        targetKind: "thread",
        title: params.title,
      },
    });
    if (response.ok && "binding" in response.data) {
      return {
        requested: true,
        outcome: response.data.outcome,
        channel: response.data.channel,
        conversation: {
          id: response.data.conversation.id,
          kind: response.data.conversation.kind,
          title: response.data.conversation.title,
        },
        ...(response.data.createdConversation
          ? {
              createdConversation: {
                id: response.data.createdConversation.id,
                kind: response.data.createdConversation.kind,
                title: response.data.createdConversation.title,
              },
            }
          : {}),
      };
    }
    if (!explicitRequest) {
      return { requested: false, outcome: "not_requested" };
    }
    if (response.ok) {
      return {
        requested: true,
        outcome: "failed",
        reason: "Messaging location did not return an attachable binding.",
      };
    }
    return {
      requested: true,
      outcome:
        response.error.code === "not_found"
          ? "not_available"
          : response.error.code === "forbidden"
            ? "forbidden"
            : response.error.code === "unsupported_operation"
              ? "unsupported"
              : "failed",
      reason: response.error.message,
    };
  }

  private resolveHandoffLinkedDirectory(params: {
    cwd?: string;
    fallbackToAnyDirectory?: boolean;
    overlay?: ThreadOverlayState;
    thread?: Pick<AppServerThreadSummary, "linkedDirectories">;
  }): LinkedDirectorySummary | undefined {
    const candidates = [
      ...(params.overlay?.extraLinkedDirectories ?? []),
      ...(params.thread?.linkedDirectories ?? []),
    ];
    const cwd = params.cwd?.trim();
    const matchedDirectory = cwd
      ? candidates.find((directory) => linkedDirectoryMatchesCwd(directory, cwd))
      : undefined;
    if (matchedDirectory || params.fallbackToAnyDirectory === false) {
      return matchedDirectory;
    }
    return (
      candidates.find((directory) => directory.kind === "worktree") ??
      candidates.find((directory) => directory.kind === "local") ??
      candidates[0]
    );
  }

  private async resolveProjectLocalHandoffCwd(params: {
    sourceCwd?: string;
    sourceLinkedDirectory?: LinkedDirectorySummary;
  }): Promise<string | undefined> {
    const linkedDirectory = params.sourceLinkedDirectory;
    if (linkedDirectory?.kind === "local" && linkedDirectory.path?.trim()) {
      return linkedDirectory.path.trim();
    }
    const primaryWorkspace = await this.host().gitDirectoryService
      .resolvePrimaryWorkspacePath(params.sourceCwd)
      .catch(() => undefined);
    if (primaryWorkspace?.trim()) {
      return primaryWorkspace.trim();
    }
    if (linkedDirectory?.kind === "worktree" && linkedDirectory.path?.trim()) {
      return linkedDirectory.path.trim();
    }
    return params.sourceCwd?.trim();
  }

  private async resolveHandoffProjectBoundaryPath(params: {
    cwd?: string;
    linkedDirectory?: LinkedDirectorySummary;
  }): Promise<string | undefined> {
    const linkedDirectoryPath = params.linkedDirectory?.path?.trim();
    if (linkedDirectoryPath) {
      return path.resolve(linkedDirectoryPath);
    }

    const cwd = params.cwd?.trim();
    if (!cwd) {
      return undefined;
    }

    const primaryWorkspace = await this.host().gitDirectoryService
      .resolvePrimaryWorkspacePath(cwd)
      .catch(() => undefined);
    return path.resolve(primaryWorkspace?.trim() || cwd);
  }

  private async buildThreadHandoffWorkspaceSummary(params: {
    cwd?: string;
    linkedDirectory?: LinkedDirectorySummary;
    mode: HandoffTaskWorkspaceMode;
  }): Promise<ThreadHandoffOriginWorkspace> {
    const cwd = params.cwd?.trim();
    if (!cwd) {
      return {
        mode: params.mode,
        git: {
          kind: "none",
          worktreeCreationAvailable: false,
          unavailableReason: "No workspace is associated with this thread.",
        },
      };
    }
    let repository: GitWorkspaceInspection;
    try {
      repository = await this.host().gitDirectoryService.inspectWorkspaceGit(cwd);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("thread handoff Git workspace inspection failed", {
        cwd,
        error: detail,
      });
      return {
        mode: params.mode,
        cwd,
        linkedDirectory: params.linkedDirectory,
        git: {
          kind: "unavailable",
          worktreeCreationAvailable: false,
          unavailableReason: `Git workspace inspection failed: ${detail}`,
        },
      };
    }
    if (repository.kind === "non_git") {
      return {
        mode: params.mode,
        cwd,
        linkedDirectory: params.linkedDirectory,
        git: {
          kind: "non_git",
          worktreeCreationAvailable: false,
          unavailableReason: "The workspace is not a Git repository.",
        },
      };
    }
    const kind: "git_local" | "git_worktree" =
      params.linkedDirectory?.kind === "worktree"
        ? "git_worktree"
        : "git_local";
    if (repository.kind !== "worktree") {
      const isBare = repository.kind === "bare";
      return {
        mode: params.mode,
        cwd,
        branch: repository.branch,
        linkedDirectory: params.linkedDirectory,
        git: {
          kind,
          repositoryState: repository.kind,
          worktreeCreationAvailable: false,
          unavailableReason: isBare
            ? "Bare Git repositories are not supported as handoff workspaces."
            : "Git administration directories are not supported as handoff workspaces.",
        },
      };
    }
    let unavailableReason: string | undefined;
    if (!repository.worktreeCreationAvailable) {
      if (!repository.headHasCommit) {
        unavailableReason = UNPUBLISHED_BASE_BRANCH_WORKTREE_REASON;
      } else if (!repository.hasCommits) {
        unavailableReason =
          "Repository has no commits yet; create the initial commit before allocating a worktree.";
      } else {
        unavailableReason =
          "Repository has no local or remote branch commit available; create or fetch a branch before allocating a worktree.";
      }
    }
    return {
      mode: params.mode,
      cwd,
      branch: repository.branch,
      linkedDirectory: params.linkedDirectory,
      git: {
        kind,
        ...(!repository.headHasCommit
          ? { repositoryState: "unborn" as const }
          : {}),
        worktreeCreationAvailable: repository.worktreeCreationAvailable,
        ...(unavailableReason ? { unavailableReason } : {}),
      },
    };
  }
}
