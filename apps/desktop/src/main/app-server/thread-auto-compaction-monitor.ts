import {
  effectiveAutoCompactionRules,
  resolveAutoCompactionThreshold,
  type AutoCompactionThreshold,
  type DesktopAutoCompactionRule,
} from "@pwragent/shared/auto-compaction";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type {
  AppServerBackendKind,
  AppServerNotification,
  AppServerThreadMessageOrigin,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  INITIAL_AUTO_COMPACTION_STATE,
  isAutoCompactionInFlight,
  stepAutoCompaction,
  type AutoCompactionCommand,
  type AutoCompactionContext,
  type AutoCompactionInput,
  type AutoCompactionState,
} from "@pwragent/owner-core/auto-compaction-lifecycle";

/** Auto-compaction messages carry this origin, so the transcript names them. */
export const AUTO_COMPACTION_ORIGIN: AppServerThreadMessageOrigin = {
  kind: "pwragent",
  systemReason: "auto-compaction",
};

/** After a steered `/compact` ends the turn it was steered into. */
export const AUTO_COMPACTION_CONTINUATION_TEXT = [
  "PwrAgent compacted this conversation because it reached its context budget.",
  "Continue the work you were doing before the compaction.",
  "If it was already complete, reply with a short summary instead.",
].join(" ");

/**
 * How long after a compaction's turn ends to wait for evidence (a lower fill
 * or a provider compaction report) before judging that it did not help.
 */
export const AUTO_COMPACTION_SETTLE_MS = 15_000;

