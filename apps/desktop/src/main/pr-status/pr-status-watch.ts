import { randomUUID } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerTurnInputItem,
  PrSummary,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { buildThreadIdentityKey } from "@pwragent/shared";
import type {
  OverlayStoreLike,
  PrStatusWatchClaim,
} from "../state/overlay-store-sqlite.js";

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
>;

type PrStatusWatchRegistry = {
  submitTurnIfIdle(params: {
    backend: AppServerBackendKind;
    threadId: string;
    input: AppServerTurnInputItem[];
    origin: "automation";
    messageOrigin: { kind: "pwragent" };
  }): Promise<{ status: "started" | "busy"; turnId?: string }>;
};

export type PrStatusWatchOutcome = "success" | "failure";

export class PrStatusWatchCoordinator {
  private readonly ownerId = randomUUID();

  constructor(
    private readonly options: {
      store: PrStatusWatchStore;
      registry: PrStatusWatchRegistry;
      isBackgroundPollingEnabled?: () => boolean;
      now?: () => number;
    },
  ) {}

  async handleStatusSnapshot(
    pr: PrSummary,
    observedAt: number,
    failureCoveredThreadKeys: ReadonlySet<string> = new Set(),
  ): Promise<number> {
    if (this.options.isBackgroundPollingEnabled?.() === false) return 0;
    const headSha = pr.headSha?.trim();
    if (!headSha) return 0;

    const prKey = buildPullRequestStatusKey(pr);
    await this.options.store.supersedeThreadPrStatusWatches({
      prKey,
      headSha,
      now: observedAt,
    });

    const outcome = getPrStatusWatchOutcome(pr);
    if (!outcome) return 0;

    const now = this.now();
    const claims = await this.options.store.claimThreadPrStatusWatches({
      prKey,
      headSha,
      outcome,
      now,
      ownerId: this.ownerId,
      leaseExpiresAt: now + PR_STATUS_WATCH_LEASE_MS,
      maxAttempts: PR_STATUS_WATCH_MAX_DISPATCH_ATTEMPTS,
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
    return claims.length;
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
      && failureCoveredThreadKeys.has(buildThreadIdentityKey(
        claim.watch.backend,
        claim.watch.threadId,
      ))
    ) {
      await this.options.store.finishThreadPrStatusWatch({
        watchId: claim.watch.watchId,
        ownerId: this.ownerId,
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
        messageOrigin: { kind: "pwragent" },
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
  const checkState = pr.checkState ?? pr.state;
  if (checkState === "failing") return "failure";
  if (checkState === "passing") return "success";
  return undefined;
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
