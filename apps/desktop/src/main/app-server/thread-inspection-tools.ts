import { randomUUID } from "node:crypto";
import type { ThreadRenameOptions } from "@pwragent/owner-core/thread-naming-lifecycle";
import type { ThreadTurnQueue } from "@pwragent/owner-core/thread-turn-queue";
import {
  DEFAULT_THREAD_INSPECTION_RECENT_LIMIT,
  DEFAULT_THREAD_INSPECTION_SEARCH_LIMIT,
  MAX_THREAD_INSPECTION_SEARCH_LIMIT,
  buildThreadIdentityKey,
  buildThreadMarkdownLink,
  buildThreadUrl,
  isAppServerBackendKind,
  isThreadExecutionMode,
  isThreadLockRefusal,
  isThreadSearchContentMode,
  isThreadSearchSemanticMode,
  normalizeThreadLockNote,
  threadSeenWatermark,
  type AppServerBackendKind,
  type AppServerPendingRequestNotification,
  type AppServerReadThreadRequest,
  type AppServerReadThreadResponse,
  type AppServerThreadMessageOrigin,
  type AppServerThreadStatus,
  type AppServerThreadSummary,
  type AppServerToolRequestUserInputResponse,
  type ArchiveThreadRequest,
  type ArchiveThreadResponse,
  type FederationInstanceId,
  type GetThreadStatusToolArgs,
  type HandoffThreadWorkspaceRequest,
  type HandoffThreadWorkspaceResponse,
  type MessagingDynamicToolCategory,
  type MessagingThreadBindingSummary,
  type MutateThreadParentV1Request,
  type MutateThreadToolArgs,
  type PendingThreadApprovalSummary,
  type PendingThreadHandoffSummary,
  type PendingThreadWorkspaceMoveSummary,
  type PwrAgentThreadInspectionRequest,
  type PwrAgentThreadInspectionResponse,
  type ReadThreadToolArgs,
  type RenameThreadRequest,
  type RenameThreadResponse,
  type RestoreThreadRequest,
  type RestoreThreadResponse,
  type SetThreadExecutionModeRequest,
  type SetThreadExecutionModeResponse,
  type SetThreadLockResponse,
  type SetThreadModelSettingsRequest,
  type SetThreadModelSettingsResponse,
  type SubmitServerRequestRequest,
  type ThreadExecutionMode,
  type ThreadInspectionSummary,
  type ThreadLock,
  type ThreadLockSource,
  type ThreadMaintenanceRules,
  type ThreadMutationAppliedChange,
  type ThreadOverlayState,
  type ThreadSearchFilters,
  type ThreadSearchResult,
} from "@pwragent/shared";
import { checkAgentAccessRequest } from "../agent-tools/agent-access-ceiling";
import type { PwrAgentFederationHandler } from "../agent-tools/pwragent-federation-agent-tools";
import type {
  PwrAgentFederatedThreadInspectionHandler,
  PwrAgentFederatedThreadInspectionResult,
  PwrAgentFederatedThreadMutationHandler,
} from "../agent-tools/pwragent-thread-agent-tools";
import {
  planThreadMaintenanceApply,
  summarizeThreadMaintenanceRun,
  summarizeThreadMaintenanceScan,
  threadMaintenanceConfirmationQuestion,
} from "../agent-tools/thread-maintenance-tool-results";
import { THREAD_MAINTENANCE_TOOL_WAIT_MS, ThreadMaintenanceToolScans } from "../agent-tools/thread-maintenance-tool-scans";
import { getMainLogger } from "../log";
import { compareBindingsByCreation } from "../messaging/core/messaging-binding-thread-match";
import { getDesktopMessagingStore } from "../messaging/desktop-messaging-store";
import { toMessagingThreadBindingSummary } from "../messaging/messaging-bindings-snapshot";
import { createThreadSearchStorage, type MessagingStoreLike } from "../storage/desktop-runtime-storage";
import { ProviderTranscriptThreadSearchAdapter } from "../thread-search/thread-search-provider-adapters";
import { ThreadSearchService } from "../thread-search/thread-search-service";
import type { RegistryHandlers } from "./backend-registry-handlers";
import { readRecord } from "./backend-registry-notification-values";
import {
  ACTIVE_TURN_HANDOFF_ERROR,
  PENDING_APPROVAL_GUIDANCE,
  THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL,
  THREAD_MAINTENANCE_CONFIRM_QUESTION_ID,
} from "./backend-registry-runtime-helpers";
import type {
  AgentThreadActions,
  MessagingArchiveCleanupStore,
  PendingServerRequest,
  ThreadListCallerReason,
  ThreadMaintenanceToolHandler,
  ThreadPrAutoDispatchHandler,
} from "./backend-registry-types";
import type { ForgeToolBridge } from "./forge-tool-bridge";
import type { GitWorkingStateService } from "./git-working-state-service";
import type { RegistryContext, RegistryHost } from "./registry-context";
import {
  DEFAULT_THREAD_INSPECTION_READ_ENTRY_CHARS,
  DEFAULT_THREAD_INSPECTION_READ_LIMIT,
  MAX_THREAD_INSPECTION_READ_ENTRY_CHARS,
  MAX_THREAD_INSPECTION_READ_LIMIT,
  MAX_THREAD_PARENT_CHECK_DEPTH,
  buildThreadInspectionDateRange,
  clampInteger,
  dedupeThreadInspectionThreadSummaries,
  federatedThreadInspectionFailure,
  filterThreadInspectionSummaries,
  nonEmptyStringArray,
  normalizeThreadInspectionSearchRanks,
  readThreadInspectionBackend,
  readThreadMutationModelSettings,
  threadInspectionFailure,
  toThreadInspectionSearchSummary,
  toThreadInspectionSummary,
  toThreadInspectionSummaryFromNavigation,
  toThreadInspectionSummaryFromSearchResult,
  toThreadReadEntrySummary,
  toThreadReadMessageSummary,
  truncateThreadInspectionText,
} from "./thread-inspection-summaries";
import { buildPendingRequestKey } from "./thread-turn-keys";
import {
  toThreadReadEvaluationPricing,
  toThreadReadEvaluationTokenMiser,
} from "./thread-usage-math";

// The registry's logger name, so moved log lines read as they did.
const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** The inspection bindings the composition root supplies at construction. */
export type ThreadInspectionToolsHandlers = Pick<RegistryHandlers,
  | "federatedThreadMutationHandler"
  | "threadMaintenanceToolHandler"
>;

/** Collaborators the composition root builds for this module. */
export interface ThreadInspectionToolsDependencies {
  readonly forgeToolBridge: ForgeToolBridge;
  readonly threadInspectionSearchService: ThreadSearchService | null | undefined;
  readonly threadMaintenanceToolScans?: ThreadMaintenanceToolScans;
}

/**
 * Registry-owned state and thread operations the inspection tools read or
 * call. The registry's construction ports satisfy it; this module never
 * imports the registry.
 */
export interface ThreadInspectionToolsHost {
  readonly pendingServerRequests: Map<string, PendingServerRequest>;
  readonly agentThreadActions: AgentThreadActions | undefined;
  readonly federationHandler: PwrAgentFederationHandler | undefined;
  readonly federatedThreadInspectionHandler: PwrAgentFederatedThreadInspectionHandler | undefined;
  readonly threadDependencyToolHandler: RegistryHandlers["threadDependencyToolHandler"];
  readonly threadPrAutoDispatchHandler: ThreadPrAutoDispatchHandler | undefined;
  readonly threadTurnQueue: ThreadTurnQueue;
  readonly gitWorkingStateService: GitWorkingStateService;
  readonly messagingStore: MessagingArchiveCleanupStore | null | undefined;
  listThreads(params?: {
    archived?: boolean;
    backend?: AppServerBackendKind;
    callerReason?: ThreadListCallerReason;
    enrichDirectories?: boolean;
    filter?: string;
    forceRefresh?: boolean;
    limit?: number;
    maxPages?: number;
    skipArchivedMetadataRefresh?: boolean;
  }): Promise<AppServerThreadSummary[]>;
  readThread(request: AppServerReadThreadRequest): Promise<AppServerReadThreadResponse>;
  archiveThread(request: ArchiveThreadRequest & { preserveWorktrees?: boolean }): Promise<ArchiveThreadResponse>;
  restoreThread(request: RestoreThreadRequest): Promise<RestoreThreadResponse>;
  renameThread(request: RenameThreadRequest, options?: ThreadRenameOptions): Promise<RenameThreadResponse>;
  handoffThreadWorkspace(request: HandoffThreadWorkspaceRequest): Promise<HandoffThreadWorkspaceResponse>;
  setThreadExecutionMode(params: SetThreadExecutionModeRequest): Promise<SetThreadExecutionModeResponse>;
  setThreadModelSettings(params: SetThreadModelSettingsRequest): Promise<SetThreadModelSettingsResponse>;
  setThreadLock(
    request: { backend: AppServerBackendKind; threadId: string; locked: boolean; note?: string },
    origin: { source: ThreadLockSource; sourceInstanceId?: FederationInstanceId },
    options?: { resumeQueue?: boolean },
  ): Promise<SetThreadLockResponse>;
  writeThreadLock(
    identity: { backend: AppServerBackendKind; threadId: string },
    lock: ThreadLock | undefined,
  ): Promise<void>;
  getQueuedExecutionModesSnapshot(): Record<
    string,
    { mode: ThreadExecutionMode; queuedAt: number } | undefined
  >;
  getPendingThreadHandoffsForInspection(params?: {
    backend?: AppServerBackendKind | "all";
    query?: string;
    sourceThreadId?: string;
    limit?: number;
  }): PendingThreadHandoffSummary[];
  getPendingThreadWorkspaceMovesForInspection(params?: {
    backend?: AppServerBackendKind | "all";
    query?: string;
    sourceThreadId?: string;
    limit?: number;
  }): PendingThreadWorkspaceMoveSummary[];
  threadHasActiveTurn(
    threadId: string,
    backend?: AppServerBackendKind,
    ignoreCodexStartReservation?: boolean,
  ): boolean;
  resolveAgentCallerExecutionMode(context: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    overlay?: ThreadOverlayState;
  }): Promise<ThreadExecutionMode>;
  readCausalMessagingContext(context: { backend: AppServerBackendKind; threadId: string; turnId?: string }): Promise<
    Pick<AppServerThreadMessageOrigin, "causalMessagingSource" | "causalMessagingAmbiguous">
  >;
  dynamicToolPermissionDenied(
    backend: AppServerBackendKind,
    category: MessagingDynamicToolCategory,
    call: { threadId: string; turnId?: string; tool: string; arguments?: unknown },
  ): Promise<string | null>;
}

