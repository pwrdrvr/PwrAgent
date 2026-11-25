import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrChipState, PrSummary } from "@pwragent/shared/contracts/navigation";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";
import { TOOLTIP_HOVER_DELAY_MS } from "../../../lib/useViewportTooltip";
import { PrChip } from "../PrChip";

/**
 * Model test for a sidebar PR card while the sidebar keeps changing.
 *
 * A row above the chip gains and loses a chip (a repair that keeps
 * rescheduling flips its "Scheduled" chip every 30 s), which moves the PR chip
 * down and back; scroll anchoring scrolls the lane to compensate; the PR's
 * checks keep updating. The operator meanwhile rests the pointer on the card's
 * footer.
 *
 * The rules:
 *
 * - A card the pointer is inside stays open, whatever the layout does under
 *   it. Only the operator closes it: leaving it, Escape, or a press outside.
 * - A card that is not held closes when its chip moves or its lane scrolls,
 *   as any tooltip does: it no longer points at anything.
 * - Leaving a card whose chip moved while it was held closes it, since the
 *   bridge back to the chip no longer leads there.
 */

const ROW_SHIFT = 24;
const SIDEBAR = { left: 0, right: 320 };

function rect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    left, right, top, bottom, x: left, y: top,
    width: right - left, height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** The chip sits one row lower while the row above carries its extra chip. */
function chipTop(): number {
  return document.querySelector("[data-row-above-chip]") ? 200 + ROW_SHIFT : 200;
}

function mockSidebarGeometry(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("sidebar")) return rect(SIDEBAR.left, SIDEBAR.right, 0, 900);
    if (this.classList.contains("pr-status-card")) return rect(330, 602, 100, 300);
    if (this.hasAttribute("data-pr-chip")) {
      const top = chipTop();
      return rect(200, 260, top, top + 20);
    }
    return rect(0, 0, 0, 0);
  });
  vi.stubGlobal("innerWidth", 1200);
  vi.stubGlobal("innerHeight", 900);
}

/**
 * The browser's native geometry observers, delivered when the test says the
 * layout changed. jsdom has neither, and a sibling row's subtree is outside
 * the anchor's mutation path, so without these the move would go unseen —
 * which is not what Chromium does.
 */
function stubNativeGeometryObservers(): { layoutChanged: () => void } {
  const intersections = new Set<{
    callback: IntersectionObserverCallback;
    observer: IntersectionObserver;
    targets: Set<Element>;
  }>();
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
  });
  vi.stubGlobal("IntersectionObserver", class {
    private readonly entry: {
      callback: IntersectionObserverCallback;
      observer: IntersectionObserver;
      targets: Set<Element>;
    };

    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, observer: this as unknown as IntersectionObserver, targets: new Set() };
      intersections.add(this.entry);
    }

    observe(target: Element): void {
      this.entry.targets.add(target);
    }

    disconnect(): void {
      intersections.delete(this.entry);
    }
  });
  return {
    layoutChanged: () => {
      act(() => {
        for (const { callback, observer, targets } of [...intersections]) {
          callback([...targets].map((target) => ({
            target,
            boundingClientRect: target.getBoundingClientRect(),
            intersectionRatio: 1,
          }) as unknown as IntersectionObserverEntry), observer);
        }
      });
    },
  };
}

function pr(checkState: PrChipState): PrSummary {
  return {
    provider: "github.com",
    number: 4403,
    org: "acme",
    repo: "orbit",
    title: "Wait for the panel's rows",
    url: "https://github.com/acme/orbit/pull/4403",
    state: checkState,
    checkState,
    lifecycleState: "open",
  };
}

function Sidebar(props: { scheduled: boolean; checkState: PrChipState }) {
  return (
    <aside className="sidebar">
      <div className="sidebar-list--dense" data-testid="lane">
        <div className="thread-row">
          <span className="thread-row__chips">
            <span className="thread-row__chip">Claude</span>
            {props.scheduled ? (
              <span className="thread-row__chip" data-row-above-chip="">Scheduled</span>
            ) : null}
          </span>
        </div>
        <div className="thread-row">
          <span className="thread-row__chips">
            <PrChip
              pr={pr(props.checkState)}
              showRepoPrefix={false}
              onOpen={() => {}}
              onDetach={() => {}}
              cardActions
            />
          </span>
        </div>
      </div>
    </aside>
  );
}

type Pointer = "outside" | "chip" | "card";
type Model = { visible: boolean; pointer: Pointer; movedWhileHeld: boolean };
type Real = {
  rerender: (props: { scheduled: boolean; checkState: PrChipState }) => void;
  props: { scheduled: boolean; checkState: PrChipState };
  layoutChanged: () => void;
};

const chip = () => screen.getByRole("button", { name: /Open acme\/orbit#4403 / });
const card = () => screen.queryByRole("tooltip");

async function flushMutations(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

function check(model: Model): void {
  if (model.visible) {
    expect(card()).not.toBeNull();
  } else {
    expect(card()).toBeNull();
  }
}

/** The layout under the card moved its chip, or the lane scrolled. */
function anchorDisturbed(model: Model): void {
  if (!model.visible) return;
  if (model.pointer === "card") {
    model.movedWhileHeld = true;
  } else {
    model.visible = false;
  }
}

class HoverChip implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.pointer === "outside";
  }

  async run(model: Model): Promise<void> {
    fireEvent.mouseEnter(chip());
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    await flushMutations();
    model.pointer = "chip";
    model.visible = true;
    model.movedWhileHeld = false;
    check(model);
  }

  toString(): string { return "hoverChip"; }
}

class EnterCard implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.pointer === "chip" && model.visible;
  }

  async run(model: Model): Promise<void> {
    fireEvent.mouseLeave(chip());
    fireEvent.mouseEnter(card()!);
    await flushMutations();
    model.pointer = "card";
    check(model);
  }

  toString(): string { return "enterCard"; }
}

