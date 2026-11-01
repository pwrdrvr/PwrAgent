import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  PrSummary,
  PullRequestTerminalDetails,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import {
  buildPullRequestStatusKey,
  buildThreadIdentityKey,
} from "@pwragent/shared";
import type {
  OverlayStoreLike,
  PrStatusWatchClaim,
  PrStatusWatchThreadRef,
} from "../state/overlay-store-sqlite.js";
import {
  fallbackTerminalDetails,
  formatTerminalDetailsLines,
  terminalOutcomeOf,
} from "./pr-terminal-details";

export const PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS = 3;
export const PR_STATUS_WATCH_LEASE_MS = 60_000;
const PR_STATUS_WATCH_HEARTBEAT_MS = 20_000;

type PrStatusWatchStore = Pick<
  OverlayStoreLike,
  | "claimThreadPrStatusWatches"
  | "finishThreadPrStatusWatch"
  | "releaseThreadPrStatusWatch"
  | "renewThreadPrStatusWatchLease"
  | "advanceThreadPrStatusWatches"
  | "claimThreadPrTerminalWatches"
  | "finishThreadPrTerminalWatch"
>;

type PrStatusWatchRegistry = {
  submitTurnIfIdle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: "automation";
    messageOrigin: AppServerThreadMessageOrigin;
  }): Promise<{ status: "started" | "busy"; turnId?: string }>;
};

export type PrStatusWatchOutcome = "success" | "failure";

/** Terminal details are immutable once read; keep a few for busy retries. */
const TERMINAL_DETAILS_CACHE_LIMIT = 32;

export class PrStatusWatchCoordinator {
  private readonly ownerId = randomUUID();
  private readonly terminalDetailsCache = new Map<string, PullRequestTerminalDetails>();

  constructor(
    private readonly options: {
      store: PrStatusWatchStore;
      registry: PrStatusWatchRegistry;
      isBackgroundPollingEnabled?: () => boolean;
      /** Reads merge details from the forge; a throw falls back to cached status. */
      fetchTerminalDetails?: (pr: PrSummary) => Promise<PullRequestTerminalDetails | undefined>;
      /**
       * Work PwrAgent does for the watching thread before it wakes, such as
       * releasing its sandboxes. Returns lines for the wake message. It must
       * bound its own time; a throw only drops the lines.
       */
      prepareTerminalWake?: (params: {
        watch: ThreadPullRequestWatchSummary;
        pr: PrSummary;
      }) => Promise<string[]>;
      /**
       * A thread's watches changed: one woke it, gave up, moved to a new
       * head, or lost its baseline. A throw is ignored.
       */
      onWatchesChanged?: (threads: PrStatusWatchThreadRef[]) => void | Promise<void>;
      now?: () => number;
    },
  ) {}

  async handleStatusSnapshot(
    pr: PrSummary,
    observedAt: number,
    failureCoveredThreadKeys: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return 0;
    const terminal = terminalOutcomeOf(pr) !== undefined;
    const dispatched = terminal
      ? await this.handleTerminalSnapshot(pr, observedAt)
      : 0;
    const headSha = pr.headSha?.trim();
    if (!headSha) return dispatched;

    const prKey = buildPullRequestStatusKey(pr);
    const outcome = getPrStatusWatchOutcome(pr);
    const advanced = await this.options.store.advanceThreadPrStatusWatches({
      prKey,
      headSha,
      checksRunning: outcome === undefined,
      now: observedAt,
    });
    await this.notifyWatchesChanged(advanced.threads);
    if (!outcome) return dispatched;

    const now = this.now();
    const failedCheckUrl = outcome === "failure" ? pr.failedCheckUrl : undefined;
    // Auto-fix handles a covered thread's failure. Its watch keeps waiting
    // when it also asked for success, so a later pass still wakes it.
    const skipThreadKeys = outcome === "failure" ? failureCoveredThreadKeys : undefined;
    const claims = await this.options.store.claimThreadPrStatusWatches({
      prKey,
      headSha,
      outcome,
      now,
      ownerId: this.ownerId,
      leaseExpiresAt: now + PR_STATUS_WATCH_LEASE_MS,
      maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
      skipThreadsWithTerminalWatch: terminal,
      ...(failedCheckUrl ? { failedCheckUrl } : {}),
      ...(skipThreadKeys?.size ? { skipThreadKeys } : {}),
    });
    for (const claim of claims) {
      await this.dispatchClaim(
        claim,
        pr,
        outcome,
        observedAt,
        failureCoveredThreadKeys,
      );
    }
    return dispatched + claims.length;
  }

