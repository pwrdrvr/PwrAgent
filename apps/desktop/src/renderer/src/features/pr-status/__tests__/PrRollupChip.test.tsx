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
    expect(chip).toHaveAttribute("aria-label", "3 pull requests, checks failing");
    expect(chip).toHaveAttribute("aria-expanded", "false");
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
});
