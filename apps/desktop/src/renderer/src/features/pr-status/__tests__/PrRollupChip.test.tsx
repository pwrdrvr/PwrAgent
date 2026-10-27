import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(rows[2]).toHaveAttribute("aria-describedby", card.id);

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

  it("cancels the first card when the pointer leaves or the list scrolls", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, failing]);
    fireEvent.click(container.querySelector<HTMLElement>("[data-pr-rollup]")!);
    const list = screen.getByRole("group");
    const row = within(list).getAllByRole("button")[0]!;
    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS - 1));
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.mouseLeave(list);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(row).not.toHaveAttribute("aria-describedby");

    fireEvent.mouseEnter(row);
    fireEvent.scroll(within(list).getByRole("list"));
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(row);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.getByRole("tooltip")).toBeInTheDocument();
    fireEvent.scroll(within(list).getByRole("list"));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(row).not.toHaveAttribute("aria-describedby");
  });

  it("cancels a pending card when the list closes", () => {
    vi.useFakeTimers();
    const { container } = renderRollup([passing, failing]);
    const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
    fireEvent.click(chip);
    fireEvent.mouseEnter(within(screen.getByRole("group")).getAllByRole("button")[0]!);
    fireEvent.click(chip);
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("updates an open card from live PR and branch drift data", () => {
    const props = {
      prs: [passing, failing],
      repoPrefixedUrls: "",
      threadTitle: "Orbit refactor",
      branchDrift: { url: failing.url, baseBranch: "main", behind: 4, ahead: 2 },
      onOpen: vi.fn(),
    };
    const { container, rerender } = render(<PrRollupChip {...props} />);
    fireEvent.click(container.querySelector<HTMLElement>("[data-pr-rollup]")!);
    const row = within(screen.getByRole("group")).getAllByRole("button")[0]!;
    fireEvent.focus(row);
    const cardId = screen.getByRole("tooltip").id;
    rerender(<PrRollupChip {...props}
      prs={[passing, { ...failing, title: "Updated change" }]}
      branchDrift={{ ...props.branchDrift, behind: 6 }}
    />);
    expect(screen.getByRole("tooltip")).toHaveTextContent("Updated change");
    expect(screen.getByRole("tooltip")).toHaveTextContent("Behind main6 commits");
    expect(row).toHaveAttribute("aria-describedby", cardId);
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
