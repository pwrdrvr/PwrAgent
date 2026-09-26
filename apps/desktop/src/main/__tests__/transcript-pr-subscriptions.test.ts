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
});

describe("transcript PR subscriptions", () => {
  it("returns only changed targets and releases only the last owner's polling clock", () => {
    const inactive = vi.fn();
    const store = new TranscriptPrSubscriptions(inactive);
    store.set(1, { removedUrls: [], updates: Array.from({ length: 1_000 }, (_, index) => ({
      url: `https://github.com/example/project/pull/${index + 1}`, visible: false,
    })) }, vi.fn());
    expect(store.takePendingTargets()).toHaveLength(1_000);
    store.set(2, { removedUrls: [], updates: [{ url, visible: true }] }, vi.fn());
    expect(store.takePendingTargets()).toMatchObject([{ pr: { number: 42 }, subscriptionTier: "focused" }]);
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

  it("accepts GitLab namespaces and rejects invalid or unsupported references", () => {
    expect(parseTranscriptPullRequest("https://gitlab.example.com/group/sub/repo/-/merge_requests/9/diffs#note"))
      .toMatchObject({ provider: "gitlab.example.com", org: "group/sub", repo: "repo", number: 9 });
    for (const invalid of ["http://github.com/a/b/pull/1", "https://example.com/a/b/pull/1", "https://user:secret@github.com/a/b/pull/1", "https://github.com/a/b/pull/0", "https://github.com/a/b/pull/9007199254740993"]) {
      expect(parseTranscriptPullRequest(invalid)).toBeUndefined();
    }
  });
});
