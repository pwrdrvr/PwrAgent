import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

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
    reviewState: "ready_for_review",
    mergeState: "mergeable",
  };
}

// The list at the sidebar's edge, its card beside it with a 10px gap: the
// layout the sidebar draws when the window is wide enough.
function mockBesideLayout(): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains("pr-rollup-popover")) return new DOMRect(8, 660, 340, 170);
    if (this.classList.contains("pr-status-card")) return new DOMRect(358, 660, 272, 470);
    return new DOMRect(8, 740, 330, 40);
  });
}

/**
 * The pointer moves from `from` to `to`, as the browser reports it: a
 * `mouseout` naming where it went, then a `mouseover` naming where it came
 * from. React derives enter and leave for every box in between from the
 * pair, so a move inside the row's `<li>` does not re-enter the row.
 */
function move(from: Element, to: Element): void {
  fireEvent.mouseOut(from, { relatedTarget: to });
  fireEvent.mouseOver(to, { relatedTarget: from });
}

/** A pointer route from a row's chip toward its card, or to a stop short of it. */
const route = fc.record({
  // Straight across, the row's own ✕ lies between its number and the card.
  throughDetach: fc.boolean(),
  // Diagonally down toward the card's footer (Squash merge, Copy URL,
  // Detach), Detach all lies in the way.
  throughDetachAll: fc.boolean(),
  // Below the list's corner, the pointer crosses the sidebar before the
  // bridge beside the list.
  belowList: fc.boolean(),
  // Each hop's time; a whole crossing stays inside the grace.
  dwell: fc.array(fc.integer({ min: 0, max: 40 }), { minLength: 8, maxLength: 8 }),
});

describe("PR rollup card reachability", () => {
  // Oracle: a row's card is enterable, and the controls between the row's
  // chip and the card are on the way to it, not destinations. Crossing them
  // within the hover grace reaches that row's card, which then stays.
  it("reaches a row's card from its chip across the ✕, Detach all, and the gap", () => {
    vi.useFakeTimers();
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 4 }),
      fc.nat(),
      fc.boolean(),
      route,
      (count, pick, pinned, path) => {
        mockBesideLayout();
        const prs = Array.from({ length: count }, (_, index) => pr(10 + index));
        const { container } = render(
          <>
            <div data-testid="sidebar">Other threads</div>
            <PrRollupChip
              prs={prs}
              repoPrefixedUrls=""
              threadTitle="Orbit refactor"
              onOpen={vi.fn()}
              onDetach={vi.fn()}
              onDetachAll={vi.fn()}
            />
          </>,
        );
        try {
          const sidebar = screen.getByTestId("sidebar");
          const trigger = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
          if (pinned) {
            fireEvent.click(trigger);
          } else {
            move(sidebar, trigger);
            act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
            move(trigger, sidebar);
            move(sidebar, screen.getByRole("group"));
          }
          const list = screen.getByRole("group");
          const items = list.querySelectorAll<HTMLElement>(".pr-rollup-popover__item");
          const item = items[pick % items.length]!;
          const hovered = item.querySelector(".pr-rollup-popover__chip .pr-chip__label")!;
          const target = /#(\d+)/.exec(hovered.textContent ?? "")![1];

          move(list, hovered);
          act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
          const card = screen.getByRole("tooltip");
          expect(card).toHaveTextContent(`acme/orbit#${target}`);
          const bridge = card.querySelector(".tooltip-hover-bridge")!;

          const hops: Element[] = [hovered];
          if (path.throughDetach) hops.push(item.querySelector(".pr-chip__detach")!);
          hops.push(list);
          if (path.throughDetachAll) {
            hops.push(within(list).getByRole("button", { name: "Detach all" }), list);
          }
          if (path.belowList) hops.push(sidebar);
          hops.push(bridge, card);
          for (let index = 1; index < hops.length; index += 1) {
            move(hops[index - 1]!, hops[index]!);
            act(() => vi.advanceTimersByTime(path.dwell[index - 1]!));
          }

          expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${target}`);
          act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 2));
          expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${target}`);
          expect(trigger).toHaveAttribute("aria-expanded", "true");
        } finally {
          cleanup();
          vi.restoreAllMocks();
        }
      },
    ), { numRuns: 40 });
  });

  // Model: where the pointer comes to rest decides the card. On its own row,
  // ✕ included, the row's card stays; on another row, that row's card; on
  // Detach all, no card once the grace runs out. The list stays open.
  it("keeps the card that belongs to where the pointer rests", () => {
    vi.useFakeTimers();
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 4 }),
      fc.nat(),
      fc.nat(),
      fc.constantFrom("detach", "detach-all", "other-row"),
      (count, pick, otherPick, rest) => {
        mockBesideLayout();
        const prs = Array.from({ length: count }, (_, index) => pr(10 + index));
        const { container } = render(
          <PrRollupChip
            prs={prs}
            repoPrefixedUrls=""
            threadTitle="Orbit refactor"
            onOpen={vi.fn()}
            onDetach={vi.fn()}
            onDetachAll={vi.fn()}
          />,
        );
        try {
          const trigger = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
          fireEvent.click(trigger);
          const list = screen.getByRole("group");
          const items = [...list.querySelectorAll<HTMLElement>(".pr-rollup-popover__item")];
          const index = pick % items.length;
          const item = items[index]!;
          const other = items[(index + 1 + (otherPick % (items.length - 1))) % items.length]!;
          const numberOf = (row: HTMLElement) =>
            /#(\d+)/.exec(row.querySelector(".pr-chip__label")!.textContent ?? "")![1];
          const hovered = item.querySelector(".pr-rollup-popover__chip .pr-chip__label")!;

          move(list, hovered);
          act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
          expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${numberOf(item)}`);

          const stop = rest === "detach"
            ? item.querySelector(".pr-chip__detach")!
            : rest === "detach-all"
              ? within(list).getByRole("button", { name: "Detach all" })
              : other.querySelector(".pr-rollup-popover__title")!;
          if (rest === "detach") {
            move(hovered, stop);
          } else {
            move(hovered, list);
            move(list, stop);
          }
          act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS * 2));

          const expected = rest === "detach"
            ? numberOf(item)
            : rest === "other-row" ? numberOf(other) : undefined;
          if (expected) {
            expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${expected}`);
          } else {
            expect(screen.queryByRole("tooltip")).toBeNull();
          }
          expect(trigger).toHaveAttribute("aria-expanded", "true");
        } finally {
          cleanup();
          vi.restoreAllMocks();
        }
      },
    ), { numRuns: 40 });
  });
});
