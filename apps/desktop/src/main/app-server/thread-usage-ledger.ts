import type { RegistryContext, RegistryHost } from "./registry-context";
import type { ManagedReviewService } from "./managed-review-service";
import type { SubAgentMonitorService } from "./subagent-monitor-service";
import { logUnpricedThreadUsageLine } from "./unpriced-usage-line-log";
import {
  indexTokenMiserCachedReplays,
  indexTokenMiserPricingLines,
  type TokenMiserCachedReplayIndex,
} from "./token-miser-ledger-index";
import {
  addTokenMiserGateAccountingTotals,
  isTokenMiserSubAgent,
  totalTokenMiserGateAccountings,
  readUuidV7Timestamp,
} from "@pwragent/shared";
import {
  buildMonitorJobHeuristicPrompt,
  MonitorJobHeuristicDetector,
  MONITOR_JOB_HEURISTIC_SCHEMA,
  MONITOR_JOB_HEURISTIC_SYSTEM,
  MonitorJobSuggestionDetector,
  MONITOR_JOB_SUGGESTION,
  CLAUDE_MONITOR_JOB_SUGGESTION,
  isCiWaitCommand,
  parseMonitorJobHeuristicDecision,
  type MonitorJobHeuristicEvidence,
} from "./monitor-job-suggestion";
import { priceLocalModelUsage } from "@pwragent/shared";
import {
  type ThreadDisplayCards,
} from "./thread-display";
import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type AppServerThreadActivityEntry,
  type AppServerThreadMessageOrigin,
  type AppServerThreadReplay,
  type AppServerBackendKind,
  type BackendSummary,
  type DesktopSpendAlertPolicy,
  type DesktopToolOutputAlertPolicy,
  type NavigationSnapshot,
  type SteerTurnRequest,
  type SteerTurnResponse,
  type ThreadOverlayState,
  type ThreadSubAgentSummary,
  type ThreadToolAccounting,
  type ThreadToolInvocationAlert,
  type ThreadToolInvocationRecord,
  type ThreadTokenMiserSavings,
  type ThreadUsageLineRecord,
  buildThreadIdentityKey,
  isAcpBackendId,
  TOOL_OUTPUT_CAP_CHARS,
  toolOutputWarningChars,
} from "@pwragent/shared";
import { type TokenMiserDiagnosticContext } from "../token-miser/token-miser-diagnostics";
import { type TokenMiserServiceOptions } from "../token-miser/token-miser-service";
import type { TokenMiserStore } from "../token-miser/token-miser-store";
import { type TokenMiserObjectMetadata } from "../token-miser/token-miser-types";
import {
  type ResolvedAgentToolMcpCallContext,
} from "../agent-tools/agent-tool-mcp-server";
import {
  detectLargeToolOutput,
  detectNoisyPolling,
  mergeLargeToolOutputIncident,
  mergeStreamedToolInvocationDeltas,
  mergeToolInvocationLifecycleWithStreamedOutput,
  toolAccountingLookbackSince,
  toolInvocationFromNotification,
  normalizeToolInvocationCommand,
  toolInvocationReviewInputFromNotification,
  type ToolOutputIncidentAggregate,
} from "./tool-invocation-accounting";
import { detectUsageSpendAlerts } from "./usage-spend-alerts";
import { getMainLogger } from "../log";
import {
  completedAtFromTerminalNotification,
  normalizeNotificationTimestamp,
  readNotificationItemType,
  textFragmentsFromCodexNotification,
  turnIdFromTerminalNotification,
} from "./backend-registry-notifications";
import {
  type ClaudeTurnTimes,
  type DeferredThreadPricing,
  type DerivedLiveThreadTokenUsage,
  type LiveThreadContextWindowObservation,
  type LiveThreadRequestUsage,
  type LiveThreadUsageAggregate,
  type LiveThreadUsageBatch,
  type LiveThreadUsageEmitWork,
  type ObservedContextReplayCursor,
  type ObservedContextReplayTally,
  type ObservedContextWindowDrop,
  type PendingLiveThreadUsageLine,
  type RecentlyCompletedThreadUsageTurn,
  type ReportedCompactionRequestBoundary,
  type TaskMonitorTokenUsageBreakdown,
  type ThreadPricingLedger,
  type TokenMiserLedgerIndexes,
} from "./backend-registry-types";
import {
  LIVE_THREAD_USAGE_FLUSH_INTERVAL_MS,
  TOOL_INVOCATION_DELTA_FLUSH_INTERVAL_MS,
  USAGE_TURN_REPAIR_BATCH_LIMIT,
  USAGE_TURN_REPAIR_PEER_QUIET_MS,
} from "./backend-registry-runtime-helpers";
import {
  buildReviewSubAgentKey,
  parseActiveTurnKey,
  taskMonitorThreadKey,
} from "./thread-turn-keys";
import {
  readNonEmptyString,
  readOptionalString,
  readRecord,
} from "./backend-registry-notification-values";
import {
  COMPACTION_NOTIFICATION_DEDUP_WINDOW_MS,
  addTaskMonitorTokenUsage,
  buildForkBaselineUsageLine,
  buildLiveThreadUsageLine,
  buildTaskMonitorUsageLine,
  buildTaskMonitorUsageSnapshot,
  buildTaskMonitorUsageTotals,
  buildThreadCompactionIdentity,
  canSubtractTaskMonitorTokenUsage,
  claudeTurnTimes,
  collectThreadUsageLinesFromReplay,
  detectObservedContextWindowDrop,
  foldLiveThreadRequestUsage,
  foldObservedContextReplay,
  mergeThreadPricingLines,
  readTaskMonitorTokenUsageRecords,
  readThreadCompactionBoundary,
  readUsageBoolean,
  readUsageNumber,
  readUsageString,
  resolveLiveThreadUsageTiming,
  resolveTokenMiserGateAccounting,
  subtractTaskMonitorTokenUsage,
  taskMonitorTokenUsageEqual,
  tokenMiserMonitorId,
  tokenMiserSubAgentProjectionChanged,
  withLegacyTokenMiserReplayAccounting,
  withLiveCodexNativeSubAgentUsage,
} from "./thread-usage-math";
import { isDevelopment, logDebug } from "./registry-debug-log";

const backendRegistryLog = getMainLogger("pwragent:backend-registry");

/** Collaborators the composition root builds for this module. */
export interface ThreadUsageLedgerDependencies {
  readonly managedReviewService: ManagedReviewService;
  readonly subAgentMonitorService: SubAgentMonitorService;
}

/**
 * Registry-owned state and turn operations the usage ledger reads. The
 * registry's construction ports satisfy it; this module never imports the
 * registry. The Codex turn-activity set stays registry-owned, and so does
 * the Codex account summary: capturing a turn's usage account can update it.
 */
export interface ThreadUsageLedgerHost {
  readonly activeTurnKeys: ReadonlySet<string>;
  readonly codexBackendSummary: BackendSummary | undefined;
  readonly registrySessionId: string;
  readonly registrySessionStartedAt: number;
  readonly resolveCodexLocalModelIdsFn: () => string[];
  readonly resolveTokenMiserEnabledFn: () => boolean;
  readonly resolveTokenMiserPollingReviewsEnabledFn: () => boolean;
  readonly runtimeInstanceId: string;
  readonly spendAlertPolicy: DesktopSpendAlertPolicy;
  readonly tokenMiserStore: TokenMiserStore | undefined;
  readonly toolOutputAlertPolicy: DesktopToolOutputAlertPolicy;
  captureUsageAccount(backend: AppServerBackendKind, threadId?: string): Promise<string | undefined>;
  getActiveTurnForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): { backend: AppServerBackendKind; threadId: string; turnId: string } | undefined;
  invalidateThreadListCache(
    backend?: AppServerBackendKind,
    workspaceChanged?: boolean,
    threadId?: string,
    paths?: readonly string[],
  ): void;
  liveProfileRuntimeInstanceIds(): string[] | undefined;
  liveSubAgentMonitorIds(backend: AppServerBackendKind, threadId: string): string[];
  steerTurn(
    params: SteerTurnRequest,
    messageOrigin?: AppServerThreadMessageOrigin,
  ): Promise<SteerTurnResponse>;
}

/**
 * The usage and Token Miser domain of the backend registry: live usage lines
 * and their flush window, the pricing publications they drive, usage-turn
 * accounts and the startup and shutdown repairs of the turn ledger, context
 * replay and compaction boundaries, the Token Miser ledger with its live
 * gates, and tool-invocation accounting with the monitor-job suggestions it
 * raises.
 */
export class ThreadUsageLedger {
  private readonly context: RegistryContext;
  private readonly host: RegistryHost<ThreadUsageLedgerHost>;
  private readonly managedReviewService: ManagedReviewService;
  private readonly subAgentMonitorService: SubAgentMonitorService;

  constructor(
    context: RegistryContext,
    dependencies: ThreadUsageLedgerDependencies,
    host: RegistryHost<ThreadUsageLedgerHost>,
  ) {
    this.context = context;
    this.host = host;
    this.managedReviewService = dependencies.managedReviewService;
    this.subAgentMonitorService = dependencies.subAgentMonitorService;
  }

  /** Recently ended turns by thread, for the sub-agent monitor's reads. */
  get recentlyCompletedThreadUsageTurnRecords(): ReadonlyMap<string, RecentlyCompletedThreadUsageTurn> {
    return this.recentlyCompletedThreadUsageTurns;
  }

  /** Each thread's latest observed request cursor, for the Token Miser service's reads. */
  get liveThreadReplayInputCursorRecords(): ReadonlyMap<string, ObservedContextReplayCursor> {
    return this.liveThreadReplayInputCursor;
  }

  /** Live usage lines waiting for the next flush, for the registry's reads. */
  get pendingLiveThreadUsageLineRecords(): ReadonlyMap<string, PendingLiveThreadUsageLine> {
    return this.pendingLiveThreadUsageLines;
  }

  /** Live Token Miser gate cards by parent thread, then monitor id, for the registry's reads. */
  get liveTokenMiserSubAgentRecords(): ReadonlyMap<string, ReadonlyMap<string, ThreadSubAgentSummary>> {
    return this.liveTokenMiserSubAgents;
  }

  /** The latest Token Miser ledger reconciliation; the registry waits on it. */
  get currentTokenMiserLedgerReconciliation(): Promise<void> {
    return this.tokenMiserLedgerReconciliation;
  }

  /** Replaces a pending live usage line; the hub stamps a terminal turn's end on it. */
  setPendingLiveThreadUsageLine(usageKey: string, line: PendingLiveThreadUsageLine): void {
    this.pendingLiveThreadUsageLines.set(usageKey, line);
  }

  /** Holds a gate's metadata until its usage is recorded; the Token Miser store reports each update. */
  rememberPendingTokenMiserInterception(metadata: TokenMiserObjectMetadata): void {
    this.pendingTokenMiserInterceptions.set(metadata.objectId, metadata);
  }

  private readonly usageTurnAccounts = new Map<string, Promise<string | undefined>>();

  /** Turn start times reported on turn/started, keyed like usageTurnAccounts. */
  private readonly usageTurnStartTimes = new Map<string, number>();

  private readonly liveThreadUsageBaselines = new Map<
    string,
    TaskMonitorTokenUsageBreakdown
  >();

  // Codex `total` usage is cumulative for the thread, while `last` is only the
  // latest upstream model request. Keep the preceding turn's cumulative high-
  // water mark so a snapshot first observed after a long multi-request turn
  // is attributed as `total - preceding total`, not mistaken for `last`.
  private readonly liveCodexThreadCumulativeUsage = new Map<
    string,
    {
      observationSequence: number;
      turnId: string;
      usage: TaskMonitorTokenUsageBreakdown;
    }
  >();

  // Once another turn consumes usage, the preceding cumulative snapshot is
  // the upper bound for the older turn. Keep it across start/completion events
  // so a replay cannot charge a later turn's tokens to an earlier ledger row.
  private readonly liveCodexThreadUsageCeilings = new Map<
    string,
    TaskMonitorTokenUsageBreakdown
  >();

  private readonly liveThreadUsageAggregates = new Map<
    string,
    LiveThreadUsageAggregate
  >();

  private readonly liveThreadRequestUsage = new Map<
    string,
    LiveThreadRequestUsage
  >();

  private readonly recentlyCompletedThreadUsageTurns = new Map<
    string,
    RecentlyCompletedThreadUsageTurn
  >();

  // Per-turn tally of observed context replays (key: backend:threadId:turnId).
  private readonly liveThreadReplayObservations = new Map<
    string,
    ObservedContextReplayTally
  >();

  private readonly liveThreadContextWindowObservations = new Map<
    string,
    LiveThreadContextWindowObservation
  >();

  // Per-thread replay cursor (key: backend:threadId): the high-water mark of
  // cumulative `total.inputTokens` (detects a genuinely new model request, so
  // duplicate re-emissions are no-ops) plus the prior request's context size
  // (caps cold-replay attribution). Kept per-thread, not per-turn, so both
  // signals span turn boundaries; per-turn tallies are dropped at turn end but
  // this cursor intentionally survives so late duplicates still dedup.
  private readonly liveThreadReplayInputCursor = new Map<
    string,
    ObservedContextReplayCursor
  >();

  // Semantic boundary at the latest successfully persisted reported
  // compaction. The cursor lets usage-only inference match the exact boundary;
  // the remaining fields reconcile the item lifecycle event with an adjacent
  // item-less `thread/compacted` notification.
  // A later context drop suppresses inference only when its immediately prior
  // request has this exact cursor; an older unattributed database row is not
  // evidence that the new drop was already marked.
  private readonly reportedCompactionRequestBoundaries = new Map<
    string,
    ReportedCompactionRequestBoundary
  >();

  /**
   * Cumulative live usage waiting for one bulk sqlite transaction. The
   * observation sequence preserves event arrival order even if an older
   * event's overlay lookup resolves after a newer event's lookup.
   */
  private readonly pendingLiveThreadUsageLines = new Map<
    string,
    PendingLiveThreadUsageLine
  >();

  private readonly pendingTokenMiserInterceptions = new Map<
    string,
    TokenMiserObjectMetadata
  >();

  private readonly activeTokenMiserReplayEntries = new Map<
    string,
    Map<string, TokenMiserObjectMetadata>
  >();

  /**
   * Per-thread request boundary for Token Miser (key: backend:threadId): the
   * high-water mark of the thread's cumulative `total.inputTokens`.
   *
   * One cursor per thread, not one per gate. The cumulative total is a property
   * of the thread's request sequence, so deciding "is this a new request?" once
   * keeps every gate on the same answer; per-gate marks made the answer depend
   * on when each gate was created. The process epoch passed to the store lets a
   * resumed session re-anchor below the previous process's persisted watermark.
   */
  private readonly liveTokenMiserRequestCursor = new Map<string, number>();

  private readonly tokenMiserRequestEpoch = randomUUID();

  private readonly tokenMiserRequestEpochByCursor = new Map<string, string>();

  private readonly liveTokenMiserSubAgents = new Map<
    string,
    Map<string, ThreadSubAgentSummary>
  >();

  private readonly liveTokenMiserUsageLines = new Map<
    string,
    Map<string, ThreadUsageLineRecord>
  >();

  private tokenMiserStoragePreparation: Promise<void> = Promise.resolve();

  /**
   * The settlement of the last queued live gate publish. Each publish waits
   * for this, so gate cards update in the order the store reported them.
   */
  private tokenMiserLivePublishChain: Promise<void> = Promise.resolve();

  private tokenMiserLedgerReconciliation: Promise<void> = Promise.resolve();

  private liveThreadUsageObservationSequence = 0;

  /**
   * Usage notifications overlap at the JSON-RPC transport. Register each one
   * before `emit` first yields so a later terminal event or close can capture
   * an exact arrival-ordered durability barrier.
   */
  private readonly liveThreadUsageEmitWork = new Set<LiveThreadUsageEmitWork>();

  // Registered synchronously at notification arrival, before the async event
  // pipeline can reorder overlay reads. Each thread's derivation waits for the
  // preceding arrival to publish its cumulative snapshot, while unrelated
  // threads remain fully concurrent.
  private readonly liveThreadUsageDerivationTails = new Map<
    string,
    Promise<void>
  >();

  private pendingLiveThreadUsageTimer: NodeJS.Timeout | undefined;

  /**
   * Serializes timer, terminal, retry, and shutdown drains. A caller awaiting
   * a flush therefore also waits for any batch that was already in flight.
   */
  private liveThreadUsageFlushChain: Promise<void> = Promise.resolve();

  private liveThreadUsagePricingChain: Promise<void> = Promise.resolve();

  private readonly threadPricingPublications = new Map<string, Promise<void>>();

  /**
   * Streamed command-output accounting waiting to be written, keyed by
   * invocation id. Deltas fold together here instead of each one paying a
   * sqlite read+write on the event hot path; see
   * `TOOL_INVOCATION_DELTA_FLUSH_INTERVAL_MS`.
   */
  private readonly pendingToolInvocationDeltas = new Map<
    string,
    ThreadToolInvocationRecord
  >();

  /**
   * Full in-memory output totals for active commands. Flush windows clear the
   * sqlite write buffer every 250ms, but warning thresholds must span those
   * windows or a steady stream of small chunks never reaches the configured
   * large-output boundary.
   */
  private readonly streamedToolInvocationOutputTotals = new Map<
    string,
    ThreadToolInvocationRecord
  >();

  /**
   * Short-lived polling samples used only for replay-amplification detection.
   * Persisting every `wait` / `write_stdin` check would turn the detector into
   * a timer-driven sqlite writer, so only incident boundaries reach sqlite.
   */
  private readonly volatileDeferredCheckInvocations = new Map<
    string,
    ThreadToolInvocationRecord[]
  >();

