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
 * down and back; a smaller change above nudges it by less than its own
 * height; scroll anchoring scrolls the lane to compensate; the PR's checks
 * keep updating. The operator meanwhile rests the pointer on the card's
 * footer, rests it on the chip, or reads the card from the keyboard with
 * focus on the chip.
 *
 * The rules:
 *
 * - A card the pointer is inside stays open, whatever the layout does under
 *   it. Only the operator closes it: leaving it, Escape, or a press outside.
 * - A card whose chip still has keyboard focus, or still has the pointer over
 *   it where it now sits, follows the chip when it moves or its lane scrolls.
 * - Any other card closes when its chip moves or its lane scrolls, as any
 *   tooltip does: it no longer points at anything.
 * - Leaving a card whose chip moved while it was held closes it, since the
 *   bridge back to the chip no longer leads there.
 */

const ROW_SHIFT = 24;
/** Less than the chip's height, so a pointer resting on it stays on it. */
const ROW_NUDGE = 8;
const CHIP_TOP = 200;
const CHIP_HEIGHT = 20;
const CHIP_X = 230;
/** Where the pointer rests on the chip, from its top edge. */
const POINTER_IN_CHIP = 10;
const CARD_POINT = { clientX: 400, clientY: 150 };
const SIDEBAR = { left: 0, right: 320 };

