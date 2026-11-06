import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrChip } from "../PrChip";
import { PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const update = fc.constantFrom("transcript", "pricing", "pr");
const dismissal = fc.constantFrom("sidebar", "document", "resize", "outside", "escape", "leave");

describe.each(["regular", "single PR rollup"] as const)("%s PR card lifetime", (surface) => {
  // The same anchor-ownership rule as the multi-PR list: sibling streaming
  // cannot move the chip, cancel its delayed hover, or replace its open card.
  it("preserves the live hover card through generated pane updates and dismisses on owned events", () => {
    vi.useFakeTimers();
    fc.assert(fc.property(
      fc.boolean(),
      fc.array(update, { minLength: 1, maxLength: 8 }),
      dismissal,
      (focused, updates, dismiss) => {
        let revision = 0;
        const onOpen = vi.fn();
        const scene = () => {
          const pr: PrSummary = {
            provider: "github.com",
            org: "acme",
            repo: "orbit",
            number: 42,
            url: "https://github.com/acme/orbit/pull/42",
            title: `Change revision ${revision}`,
            additions: revision,
            deletions: 3,
            state: revision % 2 === 0 ? "passing" : "failing",
            checkState: revision % 2 === 0 ? "passing" : "failing",
            lifecycleState: "open",
          };
          return (
            <div>
              <aside data-testid="sidebar">
                {surface === "regular"
                  ? <PrChip pr={pr} showRepoPrefix={false} onOpen={onOpen} />
                  : <PrRollupChip prs={[pr]} threadTitle="Orbit refactor" repoPrefixedUrls="" onOpen={onOpen} />}
              </aside>
              <main data-testid="transcript">Streamed update {revision}</main>
              <section data-testid="pricing">Usage {revision}</section>
            </div>
          );
        };
        const { container, rerender } = render(scene());
        try {
          const chip = container.querySelector<HTMLElement>("[data-pr-chip]")!;
          if (focused) fireEvent.focus(chip);
          else fireEvent.mouseEnter(chip);
          // A transcript can auto-scroll before the hover delay has elapsed.
          fireEvent.scroll(screen.getByTestId("transcript"));
          act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
          const card = screen.getByRole("tooltip");
          for (const operation of updates) {
            revision += 1;
            rerender(scene());
            if (operation !== "pr") fireEvent.scroll(screen.getByTestId(operation));
            expect(container.querySelector("[data-pr-chip]")).toBe(chip);
            expect(screen.getByRole("tooltip")).toBe(card);
            expect(chip).toHaveAttribute("aria-describedby", card.id);
            expect(card).toHaveTextContent(`Change revision ${revision}`);
            expect(card).toHaveTextContent(`+${revision}`);
            expect(card).toHaveTextContent(revision % 2 === 0 ? "checks passing" : "checks failing");
          }

          if (dismiss === "resize") fireEvent.resize(window);
          else if (dismiss === "outside") fireEvent.pointerDown(screen.getByTestId("transcript"));
          else if (dismiss === "escape") fireEvent.keyDown(chip, { key: "Escape" });
          else if (dismiss === "leave") fireEvent.mouseLeave(chip);
          else if (dismiss === "document") fireEvent.scroll(document);
          else fireEvent.scroll(screen.getByTestId(dismiss));
          expect(screen.queryByRole("tooltip")).toBeNull();
          expect(chip).not.toHaveAttribute("aria-describedby");
          expect(onOpen).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });
});
