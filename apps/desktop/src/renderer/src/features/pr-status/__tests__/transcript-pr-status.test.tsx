import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type NavigationThreadSummary, type PrSummary, type TranscriptPullRequestStatuses } from "@pwragent/shared";
import { TranscriptPrStatusStore } from "../../../lib/transcript-pr-status";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PullRequestLinkChip } from "../PullRequestLinkChip";
import { PullRequestLinkProvider } from "../../../lib/pull-request-links";

const url = "https://github.com/example/project/pull/42";
const pr: PrSummary = { provider: "github.com", org: "example", repo: "project", number: 42, url, state: "unknown" };
const key = buildPullRequestStatusKey(pr);

function apiHarness() {
  let publish!: (statuses: TranscriptPullRequestStatuses) => void;
  const unsubscribe = vi.fn();
  const set = vi.fn().mockResolvedValue({ statuses: [] });
  const api = {
    setTranscriptPullRequests: set,
    onTranscriptPullRequestStatuses: (callback: typeof publish) => {
      publish = callback;
      return unsubscribe;
    },
  } as unknown as DesktopApi;
  return { api, set, unsubscribe, publish: (statuses: TranscriptPullRequestStatuses) => publish(statuses) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("transcript PR renderer store", () => {
  it("coalesces duplicate chips and releases the last subscription", async () => {
    const h = apiHarness();
    const store = new TranscriptPrStatusStore(h.api);
    const first = vi.fn();
    const second = vi.fn();
    const releaseFirst = store.subscribe(pr, false, first);
    const releaseSecond = store.subscribe(pr, true, second);
    await vi.advanceTimersByTimeAsync(50);
    expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url, visible: true }] });
    h.publish({ statuses: [{ pr: { ...pr, state: "merged" }, fetchedAt: 100 }] });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    releaseSecond();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url, visible: false }] });
    releaseFirst();
    await vi.advanceTimersByTimeAsync(50);
    expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [url], updates: [] });
    expect(h.unsubscribe).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot(key)).toBeUndefined();
  });

  it("rejects a late IPC snapshot after a newer status event", async () => {
    const h = apiHarness();
    let resolve!: (statuses: TranscriptPullRequestStatuses) => void;
    h.set.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const store = new TranscriptPrStatusStore(h.api);
    const release = store.subscribe(pr, true, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    h.publish({ statuses: [{ pr: { ...pr, state: "merged" }, fetchedAt: 200 }] });
    resolve({ statuses: [{ pr: { ...pr, state: "pending" }, fetchedAt: 100 }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getSnapshot(key)?.state).toBe("merged");
    release();
  });

  it("keeps the last status when the IPC request fails", async () => {
    const h = apiHarness();
    const store = new TranscriptPrStatusStore(h.api);
    const release = store.subscribe(pr, true, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    h.publish({ statuses: [{ pr: { ...pr, state: "passing" }, fetchedAt: 100 }] });
    h.set.mockRejectedValueOnce(new Error("offline"));
    release();
    const releaseOther = store.subscribe(pr, false, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(store.getSnapshot(key)?.state).toBe("passing");
    releaseOther();
  });

  it("sends one changed identity among 1,000 chips without republishing the rest", async () => {
    const h = apiHarness();
    const store = new TranscriptPrStatusStore(h.api);
    const releases = Array.from({ length: 1_000 }, (_, index) => store.subscribe({
      ...pr, number: index + 1, url: `https://github.com/example/project/pull/${index + 1}`,
    }, false, vi.fn()));
    await vi.advanceTimersByTimeAsync(50);
    expect(h.set.mock.calls[0]?.[0].updates).toHaveLength(1_000);
    const releaseVisible = store.subscribe(pr, true, vi.fn());
    await vi.advanceTimersByTimeAsync(50);
    expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url, visible: true }] });
    releaseVisible();
    for (const release of releases) release();
  });
});