/**
 * The thread inspection domain of the backend registry: the agent tools that
 * search, read and report on threads, mutate a thread's settings, grouping
 * and lifecycle, run thread maintenance, and dispatch the PR, dependency and
 * project-read tools to their owners.
 */
export class ThreadInspectionTools {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadInspectionToolsHost>;
  private readonly forgeToolBridge: ForgeToolBridge;

  constructor(
    context: RegistryContext,
    handlers: ThreadInspectionToolsHandlers,
    dependencies: ThreadInspectionToolsDependencies,
    host: RegistryHost<ThreadInspectionToolsHost>,
  ) {
    this.context = context;
    this.host = host;
    this.forgeToolBridge = dependencies.forgeToolBridge;
    this.federatedThreadMutationHandler = handlers.federatedThreadMutationHandler;
    this.threadMaintenanceToolHandler = handlers.threadMaintenanceToolHandler;
    this.threadMaintenanceToolScans = dependencies.threadMaintenanceToolScans;
    this.threadInspectionSearchService = dependencies.threadInspectionSearchService;
  }

  private federatedThreadMutationHandler:
    | PwrAgentFederatedThreadMutationHandler
    | undefined;
  private threadMaintenanceToolHandler: ThreadMaintenanceToolHandler | undefined;
  private threadMaintenanceToolScans: ThreadMaintenanceToolScans | undefined;
  /** Null turns search off; undefined builds the transcript search on first use. */
  threadInspectionSearchService: ThreadSearchService | null | undefined;

  // Federation needs the registry before it can supply routed owner bindings.
  setFederatedThreadMutationHandler(
    handler: PwrAgentFederatedThreadMutationHandler | null | undefined,
  ): void {
    this.federatedThreadMutationHandler = handler ?? undefined;
  }

  // The app-server service needs the registry before it can supply this owner binding.
  setThreadMaintenanceToolHandler(handler: ThreadMaintenanceToolHandler | undefined): void {
    this.threadMaintenanceToolHandler = handler;
    this.threadMaintenanceToolScans = handler ? new ThreadMaintenanceToolScans({
      scan: async (request) => await handler.scan(request),
      getScan: (scanId) => handler.getScan(scanId),
    }) : undefined;
  }

  /** What the operator has yet to answer on a thread, for get_thread_status. */
  private pendingApprovalsForInspection(
    backend: AppServerBackendKind,
    threadId: string,
    includeMessages: boolean,
  ): PendingThreadApprovalSummary[] {
    const approvals: PendingThreadApprovalSummary[] = [];
    for (const pending of this.host().pendingServerRequests.values()) {
      const request = pending.notification;
      if (pending.backend !== backend || request.params.threadId !== threadId) continue;
      const params = request.method === "mcpServer/elicitation/request" ? readRecord(request.params) : undefined;
      approvals.push({
        method: request.method,
        ...(typeof params?.serverName === "string" ? { serverName: params.serverName } : {}),
        // Another thread's prompt can quote its work; only the asker sees it.
        ...(includeMessages && typeof params?.message === "string" ? { message: params.message } : {}),
      });
    }
    return approvals;
  }

