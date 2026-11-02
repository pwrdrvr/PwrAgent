import "@testing-library/jest-dom/vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NavigationThreadSummary,
  PrSummary,
  ThreadPullRequestWatchSummary,
} from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { PrChip } from "../../pr-status/PrChip";
import {
  ThreadPrWatchIndicatorsContext,
  summarizeThreadPrWatches,
} from "../../pr-watches/useThreadPrWatchIndicators";
import { memoRenderObserver } from "../../../test/memo-render-observer";

/**
 * A sidebar row rebuilds its children's callbacks on every render, because
 * they close over the row's own thread and the parent's handlers. That made
 * the memoized chips below re-render on every parent render no matter how
 * stable their data was — measured on the Directories lens as 256 `PrChip`
 * renders, every one blamed on `onOpenContextMenu` and `onDetach` and nothing
 * else.
 *
 * `useEventCallback` is what breaks that link, so this pins the result at the
 * boundary that consumes it rather than trusting the helper's own unit test.
 */

function pr(number: number): PrSummary {
  return {
    provider: "github.com",
    org: "pwrdrvr",
    repo: "PwrAgent",
    number,
    state: "pending",
    url: `https://github.com/pwrdrvr/PwrAgent/pull/${number}`,
  };
}

function thread(prs: PrSummary[]): NavigationThreadSummary {
  return {
    id: "thread-render-cost",
    title: "Render cost row",
    titleSource: "explicit",
    source: "codex",
    executionMode: "default",
    updatedAt: 1,
    inbox: { inInbox: false },
    linkedDirectories: [],
    prs,
  } as unknown as NavigationThreadSummary;
}

let renders = 0;
/** The `onDetach` the row most recently handed its chip. */
let lastDetach: ((target: PrSummary) => void) | undefined;
const chipRenders = memoRenderObserver<{
  onDetach?: (target: PrSummary) => void;
}>(PrChip, "PrChip");

beforeEach(() => {
  renders = 0;
  lastDetach = undefined;
  chipRenders.install((props) => {
    renders += 1;
    lastDetach = props.onDetach;
  });
});

afterEach(() => {
  cleanup();
  chipRenders.restore();
});

/** Fresh inline handlers every time, the way the real parents supply them. */
function row(entry: NavigationThreadSummary) {
  return (
    <ThreadRow
      thread={entry}
      onSelectThread={() => undefined}
      onOpenContextMenu={() => undefined}
      onOpenPullRequestContextMenu={() => undefined}
      onDetachPullRequest={async () => undefined}
      onOpenPullRequest={() => undefined}
    />
  );
}

describe("thread row render cost", () => {
  it("does not re-render a PR chip when only the parent's handlers are new", () => {
    const entry = thread([pr(2116)]);
    const { rerender } = render(row(entry));
    expect(renders).toBe(1);

    // Ten parent renders. The thread is unchanged; every handler is a brand
    // new function, which is exactly what the sidebar hands down today.
    for (let round = 0; round < 10; round += 1) rerender(row(entry));

    expect(renders).toBe(1);
  });

  it("still re-renders the chip when the PR itself changes", () => {
    // The other half: the bail-out must not outlive the data it was based on.
    const entry = thread([pr(2116)]);
    const { rerender } = render(row(entry));
    expect(renders).toBe(1);

    rerender(row(thread([{ ...pr(2116), state: "merged" }])));

    expect(renders).toBe(2);
  });

  it("re-renders no row body when one thread's PR watch changes", () => {
    // Rows used to read the watch context themselves, so every watch change
    // re-rendered every memoized row body in the sidebar.
    const rowRenders = new Map<string, number>();
    const rows = memoRenderObserver<{ thread: NavigationThreadSummary }>(ThreadRow, "ThreadRow");
    rows.install((props) => {
      rowRenders.set(props.thread.id, (rowRenders.get(props.thread.id) ?? 0) + 1);
    });
    try {
      const first = { ...thread([pr(2201)]), id: "thread-a" };
      const second = { ...thread([pr(2202)]), id: "thread-b" };
      const watch: ThreadPullRequestWatchSummary = {
        watchId: "watch-a", backend: "codex", threadId: first.id,
        prKey: buildPullRequestStatusKey(pr(2201)), prUrl: pr(2201).url, prNumber: 2201,
        headSha: "a".repeat(40), notifyOn: ["success", "failure"], createdAt: 1,
        failureHandledByAutoFix: false, kind: "checks",
      };
      const select = () => undefined;
      let setWatches!: (watches: ThreadPullRequestWatchSummary[]) => void;
      function Harness() {
        const [watches, update] = useState<ThreadPullRequestWatchSummary[]>([]);
        setWatches = update;
        return (
          <ThreadPrWatchIndicatorsContext.Provider value={{ byThreadKey: summarizeThreadPrWatches(watches) }}>
            <ThreadRow thread={first} onSelectThread={select} onOpenContextMenu={select} />
            <ThreadRow thread={second} onSelectThread={select} onOpenContextMenu={select} />
          </ThreadPrWatchIndicatorsContext.Provider>
        );
      }
      render(<Harness />);
      expect(rowRenders).toEqual(new Map([["thread-a", 1], ["thread-b", 1]]));
      expect(renders).toBe(2);

      act(() => setWatches([watch]));

      // Only thread A's chip re-renders, to draw its eye.
      expect(rowRenders).toEqual(new Map([["thread-a", 1], ["thread-b", 1]]));
      expect(renders).toBe(3);
    } finally {
      rows.restore();
    }
  });

  it("keeps the detach handler wired to the newest parent callback", () => {
    // The risk a stable identity introduces: calling a stale closure. The
    // handler identity must not change, and it must still reach the CURRENT
    // parent's callback.
    const entry = thread([pr(2116)]);
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    const view = render(
      <ThreadRow
        thread={entry}
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onDetachPullRequest={first}
      />,
    );
    const captured = lastDetach;
    view.rerender(
      <ThreadRow
        thread={entry}
        onSelectThread={() => undefined}
        onOpenContextMenu={() => undefined}
        onDetachPullRequest={second}
      />,
    );

    expect(lastDetach).toBe(captured);
    captured?.(pr(2116));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