  /**
   * Wake every thread whose merge/close watch matches this terminal PR.
   * Called from each status snapshot, and with cached status after a busy
   * thread goes idle or the app restarts, because the poller stops fetching
   * a PR once it is merged or closed.
   */
  async handleTerminalSnapshot(
    pr: PrSummary,
    observedAt: number,
  ): Promise<number> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return 0;
    const outcome = terminalOutcomeOf(pr);
    if (!outcome) return 0;
    const now = this.now();
    const claims = await this.options.store.claimThreadPrTerminalWatches({
      prKey: buildPullRequestStatusKey(pr),
      outcome,
      now,
      ownerId: this.ownerId,
      leaseExpiresAt: now + PR_STATUS_WATCH_LEASE_MS,
      maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
    });
    if (claims.length === 0) return 0;
    // Hold every lease across the forge read, so a slow lookup cannot let
    // another instance reclaim and deliver the same wake.
    const stopHeartbeats = claims.map((claim) =>
      this.startLeaseHeartbeat(claim.watch.watchId)
    );
    try {
      const details = await this.resolveTerminalDetails(pr);
      // Each thread's sandbox cleanup can wait on a remote MCP, so prepare
      // every wake at once rather than one thread after another.
      const extraLines = details
        ? await Promise.all(claims.map((claim) => this.prepareTerminalWake(claim, pr)))
        : [];
      for (const [index, claim] of claims.entries()) {
        await this.dispatchTerminalClaim(
          claim,
          pr,
          details,
          observedAt,
          extraLines[index] ?? [],
        );
      }
    } finally {
      for (const stop of stopHeartbeats) stop();
    }
    return claims.length;
  }

  /** Forge details when available, else what cached status can say. */
  async resolveTerminalDetails(
    pr: PrSummary,
  ): Promise<PullRequestTerminalDetails | undefined> {
    const prKey = buildPullRequestStatusKey(pr);
    const outcome = terminalOutcomeOf(pr);
    if (!outcome) return undefined;
    // A PR can close, reopen, and close again: the time names the event.
    const cacheKey = JSON.stringify([prKey, outcome, pr.mergedAt ?? pr.closedAt ?? null]);
    const cached = this.terminalDetailsCache.get(cacheKey);
    if (cached) return cached;
    if (!this.options.fetchTerminalDetails) {
      return fallbackTerminalDetails(pr, "No forge lookup is configured.");
    }
    try {
      const details = await this.options.fetchTerminalDetails(pr);
      if (details?.outcome === outcome) {
        this.terminalDetailsCache.delete(cacheKey);
        this.terminalDetailsCache.set(cacheKey, details);
        while (this.terminalDetailsCache.size > TERMINAL_DETAILS_CACHE_LIMIT) {
          const oldest = this.terminalDetailsCache.keys().next().value;
          if (oldest === undefined) break;
          this.terminalDetailsCache.delete(oldest);
        }
        return details;
      }
      return fallbackTerminalDetails(
        pr,
        details
          ? `The forge reported the PR as ${details.outcome}, not ${outcome}.`
          : "The forge returned no merge details.",
      );
    } catch (error) {
      return fallbackTerminalDetails(
        pr,
        `The forge lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async prepareTerminalWake(
    claim: PrStatusWatchClaim,
    pr: PrSummary,
  ): Promise<string[]> {
    try {
      return await this.options.prepareTerminalWake?.({
        watch: claim.watch,
        pr,
      }) ?? [];
    } catch {
      return [];
    }
  }

  private async dispatchTerminalClaim(
    claim: PrStatusWatchClaim,
    pr: PrSummary,
    details: PullRequestTerminalDetails | undefined,
    observedAt: number,
    extraLines: string[],
  ): Promise<void> {
    const release = async (spendAttempt: boolean) =>
      await this.releaseClaim(claim, spendAttempt);
    const outcome = terminalOutcomeOf(pr);
    if (!details || !outcome || this.options.isBackgroundPollingEnabled?.() === false) {
      await release(false);
      return;
    }
    try {
      const submission = await this.options.registry.submitTurnIfIdle({
        backend: claim.watch.backend,
        threadId: claim.watch.threadId,
        input: [{
          type: "text",
          text: buildPrTerminalWatchPrompt({ details, observedAt, extraLines }),
        }],
        origin: "automation",
        messageOrigin: {
          kind: "pwragent",
          prAutomation: {
            kind: "watch",
            prKey: claim.watch.prKey,
            prNumber: claim.watch.prNumber,
            ...(claim.watch.prTitle
              ? { prTitle: claim.watch.prTitle }
              : {}),
            headSha: details.headSha ?? claim.watch.headSha,
            outcome,
          },
        },
      });
      if (submission.status === "busy") {
        await release(false);
        return;
      }
      await this.options.store.finishThreadPrTerminalWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        now: this.now(),
      });
      await this.notifyWatchesChanged([watchThreadRef(claim.watch)]);
    } catch {
      await release(true);
    }
  }

  private async dispatchClaim(
    claim: PrStatusWatchClaim,
    pr: PrSummary,
    outcome: PrStatusWatchOutcome,
    observedAt: number,
    failureCoveredThreadKeys: ReadonlySet<string>,
  ): Promise<void> {
    if (this.options.isBackgroundPollingEnabled?.() === false) {
      await this.releaseClaim(claim, false);
      return;
    }
    const failedCheckUrl = outcome === "failure" ? pr.failedCheckUrl : undefined;
    const finish = async (endedReason: "woke" | "covered_by_auto_fix") => {
      const threads = await this.options.store.finishThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        prKey: claim.watch.prKey,
        headSha: claim.watch.headSha,
        outcome,
        now: this.now(),
        endedReason,
        ...(failedCheckUrl ? { failedCheckUrl } : {}),
        ...(outcome === "failure" && failureCoveredThreadKeys.size > 0
          ? { skipThreadKeys: failureCoveredThreadKeys }
          : {}),
      });
      await this.notifyWatchesChanged(threads);
    };
    // Only this watch's own thread's Auto-fix can stand in for its wake.
    if (
      outcome === "failure"
      && failureCoveredThreadKeys.has(
        buildThreadIdentityKey(claim.watch.backend, claim.watch.threadId),
      )
    ) {
      await finish("covered_by_auto_fix");
      return;
    }
    const stopHeartbeat = this.startLeaseHeartbeat(claim.watch.watchId);
    try {
      const submission = await this.options.registry.submitTurnIfIdle({
        backend: claim.watch.backend,
        threadId: claim.watch.threadId,
        input: [{
          type: "text",
          text: buildPrStatusWatchPrompt({
            watch: claim.watch,
            pr,
            outcome,
            observedAt,
          }),
        }],
        origin: "automation",
        messageOrigin: {
          kind: "pwragent",
          prAutomation: {
            kind: "watch",
            prKey: claim.watch.prKey,
            prNumber: claim.watch.prNumber,
            ...(claim.watch.prTitle
              ? { prTitle: claim.watch.prTitle }
              : {}),
            headSha: claim.watch.headSha,
            outcome,
          },
        },
      });
      if (submission.status === "busy") {
        await this.releaseClaim(claim, false);
        return;
      }
      await finish("woke");
    } catch {
      await this.releaseClaim(claim, true);
    } finally {
      stopHeartbeat();
    }
  }

  private async releaseClaim(
    claim: PrStatusWatchClaim,
    spendAttempt: boolean,
  ): Promise<void> {
    const status = await this.options.store.releaseThreadPrStatusWatch({
      watchId: claim.watch.watchId,
      ownerId: this.ownerId,
      now: this.now(),
      spendAttempt,
      maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
    });
    if (status === "failed") {
      await this.notifyWatchesChanged([watchThreadRef(claim.watch)]);
    }
  }

  private async notifyWatchesChanged(
    threads: PrStatusWatchThreadRef[],
  ): Promise<void> {
    if (threads.length === 0 || !this.options.onWatchesChanged) return;
    try {
      await this.options.onWatchesChanged(threads);
    } catch {
      // Indicators re-read on the next change; a missed refresh is harmless.
    }
  }

  private startLeaseHeartbeat(watchId: string): () => void {
    const timer = setInterval(() => {
      const now = this.now();
      void this.options.store.renewThreadPrStatusWatchLease({
        watchId,
        ownerId: this.ownerId,
        now,
        leaseExpiresAt: now + PR_STATUS_WATCH_LEASE_MS,
      }).catch(() => undefined);
    }, PR_STATUS_WATCH_HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

function watchThreadRef(
  watch: ThreadPullRequestWatchSummary,
): PrStatusWatchThreadRef {
  return {
    backend: watch.backend,
    threadId: watch.threadId,
    prKey: watch.prKey,
  };
}

export function getPrStatusWatchOutcome(
  pr: PrSummary,
): PrStatusWatchOutcome | undefined {
  if (pr.lifecycleState === "merged") return "success";
  if (pr.lifecycleState === "closed") return "failure";
  if (pr.mergeState === "conflicting") return "failure";
  if (pr.checksStillRunning) return undefined;
  const checkState = pr.checkState ?? pr.state;
  if (checkState === "failing") return "failure";
  if (checkState === "passing") return "success";
  return undefined;
}

export function buildPrTerminalWatchPrompt(params: {
  details: PullRequestTerminalDetails;
  observedAt: number;
  /** Lines from work PwrAgent already did, such as sandbox cleanup. */
  extraLines?: string[];
}): string {
  const merged = params.details.outcome === "merged";
  const extraLines = params.extraLines ?? [];
  return [
    `PwrAgent resumed this thread because its pull request watch saw the PR ${
      merged ? "merged" : "closed without merge"
    }.`,
    "",
    "Pull request notification",
    ...formatTerminalDetailsLines(params.details),
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    ...extraLines,
    "",
    (extraLines.length > 0
      ? "PwrAgent has already acted on the sandboxes listed above: do not stop or delete them yourself, and report any it could not clean up. Release anything else this thread created only for this PR, unless the operator asked to keep it. "
      : "Release what this thread created only for this PR, such as a Sandboxer sandbox used to test it, unless the operator asked to keep it. ")
      + (merged
        ? "Report the merge, and continue only if the operator's prior request asked for follow-up after it lands."
        : "Report the close, and do not reopen or recreate the PR unless the operator asked for that.")
      + " Do not poll the PR or create a monitor thread.",
  ].join("\n");
}

function buildPrStatusWatchPrompt(params: {
  watch: ThreadPullRequestWatchSummary;
  pr: PrSummary;
  outcome: PrStatusWatchOutcome;
  observedAt: number;
}): string {
  const checkState = params.pr.checkState ?? params.pr.state ?? "unknown";
  return [
    "PwrAgent resumed this thread because its one-shot pull request watch completed.",
    "",
    "Pull request notification",
    `- PR: ${params.watch.prKey}`,
    `- URL: ${params.watch.prUrl}`,
    ...(params.watch.prTitle ? [`- Title: ${params.watch.prTitle}`] : []),
    `- Watched head SHA: ${params.watch.headSha}`,
    `- Outcome: ${params.outcome}`,
    `- Check state: ${checkState}`,
    `- Merge state: ${params.pr.mergeState ?? "unknown"}`,
    `- Lifecycle state: ${params.pr.lifecycleState ?? "open"}`,
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    "",
    params.outcome === "success"
      ? "Report that the watched PR checks succeeded and continue only if the operator's prior request requires another action. Do not poll CI or create a monitor thread."
      : "Report the failure unless the prior request already authorized you to investigate or repair it. Verify current provider state before changing code, and do not create a polling or monitor loop.",
  ].join("\n");
}
