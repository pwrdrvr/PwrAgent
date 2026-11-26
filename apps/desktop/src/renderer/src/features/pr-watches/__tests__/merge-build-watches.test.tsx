import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared/contracts/navigation";
import type {
  ThreadDependency,
  ThreadDependencyMergeBuildObservation,
} from "@pwragent/shared/contracts/thread-dependencies";
import { THREAD_DEPENDENCY_MERGE_BUILD_WAITING_REASON } from "@pwragent/shared/contracts/thread-dependencies";
import { PrStatusCard } from "../../pr-status/PrStatusCard";
import { PullRequestLinkChip } from "../../pr-status/PullRequestLinkChip";
import { TranscriptPrContextProvider } from "../../pr-status/transcript-pr-context";
import {
  summarizeThreadDependencies,
  ThreadDependencyIndicatorsContext,
} from "../../thread-dependencies/useThreadDependencyIndicators";
import { describeMergeBuildWatchRow, mergeBuildWaitForPr } from "../merge-build-watches";
import { PullRequestWatchList } from "../PullRequestWatchList";
import { ThreadForgeAutomationContext } from "../../forge-automation/thread-hands-off";
import { PullRequestWatchMenuItems } from "../PullRequestWatchMenuItems";
import {
  resolvePrChipWatch,
  ThreadPrWatchIndicatorsContext,
  useThreadPrWatches,
  withMergeBuildWaits,
  type ThreadPrWatchIndicatorsValue,
} from "../useThreadPrWatchIndicators";

afterEach(() => {
  cleanup();
});

const NOW = 10_000_000;
const PR_URL = "https://github.com/example/widgets/pull/41";

const pr = (patch: Partial<PrSummary> = {}): PrSummary => ({
  provider: "github.com", org: "example", repo: "widgets", number: 41, url: PR_URL, title: "feat: widgets",
  state: "passing", checkState: "passing", lifecycleState: "open", ...patch,
});
const merged = pr({ state: "merged", lifecycleState: "merged", mergedAt: NOW - 120_000 });

const thread: NavigationThreadSummary = {
  id: "feature", source: "codex", title: "Widgets", titleSource: "explicit", inbox: { inInbox: false },
  linkedDirectories: [], primaryGitRepository: "github.com/example/widgets", prs: [merged],
};

const build = (patch: Partial<ThreadDependencyMergeBuildObservation> = {}): ThreadDependencyMergeBuildObservation => ({
  mergeCommitSha: "9c1e3a7f0b2d4c6e8a0b1c2d3e4f5a6b7c8d9e0f", baseBranch: "main", status: "running",
  checks: { total: 6, passed: 4, failed: 0, cancelled: 0, running: 2, queued: 0, skipped: 0 }, checkedAt: NOW - 60_000, ...patch,
});

/** A thread's own merge build wait on PR 41, as main lists it. */
const wait = (patch: Partial<ThreadDependency> = {}, evidence: Partial<ThreadDependency["evidence"][number]> = {}): ThreadDependency => {
  const condition = { backend: "codex" as const, threadId: "feature", when: "merge_build" as const, prUrl: PR_URL };
  return {
    id: "wait-1", backend: "codex", threadId: "feature", mode: "all", onFailure: "notify", status: "waiting",
    wakeOn: "failure", automatic: true, conditions: [condition],
    evidence: [{ condition, state: "waiting", reason: THREAD_DEPENDENCY_MERGE_BUILD_WAITING_REASON, observedAt: NOW, prUrl: PR_URL, mergeBuild: build(), ...evidence }],
    createdAt: 1, updatedAt: 1, ...patch,
  };
};

