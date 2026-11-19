import type { PrSummary, RefreshThreadPullRequestsRequest } from "@pwragent/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ThreadPullRequestLookup } from "../app-server/thread-pull-request-lookup";
import { ForgePrFetcher } from "../pr-status/forge-pr-fetcher";
import { detectPullRequestsForThread } from "../pr-status/pr-detection";
import { PullRequestRepositoryAliases } from "../pr-status/pr-repository-aliases";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";

vi.mock("../pr-status/pr-detection", () => ({ detectPullRequestsForThread: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

function pullRequest(number: number, lifecycleState: "open" | "merged"): PrSummary {
  return {
    provider: "github.com", org: "fixture", repo: "example", number,
    title: `Fixture pull request ${number}`, url: `https://github.com/fixture/example/pull/${number}`,
    state: "passing", checkState: "passing", lifecycleState, reviewState: "ready_for_review",
    mergeState: "unknown", headSha: "a".repeat(40),
  };
}

it("coalesces a shared branch lookup and preserves each subscriber's prior attachments", async () => {
  const db = openInMemoryStateDb();
  const overlay = new SqliteOverlayStore(db);
  const fetcher = new ForgePrFetcher();
  vi.spyOn(fetcher, "getProviderAvailability").mockResolvedValue([
    { provider: "github.com", cli: "gh", available: true },
  ]);
  const publish = vi.fn(async () => {});
  const owner = new ThreadPullRequestLookup({
    getOverlayStore: () => overlay,
    loadPrStatusRegistry: async () => {},
    filterStoredDiscoveredPrs: async (prs) => prs,
    mergePrHistory: (prior, discovered) => [...new Map([...prior, ...discovered].map((pr) => [pr.number, pr])).values()],
    rememberPrStatuses: () => [],
    canonicalizePrs: (prs) => prs,
    detachedPrKeyCanonicalizer: () => ({}),
    publishThreadPullRequestsUpdated: publish,
    getPrFetcher: () => fetcher,
    storedPrsNeedRename: () => false,
    threadForgeAutomation: () => undefined,
    nextPrObservationTimestamp: () => Date.now(),
    writePrStatusesToCache: async () => {},
    publishPullRequestStatusUpdates: async () => {},
    learnPullRequestRepository: () => {},
    recordPrCheck: () => {},
    handlePrAutoDispatchSnapshots: async () => {},
    takePrPollingToken: () => true,
    prRepositoryAliases: new PullRequestRepositoryAliases(),
    prActivity: { record: () => {} },
    logDebug: () => {},
    isFederationMethodNotFoundError: () => false,
  });
  const first = {
    backend: "codex", threadId: "first", branch: "example",
    directoryPaths: ["/fixture/example"], trigger: "user",
  } satisfies RefreshThreadPullRequestsRequest;
  const second = { ...first, threadId: "second" };
  const oldPr = pullRequest(7, "merged");
  const sharedPr = pullRequest(42, "open");
  const lookup = Promise.withResolvers<PrSummary[]>();
  const detect = vi.mocked(detectPullRequestsForThread);
  detect.mockReturnValue(lookup.promise);
  let pending: Promise<void> | undefined;
  try {
    await overlay.setThreadPullRequests({ ...first, prs: [oldPr], fetchedAt: 1 });
    expect((await owner.refreshThreadPullRequests(first)).prs.map((pr) => pr.number)).toEqual([7]);
    pending = owner.pendingRefresh(first);
    expect(pending).toBeInstanceOf(Promise);
    expect((await owner.refreshThreadPullRequests(second)).prs).toEqual([]);
    expect(owner.pendingRefresh(second)).toBe(pending);
    expect(detect).toHaveBeenCalledTimes(1);
    lookup.resolve([sharedPr]);
    await pending;
    expect((await overlay.getThreadOverlayState(first))?.prs?.map((pr) => pr.number)).toEqual([7, 42]);
    expect((await overlay.getThreadOverlayState(second))?.prs?.map((pr) => pr.number)).toEqual([42]);
    expect(publish).toHaveBeenCalledTimes(2);
  } finally {
    lookup.resolve([]);
    await (pending ?? owner.pendingRefresh(first));
    db.close();
  }
});
