import type { RegistryContext, RegistryHost } from "./registry-context";
import type { ThreadInspectionTools } from "./thread-inspection-tools";
import type { ThreadMcpConnections } from "./thread-mcp-connections";
import type { ThreadArchiveCoordinator } from "./thread-archive-coordinator";
import type { ThreadWorkspaceService } from "./thread-workspace-service";
import { logDebug } from "./registry-debug-log";
import { extractFirstMeaningfulTextInput } from "@pwragent/owner-core/thread-title-lifecycle";
import { delegatedTurnAttribution } from "./delegated-turn-attribution";
import { LaunchpadCreationOperations, type LaunchpadCreationOperation } from "./launchpad-creation-operations";
import type { LaunchpadCreationRequest, LaunchpadCreationResponse } from "@pwragent/shared";
import { listingDiagnostics } from "../diagnostics/listing-diagnostics";
import { joinConcurrent } from "../../shared/concurrent-work";
import {
  isRemoteLaunchpadStorageKey,
  launchpadStorageKey,
  parseRemoteLaunchpadStorageKey,
  type FederationTarget,
} from "@pwragent/shared";
import { PendingEnvironmentLaunchStore, type PendingEnvironmentLaunch } from "./pending-environment-launch-store";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  formatReviewCommand,
} from "../../shared/review-command";
import { PerKeyAsyncLock } from "../util/per-key-async-lock";
import {
  canIsolateMcpProviderServers,
  type AgentEvent,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type FederationInstanceId,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadMessageOrigin,
  type AppServerThreadSummary,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type BackendAcpSessionRuntimeState,
  type CodexEnvironmentActionRun,
  type CodexEnvironmentSetupProgressEvent,
  type CodexThreadEnvironmentRuntime,
  type CreateScheduledThreadActionRequest,
  type BackendLaunchpadOptions,
  type BackendSummary,
  type DesktopProviderModelDefaults,
  type CheckThreadBranchDriftRequest,
  type CheckThreadBranchDriftResponse,
  type ListBackendsRequest,
  type ListBackendsResponse,
  type LinkedDirectorySummary,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadOptions,
  type MaterializeDirectoryLaunchpadResponse,
  type MaterializedDirectoryLaunchpadThread,
  type LaunchpadWorkMode,
  type NavigationLaunchpadDraft,
  type NavigationLaunchpadDefaults,
  type ResetDirectoryLaunchpadRequest,
  type ResetDirectoryLaunchpadResponse,
  type RunCodexEnvironmentActionRequest,
  type RunCodexEnvironmentActionResponse,
  type StopCodexEnvironmentActionRequest,
  type StopCodexEnvironmentActionResponse,
  type SetCodexThreadEnvironmentRequest,
  type SetCodexThreadEnvironmentResponse,
  applyNavigationLaunchpadProviderSettingsPatch,
  projectNavigationLaunchpadProviderSettings,
  resolveDefaultLaunchpadExecutionMode,
  type ScheduledThreadActionMutationResponse,
  type AttachThreadDirectoryResult,
  type AttachThreadDirectoryToolArgs,
  type AttachThreadDirectoryWorkspaceMode,
  type PwrAgentThreadOrchestrationRequest,
  type PwrAgentThreadOrchestrationResponse,
  type AcknowledgeThreadEnvironmentFailureRequest,
  type AcknowledgeThreadEnvironmentFailureResponse,
  type ContinueThreadEnvironmentStartupRequest,
  type ContinueThreadEnvironmentStartupResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartThreadRequest,
  type StartThreadResponse,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type UpdateDirectoryLaunchpadRequest,
  type UpdateDirectoryLaunchpadResponse,
  type EnsureDirectoryLaunchpadRequest,
  type EnsureDirectoryLaunchpadResponse,
  applyCodexEnvironmentActionRunUpdate,
  buildThreadIdentityKey,
  isAcpBackendId,
  isAppServerBackendKind,
  readCodexEnvironmentActionRuns,
} from "@pwragent/shared";
import {
  GitDirectoryService,
} from "./git-directory-service";
import type {
  WorktreeBaseSource,
} from "./git-directory-service";
import {
  ThreadInfoStore,
} from "./thread-info-store";
import { hasWorktreeRegistration, inspectRegisterableWorktree, sameRegisteredWorktree } from "./worktree-maintenance-registration";
import { getMainLogger } from "../log";
import {
  type ProviderDiscoveryPermit,
} from "../settings/provider-discovery-permit";
import {
  type BackendModelCatalogCallerReason,
} from "./backend-model-catalog";
import {
  listCodexEnvironmentOptions,
  pruneCodexEnvironmentActionMap,
  resolveCodexEnvironmentActionId,
  resolveCodexEnvironmentSelector,
  withCodexEnvironmentOptions,
} from "./codex-environment-config";
import {
  applyLocalCodexEnvironmentSelection,
  attachDetachedCommandThreadId,
  CodexEnvironmentStartupError,
  startLocalCodexEnvironmentAction,
  stopCodexEnvironmentDetachedCommand,
  waitForCodexEnvironmentDetachedCommandGone,
  type CodexEnvironmentCommandRunner,
  type CodexEnvironmentDetachedExit,
  type CodexEnvironmentDetachedOutput,
} from "./codex-environment-runtime";
import { type CodexEnvironmentHydrationStoreLike } from "../storage/codex-environment-hydration-store";
import {
  ownThreadInputAttachments,
} from "./turn-input-attachment-files";
import {
  reviewTaskLabel,
  reviewThreadTitlePrompt,
} from "./backend-registry-notifications";
import {
  type CodexDiscoveryObserver,
  type ModelSettings,
  type ThreadListCallerReason,
} from "./backend-registry-types";
import {
  threadOrchestrationFailure,
} from "./backend-registry-runtime-helpers";
import {
  buildActiveTurnModeKey,
} from "./thread-turn-keys";
import {
  cloneCodexEnvironmentRuntimeForFork,
  defaultLaunchpadWorkMode,
  fallbackLaunchpadIdentity,
  isEmptyDirectoryLaunchpadDraft,
  readSelectedActionIdByEnvironmentIdForFork,
  resetLaunchpadAfterMaterialize,
  resolveCodexEnvironmentSelection,
  sameMcpConnectionIds,
} from "./thread-launchpad-helpers";
import {
  getAvailableExecutionMode,
  launchpadDefaultsEqual,
  resolveModelSettingsFromOptions,
} from "./thread-model-options";
import {
  buildCachedDirectoryRelationship,
  buildCachedWorktreeDirectory,
  buildLocalLinkedDirectory,
  buildWorktreeLinkedDirectory,
  dedupeLinkedDirectoriesByNormalizedIdentity,
  hasCachedWorktreeDirectory,
  isLikelyToolManagedWorktreePath,
  linkedDirectoryMatchesDetachArgs,
  linkedDirectoryWorktreePath,
  overlayHasHandoffWorkspace,
  readCurrentGitBranch,
  resolvePreparedRepositoryIdentityPath,
  resolveThreadWorkspaceCwd,
  shouldRepairCachedDirectoryRelationship,
} from "./linked-directory-identity";
import { refuseResolvedWorkMode } from "./required-work-mode";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** The collaborators and services the composition root supplies to this module. */
export interface ThreadDirectoryServiceDependencies {
  readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  readonly threadWorkspaceService: ThreadWorkspaceService;
  readonly threadInspectionTools: ThreadInspectionTools;
  readonly threadMcpConnections: ThreadMcpConnections;
  readonly codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;
  readonly codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;
}

/**
 * Registry-owned state and operations the directory service reads. The
 * registry's construction ports satisfy it; this module never imports the
 * registry. Codex turn activity, thread creation and turns, the pending
 * environment launch store, the Git directory service, model settings and
 * the thread lookups shared across the registry stay registry-owned.
 */
export interface ThreadDirectoryServiceHost {
  readonly activeCodexTurnModes: ReadonlyMap<string, ThreadExecutionMode>;
  readonly codexEnvironmentCommandEnv?: NodeJS.ProcessEnv;
  readonly createScheduledThreadActionFn?: (
    request: CreateScheduledThreadActionRequest,
    options: { id: string },
  ) => Promise<ScheduledThreadActionMutationResponse>;
  readonly createScratchProjectDirectory: () => Promise<string>;
  readonly gitDirectoryService: GitDirectoryService;
  readonly localFilePrivateStorageRoots: readonly string[];
  readonly pendingEnvironmentLaunchStore: PendingEnvironmentLaunchStore;
  readonly pendingStartedThreads: ReadonlyMap<string, AppServerThreadSummary>;
  readonly resolveCodexFastAllowedFn: () => boolean;
  readonly resolveDefaultPrAutoDispatchEnabledFn: () => boolean;
  readonly resolveProviderModelDefaultsFn: () => Record<
    string,
    DesktopProviderModelDefaults
  >;
  readonly threadInfoStore: ThreadInfoStore;
  readonly threadLifecycleLocks: PerKeyAsyncLock;
  readonly threadListCacheOwnerId: string;
  admitNewThreadModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings & { acpRuntime?: BackendAcpSessionRuntimeState },
  ): Promise<ModelSettings>;
  archiveThread(
    request: ArchiveThreadRequest & { preserveWorktrees?: boolean },
  ): Promise<ArchiveThreadResponse>;
  checkThreadBranchDrift(
    params: CheckThreadBranchDriftRequest,
  ): Promise<CheckThreadBranchDriftResponse>;
  findThreadForWorkspaceHandoff(params: {
    backend: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    freshness?: "last-known" | "provider";
    threadId: string;
  }): Promise<AppServerThreadSummary | undefined>;
  getBackendLaunchpadOptions(
    backend: AppServerBackendKind,
    callerReason: BackendModelCatalogCallerReason,
  ): Promise<BackendLaunchpadOptions | undefined>;
  getCachedThreadSummary(params: {
    backend?: AppServerBackendKind;
    threadId: string;
  }): AppServerThreadSummary | undefined;
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  isLiveDynamicToolCall(
    backend: AppServerBackendKind,
    call: { threadId: string; turnId?: string },
  ): boolean;
  listBackends(
    request?: ListBackendsRequest,
    discoveryPermit?: ProviderDiscoveryPermit,
    observer?: CodexDiscoveryObserver,
  ): Promise<ListBackendsResponse>;
  publishLocalEvent(event: AgentEvent): Promise<void>;
  readThread(request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse>;
  recordCodexWorktreeOwnerThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
    worktreePath?: string;
  }): Promise<void>;
  resolveCodexThreadExecutionModeForActiveTurn(
    threadId: string,
  ): Promise<ThreadExecutionMode>;
  resolveModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
    callerReason?: BackendModelCatalogCallerReason,
  ): Promise<ModelSettings>;
  resolveThreadEnvironmentCwd(
    backend: AppServerBackendKind,
    threadId: string,
    overlay?: ThreadOverlayState,
  ): Promise<string | undefined>;
  scheduleThreadTitleGeneration(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
  }): void;
  startReview(
    params: StartReviewRequest,
    trustedSnapshot?: boolean,
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>,
  ): Promise<StartReviewResponse>;
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
}

/**
 * The launchpad, environment and directory domain of the backend registry:
 * directory launchpads and their materialization into threads, the paused
 * environment launches a thread resumes, Codex environment runtimes and their
 * actions, linked directories (attach, detach, worktree registration and the
 * workspace directory replacement), and the Codex thread directory
 * relationships the registry repairs and backfills.
 */