function rect(left: number, right: number, top: number, bottom: number): DOMRect {
  return {
    left, right, top, bottom, x: left, y: top,
    width: right - left, height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Where the chip sits for a layout: a row lower while the row above carries
 *  its extra chip, a little lower while the row above is nudged. */
function chipTopFor(layout: Layout): number {
  return CHIP_TOP + (layout.scheduled ? ROW_SHIFT : 0) + (layout.nudged ? ROW_NUDGE : 0);
}

function chipTop(): number {
  return chipTopFor({
    scheduled: document.querySelector("[data-row-above-chip]") !== null,
    nudged: document.querySelector("[data-row-above-nudge]") !== null,
  });
}

function mockSidebarGeometry(): void {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    if (this.classList.contains("sidebar")) return rect(SIDEBAR.left, SIDEBAR.right, 0, 900);
    if (this.classList.contains("pr-status-card")) return rect(330, 602, 100, 300);
    if (this.hasAttribute("data-pr-chip")) {
      const top = chipTop();
      return rect(200, 260, top, top + CHIP_HEIGHT);
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

type Layout = { scheduled: boolean; nudged: boolean };
type SidebarProps = Layout & { checkState: PrChipState };

function Sidebar(props: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-list--dense" data-testid="lane">
        <div className="thread-row">
          <span className="thread-row__chips">
            <span className="thread-row__chip" data-row-above-nudge={props.nudged ? "" : undefined}>Claude</span>
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
type Model = {
  visible: boolean;
  pointer: Pointer;
  /** Where the pointer rests while it is on the chip. */
  pointerY: number | null;
  focus: "none" | "chip";
  movedWhileHeld: boolean;
  /** The chip top the visible card is placed beside. */
  cardTop: number | null;
  layout: Layout;
};
type Real = {
  rerender: (props: SidebarProps) => void;
  props: SidebarProps;
  layoutChanged: () => void;
};

const initialModel = (): Model => ({
  visible: false,
  pointer: "outside",
  pointerY: null,
  focus: "none",
  movedWhileHeld: false,
  cardTop: null,
  layout: { scheduled: false, nudged: false },
});

const chip = () => screen.getByRole("button", { name: /Open acme\/orbit#4403 / });
const card = () => screen.queryByRole("tooltip");

async function flushMutations(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

function check(model: Model): void {
  if (model.visible) {
    expect(card()).not.toBeNull();
    // Beside placement levels the card with the chip it points at.
    expect(card()!.style.top).toBe(`${model.cardTop}px`);
  } else {
    expect(card()).toBeNull();
  }
}

function pointerOverChip(model: Model): boolean {
  if (model.pointer !== "chip" || model.pointerY === null) return false;
  const top = chipTopFor(model.layout);
  return model.pointerY >= top && model.pointerY < top + CHIP_HEIGHT;
}

/** The card shows, or is placed again, beside the chip where it sits now. */
function cardFollowsChip(model: Model): void {
  model.visible = true;
  model.movedWhileHeld = false;
  model.cardTop = chipTopFor(model.layout);
}

function cardCloses(model: Model): void {
  model.visible = false;
  model.movedWhileHeld = false;
  model.cardTop = null;
  // A card vanishing under the pointer leaves it over whatever was beneath.
  if (model.pointer === "card") model.pointer = "outside";
}

/** The layout under the card moved its chip, or the lane scrolled. */
function anchorDisturbed(model: Model): void {
  if (!model.visible) return;
  if (model.pointer === "card") {
    model.movedWhileHeld = true;
  } else if (model.focus === "chip" || pointerOverChip(model)) {
    cardFollowsChip(model);
  } else {
    cardCloses(model);
  }
}

/**
 * The row above changes and the chip moves. A chip that moved out from under
 * the pointer gets a `mouseleave` once the browser hit-tests again, and the
 * bridge's grace closes its card.
 */
async function moveChip(model: Model, real: Real, change: Partial<Layout>): Promise<void> {
  real.props = { ...real.props, ...change };
  model.layout = { scheduled: real.props.scheduled, nudged: real.props.nudged };
  real.rerender(real.props);
  await flushMutations();
  real.layoutChanged();
  await flushMutations();
  anchorDisturbed(model);
  check(model);
  if (model.pointer === "chip" && !pointerOverChip(model)) {
    fireEvent.mouseLeave(chip(), { clientX: CHIP_X, clientY: model.pointerY ?? 0 });
    act(() => vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 1));
    await flushMutations();
    model.pointer = "outside";
    model.pointerY = null;
    cardCloses(model);
    check(model);
  }
}

class HoverChip implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.pointer === "outside";
  }

  async run(model: Model): Promise<void> {
    const pointerY = chipTopFor(model.layout) + POINTER_IN_CHIP;
    fireEvent.mouseEnter(chip(), { clientX: CHIP_X, clientY: pointerY });
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    await flushMutations();
    model.pointer = "chip";
    model.pointerY = pointerY;
    cardFollowsChip(model);
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
    fireEvent.mouseEnter(card()!, CARD_POINT);
    await flushMutations();
    model.pointer = "card";
    model.pointerY = null;
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
    cardCloses(model);
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
    model.pointerY = null;
    cardCloses(model);
    check(model);
  }

  toString(): string { return "leaveChip"; }
}

/** Tab onto the chip: focus shows its card. */
class FocusChip implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.focus === "none";
  }

  async run(model: Model): Promise<void> {
    act(() => chip().focus());
    await flushMutations();
    model.focus = "chip";
    cardFollowsChip(model);
    check(model);
  }

  toString(): string { return "focusChip"; }
}

/** Tab away from the chip, to something outside the card. */
class BlurChip implements fc.AsyncCommand<Model, Real> {
  check(model: Readonly<Model>): boolean {
    return model.focus === "chip";
  }

  async run(model: Model): Promise<void> {
    act(() => chip().blur());
    await flushMutations();
    model.focus = "none";
    cardCloses(model);
    check(model);
  }

  toString(): string { return "blurChip"; }
}

/** The row above gains or loses its chip, and the PR chip moves. */
class ToggleRowAbove implements fc.AsyncCommand<Model, Real> {
  check(): boolean { return true; }

  async run(model: Model, real: Real): Promise<void> {
    await moveChip(model, real, { scheduled: !real.props.scheduled });
  }

  toString(): string { return "toggleRowAbove"; }
}

/** The row above grows a little, moving the PR chip by less than its height. */
class NudgeRowAbove implements fc.AsyncCommand<Model, Real> {
  check(): boolean { return true; }

  async run(model: Model, real: Real): Promise<void> {
    await moveChip(model, real, { nudged: !real.props.nudged });
  }

  toString(): string { return "nudgeRowAbove"; }
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
  fc.constant(new FocusChip()),
  fc.constant(new BlurChip()),
  fc.constant(new ToggleRowAbove()),
  fc.constant(new NudgeRowAbove()),
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
        const props: SidebarProps = { scheduled: false, nudged: false, checkState: "pending" };
        const view = render(<Sidebar {...props} />);
        const real: Real = {
          props,
          layoutChanged,
          rerender: (next) => view.rerender(<Sidebar {...next} />),
        };
        try {
          await fc.asyncModelRun(
            () => ({ model: initialModel(), real }),
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
    const view = render(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    fireEvent.mouseEnter(chip());
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const held = card()!;
    fireEvent.mouseLeave(chip());
    fireEvent.mouseEnter(held);

    view.rerender(<Sidebar scheduled nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(held);

    view.rerender(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    await flushMutations();
    expect(card()).toBe(held);

    // Leaving it now closes it at once: its chip is not where it was.
    view.rerender(<Sidebar scheduled nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.mouseLeave(held);
    expect(card()).toBeNull();
  });

  it("holds a card while focus is on one of its controls, and closes it when focus leaves after a move", async () => {
    vi.useFakeTimers();
    mockSidebarGeometry();
    const { layoutChanged } = stubNativeGeometryObservers();
    const view = render(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    fireEvent.mouseEnter(chip());
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const held = card()!;
    const control = within(held).getByRole("button", { name: "Copy URL", hidden: true });

    // Focus leaving an unmoved card is the bridge's business, not this rule's.
    act(() => control.focus());
    act(() => control.blur());
    expect(card()).toBe(held);

    act(() => control.focus());
    view.rerender(<Sidebar scheduled nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(held);

    act(() => control.blur());
    expect(card()).toBeNull();
  });

  it("follows a chip that keeps keyboard focus when a row above flips its chip", async () => {
    vi.useFakeTimers();
    mockSidebarGeometry();
    const { layoutChanged } = stubNativeGeometryObservers();
    const view = render(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    act(() => chip().focus());
    const shown = card()!;
    expect(shown.style.top).toBe(`${CHIP_TOP}px`);

    view.rerender(<Sidebar scheduled nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(shown);
    expect(shown.style.top).toBe(`${CHIP_TOP + ROW_SHIFT}px`);

    view.rerender(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    await flushMutations();
    layoutChanged();
    await flushMutations();
    expect(card()).toBe(shown);
    expect(shown.style.top).toBe(`${CHIP_TOP}px`);
  });

  it("follows a chip the pointer still rests on, and closes once the chip moves out from under it", async () => {
    vi.useFakeTimers();
    mockSidebarGeometry();
    const { layoutChanged } = stubNativeGeometryObservers();
    const view = render(<Sidebar scheduled={false} nudged={false} checkState="pending" />);
    fireEvent.mouseEnter(chip(), { clientX: CHIP_X, clientY: CHIP_TOP + POINTER_IN_CHIP });
    act(() => vi.advanceTimersByTime(TOOLTIP_HOVER_DELAY_MS));
    const shown = card()!;

    view.rerender(<Sidebar scheduled={false} nudged checkState="pending" />);
    await flushMutations();
    layoutChanged();
    await flushMutations();
    expect(card()).toBe(shown);
    expect(shown.style.top).toBe(`${CHIP_TOP + ROW_NUDGE}px`);

    fireEvent.scroll(screen.getByTestId("lane"));
    await flushMutations();
    expect(card()).toBe(shown);

    view.rerender(<Sidebar scheduled nudged checkState="pending" />);
    await flushMutations();
    layoutChanged();
    await flushMutations();
    expect(card()).toBeNull();
  });
});
