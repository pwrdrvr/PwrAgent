import type { PrSummary } from "@pwragent/shared";
import { getMainLogger } from "../log";
import type { PrRef } from "./github-graphql-client";
import { parsePrRefFromUrl } from "./github-graphql-client";
import { isTerminalPullRequest } from "./pr-derivations";

const schedulerLog = getMainLogger("pwragent:pr-poller");

/**
 * Background PR-status poller.
 *
 * Before this existed, the ONLY recurring PR refresh was a renderer interval
 * scoped to the selected thread, so every other open project's chips were a
 * snapshot from whenever the operator last moused over them. This walks every
 * tracked, non-terminal PR on an attention-weighted cadence instead.
 *
 * The scheduler is deliberately dependency-injected and holds no reference to
 * AppServerService — that keeps it unit-testable without booting the app, and
 * keeps the module graph acyclic.
 *
 * Budget shape: one GraphQL request covers up to `BATCH_SIZE` PRs across
 * arbitrary repos for ~1 rate-limit point, and we take one token bucket slot
 * per request (not per PR), so a full sweep of a few hundred PRs is a handful
 * of points.
 */

/**
 * `icebox` is not a cadence — it means "stop watching this PR entirely."
 * Everything else polls on the cadence below.
 */
export type PrPollTier = "focused" | "warm" | "cold" | "icebox";

/** The tiers that actually poll. `icebox` is excluded by construction. */
export type PollablePrTier = Exclude<PrPollTier, "icebox">;

export type PrPollTarget = {
  prKey: string;
  pr: PrSummary;
  /** Thread keys (`backend:threadId`) that show this PR. Drives tier + publish. */
  threadKeys: string[];
};

/** Target cadence per pollable tier, when the window is visible. */
export const TIER_CADENCE_MS: Record<PollablePrTier, number> = {
  focused: 60_000,
  warm: 150_000,
  cold: 300_000,
};

/**
 * A PR that has not actually changed in this long gets demoted to the slowest
 * tier. Active PRs (CI running, review churn) keep the budget; a PR that has
 * sat untouched for six hours is unlikely to need minute-level freshness.
 */
export const QUIET_DEMOTION_MS = 6 * 60 * 60_000;

/**
 * The icebox threshold. A PR whose status has not changed AND whose threads
 * have not been touched in this long falls off the monitor list completely —
 * we stop spending any budget on it.
 *
 * This is intentionally self-latching: an iceboxed PR is never polled, so its
 * `lastChangedAt` can never advance on its own, so it stays iceboxed until the
 * operator interacts with one of its threads. That is the point — a branch
 * abandoned two weeks ago should cost nothing, forever, until you look at it.
 * Touching the thread (selecting it, or a turn completing in it) puts it back
 * on the list immediately at the focused/warm tier.
 */
export const ICEBOX_AFTER_MS = 24 * 60 * 60_000;

/** When the window is hidden, stretch every cadence rather than stopping dead. */
const HIDDEN_WINDOW_CADENCE_MULTIPLIER = 4;

const TICK_INTERVAL_MS = 15_000;
const BATCH_SIZE = 40;
/**
 * Cap requests per tick. Bounds concurrency by construction (the batches below
 * this cap run together) and spreads a large backlog across ticks instead of
 * bursting it all at once.
 */
const MAX_BATCHES_PER_TICK = 3;

const TIER_RANK: Record<PollablePrTier, number> = {
  focused: 0,
  warm: 1,
  cold: 2,
};

export type PrPollingSchedulerDeps = {
  /** Every tracked PR, with the threads that reference it. */
  listTargets: () => PrPollTarget[];
  /** Threads the operator is looking at right now (selected + on-screen). */
  getFocusedThreadKeys: () => ReadonlySet<string>;
  isWindowVisible: () => boolean;
  /** Global scheduled-fetch ceiling. One token per REQUEST, not per PR. */
  tryTakeToken: () => boolean;
  fetchPullRequests: (refs: PrRef[]) => Promise<PrSummary[]>;
  /** Persist + publish. Returns the prKeys whose status actually changed. */
  applyResults: (prs: PrSummary[], fetchedAt: number) => Promise<string[]>;
  now?: () => number;
};

