// Pre-launch seeder for the PR watch surfaces the a11y gate audits: a
// thread's attached PRs, its Auto-fix opt-in, two active watches and two
// ended ones.
//
// None of it is replay-fixture data. PRs come from the forge, watches from
// `watch_thread_pull_request` or Watch CI, and both persist through the
// overlay store. So the state is written through that store's own writers,
// the way the Directories block seeds its pins: the key format, the payload
// shape and the watch table's columns keep one owner.
//
// Pre-launch, so the first render reads it: the renderer lists watches once
// at mount and then only on `thread/prWatches/updated`, which a direct write
// never sends. `StateDb.open` creates the profile directory and the schema.
//
// Every name, number and SHA here is invented. The repository is never
// fetched: the thread links no directory, so no branch lookup runs, and the
// block launches without forge credentials, so the status poller's `gh` call
// fails without changing anything.
import {
  buildPullRequestStatusKey,
  type PrSummary,
  type ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { SqliteOverlayStore } from "../../src/main/state/overlay-store-sqlite";
import { StateDb } from "../../src/main/state/state-db";
import { stateDbPathForHomeRoot } from "./readme-state-seeding";

/** The thread `fixtures/a11y-pr-watches/replay.fixture.json` lists. */
export const PR_WATCH_AUDIT_THREAD_ID = "thread-a11y-pr-watches";

const ORG = "pwragent-fixtures";
const REPO = "watch-audit";

/**
 * The PR with every kind of watch. Its title is long on purpose: the card's
 * watch rows must wrap beside it, not clip.
 */
export const PR_WATCH_AUDIT_WATCHED_PR: PrSummary = {
  provider: "github.com",
  number: 4182,
  org: ORG,
  repo: REPO,
  title: "Keep the deploy preview banner visible while the staging rollout drains old traffic",
  url: `https://github.com/${ORG}/${REPO}/pull/4182`,
  headRefName: "fix/preview-banner-drain",
  baseRefName: "main",
  headSha: "4c1e9a7b2d5f8e0a3c6b9d2e5f8a1b4c7d0e3f6a",
  // Pending, not failing: an opted-in thread with a failing PR is one poll
  // away from an Auto-fix turn, and the replay backend has no turn to give.
  state: "pending",
  checkState: "pending",
  lifecycleState: "open",
  reviewState: "ready_for_review",
  mergeState: "mergeable",
  additions: 148,
  deletions: 37,
  changedFiles: 9,
  commitCount: 4,
};

/** The PR with no CI watch, so its card offers Watch CI. */
export const PR_WATCH_AUDIT_UNWATCHED_PR: PrSummary = {
  provider: "github.com",
  number: 4177,
  org: ORG,
  repo: REPO,
  title: "Move the nightly fixture refresh onto the shared runner pool and retire the old cron",
  url: `https://github.com/${ORG}/${REPO}/pull/4177`,
  headRefName: "chore/nightly-runner-pool",
  baseRefName: "main",
  headSha: "9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b",
  state: "passing",
  checkState: "passing",
  lifecycleState: "open",
  reviewState: "ready_for_review",
  mergeState: "mergeable",
  additions: 22,
  deletions: 61,
  changedFiles: 3,
  commitCount: 2,
};

const HOUR_MS = 60 * 60 * 1000;

function watchOn(
  pr: PrSummary,
  watch: Pick<ThreadPullRequestWatchSummary, "watchId" | "headSha" | "notifyOn" | "createdAt">
    & Partial<ThreadPullRequestWatchSummary>,
): ThreadPullRequestWatchSummary {
  return {
    backend: "codex",
    threadId: PR_WATCH_AUDIT_THREAD_ID,
    prKey: buildPullRequestStatusKey(pr),
    prUrl: pr.url,
    prNumber: pr.number,
    ...(pr.title ? { prTitle: pr.title } : {}),
    failureHandledByAutoFix: false,
    kind: "checks",
    ...watch,
  };
}

/**
 * The watches the block expects, relative to `now` so history stays inside
 * the 30-day retention window. Active first, then the two that end.
 */
export function buildAuditPrWatches(now: number): {
  active: ThreadPullRequestWatchSummary[];
  ended: Array<{
    watch: ThreadPullRequestWatchSummary;
    endedAt: number;
    endedReason: "cancelled_by_operator" | "cancelled_by_agent";
  }>;
} {
  const pr = PR_WATCH_AUDIT_WATCHED_PR;
  const headSha = pr.headSha!;
  return {
    active: [
      // An agent re-ran the failed job and waits for attempt 2. The first
      // attempt's failure is the baseline that must not wake it.
      watchOn(pr, {
        watchId: "watch-audit-ci",
        headSha,
        notifyOn: ["success", "failure"],
        createdAt: now - HOUR_MS,
        createdBy: "agent",
        runAttempt: 2,
        runId: 7_310_442,
        baseline: {
          outcome: "failure",
          observedAt: now - HOUR_MS - 60_000,
          rerunRequestedAt: now - HOUR_MS,
          runAttempt: 1,
        },
      }),
      watchOn(pr, {
        watchId: "watch-audit-merge",
        headSha,
        notifyOn: ["merged", "closed"],
        createdAt: now - 2 * HOUR_MS,
        createdBy: "operator",
        kind: "terminal",
      }),
    ],
    ended: [
      {
        watch: watchOn(pr, {
          watchId: "watch-audit-ended-operator",
          headSha: "1f2e3d4c5b6a7980a1b2c3d4e5f60718293a4b5c",
          notifyOn: ["success", "failure"],
          createdAt: now - 5 * HOUR_MS,
          createdBy: "operator",
        }),
        endedAt: now - 4 * HOUR_MS,
        endedReason: "cancelled_by_operator",
      },
      {
        watch: watchOn(pr, {
          watchId: "watch-audit-ended-agent",
          headSha: "6a5b4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b",
          notifyOn: ["failure"],
          createdAt: now - 7 * HOUR_MS,
        }),
        endedAt: now - 6 * HOUR_MS,
        endedReason: "cancelled_by_agent",
      },
    ],
  };
}

/**
 * Writes the audit thread's PRs, Auto-fix opt-in and watches into
 * `<homeRoot>`'s default profile.
 */
export async function seedPrWatchAuditState(
  homeRoot: string,
  now = Date.now(),
): Promise<void> {
  const stateDb = StateDb.open(stateDbPathForHomeRoot(homeRoot), {
    profileName: "default",
  });
  try {
    const overlay = new SqliteOverlayStore(stateDb);
    const thread = { backend: "codex" as const, threadId: PR_WATCH_AUDIT_THREAD_ID };
    await overlay.setThreadPullRequests({
      ...thread,
      prs: [PR_WATCH_AUDIT_WATCHED_PR, PR_WATCH_AUDIT_UNWATCHED_PR],
      fetchedAt: now,
    });
    await overlay.setThreadPrAutoDispatchEnabled({ ...thread, enabled: true });
    const watches = buildAuditPrWatches(now);
    // The ended watches go first: each must be the only active one on its
    // head while it is registered, then cancel the way Stop does.
    for (const ended of watches.ended) {
      await overlay.registerThreadPrStatusWatch({
        watch: ended.watch,
        now: ended.watch.createdAt,
      });
      const cancelled = await overlay.cancelThreadPrStatusWatch({
        ...thread,
        watchId: ended.watch.watchId,
        now: ended.endedAt,
        endedReason: ended.endedReason,
      });
      if (!cancelled) {
        throw new Error(`PR watch seed could not end ${ended.watch.watchId}.`);
      }
    }
    for (const watch of watches.active) {
      const registered = await overlay.registerThreadPrStatusWatch({
        watch,
        now: watch.createdAt,
      });
      if (registered.existed) {
        throw new Error(`PR watch seed found ${watch.watchId} already armed.`);
      }
    }
  } finally {
    stateDb.close();
  }
}
