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
