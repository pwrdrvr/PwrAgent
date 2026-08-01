import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerTurnInputItem,
  PrSummary,
  ThreadOverlayState,
  ThreadPrAutoDispatchEventKind,
  ThreadPrAutoDispatchPending,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  parseThreadIdentityKey,
} from "@pwragent/shared";
import type {
  PrAutoDispatchPendingRecord,
  PrAutoDispatchScheduleResult,
} from "../state/overlay-store-sqlite";

export const MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT = 2;
export const PR_AUTO_DISPATCH_DELAY_MS = 30_000;

export type PrAutoDispatchOutcome = {
  threadKey: string;
  status:
    | "scheduled"
    | "dispatched"
    | "gate-off"
    | "not-actionable"
    | "missing-head"
    | "disabled"
    | "busy"
    | "pending"
    | "duplicate"
    | "attempt-limit"
    | "cancelled"
    | "stale"
    | "failed";
  fingerprint?: string;
  error?: string;
};

type PrAutoDispatchStore = {
  getThreadOverlayState(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<ThreadOverlayState | undefined>;
  scheduleThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    pending: ThreadPrAutoDispatchPending;
    prompt: string;
    maxAttempts: number;
    allowCancelledRearm?: boolean;
  }): Promise<PrAutoDispatchScheduleResult>;
  beginThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    maxAttempts: number;
    now: number;
  }): Promise<
    | { status: "ready"; attemptCount: number; record: PrAutoDispatchPendingRecord }
    | { status: "disabled" | "stale" | "attempt-limit" }
  >;
  restoreThreadPrAutoDispatchAfterBusy(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    scheduledAt: number;
    now: number;
  }): Promise<ThreadPrAutoDispatchPending | undefined>;
  finishThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    status: "dispatched" | "failed";
    now: number;
  }): Promise<void>;
  cancelThreadPrAutoDispatch(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
    now?: number;
    status?: "cancelled" | "resolved" | "superseded";
  }): Promise<boolean>;
  cancelPendingThreadPrAutoDispatchForPr(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    now: number;
  }): Promise<boolean>;
  resolveThreadPrAutoDispatchIncident(params: {
    backend: AppServerBackendKind;
    threadId: string;
    prKey: string;
    resolvedKinds: ThreadPrAutoDispatchEventKind[];
    now: number;
  }): Promise<void>;
  getThreadPrAutoDispatchPending(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<PrAutoDispatchPendingRecord | undefined>;
  listPendingThreadPrAutoDispatches(): Promise<Array<
    PrAutoDispatchPendingRecord & {
      backend: AppServerBackendKind;
      threadId: string;
    }
  >>;
};

type PrAutoDispatchRegistry = {
  submitTurnIfIdle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: "automation";
    messageOrigin: { kind: "pwragent" };
  }): Promise<
    | { status: "started"; turnId: string }
    | { status: "busy" }
  >;
};

export type PrAutoDispatchEvent = {
  eventKinds: ThreadPrAutoDispatchEventKind[];
  fingerprint: string;
  headSha: string;
  prKey: string;
};