describe.each(["main", "federation"])("%s window peer PR status authority", (windowKind) => {
  function peerTranscript(prs: PrSummary[]) {
    const thread = {
      id: "peer-thread", title: "Peer transcript", titleSource: "derived", source: "codex", prs,
      linkedDirectories: [], inbox: { inInbox: true, unread: false },
      federation: { ref: { target: { scope: "remote", instanceId: "peer" }, backend: "codex", threadId: "peer-thread" }, instanceLabel: "Peer" },
    } as NavigationThreadSummary;
    return <PullRequestLinkProvider activeThread={thread} threads={[thread]}>
      <PullRequestLinkChip pr={{ ...pr, url: `${url}/files#diff-123` }} />
    </PullRequestLinkProvider>;
  }

  function viewerHarness() {
    const h = apiHarness();
    vi.stubGlobal("pwragent", h.api);
    if (windowKind === "federation") vi.stubGlobal("__pwragentFederationTarget", { scope: "remote", instanceId: "peer" });
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    return h;
  }

  it("lets later peer observations replace a cached local read even inside the local cooldown", async () => {
    const h = viewerHarness();
    h.set.mockResolvedValue({ statuses: [{ pr: { ...pr, state: "passing" }, fetchedAt: Date.now() }] });
    const view = render(peerTranscript([]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    const chip = screen.getByRole("button");
    expect(chip).toHaveAccessibleName(/checks passing/);

    view.rerender(peerTranscript([{ ...pr, state: "failing" }]));
    expect(chip).toHaveAccessibleName(/checks failing/);
    // A late local event must not take authority back from the peer.
    act(() => h.publish({ statuses: [{ pr: { ...pr, state: "passing" }, fetchedAt: Date.now() + 1 }] }));
    expect(chip).toHaveAccessibleName(/checks failing/);
    view.rerender(peerTranscript([{ ...pr, state: "merged", lifecycleState: "merged" }]));
    expect(chip).toHaveAccessibleName(/merged/);
    expect(chip).toHaveAttribute("data-pr-url", `${url}/files#diff-123`);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [`${url}/files#diff-123`] });
    expect(h.set).toHaveBeenCalledTimes(2);
  });

  it.each(["unknown", "passing"] as const)("uses an existing %s peer snapshot without subscribing locally", async (state) => {
    const h = viewerHarness();
    const view = render(peerTranscript([{ ...pr, state }]));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(h.set).not.toHaveBeenCalled();
    view.rerender(peerTranscript([{ ...pr, state: "merged", lifecycleState: "merged" }]));
    expect(screen.getByRole("button")).toHaveAccessibleName(/merged/);
    expect(h.set).not.toHaveBeenCalled();
  });
});

it("fetches only after visibility, updates the chip, preserves deep links, and slows when hidden", async () => {
  const h = apiHarness();
  vi.stubGlobal("pwragent", h.api);
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  let callback!: IntersectionObserverCallback;
  let instance!: IntersectionObserver;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("IntersectionObserver", class {
    observe = observe;
    unobserve = vi.fn();
    disconnect = disconnect;
    constructor(cb: IntersectionObserverCallback) {
      callback = cb;
      instance = this as unknown as IntersectionObserver;
    }
  });
  const deepUrl = `${url}/files#diff-123`;
  const view = render(<PullRequestLinkChip pr={{ ...pr, url: deepUrl }} />);
  const chip = screen.getByRole("button");
  expect(observe).toHaveBeenCalledWith(chip);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(h.set).not.toHaveBeenCalled();
  act(() => callback([{ target: chip, isIntersecting: true } as unknown as IntersectionObserverEntry], instance));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url: deepUrl, visible: true }] });
  act(() => h.publish({ statuses: [{ pr: { ...pr, state: "merged", lifecycleState: "merged" }, fetchedAt: 100 }] }));
  expect(chip).toHaveAccessibleName(/merged/);
  expect(chip).toHaveAttribute("data-pr-url", deepUrl);
  act(() => callback([{ target: chip, isIntersecting: false } as unknown as IntersectionObserverEntry], instance));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url: deepUrl, visible: false }] });
  act(() => callback([{ target: chip, isIntersecting: true } as unknown as IntersectionObserverEntry], instance));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  hidden.mockReturnValue(true);
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [], updates: [{ url: deepUrl, visible: false }] });
  // Reusing this component for a different offscreen link must not inherit
  // the old link's "seen" status and start fetching hidden transcript history.
  view.rerender(<PullRequestLinkChip pr={{ ...pr, number: 43, url: url.replace("42", "43") }} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [deepUrl], updates: [] });
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(50); });
  expect(h.set).toHaveBeenLastCalledWith({ removedUrls: [deepUrl], updates: [] });
  expect(disconnect).toHaveBeenCalledTimes(2);
});