  private readonly persistedToolInvocationAlertCounts = new Map<string, number>();

  private readonly liveToolOutputIncidents = new Map<
    string,
    ToolOutputIncidentAggregate
  >();

  private readonly triggeredSpendAlertIds = new Set<string>();

  private pendingToolInvocationDeltaTimer: NodeJS.Timeout | undefined;

  /**
   * Serializes every flush and streamed alert boundary so a timer-driven write
   * can never land after the `item/completed` write it accumulated before. The
   * store keeps the terminal status and stops summing once a row is terminal, so an
   * out-of-order delta flush would silently under-count the command's output.
   */
  private toolInvocationDeltaFlushChain: Promise<void> = Promise.resolve();

  private readonly monitorJobSuggestionDetector = new MonitorJobSuggestionDetector();

  private readonly pendingAcpMonitorJobSuggestions = new Map<string, string>();

  private readonly monitorJobHeuristicDetector = new MonitorJobHeuristicDetector();

  /**
   * Repair ledger turn times once per profile. Two bugs left them wrong:
   *
   * - Claude turns were dated by reading their UUIDv4 ids as UUIDv7, which
   *   stored starts in years such as 2042 and 6903.
   * - Every launch rewrote each turn's start to its first usage write and
   *   cleared ends the lines did not carry.
   *
   * A Codex turn id is a UUIDv7 that carries the start. PwrAgent's own Claude
   * transcript has each turn's first entry and its recorded end. The store
   * keeps a recovered time only when it is plausible and better than the
   * stored one, and clears any start that is still implausible.
   */
  async repairThreadUsageTurnTimesOnce(): Promise<void> {
    const read = this.context.stores.usage.readThreadUsageTurnTimeRepairCandidates;
    const repair = this.context.stores.usage.repairThreadUsageTurnTimes;
    if (!read || !repair) {
      return;
    }
    const rows = await read.call(this.context.stores.usage);
    // Nothing recorded yet: leave the marker unwritten rather than commit it
    // for an empty ledger. The next launch's read is as cheap.
    if (!rows || rows.length === 0) {
      return;
    }
    const claudeTurns = new Map<string, Map<string, ClaudeTurnTimes>>();
    for (const threadId of new Set(rows.flatMap((row) => row.backend === "claude" ? [row.threadId] : []))) {
      try {
        claudeTurns.set(threadId, claudeTurnTimes(await this.context.providers.claude.readThread(threadId)));
      } catch {
        // A deleted transcript leaves the turn's stored times in place.
      }
    }
    const repairs = rows.flatMap((row) => {
      const claude = row.backend === "claude" && row.turnId
        ? claudeTurns.get(row.threadId)?.get(row.turnId)
        : undefined;
      const startedAt = claude?.startedAt ?? readUuidV7Timestamp(row.turnId);
      const completedAt = row.completedAt === undefined || row.completedAtInferred
        ? claude?.completedAt
        : undefined;
      return startedAt === undefined && completedAt === undefined
        ? []
        : [{
            usageTurnId: row.usageTurnId,
            ...(startedAt !== undefined ? { startedAt } : {}),
            ...(completedAt !== undefined ? { completedAt } : {}),
          }];
    });
    const repaired = await repair.call(this.context.stores.usage, { repairs });
    backendRegistryLog.info("usage-turn-time-repair", {
      candidates: rows.length,
      recovered: repairs.length,
      repaired,
    });
  }

  /**
   * Record an end for pricing-ledger turns that no process will ever finish.
   *
   * Each turn runs in an app-server or ACP agent process that one registry
   * owns, and only that registry receives its events. When this is the
   * profile's only live runtime, no process can still report an end for a
   * turn written before this session started, so every such open turn is
   * over. Another live runtime may be running one of its own, and a turn
   * waiting on an approval writes no usage at all, so then only turns with no
   * usage write for a day qualify. The repair marks each end as inferred, so
   * if such a turn is still live, its terminal event replaces the estimate.
   */
  async repairUnfinishedThreadUsageTurnsAtStartup(): Promise<void> {
    const repair = this.context.stores.usage.repairUnfinishedThreadUsageTurns;
    if (!repair) {
      return;
    }
    const liveRuntimeInstanceIds = this.host().liveProfileRuntimeInstanceIds();
    if (!liveRuntimeInstanceIds) {
      return;
    }
    const soleRuntime = liveRuntimeInstanceIds.every(
      (instanceId) => instanceId === this.host().runtimeInstanceId,
    );
    const result = await repair.call(this.context.stores.usage, {
      lastWriteBefore: soleRuntime
        ? this.host().registrySessionStartedAt
        : Math.min(
            this.host().registrySessionStartedAt,
            Date.now() - USAGE_TURN_REPAIR_PEER_QUIET_MS,
          ),
      limit: USAGE_TURN_REPAIR_BATCH_LIMIT,
    });
    if (result.repaired > 0) {
      backendRegistryLog.info("usage-turn-startup-repair", {
        ...result,
        soleRuntime,
      });
    }
  }

  /**
   * Closing stops the app-server and ACP agent processes, which ends every
   * turn still running in them, and no terminal event will arrive for any of
   * them. Record the stop as their end.
   */
  async completeRunningThreadUsageTurnsAtShutdown(): Promise<void> {
    const complete = this.context.stores.usage.completeThreadUsageTurns;
    if (!complete) {
      return;
    }
    const turns = Array.from(this.host().activeTurnKeys).flatMap((key) => {
      const parsed = parseActiveTurnKey(key);
      return parsed ? [parsed] : [];
    });
    if (turns.length === 0) {
      return;
    }
    try {
      await complete.call(this.context.stores.usage, { completedAt: Date.now(), turns });
    } catch (error) {
      backendRegistryLog.warn("usage-turn-shutdown-completion-failed", {
        message: error instanceof Error ? error.message : String(error),
        turns: turns.length,
      });
    }
  }

  /**
   * Pricing's cards: only those its usage lines name, so a thread's thousands
   * of policy gates with no line are never read. The savings fallback sums
   * every gate, so it gets the stored totals, with each live gate swapped in
   * for its stored version.
   */
  async readPricingSubAgents(params: {
    backend: AppServerBackendKind;
    threadId: string;
    pricing: ThreadPricingLedger | undefined;
  }): Promise<Pick<ThreadDisplayCards, "pricingSubAgents" | "tokenMiserGateTotals">> {
    const { backend, threadId } = params;
    const liveIds = this.host().liveSubAgentMonitorIds(backend, threadId);
    const named = new Set(liveIds);
    for (const line of params.pricing?.lines ?? []) {
      if (line.sourceItemId) named.add(line.sourceItemId);
    }
    const stored = await this.context.stores.subAgents.getThreadSubAgents({ backend, threadId, monitorIds: [...named] });
    const storedTotals = await this.context.stores.usage.readThreadTokenMiserGateTotals({ backend, threadId });
    if (backend !== "codex") return { pricingSubAgents: stored, tokenMiserGateTotals: storedTotals };
    const liveGates = this.listLiveTokenMiserSubAgents(threadId).filter(isTokenMiserSubAgent);
    const liveGateIds = new Set(liveGates.map((card) => card.monitorId));
    const replaced = stored.filter((card) => liveGateIds.has(card.monitorId) && isTokenMiserSubAgent(card));
    return {
      pricingSubAgents: this.mergeLiveTokenMiserSubAgents(threadId, stored),
      tokenMiserGateTotals: addTokenMiserGateAccountingTotals(
        addTokenMiserGateAccountingTotals(
          storedTotals,
          totalTokenMiserGateAccountings(liveGates.map((card) => card.tokenMiserAccounting)),
        ),
        totalTokenMiserGateAccountings(replaced.map((card) => card.tokenMiserAccounting)),
        -1,
      ),
    };
  }

  async usageAccountForTurn(
    backend: AppServerBackendKind,
    threadId: string,
    turnId: string | undefined,
  ): Promise<string | undefined> {
    return turnId ? await this.usageTurnAccounts.get(JSON.stringify([backend, threadId, turnId])) : undefined;
  }

  async persistReplayUsageLines(
    replay: AppServerThreadReplay,
  ): Promise<void> {
    if (typeof this.context.stores.usage.upsertThreadUsageLine !== "function") {
      return;
    }
    const lines = collectThreadUsageLinesFromReplay(replay);
    for (const line of lines) {
      logUnpricedThreadUsageLine(line);
      await this.context.stores.usage.upsertThreadUsageLine({ line });
    }
  }

  withLiveTokenMiserNavigationSnapshot(
    snapshot: NavigationSnapshot,
  ): NavigationSnapshot {
    if (this.liveTokenMiserSubAgents.size === 0) {
      return snapshot;
    }
    let changed = false;
    const threads = snapshot.threads.map((thread) => {
      if (thread.source !== "codex" || thread.federation) {
        return thread;
      }
      const live = this.liveTokenMiserSubAgents.get(thread.id);
      if (!live || live.size === 0) {
        return thread;
      }
      changed = true;
      return {
        ...thread,
        subAgents: this.mergeLiveTokenMiserSubAgents(
          thread.id,
          thread.subAgents,
        ),
      };
    });
    return changed ? { ...snapshot, threads, unchanged: false } : snapshot;
  }

  /** Gate cards not yet persisted; at most one turn's worth. */
  listLiveTokenMiserSubAgents(threadId: string): ThreadSubAgentSummary[] {
    return [...this.liveTokenMiserSubAgents.get(threadId)?.values() ?? []];
  }

  /**
   * Everything `mergeLiveTokenMiserSubAgents` overlays on stored cards, for a
   * revision that changes with live state without hashing stored cards.
   */
  readLiveSubAgentRevisionSource(threadId: string): unknown {
    return [
      this.listLiveTokenMiserSubAgents(threadId),
      [...this.subAgentMonitorService.liveCodexNativeSubAgentUsageRecords.get(threadId) ?? []],
    ];
  }

  mergeLiveTokenMiserSubAgents(
    threadId: string,
    persisted: readonly ThreadSubAgentSummary[] | undefined,
  ): ThreadSubAgentSummary[] {
    const byId = new Map(
      (persisted ?? []).map((subAgent) => [subAgent.monitorId, subAgent]),
    );
    for (const subAgent of this.liveTokenMiserSubAgents.get(threadId)?.values()
      ?? []) {
      byId.set(subAgent.monitorId, subAgent);
    }
    // Only the usage is live; status, name and task stay the stored card's.
    for (const [monitorId, live] of this.subAgentMonitorService.liveCodexNativeSubAgentUsageRecords.get(threadId)
      ?? []) {
      const card = byId.get(monitorId);
      if (card) {
        byId.set(monitorId, withLiveCodexNativeSubAgentUsage(card, live));
      }
    }
    return [...byId.values()].sort((left, right) =>
      right.updatedAt - left.updatedAt
      || right.monitorId.localeCompare(left.monitorId)
    );
  }

