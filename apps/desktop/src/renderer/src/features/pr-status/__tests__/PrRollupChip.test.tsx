import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { placeRowCard, PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function pr(number: number, overrides: Partial<PrSummary> = {}): PrSummary {
  return {
    provider: "github.com",
    number,
    org: "acme",
    repo: "orbit",
    title: `Change ${number}`,
    url: `https://github.com/acme/orbit/pull/${number}`,
    state: "passing",
    checkState: "passing",
    lifecycleState: "open",
    reviewState: "ready_for_review",
    mergeState: "mergeable",
    ...overrides,
  };
}

const passing = pr(10);
const failing = pr(11, { checkState: "failing", state: "failing" });
const merged = pr(12, { lifecycleState: "merged", state: "merged" });

function renderRollup(prs: PrSummary[], onRowClick = vi.fn()) {
  const onOpen = vi.fn();
  const view = render(
    // The row's own click handler: the chip must not reach it.
    <div onClick={onRowClick}>
      <PrRollupChip
        prs={prs}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        onOpen={onOpen}
      />
    </div>,
  );
  return { ...view, onOpen, onRowClick };
}

describe("PrRollupChip", () => {
  it("renders a lone PR as the ordinary chip", () => {
    const { container } = renderRollup([failing]);
    expect(container.querySelector("[data-pr-chip]")).toHaveTextContent("#11");
    expect(container.querySelector("[data-pr-rollup]")).toBeNull();
  });

  it("wears the least ready PR's state and names the count", () => {
    const { container } = renderRollup([passing, merged, failing]);
    const chip = container.querySelector("[data-pr-rollup]")!;
    expect(chip).toHaveTextContent("3 PRs");
    expect(chip).toHaveClass("pr-chip", "pr-chip--failing");
    expect(chip).toHaveAttribute(
      "aria-label",
      "3 pull requests, ready for review · checks failing",
    );
    expect(chip).toHaveAttribute("aria-expanded", "false");
  });

  it("names the only open PR and counts the finished ones", () => {
    const closed = pr(13, { lifecycleState: "closed", state: "closed" });
    const { container } = renderRollup([merged, failing, closed]);
    const chip = container.querySelector("[data-pr-rollup]")!;
    expect(chip.querySelector(".pr-chip__lead")).toHaveTextContent("#11");
    expect(chip.querySelector(".pr-chip__more")).toHaveTextContent("+2");
    expect(chip).toHaveClass("pr-chip--failing");
    expect(chip).toHaveAttribute(
      "aria-label",
      "3 pull requests, #11 open, ready for review · checks failing",
    );
  });

  it("keeps the draft bar under the lead PR", () => {
    const draft = pr(14, { reviewState: "draft" });
    const { container } = renderRollup([draft, merged]);
    expect(container.querySelector(".pr-chip__lead .pr-chip__draft-bar")).not.toBeNull();
  });

  it("uses the lead PR's repository prefix when it needs one", () => {
    render(
      <PrRollupChip
        prs={[failing, merged]}
        repoPrefixedUrls={failing.url}
        threadTitle="Orbit refactor"
        onOpen={vi.fn()}
      />,
    );
    expect(document.querySelector(".pr-chip__lead")).toHaveTextContent("acme/orbit#11");
  });

  it("opens a list of every PR, least ready first, without selecting the row", () => {
    const { container, onOpen, onRowClick } = renderRollup([passing, merged, failing]);
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    fireEvent.click(chip);
    expect(onRowClick).not.toHaveBeenCalled();
    expect(chip).toHaveAttribute("aria-expanded", "true");

    const list = screen.getByRole("group", { name: "Pull requests for Orbit refactor" });
    const rows = within(list).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "#11Change 11ready for review · checks failing",
      "#10Change 10ready for review · checks passing",
      "#12Change 12merged",
    ]);

    fireEvent.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledWith(passing.url);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("adds the behind count to the row of the PR on the thread's branch", () => {
    const onHoverStart = vi.fn();
    const onHoverEnd = vi.fn();
    const { container } = render(
      <PrRollupChip
        prs={[passing, failing]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        branchDrift={{ url: failing.url, baseBranch: "main", behind: 4, ahead: 2 }}
        onHoverStart={onHoverStart}
        onHoverEnd={onHoverEnd}
        onOpen={vi.fn()}
      />,
    );
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    // The row's Git prefetch: this chip sits outside the chips line.
    fireEvent.mouseEnter(chip.parentElement!);
    expect(onHoverStart).toHaveBeenCalledTimes(1);
    fireEvent.mouseLeave(chip.parentElement!);
    expect(onHoverEnd).toHaveBeenCalledTimes(1);

    fireEvent.click(chip);
    const rows = within(screen.getByRole("group")).getAllByRole("button");
    expect(rows.map((row) => row.textContent)).toEqual([
      "#11Change 11ready for review · checks failing · 4 behind main",
      "#10Change 10ready for review · checks passing",
    ]);
    expect(rows[0]).toHaveAccessibleName(
      "Open acme/orbit#11, Change 11 (ready for review · checks failing · 4 behind main) in browser",
    );
  });

  it("shows a row's PR card beside the list on hover, and swaps it between rows", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, merged, failing]);
    fireEvent.click(container.querySelector<HTMLElement>("[data-pr-rollup]")!);
    const list = screen.getByRole("group");
    const rows = within(list).getAllByRole("button");

    // The first card waits out the tooltip delay.
    fireEvent.mouseEnter(rows[0]!);
    expect(screen.queryByRole("tooltip")).toBeNull();
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const card = screen.getByRole("tooltip");
    expect(card).toHaveClass("pr-status-card");
    expect(card).toHaveTextContent("Change 11");
    expect(card).toHaveTextContent("acme/orbit#11");
    expect(rows[0]).toHaveAttribute("aria-describedby", card.id);

    // Another row swaps the card at once.
    fireEvent.mouseEnter(rows[2]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("acme/orbit#12");
    expect(rows[0]).not.toHaveAttribute("aria-describedby");

    fireEvent.mouseLeave(list);
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("shows a focused row's card at once, with the branch drift for its PR", () => {
    const { container } = render(
      <PrRollupChip
        prs={[passing, failing]}
        repoPrefixedUrls=""
        threadTitle="Orbit refactor"
        branchDrift={{ url: failing.url, baseBranch: "main", behind: 4, ahead: 2 }}
        onOpen={vi.fn()}
      />,
    );
    fireEvent.keyDown(container.querySelector<HTMLElement>("[data-pr-rollup]")!, { key: "Enter" });
    const rows = within(screen.getByRole("group")).getAllByRole("button");
    fireEvent.focus(rows[0]!);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Behind main4 commits");
    fireEvent.blur(rows[0]!);
    fireEvent.focus(rows[1]!);
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("Local branch");

    fireEvent.keyDown(rows[1]!, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("peeks on hover and closes after the pointer leaves both chip and list", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, failing]);
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    fireEvent.mouseEnter(chip);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const list = screen.getByRole("group");

    // Crossing from the chip into the list keeps it open.
    fireEvent.mouseLeave(chip);
    fireEvent.mouseEnter(list);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.getByRole("group")).toBeInTheDocument();

    fireEvent.mouseLeave(list);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("opens from the keyboard, moves with the arrows, and closes on Escape", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, failing, merged]);
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
    act(() => vi.advanceTimersToNextFrame());
    const rows = within(screen.getByRole("group")).getAllByRole("button");
    expect(rows[0]).toHaveFocus();

    fireEvent.keyDown(rows[0]!, { key: "ArrowUp" });
    expect(rows[2]).toHaveFocus();

    fireEvent.keyDown(rows[2]!, { key: "Escape" });
    expect(screen.queryByRole("group")).toBeNull();
    expect(chip).toHaveFocus();
  });

  it("hands focus back to the chip when Tab leaves the list", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, failing]);
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    chip.focus();
    fireEvent.keyDown(chip, { key: "Enter" });
    act(() => vi.advanceTimersToNextFrame());
    const rows = within(screen.getByRole("group")).getAllByRole("button");

    // Tab continues from the chip, not from <body> after the list unmounts.
    const tab = fireEvent.keyDown(rows[1]!, { key: "Tab" });
    expect(tab).toBe(true);
    expect(screen.queryByRole("group")).toBeNull();
    expect(chip).toHaveFocus();

    fireEvent.keyDown(chip, { key: "Enter" });
    act(() => vi.advanceTimersToNextFrame());
    const first = within(screen.getByRole("group")).getAllByRole("button")[0]!;
    // Shift+Tab stops on the chip itself.
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(chip).toHaveFocus();
  });
});