  async handleThreadInspectionRequest(
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
      const instanceId = request.args.instanceId?.trim();
      const includeRemote = request.args.includeRemote !== false;
      if (Object.hasOwn(request.args, "instanceId") && !instanceId) {
        return threadInspectionFailure(
          "invalid_arguments",
          "instanceId must be a non-empty string when provided.",
        );
      }
      if (instanceId && !includeRemote) {
        return threadInspectionFailure(
          "invalid_arguments",
          "instanceId cannot be used when includeRemote is false.",
        );
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
      if (instanceId) {
        return await this.mergeFederatedThreadSearchResults({
          args: request.args,
          context: request.context,
          instanceId,
          includeRemote,
          limit,
          localResponse: {
            ok: true,
            data: {
              threads: [],
              totalCount: 0,
              limit,
              truncated: false,
            },
          },
        });
      }
      const pendingHandoffs = this.host().getPendingThreadHandoffsForInspection({
        backend,
        query: request.args.query,
        sourceThreadId: request.context.threadId,
        limit,
      });
      const pendingWorkspaceMoves =
        this.host().getPendingThreadWorkspaceMovesForInspection({
          backend,
          query: request.args.query,
          sourceThreadId: request.context.threadId,
          limit,
        });
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
        return await this.mergeFederatedThreadSearchResults({
          args: request.args,
          context: request.context,
          instanceId,
          includeRemote,
          limit,
          localResponse: {
            ok: true,
            data: {
              threads,
              totalCount: filtered.length,
              limit,
              truncated: response.truncated === true || filtered.length > limit,
              ...(pendingHandoffs.length ? { pendingHandoffs } : {}),
              ...(pendingWorkspaceMoves.length ? { pendingWorkspaceMoves } : {}),
              query: response.query,
              searchedScopes: response.searchedScopes,
              unavailableScopes: response.unavailableScopes,
              contentMode: response.contentMode,
              semanticMode: response.semanticMode,
            },
          },
        });
      }
      const listBackend = backend === "all" ? undefined : backend;
      const activeThreads = await this.host().listThreads({
        backend: listBackend,
        archived: false,
        callerReason: "agent-thread-inspection",
      });
      const threads =
        request.args.includeArchived === true
          ? dedupeThreadInspectionThreadSummaries([
              ...activeThreads,
              ...(await this.host().listThreads({
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
      return await this.mergeFederatedThreadSearchResults({
        args: request.args,
        context: request.context,
        instanceId,
        includeRemote,
        limit,
        localResponse: {
          ok: true,
          data: {
            threads: filtered.slice(0, limit).map(toThreadInspectionSearchSummary),
            totalCount: filtered.length,
            limit,
            truncated: filtered.length > limit,
            ...(pendingHandoffs.length ? { pendingHandoffs } : {}),
            ...(pendingWorkspaceMoves.length ? { pendingWorkspaceMoves } : {}),
          },
        },
      });
    }

    if (request.operation === "get_thread_status") {
      return await this.handleGetThreadStatusInspectionRequest(
        {
          ...request.args,
          backend: request.args.backend ?? request.context.backend,
          threadId: request.args.threadId ?? request.context.threadId,
        },
        request.context,
      );
    }

    if (request.operation === "read_thread") {
      return await this.handleReadThreadInspectionRequest(request.args);
    }

    if (request.operation === "attach_thread_pull_request") {
      return await this.forgeToolBridge.handleAttachThreadPullRequestInspectionRequest({
        ...request.args,
        backend: request.args.backend ?? request.context.backend,
        threadId: request.args.threadId ?? request.context.threadId,
      });
    }

    if (request.operation === "check_thread_pull_request_status") {
      if (!this.forgeToolBridge.pullRequestStatusTool) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "Pull request status checks are not available.",
          },
        };
      }
      return await this.forgeToolBridge.pullRequestStatusTool(
        {
          ...request.args,
          backend: request.args.backend ?? request.context.backend,
          threadId: request.args.threadId ?? request.context.threadId,
        },
        request.context,
      );
    }

    if (request.operation === "watch_thread_pull_request") {
      if (!this.forgeToolBridge.pullRequestWatchTool) {
        return {
          ok: false,
          error: {
            code: "unsupported_operation",
            message: "Pull request completion watches are not available.",
          },
        };
      }
      return await this.forgeToolBridge.pullRequestWatchTool({
        ...request.args,
        backend: request.args.backend ?? request.context.backend,
        threadId: request.args.threadId ?? request.context.threadId,
      });
    }

    if (request.operation === "manage_thread_dependencies") {
      const host = this.host();
      if (!host.threadDependencyToolHandler) return threadInspectionFailure("unsupported_operation", "Thread dependencies are not available.");
      // The resumed turn may have lost the plan to compaction, so an agent must
      // write it down. This message is worded for an agent; the desktop
      // service refuses a blank plan from the operator's dialog too.
      if (request.args.action === "create"
        && (typeof request.args.continuation !== "string" || !request.args.continuation.trim())) {
        return threadInspectionFailure("invalid_arguments", "Provide continuation: the concrete steps this thread should take when the prerequisites are met, written so a reader without this conversation can act on them.");
      }
      return await host.threadDependencyToolHandler({
        ...request.args,
        ...(request.args.action === "create" && Array.isArray(request.args.conditions)
          ? { conditions: await this.withDependencyTitles(request.args.conditions) }
          : {}),
        backend: request.args.backend ?? request.context.backend,
        threadId: request.args.threadId ?? request.context.threadId,
      }, await this.host().readCausalMessagingContext(request.context), `agent:${request.context.backend}:${request.context.threadId}`);
    }

    if (request.operation === "mark_project_read") {
      const args = request.args;
      if (typeof args.projectKey !== "string" || !args.projectKey.trim()
        || (args.instanceId !== undefined && (typeof args.instanceId !== "string" || !args.instanceId.trim()))
        || Object.keys(args).some((key) => key !== "projectKey" && key !== "instanceId")) {
        return threadInspectionFailure("invalid_arguments", "Provide an exact projectKey and optional nonempty instanceId.");
      }
      const host = this.host();
      if (!host.agentThreadActions?.markProjectRead) {
        return threadInspectionFailure("unsupported_operation", "Project mark-read is unavailable on this instance.");
      }
      try {
        const projectRead = await host.agentThreadActions.markProjectRead({
          projectKey: args.projectKey,
          ...(args.instanceId !== undefined ? { instanceId: args.instanceId.trim() } : {}),
        });
        return { ok: true, data: { projectRead } };
      } catch (error) {
        return threadInspectionFailure("internal_error", error instanceof Error ? error.message : String(error));
      }
    }

    if (request.operation === "scan_thread_maintenance"
      || request.operation === "apply_thread_maintenance"
      || request.operation === "open_thread_maintenance") {
      return await this.handleThreadMaintenanceToolRequest(request);
    }

    if (request.operation === "rename_current_thread") {
      const args = request.args;
      if (typeof args.title !== "string" || !args.title.trim() || args.title.length > 200
        || Object.keys(args).some((key) => key !== "title")) {
        return threadInspectionFailure("invalid_arguments", "Provide only a title between 1 and 200 characters.");
      }
      return await this.handleMutateThreadInspectionRequest({
        backend: request.context.backend,
        threadId: request.context.threadId,
        includeRemote: false,
        title: args.title,
      }, request.context);
    }

    if (request.operation === "mutate_thread") {
      return await this.handleMutateThreadInspectionRequest(
        request.args,
        request.context,
      );
    }

    return {
      ok: false,
      error: {
        code: "unsupported_operation",
        message: "Unsupported PwrAgent thread inspection operation.",
      },
    };
  }

  private async handleThreadMaintenanceToolRequest(
    request: Extract<PwrAgentThreadInspectionRequest, {
      operation: "scan_thread_maintenance" | "apply_thread_maintenance" | "open_thread_maintenance";
    }>,
  ): Promise<PwrAgentThreadInspectionResponse> {
    // Every answer must reach the agent within one MCP request's limit.
    const callStartedAt = Date.now();
    const handler = this.threadMaintenanceToolHandler;
    const scans = this.threadMaintenanceToolScans;
    if (!handler || !scans) return threadInspectionFailure("unsupported_operation", "Thread maintenance is unavailable on this instance.");
    const args = (request.args ?? {}) as Record<string, unknown>;
    const allowed = (keys: string[]) => Object.keys(args).every((key) => keys.includes(key));
    const projectKey = args.projectKey;
    if (projectKey !== undefined && (typeof projectKey !== "string" || !projectKey.trim())) {
      return threadInspectionFailure("invalid_arguments", "projectKey must be a nonempty project path.");
    }
    try {
      if (request.operation === "open_thread_maintenance") {
        if (!allowed(["projectKey"])) return threadInspectionFailure("invalid_arguments", "Pass only an optional projectKey.");
        const opened = handler.open(typeof projectKey === "string" ? { projectKey: projectKey.trim() } : {});
        return { ok: true, data: { maintenanceDialog: { opened } } };
      }
      if (request.operation === "scan_thread_maintenance") {
        if (!allowed(["projectKey", "rules", "scanId"])) return threadInspectionFailure("invalid_arguments", "Pass only projectKey, rules and scanId.");
        const rules = args.rules;
        if (rules !== undefined && (!rules || typeof rules !== "object" || Array.isArray(rules))) {
          return threadInspectionFailure("invalid_arguments", "rules must be an object.");
        }
        const scanId = args.scanId;
        if (scanId !== undefined && (typeof scanId !== "string" || !scanId.trim())) {
          return threadInspectionFailure("invalid_arguments", "scanId must be the nonempty scanId of an earlier scan.");
        }
        if (scanId !== undefined && (projectKey !== undefined || rules !== undefined)) {
          return threadInspectionFailure("invalid_arguments", "Pass scanId alone to read a scan, or projectKey and rules to start one.");
        }
        const outcome = typeof scanId === "string"
          ? await scans.read(scanId.trim(), THREAD_MAINTENANCE_TOOL_WAIT_MS)
          : await scans.start({
            ...(typeof projectKey === "string" ? { projectKey: projectKey.trim() } : {}),
            ...(rules ? { rules: rules as Partial<ThreadMaintenanceRules> } : {}),
          }, THREAD_MAINTENANCE_TOOL_WAIT_MS);
        const run = handler.getRun();
        switch (outcome.kind) {
          case "finished":
            return { ok: true, data: { maintenanceScan: summarizeThreadMaintenanceScan(outcome.scan, run) } };
          case "running":
            return { ok: true, data: { maintenanceScanPending: {
              scanId: outcome.scanId, running: true, startedAt: outcome.startedAt,
              ...(outcome.projectKey ? { projectKey: outcome.projectKey } : {}),
              ...(run ? { run: summarizeThreadMaintenanceRun(run) } : {}),
              guidance: "The scan is still running in PwrAgent and changes nothing. Call scan_thread_maintenance with only this scanId to read it. "
                + `Each call waits up to ${THREAD_MAINTENANCE_TOOL_WAIT_MS / 1_000} seconds. Do not start another scan.`,
            } } };
          case "failed":
            return threadInspectionFailure("internal_error", `The scan failed: ${outcome.message}`);
          case "missing":
            return threadInspectionFailure("not_found", "That scan is no longer available. Call scan_thread_maintenance again.");
        }
      }
      if (!allowed(["scanId", "archive", "removeCheckouts", "trashCheckouts", "removeEmptyFolders", "hibernate", "dryRun"])) {
        return threadInspectionFailure("invalid_arguments", "Pass only scanId, archive, removeCheckouts, trashCheckouts, removeEmptyFolders, hibernate and dryRun.");
      }
      const applyArgs = request.args as import("@pwragent/shared").ApplyThreadMaintenanceToolArgs;
      if (typeof applyArgs.scanId !== "string" || !applyArgs.scanId.trim()) {
        return threadInspectionFailure("invalid_arguments", "Pass the scanId from scan_thread_maintenance.");
      }
      for (const key of ["archive", "removeCheckouts", "trashCheckouts", "hibernate"] as const) {
        if (applyArgs[key] !== undefined && !Array.isArray(applyArgs[key])) {
          return threadInspectionFailure("invalid_arguments", `${key} must be an array.`);
        }
      }
      const scan = handler.getScan(applyArgs.scanId.trim());
      if (!scan) return threadInspectionFailure("not_found", "That scan is no longer available. Call scan_thread_maintenance again.");
      const plan = planThreadMaintenanceApply(applyArgs, scan, {
        backend: request.context.backend, threadId: request.context.threadId,
      });
      if ("error" in plan) return threadInspectionFailure("invalid_arguments", plan.error);
      if (applyArgs.dryRun === true) return { ok: true, data: { maintenancePlan: plan.summary, dryRun: true } };
      if (handler.getRun()?.running) {
        return threadInspectionFailure("forbidden", "Thread maintenance is already running. Wait for it, then scan again.");
      }
      const approved = await this.requestThreadMaintenanceConfirmation({
        backend: request.context.backend,
        threadId: request.context.threadId,
        turnId: request.context.turnId,
        itemId: request.context.callId,
        requestId: `thread-maintenance:${scan.scanId}:${request.context.callId?.trim() || randomUUID()}`,
        question: threadMaintenanceConfirmationQuestion(plan.summary),
      });
      if (!approved) {
        return threadInspectionFailure("forbidden", "The operator declined this thread maintenance run. Do not retry it. Ask the operator what to change.");
      }
      const { done } = handler.start(plan.request);
      // The operator's answer to the card counts against the same limit.
      const waitMs = Math.max(0, THREAD_MAINTENANCE_TOOL_WAIT_MS - (Date.now() - callStartedAt));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waited = await Promise.race([
        done,
        new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); }),
      ]).finally(() => clearTimeout(timer));
      const run = waited ?? handler.getRun();
      if (!run) return threadInspectionFailure("internal_error", "Thread maintenance did not report a run.");
      return { ok: true, data: { maintenanceRun: summarizeThreadMaintenanceRun(run) } };
    } catch (error) {
      return threadInspectionFailure("internal_error", error instanceof Error ? error.message : String(error));
    }
  }

  /** One approve-or-cancel card on the calling thread. Resolves false on
   * anything but an explicit approval. */
  async requestThreadMaintenanceConfirmation(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId?: string;
    itemId?: string;
    requestId: string;
    question: string;
    header?: string;
    approveLabel?: string;
    approveDescription?: string;
  }): Promise<boolean> {
    const key = buildPendingRequestKey({ backend: params.backend, threadId: params.threadId, requestId: params.requestId });
    const notification: AppServerPendingRequestNotification = {
      method: "item/tool/requestUserInput",
      params: {
        threadId: params.threadId,
        ...(params.turnId ? { turnId: params.turnId } : {}),
        ...(params.itemId ? { itemId: params.itemId } : {}),
        requestId: params.requestId,
        questions: [{
          id: THREAD_MAINTENANCE_CONFIRM_QUESTION_ID,
          header: params.header ?? "Thread maintenance",
          question: params.question,
          isOther: false,
          isSecret: false,
          options: [
            { label: params.approveLabel ?? THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL,
              description: params.approveDescription ?? "Run exactly these changes. Each item is checked again first." },
            { label: "Cancel", description: "Change nothing." },
          ],
        }],
      },
    };
    const response = await new Promise<SubmitServerRequestRequest["response"]>((resolve, reject) => {
      this.host().pendingServerRequests.set(key, { backend: params.backend, notification, resolve, reject });
      void this.context.emit({ backend: params.backend, notification }).catch((error) => {
        backendRegistryLog.error("failed to publish thread maintenance confirmation; keeping request pending", {
          backend: params.backend, threadId: params.threadId, requestId: params.requestId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    });
    const answers = (response as AppServerToolRequestUserInputResponse)?.answers?.[THREAD_MAINTENANCE_CONFIRM_QUESTION_ID]?.answers;
    return Array.isArray(answers) && answers.length === 1
      && answers[0] === (params.approveLabel ?? THREAD_MAINTENANCE_CONFIRM_APPROVE_LABEL);
  }

  private async mergeFederatedThreadSearchResults(params: {
    args: Extract<
      PwrAgentThreadInspectionRequest,
      { operation: "search_threads" }
    >["args"];
    context: PwrAgentThreadInspectionRequest["context"];
    instanceId?: string;
    includeRemote: boolean;
    limit: number;
    localResponse: Extract<PwrAgentThreadInspectionResponse, { ok: true }>;
  }): Promise<PwrAgentThreadInspectionResponse> {
    const host = this.host();
    if (!params.includeRemote || !host.federationHandler) {
      return params.localResponse;
    }
    const localData = params.localResponse.data;
    if (!("threads" in localData)) {
      return params.localResponse;
    }

    const hasUnsupportedRemoteFilters =
      params.args.agentOnly === true
      || Boolean(nonEmptyStringArray(params.args.directoryPaths))
      || Boolean(nonEmptyStringArray(params.args.models))
      || params.args.contentMode === "required"
      || params.args.semanticMode === "required";
    if (hasUnsupportedRemoteFilters) {
      if (params.instanceId) {
        return threadInspectionFailure(
          "invalid_arguments",
          "instanceId cannot be combined with local-only Agent, directory, model, required transcript, or required semantic filters.",
        );
      }
      return params.localResponse;
    }

    const backend = readThreadInspectionBackend(params.args.backend);
    const projectKeys = nonEmptyStringArray(params.args.projectKeys);
    const response = await host.federationHandler({
      operation: "search_federation_threads",
      context: params.context,
      args: {
        query: params.args.query?.trim() ?? "",
        scope: "remote",
        ...(backend ? { backend } : {}),
        ...(params.args.includeArchived === true
          ? { includeArchived: true }
          : {}),
        ...(projectKeys ? { projectKeys } : {}),
        ...(params.args.updatedAfter !== undefined
          ? { updatedAfter: params.args.updatedAfter }
          : {}),
        ...(params.args.updatedBefore !== undefined
          ? { updatedBefore: params.args.updatedBefore }
          : {}),
        ...(params.instanceId ? { instanceId: params.instanceId } : {}),
        limit: params.limit,
      },
    });
    if (!response.ok) {
      if (params.instanceId) {
        return threadInspectionFailure(
          response.error.code === "turn_start_failed"
            ? "internal_error"
            : response.error.code,
          response.error.message,
        );
      }
      return params.localResponse;
    }
    if (!("results" in response.data)) {
      return params.localResponse;
    }

    const remoteThreads = response.data.results
      .map(
        (entry): ThreadInspectionSummary => ({
          backend: entry.backend,
          threadId: entry.threadId,
          instanceId: entry.instanceId,
          instanceLabel: entry.instanceLabel,
          threadLink: entry.threadLink,
          title: entry.title,
          updatedAt: entry.updatedAt,
          archivedAt: entry.archivedAt,
          projectKey: entry.projectKey,
          linkedDirectories: [],
          score: entry.score,
        }),
      );
    const localThreads = normalizeThreadInspectionSearchRanks(
      params.instanceId ? [] : localData.threads,
    );
    const normalizedRemoteThreads = normalizeThreadInspectionSearchRanks(
      remoteThreads,
    );
    const threads = [...localThreads, ...normalizedRemoteThreads]
      .sort(
        (left, right) =>
          (right.score ?? 0) - (left.score ?? 0)
          || (right.updatedAt ?? right.createdAt ?? 0)
            - (left.updatedAt ?? left.createdAt ?? 0),
      );
    const totalCount = (params.instanceId ? 0 : localData.totalCount)
      + response.data.totalCount;
    return {
      ok: true,
      data: {
        ...localData,
        threads: threads.slice(0, params.limit),
        totalCount,
        truncated:
          localData.truncated
          || response.data.truncated
          || totalCount > params.limit,
        searchedInstances: response.data.searchedInstances,
        federationFailures: response.data.failures,
      },
    };
  }

  /**
   * Agents usually register dependencies from ids alone. Save each
   * prerequisite's current title so the operator's rail and the continuation
   * prompt name it. Best effort: an unknown thread keeps its id.
   */
  private async withDependencyTitles<T>(conditions: T[]): Promise<T[]> {
    type Untitled = { backend: AppServerBackendKind; threadId: string };
    const untitled = (condition: unknown): condition is Untitled =>
      Boolean(condition) && typeof condition === "object"
      && typeof (condition as { backend?: unknown }).backend === "string"
      && typeof (condition as { threadId?: unknown }).threadId === "string"
      && (condition as { title?: unknown }).title === undefined
      // A peer's thread or "something else" is not in this machine's list.
      && (condition as { subject?: unknown }).subject === undefined
      && (condition as { target?: unknown }).target === undefined;
    const missing = (conditions as unknown[]).filter(untitled);
    if (missing.length === 0) return conditions;
    const titles = new Map<string, string>();
    for (const backend of new Set(missing.map((condition) => condition.backend))) {
      try {
        const wanted = new Set(missing.filter((condition) => condition.backend === backend).map((condition) => condition.threadId));
        for (const thread of await this.host().listThreads({ backend, archived: false, callerReason: "thread-dependency-titles" })) {
          if (wanted.has(thread.id) && thread.title.trim()) titles.set(JSON.stringify([backend, thread.id]), thread.title.trim().slice(0, 200));
        }
      } catch {
        // Titles are display-only; registration validates the thread itself.
      }
    }
    return conditions.map((condition) => {
      if (!untitled(condition)) return condition;
      const title = titles.get(JSON.stringify([condition.backend, condition.threadId]));
      return title ? { ...condition, title } : condition;
    });
  }

  private async handleGetThreadStatusInspectionRequest(
    args: GetThreadStatusToolArgs & {
      backend: AppServerBackendKind;
      threadId: string;
    },
    context: PwrAgentThreadInspectionRequest["context"],
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (!isAppServerBackendKind(args.backend)) {
      return threadInspectionFailure(
        "invalid_arguments",
        "backend must be a known PwrAgent backend.",
      );
    }
    const threadId = args.threadId.trim();
    const instanceId = args.instanceId?.trim();
    const includeRemote = args.includeRemote !== false;
    if (!threadId) {
      return threadInspectionFailure("invalid_arguments", "threadId is required.");
    }
    if (Object.hasOwn(args, "instanceId") && !instanceId) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId must be a non-empty string when provided.",
      );
    }
    if (instanceId && !includeRemote) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId cannot be used when includeRemote is false.",
      );
    }

    let localError: unknown;
    if (!instanceId) {
      try {
        const activeThreads = await this.host().listThreads({
          backend: args.backend,
          archived: false,
          callerReason: "agent-thread-inspection",
        });
        let candidateThreads = activeThreads.filter(
          (thread) => thread.id === threadId,
        );
        let archived = false;
        if (candidateThreads.length === 0) {
          archived = true;
          candidateThreads = (
            await this.host().listThreads({
              backend: args.backend,
              archived: true,
              callerReason: "agent-thread-inspection:archived",
            })
          ).filter((thread) => thread.id === threadId);
        }
        const [summary] =
          await this.enrichThreadInspectionSummaries(candidateThreads);
        if (summary) {
          const status = await this.host().readThread({
            backend: args.backend,
            includeTurns: false,
            limit: 0,
            threadId,
          })
            .then(
              (response) =>
                response.threadStatus ?? response.replay.threadStatus,
            )
            .catch((): AppServerThreadStatus | undefined => undefined);
          const queueKey = buildThreadIdentityKey(args.backend, threadId);
          const queued = this.host().getQueuedExecutionModesSnapshot()[queueKey];
          const pendingHandoffs = this.host().getPendingThreadHandoffsForInspection({
            backend: args.backend,
            sourceThreadId: threadId,
          });
          const pendingWorkspaceMoves =
            this.host().getPendingThreadWorkspaceMovesForInspection({
              backend: args.backend,
              sourceThreadId: threadId,
            });
          const prAutomation =
            await this.host().threadPrAutoDispatchHandler?.inspect?.(
              {
                backend: args.backend,
                threadId,
              },
              context,
            );
          const pendingApprovals = this.pendingApprovalsForInspection(
            args.backend,
            threadId,
            context.backend === args.backend && context.threadId === threadId,
          );
          return {
            ok: true,
            data: {
              thread: {
                ...summary,
                archived,
                status,
                queuedExecutionMode: queued?.mode,
                queuedExecutionModeAt: queued?.queuedAt,
                ...(prAutomation ? { prAutomation } : {}),
                ...(pendingApprovals.length
                  ? { pendingApprovals, pendingApprovalGuidance: PENDING_APPROVAL_GUIDANCE }
                  : {}),
                ...(pendingHandoffs.length ? { pendingHandoffs } : {}),
                ...(pendingWorkspaceMoves.length
                  ? { pendingWorkspaceMoves }
                  : {}),
              },
            },
          };
        }
      } catch (error) {
        localError = error;
      }
    }

    const host = this.host();
    if (includeRemote && host.federatedThreadInspectionHandler) {
      try {
        const remote = await host.federatedThreadInspectionHandler({
          backend: args.backend,
          threadId,
          ...(instanceId ? { instanceId } : {}),
          limit: 0,
          includeTurns: false,
        });
        if (remote) {
          const summary = remote.summary
            ? toThreadInspectionSummaryFromNavigation(remote.summary)
            : toThreadInspectionSummary(remote.thread, undefined, undefined);
          return {
            ok: true,
            data: {
              thread: {
                ...summary,
                instanceId: remote.instanceId,
                instanceLabel: remote.instanceLabel,
                ...(remote.archived !== undefined ? { archived: remote.archived } : {}),
                threadLink: buildThreadMarkdownLink({
                  backend: args.backend,
                  threadId,
                  instanceId: remote.instanceId,
                  title: summary.title,
                }),
                status:
                  remote.read.threadStatus
                  ?? remote.read.replay.threadStatus,
              },
            },
          };
        }
      } catch (error) {
        return federatedThreadInspectionFailure(error);
      }
    }

    if (localError) {
      return federatedThreadInspectionFailure(localError);
    }

    return threadInspectionFailure(
      "not_found",
      `Thread ${args.backend}:${threadId} was not found${
        includeRemote ? " locally or on a connected Federation peer" : " locally"
      }.`,
    );
  }

  async readThreadInspectionSummaryForMutation(params: {
    backend: AppServerBackendKind;
    threadId: string;
    /** Bypass the list cache, for a change computed from `updatedAt`. */
    fresh?: boolean;
  }): Promise<ThreadInspectionSummary | undefined> {
    const activeThreads = await this.host().listThreads({
      backend: params.backend,
      archived: false,
      callerReason: "agent-thread-inspection",
      ...(params.fresh ? { forceRefresh: true } : {}),
    });
    let candidateThreads = activeThreads.filter(
      (thread) => thread.id === params.threadId,
    );
    let archived = false;
    if (candidateThreads.length === 0) {
      archived = true;
      candidateThreads = (
        await this.host().listThreads({
          backend: params.backend,
          archived: true,
          callerReason: "agent-thread-inspection:archived",
        })
      ).filter((thread) => thread.id === params.threadId);
    }
    const [summary] = await this.enrichThreadInspectionSummaries(candidateThreads);
    return summary ? { ...summary, archived } : undefined;
  }

  /**
   * Why `mutate_thread` would refuse a parent change, checked before anything
   * changes and on a dry run too. No `parent` means a detach.
   */
  private async checkThreadParentChange(params: {
    backend: AppServerBackendKind;
    threadId: string;
    threadLabel: string;
    parent?: { backend: AppServerBackendKind; threadId: string };
  }): Promise<PwrAgentThreadInspectionResponse | undefined> {
    if (!this.host().agentThreadActions?.setThreadParent) {
      return threadInspectionFailure(
        "internal_error",
        "Thread grouping is not available in this process.",
      );
    }
    if (!params.parent) {
      const overlay = await this.context.stores.threads.getThreadOverlayState({
        backend: params.backend,
        threadId: params.threadId,
      });
      return overlay?.parentThreadId?.trim()
        ? undefined
        : threadInspectionFailure(
            "invalid_arguments",
            `${params.threadLabel} is not a sub-thread.`,
          );
    }
    const parent = params.parent;
    const parentLabel = `Parent thread ${parent.backend}:${parent.threadId}`;
    // Only existence and archive state matter here, so the provider's own
    // lists answer it without an inspection summary's enrichment. A list
    // that fails is reported as such, not as a missing parent.
    let archived: boolean;
    try {
      const listed = async (archivedList: boolean) => (await this.host().listThreads({
        backend: parent.backend,
        archived: archivedList,
        callerReason: archivedList ? "agent-thread-parent:archived" : "agent-thread-parent",
      })).some((thread) => thread.id === parent.threadId);
      if (await listed(false)) {
        archived = false;
      } else if (await listed(true)) {
        archived = true;
      } else {
        return threadInspectionFailure(
          "not_found",
          `${parentLabel} was not found on this instance.`,
        );
      }
    } catch (error) {
      return federatedThreadInspectionFailure(error);
    }
    // An archived parent cannot own a live tray row.
    if (archived) {
      return threadInspectionFailure(
        "invalid_arguments",
        `${parentLabel} is archived.`,
      );
    }
    // The same walk the store repeats inside its write.
    const threadKey = buildThreadIdentityKey(params.backend, params.threadId);
    const seen = new Set<string>();
    let cursor: { backend: AppServerBackendKind; threadId: string } | undefined = params.parent;
    while (cursor && seen.size < MAX_THREAD_PARENT_CHECK_DEPTH) {
      const key = buildThreadIdentityKey(cursor.backend, cursor.threadId);
      if (key === threadKey) {
        return threadInspectionFailure(
          "invalid_arguments",
          `${parentLabel} is a sub-thread of ${params.threadLabel}. A thread cannot become a sub-thread of its own sub-thread.`,
        );
      }
      if (seen.has(key)) break;
      seen.add(key);
      const overlay = await this.context.stores.threads.getThreadOverlayState(cursor);
      const nextId = overlay?.parentThreadId?.trim();
      cursor = nextId && !overlay!.parentThreadInstanceId
        ? { backend: overlay!.parentThreadBackend ?? cursor.backend, threadId: nextId }
        : undefined;
    }
    return undefined;
  }

  async mutateThreadParentV1(
    request: MutateThreadParentV1Request,
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (typeof request.dryRun !== "boolean") {
      return threadInspectionFailure("invalid_arguments", "dryRun must be a boolean.");
    }
    // Whitelist the versioned fields: an inbound peer cannot forward another
    // mutation or a routing hint through this grouping-only method.
    return await this.handleMutateThreadInspectionRequest({
      backend: request.backend,
      threadId: request.threadId,
      ...(Object.hasOwn(request, "parentThreadId") ? { parentThreadId: request.parentThreadId } : {}),
      ...(Object.hasOwn(request, "parentBackend") ? { parentBackend: request.parentBackend } : {}),
      ...(Object.hasOwn(request, "detachFromParent") ? { detachFromParent: request.detachFromParent } : {}),
      dryRun: request.dryRun,
      includeRemote: false,
    });
  }

  private async handleMutateThreadInspectionRequest(
    args: MutateThreadToolArgs,
    context?: PwrAgentThreadInspectionRequest["context"],
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (!isAppServerBackendKind(args.backend)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "backend must be a known PwrAgent backend.",
        },
      };
    }
    const threadId = args.threadId?.trim();
    if (!threadId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "threadId is required.",
        },
      };
    }
    const instanceId = args.instanceId?.trim();
    const includeRemote = args.includeRemote !== false;
    if (Object.hasOwn(args, "instanceId") && !instanceId) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId must be a non-empty string when provided.",
      );
    }
    if (instanceId && !includeRemote) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId cannot be used when includeRemote is false.",
      );
    }

    const dryRun = args.dryRun === true;

    let title: string | undefined;
    if (Object.hasOwn(args, "title")) {
      if (typeof args.title !== "string" || !args.title.trim()) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "title must be a non-empty string when provided.",
          },
        };
      }
      title = args.title.trim();
    }

    const modelSettings = readThreadMutationModelSettings(args);
    if (modelSettings.error) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: modelSettings.error,
        },
      };
    }

    let executionMode: ThreadExecutionMode | undefined;
    if (Object.hasOwn(args, "executionMode")) {
      if (!isThreadExecutionMode(args.executionMode)) {
        return {
          ok: false,
          error: {
            code: "invalid_arguments",
            message: "executionMode must be default, auto, or full-access when provided.",
          },
        };
      }
      executionMode = args.executionMode;
      // The same ceiling for the caller's own thread, another local thread,
      // and a peer's: checked here, before the owner is resolved. Without a
      // calling thread there is no access to keep, so nothing above Default.
      const accessRefusal = checkAgentAccessRequest(
        context
          ? await this.host().resolveAgentCallerExecutionMode(context)
          : "default",
        { executionMode },
      );
      if (accessRefusal) {
        return threadInspectionFailure(accessRefusal.code, accessRefusal.message);
      }
    }

    let projectPath: string | undefined;
    if (Object.hasOwn(args, "projectPath")) {
      if (typeof args.projectPath !== "string" || !args.projectPath.trim()) {
        return threadInspectionFailure(
          "invalid_arguments",
          "projectPath must be a non-empty string when provided.",
        );
      }
      projectPath = args.projectPath.trim();
    }

    for (const field of ["archive", "pinned", "unread", "locked"] as const) {
      if (Object.hasOwn(args, field) && typeof args[field] !== "boolean") {
        return threadInspectionFailure(
          "invalid_arguments",
          field === "archive"
            ? "archive must be true to archive the thread or false to restore it."
            : `${field} must be a boolean when provided.`,
        );
      }
    }
    const archive = args.archive;
    const pinned = args.pinned;
    const unread = args.unread;
    const lockNoteProvided = Object.hasOwn(args, "lockNote");
    if (lockNoteProvided && typeof args.lockNote !== "string") {
      return threadInspectionFailure(
        "invalid_arguments",
        "lockNote must be a string when provided.",
      );
    }
    if (lockNoteProvided && args.locked === false) {
      return threadInspectionFailure(
        "invalid_arguments",
        "lockNote cannot be combined with locked false. Unlocking drops the note.",
      );
    }
    const lockNote = lockNoteProvided ? normalizeThreadLockNote(args.lockNote) ?? "" : undefined;
    const locked = args.locked ?? (lockNoteProvided ? true : undefined);

    let parentThreadId: string | undefined;
    if (Object.hasOwn(args, "parentThreadId")) {
      if (typeof args.parentThreadId !== "string" || !args.parentThreadId.trim()) {
        return threadInspectionFailure(
          "invalid_arguments",
          "parentThreadId must be a non-empty string when provided.",
        );
      }
      parentThreadId = args.parentThreadId.trim();
    }
    if (Object.hasOwn(args, "parentBackend")) {
      if (typeof args.parentBackend !== "string" || !isAppServerBackendKind(args.parentBackend)) {
        return threadInspectionFailure(
          "invalid_arguments",
          "parentBackend must be a known PwrAgent backend when provided.",
        );
      }
      if (parentThreadId === undefined) {
        return threadInspectionFailure(
          "invalid_arguments",
          "parentBackend requires parentThreadId.",
        );
      }
    }
    if (Object.hasOwn(args, "detachFromParent") && typeof args.detachFromParent !== "boolean") {
      return threadInspectionFailure(
        "invalid_arguments",
        "detachFromParent must be a boolean when provided.",
      );
    }
    const detachFromParent = args.detachFromParent === true;
    const parentBackend = parentThreadId !== undefined
      ? args.parentBackend ?? args.backend
      : undefined;
    if (parentThreadId !== undefined && detachFromParent) {
      return threadInspectionFailure(
        "invalid_arguments",
        "detachFromParent cannot be combined with parentThreadId.",
      );
    }
    if (parentThreadId === threadId && parentBackend === args.backend) {
      return threadInspectionFailure(
        "invalid_arguments",
        "A thread cannot be its own parent.",
      );
    }
    // A sub-thread carries no pin: the parent change clears it.
    if (parentThreadId !== undefined && pinned === true) {
      return threadInspectionFailure(
        "invalid_arguments",
        "pinned true cannot be combined with parentThreadId. A sub-thread is not pinned.",
      );
    }
    const parentChange = parentThreadId !== undefined || detachFromParent;

    const changes: ThreadMutationAppliedChange[] = [];
    if (title !== undefined) {
      changes.push({
        field: "title",
        status: dryRun ? "would_apply" : "applied",
        to: title,
      });
    }
    if (modelSettings.value) {
      changes.push({
        field: "model_settings",
        status: dryRun ? "would_apply" : "applied",
        to: modelSettings.value,
      });
    }
    if (executionMode !== undefined) {
      changes.push({
        field: "execution_mode",
        status: dryRun ? "would_apply" : "applied",
        to: executionMode,
      });
    }
    if (projectPath !== undefined) {
      changes.push({
        field: "project",
        status: dryRun ? "would_apply" : "applied",
        to: projectPath,
      });
    }
    if (archive !== undefined) {
      changes.push({
        field: "archive",
        status: dryRun ? "would_apply" : "applied",
        to: archive,
      });
    }
    if (pinned !== undefined) {
      changes.push({
        field: "pinned",
        status: dryRun ? "would_apply" : "applied",
        to: pinned,
      });
    }
    if (unread !== undefined) {
      changes.push({
        field: "unread",
        status: dryRun ? "would_apply" : "applied",
        to: unread,
      });
    }
    if (locked !== undefined) {
      changes.push({
        field: "locked",
        status: dryRun ? "would_apply" : "applied",
        to: locked,
      });
    }
    if (lockNote !== undefined) {
      changes.push({
        field: "lock_note",
        status: dryRun ? "would_apply" : "applied",
        to: lockNote,
      });
    }
    if (parentChange) {
      changes.push({
        field: "parent",
        status: dryRun ? "would_apply" : "applied",
        to: parentThreadId !== undefined
          ? { backend: parentBackend, threadId: parentThreadId }
          : null,
      });
    }

    if (changes.length === 0) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message:
            "At least one mutation field is required: title, model, serviceTier, reasoningEffort, fastMode, executionMode, projectPath, archive, pinned, unread, locked, lockNote, parentThreadId, or detachFromParent.",
        },
      };
    }
    if (archive !== undefined && changes.length > 1) {
      return threadInspectionFailure(
        "invalid_arguments",
        "archive cannot be combined with other changes. Archive or restore the thread in a call of its own.",
      );
    }
    // The turn making this call runs in the invoking thread. Archiving it or
    // relinking its workspace would pull that thread out from under the turn
    // that still has to report the result.
    if (
      (archive === true || projectPath !== undefined)
      && context
      && !instanceId
      && args.backend === context.backend
      && threadId === context.threadId
    ) {
      return threadInspectionFailure(
        "forbidden",
        "mutate_thread cannot archive or move the thread running this turn.",
      );
    }

    let localError: unknown;
    let localSummary: ThreadInspectionSummary | undefined;
    if (!instanceId) {
      try {
        localSummary = await this.readThreadInspectionSummaryForMutation({
          backend: args.backend,
          threadId,
          // The seen watermark is the thread's last update: one read from a
          // cached list lands behind a newer update and leaves it unread.
          fresh: unread !== undefined,
        });
      } catch (error) {
        localError = error;
      }
    }
    const localOverlay = !instanceId && !localSummary
      ? await this.context.stores.threads.getThreadOverlayState({
          backend: args.backend,
          threadId,
        })
      : undefined;
    const mutateLocally = Boolean(localSummary || localOverlay);
    let remoteOwner:
      | { instanceId: string; instanceLabel: string }
      | undefined;
    if (!mutateLocally && includeRemote && this.federatedThreadMutationHandler) {
      if (parentChange && context) {
        // An omitted instanceId can still resolve to a peer. Recheck scope
        // with the trusted invoking turn before the handler can mutate it.
        const denied = await this.host().dynamicToolPermissionDenied(context.backend, "thread_inspection", {
          threadId: context.threadId,
          turnId: context.turnId,
          tool: "mutate_thread",
          arguments: { ...args, includeRemote: true },
        });
        if (denied) return threadInspectionFailure("forbidden", `Missing permission: ${denied}.`);
      }
      try {
        remoteOwner = await this.federatedThreadMutationHandler({
          backend: args.backend,
          threadId,
          ...(instanceId ? { instanceId } : {}),
          ...(title !== undefined ? { title } : {}),
          ...(modelSettings.value ? { modelSettings: modelSettings.value } : {}),
          ...(executionMode !== undefined ? { executionMode } : {}),
          ...(projectPath !== undefined ? { projectPath } : {}),
          ...(archive !== undefined ? { archive } : {}),
          ...(pinned !== undefined ? { pinned } : {}),
          ...(unread !== undefined ? { unread } : {}),
          ...(locked !== undefined ? { locked } : {}),
          ...(lockNote !== undefined ? { lockNote } : {}),
          ...(parentThreadId !== undefined ? { parentThreadId, parentBackend } : {}),
          ...(detachFromParent ? { detachFromParent: true } : {}),
          dryRun,
        });
      } catch (error) {
        return federatedThreadInspectionFailure(error);
      }
    }
    if (!mutateLocally && !remoteOwner) {
      if (localError) {
        return federatedThreadInspectionFailure(localError);
      }
      return threadInspectionFailure(
        "not_found",
        `Thread ${args.backend}:${threadId} was not found${
          includeRemote ? " locally or on a connected Federation peer" : " locally"
        }.`,
      );
    }

    // Everything below is checked before anything changes, and on a dry run
    // too, so a preview tells the Agent what the real call would say.
    const threadLabel = `Thread ${args.backend}:${threadId}`;
    if (mutateLocally) {
      // Known only when the backend listed the thread; an overlay-only hit
      // leaves the question to the archive call itself.
      const archived = localSummary?.archived;
      if (archive === true && archived === true) {
        return threadInspectionFailure(
          "invalid_arguments",
          `${threadLabel} is already archived.`,
        );
      }
      if (archive === false && archived === false) {
        return threadInspectionFailure(
          "invalid_arguments",
          `${threadLabel} is not archived.`,
        );
      }
      // Archiving a thread mid-turn orphans the turn: the provider keeps
      // running work nothing will show.
      if (archive === true && this.host().threadHasActiveTurn(threadId, args.backend)) {
        return threadInspectionFailure(
          "forbidden",
          `${threadLabel} has a turn running. Stop it with stop_thread before archiving it.`,
        );
      }
      // Unread is a seen watermark behind the thread's last update, and a
      // thread with no update time has nothing to put it behind.
      if (unread === true && localSummary?.updatedAt === undefined) {
        return threadInspectionFailure(
          "invalid_arguments",
          `${threadLabel} has no update time to mark unread against.`,
        );
      }
      if (
        (pinned !== undefined || unread !== undefined)
        && !this.host().agentThreadActions
      ) {
        return threadInspectionFailure(
          "internal_error",
          "Pinning and read state are not available in this process.",
        );
      }
      if (parentChange) {
        const refusal = await this.checkThreadParentChange({
          backend: args.backend,
          threadId,
          threadLabel,
          parent: parentThreadId !== undefined
            ? { backend: parentBackend!, threadId: parentThreadId }
            : undefined,
        });
        if (refusal) return refusal;
      }
    }

    if (mutateLocally && archive !== undefined && !dryRun) {
      try {
        if (archive) {
          const archiveThread = this.host().agentThreadActions?.archiveThread
            ?? (async (request: ArchiveThreadRequest) =>
              await this.host().archiveThread(request));
          await archiveThread({ backend: args.backend, threadId });
        } else {
          await this.host().restoreThread({ backend: args.backend, threadId });
        }
      } catch (error) {
        return federatedThreadInspectionFailure(error);
      }
    }

    // The parent lands first. The store repeats the loop check inside its
    // write, so a link made since the check above is refused before
    // anything else here has changed.
    if (mutateLocally && parentChange && !dryRun) {
      try {
        await this.host().agentThreadActions!.setThreadParent!({
          backend: args.backend,
          threadId,
          parentThreadId: parentThreadId ?? null,
          parentThreadBackend: parentBackend ?? null,
        });
      } catch (error) {
        return threadInspectionFailure(
          "invalid_arguments",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    // An unlock lands before the move, which a lock refuses; a lock lands
    // last, after the move it would otherwise refuse. A refused move puts
    // the unlocked lock back as it was.
    // The queue the lock held resumes only after the move: a message started
    // in between would run in the old workspace and refuse the move.
    const unlockedLock = mutateLocally && locked === false && !dryRun
      ? (await this.host().setThreadLock({
          backend: args.backend,
          threadId,
          locked: false,
        }, { source: "agent_tool" }, { resumeQueue: false })).previousLock
      : undefined;

    // First, and before anything else changes: the destination is checked on
    // disk, and a move that fails should leave the title and settings as
    // they were rather than half the request applied.
    if (mutateLocally && projectPath !== undefined && !dryRun) {
      try {
        await this.host().handoffThreadWorkspace({
          backend: args.backend,
          threadId,
          direction: "to-project",
          targetPath: projectPath,
        });
      } catch (error) {
        if (unlockedLock) {
          await this.host().writeThreadLock({ backend: args.backend, threadId }, unlockedLock);
        }
        const message = error instanceof Error ? error.message : String(error);
        return threadInspectionFailure(
          message === ACTIVE_TURN_HANDOFF_ERROR ? "forbidden" : "invalid_arguments",
          message,
        );
      }
    }
    if (unlockedLock) {
      await this.host().threadTurnQueue.releaseHold({ backend: args.backend, threadId }, isThreadLockRefusal);
    }

    if (mutateLocally && title !== undefined && !dryRun) {
      await this.host().renameThread({
        backend: args.backend,
        threadId,
        name: title,
      }, {
        renameOrigin: "agent_tool",
      });
    }

    if (mutateLocally && modelSettings.value && !dryRun) {
      await this.host().setThreadModelSettings({
        backend: args.backend,
        threadId,
        ...modelSettings.value,
      });
    }

    if (mutateLocally && executionMode !== undefined && !dryRun) {
      await this.host().setThreadExecutionMode({
        backend: args.backend,
        threadId,
        executionMode,
      });
    }

    if (mutateLocally && pinned !== undefined && !dryRun) {
      await this.host().agentThreadActions?.setThreadPin({
        backend: args.backend,
        threadId,
        pinned,
      });
    }

    if (mutateLocally && unread !== undefined && !dryRun) {
      await this.host().agentThreadActions?.markThreadSeen({
        backend: args.backend,
        threadId,
        ...threadSeenWatermark(localSummary?.updatedAt, unread),
      });
    }

    if (mutateLocally && locked === true && !dryRun) {
      await this.host().setThreadLock({
        backend: args.backend,
        threadId,
        locked: true,
        ...(lockNote !== undefined ? { note: lockNote } : {}),
      }, { source: "agent_tool" });
    }

    return {
      ok: true,
      data: {
        mutation: {
          backend: args.backend,
          threadId,
          ...(remoteOwner ?? {}),
          dryRun,
          changes,
        },
      },
    };
  }

  private async handleReadThreadInspectionRequest(
    args: ReadThreadToolArgs,
  ): Promise<PwrAgentThreadInspectionResponse> {
    if (!isAppServerBackendKind(args.backend)) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "backend must be a known PwrAgent backend.",
        },
      };
    }
    const threadId = args.threadId?.trim();
    if (!threadId) {
      return {
        ok: false,
        error: {
          code: "invalid_arguments",
          message: "threadId is required.",
        },
      };
    }
    const instanceId = args.instanceId?.trim();
    const includeRemote = args.includeRemote !== false;
    if (Object.hasOwn(args, "instanceId") && !instanceId) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId must be a non-empty string when provided.",
      );
    }
    if (instanceId && !includeRemote) {
      return threadInspectionFailure(
        "invalid_arguments",
        "instanceId cannot be used when includeRemote is false.",
      );
    }
    const before = args.before?.trim();
    const limit = clampInteger(
      args.limit,
      DEFAULT_THREAD_INSPECTION_READ_LIMIT,
      MAX_THREAD_INSPECTION_READ_LIMIT,
    );
    const maxCharsPerEntry = clampInteger(
      args.maxCharsPerEntry,
      DEFAULT_THREAD_INSPECTION_READ_ENTRY_CHARS,
      MAX_THREAD_INSPECTION_READ_ENTRY_CHARS,
    );

    let response: AppServerReadThreadResponse | undefined;
    let remote: PwrAgentFederatedThreadInspectionResult | undefined;
    let localError: unknown;
    if (!instanceId) {
      try {
        response = await this.host().readThread({
          backend: args.backend,
          threadId,
          includeTurns: true,
          ...(before ? { before } : {}),
          limit,
        });
      } catch (error) {
        localError = error;
      }
    }
    const host = this.host();
    if (!response && includeRemote && host.federatedThreadInspectionHandler) {
      try {
        remote = await host.federatedThreadInspectionHandler({
          backend: args.backend,
          threadId,
          ...(instanceId ? { instanceId } : {}),
          ...(before ? { before } : {}),
          limit,
          includeTurns: true,
        });
        response = remote?.read;
      } catch (error) {
        return federatedThreadInspectionFailure(error);
      }
    }
    if (!response) {
      if (localError) {
        const message =
          localError instanceof Error ? localError.message : String(localError);
        return threadInspectionFailure(
          /not found/i.test(message) ? "not_found" : "internal_error",
          message,
        );
      }
      return threadInspectionFailure(
        "not_found",
        `Thread ${args.backend}:${threadId} was not found${
          includeRemote ? " locally or on a connected Federation peer" : " locally"
        }.`,
      );
    }

    try {
      const replay = response.replay;
      const status = response.threadStatus ?? replay.threadStatus;
      const title = remote?.summary?.title ?? remote?.thread.title;
      const threadLinkRef = {
        backend: args.backend,
        threadId,
        ...(remote ? { instanceId: remote.instanceId } : {}),
      };
      return {
        ok: true,
        data: {
          read: {
            backend: args.backend,
            threadId,
            ...(response.tokenMiserEnabled !== undefined
              ? { tokenMiserEnabled: response.tokenMiserEnabled }
              : {}),
            ...(remote
              ? {
                  instanceId: remote.instanceId,
                  instanceLabel: remote.instanceLabel,
                }
              : {}),
            ...(title ? { title } : {}),
            threadUrl: buildThreadUrl(threadLinkRef),
            threadLink: buildThreadMarkdownLink({
              ...threadLinkRef,
              title,
            }),
            limit,
            ...(before ? { before } : {}),
            maxCharsPerEntry,
            ...(args.includeEntries === false
              ? {}
              : {
                  // Owners page whole turns, so a page can hold more than
                  // `limit` entries. Keep its newest ones; clampInteger
                  // keeps `limit` at 1 or more.
                  entries: replay.entries
                    .slice(-limit)
                    .map((entry) =>
                      toThreadReadEntrySummary(
                        entry,
                        maxCharsPerEntry,
                        threadLinkRef,
                        title,
                      ),
                    ),
                }),
            ...(args.includeMessages === false
              ? {}
              : {
                  messages: replay.messages
                    .slice(-limit)
                    .map((message) =>
                      toThreadReadMessageSummary(
                        message,
                        maxCharsPerEntry,
                        threadLinkRef,
                        title,
                      ),
                    ),
                }),
            ...(args.includeEntries !== false && replay.entries.length > limit
              ? { omittedEntries: replay.entries.length - limit }
              : {}),
            ...(args.includeMessages !== false && replay.messages.length > limit
              ? { omittedMessages: replay.messages.length - limit }
              : {}),
            ...(replay.lastUserMessage
              ? {
                  lastUserMessage: truncateThreadInspectionText(
                    replay.lastUserMessage,
                    maxCharsPerEntry,
                  ),
                }
              : {}),
            ...(replay.lastAssistantMessage
              ? {
                  lastAssistantMessage: truncateThreadInspectionText(
                    replay.lastAssistantMessage,
                    maxCharsPerEntry,
                  ),
                }
              : {}),
            pagination: replay.pagination,
            ...(args.includeStatus === false
              ? {}
              : status
                ? { status }
                : {}),
            ...(args.includeEvaluation
              ? {
                  evaluation: {
                    ...(response.tokenMiserEnabled !== undefined
                      ? {
                          tokenMiserEnabled: response.tokenMiserEnabled,
                        }
                      : {}),
                    ...(response.tokenMiserOverride !== undefined
                      ? { tokenMiserOverride: response.tokenMiserOverride }
                      : {}),
                    ...(response.pricing
                      ? {
                          pricing: toThreadReadEvaluationPricing(
                            response.pricing,
                          ),
                        }
                      : {}),
                    ...(response.toolAccounting?.tokenMiser
                      ? {
                          tokenMiser: toThreadReadEvaluationTokenMiser(
                            response.toolAccounting.tokenMiser,
                          ),
                        }
                      : {}),
                  },
                }
              : {}),
          },
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        error: {
          code: /not found/i.test(message) ? "not_found" : "internal_error",
          message,
        },
      };
    }
  }

  private getThreadInspectionSearchService(): ThreadSearchService | null {
    if (this.threadInspectionSearchService !== undefined) {
      return this.threadInspectionSearchService;
    }
    this.threadInspectionSearchService = new ThreadSearchService(
      createThreadSearchStorage(),
      async ({ backend, archived }) =>
        await this.host().listThreads({
          backend,
          archived,
          callerReason: "agent-thread-inspection-search",
          enrichDirectories: false,
        }),
      new ProviderTranscriptThreadSearchAdapter(
        async ({ backend, threadId, limit }) =>
          await this.host().readThread({
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
        const overlay = await this.context.stores.threads.getThreadOverlayState({
          backend: result.backend,
          threadId: result.threadId,
        });
        const messagingBindings = await this.getThreadInspectionMessagingBindings({
          backend: result.backend,
          threadId: result.threadId,
        });
        return toThreadInspectionSummaryFromSearchResult(
          result,
          await this.forgeToolBridge.projectCanonicalPullRequests(overlay),
          messagingBindings,
        );
      }),
    );
  }

  private async enrichThreadInspectionSummaries(
    threads: AppServerThreadSummary[],
  ): Promise<ThreadInspectionSummary[]> {
    return await Promise.all(
      threads.map(async (thread) => {
        const overlay = await this.context.stores.threads.getThreadOverlayState({
          backend: thread.source,
          threadId: thread.id,
        });
        const messagingBindings = await this.getThreadInspectionMessagingBindings({
          backend: thread.source,
          threadId: thread.id,
        });
        const worktreePath = thread.projectKey?.trim();
        const gitWorkingState =
          thread.gitWorkingState ??
          (worktreePath
            ? await this.host().gitWorkingStateService.readWorkingState(worktreePath).catch(
                () => undefined,
              )
            : undefined);
        return toThreadInspectionSummary(
          gitWorkingState ? { ...thread, gitWorkingState } : thread,
          await this.forgeToolBridge.projectCanonicalPullRequests(overlay),
          messagingBindings,
        );
      }),
    );
  }

  async getThreadInspectionMessagingBindings(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<MessagingThreadBindingSummary[] | undefined> {
    const store = this.resolveMessagingInspectionStore();
    if (!store) {
      return undefined;
    }
    try {
      const bindings = await store.findActiveBindingsForThread(params);
      if (bindings.length === 0) {
        return undefined;
      }
      // Chip order: creation, then id, as the sidebar and detail show it.
      return [...bindings].sort(compareBindingsByCreation).map(toMessagingThreadBindingSummary);
    } catch (error) {
      backendRegistryLog.warn("failed to resolve thread inspection messaging bindings", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
      return undefined;
    }
  }

  private resolveMessagingInspectionStore(): Pick<
    MessagingStoreLike,
    "findActiveBindingsForThread"
  > | undefined {
    const host = this.host();
    if (host.messagingStore === null) {
      return undefined;
    }
    if (host.messagingStore) {
      return host.messagingStore;
    }

    try {
      return getDesktopMessagingStore();
    } catch (error) {
      backendRegistryLog.debug("messaging store unavailable for thread inspection", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}
