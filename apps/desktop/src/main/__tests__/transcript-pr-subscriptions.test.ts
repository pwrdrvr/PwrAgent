import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type PrSummary } from "@pwragent/shared";
import { TranscriptPrSubscriptions, parseTranscriptPullRequest } from "../pr-status/transcript-pr-subscriptions";
import { PrPollingScheduler, TIER_CADENCE_MS } from "../pr-status/pr-polling-scheduler";

const url = "https://github.com/example/project/pull/42";
const pr: PrSummary = { provider: "github.com", org: "example", repo: "project", number: 42, url, state: "passing" };
let subscriptions: TranscriptPrSubscriptions;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  subscriptions = new TranscriptPrSubscriptions();
});
afterEach(() => {
  subscriptions.clear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("transcript PR subscriptions", () => {
  function onDemandHarness(count: number, tryTakeToken = () => true) {
    subscriptions.set(1, { removedUrls: [], updates: Array.from({ length: count }, (_, index) => ({
      url: `https://gitlab.com/example/project/-/merge_requests/${index + 1}`, visible: true,
    })) }, vi.fn());
    const fetch = vi.fn().mockResolvedValue([]);
    const listTargets = vi.fn(() => subscriptions.targets());
    const scheduler = new PrPollingScheduler({
      listTargets,
      getFocusedThreadKeys: () => new Set(),
      isWindowVisible: () => true,
      tryTakeToken,
      fetchPullRequests: fetch,
      applyResults: async () => [],
      onTargetsHandled: (keys) => subscriptions.markHandled(keys),
    });
    // Deliberately never call scheduler.start(): background polling is off.
    const pendingTargets = () => subscriptions.pendingTargets();
    subscriptions.requestRefresh(() => scheduler.tick(pendingTargets));
    return { fetch, listTargets, scheduler };
  }

  it("drains four GitLab initial reads across the three-batch cap without background polling", async () => {
    const { fetch, listTargets } = onDemandHarness(4);
    await vi.advanceTimersByTimeAsync(50);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(subscriptions.pendingTargets()).toMatchObject([{ pr: { number: 4 } }]);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[3]?.[0]).toMatchObject([{ number: 4 }]);
    expect(subscriptions.pendingTargets()).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(listTargets).not.toHaveBeenCalled();
  });

  it("retains initial reads while the shared budget is empty, then retries at a bounded cadence", async () => {
    let available = false;
    const budget = vi.fn(() => available);
    const { fetch, listTargets } = onDemandHarness(1, budget);
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).not.toHaveBeenCalled();
    expect(budget).toHaveBeenCalledTimes(2);
    expect(subscriptions.pendingTargets()).toHaveLength(1);
    available = true;
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listTargets).not.toHaveBeenCalled();
  });

  it("cancels deferred admission when the last window closes", async () => {
    const budget = vi.fn(() => false);
    const { fetch } = onDemandHarness(4, budget);
    await vi.advanceTimersByTimeAsync(50);
    subscriptions.clearSender(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(budget).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(subscriptions.pendingTargets()).toEqual([]);
  });

  it("finishes pending work already satisfied by a fresh or merged observation", async () => {
    const { fetch } = onDemandHarness(2);
    const targets = subscriptions.targets();
    subscriptions.observe(targets.map((target, index) => ({
      ...target.pr, state: index === 0 ? "passing" : "merged",
    })), Date.now());
    await vi.advanceTimersByTimeAsync(50);
    expect(subscriptions.pendingTargets()).toEqual([]);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns only changed targets and releases only the last owner's polling clock", () => {
    const inactive = vi.fn();
    const store = new TranscriptPrSubscriptions(inactive);
    store.set(1, { removedUrls: [], updates: Array.from({ length: 1_000 }, (_, index) => ({
      url: `https://github.com/example/project/pull/${index + 1}`, visible: false,
    })) }, vi.fn());
    expect(store.pendingTargets()).toHaveLength(1_000);
    store.markHandled(store.pendingTargets().map((target) => target.prKey));
    store.set(2, { removedUrls: [], updates: [{ url, visible: true }] }, vi.fn());
    expect(store.pendingTargets()).toMatchObject([{ pr: { number: 42 }, subscriptionTier: "focused" }]);
    store.clearSender(2);
    expect(inactive).not.toHaveBeenCalled();
    store.set(1, { removedUrls: [url], updates: [] }, vi.fn());
    expect(inactive).toHaveBeenCalledExactlyOnceWith(buildPullRequestStatusKey(pr));
    store.clear();
  });

  it("deduplicates deep links across windows and drops polling on the last release", () => {
    subscriptions.set(1, { removedUrls: [], updates: [{ url: `${url}/files#diff`, visible: true }] }, vi.fn());
    subscriptions.set(2, { removedUrls: [], updates: [{ url, visible: false }] }, vi.fn());
    expect(subscriptions.targets()).toMatchObject([{ subscriptionTier: "focused", threadKeys: [], pr: { url } }]);
    subscriptions.clearSender(1);
    expect(subscriptions.targets()).toMatchObject([{ subscriptionTier: "cold" }]);
    subscriptions.clearSender(2);
    expect(subscriptions.targets()).toEqual([]);
  });

  it("keeps cache entries through a short remount, then evicts after the last subscriber", () => {
    const request = { removedUrls: [], updates: [{ url, visible: true }] };
    subscriptions.set(1, request, vi.fn());
    subscriptions.observe([pr], Date.now());
    subscriptions.clearSender(1);
    vi.advanceTimersByTime(60_000);
    expect(subscriptions.set(2, request, vi.fn()).statuses).toEqual([{ pr, fetchedAt: 1_000_000 }]);
    // The cancelled eviction must not delete a newly active entry.
    vi.advanceTimersByTime(180_000);
    expect(subscriptions.targets()).toHaveLength(1);
    subscriptions.clearSender(2);
    vi.advanceTimersByTime(120_000);
    expect(subscriptions.set(3, request, vi.fn()).statuses).toEqual([]);
  });

  it("publishes only to interested windows and ignores older observations", () => {
    const publish = vi.fn();
    const other = vi.fn();
    subscriptions.set(1, { removedUrls: [], updates: [{ url, visible: true }] }, publish);
    subscriptions.set(2, { removedUrls: [], updates: [{ url: url.replace("42", "43"), visible: true }] }, other);
    subscriptions.observe([pr], 200);
    subscriptions.observe([{ ...pr, state: "failing" }], 100);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    expect(subscriptions.targets()[0]?.pr.state).toBe("passing");
  });

  it("uses existing focused/cold buckets and retains status after a failed fetch", async () => {
    const publish = vi.fn();
    const request = { removedUrls: [], updates: [{ url, visible: true }] };
    subscriptions.set(1, request, publish);
    const fetch = vi.fn().mockResolvedValue([pr]);
    const scheduler = new PrPollingScheduler({
      listTargets: () => subscriptions.targets(),
      getFocusedThreadKeys: () => new Set(),
      isWindowVisible: () => true,
      tryTakeToken: () => true,
      fetchPullRequests: fetch,
      applyResults: async (prs, at) => {
        subscriptions.observe(prs, at);
        return prs.map(buildPullRequestStatusKey);
      },
    });
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(TIER_CADENCE_MS.focused - 1);
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    subscriptions.set(1, { removedUrls: [], updates: [{ url, visible: false }] }, publish);
    vi.advanceTimersByTime(TIER_CADENCE_MS.cold - 1);
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    fetch.mockRejectedValueOnce(new Error("offline"));
    vi.advanceTimersByTime(1);
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(subscriptions.targets()[0]?.pr.state).toBe("passing");
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(3);
    subscriptions.clearSender(1);
    vi.advanceTimersByTime(TIER_CADENCE_MS.cold);
    await scheduler.tick();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([
    "https://attacker.example/group/repo/-/merge_requests/1",
    "https://gitlab.com.attacker.example/group/repo/-/merge_requests/1",
    "https://gitlab.com:8443/group/repo/-/merge_requests/1",
    "https://github.com:8443/group/repo/pull/1",
    "https://gitlab.example.com/group/repo/-/merge_requests/1",
  ])("never admits an untrusted automatic fetch with inherited credentials: %s", async (untrustedUrl) => {
    vi.stubEnv("GITLAB_TOKEN", "fixture-token-do-not-send");
    subscriptions.set(1, { removedUrls: [], updates: [{ url: untrustedUrl, visible: true }] }, vi.fn());
    const fetch = vi.fn().mockResolvedValue([]);
    const scheduler = new PrPollingScheduler({
      listTargets: () => subscriptions.targets(), getFocusedThreadKeys: () => new Set(),
      isWindowVisible: () => true, tryTakeToken: () => true,
      fetchPullRequests: fetch, applyResults: async () => [],
    });
    await scheduler.tick();
    expect(fetch).not.toHaveBeenCalled();
    expect(subscriptions.hasSubscribers).toBe(false);
    expect(subscriptions.pendingTargets()).toEqual([]);
  });

  it("accepts GitLab namespaces and rejects invalid or unsupported references", () => {
    expect(parseTranscriptPullRequest("https://gitlab.com/group/sub/repo/-/merge_requests/9/diffs#note"))
      .toMatchObject({ provider: "gitlab.com", org: "group/sub", repo: "repo", number: 9 });
    for (const invalid of ["http://github.com/a/b/pull/1", "https://example.com/a/b/pull/1", "https://user:secret@github.com/a/b/pull/1", "https://github.com/a/b/pull/0", "https://github.com/a/b/pull/9007199254740993"]) {
      expect(parseTranscriptPullRequest(invalid)).toBeUndefined();
    }
  });
});
