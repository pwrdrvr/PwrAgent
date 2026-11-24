import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared/contracts/navigation";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
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

// The sidebar's layout: the list at the sidebar's edge, rows 48px tall under
// its heading, and the card beside it, 10px right, taller than the list.
const LIST = { left: 8, right: 348, top: 660 };
const ROWS_TOP = 700;
const ROW_HEIGHT = 48;
const CARD = { left: 358, right: 630, top: 660, bottom: 1130 };
const CHIP_X = 300;

type Point = { x: number; y: number };

function rowCenter(index: number): number {
  return ROWS_TOP + ROW_HEIGHT * index + ROW_HEIGHT / 2;
}

/** The points a pointer passes through on a straight move, about 6px apart. */
function segment(from: Point, to: Point): Point[] {
  const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 6));
  return Array.from({ length: steps }, (_, step) => ({
    x: Math.round(from.x + ((to.x - from.x) * (step + 1)) / steps),
    y: Math.round(from.y + ((to.y - from.y) * (step + 1)) / steps),
  }));
}

/**
 * A move from `from` to `to`, as the browser reports it: `mouseout` naming
 * where the pointer went, then `mouseover` naming where it came from, both
 * at the point it crossed.
 */
function move(from: Element, to: Element, point: Point): void {
  fireEvent.mouseOut(from, { relatedTarget: to, clientX: point.x, clientY: point.y });
  fireEvent.mouseOver(to, { relatedTarget: from, clientX: point.x, clientY: point.y });
}

/**
 * Where the pointer goes after it leaves the hovered row's chip.
 * - aim: straight to a point inside the card, across any rows in between.
 * - stop: toward the card, but it comes to rest on another row.
 * - sweep: straight up or down to another row.
 * - away: diagonally to another row, away from the card.
 * - pass: toward the card across the rows below, coming to rest in the
 *   list's footer, on no row.
 * - return: into the card level with another row, then straight back
 *   into that row.
 */
const scenario = fc.oneof(
  fc.record({
    kind: fc.constant("aim" as const),
    x: fc.integer({ min: CARD.left + 12, max: CARD.right - 12 }),
    y: fc.integer({ min: CARD.top + 10, max: CARD.bottom - 10 }),
    // A steep move leaves the list's bottom edge and crosses the sidebar
    // under it, where only the 300 ms grace holds the card (the card-path
    // test owns that rule). At 6px per 10ms, the longest such crossing here
    // takes 270 ms.
    pace: fc.integer({ min: 4, max: 10 }),
  }),
  fc.record({
    kind: fc.constantFrom("stop" as const, "sweep" as const, "away" as const, "pass" as const, "return" as const),
    other: fc.nat(),
    pace: fc.integer({ min: 4, max: 30 }),
  }),
);