type PollState = {
  lastPolledAt: number;
  /** Last time this PR's status actually changed — drives quiet-demotion. */
  lastChangedAt: number;
  /**
   * Last time the operator touched one of this PR's threads (focused it, or a
   * turn completed in it). Together with `lastChangedAt` this decides whether
   * the PR is still worth watching at all.
   */
  lastInteractionAt: number;
};

/** Is the operator looking at a thread that shows this PR right now? */
export function isTargetFocused(
  target: PrPollTarget,
  focusedThreadKeys: ReadonlySet<string>,
): boolean {
  return target.threadKeys.some((threadKey) => focusedThreadKeys.has(threadKey));
}

/**
 * Pick the tier for one target. Exported for tests.
 *
 * Focus wins outright: if the operator is looking at a thread showing this PR,
 * it polls fast no matter how long it had been quiet — which is what makes the
 * icebox safe to be aggressive about.
 */
export function assignTier(params: {
  target: PrPollTarget;
  focusedThreadKeys: ReadonlySet<string>;
  lastChangedAt: number;
  lastInteractionAt: number;
  now: number;
}): PrPollTier {
  if (isTargetFocused(params.target, params.focusedThreadKeys)) {
    return "focused";
  }
  // Either real movement on the PR or the operator touching its thread counts
  // as "still live" — neither alone should be able to freeze an active PR out.
  const lastActivityAt = Math.max(params.lastChangedAt, params.lastInteractionAt);
  const quietForMs = params.now - lastActivityAt;
  if (quietForMs > ICEBOX_AFTER_MS) {
    return "icebox";
  }
  return quietForMs <= QUIET_DEMOTION_MS ? "warm" : "cold";
}