  async readThreadPricingWithLiveTokenMiser(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadPricingLedger> {
    const pricing = typeof this.context.stores.usage.readThreadPricing === "function"
      ? await this.context.stores.usage.readThreadPricing(params)
      : { lines: [], summaries: [] };
    // Compactions ride the pricing payload rather than a channel of their own:
    // their whole purpose here is to explain a cold replay already in `lines`,
    // and splitting them would let the two arrive out of step.
    const compactions = await this.context.stores.usage.listThreadCompactions?.(params);
    const withCompactions = compactions?.length
      ? { ...pricing, compactions }
      : pricing;
    if (params.backend !== "codex") {
      return withCompactions;
    }
    const merged = mergeThreadPricingLines(
      withCompactions,
      [
        ...(this.liveTokenMiserUsageLines.get(params.threadId)?.values() ?? []),
        // Held worker lines, for the parent's ledger and the worker's own.
        ...[...this.subAgentMonitorService.liveCodexNativeSubAgentUsageRecords.values()]
          .flatMap((lives) => [...lives.values()])
          .flatMap((live) => [...live.lines.values()])
          .filter((line) =>
            line.parentThreadId === params.threadId || line.threadId === params.threadId),
      ],
    );
    const localIds = new Set(this.host().resolveCodexLocalModelIdsFn());
    const models = this.host().codexBackendSummary?.launchpadOptions?.models ?? [];
    const labels = new Map(models.map((model) => [model.id, model.label]));
    let changedPricing = false;
    const lines = merged.lines.map((line) => {
      const isCodexModel = line.backend === "codex"
        && (line.scope !== "monitor" || line.provider === "openai" || line.provider === "local");
      const label = isCodexModel && line.model ? labels.get(line.model) : undefined;
      const decorated = label ? { ...line, modelLabel: label } : line;
      // A helper can belong to another backend while sharing this ledger.
      if (isCodexModel && line.model && localIds.has(line.model)) {
        changedPricing = true;
        return priceLocalModelUsage(decorated);
      }
      return decorated;
    });
    return changedPricing ? mergeThreadPricingLines(merged, lines) : { ...merged, lines };
  }

  async emitThreadPricingUpdated(params: {
    activeTurnIds?: readonly string[];
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const key = buildThreadIdentityKey(params.backend, params.threadId);
    const previous = this.threadPricingPublications.get(key);
    const pending = (previous ?? Promise.resolve()).catch(() => undefined)
      .then(() => this.publishThreadPricingUpdated(params));
    this.threadPricingPublications.set(key, pending);
    try { await pending; }
    finally { if (this.threadPricingPublications.get(key) === pending) this.threadPricingPublications.delete(key); }
  }

  private async publishThreadPricingUpdated(params: {
    activeTurnIds?: readonly string[];
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const pricing = await this.readThreadPricingWithLiveTokenMiser({
      backend: params.backend,
      threadId: params.threadId,
    });
    const overlay = this.host().spendAlertPolicy.threadSpendEnabled
      ? await this.context.stores.threads.getThreadOverlayState({
          backend: params.backend,
          threadId: params.threadId,
        })
      : undefined;
    const detectedSpendAlerts = detectUsageSpendAlerts({
      ...(params.activeTurnIds ? { activeTurnIds: params.activeTurnIds } : {}),
      backend: params.backend,
      policy: this.host().spendAlertPolicy,
      pricing,
      threadId: params.threadId,
      threadSpendAlerted:
        overlay?.threadSpendAlertedAt !== undefined
        || overlay?.threadSpendAlertPending !== undefined,
      triggeredAlertIds: this.triggeredSpendAlertIds,
    });
    for (const alert of detectedSpendAlerts) {
      if (alert.kind === "active-turn-spend") {
        this.triggeredSpendAlertIds.add(alert.alertId);
      }
    }
    const detectedThreadSpendAlert = detectedSpendAlerts.find(
      (alert) => alert.kind === "thread-spend",
    );
    const pendingOverlay = detectedThreadSpendAlert
      ? await this.context.stores.toolAccounting.setThreadSpendAlertPending?.({
          alert: detectedThreadSpendAlert,
          backend: params.backend,
          threadId: params.threadId,
        })
      : overlay;
    const pendingThreadSpendAlert =
      pendingOverlay?.threadSpendAlertPending
      ?? detectedThreadSpendAlert;
    const triggeredSpendAlerts = [
      ...detectedSpendAlerts.filter(
        (alert) => alert.kind === "active-turn-spend",
      ),
      ...(pendingThreadSpendAlert ? [pendingThreadSpendAlert] : []),
    ];
    await this.context.emit({
      backend: params.backend,
      notification: {
        method: "thread/pricing/updated",
        params: {
          threadId: params.threadId,
          pricing,
          ...(triggeredSpendAlerts.length > 0
            ? { triggeredSpendAlerts }
            : {}),
        },
      },
    });
  }

  async emitThreadToolAccountingUpdated(params: {
    backend: AppServerBackendKind;
    threadId: string;
    triggeredAlerts?: ThreadToolInvocationAlert[];
  }): Promise<void> {
    if (typeof this.context.stores.toolAccounting.readThreadToolAccounting !== "function") {
      return;
    }
    // Live displays invalidate and read their own accounting on demand. The
    // incident projection only needs the SQLite invocation/alert records;
    // enriching this event scans Token Miser files only to discard the result.
    const toolAccounting = await this.context.stores.toolAccounting.readThreadToolAccounting({
      backend: params.backend,
      threadId: params.threadId,
    });
    /* The operator's dismissal/mute for this thread, so a freshly launched
       renderer honors a decision made in an earlier session. */
    const overlay = await this.context.stores.threads.getThreadOverlayState({
      backend: params.backend,
      threadId: params.threadId,
    });
    const subAgentOwner = this.subAgentMonitorService.resolveSubAgentThreadOwner(params);
    /* A child is expected to spend its own turn budget. Keep the raw
       accounting record for diagnostics, but do not turn that expected cost
       into an operator-facing incident. */
    const triggeredAlerts =
      params.backend === "codex" && subAgentOwner.isSubAgent
        ? undefined
        : params.triggeredAlerts;
    await this.context.emit({
      backend: params.backend,
      notification: {
        method: "thread/toolAccounting/updated",
        params: {
          threadId: params.threadId,
          toolAccounting,
          ...(overlay?.toolIncidentNotice
            ? { incidentNotice: overlay.toolIncidentNotice }
            : {}),
          ...(triggeredAlerts?.length
            ? { triggeredAlerts }
            : {}),
        },
      },
    });
  }

  async withTokenMiserAccounting(params: {
    accounting: ThreadToolAccounting;
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadToolAccounting> {
    const host = this.host();
    if (params.backend !== "codex" || !host.tokenMiserStore) {
      return params.accounting;
    }
    try {
      await this.tokenMiserStoragePreparation;
      const metadata = await host.tokenMiserStore.listMetadata(params.threadId);
      const tokenMiser = await host.tokenMiserStore.summarizeThreadUsage(
        params.threadId,
        metadata,
      );
      // One replay index serves the interception rows and the savings total.
      const replays = indexTokenMiserCachedReplays(
        params.accounting.invocations,
      );
      const withReplays = withLegacyTokenMiserReplayAccounting(
        tokenMiser,
        replays,
      );
      const savings = await this.buildTokenMiserThreadSavings({
        backend: params.backend,
        entries: metadata,
        replays,
        threadId: params.threadId,
      });
      return {
        ...params.accounting,
        tokenMiser: savings ? { ...withReplays, savings } : withReplays,
      };
    } catch (error) {
      backendRegistryLog.warn("failed to read Token Miser thread accounting", {
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
      return params.accounting;
    }
  }

  deriveLiveThreadTokenUsage(params: {
    appendLatestUsage?: boolean;
    backend: AppServerBackendKind;
    observationSequence?: number;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): DerivedLiveThreadTokenUsage {
    const records = readTaskMonitorTokenUsageRecords(params.tokenUsage);
    if (!records) {
      return { attributed: false, turnTokenUsage: params.tokenUsage };
    }

    if (!params.turnId) {
      return {
        // A "last" snapshot is this request's own usage; anything else here is
        // a bare/whole payload we can't attribute to the turn.
        attributed: Boolean(records.latestUsage),
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
    if (!records.totalUsage) {
      const currentUsage = records.latestUsage ?? records.currentUsage;
      if (!currentUsage) {
        return { attributed: false, turnTokenUsage: params.tokenUsage };
      }
      const previousAggregate = this.liveThreadUsageAggregates.get(key);
      const turnTokenUsage =
        params.appendLatestUsage
        && records.latestUsage
        && previousAggregate
          ? taskMonitorTokenUsageEqual(
              previousAggregate.latestUsage,
              records.latestUsage,
            )
            ? previousAggregate.usage
            : addTaskMonitorTokenUsage(
                previousAggregate.usage,
                records.latestUsage,
              ) ?? records.latestUsage
          : currentUsage;
      this.liveThreadUsageAggregates.set(key, {
        ...(records.latestUsage ? { latestUsage: records.latestUsage } : {}),
        usage: turnTokenUsage,
      });
      return {
        attributed: Boolean(records.latestUsage),
        turnTokenUsage,
      };
    }

    let baseline = this.liveThreadUsageBaselines.get(key);
    let seededBaselineTokenUsage: TaskMonitorTokenUsageBreakdown | undefined;
    const cumulativeKey = [params.backend, params.threadId].join(":");
    const observationSequence = params.observationSequence;
    const priorCumulative =
      params.backend === "codex" && observationSequence !== undefined
        ? this.liveCodexThreadCumulativeUsage.get(cumulativeKey)
        : undefined;
    if (
      !baseline
      && priorCumulative
      && priorCumulative.turnId !== params.turnId
      && observationSequence !== undefined
      && priorCumulative.observationSequence < observationSequence
      && canSubtractTaskMonitorTokenUsage(
        records.totalUsage,
        priorCumulative.usage,
      )
    ) {
      baseline = priorCumulative.usage;
      this.liveThreadUsageBaselines.set(key, baseline);
    }
    if (!baseline && records.latestUsage) {
      baseline = subtractTaskMonitorTokenUsage(
        records.totalUsage,
        records.latestUsage,
      );
      if (baseline) {
        this.liveThreadUsageBaselines.set(key, baseline);
        seededBaselineTokenUsage = baseline;
      }
    }

    if (
      params.backend === "codex"
      && params.turnId
      && observationSequence !== undefined
      // A superseded turn may refresh its own bounded usage, but it can never
      // own the thread cursor again, even when cumulative totals are equal.
      && !this.liveCodexThreadUsageCeilings.has(key)
      && (
        !priorCumulative
        || (
          observationSequence > priorCumulative.observationSequence
          && canSubtractTaskMonitorTokenUsage(
            records.totalUsage,
            priorCumulative.usage,
          )
        )
      )
    ) {
      if (priorCumulative && priorCumulative.turnId !== params.turnId) {
        const priorTurnKey = [
          params.backend,
          params.threadId,
          priorCumulative.turnId,
          "live-token-usage",
        ].join(":");
        if (!this.liveCodexThreadUsageCeilings.has(priorTurnKey)) {
          this.liveCodexThreadUsageCeilings.set(priorTurnKey, priorCumulative.usage);
        }
      }
      this.liveCodexThreadCumulativeUsage.set(cumulativeKey, {
        observationSequence,
        turnId: params.turnId,
        usage: records.totalUsage,
      });
    }

    const derivedTurnUsage = baseline
      ? subtractTaskMonitorTokenUsage(records.totalUsage, baseline)
      : undefined;
    const turnTokenUsage =
      derivedTurnUsage
      ?? records.latestUsage
      ?? records.currentUsage
      ?? records.totalUsage;
    this.liveThreadUsageAggregates.set(key, {
      ...(records.latestUsage ? { latestUsage: records.latestUsage } : {}),
      usage: turnTokenUsage,
    });
    return {
      // Attributed when we computed a per-turn delta or have this request's
      // "last" snapshot; not when we fall back to the whole cumulative total.
      attributed: Boolean(derivedTurnUsage) || Boolean(records.latestUsage),
      cumulativeTokenUsage: records.totalUsage,
      turnTokenUsage,
      ...(seededBaselineTokenUsage ? { seededBaselineTokenUsage } : {}),
    };
  }

  private observeLiveThreadRequestUsage(params: {
    backend: AppServerBackendKind;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): readonly TaskMonitorTokenUsageBreakdown[] | undefined {
    if (!params.turnId) {
      return undefined;
    }
    const key = [
      params.backend,
      params.threadId,
      params.turnId,
      "live-token-usage",
    ].join(":");
    const folded = foldLiveThreadRequestUsage({
      current: this.liveThreadRequestUsage.get(key),
      tokenUsage: params.tokenUsage,
    });
    if (!folded) {
      return undefined;
    }
    this.liveThreadRequestUsage.set(key, folded);
    return folded.requests;
  }

  // Observe one `thread/tokenUsage/updated` and fold any newly-completed model
  // request into the turn's context-replay tally. Returns the current tally for
  // the turn (unchanged on duplicate/sub-threshold updates) so the usage line
  // keeps its frozen counts across re-emissions. Counts nothing for the
  // inherited baseline of a forked thread: the cursor is seeded from
  // `total.inputTokens - last.inputTokens`, so only the observed request counts,
  // never the unobserved history already in `total`.
  observeLiveThreadContextReplay(params: {
    backend: AppServerBackendKind;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): ObservedContextReplayTally | undefined {
    if (!params.turnId) {
      return undefined;
    }
    const threadKey = [params.backend, params.threadId].join(":");
    const turnKey = [params.backend, params.threadId, params.turnId].join(":");
    const priorCursor = this.liveThreadReplayInputCursor.get(threadKey);
    const priorTally = this.liveThreadReplayObservations.get(turnKey);
    const { cursor, tally } = foldObservedContextReplay({
      cursor: priorCursor,
      tally: priorTally,
      tokenUsage: params.tokenUsage,
    });
    if (cursor) {
      this.liveThreadReplayInputCursor.set(threadKey, cursor);
    }
    if (tally) {
      this.liveThreadReplayObservations.set(turnKey, tally);
    }
    this.logObservedContextReplayDecision({
      backend: params.backend,
      cursor,
      priorCursor,
      priorTally,
      tally,
      threadId: params.threadId,
      tokenUsage: params.tokenUsage,
      turnId: params.turnId,
    });
    return tally;
  }

  private observeLiveThreadContextWindow(params: {
    backend: AppServerBackendKind;
    threadId: string;
    tokenUsage: unknown;
    turnId?: string;
  }): LiveThreadContextWindowObservation | undefined {
    if (!params.turnId) {
      return undefined;
    }
    const latest = readTaskMonitorTokenUsageRecords(
      params.tokenUsage,
    )?.latestUsage;
    const finalContextTokens = latest?.totalTokens;
    const modelContextWindow = readUsageNumber(
      params.tokenUsage,
      ["modelContextWindow", "model_context_window"],
    );
    if (
      typeof finalContextTokens !== "number"
      || finalContextTokens < 0
      || typeof modelContextWindow !== "number"
      || modelContextWindow <= 0
    ) {
      return undefined;
    }
    const key = [params.backend, params.threadId, params.turnId].join(":");
    const prior = this.liveThreadContextWindowObservations.get(key);
    const observation = {
      finalContextTokens,
      modelContextWindow,
      peakContextTokens: Math.max(
        finalContextTokens,
        prior?.peakContextTokens ?? 0,
      ),
    };
    this.liveThreadContextWindowObservations.set(key, observation);
    return observation;
  }

  // Dev-only diagnostic: one line per genuinely new model request explaining how
  // it was classified (hot/cold/not-counted) and the numbers behind the
  // decision — the observed `last.input`/`cached`, the prior-context snapshot,
  // the replayed portion, and the tokens attributed. Pure duplicate/no-op
  // re-emissions are not logged. Reconstructs the decision from the tally delta
  // rather than re-running classification, so the pure fold stays untouched.
  // Gated on isDevelopment, so it does no parsing work in packaged builds.
  private logObservedContextReplayDecision(params: {
    backend: AppServerBackendKind;
    cursor?: ObservedContextReplayCursor;
    priorCursor?: ObservedContextReplayCursor;
    priorTally?: ObservedContextReplayTally;
    tally?: ObservedContextReplayTally;
    threadId: string;
    tokenUsage: unknown;
    turnId: string;
  }): void {
    if (!isDevelopment) {
      return;
    }
    const coldDelta =
      (params.tally?.coldReplayCount ?? 0) - (params.priorTally?.coldReplayCount ?? 0);
    const hotDelta =
      (params.tally?.hotReplayCount ?? 0) - (params.priorTally?.hotReplayCount ?? 0);
    const priorCumulative = params.priorCursor?.cumulativeInputTokens;
    const nextCumulative = params.cursor?.cumulativeInputTokens;
    const advanced =
      typeof nextCumulative === "number" &&
      (priorCumulative === undefined || nextCumulative > priorCumulative);
    // Only a genuinely new request (cumulative input grew) or a counted replay
    // is worth a line; skip duplicate re-emissions and no-ops.
    if (!advanced && coldDelta === 0 && hotDelta === 0) {
      return;
    }
    const last = readTaskMonitorTokenUsageRecords(params.tokenUsage)?.latestUsage;
    const lastInput = typeof last?.inputTokens === "number" ? last.inputTokens : undefined;
    const cached =
      typeof last?.cachedInputTokens === "number" ? last.cachedInputTokens : undefined;
    const priorContext = params.priorCursor?.lastContextTokens;
    const replayed =
      typeof lastInput === "number"
        ? typeof priorContext === "number" && priorContext > 0
          ? Math.min(lastInput, priorContext)
          : lastInput
        : undefined;
    const classification =
      coldDelta > 0 ? "cold" : hotDelta > 0 ? "hot" : "not-counted";
    const attributed =
      coldDelta > 0
        ? (params.tally?.coldReplayUncachedTokens ?? 0) -
          (params.priorTally?.coldReplayUncachedTokens ?? 0)
        : hotDelta > 0
          ? (params.tally?.hotReplayCachedTokens ?? 0) -
            (params.priorTally?.hotReplayCachedTokens ?? 0)
          : 0;
    logDebug("contextReplay:classify", {
      attributed,
      backend: params.backend,
      cached,
      classification,
      coldCount: params.tally?.coldReplayCount ?? 0,
      hotCount: params.tally?.hotReplayCount ?? 0,
      lastInput,
      priorContext,
      replayed,
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }

  // Drop a turn's in-memory replay tally once the turn ends. The final counts
  // are already frozen on the persisted usage line, so this only bounds the
  // per-turn map's growth over a long session. The per-thread input cursor is
  // deliberately kept: it lets any late duplicate re-emission for this turn
  // dedup (its cumulative input does not grow, so it is a no-op) instead of
  // re-seeding and re-counting from scratch.
  forgetCompletedTurnReplayObservations(event: AgentEvent): void {
    const method = event.notification.method;
    if (method !== "turn/completed" && method !== "turn/failed") {
      return;
    }
    const threadId = event.notification.params.threadId;
    const turnId = turnIdFromTerminalNotification(event.notification);
    if (!threadId || !turnId) {
      return;
    }
    this.liveThreadReplayObservations.delete(
      [event.backend, threadId, turnId].join(":"),
    );
    this.liveThreadContextWindowObservations.delete(
      [event.backend, threadId, turnId].join(":"),
    );
  }

  registerLiveThreadUsageEmitWork(
    backend: AppServerBackendKind,
    threadId: string,
  ): LiveThreadUsageEmitWork {
    const derivationKey = [backend, threadId].join(":");
    const precedingDerivation =
      this.liveThreadUsageDerivationTails.get(derivationKey)
      ?? Promise.resolve();
    let settleDerivation!: () => void;
    const derivationSettled = new Promise<void>((resolve) => {
      settleDerivation = resolve;
    });
    const derivationTail = precedingDerivation.then(() => derivationSettled);
    this.liveThreadUsageDerivationTails.set(derivationKey, derivationTail);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const work = {
      backend,
      derivationFinished: false,
      derivationKey,
      derivationTail,
      observationSequence: ++this.liveThreadUsageObservationSequence,
      precedingDerivation,
      settleDerivation,
      settled,
      settle,
      threadId,
    };
    this.liveThreadUsageEmitWork.add(work);
    return work;
  }

  private finishLiveThreadUsageDerivation(
    work: LiveThreadUsageEmitWork,
  ): void {
    if (work.derivationFinished) {
      return;
    }
    work.derivationFinished = true;
    work.settleDerivation();
    void work.derivationTail.then(() => {
      if (
        this.liveThreadUsageDerivationTails.get(work.derivationKey)
        === work.derivationTail
      ) {
        this.liveThreadUsageDerivationTails.delete(work.derivationKey);
      }
    });
  }

  finishLiveThreadUsageEmitWork(
    work: LiveThreadUsageEmitWork,
  ): void {
    // If an earlier pipeline stage failed before recordLiveThreadUsage, release
    // this arrival's derivation slot so later usage cannot deadlock behind it.
    this.finishLiveThreadUsageDerivation(work);
    if (!this.liveThreadUsageEmitWork.delete(work)) {
      return;
    }
    work.settle();
  }

  async waitForLiveThreadUsageEmitWork(params?: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    const pending = [...this.liveThreadUsageEmitWork]
      .filter(
        (work) =>
          !params
          || (work.backend === params.backend && work.threadId === params.threadId),
      )
      .map((work) => work.settled);
    await Promise.all(pending);
  }

  /** Usage activities live in their own table, not the overlay row. */
  async readThreadUsageActivities(
    backend: AppServerBackendKind,
    threadIds: readonly string[],
  ): Promise<Record<string, AppServerThreadActivityEntry[]>> {
    if (threadIds.length === 0 || !this.context.stores.usage.readThreadUsageActivities) return {};
    return await this.context.stores.usage.readThreadUsageActivities({ backend, threadIds: [...threadIds] });
  }

  async recordLiveThreadUsage(
    event: AgentEvent,
    work?: LiveThreadUsageEmitWork,
  ): Promise<void> {
    const notification = event.notification;
    if (
      notification.method !== "thread/tokenUsage/updated"
      || !work
    ) {
      return;
    }
    const threadId = notification.params.threadId;
    if (!threadId) {
      this.finishLiveThreadUsageDerivation(work);
      return;
    }
    const explicitTurnId = notification.params.turnId ?? undefined;
    const rememberedCompletedTurn = this.recentlyCompletedThreadUsageTurns.get(
      [event.backend, threadId].join(":"),
    );
    const recentlyCompletedTurn =
      rememberedCompletedTurn
      && (!explicitTurnId || explicitTurnId === rememberedCompletedTurn.turnId)
      ? rememberedCompletedTurn
      : undefined;
    const turnId = explicitTurnId ?? recentlyCompletedTurn?.turnId;
    await work.precedingDerivation;
    let derivedUsage: DerivedLiveThreadTokenUsage | undefined;
    let contextDrop: ObservedContextWindowDrop | undefined;
    let observedReplays: ObservedContextReplayTally | undefined;
    let contextWindow: LiveThreadContextWindowObservation | undefined;
    let requestTokenUsages: readonly TaskMonitorTokenUsageBreakdown[] | undefined;
    try {
      if (
        event.backend === "codex"
        && this.subAgentMonitorService.codexNativeSubAgentParentRecords.has(threadId)
      ) {
        return;
      }
      if (this.subAgentMonitorService.isTaskMonitorThread({ backend: event.backend, threadId })) {
        return;
      }
      if (turnId) {
        const reviewKey = buildReviewSubAgentKey(
          event.backend,
          threadId,
          turnId,
        );
        if (
          this.managedReviewService.activeReviewSubAgentRecords.has(reviewKey)
          || this.managedReviewService.reviewSubAgentRecordsByReviewTurn.has(reviewKey)
        ) {
          return;
        }
      }

      const tokenUsage = notification.params.tokenUsage;
      const usageCeiling = event.backend === "codex" && turnId
        ? this.liveCodexThreadUsageCeilings.get(
            [event.backend, threadId, turnId, "live-token-usage"].join(":"),
          )
        : undefined;
      const cumulativeUsage = readTaskMonitorTokenUsageRecords(tokenUsage)?.totalUsage;
      if (
        usageCeiling
        && cumulativeUsage
        && (cumulativeUsage.totalTokens ?? 0) > (usageCeiling.totalTokens ?? 0)
      ) {
        // A stale turn id (including the turnless completion fallback) cannot
        // own a thread snapshot that already includes a subsequent turn.
        // Reject before advancing pricing, request, and replay cursors.
        return;
      }
      derivedUsage = this.deriveLiveThreadTokenUsage({
        appendLatestUsage: Boolean(recentlyCompletedTurn),
        backend: event.backend,
        observationSequence: work.observationSequence,
        threadId,
        tokenUsage,
        turnId,
      });
      requestTokenUsages = this.observeLiveThreadRequestUsage({
        backend: event.backend,
        threadId,
        tokenUsage,
        turnId,
      });
      contextDrop = detectObservedContextWindowDrop({
        cursor: this.liveThreadReplayInputCursor.get(
          [event.backend, threadId].join(":"),
        ),
        tokenUsage,
      });
      observedReplays = this.observeLiveThreadContextReplay({
        backend: event.backend,
        threadId,
        tokenUsage,
        turnId,
      });
      contextWindow = this.observeLiveThreadContextWindow({
        backend: event.backend,
        threadId,
        tokenUsage,
        turnId,
      });
    } finally {
      // Publish the cumulative cursor before any overlay or sqlite await lets
      // a later arrival overtake this derivation.
      this.finishLiveThreadUsageDerivation(work);
    }
    if (!derivedUsage) {
      return;
    }
    if (contextDrop) {
      await this.handleInferredThreadCompaction({
        backend: event.backend,
        contextDrop,
        threadId,
        turnId,
      });
    }

    // Six scalars and this turn's usage row, never the whole overlay: this
    // runs on every token-usage event.
    const overlay = this.context.stores.usage.readThreadUsageSettings
      ? await this.context.stores.usage.readThreadUsageSettings({ backend: event.backend, threadId })
      : await this.context.stores.threads.getThreadOverlayState({ backend: event.backend, threadId });
    const turnUsageActivity = turnId && this.context.stores.usage.readThreadUsageActivityForTurn
      ? await this.context.stores.usage.readThreadUsageActivityForTurn({ backend: event.backend, threadId, turnId })
      : undefined;
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
    const reasoningEffort =
      readUsageString(tokenUsage, [
        "reasoningEffort",
        "reasoning_effort",
        "effort",
      ]) ??
      overlay?.reasoningEffort;
    const resolvedUsageTiming = resolveLiveThreadUsageTiming({
      activity: turnUsageActivity,
      reportedStartedAt: turnId
        ? this.usageTurnStartTimes.get(JSON.stringify([event.backend, threadId, turnId]))
        : undefined,
      turnId,
    });
    const usageTiming = {
      ...resolvedUsageTiming,
      ...(recentlyCompletedTurn?.completedAt !== undefined
        && resolvedUsageTiming.completedAt === undefined
          ? { completedAt: recentlyCompletedTurn.completedAt }
          : {}),
      ...(recentlyCompletedTurn?.startedAt !== undefined
        && resolvedUsageTiming.startedAt === undefined
          ? { startedAt: recentlyCompletedTurn.startedAt }
          : {}),
    };
    const line = buildLiveThreadUsageLine({
      attributed: derivedUsage.attributed,
      backend: event.backend,
      cumulativeTokenUsage: derivedUsage.cumulativeTokenUsage,
      ...usageTiming,
      fastMode,
      contextWindow,
      model,
      observedReplays,
      reasoningEffort,
      requestTokenUsages,
      serviceTier,
      threadId,
      tokenUsage: derivedUsage.turnTokenUsage,
      turnId,
    });
    if (!line) {
      return;
    }
    if (event.backend === "claude") {
      const reported = readRecord(tokenUsage)?.claudeCostUSD;
      if (typeof reported === "number" && Number.isFinite(reported) && reported >= 0) {
        // The runtime accounts for cache creation, model routing, compaction,
        // and subagents. Its estimate outranks a catalog guess. Component
        // prices are unavailable; never fabricate their allocation.
        line.totalCostMicros = Math.round(reported * 1_000_000);
        line.priceStatus = "priced";
        line.provider = "anthropic";
        line.pricingBasis = "provider-reported";
        line.pricingCatalogId = undefined;
        line.pricingCatalogVersion = undefined;
        line.pricingRateId = undefined;
        line.priceUnavailableReason = undefined;
        line.uncachedInputCostMicros = 0;
        line.cachedInputCostMicros = 0;
        line.cacheWriteInputCostMicros = 0;
        line.outputCostMicros = 0;
        line.settingsSource = "event";
        line.settingsConfidence = "exact";
      }
    }
    const accountKey = await this.usageAccountForTurn(event.backend, threadId, turnId);
    if (accountKey) line.accountKey = accountKey;
    if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
      logUnpricedThreadUsageLine(line);
      const batchesLiveUsage =
        typeof this.context.stores.usage.upsertThreadUsageLines === "function";
      if (!batchesLiveUsage) {
        await this.context.stores.usage.upsertThreadUsageLine({ line });
      }
      // Best-effort: a failure here must never block the load-bearing pricing
      // write/notification path. The bulk path prepares the rare fork baseline
      // before arming its timer, so the later pricing event includes both.
      try {
        await this.captureForkBaselineUsageLine({
          backend: event.backend,
          fastMode,
          inheritedTokenUsage: derivedUsage.seededBaselineTokenUsage,
          model,
          overlay,
          serviceTier,
          threadId,
          turnId,
          usageTiming,
        });
      } catch (error) {
        backendRegistryLog.warn("fork-baseline usage capture failed", {
          backend: event.backend,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (batchesLiveUsage) {
        this.bufferLiveThreadUsageLine({
          backend: event.backend,
          line,
          observationSequence: work.observationSequence,
        });
        return;
      }
      await this.emitThreadPricingUpdated({
        ...(line.parentThreadId === undefined && line.turnId
          ? { activeTurnIds: [line.turnId] }
          : {}),
        backend: event.backend,
        threadId: line.parentThreadId ?? line.threadId,
      });
    }
  }

  private bufferLiveThreadUsageLine(
    pending: PendingLiveThreadUsageLine,
  ): void {
    const existing = this.pendingLiveThreadUsageLines.get(
      pending.line.usageLineId,
    );
    if (
      !existing
      || pending.observationSequence > existing.observationSequence
    ) {
      this.pendingLiveThreadUsageLines.set(
        pending.line.usageLineId,
        pending,
      );
    }
    this.scheduleLiveThreadUsageFlush();
  }

  private scheduleLiveThreadUsageFlush(): void {
    if (this.pendingLiveThreadUsageTimer || this.context.lifecycle.closed) {
      return;
    }
    this.pendingLiveThreadUsageTimer = setTimeout(() => {
      this.pendingLiveThreadUsageTimer = undefined;
      void this.flushLiveThreadUsageLines();
    }, LIVE_THREAD_USAGE_FLUSH_INTERVAL_MS);
    this.pendingLiveThreadUsageTimer.unref?.();
  }

  /**
   * Write buffered usage lines, then publish pricing for each thread they
   * touched. `deferPricingFor` holds back that one thread's publish and
   * returns what it would have carried, so a turn end can publish once after
   * its later writes.
   */
  flushLiveThreadUsageLines(
    options: { deferPricingFor?: { backend: AppServerBackendKind; threadId: string }; durabilityOnly?: boolean } = {},
  ): Promise<DeferredThreadPricing | undefined> {
    const flushed = this.liveThreadUsageFlushChain.then(() =>
      this.writePendingLiveThreadUsageLines(options),
    );
    this.liveThreadUsageFlushChain = flushed.then(() => undefined, () => undefined);
    return flushed.then(async (batch) => {
      const published = this.liveThreadUsagePricingChain.then(async () => {
        for (const target of batch?.pricingTargets ?? []) {
          try {
            await this.emitThreadPricingUpdated({
              ...(target.activeTurnIds.size > 0 ? { activeTurnIds: [...target.activeTurnIds] } : {}),
              backend: target.backend, threadId: target.threadId,
            });
          } catch (error) {
            backendRegistryLog.warn("live thread pricing update failed", {
              backend: target.backend, threadId: target.threadId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      });
      this.liveThreadUsagePricingChain = published.catch(() => undefined);
      if (!options.durabilityOnly) await published;
      return batch?.deferredPricing;
    }).catch(async (error: unknown) => {
      // Hydration must not supersede rows whose delayed insert could still
      // land afterward. Timer/terminal callers retain their retry behavior.
      if (options.durabilityOnly) throw error;
      await this.liveThreadUsagePricingChain;
      return undefined;
    });
  }

  private async writePendingLiveThreadUsageLines(
    options: { deferPricingFor?: { backend: AppServerBackendKind; threadId: string } } = {},
  ): Promise<LiveThreadUsageBatch | undefined> {
    if (this.pendingLiveThreadUsageTimer) {
      clearTimeout(this.pendingLiveThreadUsageTimer);
      this.pendingLiveThreadUsageTimer = undefined;
    }
    if (
      this.pendingLiveThreadUsageLines.size === 0
      || typeof this.context.stores.usage.upsertThreadUsageLines !== "function"
    ) {
      return undefined;
    }

    const pending = [...this.pendingLiveThreadUsageLines.values()];
    this.pendingLiveThreadUsageLines.clear();
    try {
      await this.context.stores.usage.upsertThreadUsageLines({
        lines: pending.map((entry) => entry.line),
      });
    } catch (error) {
      for (const entry of pending) {
        this.requeueFailedLiveThreadUsageLine(entry);
      }
      backendRegistryLog.warn("live thread usage batch write failed", {
        error: error instanceof Error ? error.message : String(error),
        lineCount: pending.length,
        usageLineIds: pending
          .slice(0, 10)
          .map((entry) => entry.line.usageLineId),
      });
      throw error;
    }

    const pricingTargets = new Map<
      string,
      {
        activeTurnIds: Set<string>;
        backend: AppServerBackendKind;
        threadId: string;
      }
    >();
    for (const { backend, line } of pending) {
      const threadId = line.parentThreadId ?? line.threadId;
      const key = JSON.stringify([backend, threadId]);
      const target = pricingTargets.get(key) ?? {
        activeTurnIds: new Set<string>(),
        backend,
        threadId,
      };
      if (line.parentThreadId === undefined && line.turnId) {
        target.activeTurnIds.add(line.turnId);
      }
      pricingTargets.set(key, target);
    }
    const deferred = options.deferPricingFor;
    let deferredPricing: DeferredThreadPricing | undefined;
    const publishTargets: LiveThreadUsageBatch["pricingTargets"] = [];
    for (const target of pricingTargets.values()) {
      if (
        deferred
        && target.backend === deferred.backend
        && target.threadId === deferred.threadId
      ) {
        deferredPricing = { activeTurnIds: [...target.activeTurnIds] };
        continue;
      }
      publishTargets.push(target);
    }
    return { deferredPricing, pricingTargets: publishTargets };
  }

  private requeueFailedLiveThreadUsageLine(
    pending: PendingLiveThreadUsageLine,
  ): void {
    if (this.context.lifecycle.closed) {
      // Shutdown already made its one durability attempt. Re-arming here would
      // let a timer write against a store after the registry has closed.
      return;
    }
    const newer = this.pendingLiveThreadUsageLines.get(
      pending.line.usageLineId,
    );
    if (
      !newer
      || pending.observationSequence > newer.observationSequence
    ) {
      this.pendingLiveThreadUsageLines.set(
        pending.line.usageLineId,
        pending,
      );
    }
    this.scheduleLiveThreadUsageFlush();
  }

  /**
   * On a fork's first observed turn, persist the context copied in at the fork
   * point as a zero-cost `scope: "fork-baseline"` usage line. That inherited
   * history was already billed on the parent thread; recording it as a real
   * (but $0) line stops the renderer from inventing a priced "Historical usage
   * estimate" gap for it and gives it an explicit "Fork point" card instead.
   *
   * Guarded to run at most once per fork via `forkBaselineCaptured`, and only
   * for threads with a recorded `forkSourceThreadId` — non-fork threads (whose
   * cumulative-vs-observed gaps are genuinely their own unobserved usage) are
   * left untouched.
   */
  private async captureForkBaselineUsageLine(params: {
    backend: AppServerBackendKind;
    fastMode?: boolean;
    inheritedTokenUsage?: TaskMonitorTokenUsageBreakdown;
    model?: string;
    overlay?: Pick<ThreadOverlayState, "forkSourceThreadId" | "forkBaselineCaptured">;
    serviceTier?: string;
    threadId: string;
    turnId?: string;
    usageTiming: { completedAt?: number; createdAt?: number; startedAt?: number };
  }): Promise<void> {
    if (
      !params.overlay?.forkSourceThreadId ||
      params.overlay.forkBaselineCaptured ||
      !params.inheritedTokenUsage ||
      typeof this.context.stores.usage.upsertThreadUsageLine !== "function"
    ) {
      return;
    }

    // The seeded baseline (`total − latest`) only equals the inherited fork
    // context on the fork's FIRST observed turn. If this thread already has an
    // observed turn line for a different turn, the baseline has folded this
    // thread's own earlier usage into the "inherited" amount — capturing it
    // would under-bill. Skip and latch (capturing on a later turn would be
    // wrong too). This catches the observed-earlier-turn window; a fork whose
    // first turn was never seen live still mis-attributes (known limitation).
    if (
      params.turnId &&
      (await this.threadHasObservedTurnBefore({
        backend: params.backend,
        threadId: params.threadId,
        turnId: params.turnId,
      }))
    ) {
      await this.latchForkBaselineCaptured(params.backend, params.threadId);
      return;
    }

    const forkLine = buildForkBaselineUsageLine({
      backend: params.backend,
      fastMode: params.fastMode,
      inheritedTokenUsage: params.inheritedTokenUsage,
      model: params.model,
      serviceTier: params.serviceTier,
      threadId: params.threadId,
      usageTiming: params.usageTiming,
    });
    // Persist the fork-baseline line when there are inherited tokens to
    // attribute; a fork of an empty-context parent has none, but we still latch
    // the guard below so we don't re-check every subsequent turn.
    if (forkLine) {
      await this.context.stores.usage.upsertThreadUsageLine({ line: forkLine });
    }
    await this.latchForkBaselineCaptured(params.backend, params.threadId);
  }

  private async latchForkBaselineCaptured(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<void> {
    await this.context.stores.threads.setThreadForkOrigin?.({
      backend,
      threadId,
      forkBaselineCaptured: true,
    });
  }

  /**
   * True when this thread already has a persisted turn usage line for a turn
   * OTHER than `turnId`. Used to detect that a fork's first turn is not the one
   * being observed now, so its inherited-context baseline can't be trusted.
   * Only the thread's own lines count — rolled-up child/monitor lines
   * (different `threadId`) are ignored.
   */
  private async threadHasObservedTurnBefore(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
  }): Promise<boolean> {
    if (typeof this.context.stores.usage.readThreadPricing !== "function") {
      return false;
    }
    const { lines } = await this.context.stores.usage.readThreadPricing({
      backend: params.backend,
      threadId: params.threadId,
    });
    return lines.some(
      (line) =>
        line.threadId === params.threadId &&
        line.scope === "turn" &&
        Boolean(line.turnId) &&
        line.turnId !== params.turnId,
    );
  }

  private async suggestMonitorJob(invocation: ThreadToolInvocationRecord): Promise<void> {
    const { backend, threadId, turnId } = invocation;
    if (isAcpBackendId(backend) && turnId) {
      this.pendingAcpMonitorJobSuggestions.set(taskMonitorThreadKey(backend, threadId), turnId);
      return;
    }
    // Only Codex uses native active-turn steering. ACP reminders ride an
    // existing MCP response, because ACP steering may queue a new turn.
    if (backend !== "codex" || !turnId) return;
    if (!await this.claimEligibleMonitorJobSuggestion({ backend, threadId, turnId })) return;
    await this.host().steerTurn({
      backend,
      threadId,
      expectedTurnId: turnId,
      requestId: `monitor-job-suggestion:${backend}:${threadId}:${turnId}`,
      input: [{ type: "text", text: MONITOR_JOB_SUGGESTION }],
    }, { kind: "pwragent", systemReason: "monitor-job-suggestion" });
  }

  async takeAcpMonitorJobSuggestion(
    context: ResolvedAgentToolMcpCallContext,
  ): Promise<string | undefined> {
    const { backend, threadId, turnId } = context;
    const key = taskMonitorThreadKey(backend, threadId);
    if (!isAcpBackendId(backend) || this.pendingAcpMonitorJobSuggestions.get(key) !== turnId) return;
    if (!await this.claimEligibleMonitorJobSuggestion(context)) return;
    this.pendingAcpMonitorJobSuggestions.delete(key);
    return MONITOR_JOB_SUGGESTION;
  }

  private async claimEligibleMonitorJobSuggestion(
    { backend, threadId, turnId }: ResolvedAgentToolMcpCallContext,
  ): Promise<boolean> {
    if (this.subAgentMonitorService.resolveSubAgentThreadOwner({ backend, threadId }).isSubAgent) return false;
    if (this.subAgentMonitorService.isTaskMonitorThread({ backend, threadId })) return false;
    if (!await this.monitorJobSuggestionEnabledForThread(backend, threadId)) return false;
    if (this.host().getActiveTurnForThread({ backend, threadId })?.turnId !== turnId) return false;
    return this.context.stores.toolAccounting.claimMonitorJobSuggestion({ backend, threadId, turnId });
  }

  /**
   * The Claude form of the monitor suggestion, appended to the Bash or Monitor
   * result that earned it. Claude waits on CI in one background shell or one
   * Monitor watcher, so a single CI wait qualifies; repeated foreground checks
   * qualify through the same detector Codex uses. At most once per turn.
   */
  async suggestClaudeMonitorJob(params: {
    threadId: string;
    turnId: string;
    toolName: string;
    command: string;
    toolUseId?: string;
  }): Promise<string | undefined> {
    const backend = "claude";
    const { threadId, turnId } = params;
    const normalized = normalizeToolInvocationCommand({
      toolName: params.toolName,
      command: params.command,
    });
    const repeated = this.monitorJobSuggestionDetector.observe({
      backend,
      threadId,
      turnId,
      invocationId: params.toolUseId ?? randomUUID(),
      toolName: params.toolName,
      category: normalized.category,
      normalizedCommand: normalized.normalizedCommand,
      observedAt: Date.now(),
    });
    if (!repeated && !isCiWaitCommand(params.command)) return undefined;
    if (this.subAgentMonitorService.resolveSubAgentThreadOwner({ backend, threadId }).isSubAgent) return undefined;
    if (this.subAgentMonitorService.isTaskMonitorThread({ backend, threadId })) return undefined;
    if (!await this.monitorJobSuggestionEnabledForThread(backend, threadId)) return undefined;
    if (!this.context.stores.toolAccounting.claimMonitorJobSuggestion({ backend, threadId, turnId })) return undefined;
    backendRegistryLog.info("monitor job suggestion appended to Claude tool result", {
      threadId,
      turnId,
      toolName: params.toolName,
      reason: repeated ? "repeated-check" : "ci-wait",
    });
    return CLAUDE_MONITOR_JOB_SUGGESTION;
  }

  private async monitorJobSuggestionEnabledForThread(
    backend: AppServerBackendKind,
    threadId: string,
  ): Promise<boolean> {
    const overlay = await this.context.stores.threads.getThreadOverlayState({ backend, threadId });
    return overlay?.monitorJobSuggestionsEnabled
      ?? this.host().toolOutputAlertPolicy.monitorJobSuggestionsEnabled
      ?? true;
  }

  private monitorJobHeuristicEnabled(): boolean {
    return this.host().resolveTokenMiserEnabledFn()
      && this.host().resolveTokenMiserPollingReviewsEnabledFn();
  }

  private rememberMonitorJobHeuristicMessage(event: AgentEvent): void {
    if (
      !this.monitorJobHeuristicEnabled()
      || event.backend !== "codex"
      || event.notification.method !== "item/completed"
      || readNotificationItemType(event.notification) !== "agentMessage"
    ) return;
    const params = readRecord(event.notification.params);
    const threadId = readNonEmptyString(params?.threadId);
    const turnId = readNonEmptyString(params?.turnId);
    const text = textFragmentsFromCodexNotification(event.notification)
      .join("\n")
      .trim();
    if (!threadId || !turnId || !text) return;
    this.monitorJobHeuristicDetector.observeAssistantMessage({
      backend: event.backend,
      threadId,
      turnId,
      observedAt: Date.now(),
      text,
    });
  }

  private async reviewMonitorJobHeuristic(
    evidence: MonitorJobHeuristicEvidence,
    invocation: ThreadToolInvocationRecord,
  ): Promise<void> {
    if (
      !this.monitorJobHeuristicEnabled()
      || evidence.backend !== "codex"
      || this.host().getActiveTurnForThread({
        backend: evidence.backend,
        threadId: evidence.threadId,
      })?.turnId !== evidence.turnId
      || !this.context.providers.codex.generateStructuredObject
    ) return;
    if (
      this.subAgentMonitorService.resolveSubAgentThreadOwner({
        backend: evidence.backend,
        threadId: evidence.threadId,
      }).isSubAgent
      || this.subAgentMonitorService.isTaskMonitorThread({
        backend: evidence.backend,
        threadId: evidence.threadId,
      })
      || !await this.monitorJobSuggestionEnabledForThread(
        evidence.backend,
        evidence.threadId,
      )
    ) return;
    const result = await this.context.providers.codex.generateStructuredObject({
      system: MONITOR_JOB_HEURISTIC_SYSTEM,
      prompt: buildMonitorJobHeuristicPrompt(evidence),
      schema: MONITOR_JOB_HEURISTIC_SCHEMA,
      helper: "token_miser_polling_reviews",
      disableExecution: true,
      isMatch: (record) => Boolean(parseMonitorJobHeuristicDecision(record)),
      timeoutMs: 45_000,
      turnTimeoutMs: 45_000,
    });
    if (result.status !== "ok") {
      backendRegistryLog.warn("monitor job heuristic review failed open", {
        threadId: evidence.threadId,
        turnId: evidence.turnId,
        reason: result.reason,
      });
      return;
    }
    const decision = parseMonitorJobHeuristicDecision(result.object);
    if (!decision) return;
    backendRegistryLog.info("monitor job heuristic review completed", {
      threadId: evidence.threadId,
      turnId: evidence.turnId,
      decision: decision.decision,
      model: result.model,
    });
    if (decision.decision === "suggest_monitor") {
      await this.suggestMonitorJob(invocation);
    }
  }

  async recordToolInvocationAccounting(event: AgentEvent): Promise<void> {
    this.rememberMonitorJobHeuristicMessage(event);
    if (event.notification.method === "item/completed"
      && (event.backend === "codex" || isAcpBackendId(event.backend))) {
      const observed = toolInvocationFromNotification({
        backend: event.backend,
        notification: event.notification,
        includeSmallTools: true,
      });
      if (observed) {
        if (this.monitorJobSuggestionDetector.observe(observed)) {
          this.monitorJobHeuristicDetector.clear(observed.backend, observed.threadId);
          void this.suggestMonitorJob(observed).catch((error) => {
            backendRegistryLog.warn("monitor job suggestion was not delivered", {
              threadId: observed.threadId,
              turnId: observed.turnId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
        } else if (event.backend === "codex" && this.monitorJobHeuristicEnabled()) {
          const evidence = this.monitorJobHeuristicDetector.observeInvocation({
            invocation: observed,
            inputPreview: toolInvocationReviewInputFromNotification(
              event.notification,
            ),
          });
          if (evidence) {
            void this.reviewMonitorJobHeuristic(evidence, observed).catch((error) => {
              backendRegistryLog.warn("monitor job heuristic review failed open", {
                threadId: observed.threadId,
                turnId: observed.turnId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        }
      }
    }
    if (
      event.notification.method === "turn/completed"
      || event.notification.method === "turn/failed"
      || event.notification.method === "turn/cancelled"
      || event.notification.method === "turn/interrupted"
    ) {
      const params = readRecord(event.notification.params);
      const threadId = readNonEmptyString(params?.threadId);
      const turnId = readNonEmptyString(params?.turnId);
      if (threadId && turnId) {
        const key = taskMonitorThreadKey(event.backend, threadId);
        if (this.pendingAcpMonitorJobSuggestions.get(key) === turnId) {
          this.pendingAcpMonitorJobSuggestions.delete(key);
        }
        this.monitorJobSuggestionDetector.clear(event.backend, threadId);
        this.monitorJobHeuristicDetector.clear(event.backend, threadId);
        this.liveToolOutputIncidents.delete(
          `large-output:${event.backend}:${threadId}:${turnId}`,
        );
        this.liveToolOutputIncidents.delete(
          `noisy-polling:${event.backend}:${threadId}:${turnId}`,
        );
      }
    }
    if (typeof this.context.stores.toolAccounting.upsertThreadToolInvocation !== "function") {
      return;
    }
    const now = Date.now();
    const toolOutputAlertPolicy = this.host().toolOutputAlertPolicy;
    const largeOutputThresholdChars = toolOutputWarningChars(
      toolOutputAlertPolicy.repeatedLargeOutputMinimumPercent,
    );
    const invocation = toolInvocationFromNotification({
      backend: event.backend,
      largeOutputThresholdChars,
      notification: event.notification,
      now,
    });
    if (!invocation) {
      return;
    }

    if (event.notification.method === "item/commandExecution/outputDelta") {
      // Streamed output never triggers noisy-polling detection (that only
      // looks at `write_stdin`). Ordinary deltas can wait for the flush timer;
      // a qualifying repeated-output or cap-hit boundary becomes durable
      // before its live alert reaches listeners.
      const buffered = this.bufferStreamedToolInvocationDelta(invocation);
      const crossedLargeOutputBoundary =
        (
          buffered.previousOutputChars < largeOutputThresholdChars
          && buffered.current.outputChars >= largeOutputThresholdChars
        )
        || (
          buffered.previousOutputChars < TOOL_OUTPUT_CAP_CHARS
          && buffered.current.outputChars >= TOOL_OUTPUT_CAP_CHARS
        );
      const detection = crossedLargeOutputBoundary
        ? detectLargeToolOutput({
            current: buffered.current,
            now,
            policy: toolOutputAlertPolicy,
            previousOutputChars: buffered.previousOutputChars,
          })
        : undefined;
      if (detection) {
        const incident = mergeLargeToolOutputIncident({
          current: this.liveToolOutputIncidents.get(detection.alert.alertId),
          detection,
          minimumWarningInvocationCount:
            toolOutputAlertPolicy.repeatedLargeOutputMinimumCalls,
        });
        this.liveToolOutputIncidents.set(
          incident.aggregate.alert.alertId,
          incident.aggregate,
        );
        if (!incident.shouldNotify) {
          return;
        }
        const stored = await this.persistStreamedToolInvocationAlertBoundary({
          alert: incident.aggregate.alert,
          invocationId: invocation.invocationId,
        });
        await this.emitThreadToolAccountingUpdated({
          backend: stored.backend,
          threadId: stored.threadId,
          triggeredAlerts: [incident.aggregate.alert],
        });
      }
      return;
    }

    const invocationWithStreamedOutput =
      mergeToolInvocationLifecycleWithStreamedOutput(
        invocation,
        this.streamedToolInvocationOutputTotals.get(invocation.invocationId),
      );
    if (event.notification.method === "item/completed") {
      this.streamedToolInvocationOutputTotals.delete(invocation.invocationId);
    }
    let shouldNotify = event.notification.method === "item/completed";
    const triggeredAlerts: ThreadToolInvocationAlert[] = [];
    const rawLargeOutputDetection = detectLargeToolOutput({
      current: invocationWithStreamedOutput,
      now,
      policy: toolOutputAlertPolicy,
    });
    const largeOutputIncident = rawLargeOutputDetection
      ? mergeLargeToolOutputIncident({
          current: this.liveToolOutputIncidents.get(
            rawLargeOutputDetection.alert.alertId,
          ),
          detection: rawLargeOutputDetection,
          minimumWarningInvocationCount:
            toolOutputAlertPolicy.repeatedLargeOutputMinimumCalls,
        })
      : undefined;
    if (largeOutputIncident) {
      this.liveToolOutputIncidents.set(
        largeOutputIncident.aggregate.alert.alertId,
        largeOutputIncident.aggregate,
      );
    }
    const largeOutputDetection = largeOutputIncident
      ? {
          alert: largeOutputIncident.aggregate.alert,
          cases: rawLargeOutputDetection!.cases,
          invocationIds: rawLargeOutputDetection!.invocationIds,
        }
      : undefined;
    const isVolatileDeferredCheck =
      invocationWithStreamedOutput.category === "polling"
      && (
        invocationWithStreamedOutput.toolName === "wait"
        || invocationWithStreamedOutput.toolName === "write_stdin"
        || invocationWithStreamedOutput.toolName === "exec"
      );
    const volatileRecent = isVolatileDeferredCheck
      ? this.readVolatileDeferredChecks(invocationWithStreamedOutput, now)
      : [];
    const rawPollingDetection =
      toolOutputAlertPolicy.repeatedQueuedChecksEnabled
      && typeof this.context.stores.toolAccounting.readRecentThreadToolInvocations === "function"
      ? detectNoisyPolling({
          current: invocationWithStreamedOutput,
          now,
          recent: [
            ...volatileRecent,
            ...this.context.stores.toolAccounting.readRecentThreadToolInvocations({
              backend: invocationWithStreamedOutput.backend,
              limit:
                invocationWithStreamedOutput.toolName === "commandExecution"
                  ? 50
                  : 12,
              ...(invocationWithStreamedOutput.toolName === "wait"
                ? {}
                : {
                    processId: invocationWithStreamedOutput.processId,
                    sessionId: invocationWithStreamedOutput.sessionId,
                  }),
              since: toolAccountingLookbackSince(now),
              threadId: invocationWithStreamedOutput.threadId,
              toolName: invocationWithStreamedOutput.toolName,
            }),
          ],
        })
      : undefined;
    const pollingIncident = rawPollingDetection
      ? mergeLargeToolOutputIncident({
          current: this.liveToolOutputIncidents.get(
            rawPollingDetection.alert.alertId,
          ),
          detection: rawPollingDetection,
        })
      : undefined;
    if (pollingIncident) {
      this.liveToolOutputIncidents.set(
        pollingIncident.aggregate.alert.alertId,
        pollingIncident.aggregate,
      );
    }
    const pollingDetection = pollingIncident
      ? {
          alert: pollingIncident.aggregate.alert,
          cases: rawPollingDetection!.cases,
          invocationIds: pollingIncident.aggregate.alert.invocationIds ?? [],
          lookbackSince: rawPollingDetection!.lookbackSince,
        }
      : undefined;
    if (isVolatileDeferredCheck) {
      this.rememberVolatileDeferredCheck(invocationWithStreamedOutput, now);
    }
    const noisyReason = pollingDetection
      ? "repeat-polling-output"
      : largeOutputDetection
        ? "large-output"
        : undefined;

    // Land accumulated stream output before the lifecycle row: the store stops
    // summing once a row is terminal, so a delta flushed after `item/completed`
    // would be dropped down to a MAX() and under-count the command.
    await this.flushStreamedToolInvocationDeltas();

    const previousPersistedPollingCount = pollingDetection
      ? this.persistedToolInvocationAlertCounts.get(
          pollingDetection.alert.alertId,
        )
      : undefined;
    const shouldPersistPollingAlert = Boolean(
      pollingDetection
      && (
        previousPersistedPollingCount === undefined
        || pollingDetection.alert.invocationCount
          >= previousPersistedPollingCount * 2
      ),
    );
    const alertsToPersist = [
      ...(largeOutputDetection && largeOutputIncident?.shouldNotify
        ? [largeOutputDetection.alert]
        : []),
      ...(pollingDetection && shouldPersistPollingAlert
        ? [pollingDetection.alert]
        : []),
    ];
    if (isVolatileDeferredCheck && !largeOutputDetection) {
      if (
        pollingDetection
        && shouldPersistPollingAlert
        && typeof this.context.stores.toolAccounting.upsertThreadToolInvocationAlert === "function"
      ) {
        await this.context.stores.toolAccounting.upsertThreadToolInvocationAlert({
          alert: pollingDetection.alert,
        });
        this.persistedToolInvocationAlertCounts.set(
          pollingDetection.alert.alertId,
          pollingDetection.alert.invocationCount,
        );
      }
      if (pollingDetection && pollingIncident?.shouldNotify) {
        await this.emitThreadToolAccountingUpdated({
          backend: invocationWithStreamedOutput.backend,
          threadId: invocationWithStreamedOutput.threadId,
          triggeredAlerts: [pollingDetection.alert],
        });
      }
      return;
    }
    const previousNoisyInvocationIds =
      pollingDetection && previousPersistedPollingCount === undefined
        ? pollingDetection.invocationIds.filter(
            (invocationId) => invocationId !== invocation.invocationId,
          )
        : [];
    const suggestedPrompt = pollingDetection?.alert.suggestedPrompt
      ?? largeOutputDetection?.alert.suggestedPrompt;
    const invocationToPersist = {
      ...invocation,
      outputState: invocation.outputTruncated ? "truncated" as const : "available" as const,
      source: "live" as const,
      ...(noisyReason
        ? {
            noisy: true,
            noisyReason,
          }
        : {}),
      ...(suggestedPrompt ? { suggestedPrompt } : {}),
    };
    let stored: ThreadToolInvocationRecord;
    if (
      typeof this.context.stores.toolAccounting.persistThreadToolInvocationBoundary === "function"
    ) {
      stored = await this.context.stores.toolAccounting.persistThreadToolInvocationBoundary({
        alerts: alertsToPersist,
        invocation: invocationToPersist,
        noisyInvocationIds: previousNoisyInvocationIds,
        ...(previousNoisyInvocationIds.length
          ? { noisyReason: "repeat-polling-output" }
          : {}),
      });
    } else {
      stored = await this.context.stores.toolAccounting.upsertThreadToolInvocation({
        invocation: invocationToPersist,
      });
      if (previousNoisyInvocationIds.length > 0) {
        if (
          typeof this.context.stores.toolAccounting.markThreadToolInvocationsNoisy === "function"
        ) {
          await this.context.stores.toolAccounting.markThreadToolInvocationsNoisy({
            invocationIds: previousNoisyInvocationIds,
            reason: "repeat-polling-output",
          });
        } else if (
          typeof this.context.stores.toolAccounting.markThreadToolInvocationNoisy === "function"
        ) {
          for (const invocationId of previousNoisyInvocationIds) {
            await this.context.stores.toolAccounting.markThreadToolInvocationNoisy({
              invocationId,
              reason: "repeat-polling-output",
            });
          }
        }
      }
      if (typeof this.context.stores.toolAccounting.upsertThreadToolInvocationAlert === "function") {
        for (const alert of alertsToPersist) {
          await this.context.stores.toolAccounting.upsertThreadToolInvocationAlert({ alert });
        }
      }
    }
    if (pollingDetection && shouldPersistPollingAlert) {
      this.persistedToolInvocationAlertCounts.set(
        pollingDetection.alert.alertId,
        pollingDetection.alert.invocationCount,
      );
    }
    if (largeOutputDetection && largeOutputIncident?.shouldNotify) {
      triggeredAlerts.push(largeOutputDetection.alert);
      shouldNotify = true;
    }
    if (pollingDetection && pollingIncident?.shouldNotify) {
      triggeredAlerts.push(pollingDetection.alert);
      shouldNotify = true;
    }

    if (shouldNotify) {
      await this.emitThreadToolAccountingUpdated({
        backend: stored.backend,
        threadId: stored.threadId,
        triggeredAlerts,
      });
    }
  }

  private bufferStreamedToolInvocationDelta(
    invocation: ThreadToolInvocationRecord,
  ): {
    current: ThreadToolInvocationRecord;
    previousOutputChars: number;
  } {
    const accumulated = this.pendingToolInvocationDeltas.get(
      invocation.invocationId,
    );
    const pending = accumulated
      ? mergeStreamedToolInvocationDeltas(accumulated, invocation)
      : invocation;
    const accumulatedTotal = this.streamedToolInvocationOutputTotals.get(
      invocation.invocationId,
    );
    const current = accumulatedTotal
      ? mergeStreamedToolInvocationDeltas(accumulatedTotal, invocation)
      : invocation;
    this.pendingToolInvocationDeltas.set(
      invocation.invocationId,
      pending,
    );
    this.streamedToolInvocationOutputTotals.set(invocation.invocationId, current);
    this.scheduleStreamedToolInvocationFlush();
    return {
      current,
      previousOutputChars: accumulatedTotal?.outputChars ?? 0,
    };
  }

  /**
   * Replace the threshold-crossing delta's ordinary buffered write with one
   * durable invocation-plus-alert boundary. Reserving the pending delta before
   * joining the flush chain prevents a timer drain from stealing it, while the
   * chain still guarantees that any older window lands first.
   */
  private persistStreamedToolInvocationAlertBoundary(params: {
    alert: ThreadToolInvocationAlert;
    invocationId: string;
  }): Promise<ThreadToolInvocationRecord> {
    const pending = this.pendingToolInvocationDeltas.get(params.invocationId);
    if (!pending) {
      return Promise.reject(
        new Error(`Missing streamed tool invocation boundary ${params.invocationId}`),
      );
    }
    this.pendingToolInvocationDeltas.delete(params.invocationId);
    const invocation = {
      ...pending,
      noisy: true,
      noisyReason: "large-output",
      outputState: pending.outputTruncated ? "truncated" as const : "available" as const,
      source: "live" as const,
      suggestedPrompt: params.alert.suggestedPrompt,
    };
    const persisted = this.toolInvocationDeltaFlushChain.then(async () => {
      try {
        if (
          typeof this.context.stores.toolAccounting.persistThreadToolInvocationBoundary === "function"
        ) {
          return await this.context.stores.toolAccounting.persistThreadToolInvocationBoundary({
            alerts: [params.alert],
            invocation,
          });
        }
        const stored = await this.context.stores.toolAccounting.upsertThreadToolInvocation({
          invocation,
        });
        if (
          typeof this.context.stores.toolAccounting.upsertThreadToolInvocationAlert === "function"
        ) {
          await this.context.stores.toolAccounting.upsertThreadToolInvocationAlert({
            alert: params.alert,
          });
        }
        return stored;
      } catch (error) {
        this.requeueFailedToolInvocationDelta(invocation);
        throw error;
      }
    });
    this.toolInvocationDeltaFlushChain = persisted.then(
      () => undefined,
      () => undefined,
    );
    return persisted;
  }

  private readVolatileDeferredChecks(
    invocation: ThreadToolInvocationRecord,
    now: number,
  ): ThreadToolInvocationRecord[] {
    const key = [invocation.backend, invocation.threadId].join(":");
    const recent = (
      this.volatileDeferredCheckInvocations.get(key) ?? []
    ).filter((record) => record.observedAt >= toolAccountingLookbackSince(now));
    if (recent.length > 0) {
      this.volatileDeferredCheckInvocations.set(key, recent);
    } else {
      this.volatileDeferredCheckInvocations.delete(key);
    }
    return recent;
  }

  private rememberVolatileDeferredCheck(
    invocation: ThreadToolInvocationRecord,
    now: number,
  ): void {
    const key = [invocation.backend, invocation.threadId].join(":");
    const recent = this.readVolatileDeferredChecks(invocation, now);
    this.volatileDeferredCheckInvocations.set(key, [...recent, invocation]);
  }

  private scheduleStreamedToolInvocationFlush(): void {
    if (this.pendingToolInvocationDeltaTimer || this.context.lifecycle.closed) {
      return;
    }
    this.pendingToolInvocationDeltaTimer = setTimeout(() => {
      this.pendingToolInvocationDeltaTimer = undefined;
      void this.flushStreamedToolInvocationDeltas();
    }, TOOL_INVOCATION_DELTA_FLUSH_INTERVAL_MS);
    this.pendingToolInvocationDeltaTimer.unref?.();
  }

  /**
   * Write every accumulated stream-output record. Callers get a promise for
   * their own flush *and* for any flush already in flight, so the terminal
   * `item/completed` write always follows the deltas it came after.
   */
  flushStreamedToolInvocationDeltas(): Promise<void> {
    const flushed = this.toolInvocationDeltaFlushChain.then(() =>
      this.writePendingToolInvocationDeltas(),
    );
    this.toolInvocationDeltaFlushChain = flushed.catch(() => undefined);
    return flushed;
  }

  private async writePendingToolInvocationDeltas(): Promise<void> {
    // Whoever reached here is draining now, so a timer armed for this batch has
    // nothing left to do.
    if (this.pendingToolInvocationDeltaTimer) {
      clearTimeout(this.pendingToolInvocationDeltaTimer);
      this.pendingToolInvocationDeltaTimer = undefined;
    }
    if (
      this.pendingToolInvocationDeltas.size === 0
      || typeof this.context.stores.toolAccounting.upsertThreadToolInvocation !== "function"
    ) {
      return;
    }
    const pending = [...this.pendingToolInvocationDeltas.values()];
    this.pendingToolInvocationDeltas.clear();
    for (const invocation of pending) {
      try {
        await this.context.stores.toolAccounting.upsertThreadToolInvocation({ invocation });
      } catch (error) {
        // Unlike the lifecycle write in `recordToolInvocationAccounting`, this
        // one has no caller to reject: most flushes run from a timer, where
        // throwing would only produce an unhandled rejection. Put the record
        // back instead, so a transient store failure costs a retry rather than
        // the whole accumulated window, and let the next flush carry it.
        this.requeueFailedToolInvocationDelta(invocation);
        backendRegistryLog.warn("tool invocation output accounting write failed", {
          backend: invocation.backend,
          error: error instanceof Error ? error.message : String(error),
          invocationId: invocation.invocationId,
          threadId: invocation.threadId,
        });
      }
    }
  }

  private requeueFailedToolInvocationDelta(
    invocation: ThreadToolInvocationRecord,
  ): void {
    if (this.context.lifecycle.closed) {
      // Shutdown already took its one flush attempt; retrying would only queue
      // work against a store that is going away.
      return;
    }
    const newer = this.pendingToolInvocationDeltas.get(invocation.invocationId);
    this.pendingToolInvocationDeltas.set(
      invocation.invocationId,
      newer
        ? mergeStreamedToolInvocationDeltas(invocation, newer)
        : invocation,
    );
    this.scheduleStreamedToolInvocationFlush();
  }

  async recordTokenMiserFocusedInference(
    params: Parameters<NonNullable<TokenMiserServiceOptions["onFocusedInference"]>>[0],
  ): Promise<void> {
    const { threadId, turnId, inferenceId, usage: result } = params;
    if (result.status !== "ok" || !result.tokenUsage) return;
    const usage = buildTaskMonitorUsageSnapshot({
      model: result.model,
      serviceTier: result.serviceTier,
      tokenUsage: result.tokenUsage,
    });
    if (!usage) return;
    const line = buildTaskMonitorUsageLine({
      backend: "codex", parentThreadId: threadId,
      accountKey: result.accountKey,
      monitorId: `system:token-miser-focused:${inferenceId}`,
      monitorThreadId: result.helperThreadId ?? `token-miser-focused:${inferenceId}`,
      monitorTurnId: result.helperTurnId ?? turnId,
      model: result.model, reasoningEffort: result.reasoningEffort,
      serviceTier: result.serviceTier, source: "monitor", usage,
    });
    logUnpricedThreadUsageLine(line);
    await this.context.stores.usage.upsertThreadUsageLine!({ line });
    await this.emitThreadPricingUpdated({ backend: "codex", threadId });
  }

  initializeTokenMiserLedger(): Promise<void> {
    this.tokenMiserStoragePreparation = this.tokenMiserStoragePreparation
      .catch(() => undefined)
      .then(async () => {
        await this.host().tokenMiserStore?.prune({
          maxAgeMs: 7 * 24 * 60 * 60 * 1_000,
          maxBytes: 512 * 1024 * 1024,
        });
      });
    this.tokenMiserLedgerReconciliation = this.tokenMiserStoragePreparation
      .then(async () => await this.reconcileTokenMiserLedger())
      .catch((error) => {
        backendRegistryLog.warn("Token Miser ledger reconciliation failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return this.tokenMiserLedgerReconciliation;
  }

  private async reconcileTokenMiserLedger(): Promise<void> {
    const host = this.host();
    if (!host.tokenMiserStore) {
      return;
    }
    const restored = await host.tokenMiserStore.listMetadata();
    const stoppedCount =
      await this.stopTokenMiserGatesCompactedWhileClosed(restored);
    // Re-read after closing gates: `restored` was captured before the stop, so
    // registering from it would put the just-stopped gates straight back into
    // the active set and publish a stale ledger.
    const metadata = stoppedCount > 0
      ? await host.tokenMiserStore.listMetadata()
      : restored;
    for (const entry of metadata) {
      this.rememberActiveTokenMiserReplayEntry(entry);
      this.seedTokenMiserRequestCursor(entry);
    }
    await this.persistTokenMiserLedgerEntries(metadata);
  }

  /**
   * Close out gates whose thread compacted while this instance was not running.
   *
   * Restore re-registers every unstopped gate, so without this a gate created
   * before a compaction stays active forever and keeps counting cached replays
   * against content the compaction already removed from context. The live
   * `thread/compacted` handler cannot cover this: the event fired when nobody
   * was listening. Persisted markers are what make the boundary survive.
   */
  private async stopTokenMiserGatesCompactedWhileClosed(
    metadata: readonly TokenMiserObjectMetadata[],
  ): Promise<number> {
    const active = metadata.filter((entry) =>
      entry.replayTrackingVersion === 2
      && entry.replayTrackingStoppedAt === undefined
    );
    if (active.length === 0) {
      return 0;
    }
    const compactedAtByThread = new Map<string, number>();
    for (const threadId of new Set(active.map((entry) => entry.threadId))) {
      const compactions = await this.context.stores.usage.listThreadCompactions?.({
        backend: "codex",
        threadId,
      });
      const latest = compactions?.at(-1);
      if (latest) {
        compactedAtByThread.set(threadId, latest.observedAt);
      }
    }
    let stopped = 0;
    for (const entry of active) {
      const compactedAt = compactedAtByThread.get(entry.threadId);
      // Only a compaction that happened after the gate bounds it; an earlier
      // one belongs to context the gate never entered.
      if (compactedAt === undefined || compactedAt <= entry.createdAt) {
        continue;
      }
      if (
        await this.host().tokenMiserStore!.stopReplayTracking({
          objectId: entry.objectId,
          stoppedAt: compactedAt,
        })
      ) {
        stopped += 1;
      }
    }
    return stopped;
  }

  /**
   * Restore the thread's request boundary from stored gate marks.
   *
   * Codex reports `total.inputTokens` cumulatively for the thread, so it
   * survives a restart — but the in-memory cursor does not. Without seeding,
   * the first usage event after a relaunch would look like a new request to
   * every gate and credit a replay that already happened.
   */
  private seedTokenMiserRequestCursor(_metadata: TokenMiserObjectMetadata): void {
    // Intentionally does not seed. `total.inputTokens` is cumulative for the
    // Codex *session*, not the thread's lifetime (see acp-usage.ts), so a mark
    // persisted by the previous process sits above everything the new session
    // reports. Seeding from it made every later event fail the advance test and
    // froze replay counting for the life of the process. The sibling
    // observed-context-replay fold re-seeds per process for the same reason.
  }

  rememberActiveTokenMiserReplayEntry(
    metadata: TokenMiserObjectMetadata,
  ): void {
    const active = this.activeTokenMiserReplayEntries.get(metadata.threadId);
    if (
      metadata.replayTrackingVersion !== 2
      || metadata.replayTrackingStoppedAt !== undefined
    ) {
      active?.delete(metadata.objectId);
      if (active?.size === 0) {
        this.activeTokenMiserReplayEntries.delete(metadata.threadId);
      }
      return;
    }
    const entries = active ?? new Map<string, TokenMiserObjectMetadata>();
    entries.set(metadata.objectId, metadata);
    this.activeTokenMiserReplayEntries.set(metadata.threadId, entries);
  }

  async runTokenMiserSideEffect(
    stage: string,
    run: () => Promise<void>,
  ): Promise<void> {
    try {
      await run();
    } catch (error) {
      backendRegistryLog.warn("Token Miser side effect failed open", {
        error: error instanceof Error ? error.message : String(error),
        stage,
      });
    }
  }

  /**
   * The model whose context a new gate is protecting.
   *
   * A native review runs on the parent thread under its own inner turn id —
   * the hook reports one id, `review/start` returned another — and produces no
   * usage line, so a gate created during one has no line to price against. The
   * review record knows the reviewer's model, and while it is active it is the
   * only thing making requests on that thread. Otherwise the newest eligible
   * usage line is the parent's current model, regardless of price availability.
   */
  async resolveTokenMiserParentModel(
    threadId: string,
  ): Promise<TokenMiserDiagnosticContext | undefined> {
    for (const record of this.managedReviewService.activeReviewSubAgentRecords.values()) {
      if (
        record.mode === "native"
        && record.reviewThreadId === threadId
        && record.model
      ) {
        return {
          model: record.model,
          reasoningEffort: record.reasoningEffort,
          ...(record.serviceTier ? { serviceTier: record.serviceTier } : {}),
        };
      }
    }
    if (typeof this.context.stores.usage.readLatestThreadUsageModel !== "function") {
      return undefined;
    }
    return this.context.stores.usage.readLatestThreadUsageModel({
      backend: "codex",
      threadId,
    });
  }

  async recordTokenMiserParentModelRequest(
    event: AgentEvent,
  ): Promise<void> {
    if (
      event.backend !== "codex"
      || event.notification.method !== "thread/tokenUsage/updated"
    ) {
      return;
    }
    const threadId = event.notification.params.threadId;
    // Past this point every observation is logged in development, either as a
    // skip reason or as a per-gate decision, so a live run can tell "the
    // handler never ran" apart from "it ran and declined".
    const host = this.host();
    if (!host.tokenMiserStore) {
      this.logTokenMiserReplaySkip("no-store", threadId);
      return;
    }
    const requestUsage = readTaskMonitorTokenUsageRecords(
      event.notification.params.tokenUsage,
    );
    const cumulativeInputTokens = requestUsage?.totalUsage?.inputTokens;
    if (typeof cumulativeInputTokens !== "number") {
      this.logTokenMiserReplaySkip("no-cumulative-input", threadId);
      return;
    }
    // One request boundary per thread, decided here.
    //
    // Each gate used to compare this cumulative high-water mark against its own
    // copy, which made the answer depend on when the gate was created: an
    // out-of-order or replayed usage event can sit above an older gate's mark
    // and below a newer one's, so the same event advanced some gates and not
    // others and their replay counts drifted apart. The thread has exactly one
    // request sequence, so it gets exactly one cursor.
    const cursorKey = [event.backend, threadId].join(":");
    const priorCursor = this.liveTokenMiserRequestCursor.get(cursorKey);
    if (priorCursor !== undefined && cumulativeInputTokens <= priorCursor) {
      // A large drop means the session restarted and its cumulative total reset,
      // not that this is a duplicate. Re-anchor instead of declining forever;
      // treating it as a duplicate is what makes a thread stop counting.
      if (cumulativeInputTokens * 2 < priorCursor) {
        this.liveTokenMiserRequestCursor.set(cursorKey, cumulativeInputTokens);
        // A Codex app-server restart can reset cumulative usage without
        // recreating this registry. Rotate only this thread's epoch so stored
        // gates accept the new lower sequence while other live threads retain
        // their own monotonic request histories.
        this.tokenMiserRequestEpochByCursor.set(cursorKey, randomUUID());
        host.tokenMiserStore.recordParentRequestUsage({
          threadId,
          cumulativeInputTokens,
          cachedInputTokens: requestUsage?.latestUsage?.cachedInputTokens,
          requestEpoch: this.tokenMiserRequestEpochByCursor.get(cursorKey)!,
        });
        this.logTokenMiserReplaySkip("session-reset", threadId);
        return;
      }
      this.logTokenMiserReplaySkip("no-advance", threadId);
      return;
    }
    this.liveTokenMiserRequestCursor.set(cursorKey, cumulativeInputTokens);
    // Compaction stops replay tracking, but the originals stay retrievable
    // until the next turn. Their requesting rounds still need fresh usage.
    host.tokenMiserStore.recordParentRequestUsage({
      threadId,
      cumulativeInputTokens,
      cachedInputTokens: requestUsage?.latestUsage?.cachedInputTokens,
      requestEpoch: this.tokenMiserRequestEpochByCursor.get(cursorKey)
        ?? this.tokenMiserRequestEpoch,
    });
    const entries = this.activeTokenMiserReplayEntries.get(threadId);
    if (!entries || entries.size === 0) {
      this.logTokenMiserReplaySkip("no-active-gates", threadId);
      return;
    }
    const observed = [...entries.entries()];
    const updated = await Promise.all(
      observed.map(([objectId]) =>
        this.host().tokenMiserStore!.recordParentModelRequest({
          cumulativeInputTokens,
          objectId,
          requestEpoch:
            this.tokenMiserRequestEpochByCursor.get(cursorKey)
            ?? this.tokenMiserRequestEpoch,
        })
      ),
    );
    this.logTokenMiserReplayDecision({
      cumulativeInputTokens,
      observed,
      threadId,
      tokenUsage: event.notification.params.tokenUsage,
      updated,
    });
    if (!updated.some(Boolean)) {
      return;
    }
    await this.publishLiveTokenMiserReplayEntries(
      updated.filter(
        (entry): entry is TokenMiserObjectMetadata => entry !== undefined,
      ),
    );
    await this.emitThreadToolAccountingUpdated({
      backend: "codex",
      threadId,
    });
  }

  private logTokenMiserReplaySkip(reason: string, threadId: string): void {
    if (!isDevelopment) {
      return;
    }
    logDebug("tokenMiser:replay", { decision: `skip:${reason}`, threadId });
  }

  // Dev-only diagnostic for the Token Miser replay heuristic: one line per
  // active gate per observed `thread/tokenUsage/updated`, recording the
  // warm-up state machine's decision beside what the thread-level observed
  // context-replay fold made of the same event. The two derive request
  // boundaries independently — the gate from its own per-object cumulative
  // high-water mark, the fold from the per-thread cursor — so logging them
  // together is what lets a live run prove or disprove the two-observation
  // assumption instead of inspecting end-state metadata that cannot show
  // ordering. Runs after `recordLiveThreadUsage`, so the fold has already
  // folded this event: an unadvanced cursor means the fold rejected it.
  // Gated on isDevelopment, so packaged builds do no parsing work here.
  private logTokenMiserReplayDecision(params: {
    cumulativeInputTokens: number;
    observed: readonly (readonly [string, TokenMiserObjectMetadata])[];
    threadId: string;
    tokenUsage: unknown;
    updated: readonly (TokenMiserObjectMetadata | undefined)[];
  }): void {
    if (!isDevelopment) {
      return;
    }
    const last = readTaskMonitorTokenUsageRecords(params.tokenUsage)?.latestUsage;
    const cursor = this.liveThreadReplayInputCursor.get(
      ["codex", params.threadId].join(":"),
    );
    const turnPrefix = ["codex", params.threadId, ""].join(":");
    const fold = [...this.liveThreadReplayObservations.entries()]
      .filter(([key]) => key.startsWith(turnPrefix))
      .reduce(
        (totals, [, tally]) => ({
          cold: totals.cold + tally.coldReplayCount,
          hot: totals.hot + tally.hotReplayCount,
        }),
        { cold: 0, hot: 0 },
      );
    params.observed.forEach(([objectId, before], index) => {
      const after = params.updated[index];
      const decision = !after
        ? "no-advance"
        : (after.cachedReplayCount ?? 0) > (before.cachedReplayCount ?? 0)
          ? "counted"
          : "warmup-skipped";
      logDebug("tokenMiser:replay", {
        cachedReplayCount: after?.cachedReplayCount ?? before.cachedReplayCount ?? 0,
        cumulativeInput: params.cumulativeInputTokens,
        decision,
        // The fold's per-thread high-water mark after this same event. Equal to
        // `cumulativeInput` means both mechanisms accepted this as a new
        // request; a lower value means only the gate did.
        foldCursorInput: cursor?.cumulativeInputTokens,
        foldColdCount: fold.cold,
        foldHotCount: fold.hot,
        lastCached: last?.cachedInputTokens,
        lastInput: last?.inputTokens,
        objectId,
        observationIndex: after?.parentRequestsObservedAfterGate
          ?? before.parentRequestsObservedAfterGate
          ?? 0,
        priorCumulativeInput: before.lastParentCumulativeInputTokens,
        threadId: params.threadId,
      });
    });
  }

  /**
   * Persist one observed compaction.
   *
   * Compaction bounds how long a preserved payload can still be replayed, and
   * it used to be live-only: a compaction seen while the app was closed stopped
   * nothing, and historical accounting had no boundary at all. The marker is
   * keyed on the backend's own item id when it reports one, so a re-emitted
   * notification — or a `ContextCompaction` item plus `thread/compacted` for
   * the same item — does not become a second compaction.
   */
  private async recordThreadCompaction(event: AgentEvent): Promise<boolean> {
    const boundary = readThreadCompactionBoundary(event);
    if (!boundary) {
      return false;
    }
    const threadId = boundary.threadId;
    const itemId = boundary.itemId;
    const observedAt = Date.now();
    const turnId = boundary.turnId
      ?? this.findActiveTurnIdForThread(event.backend, threadId);
    const threadKey = [event.backend, threadId].join(":");
    const cumulativeInputTokens = this.liveThreadReplayInputCursor.get(
      threadKey,
    )?.cumulativeInputTokens;
    const reportedBoundary = this.reportedCompactionRequestBoundaries.get(
      threadKey,
    );
    const isRecentBoundary =
      reportedBoundary !== undefined
      && observedAt - reportedBoundary.observedAt
        <= COMPACTION_NOTIFICATION_DEDUP_WINDOW_MS
      && reportedBoundary.cumulativeInputTokens === cumulativeInputTokens
      && (
        reportedBoundary.turnId === undefined
        || turnId === undefined
        || reportedBoundary.turnId === turnId
      );
    const isSameItem =
      itemId !== undefined
      && itemId === reportedBoundary?.itemId;
    const isDuplicateReportedBoundary =
      isRecentBoundary
      && (
        isSameItem
        || (reportedBoundary.itemId === undefined) !== (itemId === undefined)
      );
    if (isDuplicateReportedBoundary) {
      this.reportedCompactionRequestBoundaries.set(threadKey, {
        cumulativeInputTokens,
        itemId: reportedBoundary.itemId ?? itemId,
        observedAt,
        turnId: reportedBoundary.turnId ?? turnId,
      });
      return false;
    }
    const compactionId = buildThreadCompactionIdentity({
      backend: event.backend,
      cumulativeInputTokens,
      itemId,
      threadId,
      turnId,
    });
    try {
      const recorded = await this.context.stores.usage.recordThreadCompaction?.({
        compaction: {
          backend: event.backend,
          compactionId,
          observedAt,
          threadId,
          updatedAt: observedAt,
          ...(itemId ? { itemId } : {}),
          ...(turnId ? { turnId } : {}),
        },
      }) ?? true;
      if (recorded) {
        this.reportedCompactionRequestBoundaries.set(threadKey, {
          cumulativeInputTokens,
          itemId,
          observedAt,
          turnId,
        });
      }
      return recorded;
    } catch (error) {
      backendRegistryLog.warn("compaction marker write failed", {
        backend: event.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId,
      });
      // The notification is still authoritative even when durable accounting
      // is unavailable. Stop the pre-compaction replay window conservatively.
      return true;
    }
  }

  /**
   * Persist the usage-only safety boundary unless a reported compaction is
   * already waiting for this same post-boundary request.
   *
   * Match the reported marker's in-memory request cursor, not the database's
   * attribution state. An old marker can remain unattributed when its next
   * request was small or cache-served; treating every such row as current made
   * it suppress a later genuinely unreported compaction.
   */
  private async handleInferredThreadCompaction(params: {
    backend: AppServerBackendKind;
    contextDrop: ObservedContextWindowDrop;
    threadId: string;
    turnId?: string;
  }): Promise<void> {
    const threadKey = [params.backend, params.threadId].join(":");
    const reportedBoundary = this.reportedCompactionRequestBoundaries.get(
      threadKey,
    );
    if (
      reportedBoundary?.cumulativeInputTokens
      === params.contextDrop.previousCumulativeInputTokens
    ) {
      this.reportedCompactionRequestBoundaries.delete(threadKey);
      return;
    }
    if (
      reportedBoundary?.cumulativeInputTokens !== undefined
      && reportedBoundary.cumulativeInputTokens
        < params.contextDrop.previousCumulativeInputTokens
    ) {
      this.reportedCompactionRequestBoundaries.delete(threadKey);
    }
    try {
      const observedAt = Date.now();
      const recorded = await this.context.stores.usage.recordThreadCompaction?.({
        compaction: {
          backend: params.backend,
          compactionId: buildThreadCompactionIdentity({
            backend: params.backend,
            cumulativeInputTokens: params.contextDrop.cumulativeInputTokens,
            threadId: params.threadId,
            turnId: params.turnId,
          }),
          observedAt,
          threadId: params.threadId,
          updatedAt: observedAt,
          ...(params.turnId ? { turnId: params.turnId } : {}),
        },
      }) ?? true;
      if (!recorded) {
        return;
      }
      backendRegistryLog.warn("compaction inferred from context-window drop", {
        backend: params.backend,
        currentContextTokens: params.contextDrop.currentContextTokens,
        previousContextTokens: params.contextDrop.previousContextTokens,
        threadId: params.threadId,
        turnId: params.turnId,
      });
      await this.stopTokenMiserReplayTrackingAtBoundary({
        backend: params.backend,
        threadId: params.threadId,
      });
    } catch (error) {
      backendRegistryLog.warn("inferred compaction marker write failed", {
        backend: params.backend,
        error: error instanceof Error ? error.message : String(error),
        threadId: params.threadId,
      });
      // The observed context drop is still authoritative enough to end replay
      // accounting even when durable marker storage is unavailable.
      await this.stopTokenMiserReplayTrackingAtBoundary({
        backend: params.backend,
        threadId: params.threadId,
      });
    }
  }

  // The compaction notification carries no turn id, so recover it from the
  // active-turn set: compaction happens inside a turn, and attributing the
  // marker to that turn is what lets the pricing view group it under the work
  // that caused it.
  private findActiveTurnIdForThread(
    backend: AppServerBackendKind,
    threadId: string,
  ): string | undefined {
    const prefix = `${backend}:${threadId}:`;
    for (const key of this.host().activeTurnKeys) {
      if (key.startsWith(prefix)) {
        return key.slice(prefix.length);
      }
    }
    return undefined;
  }

  private async stopTokenMiserReplayTrackingAtCompaction(
    event: AgentEvent,
  ): Promise<void> {
    const boundary = readThreadCompactionBoundary(event);
    if (!boundary) {
      return;
    }
    await this.stopTokenMiserReplayTrackingAtBoundary({
      backend: event.backend,
      threadId: boundary.threadId,
    });
  }

  private async stopTokenMiserReplayTrackingAtBoundary(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<void> {
    if (params.backend !== "codex" || !this.host().tokenMiserStore) {
      return;
    }
    const entries = this.activeTokenMiserReplayEntries.get(params.threadId);
    if (!entries || entries.size === 0) {
      return;
    }
    const stopped = await Promise.all(
      [...entries.keys()].map((objectId) =>
        this.host().tokenMiserStore!.stopReplayTracking({ objectId })
      ),
    );
    if (!stopped.some(Boolean)) {
      return;
    }
    await this.emitThreadToolAccountingUpdated({
      backend: "codex",
      threadId: params.threadId,
    });
  }

  async handleThreadCompactionReplayBoundary(
    event: AgentEvent,
  ): Promise<void> {
    const shouldStopReplayTracking = await this.recordThreadCompaction(event);
    if (shouldStopReplayTracking) {
      await this.stopTokenMiserReplayTrackingAtCompaction(event);
    }
  }

  /**
   * Thread-level dollar accounting for the gate.
   *
   * Built from `resolveTokenMiserGateAccounting`, the same per-gate
   * computation behind the Pricing rail cards, so the Explorer's total and the
   * rail's rows are the same arithmetic rather than two implementations that
   * can drift. It skips the cards' display text: a total needs only numbers.
   *
   * Gates whose dollars are not resolvable yet — the helper's usage line has
   * not landed, or the parent turn has no known model or rate — contribute to
   * `gateCount` but not to any total. Reporting a partial sum as the whole is
   * how a savings figure quietly becomes wrong.
   */
  private async buildTokenMiserThreadSavings(params: {
    backend: AppServerBackendKind;
    entries: readonly TokenMiserObjectMetadata[];
    replays: TokenMiserCachedReplayIndex;
    threadId: string;
  }): Promise<ThreadTokenMiserSavings | undefined> {
    if (!this.host().tokenMiserStore) {
      return undefined;
    }
    const entries = params.entries;
    if (entries.length === 0) {
      return undefined;
    }
    const pricing = typeof this.context.stores.usage.readThreadPricing === "function"
      ? await this.context.stores.usage.readThreadPricing({
          backend: params.backend,
          threadId: params.threadId,
        })
      : { lines: [], summaries: [] };
    // Persisted lines precede live ones, so a persisted price wins.
    const indexes: TokenMiserLedgerIndexes = {
      pricing: indexTokenMiserPricingLines([
        ...pricing.lines,
        ...(this.liveTokenMiserUsageLines.get(params.threadId)?.values() ?? []),
      ]),
      replays: params.replays,
    };

    let passThroughCount = 0;
    let policyPassThroughCount = 0;
    let helperDecisionCount = 0;
    let pricedGateCount = 0;
    let withoutGateCostMicros = 0;
    let gateCostMicros = 0;
    let revealedCostMicros = 0;
    let savingsMicros = 0;
    let directlyObservedReplayCount = 0;
    let reconstructedReplayCount = 0;
    let gateModel: string | undefined;
    let parentModel: string | undefined;

    for (const entry of entries) {
      if (entry.helperUsage) {
        helperDecisionCount += 1;
      }
      if (entry.disposition === "passed_through") {
        passThroughCount += 1;
        if (!entry.helperUsage) {
          policyPassThroughCount += 1;
        }
      }
      const { tokenMiserAccounting: accounting } =
        resolveTokenMiserGateAccounting({
          entry,
          helperUsage: () =>
            entry.helperUsage?.tokenUsage
              ? buildTaskMonitorUsageTotals({
                  model: entry.helperUsage.model,
                  serviceTier: entry.helperUsage.serviceTier,
                  tokenUsage: entry.helperUsage.tokenUsage,
                })
              : undefined,
          indexes,
        });
      if (!accounting) {
        continue;
      }
      // Counted after the guard, with the dollars. Counting replays for a gate
      // whose dollars were skipped made the confidence chip report replays the
      // savings figure does not include. The accounting carries the observed
      // count for v2 gates and the reconstructed count for older ones.
      if (entry.replayTrackingVersion === 2) {
        directlyObservedReplayCount += accounting.cachedReplayCount ?? 0;
      } else {
        reconstructedReplayCount += accounting.cachedReplayCount ?? 0;
      }
      pricedGateCount += 1;
      withoutGateCostMicros +=
        accounting.baselineParentCostMicros
        + (accounting.cachedBaselineCostMicros ?? 0);
      gateCostMicros += accounting.gateCostMicros;
      revealedCostMicros +=
        accounting.revealedParentCostMicros
        + (accounting.cachedRevealedCostMicros ?? 0);
      savingsMicros += accounting.savingsMicros;
      gateModel ??= accounting.gateModel;
      parentModel ??= accounting.originalModel;
    }

    // Focused helper work is billed once per inference, independently of
    // whether its answer was emitted. It creates no additional source gate.
    for (const line of pricing.lines) {
      if (line.sourceItemId?.startsWith("system:token-miser-focused:")) {
        if (line.priceStatus !== "priced") return undefined;
        const cost = line.totalCostMicros;
        gateCostMicros += cost;
        savingsMicros -= cost;
      }
    }
    // No priced gate means no equation. Preserve the token-only fallback
    // rather than rendering an incomplete dollar estimate as measured fact.
    if (pricedGateCount === 0) {
      return undefined;
    }
    return {
      currency: "USD",
      directlyObservedReplayCount,
      gateCostMicros,
      gateCount: entries.length,
      passThroughCount,
      policyPassThroughCount,
      helperPassThroughCount: passThroughCount - policyPassThroughCount,
      helperDecisionCount,
      ...(gateModel ? { gateModel } : {}),
      ...(parentModel ? { parentModel } : {}),
      pricedGateCount,
      reconstructedReplayCount,
      revealedCostMicros,
      savingsMicros,
      withoutGateCostMicros,
    };
  }

  /**
   * The rail card for one gate. Callers pricing several gates against one
   * ledger share one set of indexes rather than rescanning it per gate.
   */
  private buildTokenMiserLedgerArtifact(params: {
    entry: TokenMiserObjectMetadata;
    indexes: TokenMiserLedgerIndexes;
  }): {
    gateUsageLine?: ThreadUsageLineRecord;
    subAgent: ThreadSubAgentSummary;
  } {
    const { entry } = params;
    const monitorId = tokenMiserMonitorId(entry);
    const usage = entry.helperUsage?.tokenUsage
      ? buildTaskMonitorUsageSnapshot({
          model: entry.helperUsage.model,
          serviceTier: entry.helperUsage.serviceTier,
          tokenUsage: entry.helperUsage.tokenUsage,
        })
      : undefined;
    const { gateUsageLine, tokenMiserAccounting } =
      resolveTokenMiserGateAccounting({
        entry,
        helperUsage: () => usage,
        indexes: params.indexes,
      });
    const policyPassThrough =
      entry.disposition === "passed_through"
      && !entry.helperUsage;
    return {
      ...(gateUsageLine ? { gateUsageLine } : {}),
      subAgent: {
        monitorId,
        task: policyPassThrough
          ? `Pass through ${entry.toolName} output by policy`
          : entry.disposition === "passed_through"
            ? `Evaluate ${entry.toolName} output`
          : `Gate ${entry.toolName} output`,
        status: "success",
        createdAt: entry.createdAt,
        updatedAt: entry.createdAt,
        ownerRuntimeInstanceId: this.host().runtimeInstanceId,
        ownerRegistrySessionId: this.host().registrySessionId,
        backend: "codex",
        agentName: "Token Miser",
        ...(entry.helperUsage?.model
          ? { preferredModel: entry.helperUsage.model }
          : {}),
        ...(entry.helperUsage?.reasoningEffort
          ? { preferredReasoningEffort: entry.helperUsage.reasoningEffort }
          : {}),
        ...(entry.helperUsage?.helperThreadId
          ? { monitorThreadId: entry.helperUsage.helperThreadId }
          : {}),
        parentTurnId: entry.turnId,
        ...(entry.helperUsage?.helperTurnId
          ? { monitorTurnId: entry.helperUsage.helperTurnId }
          : {}),
        lastMessage: policyPassThrough
          ? `Passed ${entry.originalCharacters.toLocaleString()} characters `
            + `from ${entry.toolName} through unchanged by deterministic policy.`
          : entry.disposition === "passed_through"
            ? `Passed ${entry.originalCharacters.toLocaleString()} characters `
              + `from ${entry.toolName} through unchanged after evaluation.`
          : `Compressed ${entry.originalCharacters.toLocaleString()} characters `
            + `from ${entry.toolName} before they entered the parent context.`,
        outcome: "success",
        completedAt: entry.createdAt,
        completionSource: {
          type: "pwragent_fallback",
          reason: entry.disposition === "passed_through"
            ? "system_token_miser_pass_through"
            : "system_token_miser_gate",
          recoveryAttempted: false,
          terminalStatus: "completed",
        },
        ...(usage ? { monitorUsage: usage } : {}),
        ...(tokenMiserAccounting ? { tokenMiserAccounting } : {}),
      },
    };
  }

  /**
   * Queues one live gate publish behind every earlier one and returns its
   * promise. A failed publish rejects its own promise but does not hold up
   * the next: the chain keeps only its settlement.
   */
  publishLiveTokenMiserLedgerEntryInOrder(
    entry: TokenMiserObjectMetadata,
  ): Promise<void> {
    const publish = this.tokenMiserLivePublishChain.then(() =>
      this.publishLiveTokenMiserLedgerEntry(entry),
    );
    this.tokenMiserLivePublishChain = publish.catch(() => undefined);
    return publish;
  }

  async publishLiveTokenMiserLedgerEntry(
    entry: TokenMiserObjectMetadata,
  ): Promise<void> {
    if (this.context.lifecycle.closed) {
      return;
    }
    const pricing = typeof this.context.stores.usage.readThreadPricing === "function"
      ? await this.context.stores.usage.readThreadPricing({
          backend: "codex",
          threadId: entry.threadId,
        })
      : { lines: [], summaries: [] };
    // Invocations only reconstruct replays for gates that predate observed
    // replay tracking. A v2 gate never reads them, so skip the full read.
    const toolAccounting =
      entry.replayTrackingVersion !== 2
      && typeof this.context.stores.toolAccounting.readThreadToolAccounting === "function"
        ? await this.context.stores.toolAccounting.readThreadToolAccounting({
            backend: "codex",
            includeAllInvocations: true,
            threadId: entry.threadId,
          })
        : undefined;
    const linesById = new Map(
      pricing.lines.map((line) => [line.usageLineId, line]),
    );
    for (const pending of this.pendingLiveThreadUsageLines.values()) {
      const lineThreadId = pending.line.parentThreadId ?? pending.line.threadId;
      if (pending.backend === "codex" && lineThreadId === entry.threadId) {
        linesById.set(pending.line.usageLineId, pending.line);
      }
    }
    for (const line of this.liveTokenMiserUsageLines.get(entry.threadId)?.values()
      ?? []) {
      linesById.set(line.usageLineId, line);
    }
    const artifact = this.buildTokenMiserLedgerArtifact({
      entry,
      indexes: {
        pricing: indexTokenMiserPricingLines(linesById.values()),
        replays: indexTokenMiserCachedReplays(toolAccounting?.invocations ?? []),
      },
    });
    if (
      artifact.gateUsageLine
      && !pricing.lines.some((line) =>
        line.usageLineId === artifact.gateUsageLine?.usageLineId
      )
      && !this.pendingLiveThreadUsageLines.has(
        artifact.gateUsageLine.usageLineId,
      )
    ) {
      logUnpricedThreadUsageLine(artifact.gateUsageLine);
      if (typeof this.context.stores.usage.upsertThreadUsageLines === "function") {
        this.bufferLiveThreadUsageLine({
          backend: "codex",
          line: artifact.gateUsageLine,
          observationSequence: ++this.liveThreadUsageObservationSequence,
        });
      } else if (typeof this.context.stores.usage.upsertThreadUsageLine === "function") {
        await this.context.stores.usage.upsertThreadUsageLine({
          line: artifact.gateUsageLine,
        });
      }
    }
    const liveSubAgents = this.liveTokenMiserSubAgents.get(entry.threadId)
      ?? new Map<string, ThreadSubAgentSummary>();
    liveSubAgents.set(artifact.subAgent.monitorId, artifact.subAgent);
    this.liveTokenMiserSubAgents.set(entry.threadId, liveSubAgents);
    if (artifact.gateUsageLine) {
      const liveUsageLines = this.liveTokenMiserUsageLines.get(entry.threadId)
        ?? new Map<string, ThreadUsageLineRecord>();
      liveUsageLines.set(
        artifact.gateUsageLine.usageLineId,
        artifact.gateUsageLine,
      );
      this.liveTokenMiserUsageLines.set(entry.threadId, liveUsageLines);
    }
    // An invalidation, like every other card change: each listener refetches
    // the page it shows, and the event is stripped to its thread id before
    // the renderer or a peer sees it, so a card array here would be read in
    // full and then dropped.
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          navigationChanged: false,
          threadId: entry.threadId,
        },
      },
    });
    await this.emitThreadPricingUpdated({
      backend: "codex",
      threadId: entry.threadId,
    });
  }

  /**
   * Refresh every live gate card once after a parent request advances replay
   * accounting. The store updates N objects for one request boundary; doing a
   * full pricing read and renderer publish from each metadata callback would
   * turn that into N reads and 2N notifications. Active v2 entries already
   * carry their parent model and helper usage, so rebuild them together from
   * the in-memory usage lines and emit one sub-agent snapshot.
   */
  private async publishLiveTokenMiserReplayEntries(
    entries: readonly TokenMiserObjectMetadata[],
  ): Promise<void> {
    const first = entries[0];
    if (this.context.lifecycle.closed || !first) {
      return;
    }
    const threadId = first.threadId;
    const liveSubAgents = this.liveTokenMiserSubAgents.get(threadId)
      ?? new Map<string, ThreadSubAgentSummary>();
    const liveUsageLines = this.liveTokenMiserUsageLines.get(threadId)
      ?? new Map<string, ThreadUsageLineRecord>();
    // A rebuilt gate line is keyed by its own monitor id, so adding it to the
    // live lines can change only that gate's lookup. Index the lines once and
    // record each addition rather than rescanning them per gate.
    const indexes: TokenMiserLedgerIndexes = {
      pricing: indexTokenMiserPricingLines(liveUsageLines.values()),
      replays: indexTokenMiserCachedReplays([]),
    };
    for (const entry of entries) {
      if (entry.threadId !== threadId) {
        continue;
      }
      const artifact = this.buildTokenMiserLedgerArtifact({ entry, indexes });
      liveSubAgents.set(artifact.subAgent.monitorId, artifact.subAgent);
      if (artifact.gateUsageLine) {
        liveUsageLines.set(
          artifact.gateUsageLine.usageLineId,
          artifact.gateUsageLine,
        );
        indexes.pricing.appendGateUsageLine(artifact.gateUsageLine);
      }
    }
    this.liveTokenMiserSubAgents.set(threadId, liveSubAgents);
    this.liveTokenMiserUsageLines.set(threadId, liveUsageLines);
    await this.context.emit({
      backend: "codex",
      notification: {
        method: "thread/subAgents/updated",
        params: {
          navigationChanged: false,
          threadId,
        },
      },
    });
  }

  private clearLiveTokenMiserLedgerEntries(
    threadId: string,
    entries: readonly TokenMiserObjectMetadata[],
  ): boolean {
    const liveSubAgents = this.liveTokenMiserSubAgents.get(threadId);
    const liveUsageLines = this.liveTokenMiserUsageLines.get(threadId);
    let changed = false;
    for (const entry of entries) {
      const monitorId = tokenMiserMonitorId(entry);
      changed = liveSubAgents?.delete(monitorId) === true || changed;
      for (const [usageLineId, line] of liveUsageLines ?? []) {
        if (line.sourceItemId === monitorId) {
          liveUsageLines?.delete(usageLineId);
          changed = true;
        }
      }
    }
    if (liveSubAgents?.size === 0) {
      this.liveTokenMiserSubAgents.delete(threadId);
    }
    if (liveUsageLines?.size === 0) {
      this.liveTokenMiserUsageLines.delete(threadId);
    }
    return changed;
  }

  async flushPendingTokenMiserLedger(params: {
    publishPricing?: boolean;
    threadId: string;
  }): Promise<boolean> {
    await this.tokenMiserLedgerReconciliation;
    const metadata = Array.from(this.pendingTokenMiserInterceptions.values())
      .filter((entry) =>
        entry.threadId === params.threadId,
      );
    const changed = await this.persistTokenMiserLedgerEntries(metadata, {
      publishPricing: params.publishPricing,
    });
    return changed.includes(params.threadId);
  }

  /**
   * Persist gate cards and their usage lines. Returns the threads whose
   * pricing changed. With `publishPricing: false` the caller publishes it,
   * which lets a turn end send one pricing update for all of its writes.
   */
  private async persistTokenMiserLedgerEntries(
    metadata: readonly TokenMiserObjectMetadata[],
    options: { publishPricing?: boolean } = {},
  ): Promise<string[]> {
    // Finalized helper usage joins the same one-second bulk-write window as
    // parent usage. Drain that window before terminal reconciliation so the
    // stable helper line is found instead of inserted a second time.
    await this.flushLiveThreadUsageLines();
    const byThread = new Map<string, TokenMiserObjectMetadata[]>();
    for (const entry of metadata) {
      const entries = byThread.get(entry.threadId) ?? [];
      entries.push(entry);
      byThread.set(entry.threadId, entries);
    }

    const pricingChanged: string[] = [];
    for (const [threadId, entries] of byThread) {
      // Only the gates' own lines and their turns' parent lines can price
      // them; a long thread's other lines are not read.
      const pricingLines =
        typeof this.context.stores.usage.readTokenMiserGatePricingLines === "function"
          ? await this.context.stores.usage.readTokenMiserGatePricingLines({
              backend: "codex",
              sourceItemIds: entries.map(tokenMiserMonitorId),
              threadId,
              turnIds: [...new Set(entries.map((entry) => entry.turnId))],
            })
          : typeof this.context.stores.usage.readThreadPricing === "function"
            ? (await this.context.stores.usage.readThreadPricing({
                backend: "codex",
                threadId,
              })).lines
            : undefined;
      // Only gates that predate observed replay tracking read invocations.
      const toolAccounting =
        entries.some((entry) => entry.replayTrackingVersion !== 2)
        && typeof this.context.stores.toolAccounting.readThreadToolAccounting === "function"
          ? await this.context.stores.toolAccounting.readThreadToolAccounting({
              backend: "codex",
              includeAllInvocations: true,
              threadId,
            })
          : undefined;
      // A gate's stored line names the gate as its source item, so the
      // narrow read finds any line a gate could otherwise insert twice.
      const knownUsageLineIds = new Set(
        pricingLines?.map((line) => line.usageLineId) ?? [],
      );
      const subAgents: ThreadSubAgentSummary[] = [];
      const usageLines: ThreadUsageLineRecord[] = [];
      const indexes: TokenMiserLedgerIndexes = {
        pricing: indexTokenMiserPricingLines(pricingLines ?? []),
        replays: indexTokenMiserCachedReplays(toolAccounting?.invocations ?? []),
      };

      for (const entry of entries) {
        const artifact = this.buildTokenMiserLedgerArtifact({ entry, indexes });
        // One keyed read per gate in this batch, not the thread's whole history.
        const existingSubAgent = await this.context.stores.subAgents.getThreadSubAgent({
          backend: "codex",
          threadId,
          monitorId: artifact.subAgent.monitorId,
        });
        // Compare the fields the rail actually renders, not the whole record:
        // owner ids change every process, so a whole-record compare would
        // rewrite every gate on every launch. But comparing accounting alone
        // meant a new rendered field — `parentTurnId`, which the rail nests
        // on — never reached gates whose numbers had not moved, so a restart
        // left them un-nested indefinitely.
        if (
          !existingSubAgent
          || tokenMiserSubAgentProjectionChanged(
            existingSubAgent,
            artifact.subAgent,
          )
        ) {
          subAgents.push(artifact.subAgent);
        }
        if (
          artifact.gateUsageLine
          && !knownUsageLineIds.has(artifact.gateUsageLine.usageLineId)
        ) {
          logUnpricedThreadUsageLine(artifact.gateUsageLine);
          usageLines.push(artifact.gateUsageLine);
        }
      }

      if (subAgents.length > 0) {
        if (typeof this.context.stores.subAgents.upsertThreadSubAgents === "function") {
          await this.context.stores.subAgents.upsertThreadSubAgents({
            backend: "codex",
            threadId,
            subAgents,
          });
        } else {
          for (const subAgent of subAgents) {
            await this.context.stores.subAgents.upsertThreadSubAgent({
              backend: "codex",
              threadId,
              subAgent,
            });
          }
        }
        this.host().invalidateThreadListCache("codex");
      }
      if (usageLines.length > 0) {
        if (typeof this.context.stores.usage.upsertThreadUsageLines === "function") {
          await this.context.stores.usage.upsertThreadUsageLines({ lines: usageLines });
        } else {
          for (const line of usageLines) {
            await this.context.stores.usage.upsertThreadUsageLine!({ line });
          }
        }
      }
      const clearedLive = this.clearLiveTokenMiserLedgerEntries(
        threadId,
        entries,
      );
      for (const entry of entries) {
        this.pendingTokenMiserInterceptions.delete(entry.objectId);
      }
      if (subAgents.length > 0 || clearedLive) {
        await this.context.emit({
          backend: "codex",
          notification: {
            method: "thread/subAgents/updated",
            params: {
              navigationChanged: false,
              threadId,
            },
          },
        });
      }
      if (usageLines.length > 0 || clearedLive) {
        pricingChanged.push(threadId);
        if (options.publishPricing !== false) {
          await this.emitThreadPricingUpdated({
            backend: "codex",
            threadId,
          });
        }
      }
    }
    return pricingChanged;
  }

  trackRecentThreadUsageTurn(event: AgentEvent): void {
    if (event.notification.method === "turn/started") {
      const threadId = event.notification.params.threadId;
      const turnId = readOptionalString(event.notification.params, ["turnId"])
        ?? readOptionalString(readRecord(event.notification.params.turn) ?? {}, ["id"]);
      if (turnId) {
        const accountKey = JSON.stringify([event.backend, threadId, turnId]);
        if (!this.usageTurnAccounts.has(accountKey)) {
          this.usageTurnAccounts.set(accountKey, this.host().captureUsageAccount(event.backend, threadId));
          if (this.usageTurnAccounts.size > 1_000) {
            this.usageTurnAccounts.delete(this.usageTurnAccounts.keys().next().value!);
          }
        }
        const startedTurn = readRecord(event.notification.params.turn);
        const startedAt = normalizeNotificationTimestamp(
          startedTurn?.startedAt ?? startedTurn?.started_at,
        );
        if (typeof startedAt === "number") {
          this.usageTurnStartTimes.set(accountKey, startedAt);
          if (this.usageTurnStartTimes.size > 1_000) {
            this.usageTurnStartTimes.delete(this.usageTurnStartTimes.keys().next().value!);
          }
        }
      }
      const key = [event.backend, threadId].join(":");
      const completedTurn = this.recentlyCompletedThreadUsageTurns.get(key);
      if (completedTurn) {
        const completedTurnUsageKey = [
          event.backend,
          threadId,
          completedTurn.turnId,
          "live-token-usage",
        ].join(":");
        this.liveThreadUsageAggregates.delete(completedTurnUsageKey);
        this.liveThreadRequestUsage.delete(completedTurnUsageKey);
      }
      this.recentlyCompletedThreadUsageTurns.delete(key);
      return;
    }
    if (
      event.notification.method !== "turn/completed"
      && event.notification.method !== "turn/failed"
      && event.notification.method !== "turn/cancelled"
    ) {
      return;
    }
    const turnId = turnIdFromTerminalNotification(event.notification);
    if (!turnId) {
      return;
    }
    const turn = readRecord(event.notification.params.turn);
    const completedAt = completedAtFromTerminalNotification(event.notification);
    const startedAt = normalizeNotificationTimestamp(
      turn?.startedAt ?? turn?.started_at,
    );
    this.recentlyCompletedThreadUsageTurns.set(
      [event.backend, event.notification.params.threadId].join(":"),
      {
        turnId,
        ...(typeof completedAt === "number" ? { completedAt } : {}),
        ...(typeof startedAt === "number" ? { startedAt } : {}),
      },
    );
  }
}
