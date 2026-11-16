import { act, renderHook } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { useNavigationHistory, type NavigationHistoryLocation } from "../useNavigationHistory";

it("Back then Forward preserves the unsubmitted composer after any navigation prefix", () => {
  fc.assert(fc.property(
    fc.array(fc.record({
      view: fc.constantFrom("thread", "launchpad", "back", "forward"),
      key: fc.integer({ min: 0, max: 3 }),
    }), { maxLength: 12 }),
    (visits) => {
      const restore = vi.fn();
      const startingThreads = new Map<string, string | undefined>();
      const h = renderHook(({ current }: { current: NavigationHistoryLocation }) =>
        useNavigationHistory({ current, restore, startingThreads }), {
        initialProps: { current: { view: "thread", threadKey: "codex:initial" } as NavigationHistoryLocation },
      });
      const navigate = (current: NavigationHistoryLocation): void => {
        act(() => h.rerender({ current }));
      };
      try {
        for (const visit of visits) {
          if (visit.view === "back" || visit.view === "forward") {
            restore.mockClear();
            act(() => visit.view === "back" ? h.result.current.goBack() : h.result.current.goForward());
            if (restore.mock.lastCall) navigate(restore.mock.lastCall[0]);
            continue;
          }
          navigate(visit.view === "thread"
            ? { view: "thread", threadKey: `codex:${visit.key}` }
            : { view: "launchpad", directoryKey: `directory:${visit.key}` });
        }
        navigate({ view: "thread", threadKey: "codex:copy-source" });
        const composer: NavigationHistoryLocation = { view: "launchpad", directoryKey: "directory:0" };
        navigate(composer);
        act(() => h.result.current.goBack());
        navigate(restore.mock.lastCall![0]);
        expect(h.result.current.canGoForward).toBe(true);
        act(() => h.result.current.goForward());
        expect(restore).toHaveBeenLastCalledWith(composer);
      } finally {
        h.unmount();
      }
    },
  ), { numRuns: 25 });
});

it("branching after Back retains every unsubmitted composer and drops ordinary Forward visits", () => {
  fc.assert(fc.property(
    fc.uniqueArray(fc.record({
      directoryKey: fc.integer({ min: 0, max: 6 }).map((key) => `directory:${key}`),
      instanceId: fc.option(fc.constantFrom("studio", "laptop"), { nil: undefined }),
    }), { minLength: 1, maxLength: 6, selector: (project) => JSON.stringify(project) }),
    (projects) => {
      const restore = vi.fn();
      const source: NavigationHistoryLocation = { view: "thread", threadKey: "codex:source" };
      const startingThreads = new Map<string, string | undefined>();
      const h = renderHook(({ current }: { current: NavigationHistoryLocation }) =>
        useNavigationHistory({ current, restore, startingThreads }), {
        initialProps: { current: source as NavigationHistoryLocation },
      });
      const navigate = (current: NavigationHistoryLocation): void => {
        act(() => h.rerender({ current }));
      };
      const back = (): NavigationHistoryLocation => {
        restore.mockClear();
        act(() => h.result.current.goBack());
        expect(restore).toHaveBeenCalledOnce();
        const location = restore.mock.lastCall![0] as NavigationHistoryLocation;
        navigate(location);
        return location;
      };
      try {
        const composers: NavigationHistoryLocation[] = projects.map((project) => ({ view: "launchpad", ...project }));
        for (const [index, composer] of composers.entries()) {
          navigate(composer);
          navigate({ view: "thread", threadKey: `codex:forward-${index}` });
        }
        for (let index = 0; index < composers.length * 2; index += 1) back();
        navigate({ view: "thread", threadKey: "codex:other" });
        expect(h.result.current.canGoForward).toBe(false);
        // The thread just left remains the first Back target. Only live
        // composers survive the abandoned branch, newest visit first.
        for (const expected of [source, ...composers.toReversed()]) {
          expect(back()).toEqual(expected);
        }
        expect(h.result.current.canGoBack).toBe(false);
      } finally {
        h.unmount();
      }
    },
  ), { numRuns: 25 });
});