describe("PR rollup card aim", () => {
  // Model: while the pointer heads for the open card, rows it crosses on the
  // way are not destinations, so the card it reaches is still the one it
  // left, and one it crossed and then left never takes it. A row it stops
  // on, or reaches moving up, down, away from the card or back from it,
  // takes the card, as it always has.
  it("keeps the card a pointer is heading for, and swaps it for the row the pointer settles on", () => {
    vi.useFakeTimers();
    fc.assert(fc.property(
      fc.integer({ min: 2, max: 4 }),
      fc.nat(),
      scenario,
      (count, pick, path) => {
        const listBottom = ROWS_TOP + ROW_HEIGHT * count + 40;
        vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
          if (this.classList.contains("pr-rollup-popover")) {
            return new DOMRect(LIST.left, LIST.top, LIST.right - LIST.left, listBottom - LIST.top);
          }
          if (this.classList.contains("pr-status-card")) {
            return new DOMRect(CARD.left, CARD.top, CARD.right - CARD.left, CARD.bottom - CARD.top);
          }
          return new DOMRect(LIST.left, ROWS_TOP, LIST.right - LIST.left, ROW_HEIGHT);
        });
        const prs = Array.from({ length: count }, (_, index) => pr(10 + index));
        const { container } = render(
          <>
            <div data-testid="sidebar">Other threads</div>
            <PrRollupChip prs={prs} repoPrefixedUrls="" threadTitle="Orbit refactor" onOpen={vi.fn()} />
          </>,
        );
        try {
          const sidebar = screen.getByTestId("sidebar");
          fireEvent.click(container.querySelector<HTMLElement>("[data-pr-rollup]")!);
          const list = screen.getByRole("group");
          const items = [...list.querySelectorAll<HTMLElement>(".pr-rollup-popover__item")];
          const numberOf = (index: number) =>
            /#(\d+)/.exec(items[index]!.querySelector(".pr-chip__label")!.textContent ?? "")![1];
          const from = pick % count;
          const start = { x: CHIP_X, y: rowCenter(from) };
          const startElement = items[from]!.querySelector(".pr-chip__label")!;

          move(list, startElement, start);
          fireEvent.mouseMove(startElement, { clientX: start.x, clientY: start.y });
          act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
          const card = screen.getByRole("tooltip");
          expect(card).toHaveTextContent(`acme/orbit#${numberOf(from)}`);
          const bridge = card.querySelector(".tooltip-hover-bridge")!;

          // What is under each point, as the layout above draws it.
          const hit = (point: Point): Element => {
            if (point.x >= CARD.left && point.x <= CARD.right && point.y >= CARD.top && point.y <= CARD.bottom) {
              return card;
            }
            if (point.x >= LIST.right && point.x < CARD.left && point.y >= CARD.top && point.y <= CARD.bottom) {
              return bridge;
            }
            if (point.x >= LIST.left && point.x < LIST.right && point.y >= LIST.top && point.y < listBottom) {
              const row = Math.floor((point.y - ROWS_TOP) / ROW_HEIGHT);
              if (point.y < ROWS_TOP || row >= count) return list;
              return row === from ? startElement : items[row]!.querySelector(".pr-rollup-popover__title")!;
            }
            return sidebar;
          };

          const other = path.kind === "aim" || path.kind === "pass"
            ? from
            : (from + 1 + (path.other % (count - 1))) % count;
          const legs: Point[] = path.kind === "aim"
            ? [{ x: path.x, y: path.y }]
            : path.kind === "stop"
              ? [{ x: LIST.right - 8, y: rowCenter(other) }]
              : path.kind === "sweep"
                ? [{ x: CHIP_X, y: rowCenter(other) }]
                : path.kind === "away"
                  ? [{ x: LIST.left + 30, y: rowCenter(other) }]
                  : path.kind === "pass"
                    ? [{ x: LIST.right - 8, y: ROWS_TOP + ROW_HEIGHT * count + 20 }]
                    : [{ x: CARD.left + 20, y: rowCenter(other) }, { x: CHIP_X, y: rowCenter(other) }];
          let current: Element = startElement;
          let position = start;
          // What the card showed as the pointer entered `other` on the last leg.
          let swappedOnEntry: string | undefined;
          for (const [leg, waypoint] of legs.entries()) {
            for (const point of segment(position, waypoint)) {
              const under = hit(point);
              if (under !== current) {
                move(current, under, point);
                current = under;
                if (
                  leg === legs.length - 1
                  && under.closest(".pr-rollup-popover__item") === items[other]
                  && swappedOnEntry === undefined
                ) {
                  swappedOnEntry = screen.getByRole("tooltip").textContent ?? "";
                }
              }
              fireEvent.mouseMove(under, { clientX: point.x, clientY: point.y });
              act(() => vi.advanceTimersByTime(path.pace));
            }
            position = waypoint;
          }

          if (path.kind === "aim") {
            expect(current).toBe(card);
            expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${numberOf(from)}`);
          } else if (path.kind === "sweep" || path.kind === "away" || path.kind === "return") {
            // At once: the swap happened as the pointer entered the row.
            expect(swappedOnEntry).toContain(`acme/orbit#${numberOf(other)}`);
          }
          act(() => vi.advanceTimersByTime(1000));
          const settled = path.kind === "aim" || path.kind === "pass" ? from : other;
          expect(screen.getByRole("tooltip")).toHaveTextContent(`acme/orbit#${numberOf(settled)}`);
        } finally {
          cleanup();
          vi.restoreAllMocks();
        }
      },
    ), { numRuns: 60 });
  });
});
