import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrSummary } from "@pwragent/shared";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrRollupChip } from "../PrRollupChip";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const prs: PrSummary[] = [10, 11].map((number) => ({
  provider: "github.com",
  org: "acme",
  repo: "orbit",
  number,
  title: `Change ${number}`,
  url: `https://github.com/acme/orbit/pull/${number}`,
  state: "passing",
  checkState: "passing",
  lifecycleState: "open",
}));

const update = fc.constantFrom("transcript", "pricing", "pr", "list");
const dismissal = fc.constantFrom("sidebar", "shell", "document", "resize", "outside", "escape");

describe("PR rollup lifetime", () => {
  // The DOM is the placement oracle: only scrolling the chip's ancestry can
  // move it. Updates and scrolls in sibling panes must preserve the same open
  // surface, whether it was opened by hovering or pinned by clicking.
  it("preserves an open list across pane updates until its placement or interaction is dismissed", () => {
    vi.useFakeTimers();
    fc.assert(fc.property(
      fc.boolean(),
      fc.array(update, { minLength: 1, maxLength: 8 }),
      dismissal,
      (pinned, updates, dismiss) => {
        let revision = 0;
        const onOpen = vi.fn();
        const scene = () => (
          <div data-testid="shell">
            <aside data-testid="sidebar">
              <div><PrRollupChip
                prs={prs.map((pr) => ({ ...pr, title: `${pr.title}, revision ${revision}` }))}
                threadTitle="Orbit refactor"
                repoPrefixedUrls=""
                onOpen={onOpen}
              /></div>
            </aside>
            <main data-testid="transcript">Streamed update {revision}</main>
            <section data-testid="pricing">Usage {revision}</section>
          </div>
        );
        const { container, rerender } = render(scene());
        try {
          const chip = container.querySelector<HTMLElement>("[data-pr-rollup]")!;
          if (pinned) {
            fireEvent.click(chip);
          } else {
            fireEvent.mouseEnter(chip);
            act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
          }
          const list = screen.getByRole("group");
          for (const operation of updates) {
            revision += 1;
            rerender(scene());
            if (operation === "list") {
              fireEvent.scroll(within(list).getByRole("list"));
            } else if (operation !== "pr") {
              fireEvent.scroll(screen.getByTestId(operation));
            }
            expect(container.querySelector("[data-pr-rollup]")).toBe(chip);
            expect(screen.getByRole("group")).toBe(list);
            expect(chip).toHaveAttribute("aria-expanded", "true");
            expect(list).toHaveTextContent(`revision ${revision}`);
          }

          if (dismiss === "resize") fireEvent.resize(window);
          else if (dismiss === "outside") fireEvent.pointerDown(screen.getByTestId("transcript"));
          else if (dismiss === "escape") fireEvent.keyDown(chip, { key: "Escape" });
          else if (dismiss === "document") fireEvent.scroll(document);
          else fireEvent.scroll(screen.getByTestId(dismiss));
          expect(screen.queryByRole("group")).toBeNull();
          expect(chip).toHaveAttribute("aria-expanded", "false");
          expect(onOpen).not.toHaveBeenCalled();
        } finally {
          cleanup();
        }
      },
    ), { numRuns: 25 });
  });
});
