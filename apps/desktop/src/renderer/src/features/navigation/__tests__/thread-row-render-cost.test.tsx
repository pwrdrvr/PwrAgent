import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";
import { PrChip } from "../../pr-status/PrChip";

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

type MemoComponent = { type: (props: never) => unknown };

let renders = 0;
/** The `onDetach` the row most recently handed its chip. */
let lastDetach: ((target: PrSummary) => void) | undefined;
const memoized = PrChip as unknown as MemoComponent;
const inner = memoized.type;

beforeEach(() => {
  renders = 0;
  lastDetach = undefined;
  memoized.type = (props: never) => {
    renders += 1;
    lastDetach = (props as { onDetach?: (target: PrSummary) => void }).onDetach;
    return inner(props);
  };
});

afterEach(() => {
  cleanup();
  memoized.type = inner;
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