describe("merge build watch rows", () => {
  it("says what wakes the thread and where the build stands", () => {
    expect(describeMergeBuildWatchRow(wait(), NOW)).toEqual({ wakes: "if it fails", status: "Running · 4 passed, 2 running · checked 1m ago" });
    expect(describeMergeBuildWatchRow(wait({ wakeOn: undefined, automatic: false }, { mergeBuild: undefined }), NOW))
      .toEqual({ wakes: "on pass or fail", status: "Merged · waiting for checks" });
    expect(describeMergeBuildWatchRow(wait({}, { mergeBuild: undefined, reason: "Waiting for PR merge" }), NOW).status).toBe("After the PR merges");
    expect(describeMergeBuildWatchRow(wait({}, { mergeBuild: build({ followedSha: "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12", follows: 1 }) }), NOW).status)
      .toMatch(/^Following ab12cd3 · Running/);
    expect(describeMergeBuildWatchRow(wait({ status: "dispatching" }), NOW).status).toBe("Waking the thread");
  });

  it("matches a wait to its PR whatever the URL's case, by the PR it names or the one it found", () => {
    expect(mergeBuildWaitForPr([wait()], pr({ url: PR_URL.toUpperCase() }))?.id).toBe("wait-1");
    const unnamed = wait({ conditions: [{ backend: "codex", threadId: "feature", when: "merge_build" }] });
    expect(mergeBuildWaitForPr([unnamed], pr())?.id).toBe("wait-1");
    expect(mergeBuildWaitForPr([wait({}, { prUrl: undefined })], pr({ url: "https://github.com/example/widgets/pull/7" }))).toBeUndefined();
    expect(mergeBuildWaitForPr([wait({ status: "delivered" })], pr())).toBeUndefined();
  });

  it("matches the same PR through authored links to files and discussions", () => {
    const watch = wait();
    expect(mergeBuildWaitForPr([watch], pr({ url: `${PR_URL}/files` }))).toBe(watch);
    fc.assert(fc.property(
      fc.constantFrom("/files", "#discussion_r123", "?tab=checks"),
      fc.constantFrom(7, 41, 42),
      (suffix, number) => {
        const authored = pr({ number, url: `https://github.com/EXAMPLE/widgets/pull/${number}${suffix}` });
        expect(mergeBuildWaitForPr([watch], authored)).toBe(number === 41 ? watch : undefined);
      },
    ));
  });
});

