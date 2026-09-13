import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ThreadRowStatus } from "../ThreadRowStatus";

/**
 * `ThreadRowStatus` renders once per mounted thread row, and
 * `features/navigation/` memoizes nothing above it — so every App render
 * re-renders one of these per visible row. A Profiler session over the
 * Directories lens with ten rows expanded measured 310 zero-input renders of
 * it across 31 commits, the largest remaining source after the icon library
 * was memoized.
 *
 * It is safe to memo where `ThreadRow` is not: the row receives the whole
 * `thread` object, which `hydrateHoverStableSidebarSnapshot` rebuilds on
 * every render while the pointer rests on a row; this component receives only
 * the derived status string and a boolean.
 */

type MemoComponent = { type: (props: never) => unknown };

const REACT_MEMO = Symbol.for("react.memo");

let renders = 0;
const memoized = ThreadRowStatus as unknown as MemoComponent;
const inner = memoized.type;
memoized.type = (props: never) => {
  renders += 1;
  return inner(props);
};

afterEach(() => {
  cleanup();
  renders = 0;
});

describe("thread row status render cost", () => {
  it("is a memo component", () => {
    expect((ThreadRowStatus as unknown as { $$typeof: symbol }).$$typeof).toBe(
      REACT_MEMO,
    );
  });

  it("does not re-render when the row above it re-renders unchanged", () => {
    const Row = ({ title }: { title: string }) => (
      <div>
        <ThreadRowStatus remoteWork={false} status="unread" />
        <span>{title}</span>
      </div>
    );
    const { rerender } = render(<Row title="round 0" />);
    expect(renders).toBe(1);
    expect(screen.getByLabelText("Unread update")).toBeInTheDocument();

    // Ten parent renders with a changing title and an unchanged status —
    // what a streamed turn looks like to a sidebar row.
    for (let round = 1; round <= 10; round += 1) {
      rerender(<Row title={`round ${round}`} />);
    }

    expect(renders).toBe(1);
  });

  it("still follows its own props when the status changes", () => {
    const { rerender } = render(<ThreadRowStatus status="unread" />);
    expect(renders).toBe(1);

    rerender(<ThreadRowStatus status="thinking" />);

    expect(renders).toBe(2);
    expect(screen.getByLabelText("Thinking")).toBeInTheDocument();
  });

  it("still follows a change to remoteWork alone", () => {
    // Same status, different ownership: the mark keeps its beam but drops the
    // accent, so a stale bail-out here would paint a peer's turn as ours.
    const { rerender } = render(
      <ThreadRowStatus remoteWork={false} status="thinking" />,
    );
    expect(renders).toBe(1);

    rerender(<ThreadRowStatus remoteWork status="thinking" />);

    expect(renders).toBe(2);
    expect(screen.getByLabelText("Thinking on another instance")).toBeInTheDocument();
  });
});
