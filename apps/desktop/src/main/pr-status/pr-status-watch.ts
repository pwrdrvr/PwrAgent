import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerThreadMessageOrigin,
  AppServerTurnInputItem,
  PrSummary,
  PullRequestTerminalDetails,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import type {
  OverlayStoreLike,
  PrStatusWatchClaim,
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
  | "supersedeThreadPrStatusWatches"
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
    await this.options.store.supersedeThreadPrStatusWatches({
      prKey,
      headSha,
      now: observedAt,
    });

    const outcome = getPrStatusWatchOutcome(pr);
    if (!outcome) return dispatched;

    const now = this.now();
    const claims = await this.options.store.claimThreadPrStatusWatches({
      prKey,
      headSha,
      outcome,
      now,
      ownerId: this.ownerId,
      leaseExpiresAt: now + PR_STATUS_WATCH_LEASE_MS,
      maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
      skipThreadsWithTerminalWatch: terminal,
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
      for (const claim of claims) {
        await this.dispatchTerminalClaim(claim, pr, details, observedAt);
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

  private async dispatchTerminalClaim(
    claim: PrStatusWatchClaim,
    pr: PrSummary,
    details: PullRequestTerminalDetails | undefined,
    observedAt: number,
  ): Promise<void> {
    const release = async (spendAttempt: boolean) =>
      await this.options.store.releaseThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        now: this.now(),
        spendAttempt,
        maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
      });
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
          text: buildPrTerminalWatchPrompt({ details, observedAt }),
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
      await this.options.store.releaseThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        now: this.now(),
        spendAttempt: false,
        maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
      });
      return;
    }
    if (
      outcome === "failure"
      && failureCoveredThreadKeys.size > 0
    ) {
      await this.options.store.finishThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        prKey: claim.watch.prKey,
        headSha: claim.watch.headSha,
        outcome,
        now: this.now(),
      });
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
        await this.options.store.releaseThreadPrStatusWatch({
          watchId: claim.watch.watchId,
          ownerId: this.ownerId,
          now: this.now(),
          spendAttempt: false,
          maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
        });
        return;
      }
      await this.options.store.finishThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        prKey: claim.watch.prKey,
        headSha: claim.watch.headSha,
        outcome,
        now: this.now(),
      });
    } catch {
      await this.options.store.releaseThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
        now: this.now(),
        spendAttempt: true,
        maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
      });
    } finally {
      stopHeartbeat();
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
}): string {
  const merged = params.details.outcome === "merged";
  return [
    `PwrAgent resumed this thread because its pull request watch saw the PR ${
      merged ? "merged" : "closed without merge"
    }.`,
    "",
    "Pull request notification",
    ...formatTerminalDetailsLines(params.details),
    `- Observed at: ${new Date(params.observedAt).toISOString()}`,
    "",
    "Release what this thread created only for this PR, such as a Sandboxer sandbox used to test it, unless the operator asked to keep it. "
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
