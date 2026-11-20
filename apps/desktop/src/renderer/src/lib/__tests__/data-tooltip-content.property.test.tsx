import { act, render } from "@testing-library/react";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { DataTooltipLayer } from "../DataTooltipLayer";
import { RendererUpdateEvent, snapshotRendererUpdates } from "../renderer-update-diagnostics";

type Action = "class" | "same-text" | "change-text" | "close" | "open";

async function exerciseContent(actions: Action[]): Promise<void> {
  const first = "Plan mode — plan the work before making changes";
  const second = "Plan mode is on";
  const screen = render(<>
    <button type="button" className="composer__toggle tooltip-target" data-tooltip={first}>
      Plan mode
    </button>
    <DataTooltipLayer />
  </>);
  const anchor = screen.getByRole("button", { name: "Plan mode" });
  const measure = vi.fn();
  const rect = Element.prototype.getBoundingClientRect;
  const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.getAttribute("role") === "tooltip") measure();
    return rect.call(this);
  });
  let open = false;
  let content = first;
  try {
    for (const action of actions) {
      const previous = snapshotRendererUpdates().counts[RendererUpdateEvent.tooltipUpdate];
      const wasOpen = open;
      measure.mockClear();
      await act(async () => {
        switch (action) {
          case "class":
            anchor.classList.toggle("is-active");
            break;
          case "same-text":
            anchor.setAttribute("data-tooltip", content);
            break;
          case "change-text":
            content = content === first ? second : first;
            anchor.setAttribute("data-tooltip", content);
            break;
          case "close":
            anchor.classList.remove("tooltip-target");
            open = false;
            break;
          case "open":
            if (!open) {
              anchor.classList.add("tooltip-target");
              anchor.dispatchEvent(new MouseEvent("pointerover", {
                bubbles: true, relatedTarget: document.body,
              }));
            }
            open = true;
            break;
        }
      });
      const changed = action === "change-text" && wasOpen;
      expect(snapshotRendererUpdates().counts[RendererUpdateEvent.tooltipUpdate] - previous)
        .toBe(changed ? 1 : 0);
      const budget = open && !wasOpen ? 2 : changed ? 1 : 0;
      expect(measure.mock.calls.length).toBeLessThanOrEqual(budget);
      const tooltip = screen.queryByRole("tooltip");
      expect(tooltip?.textContent).toBe(open ? content : undefined);
      expect(anchor.getAttribute("aria-describedby")).toBe(tooltip?.id ?? null);
    }
  } finally {
    screen.unmount();
    geometry.mockRestore();
  }
}

it("skips placement when a hovered Plan button only changes its active class", async () => {
  await exerciseContent(["open", "class"]);
});

it("updates an open tooltip only for a new label across generated anchor mutations", async () => {
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom<Action>("class", "same-text", "change-text", "close", "open"), {
      minLength: 1, maxLength: 16, size: "max",
    }),
    (actions) => exerciseContent(["open", ...actions, "close"]),
  ), { numRuns: 30 });
});