class LeaveCard implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.pointer === "card";
  }

  async run(model: Model): Promise<void> {
    const element = card();
    if (element) fireEvent.mouseLeave(element);
    if (model.movedWhileHeld) {
      model.visible = false;
      check(model);
    }
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 1));
    await flushMutations();
    model.pointer = "outside";
    model.visible = false;
    model.movedWhileHeld = false;
    check(model);
  }

  toString(): string { return "leaveCard"; }
}

class LeaveChip implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.pointer === "chip";
  }

  async run(model: Model): Promise<void> {
    fireEvent.mouseLeave(chip());
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 1));
    await flushMutations();
    model.pointer = "outside";
    model.visible = false;
    check(model);
  }

  toString(): string { return "leaveChip"; }
}

/** The row above gains or loses its chip, and the PR chip moves. */
class ToggleRowAbove implements fc.AsyncCommand<Model, Real> {
  check(): boolean { return true; }

  async run(model: Model, real: Real): Promise<void> {
    real.props = { ...real.props, scheduled: !real.props.scheduled };
    real.rerender(real.props);
    await flushMutations();
    real.layoutChanged();
    await flushMutations();
    anchorDisturbed(model);
    check(model);
  }

  toString(): string { return "toggleRowAbove"; }
}

/** Scroll anchoring compensates for a row above changing height. */
class ScrollLane implements fc.AsyncCommand<Model, Real> {
  check(): boolean { return true; }

  async run(model: Model): Promise<void> {
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    anchorDisturbed(model);
    check(model);
  }

  toString(): string { return "scrollLane"; }
}

/** New check results reach the open card. */
class StatusUpdate implements fc.AsyncCommand<Model, Real> {
  constructor(private readonly checkState: PrChipState) {}

  check(): boolean { return true; }

  async run(model: Model, real: Real): Promise<void> {
    real.props = { ...real.props, checkState: this.checkState };
    real.rerender(real.props);
    await flushMutations();
    check(model);
  }

  toString(): string { return `statusUpdate(${this.checkState})`; }
}

const commands = [
  fc.constant(new HoverChip()),
  fc.constant(new EnterCard()),
  fc.constant(new LeaveCard()),
  fc.constant(new LeaveChip()),
  fc.constant(new ToggleRowAbove()),
  fc.constant(new ScrollLane()),
  fc.constantFrom<PrChipState>("pending", "passing", "failing")
    .map((checkState) => new StatusUpdate(checkState)),
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("a held sidebar PR card", () => {
  it("stays open under layout churn until the operator leaves it", async () => {
    await fc.assert(
      fc.asyncProperty(fc.commands(commands, { maxCommands: 30 }), async (cmds) => {
        vi.useFakeTimers();
        mockSidebarGeometry();
        const { layoutChanged } = stubNativeGeometryObservers();
        const props = { scheduled: false, checkState: "pending" as PrChipState };
        const view = render(<Sidebar {...props} />);
        const real: Real = {
          props,
          layoutChanged,
          rerender: (next) => view.rerender(<Sidebar {...next} />),
        };
        try {
          await fc.asyncModelRun(
            () => ({ model: { visible: false, pointer: "outside" as Pointer, movedWhileHeld: false }, real }),
            cmds,
          );
        } finally {
          cleanup();
          vi.useRealTimers();
          vi.restoreAllMocks();
          vi.unstubAllGlobals();
        }
      }),
      { numRuns: 150 },
    );
  });

  it("survives the reported sequence: a row above flips its chip under the held card", async () => {
    vi.useFakeTimers();
    mockSidebarGeometry();
    const { layoutChanged } = stubNativeGeometryObservers();
    const view = render(<Sidebar scheduled={false} checkState="pending" />);
    fireEvent.mouseEnter(chip());
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const held = card()!;
    fireEvent.mouseLeave(chip());
    fireEvent.mouseEnter(held);

    view.rerender(<Sidebar scheduled checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(held);

    view.rerender(<Sidebar scheduled={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    await flushMutations();
    expect(card()).toBe(held);

    // Leaving it now closes it at once: its chip is not where it was.
    view.rerender(<Sidebar scheduled checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.mouseLeave(held);
    expect(card()).toBeNull();
  });

  it("holds a card while focus is on one of its controls, and closes it when focus leaves after a move", async () => {
    vi.useFakeTimers();
    mockSidebarGeometry();
    const { layoutChanged } = stubNativeGeometryObservers();
    const view = render(<Sidebar scheduled={false} checkState="pending" />);
    fireEvent.mouseEnter(chip());
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const held = card()!;
    const control = within(held).getByRole("button", { name: "Copy URL", hidden: true });

    // Focus leaving an unmoved card is the bridge's business, not this rule's.
    act(() => control.focus());
    act(() => control.blur());
    expect(card()).toBe(held);

    act(() => control.focus());
    view.rerender(<Sidebar scheduled checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(held);

    act(() => control.blur());
    expect(card()).toBeNull();
  });
});