describe("placeRowCard", () => {
  // A 340px list at the sidebar's left edge, rows from y=120.
  const list = { top: 100, right: 356, bottom: 260, left: 16 };
  const card = { rowTop: 160, width: 272, height: 300 };

  it("sits right of the list, level with the row", () => {
    expect(placeRowCard({ ...card, list, viewport: { width: 1200, height: 900 } }))
      .toEqual({ top: 160, left: 362 });
  });

  it("flips left of the list when the window has no room on the right", () => {
    const rightList = { top: 100, right: 1180, bottom: 260, left: 840 };
    expect(placeRowCard({ ...card, list: rightList, viewport: { width: 1200, height: 900 } }))
      .toEqual({ top: 160, left: 562 });
  });

  it("keeps the card on screen when the row is near the bottom", () => {
    expect(placeRowCard({ ...card, rowTop: 800, list, viewport: { width: 1200, height: 900 } }).top)
      .toBe(592);
  });

  it("goes below, then above, the list before overlapping it in a narrow window", () => {
    expect(placeRowCard({ ...card, list, viewport: { width: 600, height: 900 } }))
      .toEqual({ top: 266, left: 16 });
    const lowList = { top: 500, right: 356, bottom: 700, left: 16 };
    expect(placeRowCard({ ...card, rowTop: 560, list: lowList, viewport: { width: 600, height: 900 } }))
      .toEqual({ top: 194, left: 16 });
    // No room anywhere: beside the row, clamped on screen.
    expect(placeRowCard({ ...card, list, viewport: { width: 600, height: 400 } }))
      .toEqual({ top: 92, left: 8 });
  });
});
