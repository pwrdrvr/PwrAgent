import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResourceCheckoutsSnapshot } from "@pwragent/shared/contracts/resource-checkouts";
import { ResourcesScreen } from "../ResourcesScreen";
import type { ResourceCheckoutsSource } from "../resource-checkouts-source";
import { USAGE_BUCKET_MS, usageChart } from "../resource-usage";
import { formatAge } from "../resource-view-model";
import { buildPreviewSnapshot } from "../preview/resource-checkouts-preview";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const MIN = 60_000;
const RENDERER_START = Date.UTC(2026, 10, 21, 15, 0, 7);
const RESOURCE = "studio-m4 compute";

function staticSource(snapshot: ResourceCheckoutsSnapshot): ResourceCheckoutsSource {
  return {
    origin: "live",
    read: async () => snapshot,
    subscribe: () => () => undefined,
    perform: async () => ({ outcome: "unknown", message: "not under test" }),
  };
}

function inspector(): HTMLElement {
  return document.querySelector(".resources-inspector") as HTMLElement;
}

/** "just now" under a minute, else "4m ago", as the chart prints ages. */
function ago(at: number, now: number): string {
  const age = formatAge(at, now);
  return age === "now" ? "just now" : `${age} ago`;
}

/**
 * Rule (resource-checkouts-ui.md, Usage history): usage points and the
 * snapshot's `observedAt` are stamped by the serving process's clock, and the
 * last point holds until now on that clock. Main's clock never steps back,
 * so after the wall clock does it runs ahead of the renderer's `Date.now()`.
 * With main ahead by any Δ, an idle chart (no new points, no new revision)
 * still advances one bar per 30 seconds of elapsed time, and the readout's
 * ages are measured on the points' clock: what `usageChart` draws at main's
 * own now.
 */
describe("ResourcesScreen usage chart clock", () => {
  it("draws an idle chart on the snapshot's clock whatever the renderer's clock says", async () => {
    await fc.assert(
      fc.asyncProperty(
        // How far main's clock runs ahead of the renderer's.
        fc.integer({ min: 0, max: 2 * 60 * MIN }),
        // Age of the newest point on main's clock when the snapshot is read.
        fc.integer({ min: 0, max: 10 * MIN }),
        // How long before the newest point recording began.
        fc.integer({ min: 0, max: 8 * MIN }),
        // 30-second ticks that pass with no new revision.
        fc.integer({ min: 1, max: 20 }),
        // The bar pointed at, counted back from the newest.
        fc.integer({ min: 1, max: 59 }),
        async (ahead, newestAge, recordedBefore, ticks, back) => {
          vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
          vi.setSystemTime(RENDERER_START);
          const mainAtRead = RENDERER_START + ahead;
          const newest = mainAtRead - newestAge;
          const snapshot = buildPreviewSnapshot(mainAtRead);
          snapshot.resources = snapshot.resources.map((resource) => resource.displayName === RESOURCE
            ? { ...resource, usage: { observedSince: newest - recordedBefore, points: [{ at: newest, held: 2, waiting: 1 }] } }
            : resource);
          const resource = snapshot.resources.find((candidate) => candidate.displayName === RESOURCE)!;
          const view = render(<ResourcesScreen source={staticSource(snapshot)} onClose={() => undefined} onOpenThread={() => undefined} />);
          try {
            await act(async () => {});
            const title = screen.getAllByText(RESOURCE).find((node) => node.classList.contains("resources-row__title"))!;
            fireEvent.click(within(title.closest("li") as HTMLElement).getByRole("button", { name: new RegExp(`^${RESOURCE}`) }));
            act(() => {
              vi.advanceTimersByTime(ticks * USAGE_BUCKET_MS);
            });

            // The oracle: the chart drawn at main's own now.
            const mainNow = mainAtRead + ticks * USAGE_BUCKET_MS;
            const expected = usageChart(resource, mainNow)!;
            const count = expected.bars.length;
            const plot = within(inspector()).getByTestId("resources-usage-plot");

            // One bar per 30 seconds: recording's start sits where main's
            // clock puts it, so the leading not-recorded run has shrunk by one
            // bar per elapsed tick.
            const firstObserved = expected.bars.findIndex((bar) => bar.observed);
            const leading = plot.querySelector(".resources-usage__unobserved");
            expect(leading?.getAttribute("x1") === "0" ? Number(leading.getAttribute("x2")) / 5 : 0).toBe(firstObserved);
            if (expected.observedSince !== undefined) {
              expect(within(inspector()).getByText(/^Recording began/)).toHaveTextContent(
                `Recording began ${ago(expected.observedSince, mainNow)}, when PwrAgent started watching.`,
              );
            }

            // The readout ages a pointed bar on the same clock.
            plot.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 60, right: 300, bottom: 60, x: 0, y: 0, toJSON: () => ({}) });
            const index = count - 1 - back;
            fireEvent.pointerMove(plot, { clientX: (300 * (index + 0.5)) / count });
            const shown = expected.bars[index];
            const readout = within(inspector()).getByTestId("resources-usage-readout");
            expect(readout.querySelector(".resources-usage__when")).toHaveTextContent(ago(shown.endAt, mainNow));
            expect(readout).toHaveTextContent(shown.observed ? `${shown.held} held` : "Not recorded");
          } finally {
            view.unmount();
            vi.useRealTimers();
          }
        },
      ),
      { numRuns: 25 },
    );
  });

  it("keeps sliding an idle chart when main runs ten minutes ahead", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    vi.setSystemTime(RENDERER_START);
    const mainAtRead = RENDERER_START + 10 * MIN;
    const snapshot = buildPreviewSnapshot(mainAtRead);
    snapshot.resources = snapshot.resources.map((resource) => resource.displayName === RESOURCE
      ? { ...resource, usage: { observedSince: mainAtRead - 5 * MIN, points: [{ at: mainAtRead, held: 2, waiting: 1 }] } }
      : resource);
    render(<ResourcesScreen source={staticSource(snapshot)} onClose={() => undefined} onOpenThread={() => undefined} />);
    await act(async () => {});
    const title = screen.getAllByText(RESOURCE).find((node) => node.classList.contains("resources-row__title"))!;
    fireEvent.click(within(title.closest("li") as HTMLElement).getByRole("button", { name: new RegExp(`^${RESOURCE}`) }));
    const leadingBars = () => Number(
      within(inspector()).getByTestId("resources-usage-plot").querySelector(".resources-usage__unobserved")?.getAttribute("x2"),
    ) / 5;
    const before = leadingBars();
    act(() => {
      vi.advanceTimersByTime(4 * USAGE_BUCKET_MS);
    });
    // Two minutes passed on both clocks: recording's start is four bars
    // further back. The renderer's clock is still behind the newest point.
    expect(leadingBars()).toBe(before - 4);
  });
});
