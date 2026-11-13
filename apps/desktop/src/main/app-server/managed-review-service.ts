import { randomUUID } from "node:crypto";
import {
  buildThreadIdentityKey,
  isAcpBackendId,
  type AcpBackendId,
  type AgentEvent,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type AppServerNotification,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerReviewContext,
  type AppServerReviewTarget,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReviewEntry,
  type AppServerTurnInputItem,
  type BackendAcpSessionRuntimeState,
  type BackendModelOption,
  type CodexThreadEnvironmentRuntime,
  type PwrAgentThreadOrchestrationRequest,
  type PwrAgentThreadOrchestrationResponse,
  type StartReviewRequest,
  type StartReviewResponse,
  type StartReviewToolResult,
  type ThreadExecutionMode,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
} from "@pwragent/shared";
import type {
  ThreadTurnQueue,
  ThreadTurnQueueOrigin,
  ThreadTurnQueueSubmissionResult,
} from "@pwragent/owner-core/thread-turn-queue";
import type {
  DynamicToolSpec as CodexDynamicToolSpec,
  ThreadStartParams as CodexThreadStartParams,
  ThreadSource as CodexThreadSource,
} from "@pwrdrvr/codex-app-server-protocol/v2";
import type { NamedReviewPullRequest } from "../../shared/review-command";
import { formatReviewOutputText, parseReviewOutputText } from "../../shared/review-output";
import type { AcpMcpServerRegistration } from "../acp/acp-client";
import type { CodexPwrdrvrTokenMiserActivation } from "../codex-app-server/desktop-client";
import { getMainLogger } from "../log";
import { getReviewAutoFixArming } from "../thread-reviews/review-auto-fix";
import type { TokenMiserService } from "../token-miser/token-miser-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import type { BackendModelCatalogCallerReason } from "./backend-model-catalog";
import { readNonEmptyString, readRecord } from "./backend-registry-notification-values";
import {
  completedAtFromTerminalNotification,
  readNotificationItemType,
  reviewTaskLabel,
  textFragmentsFromCodexNotification,
} from "./backend-registry-notifications";
import { threadOrchestrationFailure } from "./backend-registry-runtime-helpers";
import type {
  BackendClient,
  ModelSettings,
  PendingReviewStartRecord,
  ReviewSubAgentRecord,
  ReviewTerminal,
} from "./backend-registry-types";
import { buildCodexTokenMiserDynamicToolSpecs } from "./codex-thread-config";
import type { delegatedTurnAttribution } from "./delegated-turn-attribution";
import { executionModeSettings } from "./execution-mode-settings";
import { normalizeLinkedDirectoryIdentityPath } from "./linked-directory-identity";
import { buildManagedReviewPrompt } from "./managed-review";
import { resolvePullRequestReview } from "./pull-request-review";
import type { RegistryContext, RegistryHost } from "./registry-context";
import { refreshReviewBaseBranch } from "./review-base-branch";
import { resolveReviewProvenance } from "./review-provenance";
import { assertReviewWorkspaceMatchesAttachedPullRequest } from "./review-workspace-guard";
import type { ThreadInfoStore } from "./thread-info-store";
import { buildReviewStartFailurePrompt, reviewStartFailureFingerprint } from "./thread-orchestration-prompts";
import {
  BACKEND_LABELS,
  buildCapabilities,
  buildLaunchpadOptions,
  hasExplicitModelSettings,
  resolveModelSettingsFromOptions,
} from "./thread-model-options";
import { assistantOutputForTurn, reviewEntryReviewer } from "./thread-transcript-helpers";
import {
  buildActiveTurnKey,
  buildActiveTurnModeKey,
  buildReviewSubAgentKey,
  buildTurnStartReservationKey,
  parseActiveTurnKey,
  reviewSubAgentId,
  type ActiveTurnKeySet,
} from "./thread-turn-keys";

// The registry's logger name, so moved log lines read as they did.
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/**
 * Registry-owned state and turn operations the review service reads. The
 * registry's construction ports satisfy it; this module never imports the
 * registry. The Codex turn-activity sets stay registry-owned: the review start
 * reserves and releases them alongside the registry's own turn paths.
 */