export class PrAutoDispatchCoordinator {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly options: {
      store: PrAutoDispatchStore;
      registry: PrAutoDispatchRegistry;
      isBackgroundPollingEnabled?: () => boolean;
      isPrAttached?: (params: {
        backend: AppServerBackendKind;
        threadId: string;
        prKey: string;
      }) => boolean;
      getCurrentPr?: (prKey: string) => PrSummary | undefined;
      onPendingChanged?: (params: {
        backend: AppServerBackendKind;
        threadId: string;
        pending: ThreadPrAutoDispatchPending | null;
      }) => void | Promise<void>;
      now?: () => number;
    },
  ) {}

  async handleStatusSnapshot(params: {
    pr: PrSummary;
    threadKeys: string[];
    observedAt: number;
    backgroundPollingEnabled: boolean;
    operatorInitiated?: boolean;
  }): Promise<PrAutoDispatchOutcome[]> {
    if (!params.backgroundPollingEnabled) {
      return params.threadKeys.map((threadKey) => ({
        threadKey,
        status: "gate-off",
      }));
    }

    const eventKinds = getPrAutoDispatchEventKinds(params.pr);
    const event = buildPrAutoDispatchEvent(params.pr);
    const prKey = buildPullRequestStatusKey(params.pr);
    const resolvedKinds = getDefinitivelyResolvedEventKinds(params.pr);
    const outcomes: PrAutoDispatchOutcome[] = [];

    for (const threadKey of params.threadKeys) {
      const identity = parseThreadIdentityKey(threadKey);
      if (!identity) {
        outcomes.push({ threadKey, status: "disabled" });
        continue;
      }

      await this.options.store.resolveThreadPrAutoDispatchIncident({
        ...identity,
        prKey,
        resolvedKinds,
        now: params.observedAt,
      });

      if (!event) {
        const cancelled = await this.options.store
          .cancelPendingThreadPrAutoDispatchForPr({
            ...identity,
            prKey,
            now: params.observedAt,
          });
        if (cancelled) {
          this.clearTimer(threadKey);
          await this.notifyPending(identity, null);
        }
        outcomes.push({
          threadKey,
          status: eventKinds.length > 0 ? "missing-head" : "not-actionable",
        });
        continue;
      }

      const pending: ThreadPrAutoDispatchPending = {
        fingerprint: event.fingerprint,
        prKey: event.prKey,
        prNumber: params.pr.number,
        ...(params.pr.title ? { prTitle: params.pr.title } : {}),
        prUrl: params.pr.url,
        headSha: event.headSha,
        eventKinds: event.eventKinds,
        createdAt: params.observedAt,
        scheduledAt: params.observedAt + PR_AUTO_DISPATCH_DELAY_MS,
      };
      const result = await this.options.store.scheduleThreadPrAutoDispatch({
        ...identity,
        pending,
        prompt: buildPrAutoDispatchPrompt({
          event,
          observedAt: params.observedAt,
          pr: params.pr,
        }),
        maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
        allowCancelledRearm: params.operatorInitiated,
      });
      outcomes.push({
        threadKey,
        status: result.status,
        fingerprint: event.fingerprint,
      });
      if (result.pending) {
        this.arm(identity, result.pending);
      }
      if (result.status === "scheduled") {
        await this.notifyPending(identity, pending);
      }
    }
    return outcomes;
  }

  async cancelPending(params: {
    backend: AppServerBackendKind;
    threadId: string;
    fingerprint: string;
  }): Promise<boolean> {
    const cancelled = await this.options.store.cancelThreadPrAutoDispatch({
      ...params,
      now: this.now(),
    });
    if (cancelled) {
      this.clearTimer(this.threadKey(params));
      await this.notifyPending(params, null);
    }
    return cancelled;
  }

  async cancelAllPendingForThread(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): Promise<boolean> {
    const record = await this.options.store.getThreadPrAutoDispatchPending(params);
    if (!record) return false;
    return await this.cancelPending({
      ...params,
      fingerprint: record.pending.fingerprint,
    });
  }

  async resume(): Promise<void> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    const records = await this.options.store.listPendingThreadPrAutoDispatches();
    for (const record of records) {
      this.arm(record, record.pending);
    }
  }

  pause(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  close(): void {
    this.pause();
  }

  private arm(
    identity: { backend: AppServerBackendKind; threadId: string },
    pending: ThreadPrAutoDispatchPending,
  ): void {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    const threadKey = this.threadKey(identity);
    this.clearTimer(threadKey);
    const timer = setTimeout(() => {
      this.timers.delete(threadKey);
      void this.dispatchPending(identity, pending.fingerprint);
    }, Math.max(0, pending.scheduledAt - this.now()));
    timer.unref?.();
    this.timers.set(threadKey, timer);
  }

  private async dispatchPending(
    identity: { backend: AppServerBackendKind; threadId: string },
    fingerprint: string,
  ): Promise<void> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return;
    const record = await this.options.store.getThreadPrAutoDispatchPending(identity);
    if (!record || record.pending.fingerprint !== fingerprint) return;

    const currentPr = this.options.getCurrentPr?.(record.pending.prKey);
    const currentEvent = currentPr
      ? buildPrAutoDispatchEvent(currentPr)
      : undefined;
    const attached = this.options.isPrAttached?.({
      ...identity,
      prKey: record.pending.prKey,
    }) ?? true;
    if (
      !attached
      || !currentEvent
      || currentEvent.fingerprint !== fingerprint
    ) {
      await this.options.store.cancelThreadPrAutoDispatch({
        ...identity,
        fingerprint,
        now: this.now(),
        status: "superseded",
      });
      await this.notifyPending(identity, null);
      return;
    }

    const now = this.now();
    const begin = await this.options.store.beginThreadPrAutoDispatch({
      ...identity,
      fingerprint,
      maxAttempts: MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT,
      now,
    });
    if (begin.status !== "ready") {
      if (begin.status === "disabled") {
        await this.options.store.cancelThreadPrAutoDispatch({
          ...identity,
          fingerprint,
          now,
        });
      }
      if (begin.status !== "stale") {
        await this.notifyPending(identity, null);
      }
      return;
    }

    if (this.options.isBackgroundPollingEnabled?.() === false) {
      await this.restoreAfterBusy(identity, fingerprint, now);
      return;
    }

    try {
      const submission = await this.options.registry.submitTurnIfIdle({
        ...identity,
        input: [{
          type: "text",
          text: [
            begin.record.prompt,
            `- Automatic attempt: ${begin.attemptCount}/${MAX_PR_AUTO_DISPATCH_ATTEMPTS_PER_INCIDENT}`,
          ].join("\n"),
        }],
        origin: "automation",
        messageOrigin: { kind: "pwragent" },
      });
      if (submission.status === "busy") {
        await this.restoreAfterBusy(identity, fingerprint, now);
        return;
      }
      await this.options.store.finishThreadPrAutoDispatch({
        ...identity,
        fingerprint,
        status: "dispatched",
        now: this.now(),
      });
      await this.notifyPending(identity, null);
    } catch {
      await this.options.store.finishThreadPrAutoDispatch({
        ...identity,
        fingerprint,
        status: "failed",
        now: this.now(),
      });
      await this.notifyPending(identity, null);
    }
  }

  private async restoreAfterBusy(
    identity: { backend: AppServerBackendKind; threadId: string },
    fingerprint: string,
    now: number,
  ): Promise<void> {
    const pending = await this.options.store.restoreThreadPrAutoDispatchAfterBusy({
      ...identity,
      fingerprint,
      scheduledAt: now + PR_AUTO_DISPATCH_DELAY_MS,
      now,
    });
    if (!pending) return;
    await this.notifyPending(identity, pending);
    this.arm(identity, pending);
  }

  private async notifyPending(
    identity: { backend: AppServerBackendKind; threadId: string },
    pending: ThreadPrAutoDispatchPending | null,
  ): Promise<void> {
    await this.options.onPendingChanged?.({ ...identity, pending });
  }

  private clearTimer(threadKey: string): void {
    const timer = this.timers.get(threadKey);
    if (timer) clearTimeout(timer);
    this.timers.delete(threadKey);
  }

  private threadKey(params: {
    backend: AppServerBackendKind;
    threadId: string;
  }): string {
    return `${params.backend}:${params.threadId}`;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

export function getPrAutoDispatchEventKinds(
  pr: PrSummary,
): ThreadPrAutoDispatchEventKind[] {
  const eventKinds: ThreadPrAutoDispatchEventKind[] = [];
  if (pr.checkState === "failing") eventKinds.push("ci-failure");
  if (pr.mergeState === "conflicting") eventKinds.push("merge-conflict");
  return eventKinds;
}

export function buildPrAutoDispatchEvent(
  pr: PrSummary,
): PrAutoDispatchEvent | undefined {
  const eventKinds = getPrAutoDispatchEventKinds(pr);
  if (eventKinds.length === 0 || !pr.headSha) return undefined;
  const prKey = buildPullRequestStatusKey(pr);
  const fingerprintPayload = {
    version: 2,
    prKey,
    headSha: pr.headSha,
    eventKinds,
    checkState: eventKinds.includes("ci-failure") ? pr.checkState : undefined,
    mergeState: eventKinds.includes("merge-conflict") ? pr.mergeState : undefined,
  };
  return {
    eventKinds,
    headSha: pr.headSha,
    prKey,
    fingerprint: createHash("sha256")
      .update(JSON.stringify(fingerprintPayload))
      .digest("hex"),
  };
}

function getDefinitivelyResolvedEventKinds(
  pr: PrSummary,
): ThreadPrAutoDispatchEventKind[] {
  const resolved: ThreadPrAutoDispatchEventKind[] = [];
  // Pending/unknown are intentionally not healthy: a repair push normally
  // passes through pending before it can fail, and resetting here would turn
  // the finite attempt budget into an unbounded loop.
  if (pr.checkState === "passing") resolved.push("ci-failure");
  if (pr.mergeState === "mergeable") resolved.push("merge-conflict");
  return resolved;
}

function buildPrAutoDispatchPrompt(params: {
  event: PrAutoDispatchEvent;
  observedAt: number;
  pr: PrSummary;
}): string {
  return [
    "PwrAgent scheduled this bounded repair turn because an attached pull request needs attention.",
    "",
    "Pull request event",
    `- PR: ${params.event.prKey}`,
    `- URL: ${params.pr.url}`,
    `- Title: ${params.pr.title ?? "(untitled)"}`,
    `- Head SHA: ${params.event.headSha}`,
    `- Event kinds: ${params.event.eventKinds.join(", ")}`,
    `- Check state: ${params.pr.checkState ?? "unknown"}`,
    `- Merge state: ${params.pr.mergeState ?? "unknown"}`,
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    `- Dedupe fingerprint: ${params.event.fingerprint}`,
    "",
    "Investigate the current PR checks or merge conflict, make only scoped fixes, run relevant validation, and update the attached PR when appropriate. Verify current provider state before changing code. If the condition is external, transient, or no safe fix is available, explain that and stop; do not create another retry loop.",
  ].join("\n");
}
