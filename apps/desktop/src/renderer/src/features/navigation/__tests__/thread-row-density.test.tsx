import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopAppearanceDensity, NavigationThreadSummary, PrSummary } from "@pwragent/shared";
import { threadSummaryIdentityKey } from "../../../lib/federated-thread-events";
import { ThreadRow } from "../ThreadRow";
import { ThreadRowDensityContext } from "../thread-row-density";

afterEach(cleanup);

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    ...overrides,
  };
}

const thread: NavigationThreadSummary = {
  id: "thread-density",
  title: "Density row",
  titleSource: "explicit",
  summary: "",
  source: "codex",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
  prs: [pr(1), pr(2, { mergeState: "conflicting" })],
};

function renderRow(
  density: DesktopAppearanceDensity,
  row: NavigationThreadSummary = thread,
  onSetReaction = vi.fn(),
  draftThreadKeys?: Record<string, boolean>,
) {
  return render(
    <ThreadRowDensityContext.Provider value={density}>
      <ThreadRow
        thread={row}
        onOpenContextMenu={vi.fn()}
        onSelectThread={vi.fn()}
        onSetReaction={onSetReaction}
        draftThreadKeys={draftThreadKeys}
      />
    </ThreadRowDensityContext.Provider>,
  );
}

describe("ThreadRow density", () => {
  it("mounts the PR rollup on the title line only in Minimal", () => {
    for (const density of ["mission-control", "compact"] as const) {
      const { container, unmount } = renderRow(density);
      expect(container.querySelector(".thread-row__pr-rollup")).toBeNull();
      unmount();
    }
    const { container } = renderRow("minimal");
    const rollup = container.querySelector(".thread-row__header .thread-row__pr-rollup");
    expect(rollup).toHaveTextContent("2 PRs");
    expect(rollup?.querySelector("[data-pr-rollup]")).toHaveClass("pr-chip--conflicting");
    // The flow keeps its PR chips for X-ray; CSS hides them at rest.
    expect(container.querySelectorAll(".thread-row__chips [data-pr-chip]")).toHaveLength(2);
  });

  it("puts reactions on the title line only in Minimal, before the pin", () => {
    const reacted = { ...thread, reactions: ["\u{1F440}", "\u{1F3C3}"], pinnedRank: "1" };
    for (const density of ["mission-control", "compact"] as const) {
      const { container, unmount } = renderRow(density, reacted);
      expect(container.querySelector(".thread-row__title-reactions")).toBeNull();
      unmount();
    }
    const onSetReaction = vi.fn();
    const { container } = renderRow("minimal", reacted, onSetReaction);
    const titleLine = container.querySelector(".thread-row__actions .thread-row__title-reactions");
    const chips = titleLine?.querySelectorAll(".thread-row__chip--reaction") ?? [];
    expect([...chips].map((chip) => chip.textContent)).toEqual(["\u{1F440}", "\u{1F3C3}"]);
    // Left of the pin, so the PR chip and the time keep their column.
    const pin = container.querySelector(".thread-row__actions .thread-row__pin");
    expect(titleLine?.compareDocumentPosition(pin!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The flow keeps its reaction chips for X-ray; CSS hides them at rest.
    expect(container.querySelectorAll(".thread-row__chips .thread-row__chip--reaction")).toHaveLength(2);

    fireEvent.click(chips[0]!);
    expect(onSetReaction).toHaveBeenCalledWith(reacted, "\u{1F440}", false);
  });

  it("marks an unsent draft with a pencil before the title only in Minimal", () => {
    const drafts = { [threadSummaryIdentityKey(thread)]: true };
    for (const density of ["mission-control", "compact"] as const) {
      const { container, unmount } = renderRow(density, thread, vi.fn(), drafts);
      expect(container.querySelector(".thread-row__title-draft")).toBeNull();
      unmount();
    }
    const { container } = renderRow("minimal", thread, vi.fn(), drafts);
    const mark = container.querySelector(".thread-row__heading .thread-row__title-draft");
    expect(mark).toHaveAttribute("role", "img");
    expect(mark).toHaveAttribute("aria-label", "Unsent draft");
    expect(mark).toHaveAttribute("data-tooltip", "Unsent draft in this thread");
    const title = container.querySelector(".thread-row__title");
    expect(mark?.compareDocumentPosition(title!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The Draft chip stays in the flow for X-ray but no longer survives
    // Minimal, so a draft holds no second line open.
    const chip = container.querySelector(".thread-row__chips [data-thread-draft]");
    expect(chip).toHaveClass("thread-row__chip--persistent");
    expect(chip).not.toHaveClass("thread-row__chip--essential");
  });
});
