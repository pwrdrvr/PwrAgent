import type { RegistryContext } from "./registry-context";
import type { ThreadUsageLedger } from "./thread-usage-ledger";
import type { ThreadArchiveCoordinator } from "./thread-archive-coordinator";
import type { ThreadWorkspaceService } from "./thread-workspace-service";
import { ThreadTurnStartLifecycle } from "@pwragent/owner-core/thread-turn-start-lifecycle";
import type {
  ListBackgroundTerminalsRequest,
  ListBackgroundTerminalsResponse,
  TerminateBackgroundTerminalRequest,
  TerminateBackgroundTerminalResponse,
  CodexBackgroundTerminal,
} from "@pwragent/shared";
import { withCodexRequestActivity } from "../codex-app-server/request-activity";
import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type AppServerNotification,
  type AppServerThreadMessageOrigin,
  type AppServerTurnInputItem,
  type AppServerBackendKind,
  type AppServerCollaborationModeRequest,
  type CodexAppServerRestartResult,
  type CodexAppServerRestartStatus,
  type ThreadCodexInvalidIdRecovery,
  type ThreadExecutionMode,
  buildThreadIdentityKey,
} from "@pwragent/shared";
import {
  type CodexServerCapabilities,
} from "../codex-app-server/desktop-client";
import {
  codexAppServerRecycleCheckIntervalMs,
  type CodexAppServerProcessSample,
  type CodexAppServerRecycleSettings,
  type CodexAppServerRecycleStatus,
} from "../codex-app-server/app-server-recycle-policy";
import { isCodexInvalidResponseMessageIdError } from "../codex-app-server/invalid-response-message-id-recovery";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { getMainLogger } from "../log";
import {
  ThreadTurnQueue,
  type ThreadTurnQueueEntry,
  type ThreadTurnQueueOrigin,
} from "@pwragent/owner-core/thread-turn-queue";
import {
  backgroundTerminalMembership,
  errorMessageFromTerminalNotification,
  readNotificationItemType,
  readStatusType,
  turnIdFromTerminalNotification,
} from "./backend-registry-notifications";
import {
  type BackendClient,
  type CodexRetryableCompaction,
  type CodexRetryableOperation,
  type LiveCodexToolItem,
  type PendingCodexInvalidIdRecovery,
} from "./backend-registry-types";
import {
  CODEX_THREAD_IDLE_UNSUBSCRIBE_CHECK_INTERVAL_MS,
  buildCodexInvalidIdRecoveryCooldownMessage,
  isCodexInvalidIdRecoveryCooldownActive,
} from "./backend-registry-runtime-helpers";
import {
  resolveThreadMessageOrigin,
} from "./thread-transcript-helpers";
import {
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";
import type { RegistryHost } from "./registry-context";
import type { RegistryHostPorts } from "./registry-host-ports";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

export interface CodexRuntimeSupervisorDependencies {
  readonly threadUsageLedger: ThreadUsageLedger;
  readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  readonly threadWorkspaceService: ThreadWorkspaceService;
  readonly resolveCodexAppServerRecycleSettingsFn: () => CodexAppServerRecycleSettings;
  readonly codexThreadIdleUnsubscribeMs: number;
  readonly markManagedCodexRuntimeSwitchCompleteFn: () => void;
}

/** Runtime operations outside the activity owner, read lazily at call time. */
export interface CodexRuntimeSupervisorHost extends Pick<RegistryHostPorts,
  "liveSubAgentMonitorIds"
  | "prepareTokenMiserRuntime"
  | "threadHasActiveTurn"
  | "withCodexThreadClient"
> {
  compactThreadNow(params: {
    backend: "codex";
    threadId: string;
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{
    backend: "codex";
    threadId: string;
    turnId: string;
    itemId?: string;
  }>;
  hasActiveCodexWork(): boolean;
  listActiveCodexWorkThreadIds(): string[];
  readonly nativeVoiceLeases: number;
  readonly resolveTokenMiserEnabledFn: () => boolean;
  readonly shutdownRequested: boolean;
  startTurnNow(params: {
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
    messageOrigin?: AppServerThreadMessageOrigin;
    agentMessageOrigins?: AppServerThreadMessageOrigin[];
    agentMessages?: ThreadTurnQueueEntry["agentMessages"];
    invalidIdRecoveryAttempted?: boolean;
  }): Promise<{ backend: AppServerBackendKind; threadId: string; turnId: string }>;
  threadHasActiveCodexReviewTurn(threadId: string): boolean;
  readonly threadStarts: ThreadTurnStartLifecycle;
  readonly threadTurnQueue: ThreadTurnQueue;
  tokenMiserCodeModeGroupingVersion?: number;
  tokenMiserPostToolUseExactOutputVersion?: number;
  tokenMiserReducerCapabilityState?: "supported" | "unsupported";
  tokenMiserRuntimePreparationFailure?: string;
  readonly tokenMiserServerCapabilities: WeakMap<BackendClient, Promise<CodexServerCapabilities | undefined>>;
  readonly tokenMiserStore?: TokenMiserStore;
}

/** Codex process restarts, invalid-ID recovery and background process lifecycle. */
export class CodexRuntimeSupervisor {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<CodexRuntimeSupervisorHost>;
  private readonly threadUsageLedger: ThreadUsageLedger;
  private readonly threadArchiveCoordinator: ThreadArchiveCoordinator;
  private readonly threadWorkspaceService: ThreadWorkspaceService;

  constructor(
    context: RegistryContext,
    dependencies: CodexRuntimeSupervisorDependencies,
    host: RegistryHost<CodexRuntimeSupervisorHost>,
  ) {
    this.context = context;
    this.host = host;
    this.threadUsageLedger = dependencies.threadUsageLedger;
    this.threadArchiveCoordinator = dependencies.threadArchiveCoordinator;
    this.threadWorkspaceService = dependencies.threadWorkspaceService;
    this.resolveCodexAppServerRecycleSettingsFn = dependencies.resolveCodexAppServerRecycleSettingsFn;
    this.codexThreadIdleUnsubscribeMs = dependencies.codexThreadIdleUnsubscribeMs;
    this.markManagedCodexRuntimeSwitchCompleteFn = dependencies.markManagedCodexRuntimeSwitchCompleteFn;
  }

  get runtimeRestartPending(): boolean { return this.codexRuntimeRestartPending; }
  setRuntimeRestartPending(value: boolean): void { this.codexRuntimeRestartPending = value; }
  get managedRuntimeSwitchPending(): boolean { return this.managedCodexRuntimeSwitchPending; }
  setManagedRuntimeSwitchPending(value: boolean): void { this.managedCodexRuntimeSwitchPending = value; }
  get runtimeRestartPromise(): Promise<boolean> | undefined { return this.codexRuntimeRestartPromise; }
  get backgroundTerminalRecords(): ReadonlyMap<string, CodexBackgroundTerminal[]> { return this.codexBackgroundTerminals; }
  get liveToolItemRecords(): ReadonlyMap<string, ReadonlyMap<string, LiveCodexToolItem>> { return this.liveCodexToolItemsByThread; }
  get pendingInvalidIdRecoveryRecords(): readonly PendingCodexInvalidIdRecovery[] { return this.pendingCodexInvalidIdRecoveries; }
  get invalidIdRecoveryBarrier(): Promise<void> | undefined { return this.codexInvalidIdRecoveryBarrier; }
  get invalidIdRecoveryDrain(): Promise<void> | undefined { return this.codexInvalidIdRecoveryDrain; }

  clearBackgroundTerminalsForShutdown(): void {
    this.backgroundTerminalGeneration += 1;
    this.codexBackgroundTerminals.clear();
    this.backgroundTerminalReadRevisions.clear();
  }

  abortInvalidIdRecoveriesForShutdown(): void {
    this.codexInvalidIdRecoveryAbort.abort();
  }

  stopAppServerRecycler(): void {
    if (this.codexAppServerRecycleTimer) {
      clearTimeout(this.codexAppServerRecycleTimer);
      this.codexAppServerRecycleTimer = undefined;
    }
  }

  stopIdleThreadUnsubscriber(): void {
    if (this.codexIdleThreadTimer) {
      clearInterval(this.codexIdleThreadTimer);
      this.codexIdleThreadTimer = undefined;
    }
  }

  rejectPendingInvalidIdRecoveriesForShutdown(): void {
    const recoveryCloseError = new Error(
      "Desktop backend registry closed before Codex history recovery completed",
    );
    for (const recovery of this.pendingCodexInvalidIdRecoveries.splice(0)) {
      recovery.reject(recoveryCloseError);
    }
    if (!this.codexInvalidIdRecoveryDrain) {
      this.resolveCodexInvalidIdRecoveryBarrier?.();
      this.resolveCodexInvalidIdRecoveryBarrier = undefined;
      this.codexInvalidIdRecoveryBarrier = undefined;
    }
  }

  private readonly pendingCodexInvalidIdRecoveries:
    PendingCodexInvalidIdRecovery[] = [];
  private readonly codexInvalidIdRecoveryAttemptedAt = new Map<string, number>();
  private codexInvalidIdRecoveryDrain?: Promise<void>;
  // Aborted by close(): a drain waiting for other turns must not hold shutdown.
  private readonly codexInvalidIdRecoveryAbort = new AbortController();
  private codexInvalidIdRecoveryBarrier?: Promise<void>;
  private resolveCodexInvalidIdRecoveryBarrier?: () => void;
  /** Commands may outlive their turn; other tools belong to that turn only. */
  private readonly liveCodexToolItemsByThread = new Map<string, Map<string, LiveCodexToolItem>>();
  private readonly codexBackgroundTerminals = new Map<string, CodexBackgroundTerminal[]>();
  /**
   * Latest revision per thread with a list read in flight. An entry lives
   * only while a read is outstanding, and the counter is shared so a read
   * started after a prune can never reuse an older read's number.
   */
  private readonly backgroundTerminalReadRevisions = new Map<string, number>();
  private backgroundTerminalReadCounter = 0;
  private backgroundTerminalGeneration = 0;
  private readonly resolveCodexAppServerRecycleSettingsFn: () => CodexAppServerRecycleSettings;
  private codexAppServerRecycleTimer?: NodeJS.Timeout;
  private codexAppServerRecycleCheck?: Promise<void>;
  private readonly codexThreadIdleUnsubscribeMs: number;
  private codexIdleThreadTimer?: NodeJS.Timeout;
  private codexIdleThreadSweep?: Promise<void>;
  private readonly markManagedCodexRuntimeSwitchCompleteFn: () => void;
  private codexRuntimeRestartPending = false;
  private managedCodexRuntimeSwitchPending = false;
  private codexRuntimeRestartPromise?: Promise<boolean>;

  getCodexAppServerRestartStatus(): CodexAppServerRestartStatus {
    return this.context.providers.codex.getAppServerRestartStatus?.() ?? { stopped: false };
  }

  onCodexAppServerRestartStatusChanged(
    listener: (status: CodexAppServerRestartStatus) => void,
  ): () => void {
    return this.context.providers.codex.onAppServerRestartStatusChanged?.(listener) ?? (() => undefined);
  }

  /**
   * Start Codex again after the client stopped restarting it. A failed start
   * is returned with the status it leaves, so the notice can say what happened.
   */
  async restartCodexAppServer(): Promise<CodexAppServerRestartResult> {
    try {
      await this.context.providers.codex.restartAppServer?.();
      return { status: this.getCodexAppServerRestartStatus() };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      backendRegistryLog.warn("Codex app server restart failed", { error: message });
      return { status: this.getCodexAppServerRestartStatus(), error: message };
    }
  }

  /**
   * Replace the Codex app server when it has sat idle for a while and has run
   * too long or started too many processes (`app-server-recycle-policy.ts`).
   * A leak in any MCP server it starts then lives hours, not days. Started by
   * the app after startup discovery, like the archive sweeper; tests that
   * never call this get no timer.
   */
  startCodexAppServerRecycler(): void {
    if (this.context.lifecycle.closed || this.host().shutdownRequested || this.codexAppServerRecycleTimer) return;
    this.scheduleCodexAppServerRecycleCheck();
  }

  private scheduleCodexAppServerRecycleCheck(): void {
    if (this.context.lifecycle.closed || this.host().shutdownRequested) return;
    const delayMs = codexAppServerRecycleCheckIntervalMs(
      this.resolveCodexAppServerRecycleSettingsFn(),
    );
    this.codexAppServerRecycleTimer = setTimeout(() => {
      void this.checkCodexAppServerRecycle()
        .finally(() => this.scheduleCodexAppServerRecycleCheck());
    }, delayMs);
    this.codexAppServerRecycleTimer.unref?.();
  }

  /**
   * One recycle check. Never throws; the client logs what it did. Registry
   * work is passed in as `isQuiescent`, not checked here, so the client
   * records a busy check in its status as it does any other.
   */
  async checkCodexAppServerRecycle(): Promise<void> {
    if (this.context.lifecycle.closed || this.host().shutdownRequested || this.codexAppServerRecycleCheck) return;
    const settings = this.resolveCodexAppServerRecycleSettingsFn();
    const recycle = this.context.providers.codex.maybeRecycleIdleAppServer?.bind(this.context.providers.codex);
    if (!settings.enabled || !recycle) return;
    const check = (async () => {
      await recycle({
        settings,
        isQuiescent: () => !this.context.lifecycle.closed
          && !this.host().shutdownRequested
          && !this.hasCodexWorkBlockingRecycle(),
      });
    })().catch((error) => {
      backendRegistryLog.warn("Codex app server recycle check failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.codexAppServerRecycleCheck = undefined;
    });
    this.codexAppServerRecycleCheck = check;
    await check;
  }

  /**
   * Work the registry tracks that a Codex stop would interrupt: turns and
   * their approvals, reserved thread starts, live tool items, background
   * terminals, voice, accepted compactions, and the other lifecycle owners
   * that stop or restart Codex themselves.
   */
  private hasCodexWorkBlockingRecycle(): boolean {
    return this.hasActiveCodexRuntimeWork()
      || this.host().hasActiveCodexWork()
      || this.codexRuntimeRestartPending
      || this.codexRuntimeRestartPromise !== undefined
      || this.codexInvalidIdRecoveryDrain !== undefined
      || this.pendingCodexInvalidIdRecoveries.length > 0;
  }

  /** The Codex app server's process, settings and last recycle, for diagnostics. */
  async readCodexAppServerDiagnostics(): Promise<{
    process?: CodexAppServerProcessSample;
    recycle: CodexAppServerRecycleStatus;
    settings: CodexAppServerRecycleSettings;
  }> {
    const process = await this.context.providers.codex.readAppServerProcessSample?.()
      .catch(() => undefined);
    return {
      ...(process ? { process } : {}),
      recycle: this.context.providers.codex.getAppServerRecycleStatus?.() ?? { recycleCount: 0 },
      settings: this.resolveCodexAppServerRecycleSettingsFn(),
    };
  }

  /**
   * Release idle Codex threads on a timer (`unsubscribeIdleThreads`). Started
   * by the app after startup discovery, like the archive sweeper; tests that
   * never call this get no timer.
   */
  startCodexIdleThreadUnsubscriber(): void {
    if (this.context.lifecycle.closed || this.host().shutdownRequested || this.codexIdleThreadTimer) return;
    this.codexIdleThreadTimer = setInterval(() => {
      void this.unsubscribeIdleCodexThreads();
    }, CODEX_THREAD_IDLE_UNSUBSCRIBE_CHECK_INTERVAL_MS);
    this.codexIdleThreadTimer.unref?.();
  }

  /** One pass over the Codex threads this app keeps loaded. Never throws. */
  async unsubscribeIdleCodexThreads(): Promise<void> {
    const unsubscribe = this.context.providers.codex.unsubscribeIdleThreads?.bind(this.context.providers.codex);
    if (this.context.lifecycle.closed || this.host().shutdownRequested || this.codexIdleThreadSweep || !unsubscribe) return;
    const sweep = (async () => {
      await unsubscribe({
        idleMs: this.codexThreadIdleUnsubscribeMs,
        isThreadBusy: (threadId) => this.context.lifecycle.closed
          || this.host().shutdownRequested
          || this.codexThreadNeedsLiveEvents(threadId),
      });
    })().catch((error) => {
      backendRegistryLog.warn("idle Codex thread unsubscribe failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      this.codexIdleThreadSweep = undefined;
    });
    this.codexIdleThreadSweep = sweep;
    await sweep;
  }

  /**
   * Work on a Codex thread that needs its live events: a turn, reserved start
   * or accepted compaction, its review, live sub-agent workers, a lifecycle
   * change or handoff in flight, a background terminal or live tool item,
   * queued input, or a history repair waiting to run.
   */
  private codexThreadNeedsLiveEvents(threadId: string): boolean {
    if (this.host().threadHasActiveTurn(threadId, "codex")) return true;
    const turnPrefix = `codex:${threadId}:`;
    for (const key of this.context.turnState.registeredTurnKeys()) {
      if (key.startsWith(turnPrefix)) return true;
    }
    const identityKey = buildThreadIdentityKey("codex", threadId);
    return this.host().liveSubAgentMonitorIds("codex", threadId).length > 0
      || this.threadArchiveCoordinator.threadLifecycleMutationCountRecords.has(identityKey)
      || this.threadWorkspaceService.threadHandoffReservationRecords.has(identityKey)
      || this.host().threadStarts.hasPending({ backend: "codex", threadId })
      || this.codexBackgroundTerminals.has(threadId)
      || this.liveCodexToolItemsByThread.has(threadId)
      || this.context.turnState.hasRetry(threadId)
      || this.host().threadTurnQueue.getQueuedEntries({ backend: "codex", threadId }).length > 0
      || this.pendingCodexInvalidIdRecoveries.some((recovery) => recovery.params.threadId === threadId);
  }

  async listBackgroundTerminals(request: ListBackgroundTerminalsRequest): Promise<ListBackgroundTerminalsResponse> {
    // Claude's running tasks live with its session, which counts as work for
    // quit and auto-archive like a Codex background terminal.
    if (request.backend === "claude") return this.context.providers.claude.listBackgroundTasks(request.threadId);
    if (request.backend !== "codex") return { supported: false, terminals: [] };
    return (await this.readCodexBackgroundTerminals(request.threadId)).response;
  }

  /** `applied` is false when an item or status event raced the read. */
  private async readCodexBackgroundTerminals(
    threadId: string,
  ): Promise<{ response: ListBackgroundTerminalsResponse; applied: boolean }> {
    const generation = this.backgroundTerminalGeneration;
    const revision = ++this.backgroundTerminalReadCounter;
    this.backgroundTerminalReadRevisions.set(threadId, revision);
    try {
      const response = await withCodexRequestActivity({ countsAsActivity: false }, () =>
        this.host().withCodexThreadClient(threadId, async (client) =>
          client.listBackgroundTerminals?.(threadId) ?? { supported: false, terminals: [] },
          undefined, false,
        ));
      const applied = !this.context.lifecycle.closed && response.supported && generation === this.backgroundTerminalGeneration
        && revision === this.backgroundTerminalReadRevisions.get(threadId);
      if (applied) {
        this.publishCodexBackgroundTerminals(threadId, response.terminals);
        this.pruneUnlistedCodexCommands(threadId, response.terminals);
      }
      return { response, applied };
    } finally {
      if (this.backgroundTerminalReadRevisions.get(threadId) === revision) {
        this.backgroundTerminalReadRevisions.delete(threadId);
      }
    }
  }

  /**
   * The list names every command that outlived its turn, so a command from a
   * finished turn that it omits is done even if Codex never sent its
   * `item/completed`. Without this a missed completion holds the thread in
   * the quit prompt and blocks a runtime restart forever. Commands in a live
   * turn may not have a session yet, and other tool kinds never appear in the
   * list, so both are kept. Absence from the active-turn maps alone cannot
   * establish completion: a new turn's bookkeeping may still be pending.
   */
  private pruneUnlistedCodexCommands(threadId: string, terminals: CodexBackgroundTerminal[]): void {
    const items = this.liveCodexToolItemsByThread.get(threadId);
    if (!items) return;
    const listed = new Set(terminals.map((terminal) => terminal.itemId));
    let pruned = false;
    for (const [itemId, { itemType, turnEnded }] of items) {
      if (
        itemType === "commandexecution"
        && !listed.has(itemId)
        && turnEnded
      ) {
        items.delete(itemId);
        pruned = true;
      }
    }
    if (!pruned) return;
    if (items.size === 0) this.liveCodexToolItemsByThread.delete(threadId);
    void this.maybeRestartCodexForManagedRuntimeChange();
  }

  /**
   * A Codex turn can end with commands still running. Codex announces no
   * terminal set, so read it once the turn ends, and read again if a
   * completion raced the read: navigation has no other way to learn of it.
   */
  async refreshCodexBackgroundTerminalsAfterTurn(threadId: string): Promise<void> {
    try {
      for (let attempt = 0; attempt < 3 && !this.context.lifecycle.closed; attempt += 1) {
        const { response, applied } = await this.readCodexBackgroundTerminals(threadId);
        if (applied || !response.supported) return;
      }
    } catch (error) {
      backendRegistryLog.debug("background terminal read after turn failed", {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Codex has no push event for background terminals, so the registry
   * publishes `thread/backgroundTasks/updated` itself whenever a thread's set
   * changes: a list read, a command's `item/completed`, or the thread
   * unloading. Navigation refreshes on that event, so the row mark clears.
   * Usage figures change on every read and are not a membership change.
   */
  private publishCodexBackgroundTerminals(threadId: string, terminals: CodexBackgroundTerminal[]): void {
    const previous = this.codexBackgroundTerminals.get(threadId) ?? [];
    if (terminals.length) this.codexBackgroundTerminals.set(threadId, terminals);
    else this.codexBackgroundTerminals.delete(threadId);
    if (backgroundTerminalMembership(previous) === backgroundTerminalMembership(terminals) || this.context.lifecycle.closed) return;
    void this.context.emit({
      backend: "codex",
      notification: { method: "thread/backgroundTasks/updated", params: { threadId, tasks: terminals } },
    }).catch((error) => backendRegistryLog.warn("background terminal update emit failed", {
      threadId,
      error: error instanceof Error ? error.message : String(error),
    }));
  }

  async terminateBackgroundTerminal(request: TerminateBackgroundTerminalRequest): Promise<TerminateBackgroundTerminalResponse> {
    if (request.backend === "claude") {
      return { terminated: await this.context.providers.claude.stopBackgroundTask(request.threadId, request.processId) };
    }
    if (request.backend !== "codex") throw new Error("Background terminals are only available for Codex and Claude.");
    const terminated = await this.host().withCodexThreadClient(request.threadId, async (client) => {
      if (!client.terminateBackgroundTerminal) throw new Error("This Codex runtime cannot stop background terminals.");
      return await client.terminateBackgroundTerminal(request.threadId, request.processId);
    });
    // The next list is authoritative. A Stop response alone does not claim
    // that the process tree has exited or manufacture item/completed events.
    // The stop already happened, so a failed read must not report it failed;
    // the cache keeps its last list until the next read succeeds.
    try {
      await this.listBackgroundTerminals(request);
    } catch {
      // The renderer re-reads after Stop and surfaces a failing list itself.
    }
    return { terminated };
  }

  async handleCodexTurnTerminalForInvalidIdRecovery(
    notification: Extract<
      AppServerNotification,
      { method: "turn/completed" | "turn/failed" | "turn/cancelled" }
    >,
  ): Promise<void> {
    const threadId = notification.params.threadId;
    const turnId = turnIdFromTerminalNotification(notification);
    const candidate = this.context.turnState.retryOperation(threadId);
    if (
      candidate
      && (
        !candidate.turnId
        || candidate.turnId.startsWith("pending:")
        || !turnId
        || candidate.turnId === turnId
      )
    ) {
      const completedCandidate = this.context.turnState.updateRetry(candidate, {
        ...(turnId && (!candidate.turnId || candidate.turnId.startsWith("pending:")) ? { turnId } : {}),
        terminalObserved: true,
      });
      this.context.turnState.forgetRetry(threadId);
      if (
        notification.method === "turn/failed"
        && !(candidate.kind === "compact" && candidate.invalidIdRecoveryAttempted)
        && isCodexInvalidResponseMessageIdError(
          errorMessageFromTerminalNotification(notification),
        )
      ) {
        if (this.context.providers.codex.recoverInvalidPersistedResponseMessageIds) {
          try {
            const recovery = await this.queueCodexInvalidIdRecovery(
              completedCandidate,
              errorMessageFromTerminalNotification(notification)!,
            );
            void recovery.completion.catch(() => undefined);
          } catch (error) {
            await this.emitCodexInvalidIdRecoveryUpdate({
              failureMessage: errorMessageFromTerminalNotification(notification)!,
              recoveryError: error instanceof Error ? error.message : String(error),
              status: "failed",
              threadId,
              ...(turnId ? { turnId } : {}),
            });
            backendRegistryLog.warn(
              "Codex invalid-message-ID recovery was not started",
              {
                error: error instanceof Error ? error.message : String(error),
                threadId,
                turnId: turnId ?? null,
              },
            );
          }
        } else {
          backendRegistryLog.warn(
            "Codex invalid-message-ID recovery is unavailable on this client",
            { threadId, turnId },
          );
        }
      }
      if (candidate.kind === "compact") {
        // emit() already attempted terminal queue dispatch while this
        // candidate still owned the thread. Wake it after releasing ownership.
        this.host().threadTurnQueue.scheduleThreadDrain({ backend: "codex", threadId });
      }
    }
    this.maybeDrainCodexInvalidIdRecoveries();
  }

  async queueCodexInvalidIdRecovery(
    candidate: CodexRetryableOperation,
    failureMessage: string,
  ): Promise<PendingCodexInvalidIdRecovery> {
    if (this.context.lifecycle.closed) {
      throw new Error("Desktop backend registry is closed");
    }
    const queued = this.pendingCodexInvalidIdRecoveries.find(
      (entry) => entry.params.threadId === candidate.params.threadId,
    );
    if (queued) {
      return queued;
    }

    const threadId = candidate.params.threadId;
    const turnId = candidate.turnId;
    if (!turnId) {
      throw new Error(
        `Codex invalid-message-ID recovery requires the failed turn id for thread ${threadId}`,
      );
    }
    const now = Date.now();
    const reservedAt = this.codexInvalidIdRecoveryAttemptedAt.get(threadId);
    if (
      reservedAt !== undefined
      && isCodexInvalidIdRecoveryCooldownActive(reservedAt, now)
    ) {
      throw new Error(buildCodexInvalidIdRecoveryCooldownMessage(reservedAt));
    }
    // Reserve in memory before the first await so concurrent observations of
    // the same failure cannot both pass the persisted cooldown check.
    this.codexInvalidIdRecoveryAttemptedAt.set(threadId, now);

    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: "codex",
      threadId,
    });
    const failedTurn = overlay?.turnFailureLog?.find(
      (entry) => entry.turnId === turnId,
    );
    if (!failedTurn) {
      throw new Error(
        `Codex invalid-message-ID recovery could not find failed turn ${turnId}`,
      );
    }
    const lastPersistedAttemptAt =
      overlay?.codexInvalidIdRecoveryLastAttemptedAt;
    if (
      lastPersistedAttemptAt !== undefined
      && isCodexInvalidIdRecoveryCooldownActive(lastPersistedAttemptAt, now)
    ) {
      this.codexInvalidIdRecoveryAttemptedAt.set(
        threadId,
        lastPersistedAttemptAt,
      );
      throw new Error(
        buildCodexInvalidIdRecoveryCooldownMessage(lastPersistedAttemptAt),
      );
    }
    const recentAttempt = [...(overlay?.turnFailureLog ?? [])]
      .reverse()
      .find((entry) =>
        entry.codexInvalidIdRecovery
        && isCodexInvalidIdRecoveryCooldownActive(
          entry.codexInvalidIdRecovery.attemptedAt,
          now,
        )
      )?.codexInvalidIdRecovery;
    if (recentAttempt) {
      this.codexInvalidIdRecoveryAttemptedAt.set(
        threadId,
        recentAttempt.attemptedAt,
      );
      throw new Error(
        buildCodexInvalidIdRecoveryCooldownMessage(recentAttempt.attemptedAt),
      );
    }

    const audit: ThreadCodexInvalidIdRecovery = {
      attemptId: randomUUID(),
      attemptedAt: Math.max(now, failedTurn.occurredAt + 1),
    };
    // Fail closed: the durable marker is the restart-safe loop guard. Never
    // touch Codex history or resubmit a request if it cannot be persisted.
    await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({
      threadId,
      turnId,
      recovery: audit,
    });
    this.codexInvalidIdRecoveryAttemptedAt.set(threadId, audit.attemptedAt);

    let resolve!: PendingCodexInvalidIdRecovery["resolve"];
    let reject!: PendingCodexInvalidIdRecovery["reject"];
    const completion = new Promise<{
      backend: "codex";
      threadId: string;
      turnId: string;
    }>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    // Repair stops the Codex app-server, so it waits for every other Codex
    // turn to finish first. Say so rather than claiming a repair is underway.
    const waitingForThreadIds = this.host().listActiveCodexWorkThreadIds()
      .filter((activeThreadId) => activeThreadId !== threadId);
    const recovery: PendingCodexInvalidIdRecovery = {
      ...candidate,
      audit,
      completion,
      failureMessage,
      reject,
      reportedWaiting: waitingForThreadIds.length > 0,
      resolve,
    };
    if (this.context.turnState.ownsRetry(candidate.params.threadId, candidate)) this.context.turnState.forgetRetry(candidate.params.threadId);
    this.pendingCodexInvalidIdRecoveries.push(recovery);
    if (!this.codexInvalidIdRecoveryBarrier) {
      this.codexInvalidIdRecoveryBarrier = new Promise<void>((barrierResolve) => {
        this.resolveCodexInvalidIdRecoveryBarrier = barrierResolve;
      });
    }
    backendRegistryLog.warn("queued Codex invalid-message-ID history recovery", {
      threadId,
      turnId,
    });
    await this.emitCodexInvalidIdRecoveryUpdate({
      failureMessage,
      status: recovery.reportedWaiting ? "waiting" : "repairing",
      threadId,
      turnId,
      ...(recovery.reportedWaiting ? { waitingForThreadIds } : {}),
    });
    return recovery;
  }

  async emitCodexInvalidIdRecoveryUpdate(
    params: Extract<
      AppServerNotification,
      { method: "thread/codexInvalidIdRecovery/updated" }
    >["params"],
  ): Promise<void> {
    try {
      await this.context.emit({
        backend: "codex",
        notification: {
          method: "thread/codexInvalidIdRecovery/updated",
          params,
        },
      });
    } catch (error) {
      backendRegistryLog.warn("Codex invalid-message-ID status notification failed", {
        error: error instanceof Error ? error.message : String(error),
        status: params.status,
        threadId: params.threadId,
      });
    }
  }

  maybeDrainCodexInvalidIdRecoveries(): void {
    if (
      this.context.lifecycle.closed
      || this.codexInvalidIdRecoveryDrain
      || this.pendingCodexInvalidIdRecoveries.length === 0
      || this.host().hasActiveCodexWork()
    ) {
      return;
    }

    this.codexInvalidIdRecoveryDrain = this.drainCodexInvalidIdRecoveries()
      .catch((error) => {
        backendRegistryLog.error("Codex invalid-message-ID recovery drain failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.codexInvalidIdRecoveryDrain = undefined;
        if (this.pendingCodexInvalidIdRecoveries.length === 0) {
          this.resolveCodexInvalidIdRecoveryBarrier?.();
          this.resolveCodexInvalidIdRecoveryBarrier = undefined;
          this.codexInvalidIdRecoveryBarrier = undefined;
          return;
        }
        this.maybeDrainCodexInvalidIdRecoveries();
      });
  }

  private async drainCodexInvalidIdRecoveries(): Promise<void> {
    const recover =
      this.context.providers.codex.recoverInvalidPersistedResponseMessageIds?.bind(
        this.context.providers.codex,
      );
    if (!recover) {
      return;
    }
    while (
      !this.context.lifecycle.closed
      && this.pendingCodexInvalidIdRecoveries.length > 0
      && !this.host().hasActiveCodexWork()
    ) {
      const recovery = this.pendingCodexInvalidIdRecoveries.shift()!;
      let retrySubmitted = false;
      try {
        if (recovery.reportedWaiting) {
          recovery.reportedWaiting = false;
          await this.emitCodexInvalidIdRecoveryUpdate({
            failureMessage: recovery.failureMessage,
            status: "repairing",
            threadId: recovery.params.threadId,
            ...(recovery.turnId ? { turnId: recovery.turnId } : {}),
          });
        }
        const forkLineageThreadIds =
          await this.resolveCodexInvalidIdRecoveryForkLineage(
            recovery.params.threadId,
          );
        // The registry's idle check above can miss turns the client alone
        // owns (helper turns) and turns admitted after it ran (reviews, task
        // monitors). The client re-checks where the stop actually happens and
        // waits there; relay that wait to the operator.
        const repaired = await recover({
          ...(forkLineageThreadIds.length > 0
            ? { forkLineageThreadIds }
            : {}),
          failureMessage: recovery.failureMessage,
          onWaitingForTurns: async (turns) => {
            recovery.reportedWaiting = true;
            await this.emitCodexInvalidIdRecoveryUpdate({
              failureMessage: recovery.failureMessage,
              status: "waiting",
              threadId: recovery.params.threadId,
              ...(recovery.turnId ? { turnId: recovery.turnId } : {}),
              waitingForThreadIds: [...new Set(turns.map((turn) => turn.threadId))],
            });
          },
          signal: this.codexInvalidIdRecoveryAbort.signal,
          threadId: recovery.params.threadId,
        });
        if (this.context.lifecycle.closed) {
          throw new Error(
            "Desktop backend registry closed during Codex history recovery; request was not resubmitted",
          );
        }
        recovery.audit = {
          ...recovery.audit,
          backupPath: repaired.backupPath,
          removedMessageIdCount: repaired.removedMessageIdCount,
          repairedAt: Math.max(Date.now(), recovery.audit.attemptedAt + 1),
        };
        await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({
          threadId: repaired.threadId,
          turnId: recovery.turnId!,
          recovery: recovery.audit,
        });
        if (this.context.lifecycle.closed) {
          throw new Error(
            "Desktop backend registry closed after Codex history repair; request was not resubmitted",
          );
        }
        const statusMessage =
          `PwrAgent repaired ${repaired.removedMessageIdCount} invalid persisted `
          + `message ID(s) for thread ${repaired.threadId}. `
          + `Backup: ${repaired.backupPath}. Retrying the failed `
          + `${recovery.kind === "compact" ? "compaction" : "turn"} once.`;
        backendRegistryLog.warn("Codex invalid-message-ID history repaired", {
          backupPath: repaired.backupPath,
          removedMessageIdCount: repaired.removedMessageIdCount,
          rolloutPath: repaired.rolloutPath,
          threadId: repaired.threadId,
          turnId: recovery.turnId ?? null,
        });
        await this.context.emit({
          backend: "codex",
          notification: {
            method: "warning",
            params: {
              threadId: repaired.threadId,
              message: statusMessage,
            },
          },
        });
        recovery.audit = {
          ...recovery.audit,
          retrySubmittedAt: Math.max(
            Date.now(),
            recovery.audit.repairedAt! + 1,
          ),
        };
        await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({
          threadId: repaired.threadId,
          turnId: recovery.turnId!,
          recovery: recovery.audit,
        });
        if (this.context.lifecycle.closed) {
          throw new Error(
            "Desktop backend registry closed before the repaired request could be resubmitted",
          );
        }
        retrySubmitted = true;
        const retried = recovery.kind === "compact"
          ? await this.host().compactThreadNow({
              ...recovery.params,
              invalidIdRecoveryAttempted: true,
            })
          : await this.host().startTurnNow({
              ...recovery.params,
              invalidIdRecoveryAttempted: true,
              // Keep automation, messaging, dependency and monitor origins so
              // the retried prompt keeps its card. Only a prompt with no
              // origin is attributed to PwrAgent's resubmission.
              messageOrigin:
                resolveThreadMessageOrigin(recovery.params)
                ?? { kind: "pwragent" },
            });
        recovery.audit = {
          ...recovery.audit,
          retryTurnId: retried.turnId,
        };
        try {
          await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({
            threadId: repaired.threadId,
            turnId: recovery.turnId!,
            recovery: recovery.audit,
          });
        } catch (error) {
          backendRegistryLog.warn(
            "failed to persist Codex invalid-message-ID retry turn id",
            {
              error: error instanceof Error ? error.message : String(error),
              threadId: repaired.threadId,
              turnId: retried.turnId,
            },
          );
        }
        await this.emitCodexInvalidIdRecoveryUpdate({
          backupPath: repaired.backupPath,
          failureMessage: recovery.failureMessage,
          removedMessageIdCount: repaired.removedMessageIdCount,
          status: "succeeded",
          threadId: repaired.threadId,
          ...(recovery.turnId ? { turnId: recovery.turnId } : {}),
        });
        recovery.resolve({
          backend: "codex",
          threadId: retried.threadId,
          turnId: retried.turnId,
        });
      } catch (error) {
        recovery.audit = {
          ...recovery.audit,
          failedAt: Math.max(
            Date.now(),
            (recovery.audit.retrySubmittedAt
              ?? recovery.audit.repairedAt
              ?? recovery.audit.attemptedAt) + 1,
          ),
          failure: error instanceof Error ? error.message : String(error),
        };
        try {
          await this.context.stores.threads.setTurnFailureCodexInvalidIdRecovery({
            threadId: recovery.params.threadId,
            turnId: recovery.turnId!,
            recovery: recovery.audit,
          });
        } catch (auditError) {
          backendRegistryLog.error(
            "failed to persist Codex invalid-message-ID recovery failure",
            {
              auditError:
                auditError instanceof Error
                  ? auditError.message
                  : String(auditError),
              threadId: recovery.params.threadId,
              turnId: recovery.turnId ?? null,
            },
          );
        }
        recovery.reject(error);
        if (!this.context.lifecycle.closed) {
          await this.emitCodexInvalidIdRecoveryUpdate({
            failureMessage: recovery.failureMessage,
            recoveryError: error instanceof Error ? error.message : String(error),
            status: "failed",
            threadId: recovery.params.threadId,
            ...(recovery.turnId ? { turnId: recovery.turnId } : {}),
          });
        }
        backendRegistryLog.error("Codex invalid-message-ID history recovery failed", {
          error: error instanceof Error ? error.message : String(error),
          phase: retrySubmitted ? "automatic-retry" : "repair",
          threadId: recovery.params.threadId,
          turnId: recovery.turnId ?? null,
        });
        if (!this.context.lifecycle.closed) {
          await this.context.emit({
            backend: "codex",
            notification: {
              method: "warning",
              params: {
                threadId: recovery.params.threadId,
                message:
                  `PwrAgent could not repair invalid persisted message IDs for thread `
                  + `${recovery.params.threadId}: `
                  + (error instanceof Error ? error.message : String(error)),
              },
            },
          });
        }
      }
    }
  }

  private async resolveCodexInvalidIdRecoveryForkLineage(
    threadId: string,
  ): Promise<string[]> {
    const lineage: string[] = [];
    const seen = new Set([threadId]);
    let currentThreadId = threadId;
    while (true) {
      const overlay = await this.context.stores.threads.getThreadOverlayState({
        backend: "codex",
        threadId: currentThreadId,
      });
      const sourceThreadId = overlay?.forkSourceThreadId?.trim();
      if (!sourceThreadId) {
        return lineage;
      }
      if (seen.has(sourceThreadId)) {
        throw new Error(
          `Codex invalid-message-ID recovery found cyclic fork provenance for thread ${threadId}`,
        );
      }
      seen.add(sourceThreadId);
      lineage.push(sourceThreadId);
      currentThreadId = sourceThreadId;
    }
  }

  private hasActiveCodexRuntimeWork(): boolean {
    if (
      this.host().nativeVoiceLeases > 0
      || this.context.turnState.startReservationCount > 0
      || this.context.turnState.providerActiveCount > 0
      || this.codexBackgroundTerminals.size > 0
      || this.liveCodexToolItemsByThread.size > 0
      || this.context.turnState.executionCount > 0
    ) {
      return true;
    }
    for (const key of this.context.turnState.registeredTurnKeys()) {
      if (key.startsWith("codex:")) return true;
    }
    return false;
  }

  /**
   * Switch binaries only at an idle Codex boundary. Enabling, disabling, and
   * installing an update all close the reconnectable client; its next request
   * resolves the currently selected command from Settings. Active turns keep
   * their original process until their terminal notification has settled.
   */
  async maybeRestartCodexForManagedRuntimeChange(): Promise<boolean> {
    if (
      this.context.lifecycle.closed
      || !this.codexRuntimeRestartPending
      || this.hasActiveCodexRuntimeWork()
    ) {
      return false;
    }
    if (this.codexRuntimeRestartPromise) {
      return await this.codexRuntimeRestartPromise;
    }

    const completesManagedSwitch = this.managedCodexRuntimeSwitchPending;
    const restart = (async () => {
      if (this.hasActiveCodexRuntimeWork()) return false;
      this.codexRuntimeRestartPending = false;
      this.managedCodexRuntimeSwitchPending = false;
      await this.context.providers.codex.close();
      // Exits counted against the old binary say nothing about the new one.
      // Clear the breaker; the next request starts the selected Codex.
      this.context.providers.codex.resetAppServerRestarts?.("Codex runtime changed");
      this.host().tokenMiserServerCapabilities.delete(this.context.providers.codex);
      this.host().tokenMiserReducerCapabilityState = undefined;
      this.host().tokenMiserCodeModeGroupingVersion = undefined;
      this.host().tokenMiserPostToolUseExactOutputVersion = undefined;
      this.host().tokenMiserRuntimePreparationFailure = undefined;
      if (this.host().tokenMiserStore) await this.threadUsageLedger.initializeTokenMiserLedger();
      if (this.host().resolveTokenMiserEnabledFn()) {
        await this.host().prepareTokenMiserRuntime();
      }
      if (completesManagedSwitch) {
        this.markManagedCodexRuntimeSwitchCompleteFn();
      }
      return true;
    })();
    this.codexRuntimeRestartPromise = restart;
    try {
      return await restart;
    } catch (error) {
      this.codexRuntimeRestartPending = true;
      if (completesManagedSwitch) {
        this.managedCodexRuntimeSwitchPending = true;
      }
      backendRegistryLog.warn("managed Codex restart failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      if (this.codexRuntimeRestartPromise === restart) {
        this.codexRuntimeRestartPromise = undefined;
      }
    }
  }

  /** A successful turn may leave commands, but cannot leave an MCP/search call running. */
  private settleCodexToolItems(
    threadId: string,
    belongsToEndedTurn: (item: LiveCodexToolItem) => boolean,
    interrupted = false,
  ): void {
    const items = this.liveCodexToolItemsByThread.get(threadId);
    if (!items) return;
    for (const [itemId, item] of items) {
      if (!belongsToEndedTurn(item)) continue;
      if (item.itemType === "commandexecution" && !interrupted) {
        // Set this at notification ingress, before asynchronous lifecycle
        // bookkeeping. An immediate list response can then prune the ended
        // command even while its parent turn remains registered.
        item.turnEnded = true;
      } else {
        items.delete(itemId);
      }
    }
    if (items.size === 0) this.liveCodexToolItemsByThread.delete(threadId);
  }

  trackLiveCodexToolItem(event: AgentEvent): void {
    if (event.backend !== "codex") return;
    const notification = event.notification;
    const params = readRecord(notification.params);
    const threadIdForRevision = readOptionalString(params, ["threadId"]);
    if (threadIdForRevision && [
      "item/started", "item/completed", "thread/status/changed", "turn/started",
      "turn/completed", "turn/failed", "turn/cancelled",
    ].includes(notification.method)) {
      // Removing the token invalidates only reads already in flight. A newer
      // read receives a fresh counter value; no invalidated token is retained.
      this.backgroundTerminalReadRevisions.delete(threadIdForRevision);
    }
    if (notification.method === "item/completed") {
      const item = readRecord(params?.item);
      const itemId = readOptionalString(item, ["id", "itemId", "item_id", "callId", "call_id"]);
      const threadId = notification.params.threadId;
      const terminals = this.codexBackgroundTerminals.get(threadId);
      if (terminals && itemId) {
        this.publishCodexBackgroundTerminals(threadId, terminals.filter((terminal) => terminal.itemId !== itemId));
      }
    }
    if (notification.method === "thread/status/changed") {
      const threadId = notification.params.threadId;
      const status = readStatusType(notification.params.status);
      if (status === "notLoaded") {
        // The unloaded thread owns no processes. Child threads have their own
        // runtime entries and are deliberately untouched by this boundary.
        this.liveCodexToolItemsByThread.delete(threadId);
        this.publishCodexBackgroundTerminals(threadId, []);
      } else if (status === "idle") {
        this.settleCodexToolItems(threadId, (item) =>
          !this.host().threadHasActiveCodexReviewTurn(threadId)
          || (!this.context.turnState.hasRegisteredTurn({ backend: "codex", threadId: threadId, turnId: item.turnId })
            && !this.context.turnState.ownsExecution({ threadId: threadId, turnId: item.turnId })),
        );
      }
    }
    if (
      notification.method === "turn/completed"
      || notification.method === "turn/failed"
      || notification.method === "turn/cancelled"
    ) {
      const threadId = notification.params.threadId;
      const turnId = turnIdFromTerminalNotification(notification);
      this.settleCodexToolItems(threadId, (item) => turnId
        ? item.turnId === turnId
        : !this.context.turnState.hasRegisteredTurn({ backend: "codex", threadId: threadId, turnId: item.turnId })
          && !this.context.turnState.ownsExecution({ threadId: threadId, turnId: item.turnId }),
        notification.method !== "turn/completed",
      );
      return;
    }
    if (notification.method !== "item/started" && notification.method !== "item/completed") {
      return;
    }
    const threadId = notification.params.threadId;
    const itemType = readNotificationItemType(notification)
      ?.replace(/[-_\s]/g, "").toLowerCase();
    if (!itemType || ![
      "commandexecution", "functioncall", "dynamictoolcall", "mcptoolcall",
      "collabagenttoolcall", "websearch",
    ].includes(itemType)) return;
    const item = readRecord(readRecord(notification.params)?.item);
    const itemId = readOptionalString(item, ["id", "itemId", "item_id", "callId", "call_id"]);
    if (!itemId) return;
    if (notification.method === "item/started") {
      if (item?.status !== "inProgress" && item?.status !== "in_progress") return;
      const turnId = readOptionalString(readRecord(notification.params), ["turnId", "turn_id"]);
      if (!turnId) return;
      const items = this.liveCodexToolItemsByThread.get(threadId) ?? new Map<string, LiveCodexToolItem>();
      items.set(itemId, { turnId, itemType });
      this.liveCodexToolItemsByThread.set(threadId, items);
      return;
    }
    const items = this.liveCodexToolItemsByThread.get(threadId);
    items?.delete(itemId);
    if (items?.size === 0) this.liveCodexToolItemsByThread.delete(threadId);
  }

  async handleCodexAppServerUnexpectedExit(affected?: ReadonlySet<string>): Promise<void> {
    this.backgroundTerminalGeneration += 1;
    // The client synthesizes terminal failures only for turns it saw start.
    // Settle accepted compactions it cannot know about at this same boundary.
    const pendingCompactions: CodexRetryableCompaction[] = [];
    for (const [threadId, candidate] of this.context.turnState.retryEntries()) {
      if (affected && !affected.has(threadId)) continue;
      if (candidate.kind !== "compact" || candidate.lifecycleStarted) continue;
      const completedCandidate = this.context.turnState.updateRetry(candidate, { terminalObserved: true });
      this.context.turnState.forgetRetry(threadId);
      pendingCompactions.push(completedCandidate);
    }
    const threadIds = [...new Set([
      ...this.liveCodexToolItemsByThread.keys(), ...this.codexBackgroundTerminals.keys(),
      ...pendingCompactions.map((candidate) => candidate.params.threadId),
    ])].filter((threadId) => !affected || affected.has(threadId));
    for (const threadId of threadIds) this.liveCodexToolItemsByThread.delete(threadId);
    // The terminals died with the app server. Publish the clear so rows that
    // carried their mark refresh.
    for (const threadId of [...this.codexBackgroundTerminals.keys()]) {
      if (affected && !affected.has(threadId)) continue;
      this.publishCodexBackgroundTerminals(threadId, []);
    }
    try {
      await Promise.all(pendingCompactions.map((candidate) => {
        const threadId = candidate.params.threadId;
        const turnId = candidate.turnId ?? `pending:compact:${threadId}`;
        return this.context.emit({
          backend: "codex",
          notification: {
            method: "turn/failed",
            params: {
              threadId,
              turnId,
              turn: {
                id: turnId,
                status: "failed",
                completedAt: Date.now(),
                error: { message: "Codex app server exited before compaction completed." },
              },
            },
          },
        });
      }));
      await Promise.all(threadIds.map((threadId) => this.context.emit({
        backend: "codex",
        notification: {
          method: "thread/status/changed",
          params: { threadId, status: { type: "notLoaded" } },
        },
      })));
    } finally {
      this.maybeDrainCodexInvalidIdRecoveries();
      await this.maybeRestartCodexForManagedRuntimeChange();
    }
  }
}