describe("PR ownership across local and pinned remote threads", () => {
  function thread(id: string, prs: PrSummary[], primaryGitRepository?: string, peer = false): NavigationThreadSummary {
    return {
      id, title: id, titleSource: "derived", source: "codex", prs, primaryGitRepository,
      linkedDirectories: [], inbox: { inInbox: true },
      ...(peer ? { federation: { ref: { target: { scope: "remote" as const, instanceId: "peer" }, backend: "codex" as const, threadId: id }, instanceLabel: "Peer" } } : {}),
    };
  }
  function transcript(threads: NavigationThreadSummary[]) {
    return <PullRequestLinkProvider activeThread={threads[0]} threads={threads}>
      <PullRequestLinkChip pr={pr} />
    </PullRequestLinkProvider>;
  }
  function harness() {
    const h = apiHarness();
    vi.stubGlobal("pwragent", h.api);
    vi.stubGlobal("IntersectionObserver", undefined);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    return h;
  }

  it.each([undefined, "github.com/example/other-project"])("a local attachment with primary %s cannot mask a peer", async (primary) => {
    const h = harness();
    h.set.mockResolvedValue({ statuses: [{ pr: { ...pr, state: "passing" }, fetchedAt: 100 }] });
    const local = thread("local", [{ ...pr, state: "passing" }], primary);
    const view = render(transcript([local]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(screen.getByRole("button")).toHaveAccessibleName(/checks passing/);
    view.rerender(transcript([local, thread("peer", [{ ...pr, state: "merged", lifecycleState: "merged" }], undefined, true)]));
    expect(screen.getByRole("button")).toHaveAccessibleName(/merged/);
    act(() => h.publish({ statuses: [{ pr: { ...pr, state: "passing" }, fetchedAt: 200 }] }));
    expect(screen.getByRole("button")).toHaveAccessibleName(/merged/);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [url] });
  });

  it.each([false, true])("local primary fork contributions keep authority regardless of peer ordering (%s)", async (peerFirst) => {
    const h = harness();
    const local = thread("local", [{ ...pr, state: "passing", sourceRepository: { provider: "github.com", org: "contributor", repo: "project" } }], "github.com/contributor/project");
    const peer = thread("peer", [{ ...pr, state: "merged", lifecycleState: "merged" }], undefined, true);
    render(transcript(peerFirst ? [peer, local] : [local, peer]));
    expect(screen.getByRole("button")).toHaveAccessibleName(/checks passing/);
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.set).toHaveBeenCalledWith({ updates: [{ url, visible: true }], removedUrls: [] });
    act(() => h.publish({ statuses: [{ pr: { ...pr, state: "failing" }, fetchedAt: 100 }] }));
    expect(screen.getByRole("button")).toHaveAccessibleName(/checks failing/);
  });

  it("releases local interest on an ownership-only transition and resumes when peer ownership disappears", async () => {
    const h = harness();
    const observation = { ...pr, state: "passing" as const };
    const local = thread("local", [observation]);
    const peer = thread("peer", [observation], undefined, true);
    const view = render(transcript([local]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    view.rerender(transcript([local, peer]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.set).toHaveBeenLastCalledWith({ updates: [], removedUrls: [url] });
    view.rerender(transcript([local]));
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(h.set).toHaveBeenLastCalledWith({ updates: [{ url, visible: true }], removedUrls: [] });
  });
});