describe("merge build watches on PR chips", () => {
  it.each([
    ["a fresh check", wait({}, { mergeBuild: build({ checks: {
      total: 6, passed: 5, failed: 0, cancelled: 0, running: 1, queued: 0, skipped: 0,
    } }) }), "5 passed, 1 running"],
    ["ready", wait({ status: "ready" }), "Waking the thread"],
    ["dispatching", wait({ status: "dispatching" }), "Waking the thread"],
    ["cancelled", wait({ status: "cancelled" }), undefined],
  ] as const)(
    "updates an open transcript card after %s",
    (_change, next, expected) => {
      const indicators: ThreadPrWatchIndicatorsValue = { byThreadKey: new Map(), stop: vi.fn() };
      const scene = (waits: ThreadDependency[]) => (
        <ThreadDependencyIndicatorsContext.Provider value={{ byThreadKey: summarizeThreadDependencies(waits) }}>
          <ThreadPrWatchIndicatorsContext.Provider value={indicators}>
            <TranscriptPrContextProvider thread={thread}>
              <PullRequestLinkChip pr={merged} />
            </TranscriptPrContextProvider>
          </ThreadPrWatchIndicatorsContext.Provider>
        </ThreadDependencyIndicatorsContext.Provider>
      );
      const view = render(scene([wait()]));
      fireEvent.focus(screen.getByRole("button"));
      const card = screen.getByRole("tooltip");
      expect(card).toHaveTextContent("4 passed, 2 running");
      view.rerender(scene([next]));
      expect(screen.getByRole("tooltip")).toBe(card);
      if (expected === undefined) {
        expect(card).not.toHaveTextContent("Merge build");
      } else {
        expect(card).toHaveTextContent(expected);
      }
    },
  );

  it("keeps one chip watch per unchanged thread entry and wait, so memoized chips bail out", () => {
    fc.assert(fc.property(fc.boolean(), fc.integer({ min: 0, max: 3 }), (open, running) => {
      const waits = [wait({}, { mergeBuild: build({ checks: { total: 6, passed: 6 - running, failed: 0, cancelled: 0, running, queued: 0, skipped: 0 } }) })];
      const watches = withMergeBuildWaits(undefined, waits);
      expect(withMergeBuildWaits(undefined, waits)).toBe(watches);
      const subject = open ? pr() : merged;
      const first = resolvePrChipWatch(watches, subject, undefined);
      expect(first?.mergeBuild).toBe(waits[0]);
      expect(resolvePrChipWatch(watches, subject, undefined)).toBe(first);
      // A new check is a new list, and a new chip watch.
      const next = [wait({}, { mergeBuild: build({ checkedAt: NOW }) })];
      expect(resolvePrChipWatch(withMergeBuildWaits(undefined, next), subject, undefined)).not.toBe(first);
    }));
  });

  it("lists only the thread's own merge build waits, and a new check changes the indicator", () => {
    const other = wait({ id: "wait-2", threadId: "review", conditions: [{ backend: "codex", threadId: "feature", when: "merge_build", prUrl: PR_URL }] });
    const indicators = summarizeThreadDependencies([wait(), other]);
    expect(indicators.get("codex:feature")?.mergeBuildWaits?.map((item) => item.id)).toEqual(["wait-1"]);
    expect(indicators.get("codex:review")?.mergeBuildWaits).toBeUndefined();
    const later = summarizeThreadDependencies([wait({}, { mergeBuild: build({ checkedAt: NOW }) })]);
    expect(later.get("codex:feature")?.mergeBuildSignature).not.toBe(indicators.get("codex:feature")?.mergeBuildSignature);
  });

  it("reads a thread's merge build waits from Continue After, beside its PR watches", () => {
    function Reader() {
      const watches = useThreadPrWatches(thread);
      return <output>{watches?.mergeBuildWaits?.length ?? "none"}</output>;
    }
    render(
      <ThreadDependencyIndicatorsContext.Provider value={{ byThreadKey: summarizeThreadDependencies([wait()]) }}>
        <ThreadPrWatchIndicatorsContext.Provider value={{ byThreadKey: new Map() }}>
          <Reader />
        </ThreadPrWatchIndicatorsContext.Provider>
      </ThreadDependencyIndicatorsContext.Provider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("1");
  });
});

describe("the PR chip's menu", () => {
  function renderMenu(dependencies: ThreadDependency[], subject: PrSummary) {
    const value: ThreadPrWatchIndicatorsValue = {
      byThreadKey: new Map(),
      stop: vi.fn(async () => undefined),
      watchMergeBuild: vi.fn(async () => undefined),
      stopMergeBuild: vi.fn(async () => undefined),
    };
    const onClose = vi.fn();
    render(
      <ThreadDependencyIndicatorsContext.Provider value={{ byThreadKey: summarizeThreadDependencies(dependencies) }}>
        <ThreadPrWatchIndicatorsContext.Provider value={value}>
          <div role="menu">
            <PullRequestWatchMenuItems thread={thread} pr={subject} onClose={onClose} />
          </div>
        </ThreadPrWatchIndicatorsContext.Provider>
      </ThreadDependencyIndicatorsContext.Provider>,
    );
    return { value, onClose };
  }

  it("offers Watch Merge Build on a merged PR the thread does not watch", () => {
    const { value, onClose } = renderMenu([], merged);
    fireEvent.click(screen.getByRole("menuitem", { name: "Watch Merge Build" }));
    expect(onClose).toHaveBeenCalled();
    expect(value.watchMergeBuild).toHaveBeenCalledWith(thread, merged);
    expect(screen.queryByRole("menuitem", { name: /Stop Watching Merge Build/ })).toBeNull();
  });

  it("offers Stop Watching Merge Build, saying what wakes the thread", () => {
    const active = wait();
    const { value } = renderMenu([active], merged);
    const item = screen.getByRole("menuitem", { name: /Stop Watching Merge Build\s*Wakes if it fails/ });
    fireEvent.click(item);
    expect(value.stopMergeBuild).toHaveBeenCalledWith(thread, expect.objectContaining({ id: active.id }));
    expect(screen.queryByRole("menuitem", { name: "Watch Merge Build" })).toBeNull();
  });

  it("offers nothing for a closed PR, which never merges", () => {
    renderMenu([], pr({ state: "closed", lifecycleState: "closed" }));
    expect(screen.queryByRole("menuitem", { name: /Merge Build/ })).toBeNull();
  });
});

describe("the hover card and the rail", () => {
  it("lists the merge build under Wakes this thread", () => {
    render(<PrStatusCard pr={merged} watch={{ mergeBuild: wait() }} watchStopHint now={NOW} />);
    expect(screen.getByText("Merge build")).toBeInTheDocument();
    expect(screen.getByText("if it fails")).toBeInTheDocument();
    expect(screen.getByText("Running · 4 passed, 2 running · checked 1m ago")).toBeInTheDocument();
    expect(screen.getByText("Right-click the chip to stop a watch.")).toBeInTheDocument();
  });

  it("shows a merged PR's merge build with Stop, and no Watch CI hint", async () => {
    const onStopMergeBuild = vi.fn(async () => undefined);
    const active = wait({ wakeOn: undefined, automatic: false });
    render(<PullRequestWatchList pr={merged} watches={[]} autoFix={false} mergeBuild={active} onStopMergeBuild={onStopMergeBuild} now={NOW} />);
    expect(screen.getByText("Merge build · wakes on pass or fail")).toBeInTheDocument();
    expect(screen.queryByText("Not waiting for CI.")).toBeNull();
    const stop = screen.getByRole("button", { name: "Stop watching the merge build of #41" });
    fireEvent.click(stop);
    expect(onStopMergeBuild).toHaveBeenCalledWith(active);
    expect(stop).toBeDisabled();
    await waitFor(() => expect(stop).toBeEnabled());
  });

  it("switches Auto-fix for one PR from its watch list, and back on once it is off", () => {
    const pr: PrSummary = {
      provider: "github.com", org: "example", repo: "app", number: 41, state: "passing", lifecycleState: "open",
      url: "https://github.com/example/app/pull/41",
    };
    const onSetPrAutoFix = vi.fn();
    const onTurnOffAutoFix = vi.fn();
    const { rerender } = render(
      <PullRequestWatchList pr={pr} watches={[]} autoFix onTurnOffAutoFix={onTurnOffAutoFix} onSetPrAutoFix={onSetPrAutoFix} now={NOW} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Skip This PR, #41: the thread's other PRs keep Auto-fix" }));
    expect(onSetPrAutoFix).toHaveBeenLastCalledWith(false);
    expect(onTurnOffAutoFix).not.toHaveBeenCalled();
    rerender(
      <PullRequestWatchList pr={pr} watches={[]} autoFix={false} autoFixBlocked={{ reason: "switched_off" }}
        onTurnOffAutoFix={onTurnOffAutoFix} onSetPrAutoFix={onSetPrAutoFix} now={NOW} />,
    );
    expect(screen.getByText("Auto-fix off for this PR")).toBeInTheDocument();
    expect(screen.queryByText(/handled by/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Turn On Auto-fix for #41" }));
    expect(onSetPrAutoFix).toHaveBeenLastCalledWith(true);
  });

  it("names a hands-off PR on its card and in its watch list instead of claiming Auto-fix repairs it", () => {
    const pr: PrSummary = {
      provider: "github.com", org: "upstream", repo: "app", number: 7, state: "failing", lifecycleState: "open",
      url: "https://github.com/upstream/app/pull/7", labels: ["takeover:maintainer"],
    };
    const thread = {
      id: "t", source: "codex", title: "t", titleSource: "explicit", inbox: { inInbox: false },
      linkedDirectories: [{ path: "/work/app" }],
    } as unknown as NavigationThreadSummary;
    const lookup = () => ({ handsOff: [{ repository: "upstream/app", label: "takeover:*" }] });
    render(
      <ThreadForgeAutomationContext.Provider value={lookup}>
        <PrStatusCard pr={pr} watch={{ autoFix: true }} stackThread={thread} now={NOW} />
      </ThreadForgeAutomationContext.Provider>,
    );
    expect(screen.getByText("hands-off")).toBeInTheDocument();
    expect(screen.getByText("Labeled takeover:maintainer")).toBeInTheDocument();
    expect(screen.queryByText("on")).toBeNull();
    cleanup();
    render(<PullRequestWatchList pr={pr} watches={[]} autoFix={false}
      autoFixBlocked={{ reason: "hands_off", detail: "hands-off, labeled takeover:maintainer" }} now={NOW} />);
    expect(screen.getByText("Auto-fix hands-off")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Auto-fix/ })).toBeNull();
  });
});