export type ThreadAutoCompactionHost = {
  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  /** Saved rules; the monitor merges the built-in defaults. */
  resolveSavedRules(): readonly DesktopAutoCompactionRule[];
  resolveThreadModel(params: { backend: AppServerBackendKind; threadId: string }): Promise<string | undefined>;
  /** The running turn's id, or undefined when the thread is idle. */
  activeTurnId(params: { backend: AppServerBackendKind; threadId: string }): string | undefined;
  support(params: { backend: AppServerBackendKind; threadId: string }):
    | Pick<AutoCompactionContext, "canSteer" | "canStart">
    | Promise<Pick<AutoCompactionContext, "canSteer" | "canStart">>;
  steerCompact(params: {
    backend: AppServerBackendKind;
    threadId: string;
    turnId: string;
    requestId: string;
  }): Promise<void>;
  startCompact(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<{ status: "started"; turnId?: string } | { status: "busy" }>;
  startContinuation(params: { backend: AppServerBackendKind; threadId: string }): Promise<void>;
  publish(event: AgentEvent): Promise<void>;
  log: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

type ThreadEntry = {
  backend: AppServerBackendKind;
  threadId: string;
  state: AutoCompactionState;
  threshold?: AutoCompactionThreshold;
  /** Serializes this thread's inputs across awaits. */
  chain: Promise<void>;
  settleTimer?: unknown;
  published?: string;
};

type Notification<M extends AppServerNotification["method"]> = Extract<AppServerNotification, { method: M }>;

type ContextFill = { usedTokens: number; reportedContextWindow: number; model?: string };

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * Codex's `thread/tokenUsage/updated`: the last request's total is the
 * context in use, against `modelContextWindow`. The renderer's moon reads the
 * same pair.
 */
export function readCodexContextFill(tokenUsage: unknown): Omit<ContextFill, "model"> | undefined {
  const root = readRecord(readRecord(tokenUsage)?.tokenUsage) ?? readRecord(tokenUsage);
  const last = readRecord(root?.last) ?? readRecord(root?.last_token_usage);
  const usedTokens = readNumber(last, ["totalTokens", "total_tokens"]);
  const reportedContextWindow = readNumber(root, ["modelContextWindow", "model_context_window"]);
  if (usedTokens === undefined || usedTokens < 0 || !reportedContextWindow || reportedContextWindow <= 0) {
    return undefined;
  }
  return { usedTokens, reportedContextWindow };
}

function isContextCompactionItem(notification: AppServerNotification): boolean {
  if (notification.method !== "item/completed") return false;
  const type = readRecord(readRecord(notification.params)?.item)?.type;
  return typeof type === "string" && type.replace(/[-_\s]/gu, "").toLowerCase() === "contextcompaction";
}

/** A pending id is the registry's placeholder, never a provider turn. */
function providerTurnId(turnId: string | undefined): string | undefined {
  return turnId && !turnId.startsWith("pending:") ? turnId : undefined;
}

/**
 * Watches each local thread's context fill against its auto-compaction rule
 * and compacts it through the owner: a `/compact` steered into the running
 * turn where the provider takes one, or a compaction started between turns.
 * The lifecycle is `stepAutoCompaction`; this class turns provider events
 * into its inputs and carries out its commands. State is in memory only.
 */
export class ThreadAutoCompactionMonitor {
  private readonly threads = new Map<string, ThreadEntry>();
  private unsubscribe?: () => void;
  private rulesKey = "";
  private requestSequence = 0;

  constructor(private readonly host: ThreadAutoCompactionHost) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.host.onEvent((event) => this.observe(event));
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const entry of this.threads.values()) this.clearSettleTimer(entry);
    this.threads.clear();
  }

  /** Test seam: the lifecycle state for one thread. */
  stateFor(backend: AppServerBackendKind, threadId: string): AutoCompactionState | undefined {
    return this.threads.get(`${backend}\n${threadId}`)?.state;
  }

  /** Resolves once every input queued so far has been applied. */
  async idle(): Promise<void> {
    await Promise.all([...this.threads.values()].map((entry) => entry.chain));
  }

  observe(event: AgentEvent): void {
    // Only the owner compacts. Events relayed from a peer belong to it.
    if (event.federationTarget?.scope === "remote") return;
    if (event.notification.method === "thread/autoCompaction/updated") return;
    const notification = event.notification;
    const params = readRecord(notification.params);
    const threadId = typeof params?.threadId === "string" ? params.threadId : undefined;
    if (!threadId) return;
    switch (notification.method) {
      case "thread/contextWindow/updated": {
        const fill = (notification as Notification<"thread/contextWindow/updated">).params;
        this.enqueue(event.backend, threadId, (entry) => this.onFill(entry, {
          usedTokens: fill.usedTokens,
          reportedContextWindow: fill.modelContextWindow,
        }));
        return;
      }
      case "thread/tokenUsage/updated": {
        // ACP and Claude report fill on their own event; their usage here is
        // per turn, not context.
        if (event.backend !== "codex") return;
        const usage = (notification as Notification<"thread/tokenUsage/updated">).params;
        const fill = readCodexContextFill(usage.tokenUsage);
        if (!fill) return;
        const model = usage.model;
        this.enqueue(event.backend, threadId, (entry) => this.onFill(entry, { ...fill, ...(model ? { model } : {}) }));
        return;
      }
      case "turn/started": {
        const started = (notification as Notification<"turn/started">).params;
        const turnId = providerTurnId(started.turn?.id ?? started.turnId);
        if (!turnId) return;
        this.enqueueKnown(event.backend, threadId, (entry) => this.apply(entry, { kind: "turn-started", turnId }));
        return;
      }
      case "turn/completed":
      case "turn/failed":
      case "turn/cancelled": {
        const ended = (notification as Notification<"turn/completed" | "turn/failed" | "turn/cancelled">).params;
        const turnId = providerTurnId(ended.turnId ?? undefined);
        this.enqueueKnown(event.backend, threadId, async (entry) => this.apply(entry, {
          kind: "turn-ended",
          ...(turnId ? { turnId } : {}),
          context: await this.context(entry, true),
        }));
        return;
      }
      case "thread/compacted":
        this.enqueueKnown(event.backend, threadId, async (entry) => this.apply(entry, {
          kind: "compaction-observed",
          context: await this.context(entry),
        }));
        return;
      default:
        if (isContextCompactionItem(notification)) {
          this.enqueueKnown(event.backend, threadId, async (entry) => this.apply(entry, {
            kind: "compaction-observed",
            context: await this.context(entry),
          }));
        }
    }
  }

  private key(backend: AppServerBackendKind, threadId: string): string {
    return `${backend}\n${threadId}`;
  }

  /** Fill reports create a thread's entry; other events only reach threads already watched. */
  private enqueue(
    backend: AppServerBackendKind,
    threadId: string,
    work: (entry: ThreadEntry) => Promise<void> | void,
  ): void {
    const key = this.key(backend, threadId);
    let entry = this.threads.get(key);
    if (!entry) {
      entry = { backend, threadId, state: INITIAL_AUTO_COMPACTION_STATE, chain: Promise.resolve() };
      this.threads.set(key, entry);
    }
    const target = entry;
    target.chain = target.chain
      .then(() => work(target))
      .catch((error: unknown) => {
        this.host.log.warn("auto-compaction input failed", {
          backend,
          threadId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private enqueueKnown(
    backend: AppServerBackendKind,
    threadId: string,
    work: (entry: ThreadEntry) => Promise<void> | void,
  ): void {
    if (this.threads.has(this.key(backend, threadId))) this.enqueue(backend, threadId, work);
  }

  private resolveRules() {
    const saved = this.host.resolveSavedRules();
    const key = JSON.stringify(saved);
    if (key !== this.rulesKey) {
      // A rule change starts every thread over; the next fill re-evaluates it.
      const first = this.rulesKey === "";
      this.rulesKey = key;
      if (!first) {
        for (const entry of this.threads.values()) {
          // An open or accepted request keeps its tracking: reset, its answer
          // would be dropped and the next fill would send a second `/compact`.
          if (isAutoCompactionInFlight(entry.state.phase)) continue;
          this.clearSettleTimer(entry);
          entry.state = INITIAL_AUTO_COMPACTION_STATE;
        }
      }
    }
    return effectiveAutoCompactionRules(saved);
  }

  /**
   * The thread's context now. A turn that just ended can still read as
   * active while its terminal event is being delivered, so `turn-ended`
   * passes `ended` to report it idle.
   */
  private async context(entry: ThreadEntry, ended = false): Promise<AutoCompactionContext> {
    const support = await this.host.support(entry);
    const activeTurnId = this.host.activeTurnId(entry);
    const turnId = ended ? undefined : providerTurnId(activeTurnId);
    const running = !ended && activeTurnId !== undefined;
    return {
      turnRunning: running,
      ...(turnId ? { turnId } : {}),
      canSteer: support.canSteer,
      canStart: support.canStart,
    };
  }

  private async onFill(entry: ThreadEntry, fill: ContextFill): Promise<void> {
    if (!Number.isFinite(fill.usedTokens) || fill.usedTokens < 0) return;
    const rules = this.resolveRules();
    const model = fill.model ?? await this.host.resolveThreadModel(entry);
    entry.threshold = resolveAutoCompactionThreshold({
      rules,
      backend: entry.backend,
      model,
      reportedContextWindow: fill.reportedContextWindow,
    });
    await this.apply(entry, {
      kind: "fill",
      usedTokens: fill.usedTokens,
      ...(entry.threshold
        ? {
            threshold: {
              triggerTokens: entry.threshold.triggerTokens,
              rearmTokens: entry.threshold.rearmTokens,
              duringTurn: entry.threshold.duringTurn,
            },
          }
        : {}),
      context: await this.context(entry),
    });
  }

  private async apply(entry: ThreadEntry, input: AutoCompactionInput): Promise<void> {
    const step = stepAutoCompaction(entry.state, input);
    entry.state = step.state;
    this.syncSettleTimer(entry);
    await this.publishState(entry);
    if (step.command) await this.run(entry, step.command);
  }

  private async run(entry: ThreadEntry, command: AutoCompactionCommand): Promise<void> {
    const identity = { backend: entry.backend, threadId: entry.threadId };
    switch (command.kind) {
      case "steer-compact": {
        this.host.log.info("auto-compaction steering /compact", {
          ...identity, turnId: command.turnId, usedTokens: command.usedTokens, triggerTokens: command.triggerTokens,
        });
        try {
          await this.host.steerCompact({
            ...identity,
            turnId: command.turnId,
            requestId: `auto-compaction:${entry.backend}:${entry.threadId}:${++this.requestSequence}`,
          });
          await this.apply(entry, { kind: "dispatch-accepted", context: await this.context(entry) });
        } catch (error) {
          this.host.log.warn("auto-compaction steer refused", {
            ...identity, error: error instanceof Error ? error.message : String(error),
          });
          await this.apply(entry, { kind: "dispatch-refused", context: await this.context(entry) });
        }
        return;
      }
      case "start-compact": {
        this.host.log.info("auto-compaction starting /compact", {
          ...identity, usedTokens: command.usedTokens, triggerTokens: command.triggerTokens,
        });
        try {
          const result = await this.host.startCompact(identity);
          if (result.status === "busy") {
            await this.apply(entry, { kind: "dispatch-deferred" });
            return;
          }
          const turnId = providerTurnId(result.turnId);
          await this.apply(entry, {
            kind: "dispatch-accepted",
            ...(turnId ? { turnId } : {}),
            context: await this.context(entry),
          });
        } catch (error) {
          this.host.log.warn("auto-compaction start refused", {
            ...identity, error: error instanceof Error ? error.message : String(error),
          });
          await this.apply(entry, { kind: "dispatch-refused", context: await this.context(entry) });
        }
        return;
      }
      case "start-continuation":
        try {
          await this.host.startContinuation(identity);
        } catch (error) {
          // One attempt. The operator sees the compaction in the transcript.
          this.host.log.warn("auto-compaction continuation failed", {
            ...identity, error: error instanceof Error ? error.message : String(error),
          });
        }
    }
  }

  private syncSettleTimer(entry: ThreadEntry): void {
    const settling = entry.state.phase === "compacting" && entry.state.turnEnded === true;
    if (!settling) {
      this.clearSettleTimer(entry);
      return;
    }
    if (entry.settleTimer !== undefined) return;
    const setTimer = this.host.setTimer ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms);
      timer.unref?.();
      return timer;
    });
    entry.settleTimer = setTimer(() => {
      entry.settleTimer = undefined;
      this.enqueueKnown(entry.backend, entry.threadId, async (current) => this.apply(current, {
        kind: "settle-timeout",
        context: await this.context(current),
      }));
    }, AUTO_COMPACTION_SETTLE_MS);
  }

  private clearSettleTimer(entry: ThreadEntry): void {
    if (entry.settleTimer === undefined) return;
    (this.host.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(entry.settleTimer);
    entry.settleTimer = undefined;
  }

  /** Publishes the phase when it, or the threshold it is judged against, changes. */
  private async publishState(entry: ThreadEntry): Promise<void> {
    const { state, threshold } = entry;
    const params = {
      threadId: entry.threadId,
      phase: state.phase,
      ...(threshold
        ? {
            triggerTokens: threshold.triggerTokens,
            effectiveContextWindow: threshold.effectiveContextWindow,
            reportedContextWindow: threshold.reportedContextWindow,
          }
        : {}),
      ...(state.via ? { via: state.via } : {}),
      ...(state.dispatchedAtTokens !== undefined ? { dispatchedAtTokens: state.dispatchedAtTokens } : {}),
      ...(state.heldReason ? { heldReason: state.heldReason } : {}),
    };
    const signature = JSON.stringify(params);
    if (signature === entry.published) return;
    // A thread no rule covers has nothing to show until a rule applies.
    if (entry.published === undefined && !threshold && state.phase === "armed") return;
    entry.published = signature;
    await this.host.publish({
      backend: entry.backend,
      notification: { method: "thread/autoCompaction/updated", params },
    }).catch((error: unknown) => {
      this.host.log.warn("auto-compaction state publish failed", {
        backend: entry.backend,
        threadId: entry.threadId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

/** The registry calls the monitor needs, so tests can supply a fake. */
export type AutoCompactionRegistry = {
  onEvent(listener: (event: AgentEvent) => void | Promise<void>): () => void;
  getActiveTurnForThread(params: { backend: AppServerBackendKind; threadId: string }): { turnId: string } | undefined;
  autoCompactionSupport(params: { backend: AppServerBackendKind; threadId: string }):
    | Pick<AutoCompactionContext, "canSteer" | "canStart">
    | Promise<Pick<AutoCompactionContext, "canSteer" | "canStart">>;
  resolveAutoCompactionModel(params: { backend: AppServerBackendKind; threadId: string }): Promise<string | undefined>;
  startAutoCompaction(params: {
    backend: AppServerBackendKind;
    threadId: string;
    messageOrigin: AppServerThreadMessageOrigin;
  }): Promise<{ status: "started"; turnId?: string } | { status: "busy" }>;
  steerTurn(
    params: {
      backend: AppServerBackendKind;
      threadId: string;
      expectedTurnId: string;
      requestId: string;
      input: { type: "text"; text: string }[];
    },
    origin?: AppServerThreadMessageOrigin,
  ): Promise<unknown>;
  submitTurnIfIdle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: { type: "text"; text: string }[];
    messageOrigin?: AppServerThreadMessageOrigin;
  }): Promise<{ status: string }>;
  publishLocalEvent(event: AgentEvent): Promise<void>;
};

export function createRegistryAutoCompactionMonitor(params: {
  registry: AutoCompactionRegistry;
  resolveSavedRules: () => readonly DesktopAutoCompactionRule[];
  log: ThreadAutoCompactionHost["log"];
}): ThreadAutoCompactionMonitor {
  const { registry } = params;
  return new ThreadAutoCompactionMonitor({
    onEvent: (listener) => registry.onEvent(listener),
    resolveSavedRules: params.resolveSavedRules,
    resolveThreadModel: (identity) => registry.resolveAutoCompactionModel(identity),
    activeTurnId: (identity) => registry.getActiveTurnForThread(identity)?.turnId,
    support: (identity) => registry.autoCompactionSupport(identity),
    steerCompact: async ({ turnId, requestId, ...identity }) => {
      await registry.steerTurn({
        ...identity,
        expectedTurnId: turnId,
        requestId,
        input: [{ type: "text", text: "/compact" }],
      }, AUTO_COMPACTION_ORIGIN);
    },
    startCompact: (identity) => registry.startAutoCompaction({ ...identity, messageOrigin: AUTO_COMPACTION_ORIGIN }),
    startContinuation: async (identity) => {
      const result = await registry.submitTurnIfIdle({
        ...identity,
        input: [{ type: "text", text: AUTO_COMPACTION_CONTINUATION_TEXT }],
        messageOrigin: AUTO_COMPACTION_ORIGIN,
      });
      if (result.status !== "started") throw new Error("The thread was busy; its next turn carries the work on.");
    },
    publish: (event) => registry.publishLocalEvent(event),
    log: params.log,
  });
}