export class ThreadDirectoryService {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadDirectoryServiceHost>;
  private readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  private readonly threadWorkspaceService: ThreadWorkspaceService;
  private readonly threadInspectionTools: ThreadInspectionTools;
  private readonly threadMcpConnections: ThreadMcpConnections;

  constructor(
    context: RegistryContext,
    dependencies: ThreadDirectoryServiceDependencies,
    host: RegistryHost<ThreadDirectoryServiceHost>,
  ) {
    this.context = context;
    this.host = host;
    this.threadArchiveCoordinator = dependencies.threadArchiveCoordinator;
    this.threadWorkspaceService = dependencies.threadWorkspaceService;
    this.threadInspectionTools = dependencies.threadInspectionTools;
    this.threadMcpConnections = dependencies.threadMcpConnections;
    this.codexEnvironmentCommandRunner = dependencies.codexEnvironmentCommandRunner;
    this.codexEnvironmentHydrationStore = dependencies.codexEnvironmentHydrationStore;
  }

  /** Cancels every cancellable launchpad creation, for the registry's close. */
  cancelLaunchpadCreations(): void {
    this.launchpadCreationOperations.cancelAll();
  }

  private readonly launchpadCreationOperations = new LaunchpadCreationOperations();

  private readonly environmentLaunchContinuations = new Map<string, Promise<ContinueThreadEnvironmentStartupResponse>>();

  private readonly codexEnvironmentCommandRunner?: CodexEnvironmentCommandRunner;

  private readonly codexEnvironmentHydrationStore?: CodexEnvironmentHydrationStoreLike;

  /**
   * Per-thread async chain serialising read-modify-write of
   * codexEnvironmentRuntime. Concurrent Run-button clicks and
   * concurrent detached-child exit/output callbacks all funnel through
   * this so two simultaneous overlay writes can't clobber each other.
   * Keyed by `buildThreadIdentityKey`. Implementation details and
   * failure-poisoning semantics live in PerKeyAsyncLock.
   */
  private readonly codexEnvironmentRuntimeLocks = new PerKeyAsyncLock();

  private readonly pendingDirectoryRepairs = new Map<string, Promise<void>>();

  private readonly failedDirectoryRelationshipLogKeys = new Set<string>();

