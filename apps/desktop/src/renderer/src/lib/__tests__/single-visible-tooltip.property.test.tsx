import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it } from "vitest";
import { DataTooltipLayer } from "../DataTooltipLayer";
import { useViewportTooltip, type ViewportTooltip } from "../useViewportTooltip";

afterEach(() => {
  cleanup();
});

type PlainId = "data" | "a" | "b";

type Command =
  | { kind: "hover-data" }
  | { kind: "leave-data" }
  | { kind: "show"; id: "a" | "b" }
  | { kind: "hide"; id: "a" | "b" }
  | { kind: "show-card" }
  | { kind: "hide-card" };

const tooltips: Partial<Record<"a" | "b" | "card", ViewportTooltip>> = {};

function Surface({ id, className }: { id: "a" | "b"; className: string }) {
  const tooltip = useViewportTooltip({ className });
  tooltips[id] = tooltip;
  return (
    <>
      <button type="button">{`Trigger ${id}`}</button>
      {tooltip.tooltipNode}
    </>
  );
}

// An enterable hover card keeps its own lifecycle (`hover-card-bridge.ts`):
// a plain tooltip neither closes it nor is closed by it.
function CardSurface() {
  const tooltip = useViewportTooltip({
    className: "pr-status-card",
    interactive: { onPointerEnter: () => {}, onPointerLeave: () => {} },
  });
  tooltips.card = tooltip;
  return (
    <>
      <button type="button">Trigger card</button>
      {tooltip.tooltipNode}
    </>
  );
}

function Window() {
  return (
    <>
      <button type="button" className="tooltip-target" data-tooltip="Changes">
        Changes tab
      </button>
      <Surface id="a" className="viewport-tooltip context-rail__tooltip" />
      <Surface id="b" className="viewport-tooltip lens-switch__tooltip" />
      <CardSurface />
      <DataTooltipLayer />
    </>
  );
}

function trigger(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function pointer(type: "pointerover" | "pointerout", target: Element, relatedTarget: Element): void {
  // jsdom has no PointerEvent; the layer only reads `relatedTarget`.
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget }));
}

function plainTooltipsShown(): PlainId[] {
  const shown: PlainId[] = [];
  for (const element of document.querySelectorAll('[role="tooltip"]')) {
    if (element.classList.contains("data-tooltip-layer")) shown.push("data");
    else if (element.classList.contains("context-rail__tooltip")) shown.push("a");
    else if (element.classList.contains("lens-switch__tooltip")) shown.push("b");
  }
  return shown;
}

function cardShown(): boolean {
  return document.querySelector('[role="tooltip"].pr-status-card') !== null;
}

it("hides a data-tooltip when another surface's tooltip opens", () => {
  render(<Window />);
  // The pointer rests on a clicked rail tab...
  act(() => pointer("pointerover", trigger("Changes tab"), document.body));
  expect(screen.getAllByRole("tooltip")).toHaveLength(1);
  // ...while keyboard focus raises a linked directory's rail tooltip.
  act(() => tooltips.a!.show(trigger("Trigger a"), "/Users/me/github/PwrAgnt"));
  expect(screen.getAllByRole("tooltip")).toHaveLength(1);
  expect(screen.getByRole("tooltip")).toHaveTextContent("/Users/me/github/PwrAgnt");
});

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.constant<Command>({ kind: "hover-data" }),
  fc.constant<Command>({ kind: "leave-data" }),
  fc.constantFrom<"a" | "b">("a", "b").map<Command>((id) => ({ kind: "show", id })),
  fc.constantFrom<"a" | "b">("a", "b").map<Command>((id) => ({ kind: "hide", id })),
  fc.constant<Command>({ kind: "show-card" }),
  fc.constant<Command>({ kind: "hide-card" }),
);

// Model: the window holds at most one plain tooltip, the one shown last; hiding
// it leaves none (a hidden tooltip does not come back). The enterable card is
// independent of it.
it("never shows more than one plain tooltip, and it is the one shown last", () => {
  fc.assert(
    fc.property(fc.array(command, { minLength: 1, maxLength: 24 }), (commands) => {
      const view = render(<Window />);
      let active: PlainId | null = null;
      let card = false;
      try {
        // The fixture's buttons stay mounted throughout the command sequence.
        const dataTarget = view.getByText("Changes tab");
        const targets = {
          a: view.getByText("Trigger a"),
          b: view.getByText("Trigger b"),
          card: view.getByText("Trigger card"),
        };
        for (const step of commands) {
          act(() => {
            switch (step.kind) {
              case "hover-data":
                pointer("pointerover", dataTarget, document.body);
                active = "data";
                break;
              case "leave-data":
                pointer("pointerout", dataTarget, document.body);
                if (active === "data") active = null;
                break;
              case "show":
                tooltips[step.id]!.show(targets[step.id], `Tooltip ${step.id}`);
                active = step.id;
                break;
              case "hide":
                tooltips[step.id]!.hide();
                if (active === step.id) active = null;
                break;
              case "show-card":
                tooltips.card!.show(targets.card, "PR #1");
                card = true;
                break;
              case "hide-card":
                tooltips.card!.hide();
                card = false;
                break;
            }
          });
          expect(plainTooltipsShown()).toEqual(active ? [active] : []);
          expect(cardShown()).toBe(card);
        }
      } finally {
        view.unmount();
      }
    }),
    { numRuns: 150 },
  );
});
