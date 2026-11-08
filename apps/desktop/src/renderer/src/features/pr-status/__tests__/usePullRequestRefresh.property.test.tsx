import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../../lib/desktop-api";
import { usePullRequestRefresh } from "../usePullRequestRefresh";

const input = fc.record({
  id: fc.nat(20), branch: fc.nat(20), directory: fc.nat(20),
  prs: fc.uniqueArray(fc.record({ number: fc.integer({ min: 1, max: 20 }), state: fc.constantFrom("passing" as const, "failing" as const, "pending" as const) }),
    { maxLength: 3, selector: (pr) => pr.number }),
  repeats: fc.integer({ min: 1, max: 5 }),
});
type Input = { id: number; branch: number; directory: number; prs: { number: number; state: "passing" | "failing" | "pending" }[]; repeats: number };

async function checkFixpoint(input: Input, callbackChurn: boolean) {
  const prs: PrSummary[] = input.prs.map((pr) => ({ ...pr, provider: "github.com", org: "example", repo: "project",
    url: `https://github.com/example/project/pull/${pr.number}` }));
  const selected: NavigationThreadSummary = { id: `thread-${input.id}`, source: "codex", title: "Thread", titleSource: "explicit",
    gitBranch: `topic/${input.branch}`, linkedDirectories: [{ id: "project", kind: "local", label: "Project", path: `/project-${input.directory}` }],
    prs, inbox: { inInbox: false } };
  let responsePrs = prs;
  const refresh = vi.fn(async () => ({ backend: "codex" as const, threadId: selected.id, provider: "github.com" as const, ghAvailable: true, prs: responsePrs }));
  const navigation = vi.fn(async () => undefined);
  const desktopApi = { refreshThreadPullRequests: refresh } satisfies DesktopApi;
  // Inject a dormant polling clock: no real interval or fake time is needed
  // to ask whether replaying an input has already reached a fixpoint.
  const interval = vi.spyOn(window, "setInterval").mockImplementation(() => 0 as unknown as ReturnType<typeof window.setInterval>);
  const initialProps: { selectedThread: NavigationThreadSummary; onRefreshNavigation: () => Promise<void> } = {
    selectedThread: selected, onRefreshNavigation: navigation,
  };
  const view = renderHook((props: typeof initialProps) =>
    usePullRequestRefresh({ desktopApi, ...props }), {
    initialProps,
  });
  try {
    await act(async () => {});
    expect(refresh).toHaveBeenCalledTimes(1);
    for (let step = 0; step < input.repeats; step++) {
      await act(async () => {
        view.rerender({
          selectedThread: callbackChurn ? selected : { ...structuredClone(selected), title: `Snapshot ${step}` },
          onRefreshNavigation: callbackChurn ? async () => { await navigation(); } : navigation,
        });
      });
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(interval).toHaveBeenCalledTimes(1);
      expect(navigation).not.toHaveBeenCalled();
    }
    // A changed request/result must still refresh navigation once, then
    // stabilize when the owner's new snapshot arrives. This rejects hooks
    // that merely disable subsequent reads or ignore changed responses.
    responsePrs = [...prs, { provider: "github.com", org: "example", repo: "project", number: 99,
      state: "passing", url: "https://github.com/example/project/pull/99" }];
    const changed = { ...selected, gitBranch: `${selected.gitBranch}-next` };
    await act(async () => { view.rerender({ selectedThread: changed, onRefreshNavigation: navigation }); });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(navigation).toHaveBeenCalledTimes(1);
    const settled = { ...changed, prs: responsePrs };
    await act(async () => { view.rerender({ selectedThread: settled, onRefreshNavigation: navigation }); });
    await act(async () => { view.rerender({ selectedThread: structuredClone(settled), onRefreshNavigation: navigation }); });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(navigation).toHaveBeenCalledTimes(1);
  } finally { view.unmount(); interval.mockRestore(); }
}

it("reaches a PR-request fixpoint across equivalent owner snapshots", async () => {
  await fc.assert(fc.asyncProperty(input, (value) => checkFixpoint(value, false)), { numRuns: 25 });
});

it("reaches the same fixpoint when only the navigation callback identity changes", async () => {
  await fc.assert(fc.asyncProperty(input, (value) => checkFixpoint(value, true)), { numRuns: 25 });
});

it.each([
  { regression: "#251 snapshot replacement", callbackChurn: false },
  { regression: "#346 callback identity", callbackChurn: true },
])("keeps one read after an equivalent render (shrunk $regression regression)", async ({ callbackChurn }) => {
  await checkFixpoint({ id: 0, branch: 0, directory: 0, prs: [], repeats: 1 }, callbackChurn);
});
