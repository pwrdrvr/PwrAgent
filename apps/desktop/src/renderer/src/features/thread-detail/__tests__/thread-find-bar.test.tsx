import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadFindBar } from "../ThreadFindBar";

// jsdom ships neither the CSS Custom Highlight API (which the find bar uses to
// paint matches without touching the React-rendered transcript) nor
// `scrollIntoView`. Stub both: without the highlight API the bar short-circuits
// and never matches anything, and `scrollIntoView` is the whole subject here.
type HighlightGlobals = {
  Highlight: unknown;
  CSS: { highlights: Map<string, unknown>; escape: (value: string) => string };
};

const scrollIntoView = vi.fn();

beforeEach(() => {
  const globals = globalThis as unknown as HighlightGlobals;
  globals.Highlight = class {
    ranges: Range[];
    constructor(...ranges: Range[]) {
      this.ranges = ranges;
    }
  };
  globals.CSS = {
    highlights: new Map<string, unknown>(),
    escape: (value: string) => value,
  };
  Element.prototype.scrollIntoView = scrollIntoView;
  scrollIntoView.mockClear();
});

afterEach(() => {
  cleanup();
});

/**
 * Renders the bar over a transcript-like container, the way ThreadView does.
 * `entries` stands in for transcript items; `refreshKey` is what ThreadView
 * bumps when the entry count changes (i.e. when messages stream in).
 */
function Harness(props: {
  entries: readonly string[];
  refreshKey?: unknown;
  onClose?: () => void;
}): ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div>
      <ThreadFindBar
        containerRef={containerRef}
        refreshKey={props.refreshKey ?? props.entries.length}
        onClose={props.onClose ?? (() => {})}
      />
      <div ref={containerRef}>
        {props.entries.map((entry, index) => (
          <p key={index}>{entry}</p>
        ))}
      </div>
    </div>
  );
}

function renderBar(entries: readonly string[], onClose?: () => void): {
  rerenderWith: (next: readonly string[]) => void;
} {
  const view = render(<Harness entries={entries} onClose={onClose} />);
  return {
    rerenderWith: (next: readonly string[]) => {
      view.rerender(<Harness entries={next} onClose={onClose} />);
    },
  };
}

function typeQuery(query: string): void {
  fireEvent.change(findInput(), { target: { value: query } });
}

function findInput(): HTMLElement {
  // The bar's wrapper carries the same aria-label, so scope to the textbox.
  return screen.getByRole("textbox", { name: "Find in thread" });
}

describe("ThreadFindBar scrolling", () => {
  it("scrolls to the first match when the operator types a query", () => {
    renderBar(["alpha needle", "beta", "gamma needle"]);
    typeQuery("needle");

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls when the operator steps to the next match", () => {
    renderBar(["alpha needle", "beta", "gamma needle"]);
    typeQuery("needle");
    scrollIntoView.mockClear();

    fireEvent.click(screen.getByLabelText("Next match"));

    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("scrolls when the operator presses Enter to cycle matches", () => {
    renderBar(["alpha needle", "beta", "gamma needle"]);
    typeQuery("needle");
    scrollIntoView.mockClear();

    fireEvent.keyDown(findInput(), { key: "Enter" });

    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("does NOT scroll when new messages arrive and the operator isn't navigating", () => {
    // The reported bug: with the bar open and a stale query, every streamed
    // message re-collects matches and yanked the viewport back to the active
    // one — even though the operator had scrolled away and wasn't finding.
    const bar = renderBar(["alpha needle", "beta"]);
    typeQuery("needle");
    scrollIntoView.mockClear();

    bar.rerenderWith(["alpha needle", "beta", "gamma streamed in"]);

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does NOT scroll when a streamed message adds a new match", () => {
    const bar = renderBar(["alpha needle", "beta"]);
    typeQuery("needle");
    scrollIntoView.mockClear();

    bar.rerenderWith(["alpha needle", "beta", "gamma needle"]);

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does NOT scroll when the transcript changes under a match count that shrinks", () => {
    const bar = renderBar(["alpha needle", "beta needle"]);
    typeQuery("needle");
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    scrollIntoView.mockClear();

    // The active match disappears (a turn collapsed / an item re-rendered).
    bar.rerenderWith(["alpha needle"]);

    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("restarts at the first match when the operator retypes the query", () => {
    renderBar(["alpha needle", "beta needle"]);
    typeQuery("needle");
    fireEvent.click(screen.getByLabelText("Next match"));
    expect(screen.getByText("2 of 2")).toBeInTheDocument();

    typeQuery("needl");

    expect(screen.getByText("1 of 2")).toBeInTheDocument();
  });

  it("scrolls to the new query's match, not the old query's", () => {
    // Retyping resets the active index, and the index changing is itself enough
    // to re-run the scroll — so the scroll must wait for the matches collected
    // for the NEW query, or it lands on wherever the old query's first hit was.
    renderBar(["alpha", "beta alpha", "gamma"]);
    typeQuery("alpha");
    fireEvent.click(screen.getByLabelText("Next match"));
    scrollIntoView.mockClear();

    typeQuery("gamma");

    expect(screen.getByText("1 of 1")).toBeInTheDocument();
    // `contexts` is the `this` of each call — i.e. the element scrolled. (Not
    // `instances`, which is documented as the `new`-constructed instances and
    // only happens to carry `this` today.)
    const scrolled = scrollIntoView.mock.contexts.at(-1) as Element | undefined;
    expect(scrolled?.textContent).toBe("gamma");
  });
});

describe("ThreadFindBar dismissal", () => {
  it("closes on Escape while the find input is focused", () => {
    const onClose = vi.fn();
    renderBar(["alpha needle"], onClose);

    fireEvent.keyDown(findInput(), { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape after focus has moved back into the transcript", () => {
    // The operator ⌘F's, clicks into the transcript to read, then hits Escape
    // expecting the bar to go away. It didn't: the only Escape handler lived on
    // the input.
    const onClose = vi.fn();
    renderBar(["alpha needle"], onClose);
    typeQuery("needle");
    (findInput() as HTMLInputElement).blur();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when another surface already handled it", () => {
    const onClose = vi.fn();
    renderBar(["alpha needle"], onClose);

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    event.preventDefault();
    window.dispatchEvent(event);

    expect(onClose).not.toHaveBeenCalled();
  });
});