export interface ManagedReviewServiceHost {
  readonly activeCodexReviewInterruptTurnIds: Map<string, string>;
  readonly activeCodexReviewTurnKeys: Set<string>;
  readonly activeCodexTurnModes: Map<string, ThreadExecutionMode>;
  readonly activeTurnKeys: ActiveTurnKeySet;
  readonly registrySessionId: string;
  readonly reservedAcpStartThreadKeys: Set<string>;
  readonly reservedCodexStartThreadIds: Set<string>;
  readonly runtimeInstanceId: string;
  readonly threadInfoStore: ThreadInfoStore;
  readonly threadTurnQueue: ThreadTurnQueue;
  readonly tokenMiserService: TokenMiserService | undefined;
  readonly tokenMiserStore: TokenMiserStore | undefined;
  assertNotBootstrap(method: string): void;
  assertThreadNotLocked(backend: AppServerBackendKind, threadId: string): Promise<void>;
  assertThreadOwnership(): void;
  buildSupportedCodexDynamicToolsRefresh(params: {
    client: BackendClient;
    threadId: string;
    tokenMiserEnabled: boolean;
  }): Promise<CodexDynamicToolSpec[] | undefined>;
  buildSupportedCodexTokenMiserConfig(params: {
    client: BackendClient;
    enabled: boolean;
  }): Promise<CodexThreadStartParams["config"] | undefined>;
  buildSupportedPwrdrvrTokenMiserActivation(params: {
    client: BackendClient;
    enabled: boolean;
  }): Promise<CodexPwrdrvrTokenMiserActivation | null | undefined>;
  drainPendingThreadWorkspaceMovesForTerminalTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): void;
  emitToListeners(event: AgentEvent): Promise<void>;
  ensureCheckoutAwake(identity: { backend: AppServerBackendKind; threadId: string }): Promise<void>;
  flushQueuedAgentChange(threadId: string, ownsStartReservation?: boolean): Promise<void>;
  flushQueuedExecutionModeIfPresent(threadId: string, backend?: AppServerBackendKind): Promise<void>;
  getActiveTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined;
  getClient(backend: AppServerBackendKind, executionMode?: ThreadExecutionMode): BackendClient;
  getPendingTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined;
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  isLiveDynamicToolCall(backend: AppServerBackendKind, call: { threadId: string; turnId?: string }): boolean;
  prepareTokenMiserRuntime(): Promise<void>;
  readCodexDefaultModelsOnce(callerReason: BackendModelCatalogCallerReason): Promise<BackendModelOption[]>;
  readDelegatedTurnAncestry(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
  }): Promise<{ parentTurnId?: string; rootTurnId?: string }>;
  readThread(request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse>;
  resolveCodexThreadExecutionModeForActiveTurn(threadId: string): Promise<ThreadExecutionMode>;
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
  resolveTokenMiserEnabledForOverride(threadOverride: boolean | undefined): boolean;
  scheduleQueuedAgentChange(threadId: string): void;
  startAcpSession(params: {
    backend: AcpBackendId;
    cwd?: string;
    executionMode: ThreadExecutionMode;
    acpRuntime?: BackendAcpSessionRuntimeState;
    reasoningEffort?: string;
    mcpRegistration?: AcpMcpServerRegistration;
    hidden?: boolean;
  }): Promise<{ threadId: string }>;
  startAcpTurn(params: {
    backend: AcpBackendId;
    threadId: string;
    input: AppServerTurnInputItem[];
    model?: string;
    reasoningEffort?: string;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  submitTurn(params: {
    queueEntryId?: string;
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
    messageOrigin?: AppServerThreadMessageOrigin;
    delivery?: "new_turn";
  }): Promise<ThreadTurnQueueSubmissionResult>;
  threadHasActiveTurn(
    threadId: string,
    backend?: AppServerBackendKind,
    ignoreCodexStartReservation?: boolean,
  ): boolean;
  withArchiveWorkspaceWrite<T>(paths: readonly string[], work: () => Promise<T>): Promise<T>;
  withCodexThreadClient<T>(
    threadId: string,
    operation: (client: BackendClient, mode: ThreadExecutionMode) => Promise<T>,
    requestedMode?: ThreadExecutionMode,
    logRouting?: boolean,
  ): Promise<T>;
}

/**
 * The reviews domain of the backend registry: starting a review inline or as
 * a managed child thread, scheduling a review an agent asks for until its
 * turn ends, the review sub-agent cards and their terminals, the managed
 * review's forwarded activity and output, and the start_review Agent tool.
 */
export class ManagedReviewService {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ManagedReviewServiceHost>;

  constructor(
    context: RegistryContext,
    host: RegistryHost<ManagedReviewServiceHost>,
  ) {
    this.context = context;
    this.host = host;
  }

  /** Live review sub-agents by review turn, for the registry's usage reads. */
  get activeReviewSubAgentRecords(): ReadonlyMap<string, ReviewSubAgentRecord> {
    return this.activeReviewSubAgents;
  }

  /** Review sub-agents by review turn, kept after the live record ends. */
  get reviewSubAgentRecordsByReviewTurn(): ReadonlyMap<string, ReviewSubAgentRecord> {
    return this.reviewSubAgentsByReviewTurn;
  }

  private readonly pendingReviewStarts = new Map<string, PendingReviewStartRecord>();

  /**
   * Fingerprint of the failure notice each thread was last sent, kept until a
   * turn ends without a failed start, so only an immediate retry that fails
   * the same way stays quiet.
   */
  private readonly reviewStartFailureNotices = new Map<string, string>();

  private readonly pendingReviewTerminals = new Set<Map<string, ReviewTerminal>>();

  private readonly activeReviewSubAgents = new Map<string, ReviewSubAgentRecord>();

  private readonly reviewSubAgentsByReviewTurn = new Map<
    string,
    ReviewSubAgentRecord
  >();

  private readonly managedReviewParentsByChildThread = new Map<
    string,
    { parentBackend: AppServerBackendKind; parentThreadId: string }
  >();

  private readonly managedReviewOutputByReviewTurn = new Map<string, string>();

  /**
   * A reviewer override runs the review as a managed child on the chosen
   * backend, so that backend has to be one we trust to answer the managed
   * review prompt's strict JSON contract.
   */
  private assertReviewBackendSupported(backend: AppServerBackendKind): void {
    if (isAcpBackendId(backend)) {
      if (!this.context.providers.acp.supportsManagedReview(backend)) {
        throw new Error(`Selected review provider cannot run reviews: ${backend}`);
      }
      return;
    }
    if (backend !== "codex") {
      throw new Error(`Selected review provider cannot run reviews: ${backend}`);
    }
  }

  /**
   * Reviewer for a review an agent schedules with `start_review`. The tool
   * has no reviewer argument, so this matches the composer's default: the
   * thread's own provider when it can review, else the first provider that
   * can. Undefined means no provider can.
   */
  private async resolveAgentToolReviewBackend(
    threadBackend: AppServerBackendKind,
  ): Promise<AppServerBackendKind | undefined> {
    try {
      this.assertReviewBackendSupported(threadBackend);
      return threadBackend;
    } catch {
      // A Claude thread reviews on another provider.
    }
    try {
      const methods = (await this.host().getClient("codex").getInitializeResult()).methods ?? [];
      if (buildCapabilities(methods, "codex").reviewRunner) return "codex";
    } catch (error) {
      backendRegistryLog.debug("codex reviewer lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      const acpReviewer = (await this.context.providers.acp.describeInstalledBackends()).find(
        (summary) =>
          summary.available
          && isAcpBackendId(summary.kind)
          && this.context.providers.acp.supportsManagedReview(summary.kind),
      );
      return acpReviewer?.kind;
    } catch (error) {
      backendRegistryLog.debug("ACP reviewer lookup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** Owner-side submission boundary. Caller snapshots are never authoritative. */
  async prepareReviewRequest(
    params: StartReviewRequest,
    trustedSnapshot = false,
  ): Promise<StartReviewRequest> {
    if (params.target.type !== "pullRequest") return params;
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.backend, threadId: params.threadId,
    });
    const cwd = params.cwd?.trim() || await this.host().resolveThreadEnvironmentCwd(
      params.backend, params.threadId, overlay,
    );
    if (!cwd) throw new Error("Select a repository workspace for the pull request review.");
    const target = await resolvePullRequestReview({
      target: params.target,
      cwd,
      prs: overlay?.prs ?? [],
      executionTarget: overlay?.codexEnvironmentRuntime?.executionTarget,
      trustedSnapshot,
    });
    return { ...params, cwd, target };
  }

  async startReview(
    params: StartReviewRequest,
    trustedSnapshot = false,
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>,
  ): Promise<StartReviewResponse> {
    this.host().assertThreadOwnership();
    // Retain terminal evidence only for the lifetime of this start request.
    const terminals = new Map<string, ReviewTerminal>();
    this.pendingReviewTerminals.add(terminals);
    // Armed before the start, so a review that lands at once still fixes.
    const autoFix = getReviewAutoFixArming().starting(
      { backend: params.backend, threadId: params.threadId },
      params.afterReview,
    );
    try {
      const response = await this.startReviewWithTerminalEvidence(params, terminals, trustedSnapshot, turnAttribution);
      autoFix.accepted(response.turnId);
      return response;
    } catch (error) {
      autoFix.refused();
      throw error;
    } finally {
      this.pendingReviewTerminals.delete(terminals);
    }
  }

  private async startReviewWithTerminalEvidence(
    params: StartReviewRequest,
    terminals: Map<string, ReviewTerminal>,
    trustedSnapshot: boolean,
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>,
  ): Promise<StartReviewResponse> {
    this.host().assertNotBootstrap("startReview");
    await this.host().assertThreadNotLocked(params.backend, params.threadId);
    // A review reads the checkout, so a hibernated one comes back first.
    await this.host().ensureCheckoutAwake(params);
    params = await this.prepareReviewRequest(params, trustedSnapshot);
    const acpManagedMode =
      isAcpBackendId(params.backend)
      && this.context.providers.acp.supportsManagedReview(params.backend);
    if (isAcpBackendId(params.backend) && !acpManagedMode) {
      throw new Error("Selected backend does not support review/start");
    }
    // Presence of reviewBackend means the operator picked the reviewer
    // explicitly, which keeps the picked settings out of the parent thread's
    // overlay. A reviewBackend that *differs* from the thread's backend also
    // forces the managed path, because Codex's native review/start runs on the
    // thread's own provider and has no way to switch.
    const reviewerOverridden = Boolean(params.reviewBackend);
    const reviewBackend = params.reviewBackend ?? params.backend;
    const reviewBackendDiffers = reviewBackend !== params.backend;
    // Check the reviewer before anything reads its model catalog. A Claude
    // thread reviewing itself otherwise failed the model check against the
    // Codex catalog, which named the wrong problem.
    this.assertReviewBackendSupported(reviewBackend);
    if (params.runMode !== undefined && ![
      "codex-sub-agent", "pwragent-sub-agent",
    ].includes(params.runMode)) {
      throw new Error("Unknown review run mode.");
    }
    if (params.runMode && params.delivery === "detached") {
      throw new Error("Explicit review modes do not support detached delivery.");
    }
    const requiresManaged = acpManagedMode || reviewBackendDiffers;
    if (requiresManaged && params.runMode && params.runMode !== "pwragent-sub-agent") {
      throw new Error("PwrAgent Sub Agent is required for ACP or cross-provider reviews.");
    }
    let managedMode = requiresManaged || params.runMode === "pwragent-sub-agent";
    const reserveCodexReviewStart = params.backend === "codex";
    const acpReviewReservationKey = isAcpBackendId(params.backend)
      ? buildTurnStartReservationKey(params.backend, params.threadId)
      : undefined;
    if (reserveCodexReviewStart) {
      if (this.host().threadHasActiveTurn(params.threadId)) {
        throw new Error(`Thread already has an active turn in progress: ${params.threadId}`);
      }
      this.host().reservedCodexStartThreadIds.add(params.threadId);
    } else if (acpReviewReservationKey) {
      if (this.host().threadHasActiveTurn(params.threadId, params.backend)) {
        throw new Error(`Thread already has an active turn in progress: ${params.threadId}`);
      }
      this.host().reservedAcpStartThreadKeys.add(acpReviewReservationKey);
    }
    let modelSettings: ModelSettings = {};
    let result: { threadId: string; reviewThreadId: string; turnId: string };
    let overlay: ThreadOverlayState | undefined;
    let cwd: string | undefined;
    let codexEnvironmentRuntime: CodexThreadEnvironmentRuntime | undefined;
    let reviewContext: AppServerReviewContext | undefined;
    let tokenMiserEnabled = false;
    try {
      if (params.backend === "codex") {
        await this.host().flushQueuedAgentChange(params.threadId, true);
        await this.host().flushQueuedExecutionModeIfPresent(params.threadId);
      }
      overlay = managedMode || params.backend === "codex"
        ? await this.context.stores.threads.getThreadOverlayState({
            backend: params.backend,
            threadId: params.threadId,
          })
        : undefined;
      if (reviewBackend === "codex") {
        tokenMiserEnabled = this.host().resolveTokenMiserEnabledForOverride(
          params.backend === "codex" ? overlay?.tokenMiserEnabled : undefined,
        );
        if (tokenMiserEnabled) {
          await this.host().prepareTokenMiserRuntime();
        }
      }
      if (params.backend === "codex") {
        codexEnvironmentRuntime = overlay?.codexEnvironmentRuntime;
        const threadCwd = await this.host().resolveThreadEnvironmentCwd(
          params.backend,
          params.threadId,
          overlay,
        );
        const requestedCwd = params.cwd?.trim();
        cwd = requestedCwd || threadCwd;
        const normalizedRequestedCwd = normalizeLinkedDirectoryIdentityPath(
          requestedCwd,
        );
        const normalizedThreadCwd = normalizeLinkedDirectoryIdentityPath(
          threadCwd,
        );
        const usesSelectedSecondaryWorkspace = Boolean(
          normalizedRequestedCwd
          && normalizedRequestedCwd !== normalizedThreadCwd,
        );
        // Codex review/start has no cwd field. When the operator selects a
        // linked project other than the parent thread's workspace, start the
        // review as a managed child so both thread/start and turn/start are
        // explicitly rooted in the selected project.
        if (usesSelectedSecondaryWorkspace && params.runMode && params.runMode !== "pwragent-sub-agent") {
          throw new Error("PwrAgent Sub Agent is required for a secondary workspace.");
        }
        if (usesSelectedSecondaryWorkspace && !managedMode && params.target.type === "pullRequest") {
          throw new Error("Native pull request review must run in the thread's own workspace. Select a PwrAgent-managed reviewer for another linked project.");
        }
        managedMode ||= usesSelectedSecondaryWorkspace;
        if (
          usesSelectedSecondaryWorkspace
          && codexEnvironmentRuntime?.executionTarget !== "remote"
        ) {
          // A persisted local environment can contain cwd-specific PATH or
          // VIRTUAL_ENV hydration from the parent workspace. Remote runtimes
          // must retain their environment ID so Codex routes the selected cwd
          // to the same host.
          codexEnvironmentRuntime = undefined;
        }
      } else if (managedMode) {
        // A managed reviewer runs in a new thread, so it needs the parent's
        // directory. Without it a Codex review of a Claude thread ran in
        // whatever directory Codex itself started in.
        cwd =
          params.cwd?.trim()
          || await this.host().resolveThreadEnvironmentCwd(
            params.backend,
            params.threadId,
            overlay,
          );
      }
      await assertReviewWorkspaceMatchesAttachedPullRequest({
        cwd,
        executionTarget: codexEnvironmentRuntime?.executionTarget,
        prs: overlay?.prs,
        target: params.target,
      });
      await refreshReviewBaseBranch({
        cwd,
        executionTarget: codexEnvironmentRuntime?.executionTarget,
        target: params.target,
      });
      reviewContext = await this.resolveReviewContext({
        backend: params.backend,
        cwd,
        executionTarget: codexEnvironmentRuntime?.executionTarget,
        overlay,
        target: params.target,
        threadId: params.threadId,
      });
      // A review on another provider cannot inherit the parent thread's model
      // settings — that model belongs to a different catalog. Fall back to the
      // review backend's own defaults instead of carrying gpt-5.6-sol onto a
      // Grok review.
      const requestedModelSettings: ModelSettings = reviewBackendDiffers
        ? {
            model: params.model,
            reasoningEffort: params.reasoningEffort,
            serviceTier: params.serviceTier,
            fastMode: params.fastMode,
          }
        : managedMode
          ? {
              model: params.model ?? overlay?.model,
              reasoningEffort: params.reasoningEffort ?? overlay?.reasoningEffort,
              serviceTier: params.serviceTier ?? overlay?.serviceTier ?? undefined,
              fastMode: params.fastMode ?? overlay?.fastMode,
            }
          : params;
      modelSettings = hasExplicitModelSettings(requestedModelSettings)
        ? await this.resolveReviewModelSettings(
            reviewBackend,
            requestedModelSettings,
          )
        : {};

      if (managedMode) {
        this.assertReviewBackendSupported(reviewBackend);
        if (reviewBackend === "codex") {
          const client = this.host().getClient("codex");
          if (!buildCapabilities((await client.getInitializeResult()).methods ?? [], "codex").reviewRunner) {
            throw new Error("PwrAgent Sub Agent requires thread/start and turn/start support.");
          }
        }
      }

      const startWithClient = async (
        client: BackendClient,
      ): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> => {
        if (!client.startReview || !buildCapabilities(
          (await client.getInitializeResult()).methods ?? [], "codex",
        ).reviewCodexSubAgent) {
          throw new Error("Selected backend does not support review/start");
        }
        const tokenMiserConfig =
          await this.host().buildSupportedCodexTokenMiserConfig({
            client,
            enabled: tokenMiserEnabled,
          });
        const dynamicTools =
          await this.host().buildSupportedCodexDynamicToolsRefresh({
            client,
            threadId: params.threadId,
            tokenMiserEnabled,
          });
        return await client.startReview({
          threadId: params.threadId,
          target: params.target,
          delivery: params.delivery ?? "inline",
          ...modelSettings,
          ...(cwd ? { cwd } : {}),
          ...(codexEnvironmentRuntime
            ? { codexEnvironmentRuntime }
            : {}),
          ...(tokenMiserConfig ? { config: tokenMiserConfig } : {}),
          ...(dynamicTools !== undefined ? { dynamicTools } : {}),
        });
      };

      result = managedMode
        ? await this.startManagedReviewChild({
            turnAttribution,
            backend: reviewBackend,
            cwd,
            // The parent thread's persisted Codex environment only describes
            // its own provider's runtime; a cross-provider review must not
            // inherit it.
            ...(reviewBackendDiffers ? {} : { codexEnvironmentRuntime }),
            modelSettings,
            overlay,
            parentBackend: params.backend,
            parentThreadId: params.threadId,
            target: params.target,
            tokenMiserEnabled,
          })
        : params.backend === "codex"
          ? await this.host().withCodexThreadClient(params.threadId, startWithClient)
          : await startWithClient(this.host().getClient(params.backend));
    } catch (error) {
      if (reserveCodexReviewStart) {
        this.host().reservedCodexStartThreadIds.delete(params.threadId);
      }
      if (acpReviewReservationKey) {
        this.host().reservedAcpStartThreadKeys.delete(acpReviewReservationKey);
      }
      throw error;
    }

    if (params.backend === "codex") {
      try {
        const reviewThreadId = managedMode
          ? result.threadId
          : result.reviewThreadId || result.threadId;
        // Codex review/start returns the real review turn id, but current
        // Codex builds can also emit a lone, mismatched turn/started for the
        // same thread. Treat the returned review turn as active so queued
        // turns cannot release in parallel and so the matching terminal
        // review notification clears the active state.
        const activeTurnMode = await this.host().resolveCodexThreadExecutionModeForActiveTurn(
          reviewThreadId,
        );
        if (!managedMode) {
          const startedTurn = this.host().getActiveTurnForThread({
            backend: "codex",
            threadId: reviewThreadId,
          });
          // A started notification owns its key before its mode read returns.
          // Retain that inner turn too, so an early outer terminal retires it.
          const startedTurnId = startedTurn?.turnId ?? Array.from(this.host().activeTurnKeys)
            .map(parseActiveTurnKey)
            .find((turn) => turn?.backend === "codex"
              && turn.threadId === reviewThreadId
              && !turn.turnId.startsWith("pending:"))?.turnId;
          if (startedTurnId && startedTurnId !== result.turnId) {
            this.host().activeCodexReviewInterruptTurnIds.set(
              buildActiveTurnModeKey(reviewThreadId, result.turnId),
              startedTurnId,
            );
          }
        }
        this.host().activeTurnKeys.add(
          buildActiveTurnKey(params.backend, reviewThreadId, result.turnId),
        );
        this.host().activeCodexTurnModes.set(
          buildActiveTurnModeKey(reviewThreadId, result.turnId),
          activeTurnMode,
        );
        this.host().activeCodexReviewTurnKeys.add(
          buildActiveTurnModeKey(reviewThreadId, result.turnId),
        );
      } catch (error) {
        this.host().reservedCodexStartThreadIds.delete(params.threadId);
        throw error;
      }
    } else if (acpReviewReservationKey) {
      this.host().reservedAcpStartThreadKeys.delete(acpReviewReservationKey);
    }
    const reviewSubAgentRecord: ReviewSubAgentRecord = {
      backend: reviewBackend,
      createdAt: Date.now(),
      displayText: reviewTaskLabel(params.target),
      ...(modelSettings.fastMode !== undefined ? { fastMode: modelSettings.fastMode } : {}),
      ...(modelSettings.model ? { model: modelSettings.model } : {}),
      ...(modelSettings.reasoningEffort
        ? { reasoningEffort: modelSettings.reasoningEffort }
        : {}),
      mode: managedMode ? "managed" : "native",
      ...(reviewContext ? { context: reviewContext } : {}),
      parentBackend: params.backend,
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
    if (reserveCodexReviewStart) {
      this.host().reservedCodexStartThreadIds.delete(params.threadId);
    }
    const earlyTerminal = terminals.get(reviewSubAgentKey);
    if (!managedMode && earlyTerminal) {
      await this.completeReviewSubAgent(earlyTerminal);
      this.clearNativeReviewActiveTurns(reviewSubAgentRecord);
      await this.releaseNativeReviewParent(reviewSubAgentRecord, earlyTerminal);
    } else {
      await this.persistReviewSubAgent(reviewSubAgentRecord);
    }
    backendRegistryLog.info("code review started", {
      mode: reviewSubAgentRecord.mode,
      parentBackend: reviewSubAgentRecord.parentBackend,
      parentThreadId: reviewSubAgentRecord.parentThreadId,
      reviewBackend: reviewSubAgentRecord.backend,
      reviewThreadId: reviewSubAgentRecord.reviewThreadId,
      turnId: reviewSubAgentRecord.turnId,
    });
    if (managedMode) {
      await this.emitManagedReviewStarted(reviewSubAgentRecord);
    }
    // An explicitly picked reviewer applies to this review only. Persisting it
    // would repoint the whole thread — one Grok review would leave the thread
    // answering as Grok afterwards.
    if (!reviewerOverridden && hasExplicitModelSettings(modelSettings)) {
      await this.context.stores.threads.setThreadModelSettings({
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

  private async startManagedReviewChild(params: {
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>;
    /** Backend that runs the review — the reviewer override when set. */
    backend: AppServerBackendKind;
    codexEnvironmentRuntime?: CodexThreadEnvironmentRuntime;
    cwd?: string;
    modelSettings: ModelSettings;
    overlay?: ThreadOverlayState;
    /** Backend the reviewed thread itself lives on. */
    parentBackend: AppServerBackendKind;
    parentThreadId: string;
    target: StartReviewRequest["target"];
    tokenMiserEnabled: boolean;
  }): Promise<{ threadId: string; reviewThreadId: string; turnId: string }> {
    // Only a same-provider review can inherit the parent's live session state;
    // another provider's agent runtime and execution mode do not transfer.
    const inheritsParentSession = params.backend === params.parentBackend;
    if (isAcpBackendId(params.backend)) {
      const parentSession = inheritsParentSession
        ? this.context.providers.acp.getSession(params.backend, params.parentThreadId)
        : undefined;
      const acpRuntime = parentSession?.acpRuntime;
      const executionMode =
        (inheritsParentSession ? params.overlay?.executionMode : undefined)
        ?? parentSession?.executionMode
        ?? "default";
      const thread = await this.host().startAcpSession({
        backend: params.backend,
        cwd: params.cwd,
        executionMode,
        acpRuntime,
        // The replay re-selects the parent's model, so it carries the parent's
        // level. The review's level belongs to the review's model, and the
        // turn below applies the two together.
        reasoningEffort: acpRuntime?.reasoningEffort,
        hidden: true,
      });
      const turn = await this.host().startAcpTurn({
        backend: params.backend,
        threadId: thread.threadId,
        input: [{ type: "text", text: buildManagedReviewPrompt(params.target) }],
        model: params.modelSettings.model,
        reasoningEffort: params.modelSettings.reasoningEffort,
      });
      return {
        threadId: params.parentThreadId,
        reviewThreadId: turn.threadId,
        turnId: turn.turnId,
      };
    }

    const executionMode = inheritsParentSession
      ? params.overlay?.executionMode
        ?? await this.host().resolveCodexThreadExecutionModeForActiveTurn(
          params.parentThreadId,
        )
      : params.overlay?.executionMode ?? "default";
    const modeSettings = executionModeSettings(executionMode);
    const client = this.host().getClient("codex", executionMode);
    const tokenMiserConfig = await this.host().buildSupportedCodexTokenMiserConfig({
      client,
      enabled: params.tokenMiserEnabled,
    });
    const pwrdrvrTokenMiser =
      await this.host().buildSupportedPwrdrvrTokenMiserActivation({
        client,
        enabled: params.tokenMiserEnabled,
      });
    const tokenMiserDynamicTools = params.tokenMiserEnabled
      ? buildCodexTokenMiserDynamicToolSpecs(this.host().tokenMiserStore, this.host().tokenMiserService?.focused)
      : [];
    const thread = await this.host().withArchiveWorkspaceWrite(params.cwd ? [params.cwd] : [], async () => await client.startThread({
      ...(params.cwd ? { cwd: params.cwd } : {}),
      approvalPolicy: modeSettings.approvalPolicy,
      // Do not persist managed workers in the shared Codex history: other
      // profiles and the Codex app cannot rely on our local navigation filter.
      // Progress, results, and usage remain on the parent's sub-agent record.
      ephemeral: true,
      threadSource: "subagent" as CodexThreadSource,
      approvalsReviewer: modeSettings.approvalsReviewer,
      sandbox: modeSettings.sandbox,
      ...params.modelSettings,
      ...(params.codexEnvironmentRuntime
        ? { codexEnvironmentRuntime: params.codexEnvironmentRuntime }
        : {}),
      ...(tokenMiserConfig ? { config: tokenMiserConfig } : {}),
      ...(pwrdrvrTokenMiser ? { pwrdrvrTokenMiser } : {}),
      ...(tokenMiserDynamicTools.length > 0
        ? { dynamicTools: tokenMiserDynamicTools }
        : {}),
    }));
    let managedReviewChildKey = buildThreadIdentityKey(
      "codex",
      thread.threadId,
    );
    this.managedReviewParentsByChildThread.set(managedReviewChildKey, {
      parentBackend: params.parentBackend,
      parentThreadId: params.parentThreadId,
    });
    this.host().reservedCodexStartThreadIds.add(thread.threadId);
    try {
      const turn = await client.startTurn({
        ...params.turnAttribution,
        threadId: thread.threadId,
        input: [{ type: "text", text: buildManagedReviewPrompt(params.target) }],
        ...(params.cwd ? { cwd: params.cwd } : {}),
        approvalPolicy: modeSettings.approvalPolicy,
        approvalsReviewer: modeSettings.approvalsReviewer,
        sandbox: modeSettings.sandbox,
        ...params.modelSettings,
        ...(params.codexEnvironmentRuntime
          ? { codexEnvironmentRuntime: params.codexEnvironmentRuntime }
          : {}),
        // The complete tool catalog and environment were installed by
        // thread/start above. Re-sending dynamicTools here asks the client to
        // resume this ephemeral worker, which has no persisted rollout.
        ...(pwrdrvrTokenMiser !== undefined ? { pwrdrvrTokenMiser } : {}),
      });
      const startedReviewChildKey = buildThreadIdentityKey(
        "codex",
        turn.threadId,
      );
      if (startedReviewChildKey !== managedReviewChildKey) {
        const parent = this.managedReviewParentsByChildThread.get(
          managedReviewChildKey,
        );
        this.managedReviewParentsByChildThread.delete(managedReviewChildKey);
        managedReviewChildKey = startedReviewChildKey;
        if (parent) {
          this.managedReviewParentsByChildThread.set(
            managedReviewChildKey,
            parent,
          );
        }
      }
      this.host().activeTurnKeys.add(
        buildActiveTurnKey("codex", turn.threadId, turn.turnId),
      );
      this.host().activeCodexTurnModes.set(
        buildActiveTurnModeKey(turn.threadId, turn.turnId),
        executionMode,
      );
      return {
        threadId: params.parentThreadId,
        reviewThreadId: turn.threadId,
        turnId: turn.turnId,
      };
    } catch (error) {
      this.managedReviewParentsByChildThread.delete(managedReviewChildKey);
      throw error;
    } finally {
      this.host().reservedCodexStartThreadIds.delete(thread.threadId);
    }
  }

  /**
   * Never fails a review. Provenance is reporting: a card that cannot say which
   * project it ran in is worse than one that can, but it is not worth refusing
   * to run the review the operator asked for.
   */
  async resolveReviewContext(params: {
    backend: AppServerBackendKind;
    cwd?: string;
    executionTarget?: "local" | "remote";
    namedPullRequests?: NamedReviewPullRequest[];
    overlay?: ThreadOverlayState;
    target: AppServerReviewTarget;
    threadId: string;
  }): Promise<AppServerReviewContext | undefined> {
    if (!params.cwd?.trim()) {
      return undefined;
    }
    try {
      // Read the remembered summary directly rather than through
      // `findThreadForWorkspaceHandoff`, which falls through to `thread/list`
      // on a miss. `resolveThreadEnvironmentCwd` already looked this thread up
      // moments ago; provenance is reporting and must not add an uncached
      // round trip to the app server before the review starts. The enriched
      // row carries directory labels, so prefer it and settle for the plain
      // row — a basename label beats a blocked review.
      const threadKey = {
        backend: params.backend,
        threadId: params.threadId,
      };
      const thread =
        this.host().threadInfoStore.getSummary(threadKey, { requireEnriched: true })
        ?? this.host().threadInfoStore.getSummary(threadKey);
      return await resolveReviewProvenance({
        cwd: params.cwd,
        ...(params.executionTarget
          ? { executionTarget: params.executionTarget }
          : {}),
        linkedDirectories: [
          ...(thread?.linkedDirectories ?? []),
          ...(params.overlay?.extraLinkedDirectories ?? []),
        ],
        ...(params.namedPullRequests
          ? { namedPullRequests: params.namedPullRequests }
          : {}),
        ...(params.overlay?.prs ? { prs: params.overlay.prs } : {}),
        target: params.target,
      });
    } catch (error) {
      backendRegistryLog.warn("failed to resolve review provenance", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
      return undefined;
    }
  }

  private async emitManagedReviewStarted(
    record: ReviewSubAgentRecord,
  ): Promise<void> {
    const startedAt = Date.now();
    const entry: AppServerThreadReviewEntry = {
      type: "review",
      id: `managed-review:${record.turnId}:started`,
      review: record.displayText,
      displayText: record.displayText,
      createdAt: startedAt,
      reviewer: reviewEntryReviewer(record),
      ...(record.context ? { context: record.context } : {}),
      turn: {
        id: record.turnId,
        status: "in_progress",
        startedAt,
      },
    };
    await this.context.stores.reviews.upsertManagedReviewEntry({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      entry,
    });
    await this.context.emit({
      backend: record.parentBackend,
      notification: {
        method: "turn/started",
        params: {
          threadId: record.parentThreadId,
          turnId: record.turnId,
          turn: {
            id: record.turnId,
            status: "inProgress",
            startedAt,
          },
        },
      },
    });
    await this.context.emit({
      backend: record.parentBackend,
      notification: {
        method: "item/completed",
        params: {
          threadId: record.parentThreadId,
          turnId: record.turnId,
          item: {
            id: entry.id,
            type: "enteredReviewMode",
            review: record.displayText,
            createdAt: startedAt,
            // Spelled out rather than left to withReviewRuntimeMetadata: that
            // looks the record up under the review CHILD's thread, and this
            // item is emitted under the parent's, so the lookup misses and
            // the live card would lose its workspace/branch/commit/PR rows
            // until a reload read the persisted entry above.
            data: {
              reviewer: entry.reviewer,
              ...(entry.context ? { context: entry.context } : {}),
            },
          },
        },
      },
    });
  }

  async submitReview(params: StartReviewRequest & {
    idempotencyKey?: string;
  }, trustedSnapshot = false): Promise<
    | {
        status: "started";
        response: StartReviewResponse;
      }
    | {
        status: "scheduled";
        pendingReviewId: string;
        invokingTurnId: string;
      }
  > {
    const { idempotencyKey, ...incoming } = params;
    await this.host().assertThreadNotLocked(incoming.backend, incoming.threadId);
    const request = await this.prepareReviewRequest(incoming, trustedSnapshot);
    const activeTurn = this.host().getActiveTurnForThread({
      backend: request.backend,
      threadId: request.threadId,
    });
    const invokingTurnId =
      activeTurn?.turnId
      ?? this.host().getPendingTurnForThread({
        backend: request.backend,
        threadId: request.threadId,
      })?.turnId
      ?? (
        request.backend === "codex"
        && this.host().reservedCodexStartThreadIds.has(request.threadId)
          ? `pending:${request.threadId}`
          : undefined
      )
      ?? (
        isAcpBackendId(request.backend)
        && this.host().reservedAcpStartThreadKeys.has(
          buildTurnStartReservationKey(request.backend, request.threadId),
        )
          ? `pending:${request.threadId}`
          : undefined
      );
    if (!invokingTurnId) {
      return {
        status: "started",
        response: await this.startReview(request, true),
      };
    }
    const pending = this.scheduleReviewStart({
      invokingTurnId,
      request,
      idempotencyKey,
    });
    return {
      status: "scheduled",
      pendingReviewId: pending.pendingReviewId,
      invokingTurnId: pending.invokingTurnId,
    };
  }

  cancelPendingReview(pendingReviewId: string, reason: string): boolean {
    const pending = this.pendingReviewStarts.get(pendingReviewId);
    if (!pending || pending.status !== "scheduled") {
      return false;
    }
    this.pendingReviewStarts.set(pendingReviewId, {
      ...pending,
      status: "cancelled",
      error: reason,
      updatedAt: Date.now(),
    });
    return true;
  }

  private scheduleReviewStart(params: {
    turnAttribution?: ReturnType<typeof delegatedTurnAttribution>;
    invokingTurnId: string;
    request: StartReviewRequest;
    idempotencyKey?: string;
  }): PendingReviewStartRecord {
    if (params.idempotencyKey) {
      const existing = [...this.pendingReviewStarts.values()].find(
        (candidate) =>
          candidate.backend === params.request.backend &&
          candidate.threadId === params.request.threadId &&
          candidate.idempotencyKey === params.idempotencyKey,
      );
      if (existing) {
        return existing;
      }
    }
    const duplicate = params.idempotencyKey
      ? undefined
      : [...this.pendingReviewStarts.values()].find(
          (candidate) =>
            candidate.backend === params.request.backend &&
            candidate.threadId === params.request.threadId &&
            candidate.invokingTurnId === params.invokingTurnId &&
            candidate.status === "scheduled",
        );
    if (duplicate) {
      return duplicate;
    }

    const now = Date.now();
    const pending: PendingReviewStartRecord = {
      ...(params.turnAttribution ? { turnAttribution: params.turnAttribution } : {}),
      pendingReviewId: `pending-review:${randomUUID()}`,
      backend: params.request.backend,
      threadId: params.request.threadId,
      invokingTurnId: params.invokingTurnId,
      request: params.request,
      createdAt: now,
      updatedAt: now,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      status: "scheduled",
    };
    this.pendingReviewStarts.set(pending.pendingReviewId, pending);
    return pending;
  }

  rebindPendingReviewStartsForStartedTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    pendingTurnId: string;
    turnId: string;
  }): void {
    for (const candidate of this.pendingReviewStarts.values()) {
      if (
        candidate.backend !== params.backend
        || candidate.threadId !== params.threadId
        || candidate.invokingTurnId !== params.pendingTurnId
        || candidate.status !== "scheduled"
      ) {
        continue;
      }
      this.pendingReviewStarts.set(candidate.pendingReviewId, {
        ...candidate,
        invokingTurnId: params.turnId,
        updatedAt: Date.now(),
      });
    }
  }

  async drainPendingReviewStartsForTerminalTurn(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    method: "turn/completed" | "turn/failed" | "turn/cancelled";
  }): Promise<void> {
    if (!params.turnId) {
      return;
    }
    const pending = [...this.pendingReviewStarts.values()].filter(
      (candidate) =>
        candidate.backend === params.backend &&
        candidate.threadId === params.threadId &&
        candidate.invokingTurnId === params.turnId &&
        candidate.status === "scheduled",
    );
    const failures: Array<{ error: string; target: AppServerReviewTarget }> = [];
    for (const candidate of pending) {
      if (params.method !== "turn/completed") {
        const error =
          "The active turn did not complete successfully, so the queued review was cancelled.";
        this.pendingReviewStarts.set(candidate.pendingReviewId, {
          ...candidate,
          status: "cancelled",
          error,
          updatedAt: Date.now(),
        });
        await this.context.emit({
          backend: candidate.backend,
          notification: {
            method: "thread/reviewStart/updated",
            params: {
              threadId: candidate.threadId,
              pendingReviewId: candidate.pendingReviewId,
              status: "cancelled",
              error,
            },
          },
        });
        continue;
      }
      const current = this.pendingReviewStarts.get(candidate.pendingReviewId);
      if (!current || current.status !== "scheduled") continue;
      const starting: PendingReviewStartRecord = {
        ...current,
        status: "starting",
        updatedAt: Date.now(),
      };
      this.pendingReviewStarts.set(candidate.pendingReviewId, starting);
      try {
        const response = await this.startReview(starting.request, true, starting.turnAttribution);
        this.pendingReviewStarts.set(candidate.pendingReviewId, {
          ...starting,
          status: "started",
          reviewThreadId: response.reviewThreadId,
          reviewTurnId: response.turnId,
          updatedAt: Date.now(),
        });
        this.reviewStartFailureNotices.delete(
          buildThreadIdentityKey(candidate.backend, candidate.threadId),
        );
        await this.context.emit({
          backend: candidate.backend,
          notification: {
            method: "thread/reviewStart/updated",
            params: {
              threadId: candidate.threadId,
              pendingReviewId: candidate.pendingReviewId,
              status: "started",
              reviewThreadId: response.reviewThreadId,
              reviewTurnId: response.turnId,
            },
          },
        });
        for (const waiting of pending) {
          if (waiting.pendingReviewId === candidate.pendingReviewId) {
            continue;
          }
          const currentWaiting = this.pendingReviewStarts.get(
            waiting.pendingReviewId,
          );
          if (!currentWaiting || currentWaiting.status !== "scheduled") continue;
          this.pendingReviewStarts.set(waiting.pendingReviewId, {
            ...currentWaiting,
            invokingTurnId: response.turnId,
            updatedAt: Date.now(),
          });
        }
        // An inline review is now the active turn. Remaining reviews wait for
        // its terminal lifecycle instead of starting concurrently.
        break;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.pendingReviewStarts.set(candidate.pendingReviewId, {
          ...starting,
          status: "failed",
          error: message,
          updatedAt: Date.now(),
        });
        backendRegistryLog.warn("scheduled review start failed", {
          backend: candidate.backend,
          pendingReviewId: candidate.pendingReviewId,
          threadId: candidate.threadId,
          error: message,
        });
        await this.context.emit({
          backend: candidate.backend,
          notification: {
            method: "thread/reviewStart/updated",
            params: {
              threadId: candidate.threadId,
              pendingReviewId: candidate.pendingReviewId,
              status: "failed",
              error: message,
            },
          },
        });
        failures.push({ error: message, target: candidate.request.target });
      }
    }
    if (failures.length > 0) {
      await this.sendReviewStartFailureNotice({
        backend: params.backend,
        threadId: params.threadId,
        failures,
      });
    } else {
      // The thread moved on without retrying, so a later failure is news.
      this.reviewStartFailureNotices.delete(
        buildThreadIdentityKey(params.backend, params.threadId),
      );
    }
  }

  /**
   * The agent was told its review was scheduled and then ended its turn, so
   * nothing else tells it, or the operator, that the start failed. The notice
   * queues behind any turn the thread is running, like other PwrAgent turns.
   */
  private async sendReviewStartFailureNotice(params: {
    backend: AppServerBackendKind;
    threadId: string;
    failures: Array<{ error: string; target: AppServerReviewTarget }>;
  }): Promise<void> {
    const noticeKey = buildThreadIdentityKey(params.backend, params.threadId);
    const fingerprint = reviewStartFailureFingerprint(params.failures);
    // A retry that fails the same way would otherwise start a turn that
    // retries again, without end.
    if (this.reviewStartFailureNotices.get(noticeKey) === fingerprint) {
      backendRegistryLog.warn("repeated scheduled review start failure not re-sent", {
        backend: params.backend,
        threadId: params.threadId,
      });
      return;
    }
    try {
      await this.host().submitTurn({
        backend: params.backend,
        threadId: params.threadId,
        input: [{
          type: "text",
          text: buildReviewStartFailurePrompt(params.failures),
        }],
        origin: "automation",
        messageOrigin: { kind: "pwragent" },
      });
      // Only a delivered notice suppresses the next one.
      this.reviewStartFailureNotices.set(noticeKey, fingerprint);
    } catch (error) {
      backendRegistryLog.warn("failed to send scheduled review start failure notice", {
        backend: params.backend,
        threadId: params.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveReviewModelSettings(
    backend: AppServerBackendKind,
    settings: ModelSettings,
  ): Promise<ModelSettings> {
    if (backend !== "codex") {
      return await this.host().resolveModelSettings(backend, settings, "review-start");
    }

    const models = await this.host().readCodexDefaultModelsOnce("review-start");
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

  async persistReviewSubAgent(
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
    const monitorId = reviewSubAgentId(record.turnId);
    const existing = await this.context.stores.subAgents.getThreadSubAgent({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      monitorId,
    });
    const subAgent: ThreadSubAgentSummary = {
      monitorId,
      task: record.task,
      status: patch.status ?? existing?.status ?? "running",
      createdAt: record.createdAt,
      updatedAt: patch.updatedAt ?? Date.now(),
      ownerRuntimeInstanceId:
        existing?.ownerRuntimeInstanceId ?? this.host().runtimeInstanceId,
      ownerRegistrySessionId:
        existing?.ownerRegistrySessionId ?? this.host().registrySessionId,
      backend: record.backend,
      ...(record.model ?? existing?.preferredModel
        ? { preferredModel: record.model ?? existing?.preferredModel }
        : {}),
      ...(record.reasoningEffort ?? existing?.preferredReasoningEffort
        ? {
            preferredReasoningEffort:
              record.reasoningEffort ?? existing?.preferredReasoningEffort,
          }
        : {}),
      ...(record.fastMode ?? existing?.preferredFastMode
        ? { preferredFastMode: record.fastMode ?? existing?.preferredFastMode }
        : {}),
      monitorThreadId: record.reviewThreadId,
      monitorTurnId: record.turnId,
      ...(record.context ?? existing?.reviewContext
        ? { reviewContext: record.context ?? existing?.reviewContext }
        : {}),
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

    await this.context.stores.subAgents.upsertThreadSubAgent({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      subAgent,
    });
    this.host().invalidateThreadListCache(record.parentBackend);
    await this.context.emit({
      backend: record.parentBackend,
      notification: {
        method: "thread/subAgents/updated",
        params: {
          threadId: record.parentThreadId,
        },
      },
    });
  }

  async completeReviewSubAgent(params: ReviewTerminal): Promise<void> {
    for (const terminals of this.pendingReviewTerminals) {
      terminals.set(
        buildReviewSubAgentKey(params.backend, params.threadId, params.turnId),
        params,
      );
    }
    const activeReview = this.findActiveReviewSubAgentForTerminal(params);
    if (!activeReview) {
      return;
    }

    this.activeReviewSubAgents.delete(activeReview.key);
    const { record } = activeReview;
    this.managedReviewParentsByChildThread.delete(
      buildThreadIdentityKey(record.backend, record.reviewThreadId),
    );
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

  clearNativeReviewActiveTurns(record: ReviewSubAgentRecord): void {
    if (record.mode === "native" && record.backend === "codex") {
      const reviewKey = buildActiveTurnModeKey(record.reviewThreadId, record.turnId);
      const interruptTurnId = this.host().activeCodexReviewInterruptTurnIds.get(reviewKey);
      for (const turnId of new Set([record.turnId, interruptTurnId])) {
        if (!turnId) {
          continue;
        }
        const modeKey = buildActiveTurnModeKey(record.reviewThreadId, turnId);
        this.host().activeCodexTurnModes.delete(modeKey);
        this.host().activeCodexReviewTurnKeys.delete(modeKey);
        this.host().activeTurnKeys.delete(buildActiveTurnKey("codex", record.reviewThreadId, turnId));
      }
      this.host().activeCodexReviewInterruptTurnIds.delete(reviewKey);
    }
  }

  async releaseNativeReviewParent(
    record: ReviewSubAgentRecord,
    terminal: ReviewTerminal,
  ): Promise<void> {
    await this.drainPendingReviewStartsForTerminalTurn({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      turnId: record.turnId,
      method: terminal.method,
    });
    this.host().drainPendingThreadWorkspaceMovesForTerminalTurn({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      turnId: record.turnId,
    });
    if (record.parentBackend === "codex") this.host().scheduleQueuedAgentChange(record.parentThreadId);
    void this.host().flushQueuedExecutionModeIfPresent(record.parentThreadId);
    void this.host().threadTurnQueue.releaseThread({
      backend: record.parentBackend,
      threadId: record.parentThreadId,
      turnId: record.turnId,
      status: terminal.method,
      ...(terminal.errorMessage ? { errorMessage: terminal.errorMessage } : {}),
    });
    if (record.mode === "native" && record.backend === "codex" && record.parentBackend === "codex"
      && record.reviewThreadId !== record.parentThreadId) {
      try {
        const retired = await this.host().withCodexThreadClient(record.reviewThreadId, async (client) =>
          await client.retireReviewThread?.({ threadId: record.reviewThreadId, parentThreadId: record.parentThreadId }));
        backendRegistryLog.info("native review thread retirement completed", {
          parentThreadId: record.parentThreadId, reviewThreadId: record.reviewThreadId, retired: retired === true,
        });
      } catch (error) {
        // Findings and the parent's terminal state have already been retained.
        // A cleanup failure must not fail the review or its parent's queue.
        backendRegistryLog.warn("native review thread retirement failed", {
          parentThreadId: record.parentThreadId, reviewThreadId: record.reviewThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  findReviewForParentTurn(params: {
    backend: AppServerBackendKind;
    parentThreadId: string;
    turnId?: string;
  }): ReviewSubAgentRecord | undefined {
    return Array.from(this.activeReviewSubAgents.values()).find(
      (record) =>
        record.parentBackend === params.backend
        && record.parentThreadId === params.parentThreadId
        && (!params.turnId || record.turnId === params.turnId),
    );
  }

  findManagedReviewForChildRequest(params: {
    backend: AppServerBackendKind;
    reviewThreadId: string;
    turnId?: string;
  }): ReviewSubAgentRecord | undefined {
    return Array.from(this.activeReviewSubAgents.values()).find(
      (record) =>
        record.mode === "managed"
        && record.backend === params.backend
        && record.reviewThreadId === params.reviewThreadId
        && (!params.turnId || record.turnId === params.turnId),
    );
  }

  async publishManagedReviewTerminal(params: {
    method: "turn/completed" | "turn/failed" | "turn/cancelled";
    notification: Extract<
      AppServerNotification,
      { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
    >;
    record: ReviewSubAgentRecord;
  }): Promise<void> {
    const completedAt =
      completedAtFromTerminalNotification(params.notification) ?? Date.now();
    const completedItemOutput = this.takeManagedReviewOutput(params.record);
    if (params.method === "turn/completed") {
      const output = await this.readManagedReviewOutput(
        params.record,
        params.notification as Extract<
          AppServerNotification,
          { method: "turn/completed" }
        >,
        completedItemOutput,
      );
      const parsed = parseReviewOutputText(output);
      const review = parsed
        ? formatReviewOutputText(parsed)
        : output?.trim() || "Review completed without output.";
      const entry: AppServerThreadReviewEntry = {
        type: "review",
        id: `managed-review:${params.record.turnId}:result`,
        review,
        createdAt: completedAt,
        reviewer: reviewEntryReviewer(params.record),
        ...(params.record.context ? { context: params.record.context } : {}),
        ...(parsed ? { output: parsed } : {}),
        turn: {
          id: params.record.turnId,
          status: "completed",
          completedAt,
        },
      };
      await this.context.stores.reviews.upsertManagedReviewEntry({
        backend: params.record.parentBackend,
        threadId: params.record.parentThreadId,
        entry,
        pendingContext: isAcpBackendId(params.record.parentBackend),
      });
      await this.context.emit({
        backend: params.record.parentBackend,
        notification: {
          method: "item/completed",
          params: {
            threadId: params.record.parentThreadId,
            turnId: params.record.turnId,
            item: {
              id: entry.id,
              type: "exitedReviewMode",
              review,
              createdAt: completedAt,
              // Same child-vs-parent key miss as the started item.
              data: {
                ...(parsed ? { reviewOutput: parsed } : {}),
                reviewer: entry.reviewer,
                ...(entry.context ? { context: entry.context } : {}),
              },
            },
          },
        },
      });
      backendRegistryLog.info("managed review artifact published", {
        parentThreadId: params.record.parentThreadId,
        reviewThreadId: params.record.reviewThreadId,
        structured: Boolean(parsed),
        turnId: params.record.turnId,
      });
      await this.context.emit({
        backend: params.record.parentBackend,
        notification: {
          method: "turn/completed",
          params: {
            threadId: params.record.parentThreadId,
            turnId: params.record.turnId,
            turn: {
              id: params.record.turnId,
              status: "completed",
              completedAt,
              output: [{ type: "text", text: review }],
            },
          },
        },
      });
      return;
    }

    backendRegistryLog.info("managed review artifact discarded", {
      method: params.method,
      parentThreadId: params.record.parentThreadId,
      reviewThreadId: params.record.reviewThreadId,
      turnId: params.record.turnId,
    });
    if (params.method === "turn/cancelled") {
      await this.context.emit({
        backend: params.record.parentBackend,
        notification: {
          method: "turn/cancelled",
          params: {
            threadId: params.record.parentThreadId,
            turnId: params.record.turnId,
            turn: {
              id: params.record.turnId,
              status: "cancelled",
              completedAt,
            },
          },
        },
      });
      return;
    }

    const failure = (
      params.notification as Extract<
        AppServerNotification,
        { method: "turn/failed" }
      >
    ).params.turn?.error?.message;
    await this.context.emit({
      backend: params.record.parentBackend,
      notification: {
        method: "turn/failed",
        params: {
          threadId: params.record.parentThreadId,
          turnId: params.record.turnId,
          turn: {
            id: params.record.turnId,
            status: "failed",
            completedAt,
            error: {
              message:
                typeof failure === "string" && failure.trim()
                  ? failure
                  : "Managed review failed.",
            },
          },
        },
      },
    });
  }

  private async readManagedReviewOutput(
    record: ReviewSubAgentRecord,
    notification: Extract<AppServerNotification, { method: "turn/completed" }>,
    completedItemOutput?: string,
  ): Promise<string | undefined> {
    const terminalOutput = notification.params.turn?.output
      ?.map((item) => item.text)
      .filter((text): text is string => typeof text === "string" && Boolean(text.trim()))
      .join("\n\n")
      .trim();
    if (terminalOutput) {
      return terminalOutput;
    }
    if (completedItemOutput?.trim()) {
      return completedItemOutput.trim();
    }
    try {
      const replay = await this.host().readThread({
        backend: record.backend,
        threadId: record.reviewThreadId,
      });
      return assistantOutputForTurn(replay.replay, record.turnId)
        .map((item) => item.text)
        .join("\n\n")
        .trim() || undefined;
    } catch (error) {
      backendRegistryLog.warn("managed review output read failed", {
        error: error instanceof Error ? error.message : String(error),
        reviewThreadId: record.reviewThreadId,
        turnId: record.turnId,
      });
      return undefined;
    }
  }

  rememberManagedReviewOutput(event: AgentEvent): void {
    if (
      event.notification.method !== "item/completed"
      || readNotificationItemType(event.notification) !== "agentMessage"
    ) {
      return;
    }
    const params = readRecord(event.notification.params);
    const reviewThreadId = readNonEmptyString(params?.threadId);
    const turnId = readNonEmptyString(params?.turnId);
    const output = textFragmentsFromCodexNotification(event.notification)
      .at(-1)
      ?.trim();
    if (!reviewThreadId || !turnId || !output) {
      return;
    }
    const record = this.findManagedReviewForChildRequest({
      backend: event.backend,
      reviewThreadId,
      turnId,
    });
    if (record?.mode !== "managed") {
      return;
    }
    this.managedReviewOutputByReviewTurn.set(
      buildReviewSubAgentKey(event.backend, reviewThreadId, record.turnId),
      output,
    );
  }

  private takeManagedReviewOutput(record: ReviewSubAgentRecord): string | undefined {
    const key = buildReviewSubAgentKey(
      record.backend,
      record.reviewThreadId,
      record.turnId,
    );
    const output = this.managedReviewOutputByReviewTurn.get(key);
    this.managedReviewOutputByReviewTurn.delete(key);
    return output;
  }

  findActiveReviewSubAgentForTerminal(params: {
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
      if (this.host().activeCodexReviewInterruptTurnIds.get(reviewTurnKey) === params.turnId) {
        return { key, record };
      }
    }

    return undefined;
  }

  findManagedReviewParentForChild(params: {
    backend: AppServerBackendKind;
    reviewThreadId: string;
  }): { parentBackend: AppServerBackendKind; parentThreadId: string } | undefined {
    const pending = this.managedReviewParentsByChildThread.get(
      buildThreadIdentityKey(params.backend, params.reviewThreadId),
    );
    if (pending) {
      return pending;
    }
    const active = Array.from(this.activeReviewSubAgents.values()).find(
      (record) =>
        record.mode === "managed"
        && record.backend === params.backend
        && record.reviewThreadId === params.reviewThreadId,
    );
    return active
      ? {
          parentBackend: active.parentBackend,
          parentThreadId: active.parentThreadId,
        }
      : undefined;
  }

  async startReviewFromAgentTool(
    request: PwrAgentThreadOrchestrationRequest<"start_review">,
  ): Promise<PwrAgentThreadOrchestrationResponse> {
    const invokingTurnId = request.context.turnId?.trim();
    if (
      !invokingTurnId ||
      !this.host().isLiveDynamicToolCall(request.context.backend, {
        threadId: request.context.threadId,
        turnId: invokingTurnId,
      })
    ) {
      return threadOrchestrationFailure(
        "forbidden",
        "start_review must be invoked from a live turn on the thread being reviewed.",
      );
    }
    if (
      isAcpBackendId(request.context.backend)
      && !this.context.providers.acp.supportsManagedReview(request.context.backend)
    ) {
      return threadOrchestrationFailure(
        "unsupported_backend",
        "Selected backend does not support review/start.",
      );
    }
    // The start runs after this turn ends, where a failure reaches only the
    // log. Choose the reviewer now, so a review that cannot run fails here.
    const reviewBackend = await this.resolveAgentToolReviewBackend(
      request.context.backend,
    );
    if (!reviewBackend) {
      return threadOrchestrationFailure(
        "unsupported_backend",
        `${request.context.backend} cannot run reviews, and no other installed provider can run one for this thread.`,
      );
    }
    const reviewBackendDiffers = reviewBackend !== request.context.backend;
    if (reviewBackendDiffers && request.args.runMode === "codex-sub-agent") {
      return threadOrchestrationFailure(
        "invalid_arguments",
        `This thread's reviews run on ${reviewBackend}, which requires runMode pwragent-sub-agent.`,
      );
    }

    try {
      const pending = this.scheduleReviewStart({
        invokingTurnId,
        turnAttribution: await this.host().readDelegatedTurnAncestry(request.context),
        idempotencyKey: request.context.callId,
        request: await this.prepareReviewRequest({
          backend: request.context.backend,
          threadId: request.context.threadId,
          target: request.args.target,
          runMode: request.args.runMode,
          delivery: "inline",
          ...(reviewBackendDiffers ? { reviewBackend } : {}),
          ...(request.args.cwd ? { cwd: request.args.cwd } : {}),
        }),
      });
      return {
        ok: true,
        data: {
          backend: pending.backend,
          threadId: pending.threadId,
          pendingReviewId: pending.pendingReviewId,
          status: "scheduled",
          target: pending.request.target,
          ...(pending.request.cwd ? { cwd: pending.request.cwd } : {}),
          invokingTurnId: pending.invokingTurnId,
          createdAt: pending.createdAt,
          message: reviewBackendDiffers
            ? `Review scheduled to run on ${isAcpBackendId(reviewBackend) ? reviewBackend : BACKEND_LABELS[reviewBackend]}, because ${request.context.backend} cannot run reviews. Stop work and let this turn complete; PwrAgent will start the review automatically.`
            : "Review scheduled. Stop work and let this turn complete; PwrAgent will start the review automatically.",
        } satisfies StartReviewToolResult,
      };
    } catch (error) {
      return threadOrchestrationFailure(
        "internal_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Item types forwarded from a managed review's hidden child thread onto its
   * parent transcript.
   *
   * An ALLOWLIST, deliberately. The child's final assistant message is the raw
   * JSON findings blob and its reasoning is model prose; forwarding either
   * would render them as parent-thread messages. A denylist would leak both the
   * moment a provider adds a type. An unknown type going unforwarded costs a
   * missing progress row, which is the far cheaper failure.
   */
  private static readonly MANAGED_REVIEW_FORWARDED_ITEM_TYPES = new Set([
    "commandExecution",
    "fileChange",
    "mcpToolCall",
    "patchApply",
    "toolCall",
    "webSearch",
  ]);

  /**
   * Streaming refinements of an already-forwarded item. These carry no item
   * envelope of their own, so they are matched by method and rewritten onto the
   * parent unconditionally — they only ever refine an item the allowlist above
   * already let through.
   */
  private static readonly MANAGED_REVIEW_FORWARDED_METHODS = new Set([
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/mcpToolCall/progress",
  ]);

  /**
   * Mirror a managed review sub-agent's tool activity onto the thread being
   * reviewed, so an in-flight review shows what it is doing instead of a silent
   * gap between "started" and the findings.
   *
   * Deliberately transient: the forwarded copies are events only, never
   * persisted. They live in the renderer's in-memory session state for as long
   * as the thread stays loaded and vanish on reload or eviction. That is the
   * intended lifetime — the review's *findings* are durable in the overlay via
   * `upsertManagedReviewEntry`, so nothing an operator still needs to read is
   * lost when the breadcrumb goes. It also keeps command output out of sqlite,
   * which `docs/thread-history-persistence.md` requires.
   */
  async forwardManagedReviewActivity(event: AgentEvent): Promise<void> {
    // Every emitted event reaches this method, including per-chunk streaming
    // deltas on unrelated threads. Reviews are rare and short-lived, so settle
    // the common case with a size check before touching the notification.
    if (this.activeReviewSubAgents.size === 0) {
      return;
    }
    const method = event.notification.method;
    const isItemEnvelope =
      method === "item/started" || method === "item/completed";
    if (
      !isItemEnvelope
      && !ManagedReviewService.MANAGED_REVIEW_FORWARDED_METHODS.has(method)
    ) {
      return;
    }
    const params = event.notification.params as {
      threadId?: unknown;
      turnId?: unknown;
      itemId?: unknown;
      item?: { id?: unknown; type?: unknown };
    };
    const childThreadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (!childThreadId) {
      return;
    }
    const record = this.findManagedReviewForChildRequest({
      backend: event.backend,
      reviewThreadId: childThreadId,
      ...(typeof params.turnId === "string" ? { turnId: params.turnId } : {}),
    });
    // Only a managed review child has a record here; a normal thread's own
    // items never match, which is also what stops the forwarded copy (addressed
    // to the parent) from being forwarded again.
    if (!record || record.reviewThreadId === record.parentThreadId) {
      return;
    }
    if (isItemEnvelope) {
      const itemType =
        typeof params.item?.type === "string" ? params.item.type : undefined;
      if (
        !itemType
        || !ManagedReviewService.MANAGED_REVIEW_FORWARDED_ITEM_TYPES.has(itemType)
      ) {
        return;
      }
    }
    // Namespace every id so a forwarded item can never collide with a real
    // item on the parent thread, and group it under the review's turn so it
    // nests with the review entry rather than floating at the transcript tail.
    const namespaceId = (value: unknown): string | undefined =>
      typeof value === "string" ? `managed-review:${value}` : undefined;
    const forwardedItemId = namespaceId(params.item?.id);
    const forwardedRefId = namespaceId(params.itemId);
    // Straight to listeners, NOT back through `emit`. The forwarded copy is a
    // view of activity the child thread already recorded; replaying it through
    // the pipeline would write a second tool-invocation row per item and add
    // parent-keyed entries to the file-change approval-context cache.
    await this.host().emitToListeners({
      backend: record.parentBackend,
      notification: {
        ...event.notification,
        params: {
          ...(event.notification.params as Record<string, unknown>),
          threadId: record.parentThreadId,
          turnId: record.turnId,
          ...(forwardedRefId ? { itemId: forwardedRefId } : {}),
          ...(params.item && forwardedItemId
            ? { item: { ...params.item, id: forwardedItemId } }
            : {}),
        },
      },
    } as AgentEvent);
  }

  /**
   * Provider transcripts do not attach model settings to review-mode items.
   * The registry owns that association for the review's lifetime, so include
   * it in the live item as well as the durable review artifact.
   */
  withReviewRuntimeMetadata(event: AgentEvent): AgentEvent {
    if (event.notification.method !== "item/completed") {
      return event;
    }
    const params = readRecord(event.notification.params);
    const threadId = readNonEmptyString(params?.threadId);
    const turnId = readNonEmptyString(params?.turnId);
    const item = readRecord(params?.item);
    const itemType = readNonEmptyString(item?.type);
    if (
      !threadId
      || !turnId
      || !item
      || (itemType !== "enteredReviewMode" && itemType !== "exitedReviewMode")
    ) {
      return event;
    }
    const reviewKey = buildReviewSubAgentKey(event.backend, threadId, turnId);
    const record =
      this.activeReviewSubAgents.get(reviewKey)
      ?? this.reviewSubAgentsByReviewTurn.get(reviewKey);
    if (!record) {
      return event;
    }
    const data = readRecord(item.data) ?? {};
    // Each field guards itself. Keying the whole decoration off `reviewer`
    // made a later field's delivery depend on an unrelated field's absence:
    // an item that already carried a reviewer would silently ship without
    // provenance.
    const additions = {
      ...(data.reviewer ? {} : { reviewer: reviewEntryReviewer(record) }),
      ...(record.context && !data.context ? { context: record.context } : {}),
    };
    if (Object.keys(additions).length === 0) {
      return event;
    }
    return {
      ...event,
      notification: {
        ...event.notification,
        params: {
          ...event.notification.params,
          item: {
            ...item,
            data: {
              ...data,
              ...additions,
            },
          },
        },
      },
    } as AgentEvent;
  }
}