export class PrPollingScheduler {
  private readonly deps: PrPollingSchedulerDeps;
  private readonly now: () => number;
  private readonly pollState = new Map<string, PollState>();
  /**
   * Threads touched since the last pass, from signals the scheduler cannot see
   * itself (a turn completing in a background thread). Drained each tick.
   */
  private readonly pendingInteractionThreadKeys = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(deps: PrPollingSchedulerDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => Date.now());
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, TICK_INTERVAL_MS);
    // Never hold the process open just to poll PR chips.
    this.timer.unref?.();
    schedulerLog.debug("PR polling scheduler started", {
      tickIntervalMs: TICK_INTERVAL_MS,
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.pollState.clear();
    this.pendingInteractionThreadKeys.clear();
  }

  /**
   * Record that the operator (or an agent turn) touched these threads. Thaws
   * any iceboxed PRs on them at the next tick.
   *
   * Focus is already sampled every tick, so this is for interactions the
   * scheduler cannot observe — chiefly a turn completing in a thread that is
   * not on screen.
   */
  noteThreadInteraction(threadKeys: string[]): void {
    for (const threadKey of threadKeys) {
      this.pendingInteractionThreadKeys.add(threadKey);
    }
  }

  /** One scheduling pass. Exposed so tests can drive it without timers. */
  async tick(): Promise<void> {
    // Ticks must not overlap: a slow sweep would otherwise stack requests and
    // re-select the same not-yet-marked targets.
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.runTick();
    } catch (error) {
      schedulerLog.warn("PR poll tick failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<void> {
    const now = this.now();
    const targets = this.deps.listTargets();
    this.prunePollState(targets);

    const due = this.selectDueTargets(targets, now);
    if (due.length === 0) {
      return;
    }

    const batches = chunk(due, BATCH_SIZE).slice(0, MAX_BATCHES_PER_TICK);
    const admitted: PrPollTarget[][] = [];
    for (const batch of batches) {
      // One token per request. If the bucket is dry, leave the rest of the
      // backlog for the next tick rather than dropping it silently.
      if (!this.deps.tryTakeToken()) {
        schedulerLog.debug("PR poll deferred: token bucket empty", {
          deferredBatches: batches.length - admitted.length,
        });
        break;
      }
      admitted.push(batch);
    }

    await Promise.all(admitted.map(async (batch) => await this.pollBatch(batch)));
  }

  private selectDueTargets(targets: PrPollTarget[], now: number): PrPollTarget[] {
    const focusedThreadKeys = this.deps.getFocusedThreadKeys();
    const cadenceMultiplier = this.deps.isWindowVisible()
      ? 1
      : HIDDEN_WINDOW_CADENCE_MULTIPLIER;

    const due: { target: PrPollTarget; tier: PollablePrTier; lastPolledAt: number }[] = [];
    for (const target of targets) {
      // Merged/closed PRs cannot change again. The registry keeps them for
      // display; polling them is pure waste.
      if (isTerminalPullRequest(target.pr)) {
        continue;
      }
      const state = this.ensurePollState(target.prKey, now);

      // Refresh the interaction clock BEFORE assigning a tier, so touching a
      // thread thaws its iceboxed PRs on this very tick. Focus is sampled
      // continuously (not just on change) so a thread sat on for a day does
      // not age into the icebox while the operator is staring at it.
      if (
        isTargetFocused(target, focusedThreadKeys)
        || target.threadKeys.some((threadKey) =>
          this.pendingInteractionThreadKeys.has(threadKey),
        )
      ) {
        state.lastInteractionAt = now;
      }

      const tier = assignTier({
        target,
        focusedThreadKeys,
        lastChangedAt: state.lastChangedAt,
        lastInteractionAt: state.lastInteractionAt,
        now,
      });
      if (tier === "icebox") {
        // Off the monitor list entirely — no cadence, no budget, no request.
        continue;
      }
      const cadence = TIER_CADENCE_MS[tier] * cadenceMultiplier;
      if (now - state.lastPolledAt < cadence) {
        continue;
      }
      due.push({ target, tier, lastPolledAt: state.lastPolledAt });
    }
    // Drained once per pass: every target has now had a chance to see them.
    this.pendingInteractionThreadKeys.clear();

    // Focused first, then least-recently-polled. The second key is what makes
    // the sweep round-robin instead of starving the tail of a long list.
    due.sort((a, b) =>
      TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.lastPolledAt - b.lastPolledAt,
    );
    return due.map((entry) => entry.target);
  }

  private async pollBatch(batch: PrPollTarget[]): Promise<void> {
    const refs: PrRef[] = [];
    for (const target of batch) {
      const ref = parsePrRefFromUrl(target.pr.url);
      if (!ref) {
        schedulerLog.debug("skipping PR with unparseable url", {
          prKey: target.prKey,
        });
        continue;
      }
      refs.push(ref);
    }

    // Mark polled BEFORE the request. If a PR consistently errors, it must not
    // stay permanently "due" and crowd out healthy targets on every tick.
    const attemptedAt = this.now();
    for (const target of batch) {
      const state = this.ensurePollState(target.prKey, attemptedAt);
      state.lastPolledAt = attemptedAt;
    }

    if (refs.length === 0) {
      return;
    }

    const prs = await this.deps.fetchPullRequests(refs);
    if (prs.length === 0) {
      return;
    }

    const fetchedAt = this.now();
    const changedKeys = await this.deps.applyResults(prs, fetchedAt);
    for (const prKey of changedKeys) {
      const state = this.pollState.get(prKey);
      if (state) {
        state.lastChangedAt = fetchedAt;
      }
    }

    if (changedKeys.length > 0) {
      schedulerLog.debug("PR poll applied changes", {
        polled: refs.length,
        changed: changedKeys.length,
      });
    }
  }

  private ensurePollState(prKey: string, now: number): PollState {
    const existing = this.pollState.get(prKey);
    if (existing) {
      return existing;
    }
    // A newly tracked PR is "due immediately" but counts as recently active,
    // so it starts warm rather than being demoted to cold — or iceboxed — on
    // first sight.
    const created: PollState = {
      lastPolledAt: 0,
      lastChangedAt: now,
      lastInteractionAt: now,
    };
    this.pollState.set(prKey, created);
    return created;
  }

  private prunePollState(targets: PrPollTarget[]): void {
    if (this.pollState.size === 0) {
      return;
    }
    const live = new Set(targets.map((target) => target.prKey));
    for (const prKey of this.pollState.keys()) {
      if (!live.has(prKey)) {
        this.pollState.delete(prKey);
      }
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}
