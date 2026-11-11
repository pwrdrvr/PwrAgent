import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrChip } from "../PrChip";

const copyText = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("../../../lib/copy-text", () => ({ copyText }));

function pr(number: number): PrSummary {
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
  };
}

const SIDEBAR = { left: 0, right: 320 };
/** Where the card lands: beside the sidebar, or (narrow window) over it. */
let cardLeft = 330;

function rect(left: number, right: number, top = 100, bottom = 120): DOMRect {
  return {
    left, right, top, bottom, x: left, y: top,
    width: right - left, height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  cardLeft = 330;
  vi.useFakeTimers();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("sidebar")) return rect(SIDEBAR.left, SIDEBAR.right, 0, 900);
    if (this.classList.contains("pr-status-card")) return rect(cardLeft, cardLeft + 272, 100, 300);
    return rect(200, 260);
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  copyText.mockClear();
});

function renderSidebar(onDetach = vi.fn()) {
  render(
    <aside className="sidebar">
      {[11, 12].map((number) => (
        <PrChip
          key={number}
          pr={pr(number)}
          showRepoPrefix={false}
          onOpen={vi.fn()}
          onDetach={onDetach}
          cardActions
        />
      ))}
    </aside>,
  );
  const chip = (number: number) =>
    screen.getByRole("button", { name: new RegExp(`Open acme/orbit#${number} `) });
  return { chip, onDetach };
}

function hoverUntilCard(chip: HTMLElement): HTMLElement {
  fireEvent.mouseEnter(chip);
  act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
  return screen.getByRole("tooltip");
}

describe("PrChip sidebar card", () => {
  it("bridges the pointer from the chip to the card and holds it there", () => {
    const { chip } = renderSidebar();
    const card = hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS - 1));
    expect(screen.getByRole("tooltip")).toBe(card);

    fireEvent.mouseEnter(card);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 3));
    expect(screen.getByRole("tooltip")).toBe(card);

    // Leaving the card bridges too, then closes.
    fireEvent.mouseLeave(card);
    expect(screen.getByRole("tooltip")).toBe(card);
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("swaps at once from a card to another chip", () => {
    const { chip } = renderSidebar();
    const card = hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    fireEvent.mouseEnter(card);
    fireEvent.mouseLeave(card);
    fireEvent.mouseEnter(chip(12));
    const cards = screen.getAllByRole("tooltip");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Change 12");
  });

  it("keeps presses inside the card from reaching the row", () => {
    const onRowClick = vi.fn();
    const onRowPointerDown = vi.fn();
    render(
      <aside className="sidebar">
        <div onClick={onRowClick} onPointerDown={onRowPointerDown} onDoubleClick={onRowClick}>
          <PrChip pr={pr(11)} showRepoPrefix={false} onOpen={vi.fn()} cardActions />
        </div>
      </aside>,
    );
    const card = hoverUntilCard(screen.getByRole("button", { name: /Open acme\/orbit#11 / }));
    const title = within(card).getByText("Change 11");
    fireEvent.pointerDown(title);
    fireEvent.click(title);
    fireEvent.doubleClick(title);
    expect(onRowPointerDown).not.toHaveBeenCalled();
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it("closes the card when the bridge runs out", () => {
    const { chip } = renderSidebar();
    hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("swaps to the next chip's card at once during a sweep", () => {
    const { chip } = renderSidebar();
    hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    fireEvent.mouseEnter(chip(12));
    // No hover delay, and only the new card.
    const cards = screen.getAllByRole("tooltip");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("Change 12");
  });

  it("closes at once when the card had to open over the rows", () => {
    cardLeft = 100;
    const { chip } = renderSidebar();
    hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("detaches and copies from the card's footer", () => {
    const { chip, onDetach } = renderSidebar();
    let card = hoverUntilCard(chip(11));
    fireEvent.mouseLeave(chip(11));
    fireEvent.mouseEnter(card);
    const copy = within(card).getByRole("button", { name: "Copy URL", hidden: true });
    // A press inside the card is not an outside press.
    fireEvent.pointerDown(copy);
    expect(screen.getByRole("tooltip")).toBe(card);
    fireEvent.click(copy);
    expect(copyText).toHaveBeenCalledExactlyOnceWith(pr(11).url);
    expect(screen.queryByRole("tooltip")).toBeNull();

    card = hoverUntilCard(chip(12));
    fireEvent.click(within(card).getByRole("button", { name: "Detach", hidden: true }));
    expect(onDetach).toHaveBeenCalledExactlyOnceWith(pr(12));
    expect(screen.queryByRole("tooltip")).toBeNull();
    // The detach warning returns focus to the chip, not a removed button.
    expect(chip(12)).toHaveFocus();
  });

  it("keeps the footer out of the Tab order and the chip's description", () => {
    const { chip } = renderSidebar();
    const card = hoverUntilCard(chip(11));
    expect(within(card).queryAllByRole("button")).toHaveLength(0);
    for (const button of within(card).getAllByRole("button", { hidden: true })) {
      expect(button).toHaveAttribute("tabindex", "-1");
    }
  });
});
