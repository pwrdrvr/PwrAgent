import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import * as tooltips from "../../../lib/useViewportTooltip";
import {
  ThreadDependencyIndicatorsContext,
  threadDependencyIndicatorKey,
} from "../../thread-dependencies/useThreadDependencyIndicators";
import { ThreadMetaChips } from "../ThreadMetaChips";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const thread: NavigationThreadSummary = {
  id: "contrived",
  source: "codex",
  title: "Contrived",
  titleSource: "explicit",
  linkedDirectories: [],
  inbox: { inInbox: false },
};

it("sets up viewport tooltip controllers only for an interacted-with chip row", () => {
  const setup = vi.spyOn(tooltips, "useViewportTooltip");
  fc.assert(fc.property(fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }), (drafts) => {
    setup.mockClear();
    const view = render(<>
      {drafts.map((hasUnsentDraft, index) => <ThreadMetaChips
        key={index}
        thread={{ ...thread, id: String(index) }}
        hasUnsentDraft={hasUnsentDraft}
      />)}
    </>);
    try {
      expect(setup).not.toHaveBeenCalled();
      expect(screen.queryByRole("tooltip")).toBeNull();
    } finally {
      view.unmount();
    }
  }), { numRuns: 25 });
});

it("keeps the tooltip with the latest chip, including across rows and unmount", () => {
  const view = render(<>
    <div data-testid="first"><ThreadMetaChips thread={thread} hasUnsentDraft /></div>
    <div data-testid="second"><ThreadMetaChips thread={{ ...thread, id: "second" }} hasUnsentDraft /></div>
  </>);
  const first = within(screen.getByTestId("first")).getByRole("img", { name: "Unsent draft" });
  const second = within(screen.getByTestId("second")).getByRole("img", { name: "Unsent draft" });

  fireEvent.mouseEnter(first);
  const firstTooltip = screen.getByRole("tooltip");
  expect(firstTooltip.textContent).toContain("composer text");
  fireEvent.mouseEnter(second);
  const secondTooltip = screen.getByRole("tooltip");
  expect(secondTooltip).not.toBe(firstTooltip);
  fireEvent.mouseLeave(first);
  expect(screen.getByRole("tooltip")).toBe(secondTooltip);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("tooltip")).toBeNull();

  fireEvent.mouseEnter(first);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  view.unmount();
  expect(screen.queryByRole("tooltip")).toBeNull();
});

it.each(["draft", "branch"] as const)("gives the last %s event the window tooltip in a shared React batch", (last) => {
  render(<ThreadMetaChips thread={{ ...thread, gitBranch: "fixture-branch" }} hasUnsentDraft />);
  const draft = screen.getByRole("img", { name: "Unsent draft" });
  const branch = screen.getByRole("button", { name: "Copy branch fixture-branch" });
  const actions = {
    draft: () => fireEvent.mouseEnter(draft),
    branch: () => branch.focus(),
  };

  // The last opening event owns the slot even if an earlier chip still
  // needs its portal to mount. Commit order cannot reverse event order.
  act(() => {
    actions[last === "draft" ? "branch" : "draft"]();
    actions[last]();
  });
  expect(document.activeElement).toBe(branch);
  expect(screen.getByRole("tooltip").textContent)
    .toContain(last === "draft" ? "Unsent draft" : "fixture-branch");
});

it("keeps a keyboard-open tooltip when a previous chip leaves, and releases a removed anchor", async () => {
  const open = vi.fn();
  const tree = (hasDependency: boolean) => (
    <ThreadDependencyIndicatorsContext.Provider value={{
      byThreadKey: hasDependency ? new Map([[threadDependencyIndicatorKey("codex", thread.id), {
        label: "Waiting",
        tooltip: "Waiting on a fixture thread",
        count: 1,
        alert: false,
        mergeHeld: false,
      }]]) : new Map(),
      open,
    }}>
      <ThreadMetaChips thread={thread} hasUnsentDraft />
    </ThreadDependencyIndicatorsContext.Provider>
  );
  const view = render(tree(true));
  const draft = screen.getByRole("img", { name: "Unsent draft" });
  const dependency = screen.getByRole("button", { name: "Continue after: Waiting" });

  fireEvent.mouseEnter(draft);
  act(() => dependency.focus());
  fireEvent.mouseLeave(draft);
  expect(screen.getByRole("tooltip").textContent).toContain("Waiting on a fixture thread");
  fireEvent.keyDown(dependency, { key: "Enter" });
  expect(open).toHaveBeenCalledWith(thread);
  expect(screen.queryByRole("tooltip")).toBeNull();

  fireEvent.mouseEnter(dependency);
  expect(screen.getByRole("tooltip")).toBeTruthy();
  view.rerender(tree(false));
  await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
});