  async buildForkedCodexEnvironmentRuntime(params: {
    cwd?: string;
    /** Run setup in a workspace that is not a new worktree. */
    forceSetup?: boolean;
    onSetupProgress?: (
      event: Omit<CodexEnvironmentSetupProgressEvent, "directoryKey">,
    ) => void;
    sourceRuntime?: CodexThreadEnvironmentRuntime;
    workMode: LaunchpadWorkMode;
  }): Promise<CodexThreadEnvironmentRuntime | undefined> {
    const { cwd, forceSetup, onSetupProgress, sourceRuntime, workMode } = params;
    if (!sourceRuntime?.environmentId) {
      return undefined;
    }
    if (
      (workMode !== "worktree" && !forceSetup) ||
      sourceRuntime.executionTarget !== "local" ||
      !cwd?.trim()
    ) {
      return cloneCodexEnvironmentRuntimeForFork(sourceRuntime, cwd);
    }

    const environment = (await listCodexEnvironmentOptions(cwd))
      .find((candidate) => candidate.id === sourceRuntime.environmentId);
    if (!environment) {
      const message = `Selected Codex environment '${sourceRuntime.environmentName}' is not available in the forked worktree.`;
      const runtime = {
        ...cloneCodexEnvironmentRuntimeForFork(sourceRuntime, cwd),
        setupStatus: "failed",
        setupOutput: message,
      } satisfies CodexThreadEnvironmentRuntime;
      throw new CodexEnvironmentStartupError(
        message,
        "setup",
        runtime,
      );
    }

    const runtime = await applyLocalCodexEnvironmentSelection({
      commandRunner: this.codexEnvironmentCommandRunner,
      cwd,
      env: this.host().codexEnvironmentCommandEnv,
      hydrationStore: this.codexEnvironmentHydrationStore,
      onSetupProgress,
      selection: {
        environment,
        executionTarget: "local",
        runSetup: Boolean(environment.setupScript),
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

  async ensureDirectoryLaunchpad(
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
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const { owner, ...storageOptions } = options ?? {};
    const storageKey = launchpadStorageKey(request.directoryKey, owner);
    if (storageKey !== request.directoryKey) {
      await this.adoptLegacyRemoteDirectoryLaunchpad(owner, request.directoryKey, storageKey);
      const response = await this.ensureDirectoryLaunchpad(
        { ...request, directoryKey: storageKey },
        storageOptions,
      );
      return {
        ...response,
        launchpad: { ...response.launchpad, directoryKey: request.directoryKey },
      };
    }
    const codexEnvironmentOptions = options?.skipFilesystemInspection
      ? []
      : await listCodexEnvironmentOptions(request.directoryPath);
    const withEnvironmentOptions = (launchpad: NavigationLaunchpadDraft): NavigationLaunchpadDraft =>
      options?.skipFilesystemInspection
        ? launchpad
        : withCodexEnvironmentOptions(launchpad, codexEnvironmentOptions);
    const existing = await this.context.stores.launchpads.getDirectoryLaunchpad({
      directoryKey: request.directoryKey,
    });
    const defaults = await this.resolveLaunchpadDefaults(
      await this.context.stores.launchpads.getLaunchpadDefaults(),
      request.preferredBackend,
    );
    const mcpSeed = options?.skipMcpConnectionDefaults
      ? undefined
      : await this.threadMcpConnections.resolveLaunchpadMcpSeed(existing);
    if (existing) {
      const registeredAt = existing.registeredAt ?? request.registeredAt;
      const existingLaunchpad = projectNavigationLaunchpadProviderSettings(existing);
      const backend = await this.resolveLaunchpadBackend(existingLaunchpad.backend);
      const modelSettings = (owner?.scope === "remote" || isRemoteLaunchpadStorageKey(request.directoryKey))
        && backend.kind === existingLaunchpad.backend
        ? {
            model: existingLaunchpad.model,
            reasoningEffort: existingLaunchpad.reasoningEffort,
            serviceTier: existingLaunchpad.serviceTier,
            fastMode: existingLaunchpad.fastMode,
          }
        : await this.resolveLaunchpadModelSettings(backend, existingLaunchpad);
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
      const requestParentThreadBackend =
        request.parentThreadBackend ?? normalizedExisting.parentThreadBackend;
      const requestParentThreadInstanceId =
        request.parentThreadInstanceId
        ?? normalizedExisting.parentThreadInstanceId;
      const requestParentThreadTitle =
        request.parentThreadTitle ?? normalizedExisting.parentThreadTitle;
      const identityChanged =
        normalizedExisting.directoryKind !== request.directoryKind ||
        normalizedExisting.directoryLabel !== request.directoryLabel ||
        normalizedExisting.directoryPath !== request.directoryPath;
      const parentChanged =
        request.parentThreadId !== undefined &&
        (normalizedExisting.parentThreadId !== request.parentThreadId ||
          normalizedExisting.parentThreadBackend !== request.parentThreadBackend ||
          normalizedExisting.parentThreadInstanceId
            !== request.parentThreadInstanceId ||
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
          prAutoDispatchEnabled: this.host().resolveDefaultPrAutoDispatchEnabledFn(),
          workMode: defaultLaunchpadWorkMode(request, defaults),
          branchName: existing.branchName ?? request.currentBranch,
          parentThreadId: requestParentThreadId,
          parentThreadBackend: requestParentThreadBackend,
          parentThreadInstanceId: requestParentThreadInstanceId,
          parentThreadTitle: requestParentThreadTitle,
          registeredAt,
          ...mcpSeed,
          updatedAt: Date.now(),
        };
        return {
          launchpad: withEnvironmentOptions(
            await this.context.stores.launchpads.upsertDirectoryLaunchpad(refreshed),
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
        parentChanged ||
        mcpSeed !== undefined
      ) {
        return {
          launchpad: withEnvironmentOptions(
            await this.context.stores.launchpads.upsertDirectoryLaunchpad({
              ...normalizedExisting,
              directoryKind: request.directoryKind,
              directoryLabel: request.directoryLabel,
              directoryPath: request.directoryPath,
              parentThreadId: requestParentThreadId,
              parentThreadBackend: requestParentThreadBackend,
              parentThreadInstanceId: requestParentThreadInstanceId,
              parentThreadTitle: requestParentThreadTitle,
              registeredAt,
              ...mcpSeed,
              updatedAt: Date.now(),
            }),
          ),
          defaults,
        };
      }

      return {
        launchpad: withEnvironmentOptions(existing),
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
      prAutoDispatchEnabled: this.host().resolveDefaultPrAutoDispatchEnabledFn(),
      prompt: "",
      registeredAt: request.registeredAt,
      workMode: defaultLaunchpadWorkMode(request, defaults),
      branchName: request.currentBranch,
      parentThreadId: request.parentThreadId,
      parentThreadBackend: request.parentThreadBackend,
      parentThreadInstanceId: request.parentThreadInstanceId,
      parentThreadTitle: request.parentThreadTitle,
      ...mcpSeed,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    return {
      launchpad: withEnvironmentOptions(
        await this.context.stores.launchpads.upsertDirectoryLaunchpad(launchpad),
      ),
      defaults,
    };
  }

  /**
   * Seed a peer's draft with text this viewer kept under the owner's bare key
   * before drafts named their owner (see the overlay store). A failure only
   * costs that copy; the draft still opens.
   */
  private async adoptLegacyRemoteDirectoryLaunchpad(
    owner: FederationTarget | undefined,
    directoryKey: string,
    storageKey: string,
  ): Promise<void> {
    if (owner?.scope !== "remote" || !this.context.stores.launchpads.adoptLegacyRemoteDirectoryLaunchpad) {
      return;
    }
    try {
      await this.context.stores.launchpads.adoptLegacyRemoteDirectoryLaunchpad({
        instanceId: owner.instanceId,
        directoryKey,
        storageKey,
      });
    } catch (error) {
      backendRegistryLog.warn("remote_launchpad_legacy_adoption_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The draft an update reaches before any ensure created it. For a peer's
   * draft this is also its first open, so it takes the text kept under the
   * shared key first, as an ensure would.
   */
  private async ensureLaunchpadForLateUpdate(
    storageKey: string,
  ): Promise<EnsureDirectoryLaunchpadResponse> {
    const peer = parseRemoteLaunchpadStorageKey(storageKey);
    if (peer) {
      await this.adoptLegacyRemoteDirectoryLaunchpad(
        { scope: "remote", instanceId: peer.instanceId },
        peer.directoryKey,
        storageKey,
      );
    }
    return await this.ensureDirectoryLaunchpad(
      { directoryKey: storageKey, ...fallbackLaunchpadIdentity(storageKey) },
      // A peer's draft takes nothing from this machine's copy of its path.
      peer ? { skipFilesystemInspection: true, skipMcpConnectionDefaults: true } : undefined,
    );
  }

  async updateDirectoryLaunchpad(
    request: UpdateDirectoryLaunchpadRequest,
    options?: {
      /** A remote viewer's draft takes no environment metadata from here. */
      skipFilesystemInspection?: boolean;
      /** Leave the stored draft as it is unless this holds for it. */
      onlyIf?: (current: NavigationLaunchpadDraft) => boolean;
      /** The instance that owns `directoryKey`, as on an ensure. */
      owner?: FederationTarget;
    },
  ): Promise<UpdateDirectoryLaunchpadResponse> {
    const { owner, ...storageOptions } = options ?? {};
    const storageKey = launchpadStorageKey(request.directoryKey, owner);
    if (storageKey !== request.directoryKey) {
      const { federationTarget: _federationTarget, ...storageRequest } = request;
      const response = await this.updateDirectoryLaunchpad(
        { ...storageRequest, directoryKey: storageKey },
        // The peer's path names a folder on the peer. This machine's folder
        // at the same path holds none of the peer's environments.
        { ...storageOptions, skipFilesystemInspection: true },
      );
      return {
        ...response,
        launchpad: { ...response.launchpad, directoryKey: request.directoryKey },
      };
    }
    const current =
      (await this.context.stores.launchpads.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      })) ??
      (await this.ensureLaunchpadForLateUpdate(request.directoryKey)).launchpad;
    if (options?.onlyIf && !options.onlyIf(current)) {
      return {
        launchpad: current,
        defaults: await this.context.stores.launchpads.getLaunchpadDefaults(),
      };
    }

    const patch = {
      ...request.patch,
      ...("fastMode" in request.patch && !("serviceTier" in request.patch)
        ? { serviceTier: undefined } : {}),
      // An edit to the selection makes it the operator's. Re-seeding after
      // that would put back a connection they just turned off. A patch that
      // only repeats the current ids is not an edit: the MCP access panel
      // sends them along with its agent-servers switch.
      ...("mcpConnectionIds" in request.patch
        && !sameMcpConnectionIds(
          request.patch.mcpConnectionIds,
          current.mcpConnectionIds,
        )
        ? { mcpConnectionIdsFromDefaults: undefined }
        : {}),
    };
    const patchedLaunchpad: NavigationLaunchpadDraft = {
      ...applyNavigationLaunchpadProviderSettingsPatch(current, patch),
      directoryKey: request.directoryKey,
      settingsTouchedAt: request.stickySettingsChanged
        ? Date.now()
        : current.settingsTouchedAt,
      updatedAt: Date.now(),
    };
    let nextLaunchpad = patchedLaunchpad;
    // A sub-thread draft keeps its plain key under a peer owner.
    const isPeerDraft =
      owner?.scope === "remote"
      || isRemoteLaunchpadStorageKey(request.directoryKey);
    // A peer's draft carries the owner's model choices. The viewer's catalog
    // cannot normalize them; the owner validates them when creating the thread.
    if (
      !isPeerDraft
      && (
        "model" in patch
        || "reasoningEffort" in patch
        || "serviceTier" in patch
        || "fastMode" in patch
      )
    ) {
      const projectedLaunchpad =
        projectNavigationLaunchpadProviderSettings(patchedLaunchpad);
      const backend = await this.resolveLaunchpadBackend(projectedLaunchpad.backend);
      const modelSettings = await this.resolveLaunchpadModelSettings(
        backend,
        projectedLaunchpad,
      );
      if ("fastMode" in patch && !("serviceTier" in request.patch)) {
        modelSettings.serviceTier = undefined;
      }
      nextLaunchpad = {
        ...applyNavigationLaunchpadProviderSettingsPatch(
          {
            ...projectedLaunchpad,
            backend: backend.kind,
            executionMode: getAvailableExecutionMode(
              backend,
              projectedLaunchpad.executionMode,
            ),
          },
          modelSettings,
        ),
        directoryKey: request.directoryKey,
        settingsTouchedAt: request.stickySettingsChanged
          ? Date.now()
          : current.settingsTouchedAt,
        updatedAt: Date.now(),
      };
    }
    const persisted = await this.context.stores.launchpads.upsertDirectoryLaunchpad(nextLaunchpad);

    // A peer's draft keeps the operator's pick (`settingsTouchedAt`) but
    // changes no default here. It is seeded from the owner's defaults, and
    // its models are the owner's: saved here, a local provider would start
    // new launchpads on a model it cannot run.
    const saveSticky = request.stickySettingsChanged === true && !isPeerDraft;
    const stickyPatch: Partial<NavigationLaunchpadDefaults> = {};
    if (saveSticky && request.patch.backend) {
      stickyPatch.backend = request.patch.backend;
    }
    if (saveSticky && patch.executionMode) {
      stickyPatch.executionMode = patch.executionMode;
    }
    if (saveSticky && "model" in patch) {
      stickyPatch.model = patch.model;
    }
    if (saveSticky && "reasoningEffort" in patch) {
      stickyPatch.reasoningEffort = patch.reasoningEffort;
    }
    if (saveSticky && "serviceTier" in patch) {
      stickyPatch.serviceTier = patch.serviceTier;
    }
    if (saveSticky && "fastMode" in patch) {
      stickyPatch.fastMode = patch.fastMode;
      if (!("serviceTier" in request.patch)) {
        stickyPatch.serviceTier = undefined;
      }
    }
    if (saveSticky && "acpRuntime" in patch) {
      stickyPatch.acpRuntime = patch.acpRuntime;
    }
    if (saveSticky && request.patch.workMode) {
      stickyPatch.workMode = request.patch.workMode;
    }

    const storedDefaults =
      Object.keys(stickyPatch).length > 0
        // These settings are this launchpad's provider's. Filed under the
        // defaults' provider instead, a Codex model became the Claude default.
        ? await this.context.stores.launchpads.setLaunchpadDefaults(stickyPatch, {
            provider: persisted.backend,
          })
        : await this.context.stores.launchpads.getLaunchpadDefaults();
    const shouldResolveStickyModelSettings =
      "model" in stickyPatch ||
      "reasoningEffort" in stickyPatch ||
      "serviceTier" in stickyPatch ||
      "fastMode" in stickyPatch;
    const defaults = shouldResolveStickyModelSettings
      ? await this.resolveLaunchpadDefaults(
          storedDefaults,
          stickyPatch.backend ?? persisted.backend,
        )
      : storedDefaults;

    return {
      launchpad: options?.skipFilesystemInspection
        ? persisted
        : withCodexEnvironmentOptions(
            persisted,
            await listCodexEnvironmentOptions(persisted.directoryPath),
          ),
      defaults,
    };
  }

  async resetDirectoryLaunchpad(
    request: ResetDirectoryLaunchpadRequest,
    options?: {
      /** The instance that owns `directoryKey`, as on an ensure. */
      owner?: FederationTarget;
    },
  ): Promise<ResetDirectoryLaunchpadResponse> {
    const storageKey = launchpadStorageKey(request.directoryKey, options?.owner);
    const launchpad = request.preserveEnvironment
      ? await this.context.stores.launchpads.getDirectoryLaunchpad({ directoryKey: storageKey })
      : undefined;
    if (launchpad) {
      await this.resetLaunchpadDraft(launchpad);
    } else {
      await this.context.stores.launchpads.resetDirectoryLaunchpad({ directoryKey: storageKey });
    }
    return {
      directoryKey: request.directoryKey,
      defaults: await this.context.stores.launchpads.getLaunchpadDefaults(),
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
        const overlay = await this.context.stores.threads.getThreadOverlayState({
          backend: request.backend,
          threadId: request.threadId,
        });
        const runtime = overlay?.codexEnvironmentRuntime;
        if (!runtime?.environmentId) {
          throw new Error("This thread does not have a selected environment.");
        }

        const currentCwd =
          request.cwd?.trim() ||
          (await this.host().resolveThreadEnvironmentCwd(
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
            [runtime.environmentId]: request.actionId,
          },
        };
        const runId = randomUUID();
        let nextRuntime: CodexThreadEnvironmentRuntime;
        try {
          nextRuntime = await startLocalCodexEnvironmentAction({
            actionId: request.actionId,
            runId,
            owner: {
              backend: request.backend,
              threadId: request.threadId,
            },
            commandRunner: this.codexEnvironmentCommandRunner,
            env: this.host().codexEnvironmentCommandEnv,
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
            await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
              backend: request.backend,
              threadId: request.threadId,
              codexEnvironmentRuntime: error.runtime,
            });
            this.host().invalidateThreadListCache(request.backend);
            await this.emitCodexEnvironmentRuntimeUpdated({
              backend: request.backend,
              threadId: request.threadId,
              codexEnvironmentRuntime: error.runtime,
            });
          }
          throw error;
        }
        await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });
        this.host().invalidateThreadListCache(request.backend);
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
        const overlay = await this.context.stores.threads.getThreadOverlayState({
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
        await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
          backend: request.backend,
          threadId: request.threadId,
          codexEnvironmentRuntime: nextRuntime,
        });
        this.host().invalidateThreadListCache(request.backend);
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
    onSetupProgress?: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    return this.withCodexEnvironmentRuntimeLock(
      request.backend,
      request.threadId,
      () => this.setCodexThreadEnvironmentLocked(request, onSetupProgress),
    );
  }

  private async setCodexThreadEnvironmentLocked(
    request: SetCodexThreadEnvironmentRequest,
    onSetupProgress?: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): Promise<SetCodexThreadEnvironmentResponse> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: request.backend,
      threadId: request.threadId,
    });
    const previousRuntime = overlay?.codexEnvironmentRuntime;
    // Runs belong to the thread, not its current environment selection. Fill
    // provenance for older entries before replacing the selected environment.
    const actionRuns = readCodexEnvironmentActionRuns(previousRuntime).map((run) => ({
      ...run,
      environmentId: run.environmentId ?? previousRuntime?.environmentId,
      environmentName: run.environmentName ?? previousRuntime?.environmentName,
    }));
    if (!request.environmentId) {
      const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime | undefined = actionRuns.length > 0
        ? { executionTarget: "local", actionRuns }
        : undefined;
      await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
        backend: request.backend,
        threadId: request.threadId,
        codexEnvironmentRuntime,
      });
      this.host().invalidateThreadListCache(request.backend);
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

    const cwd = await this.host().resolveThreadEnvironmentCwd(
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
    let setupRuntime = existingRuntime;
    let setupError: CodexEnvironmentStartupError | undefined;
    if (
      !existingRuntime
      || existingRuntime.setupStatus === "failed"
      || (environment.setupScript && !existingRuntime.setupStatus)
    ) {
      try {
        setupRuntime = await applyLocalCodexEnvironmentSelection({
          commandRunner: this.codexEnvironmentCommandRunner,
          cwd,
          env: this.host().codexEnvironmentCommandEnv,
          hydrationStore: this.codexEnvironmentHydrationStore,
          onSetupProgress: (event) => onSetupProgress?.({
            ...event,
            directoryKey: `thread:${request.backend}:${request.threadId}`,
          }),
          selection: {
            environment,
            executionTarget: existingRuntime?.executionTarget ?? "local",
            runSetup: true,
          },
        });
      } catch (error) {
        if (!(error instanceof CodexEnvironmentStartupError)) {
          throw error;
        }
        setupRuntime = error.runtime;
        setupError = error;
      }
    }
    const codexEnvironmentRuntime: CodexThreadEnvironmentRuntime = {
      ...(setupRuntime ?? {}),
      actionRuns: actionRuns.length > 0 ? actionRuns : undefined,
      environmentId: environment.id,
      environmentName: environment.name,
      executionTarget: existingRuntime?.executionTarget ?? "local",
      cwd,
      setupCommand: environment.setupScript,
      actions: environment.actions,
      selectedActionIdByEnvironmentId:
        Object.keys(selectedActionIdByEnvironmentId).length > 0
          ? selectedActionIdByEnvironmentId
          : undefined,
      sourcePath: environment.sourcePath,
    };
    await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
      backend: request.backend,
      threadId: request.threadId,
      codexEnvironmentRuntime,
    });
    this.host().invalidateThreadListCache(request.backend);
    await this.emitCodexEnvironmentRuntimeUpdated({
      backend: request.backend,
      threadId: request.threadId,
      codexEnvironmentRuntime,
    });

    if (setupError) {
      throw setupError;
    }

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
    await this.context.emit({
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
  withCodexEnvironmentRuntimeLock<T>(
    backend: AppServerBackendKind,
    threadId: string,
    task: () => Promise<T>,
  ): Promise<T> {
    return this.codexEnvironmentRuntimeLocks.run(
      buildThreadIdentityKey(backend, threadId),
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
          const overlay = await this.context.stores.threads.getThreadOverlayState({
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
          await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
            backend: params.backend,
            threadId: params.threadId,
            codexEnvironmentRuntime: next,
          });
          this.host().invalidateThreadListCache(params.backend);
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
        } finally {
          // Also covers a run that was evicted or a thread that is gone.
          this.context.stores.workspaces.dropThreadCodexEnvironmentActionLiveOutput?.({
            backend: params.backend,
            threadId: params.threadId,
            runId: params.runId,
          });
        }
      },
    );
  }

  /**
   * Called periodically (throttled to ~500ms) while a detached env-action
   * child is running, with a snapshot of its accumulated stdout+stderr.
   * Records the matching run's `output` in the overlay store's memory and
   * emits it, so the renderer's anchored UI and peers show live output.
   * Sqlite gets the tail at the run's boundaries (exit, stop, failure and
   * shutdown), never per snapshot. Does not change `status` — that stays
   * "started" until the child closes.
   */
  /** Shutdown is a boundary for running actions: persist their output tails. */
  flushCodexEnvironmentActionLiveOutputsForShutdown(): void {
    try {
      this.context.stores.workspaces.flushThreadCodexEnvironmentActionLiveOutputs?.();
    } catch (error) {
      backendRegistryLog.warn("codex-environment-action-output-flush-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

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
          const overlay = await this.context.stores.threads.getThreadOverlayState({
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
          const setLiveOutput = this.context.stores.workspaces.setThreadCodexEnvironmentActionLiveOutput;
          if (!ambiguousTerminalFailure && setLiveOutput) {
            // Shutdown already flushed the running tails; nothing is left to
            // persist or show this one.
            if (this.context.lifecycle.closed) return;
            setLiveOutput.call(this.context.stores.workspaces, {
              backend: params.backend,
              threadId: params.threadId,
              runId: params.runId,
              output: params.event.output,
            });
          } else {
            // A status change is a boundary. Stores without the memory layer
            // (test doubles) keep persisting every snapshot.
            await this.context.stores.workspaces.setThreadCodexEnvironmentRuntime?.({
              backend: params.backend,
              threadId: params.threadId,
              codexEnvironmentRuntime: next,
            });
            this.host().invalidateThreadListCache(params.backend);
          }
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
    options?: MaterializeDirectoryLaunchpadOptions & {
      sourceInstanceId?: FederationInstanceId;
    },
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const prepare = async (operation?: LaunchpadCreationOperation) => {
      const input = await options?.resolveInput?.();
      operation?.check();
      return await this.runMaterializeDirectoryLaunchpad(input ? { ...request, input } : request, options, operation);
    };
    if (!request.operationId) return await prepare();
    return await this.launchpadCreationOperations.run(request, options?.sourceInstanceId, async (operation) => {
      try {
        return await prepare(operation);
      } catch (error) {
        if (operation.controller.signal.aborted) {
          if (operation.actionRunId) {
            stopCodexEnvironmentDetachedCommand(operation.actionRunId, "terminate");
            await waitForCodexEnvironmentDetachedCommandGone({ runId: operation.actionRunId });
          }
          if (operation.status.threadId && operation.status.backend) {
            await this.host().archiveThread({ backend: operation.status.backend, threadId: operation.status.threadId });
          } else if (operation.workspaceRollback) {
            try {
              await operation.workspaceRollback();
              operation.workspaceRollback = undefined;
            } catch (cleanupError) {
              throw new Error(`Cancelled startup could not clean up its prepared workspace at ${operation.status.cwd}: ${String(cleanupError)}`, { cause: cleanupError });
            }
          }
          operation.check();
        }
        throw error;
      }
    });
  }

  async manageLaunchpadCreation(
    request: LaunchpadCreationRequest,
    sourceInstanceId?: FederationInstanceId,
  ): Promise<LaunchpadCreationResponse> {
    return this.launchpadCreationOperations.manage(request, sourceInstanceId);
  }

  private async runMaterializeDirectoryLaunchpad(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions & { sourceInstanceId?: FederationInstanceId },
    operation?: LaunchpadCreationOperation,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    operation?.check();
    if (!request.releaseLaunchpadOnSubmit) {
      return await this.materializeLaunchpadDraft(request, options, operation);
    }
    const launchpad =
      request.launchpad ??
      (await this.context.stores.launchpads.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      }));
    if (!launchpad) {
      throw new Error(`No launchpad found for ${request.directoryKey}`);
    }
    // Release the draft before the slow part (worktree, environment setup,
    // thread start) so the operator can compose the next thread in this
    // directory while this one starts.
    await this.resetLaunchpadDraft(launchpad);
    const released = await this.context.stores.launchpads.getDirectoryLaunchpad({
      directoryKey: launchpad.directoryKey,
    });
    try {
      return await this.materializeLaunchpadDraft({ ...request, launchpad }, options, operation);
    } catch (error) {
      // No thread exists, so the draft is still the operator's only copy of
      // the message. Put it back, unless they have already started another.
      const current = await this.context.stores.launchpads.getDirectoryLaunchpad({
        directoryKey: launchpad.directoryKey,
      });
      if (JSON.stringify(current) === JSON.stringify(released)) {
        await this.context.stores.launchpads.upsertDirectoryLaunchpad(launchpad);
      }
      throw error;
    }
  }

  private async resetLaunchpadDraft(
    launchpad: NavigationLaunchpadDraft,
  ): Promise<void> {
    await resetLaunchpadAfterMaterialize({
      defaultPrAutoDispatchEnabled: this.host().resolveDefaultPrAutoDispatchEnabledFn(),
      defaults: await this.resolveLaunchpadDefaults(
        await this.context.stores.launchpads.getLaunchpadDefaults(),
        launchpad.backend,
      ),
      launchpad,
      overlayStore: this.context.stores.launchpads,
    });
  }

  private async materializeLaunchpadDraft(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions & {
      sourceInstanceId?: FederationInstanceId;
    },
    operation?: LaunchpadCreationOperation,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    return await listingDiagnostics.trace("workflow", { query: "first-send" }, () => this.materializeLaunchpadDraftPrepared(request, options, operation));
  }

  private async materializeLaunchpadDraftPrepared(
    request: MaterializeDirectoryLaunchpadRequest,
    options?: MaterializeDirectoryLaunchpadOptions & { sourceInstanceId?: FederationInstanceId },
    operation?: LaunchpadCreationOperation,
  ): Promise<MaterializeDirectoryLaunchpadResponse> {
    const draft =
      request.launchpad ??
      (await this.context.stores.launchpads.getDirectoryLaunchpad({
        directoryKey: request.directoryKey,
      }));
    if (!draft) {
      throw new Error(`No launchpad found for ${request.directoryKey}`);
    }
    const projectedDraft = projectNavigationLaunchpadProviderSettings(draft);
    await this.host().admitNewThreadModelSettings(projectedDraft.backend, projectedDraft);
    let launchpad = options?.sourceInstanceId
      ? await this.resolveRemoteLaunchpadModelSettings(draft)
      : draft;
    operation?.update({ backend: launchpad.backend, projectPath: launchpad.directoryPath, title: request.input?.find((item) => item.type === "text")?.text ?? launchpad.prompt });
    operation?.check();
    if (
      request.scheduledFor !== undefined
      && (!Number.isFinite(request.scheduledFor) || request.scheduledFor < 0)
    ) {
      throw new Error("Scheduled time must be a finite Unix timestamp.");
    }
    const [codexEnvironmentOptions] = await joinConcurrent([
      listCodexEnvironmentOptions(launchpad.directoryPath),
      this.host().getBackendLaunchpadOptions(launchpad.backend, "thread-start-defaults"),
    ]);
    if (request.codexEnvironmentSelector?.trim()) {
      // An agent names an environment by id or name; only this machine has
      // the project's config to resolve it. Refuse before any workspace work.
      const resolution = resolveCodexEnvironmentSelector(
        request.codexEnvironmentSelector,
        codexEnvironmentOptions,
        launchpad.directoryLabel,
      );
      if (resolution.kind === "missing") {
        throw new Error(resolution.message);
      }
      const keepsAction = launchpad.codexEnvironmentId === resolution.environment.id;
      launchpad = {
        ...launchpad,
        codexEnvironmentId: resolution.environment.id,
        codexEnvironmentExecutionTarget:
          launchpad.codexEnvironmentExecutionTarget ?? "local",
        codexEnvironmentActionId: keepsAction
          ? launchpad.codexEnvironmentActionId
          : undefined,
      };
    }

    operation?.check();
    const preparedWorkspace =
      await listingDiagnostics.trace("workflow", { query: "workspace-preparation" }, () => this.host().gitDirectoryService.prepareLaunchpadWorkspace(
        request.worktreeBase
          ? { ...launchpad, worktreeBase: request.worktreeBase }
          : launchpad,
      ));
    // Retain ownership before the next await/check: cancellation may have
    // overtaken preparation. Existing/local workspaces supply no rollback.
    if (operation) operation.workspaceRollback = preparedWorkspace.rollback;
    if (request.requiredWorkMode && preparedWorkspace.workMode !== request.requiredWorkMode) {
      // Refuse before a thread exists. A worktree request that falls back
      // would otherwise share the project checkout.
      if (operation) operation.workspaceRollback = undefined;
      await refuseResolvedWorkMode({
        required: request.requiredWorkMode,
        resolved: preparedWorkspace.workMode,
        rollback: preparedWorkspace.rollback,
        backend: launchpad.backend,
      });
    }
    const workspace =
      launchpad.directoryKind === "workspace" && !preparedWorkspace.cwd
        ? {
            ...preparedWorkspace,
            cwd: await this.host().createScratchProjectDirectory(),
          }
        : preparedWorkspace;
    operation?.update({ cwd: workspace.cwd });
    operation?.check();
    const repositoryPath = await resolvePreparedRepositoryIdentityPath({
      preparedPath: workspace.repositoryPath,
      requestedPath: launchpad.directoryPath,
    });
    const linkedDirectories =
      workspace.workMode === "worktree"
        ? buildWorktreeLinkedDirectory({
            label: launchpad.directoryLabel,
            repositoryPath,
            worktreePath: workspace.cwd,
          })
        : undefined;
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
    if (operation) {
      operation.actionRunId = autoActionRunId;
      operation.controller.signal.addEventListener("abort", () => {
        stopCodexEnvironmentDetachedCommand(autoActionRunId, "terminate");
      }, { once: true });
    }
    const pendingActionThreadIdRef: { current?: string } = {};
    const queuedActionDetachedExits: CodexEnvironmentDetachedExit[] = [];
    const queuedActionDetachedOutputs: CodexEnvironmentDetachedOutput[] = [];
    const codexActionBackend: AppServerBackendKind = launchpad.backend;
    const onActionDetachedExit = (event: CodexEnvironmentDetachedExit) => {
      if (pendingActionThreadIdRef.current && codexEnvironmentSelection?.action?.id) {
        void this.handleCodexEnvironmentActionDetachedExit({
          backend: codexActionBackend,
          threadId: pendingActionThreadIdRef.current,
          runId: autoActionRunId,
          event,
        });
        return;
      }
      queuedActionDetachedExits.push(event);
    };
    const onActionDetachedOutput = (event: CodexEnvironmentDetachedOutput) => {
      if (pendingActionThreadIdRef.current && codexEnvironmentSelection?.action?.id) {
        void this.handleCodexEnvironmentActionDetachedOutput({
          backend: codexActionBackend,
          threadId: pendingActionThreadIdRef.current,
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
      codexEnvironmentRuntime = await listingDiagnostics.trace("workflow", { query: "environment-setup" }, () => applyLocalCodexEnvironmentSelection({
        signal: operation?.controller.signal,
        commandRunner: this.codexEnvironmentCommandRunner,
        cwd: workspace.cwd,
        env: this.host().codexEnvironmentCommandEnv,
        onSetupProgress: (event) => {
          const progress = {
            directoryKey: request.codexEnvironmentSetupProgressKey ?? launchpad.directoryKey,
            ...event,
            operationId: request.operationId,
            sequence: operation ? (operation.status.setupProgress?.sequence ?? 0) + 1 : undefined,
          };
          const previous = operation?.status.setupProgress;
          operation?.update({
            phase: operation.controller.signal.aborted ? "cancelling" : "setup",
            setupProgress: {
              ...progress,
              output: event.output ?? `${previous?.output ?? ""}${event.chunk ?? ""}`.slice(-32_000),
            },
          });
          try {
            options?.onCodexEnvironmentSetupProgress?.(progress);
          } catch (error) {
            backendRegistryLog.warn("launchpad-setup-progress-delivery-failed", { operationId: request.operationId, error: String(error) });
          }
        },
        onActionDetachedExit,
        onActionDetachedOutput,
        actionRunId: autoActionRunId,
        // The thread doesn't exist yet — `attachDetachedCommandThreadId` below
        // back-fills it once `startThread` returns. Registering the owner now
        // is what keeps an auto-started dev server visible to the quit dialog.
        owner: { backend: codexActionBackend },
        hydrationStore: this.codexEnvironmentHydrationStore,
        selection: codexEnvironmentSelection,
      }));
    } catch (error) {
      operation?.check();
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
    operation?.check();
    operation?.update({ phase: "creating" });
    const startThreadResponse = await this.host().startThread({
      backend: launchpad.backend,
      executionMode: launchpad.executionMode,
      agent: request.agent ?? launchpad.agent,
      cwd: workspace.cwd,
      linkedDirectories,
      model: launchpad.model,
      reasoningEffort: launchpad.reasoningEffort,
      serviceTier: launchpad.serviceTier,
      fastMode: launchpad.backend === "codex" ? launchpad.fastMode : undefined,
      mcpConnectionIds: launchpad.mcpConnectionIds,
      // Same Codex-only guard as `fastMode` above: switching a draft's
      // provider leaves the stale isolation flag behind, and the ACP path
      // would then run with the agent's own servers live while the thread
      // claims otherwise.
      mcpProviderServersEnabled: canIsolateMcpProviderServers(launchpad.backend)
        ? launchpad.mcpProviderServersEnabled
        : undefined,
      prAutoDispatchEnabled:
        launchpad.prAutoDispatchEnabled ?? this.host().resolveDefaultPrAutoDispatchEnabledFn(),
      tokenMiserEnabled: launchpad.tokenMiserEnabled,
      acpRuntime: launchpad.acpRuntime,
      codexEnvironmentRuntime,
      directoryKey: launchpad.directoryKey,
      parentThreadId: request.parentThreadId ?? launchpad.parentThreadId,
      parentThreadBackend:
        request.parentThreadBackend ?? launchpad.parentThreadBackend,
      parentThreadInstanceId:
        request.parentThreadInstanceId ?? launchpad.parentThreadInstanceId,
    });
    operation?.update({ threadId: startThreadResponse.threadId });
    if (operation) operation.workspaceRollback = undefined;
    operation?.check();
    const linkedDirectory = linkedDirectories?.[0];
    if (linkedDirectory) {
      // Preserve the launchpad's requested repository identity durably. Codex
      // can report the same repository through a physical path alias (for
      // example macOS /private/var for a requested /var path), but the
      // worktree path still proves these describe one prepared workspace.
      await this.replaceWorkspaceLinkedDirectory({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        directory: linkedDirectory,
      });
    }
    pendingActionThreadIdRef.current = startThreadResponse.threadId;
    // The auto-started environment action spawned before this thread existed;
    // give its detached-process record an owner now so the quit dialog can name
    // it and link back here.
    attachDetachedCommandThreadId(autoActionRunId, startThreadResponse.threadId);
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
      await this.host().recordCodexWorktreeOwnerThread({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        worktreePath: workspace.cwd,
      });
    }
    const materializedThread = {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      executionMode: startThreadResponse.executionMode,
      ...(startThreadResponse.pinnedRank
        ? { pinnedRank: startThreadResponse.pinnedRank }
        : {}),
      ...(startThreadResponse.autoPinFailure
        ? { autoPinFailure: startThreadResponse.autoPinFailure }
        : {}),
      ...(linkedDirectories?.[0] ? { linkedDirectory: linkedDirectories[0] } : {}),
      workMode: workspace.workMode,
      codexEnvironmentRuntime,
      codexEnvironmentStartupFailure,
    } satisfies MaterializedDirectoryLaunchpadThread;
    const pendingLaunch: PendingEnvironmentLaunch = {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
      request,
      launchpad,
      messageOrigin: options?.messageOrigin,
    };
    let continuation: ContinueThreadEnvironmentStartupResponse = {
      backend: startThreadResponse.backend,
      threadId: startThreadResponse.threadId,
    };
    if (codexEnvironmentStartupFailure) {
      const retainedInput = await ownThreadInputAttachments(
        request.input ?? (launchpad.prompt.trim() ? [{ type: "text", text: launchpad.prompt }] : []),
        pendingLaunch,
        this.host().localFilePrivateStorageRoots,
      );
      this.host().pendingEnvironmentLaunchStore.put({ ...pendingLaunch, request: { ...request, input: retainedInput } });
    }
    await options?.onThreadMaterialized?.(materializedThread);
    operation?.commit();
    if (!codexEnvironmentStartupFailure) {
      continuation = await this.startMaterializedLaunchpadRequest(pendingLaunch);
    }

    if (!request.releaseLaunchpadOnSubmit) {
      await this.resetLaunchpadDraft(launchpad);
    } else if (launchpad.prompt.trim()) {
      // Released at submit. A draft save the renderer sent just before
      // submitting can still land after that release and bring the sent
      // prompt back. Clear it again only if it is still that prompt, so a
      // new draft the operator started meanwhile survives.
      const current = await this.context.stores.launchpads.getDirectoryLaunchpad({
        directoryKey: launchpad.directoryKey,
      });
      if (current?.prompt === launchpad.prompt) {
        await this.resetLaunchpadDraft(launchpad);
      }
    }

    return {
      ...materializedThread,
      ...continuation,
    };
  }

  private async startMaterializedLaunchpadRequest(
    pending: PendingEnvironmentLaunch,
  ): Promise<ContinueThreadEnvironmentStartupResponse> {
    const { request, launchpad, messageOrigin } = pending;
    const startThreadResponse = pending;
    const input =
      request.input ??
      (launchpad.prompt.trim()
        ? [{ type: "text", text: launchpad.prompt } as const]
        : []);
    let turnId: string | undefined;
    let scheduledAction:
      | MaterializeDirectoryLaunchpadResponse["scheduledAction"]
      | undefined;
    let turnStartFailure:
      | MaterializeDirectoryLaunchpadResponse["turnStartFailure"]
      | undefined;
    if (request.scheduledFor !== undefined) {
      const actionId = `scheduled-action:${randomUUID()}`;
      await this.context.stores.threads.setThreadScheduledStart({
        backend: launchpad.backend,
        threadId: startThreadResponse.threadId,
        scheduledStart: {
          actionId,
          scheduledFor: request.scheduledFor,
          state: "scheduled",
        },
      });
      this.host().invalidateThreadListCache(launchpad.backend);
      try {
        const displayText = request.reviewTarget
          ? reviewTaskLabel(request.reviewTarget)
          : extractFirstMeaningfulTextInput(input) ?? "Scheduled message";
        const createScheduledThreadAction = this.host().createScheduledThreadActionFn;
        if (!createScheduledThreadAction) {
          throw new Error("Scheduled thread action service is unavailable");
        }
        const response = await createScheduledThreadAction(
          {
            backend: launchpad.backend,
            threadId: startThreadResponse.threadId,
            kind: request.reviewTarget ? "review" : "turn",
            origin: "desktop",
            scheduledFor: request.scheduledFor,
            displayText,
            imageAttachments: launchpad.imageAttachments,
            fileAttachments: launchpad.fileAttachments,
            ...(request.reviewTarget
              ? {
                  review: {
                    target: request.reviewTarget,
                    draftText: formatReviewCommand(request.reviewTarget),
                    delivery: "inline" as const,
                    model: launchpad.model,
                    reasoningEffort: launchpad.reasoningEffort,
                    serviceTier: launchpad.serviceTier,
                    fastMode:
                      launchpad.backend === "codex"
                        ? launchpad.fastMode
                        : undefined,
                  },
                }
              : {
                  turn: {
                    input,
                    executionMode: launchpad.executionMode,
                    model: launchpad.model,
                    collaborationMode: request.collaborationMode,
                    serviceTier: launchpad.serviceTier,
                    reasoningEffort: launchpad.reasoningEffort,
                    fastMode:
                      launchpad.backend === "codex"
                        ? launchpad.fastMode
                        : undefined,
                    messageOrigin,
                  },
                }),
          },
          { id: actionId },
        );
        scheduledAction = response.action;
        this.host().scheduleThreadTitleGeneration({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          input: request.reviewTarget
            ? [{
                type: "text",
                text: reviewThreadTitlePrompt({
                  branchName: launchpad.branchName,
                  directoryLabel: launchpad.directoryLabel,
                  target: request.reviewTarget,
                }),
              }]
            : input,
        });
      } catch (error) {
        await this.context.stores.threads.setThreadScheduledStart({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          scheduledStart: undefined,
        });
        this.host().invalidateThreadListCache(launchpad.backend);
        turnStartFailure = {
          message: error instanceof Error ? error.message : String(error),
          phase: request.reviewTarget ? "review" : "turn",
        };
      }
    } else if (request.reviewTarget) {
      try {
        const reviewResponse = await this.host().startReview({
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
        // A review is the thread's whole first turn. Nothing else will supply
        // a prompt to name it from, so name it from the review target here.
        this.host().scheduleThreadTitleGeneration({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          input: [{
            type: "text",
            text: reviewThreadTitlePrompt({
              branchName: launchpad.branchName,
              directoryLabel: launchpad.directoryLabel,
              target: request.reviewTarget,
            }),
          }],
        });
      } catch (error) {
        turnStartFailure = {
          message: error instanceof Error ? error.message : String(error),
          phase: "review",
        };
      }
    } else if (input.length > 0) {
      try {
        const turnResponse = await this.host().startTurn({
          backend: launchpad.backend,
          threadId: startThreadResponse.threadId,
          input,
          messageOrigin,
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

    return {
      backend: pending.backend,
      threadId: pending.threadId,
      turnId,
      scheduledAction,
      turnStartFailure,
    };
  }

  async acknowledgeThreadEnvironmentFailure(
    request: AcknowledgeThreadEnvironmentFailureRequest,
  ): Promise<AcknowledgeThreadEnvironmentFailureResponse> {
    const backend = request.backend ?? "codex";
    return await this.withCodexEnvironmentRuntimeLock(backend, request.threadId, async () => {
      const acknowledged = await this.context.stores.workspaces.acknowledgeThreadEnvironmentFailure?.({ ...request, backend }) ?? false;
      this.host().pendingEnvironmentLaunchStore.delete({ backend, threadId: request.threadId });
      if (acknowledged) {
        const overlay = await this.context.stores.threads.getThreadOverlayState({ backend, threadId: request.threadId });
        this.host().invalidateThreadListCache(backend);
        await this.emitCodexEnvironmentRuntimeUpdated({ backend, threadId: request.threadId, codexEnvironmentRuntime: overlay?.codexEnvironmentRuntime });
      }
      return { backend, threadId: request.threadId, acknowledged };
    });
  }

  async continueThreadEnvironmentStartup(
    request: ContinueThreadEnvironmentStartupRequest,
  ): Promise<ContinueThreadEnvironmentStartupResponse> {
    const key = buildThreadIdentityKey(request.backend, request.threadId);
    const existing = this.environmentLaunchContinuations.get(key);
    if (existing) return await existing;
    const continuation = this.resumeEnvironmentLaunch(request);
    this.environmentLaunchContinuations.set(key, continuation);
    try { return await continuation; }
    finally { this.environmentLaunchContinuations.delete(key); }
  }

  private async resumeEnvironmentLaunch(
    request: ContinueThreadEnvironmentStartupRequest,
  ): Promise<ContinueThreadEnvironmentStartupResponse> {
    if (this.host().threadHasActiveTurn(request.threadId, request.backend)) {
      throw new Error("This thread already has an active turn. Refresh it to view the conversation.");
    }
    const pending = this.host().pendingEnvironmentLaunchStore.get(request);
    const history = await this.host().readThread({ backend: request.backend, threadId: request.threadId, limit: 1 });
    if (history.replay.messages.length > 0 || history.replay.entries.some((entry) => entry.type === "message")) {
      this.host().pendingEnvironmentLaunchStore.delete(request);
      throw new Error("This thread has already started. Refresh it to view the conversation.");
    }
    let result: ContinueThreadEnvironmentStartupResponse;
    if (pending) {
      result = await this.startMaterializedLaunchpadRequest(pending);
      if (result.turnStartFailure) throw new Error(result.turnStartFailure.message);
    } else if (request.fallbackTurn?.input.length) {
      const overlay = await this.context.stores.threads.getThreadOverlayState(request);
      if (overlay?.scheduledStart || typeof overlay?.codexEnvironmentRuntime?.setupFailureAcknowledgedAt === "number") {
        throw new Error("This thread's environment startup has already been continued. Refresh it to view its state.");
      }
      result = await this.host().startTurn({ ...request.fallbackTurn, backend: request.backend, threadId: request.threadId });
    } else {
      throw new Error("The original request is unavailable. Send your prompt again to start this thread.");
    }
    this.host().pendingEnvironmentLaunchStore.delete(request);
    await this.acknowledgeThreadEnvironmentFailure(request);
    return result;
  }

  private async resolveLaunchpadBackend(
    preferred: AppServerBackendKind,
  ): Promise<BackendSummary> {
    const { backends } = await this.host().listBackends({ includeUnavailable: true });
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

  /**
   * Resolve a draft that another instance composed against this instance's
   * provider catalog.
   *
   * Admission has checked explicit choices against the owner's catalog.
   * Resolve omitted choices using that same owner's provider defaults.
   */
  private async resolveRemoteLaunchpadModelSettings(
    launchpad: NavigationLaunchpadDraft,
  ): Promise<NavigationLaunchpadDraft> {
    const projected = projectNavigationLaunchpadProviderSettings(launchpad);
    const { backends } = await this.host().listBackends({ includeUnavailable: true });
    const backend = backends.find(
      (candidate) => candidate.kind === projected.backend,
    );
    if (!backend) {
      return launchpad;
    }
    return applyNavigationLaunchpadProviderSettingsPatch(
      projected,
      await this.resolveLaunchpadModelSettings(backend, projected),
    );
  }

  private async resolveLaunchpadModelSettings(
    backend: BackendSummary,
    settings: ModelSettings,
  ): Promise<ModelSettings> {
    if (backend.kind === "codex") {
      // The summary can still contain fallback models while discovery is in
      // flight. Settings resolution must await the shared runtime catalog.
      return this.host().resolveModelSettings("codex", settings, "launchpad-defaults");
    }
    const launchpadOptions =
      backend.launchpadOptions ??
      (await this.host().getBackendLaunchpadOptions(backend.kind, "launchpad-defaults"));

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
    const providerModelDefaults = this.host().resolveProviderModelDefaultsFn();
    // Access saved for this provider wins; otherwise the provider's default
    // from Settings (Auto for Codex and Claude unless changed).
    const storedExecutionMode =
      projectedDefaults.providerSettings?.[backend.kind]?.executionMode
      ?? (backend.kind === storedDefaults.backend
        ? storedDefaults.executionMode
        : undefined);
    const backendDefaults =
      backend.kind === projectedDefaults.backend
        ? projectedDefaults
        : projectNavigationLaunchpadProviderSettings({
            ...projectedDefaults,
            backend: backend.kind,
            executionMode: undefined as unknown as ThreadExecutionMode,
            model: undefined,
            reasoningEffort: undefined,
            serviceTier: undefined,
            fastMode: undefined,
            acpRuntime: undefined,
          });
    if (storedExecutionMode === undefined) {
      backendDefaults.executionMode = resolveDefaultLaunchpadExecutionMode(
        backend.kind,
        providerModelDefaults,
      );
    }
    const configuredDefaults = providerModelDefaults[backend.kind];
    const configuredModel = configuredDefaults?.model;
    const configuredReasoningEffort = configuredModel
      ? configuredDefaults.reasoningEffortsByModel[configuredModel]
      : undefined;
    const appliedConfiguredModel =
      backendDefaults.model === undefined && configuredModel !== undefined;
    const appliedConfiguredReasoning =
      backendDefaults.reasoningEffort === undefined
      && (
        configuredDefaults?.reasoningEffortsByModel[
          backendDefaults.model ?? configuredModel ?? ""
        ] !== undefined
      );
    let modelSettings = await this.resolveLaunchpadModelSettings(
      backend,
      {
        ...backendDefaults,
        model: backendDefaults.model ?? configuredModel,
        reasoningEffort:
          backendDefaults.reasoningEffort ??
          (backendDefaults.model
            ? configuredDefaults?.reasoningEffortsByModel[backendDefaults.model]
            : configuredReasoningEffort),
      },
    );
    if (appliedConfiguredModel && modelSettings.model !== configuredModel) {
      // Do not carry the missing model's reasoning preference onto the
      // provider fallback merely because the fallback accepts the same effort
      // label.
      modelSettings = await this.resolveLaunchpadModelSettings(
        backend,
        backendDefaults,
      );
    }
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
      resolvedDefaults.backend === "codex"
      && !this.host().resolveCodexFastAllowedFn()
    ) {
      resolvedDefaults.fastMode = false;
      delete resolvedDefaults.serviceTier;
    }
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
    if (
      (appliedConfiguredModel && modelSettings.model !== configuredModel)
      || (
        appliedConfiguredReasoning
        && modelSettings.reasoningEffort !== (
          configuredDefaults?.reasoningEffortsByModel[
            backendDefaults.model ?? configuredModel ?? ""
          ]
        )
      )
    ) {
      // Keep unavailable profile preferences suspended in config instead of
      // learning the provider fallback as a new sticky choice. If the model
      // or effort returns after a provider upgrade, new launchpads can use the
      // explicit preference again.
      return resolvedDefaults;
    }

    return await this.context.stores.launchpads.setLaunchpadDefaults(resolvedDefaults);
  }

  /**
   * Rebind a thread's workspace directory, and drop the remembered provider
   * rows whose directory data is now stale.
   *
   * A remembered row carries the directory set the provider last reported, and
   * `resolveThreadWorkspaceCwd` ranks those ahead of the overlay whenever they
   * do not already match it -- which, immediately after a rebind, is precisely
   * when they do not. Keeping the row across this write therefore sends the
   * next turn to the directory the thread just moved off, and nothing corrects
   * it: no notification reports a directory change, and surviving cache
   * invalidation is the whole point of this store.
   *
   * Every rebind goes through here rather than through the overlay store
   * directly, so a site added later cannot forget the second half.
   */
  async replaceWorkspaceLinkedDirectory(params: {
    resetProjectState?: boolean;
    backend: AppServerBackendKind;
    directory: LinkedDirectorySummary;
    gitBranch?: string;
    threadId: string;
    retainWorktree?: LinkedDirectorySummary;
    preserveOtherWorktrees?: boolean;
  }): Promise<ThreadOverlayState> {
    const paths = [params.directory.path, linkedDirectoryWorktreePath(params.directory)].filter((value): value is string => Boolean(value));
    this.threadArchiveCoordinator.recordArchiveWorkspaceChange(buildThreadIdentityKey(params.backend, params.threadId), paths);
    const overlay =
      await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([linkedDirectoryWorktreePath(params.directory) ?? params.directory.path],
        async () => await this.context.stores.directories.replaceWorkspaceLinkedDirectory(params));
    this.threadArchiveCoordinator.invalidateArchiveCleanupReads(params.backend, undefined, true, params.threadId, paths);
    this.host().threadInfoStore.invalidateSummaries({
      backend: params.backend,
      threadId: params.threadId,
    });
    return overlay;
  }

  private async readCheapCodexThreadForRepair(
    threadId: string,
  ): Promise<AppServerThreadSummary | undefined> {
    const cached = this.host().getCachedThreadSummary({ backend: "codex", threadId });
    if (cached) {
      return cached;
    }

    const threads = await this.context.providers.codex.listThreads(
      {
        archived: false,
        enrichDirectories: false,
        filter: threadId,
      },
      {
        callerReason: "selected-thread-directory-repair",
        ownerId: this.host().threadListCacheOwnerId,
      },
    );
    return threads.find((thread) => thread.id === threadId);
  }

  async refreshThreadDirectoryRelationship(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    if (this.context.lifecycle.closed) return;
    if (params.backend !== "codex") {
      // Claude and ACP providers report a cwd, not live Git metadata. The
      // selected-thread timer and hover must observe it on their behalf too.
      const overlay = await this.context.stores.threads.getThreadOverlayState(params);
      await this.host().checkThreadBranchDrift(params);
      const refreshed = await this.context.stores.threads.getThreadOverlayState(params);
      if (this.context.lifecycle.closed
        || (refreshed?.observedGitBranch === overlay?.observedGitBranch
          && refreshed?.gitBranch === overlay?.gitBranch)) {
        return;
      }
      await this.context.emit({
        backend: params.backend,
        notification: {
          method: "navigation/threadDirectories/updated",
          params: { reason: "selected-thread", threadIds: [params.threadId] },
        },
      });
      return;
    }
    await this.repairCodexThreadDirectoryRelationship({
      reason: "selected-thread", threadId: params.threadId,
    });
  }

  async repairCodexThreadDirectoryRelationship(params: {
    reason: "selected-thread";
    threadId: string;
  }): Promise<void> {
    if (this.context.lifecycle.closed) return;
    const existing = this.pendingDirectoryRepairs.get(params.threadId);
    if (existing) return existing;
    const pending = this.loadCodexThreadDirectoryRelationship(params);
    this.pendingDirectoryRepairs.set(params.threadId, pending);
    try {
      await pending;
    } finally {
      if (this.pendingDirectoryRepairs.get(params.threadId) === pending) {
        this.pendingDirectoryRepairs.delete(params.threadId);
      }
    }
  }

  private async loadCodexThreadDirectoryRelationship(params: {
    reason: "selected-thread";
    threadId: string;
  }): Promise<void> {
    if (!this.context.providers.codex.enrichThreadDirectories) {
      return;
    }
    // Pending threads already carry the workspace PwrAgent just prepared.
    // Repairing them can persist a second identity for that same worktree.
    if (
      this.host().pendingStartedThreads.has(
        buildThreadIdentityKey("codex", params.threadId),
      )
    ) {
      return;
    }

    try {
      const cheapThread = await this.readCheapCodexThreadForRepair(params.threadId);
      if (!cheapThread?.projectKey?.trim()) {
        return;
      }

      const [enrichedThread] = await this.context.providers.codex.enrichThreadDirectories([
        cheapThread,
      ], "selected-thread");
      if (!enrichedThread || this.context.lifecycle.closed) {
        return;
      }

      const directory = buildCachedDirectoryRelationship(enrichedThread);
      if (!directory) {
        return;
      }

      const overlay = await this.context.stores.threads.getThreadOverlayState({
        backend: "codex",
        threadId: params.threadId,
      });
      if (this.context.lifecycle.closed) return;
      this.threadWorkspaceService.schedulePendingCodexWorkspaceCwdSyncs({
        overlaysByThreadId: { [params.threadId]: overlay },
        threads: [enrichedThread],
      });
      if (!shouldRepairCachedDirectoryRelationship({ directory, overlay })) {
        return;
      }

      await this.replaceWorkspaceLinkedDirectory({
        backend: "codex",
        threadId: params.threadId,
        directory,
        preserveOtherWorktrees: true,
      });
      this.host().invalidateThreadListCache("codex");
      await this.emitCodexDirectoryRelationshipsUpdated({
        reason: params.reason,
        threadIds: [params.threadId],
      });
    } catch (error) {
      backendRegistryLog.warn("Codex selected thread directory repair failed", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
    }
  }

  async emitCodexDirectoryRelationshipsUpdated(params: {
    reason: "selected-thread" | "full-reconcile" | "thread-created";
    threadIds: string[];
  }): Promise<void> {
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "navigation/threadDirectories/updated",
        params,
      },
    });
  }

  async reconcileCodexDirectoryRelationshipsFromSource(params: {
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
      // Wait for the provider to acknowledge the prepared workspace before
      // deriving a persisted directory identity from its thread summary.
      if (
        this.host().pendingStartedThreads.has(
          buildThreadIdentityKey("codex", thread.id),
        )
      ) {
        continue;
      }
      const directory = buildCachedDirectoryRelationship(thread);
      if (!directory) {
        continue;
      }

      const overlay = params.overlaysByThreadId[thread.id];
      if (!shouldRepairCachedDirectoryRelationship({ directory, overlay })) {
        continue;
      }

      updatedOverlaysByThreadId[thread.id] =
        await this.replaceWorkspaceLinkedDirectory({
          backend: "codex",
          threadId: thread.id,
          directory,
          preserveOtherWorktrees: true,
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

  async backfillMissingCodexDirectoryRelationships(params: {
    diagnostics?: {
      callerReason?: string;
      ownerId?: string;
    };
    overlaysByThreadId: Record<string, ThreadOverlayState | undefined>;
    threads: AppServerThreadSummary[];
  }): Promise<Record<string, ThreadOverlayState | undefined>> {
    if (!this.context.providers.codex.enrichThreadDirectories) {
      return {};
    }

    const candidates = params.threads.filter((thread) => {
      // The pending summary is already enriched from workspace preparation.
      if (
        this.host().pendingStartedThreads.has(
          buildThreadIdentityKey("codex", thread.id),
        )
      ) {
        return false;
      }
      // A handoff overlay is the authoritative workspace selection, so a
      // relationship derived from the provider's projectKey can never be
      // persisted — `shouldRepairCachedDirectoryRelationship` refuses every
      // thread whose overlay carries one. Enriching it anyway is guaranteed
      // wasted work, and when the provider still reports a pre-handoff
      // worktree that has since been removed, enrichment resolves nothing and
      // the miss below logs a phantom "no worktree relationship" warning for a
      // thread whose directory is already correct in the overlay.
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
      const enrichedThreads = await this.context.providers.codex.enrichThreadDirectories(
        candidates, "missing-worktree-backfill",
      );
      const updatedOverlaysByThreadId: Record<
        string,
        ThreadOverlayState | undefined
      > = {};

      for (const thread of enrichedThreads) {
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

        const overlay = params.overlaysByThreadId[thread.id];
        if (!shouldRepairCachedDirectoryRelationship({ directory, overlay })) {
          continue;
        }

        updatedOverlaysByThreadId[thread.id] =
          await this.replaceWorkspaceLinkedDirectory({
            backend: "codex",
            threadId: thread.id,
            directory,
            preserveOtherWorktrees: true,
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

  async registerThreadWorktree(
    request: PwrAgentThreadOrchestrationRequest<"register_thread_worktree">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const caller = request.context;
    const live = () => Boolean(caller.turnId && this.host().isLiveDynamicToolCall(caller.backend, {
      threadId: caller.threadId, turnId: caller.turnId,
    }));
    if (!live()) return threadOrchestrationFailure("forbidden", "Worktree registration requires a live invoking turn.");
    const { backend, threadId, worktreePath } = request.args;
    if (!isAppServerBackendKind(backend) || !threadId.trim() || !path.isAbsolute(worktreePath)) {
      return threadOrchestrationFailure("invalid_arguments", "Pass a known backend, threadId and absolute worktreePath.");
    }
    if (!this.context.stores.directories.setThreadWorktreeRegistration) {
      return threadOrchestrationFailure("unsupported_capability", "Worktree registration storage is unavailable.");
    }
    const unregister = request.args.action === "unregister";
    const readOwner = async () => {
      // Only the local provider inventory establishes current-profile membership.
      // Do not accept a PR reference, a cached navigation row or an arbitrary cwd.
      let thread: AppServerThreadSummary | undefined;
      for (const archived of [false, true]) {
        if (backend === "codex") {
          if (!this.context.providers.codex.listArchiveCleanupThreadsPage) throw new Error("Current-profile inventory is unavailable.");
          const cursors = new Set<string>();
          let cursor: string | undefined;
          do {
            const page = await this.context.providers.codex.listArchiveCleanupThreadsPage({ archived, cursor, limit: 100,
              checkpoint: async () => {}, directoryFilter: async () => false });
            thread = page.threads.find((item) => item.id === threadId);
            cursor = page.nextCursor?.trim();
            if (cursor && cursors.has(cursor)) throw new Error("Provider inventory did not advance.");
            if (cursor) cursors.add(cursor);
          } while (cursor && !thread);
        } else if (backend === "claude") {
          thread = (await this.context.providers.claude.listThreads({ archived })).find((item) => item.id === threadId);
        } else if (isAcpBackendId(backend) && (await this.context.providers.acp.archiveCleanupBackendIds()).includes(backend)) {
          let after: string | undefined;
          do {
            const page = this.context.providers.acp.listArchiveCleanupSessionsPage(backend, { archived, after, limit: 100 });
            const session = page.sessions.find((item) => item.sessionId === threadId);
            if (session) thread = this.context.providers.acp.sessionToThreadSummary(session);
            if (page.nextCursor && after && page.nextCursor <= after) throw new Error("Provider inventory did not advance.");
            after = page.nextCursor;
          } while (after && !thread);
        }
        if (thread) break;
      }
      if (!thread) throw new Error("The target is not a known current-profile thread.");
      const overlay = await this.context.stores.threads.getThreadOverlayState({ backend, threadId });
      return { thread: request.args.action && request.args.action !== "register" ? thread
        : await this.threadArchiveCoordinator.maintenanceThreadWorkspace(thread, overlay), overlay };
    };
    try {
      const owner = await readOwner();
      const registered = owner.overlay?.worktreeRegistrations?.find((entry) => entry.worktreePath === worktreePath);
      if (request.args.action === "inspect") {
        const attached = [...owner.thread.linkedDirectories, ...owner.overlay?.extraLinkedDirectories ?? []]
          .some((directory) => directory.worktreePath === worktreePath)
          || resolveThreadWorkspaceCwd(owner.thread, owner.overlay?.extraLinkedDirectories ?? []) === worktreePath;
        return { ok: true, data: { backend, threadId, worktreePath, registered: Boolean(registered),
          valid: attached && await hasWorktreeRegistration(worktreePath, registered ? [registered] : []),
          ...(registered ? { registration: registered } : {}),
          message: "Registration applies only while this thread remains attached to the same Git checkout. Removal protections still apply.",
        } };
      }
      if (unregister && !registered) return { ok: true, data: {
        backend, threadId, worktreePath, registered: false, message: "This thread has no registration for that checkout.",
      } };
      const inspected = unregister ? registered! : await inspectRegisterableWorktree(worktreePath);
      const attached = (thread: AppServerThreadSummary, overlay?: ThreadOverlayState) =>
        [...thread.linkedDirectories, ...overlay?.extraLinkedDirectories ?? []]
          .some((directory) => directory.kind === "worktree" && directory.worktreePath
            && path.resolve(directory.worktreePath) === inspected.worktreePath);
      if (!unregister && !attached(owner.thread, owner.overlay)) {
        return threadOrchestrationFailure("unsupported_workspace", "That linked checkout is not attached to the target thread.");
      }
      const approved = await this.threadInspectionTools.requestThreadMaintenanceConfirmation({
        backend: caller.backend, threadId: caller.threadId, turnId: caller.turnId, itemId: caller.callId,
        requestId: `worktree-registration:${caller.callId || randomUUID()}`,
        header: "Worktree ownership", approveLabel: unregister ? "Unregister worktree" : "Register worktree",
        approveDescription: unregister ? "Revoke this thread's authorization for this checkout." : "Authorize future snapshot and cleanup of this exact checkout.",
        question: `${unregister ? "Unregister" : "Register"} checkout ${inspected.worktreePath} for ${backend} thread ${threadId}`
          + `${owner.thread.title ? ` (${owner.thread.title})` : ""}?\nGit repository: ${inspected.commonDirectory}`
          + `\n${unregister ? "Revoke this thread's registration. Other owners and managed-root rules still apply."
            : "Allow PwrAgent to snapshot and remove this linked checkout during thread archive or eligible idle maintenance. Tracked edits and non-ignored untracked files are saved first; ignored files are deleted without recovery. Idle, activity, shared-owner and snapshot limits still apply."}`
          + "\nThis registration action changes no checkout files.",
      });
      if (!approved) return threadOrchestrationFailure("forbidden", "The operator declined worktree registration. Do not retry without a new request.");
      if (!live()) return threadOrchestrationFailure("forbidden", "The invoking turn ended before registration was approved.");
      // Cancel every hibernation of this checkout before yielding. Another
      // archived owner can revoke a receipt the hibernating thread depends on.
      const hibernations = this.threadArchiveCoordinator.cancelCheckoutHibernations(worktreePath);
      return await this.threadArchiveCoordinator.withThreadLifecycleMutation({ backend, threadId, worktreePath }, async () => {
        await Promise.all(hibernations.map(async (key) => await this.host().threadLifecycleLocks.run(key, async () => {})));
        return await this.threadArchiveCoordinator.withThreadWorkspaceMutation({ backend, threadId }, async () => {
          const current = await readOwner();
          if (!unregister && (!attached(current.thread, current.overlay)
            || !sameRegisteredWorktree(inspected, await inspectRegisterableWorktree(worktreePath)))) {
            return threadOrchestrationFailure("stale_target", "The thread or checkout changed during review. Nothing was registered.");
          }
          if (!live()) return threadOrchestrationFailure("forbidden", "The invoking turn ended before registration could be saved.");
          const registration = !unregister ? { ...inspected, authorizedAt: Date.now(),
            requestedBy: { backend: caller.backend, threadId: caller.threadId } } : undefined;
          await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([worktreePath], async () => {
            await this.context.stores.directories.setThreadWorktreeRegistration!({ backend, threadId, worktreePath,
              ...(registration ? { registration } : {}) });
          });
          return { ok: true, data: { backend, threadId, worktreePath, registered: !unregister,
            ...(registration ? { valid: true, registration } : {}),
            message: unregister ? "Revoked this thread's worktree registration."
              : "Registered this exact checkout for snapshot and cleanup. Existing removal protections still apply.",
          } };
        });
      });
    } catch (error) {
      return threadOrchestrationFailure("unsupported_workspace", error instanceof Error ? error.message : String(error));
    }
  }

  async attachThreadDirectory(
    request: PwrAgentThreadOrchestrationRequest<"attach_thread_directory">,
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
        "Directory attachment tools must be invoked from a live turn.",
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
        "Directory attachment currently supports only the invoking thread backend.",
      );
    }

    const sourcePath = request.args.path.trim();
    const workspaceMode: AttachThreadDirectoryWorkspaceMode =
      request.args.workspaceMode ?? "local";
    return await this.threadArchiveCoordinator.withThreadWorkspaceMutation({ backend, threadId: sourceThreadId }, async () => {
      let rollback: (() => Promise<void>) | undefined;
      try {
        const sourceOverlay =
          (await this.context.stores.threads.getThreadOverlayState({
            backend,
            threadId: sourceThreadId,
          })) ?? undefined;
        const sourceThread = await this.host().findThreadForWorkspaceHandoff({
          backend,
          callerReason: "attach-thread-directory",
          threadId: sourceThreadId,
        });
        const executionMode =
          this.host().activeCodexTurnModes.get(
            buildActiveTurnModeKey(sourceThreadId, sourceTurnId),
          ) ??
          sourceOverlay?.executionMode ??
          (backend === "codex"
            ? await this.host().resolveCodexThreadExecutionModeForActiveTurn(sourceThreadId)
            : "default");
        const primaryPath =
          await this.host().gitDirectoryService.resolvePrimaryWorkspacePath(sourcePath);
        if (workspaceMode === "local" && !primaryPath) {
          throw new Error("path must be inside a Git repository.");
        }
        const repositoryPath = primaryPath ?? sourcePath;
        const trustFailure = await this.threadWorkspaceService.ensureThreadWorkspacePathTrusted({
          backend,
          cwd: repositoryPath,
          executionMode,
          sourceOverlay,
          sourceThread,
          sourceThreadId,
          sourceTurnId,
          callId: request.context.callId,
        });
        if (trustFailure) {
          return trustFailure;
        }

        let directory =
          workspaceMode === "new_worktree"
            ? await this.createAttachedWorktreeDirectory({
                backend,
                args: request.args,
                repositoryPath,
                sourceThreadId,
              }).then((result) => {
                rollback = result.rollback;
                return result.directory;
              })
            : await this.createAttachedLocalDirectory(repositoryPath);
        const branchSource = directory.worktreePath ?? directory.path;
        const branch = branchSource
          ? await readCurrentGitBranch(branchSource).catch(() => undefined)
          : undefined;
        const normalizedBranch = branch?.trim() || undefined;
        if (workspaceMode === "new_worktree" && normalizedBranch) {
          directory = {
            ...directory,
            gitBranch: normalizedBranch,
          };
        }

        const overlay = await this.threadArchiveCoordinator.withArchiveWorkspaceWrite([directory.worktreePath ?? directory.path], async () => await this.context.stores.directories.addLinkedDirectory({
          backend,
          threadId: sourceThreadId,
          directory,
        }));
        rollback = undefined;
        await this.host().publishLocalEvent({
          backend,
          notification: {
            method: "navigation/threadDirectories/updated",
            params: {
              reason: "selected-thread",
              threadIds: [sourceThreadId],
            },
          },
        });

        return {
          ok: true,
          data: {
            backend,
            threadId: sourceThreadId,
            directory: overlay.extraLinkedDirectories.find(
              (current) => current.id === directory.id,
            ) ?? directory,
            workspaceMode,
            ...(normalizedBranch ? { branch: normalizedBranch } : {}),
            message:
              workspaceMode === "new_worktree"
                ? "Attached a managed worktree directory to this thread."
                : "Attached a secondary directory to this thread.",
          } satisfies AttachThreadDirectoryResult,
        };
      } catch (error) {
        await rollback?.().catch((rollbackError) => {
          backendRegistryLog.warn("attach_thread_directory rollback failed", {
            error:
              rollbackError instanceof Error
                ? rollbackError.message
                : String(rollbackError),
            threadId: sourceThreadId,
          });
        });
        return threadOrchestrationFailure(
          "internal_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    }, [sourcePath]);
  }

  private async createAttachedLocalDirectory(
    directoryPath: string,
  ): Promise<LinkedDirectorySummary> {
    const primaryPath = await this.host().gitDirectoryService.resolvePrimaryWorkspacePath(
      directoryPath,
    );
    if (!primaryPath) {
      throw new Error("path must be inside a Git repository.");
    }
    const [directory] = buildLocalLinkedDirectory(primaryPath);
    if (!directory) {
      throw new Error("failed to build linked directory metadata.");
    }
    return directory;
  }

  private async createAttachedWorktreeDirectory(params: {
    backend: AppServerBackendKind;
    args: AttachThreadDirectoryToolArgs;
    repositoryPath?: string;
    sourceThreadId: string;
  }): Promise<{
    directory: LinkedDirectorySummary;
    rollback?: () => Promise<void>;
  }> {
    const sourcePath = params.args.path.trim();
    const repositoryPath =
      params.repositoryPath ??
      (await this.host().gitDirectoryService.resolvePrimaryWorkspacePath(sourcePath)) ??
      sourcePath;
    const prepared = await this.host().gitDirectoryService.prepareLaunchpadWorkspace({
      backend: params.backend,
      branchName: params.args.branchName,
      directoryKind: "directory",
      directoryLabel: path.basename(repositoryPath) || repositoryPath,
      directoryPath: repositoryPath,
      workMode: "worktree",
      worktreeBranchMode: params.args.worktreeBranchMode ?? "detached",
    });
    if (prepared.workMode !== "worktree" || !prepared.cwd?.trim()) {
      throw new Error("PwrAgent could not allocate a managed worktree.");
    }
    try {
      const [directory] = buildWorktreeLinkedDirectory({
        repositoryPath: prepared.repositoryPath ?? repositoryPath,
        worktreePath: prepared.cwd,
        label: path.basename(prepared.repositoryPath ?? repositoryPath) || repositoryPath,
      });
      if (!directory) {
        throw new Error("failed to build worktree linked directory metadata.");
      }
      await this.host().recordCodexWorktreeOwnerThread({
        backend: params.backend,
        threadId: params.sourceThreadId,
        worktreePath: prepared.cwd,
      });
      return {
        directory,
        rollback: prepared.rollback,
      };
    } catch (error) {
      await prepared.rollback?.().catch((rollbackError) => {
        backendRegistryLog.warn("attach_thread_directory worktree rollback failed", {
          error:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
          threadId: params.sourceThreadId,
        });
      });
      throw error;
    }
  }

  async detachThreadDirectory(
    request: PwrAgentThreadOrchestrationRequest<"detach_thread_directory">,
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
        "Directory detachment tools must be invoked from a live turn.",
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
        "Directory detachment currently supports only the invoking thread backend.",
      );
    }

    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend,
      threadId: sourceThreadId,
    });
    const matched = overlay?.extraLinkedDirectories.find((directory) =>
      linkedDirectoryMatchesDetachArgs(directory, request.args),
    );
    if (!matched) {
      return threadOrchestrationFailure(
        "forbidden",
        "Only secondary directories attached to this thread can be detached.",
      );
    }
    const sourceThread = await this.host().findThreadForWorkspaceHandoff({
      backend,
      callerReason: "agent-thread-directory-detach",
      threadId: sourceThreadId,
    });
    const totalLinkedDirectories = dedupeLinkedDirectoriesByNormalizedIdentity([
      ...(sourceThread?.linkedDirectories ?? []),
      ...(overlay?.extraLinkedDirectories ?? []),
    ]).length;
    if (totalLinkedDirectories <= 1) {
      return threadOrchestrationFailure(
        "forbidden",
        "Cannot detach the last linked directory from a thread.",
      );
    }

    const next = await this.context.stores.directories.removeLinkedDirectory({
      backend,
      threadId: sourceThreadId,
      directory: matched,
    });
    await this.host().publishLocalEvent({
      backend,
      notification: {
        method: "navigation/threadDirectories/updated",
        params: {
          reason: "selected-thread",
          threadIds: [sourceThreadId],
        },
      },
    });

    return {
      ok: true,
      data: {
        backend,
        threadId: sourceThreadId,
        detachedDirectory: matched,
        directories: next.extraLinkedDirectories,
        message: "Detached a secondary directory from this thread.",
      },
    };
  }
}
