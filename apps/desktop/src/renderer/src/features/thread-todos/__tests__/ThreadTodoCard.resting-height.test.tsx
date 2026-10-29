import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import { ThreadTodoCard, type ThreadTodoCardProps } from "../ThreadTodoCard";

/**
 * A card raised with a paragraph of context and eight steps used to render
 * every line, about 830px tall, over the transcript and the composer. A card
 * now rests at a bounded height: the description clamps to three lines, the
 * checklist shows three steps from the first open one, and a toggle opens
 * the rest. See "To-do Card Height UX Review" in the PwrAgent design project.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (nativeScrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", nativeScrollIntoView);
  } else {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  }
});

const STEPS = [
  "Confirm the model is available",
  "Inspect the remote bridge branch",
  "Add command and environment configuration",
  "Expose managed servers through thread selection",
  "Define process and session ownership",
  "Replace the URL-only setup wording",
  "Test with fake servers",
  "Open a tested PR",
];

const LONG_DETAIL = "Use the strongest available model with high reasoning effort. ".repeat(8);

function card(checked: boolean[] = [], overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return {
    id: "long",
    backend: "codex",
    threadId: "thread-a",
    kind: "reminder",
    status: "open",
    title: "Add stdio server support to the MCP gateway",
    detail: LONG_DETAIL,
    items: STEPS.map((text, index) => ({ id: `s${index + 1}`, text, checked: checked[index] ?? false })),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function props(todo: ThreadTodo): ThreadTodoCardProps {
  return {
    todo,
    running: false,
    now: 0,
    onRun: vi.fn(),
    onStartReview: vi.fn(),
    onResolve: vi.fn(),
    onSetItemChecked: vi.fn(),
  };
}

const HANDOFF: ThreadTodo["action"] = {
  type: "start_thread",
  prompt: "Add stdio server support to the gateway.",
};

/** jsdom has no layout; report the clamped paragraph as overflowing. */
function reportClampedDetailAsCut(): void {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("is-clamped") ? 120 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return this.classList.contains("is-clamped") ? 51 : 0;
  });
}

const nativeScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

/** jsdom has no scrollIntoView; install a spy, removed after each test. */
function stubScrollIntoView() {
  const scrollIntoView = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    writable: true,
    value: scrollIntoView,
  });
  return scrollIntoView;
}

function precedes(first: Node, second: Node): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function visibleSteps(): string[] {
  return screen.queryAllByRole("checkbox").map((box) => box.closest("label")?.textContent ?? "");
}

describe("to-do card resting height", () => {
  it("shows three steps of a long checklist until the operator opens the card", () => {
    render(<ThreadTodoCard {...props(card())} />);

    expect(visibleSteps()).toEqual(STEPS.slice(0, 3));
    const toggle = screen.getByRole("button", { name: "Show all 8 steps" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(toggle);
    expect(visibleSteps()).toEqual(STEPS);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(less.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(less);
    expect(visibleSteps()).toEqual(STEPS.slice(0, 3));
  });

  it("keeps the step count in the checklist's name while steps are hidden", () => {
    render(<ThreadTodoCard {...props(card([true, true]))} />);
    expect(screen.getByRole("list", { name: "Steps, 2 of 8 checked" })).toBeTruthy();
  });

  it("starts the step window at the first open step", () => {
    render(<ThreadTodoCard {...props(card([true, true, true]))} />);
    expect(visibleSteps()).toEqual(STEPS.slice(3, 6));
  });

  it("shifts the window back so it stays full near the end", () => {
    render(<ThreadTodoCard {...props(card([true, true, true, true, true, true, true]))} />);
    expect(visibleSteps()).toEqual(STEPS.slice(5, 8));
  });

  it("leaves a ticked step in place until the whole window is ticked", () => {
    const { rerender } = render(<ThreadTodoCard {...props(card([true, true, true]))} />);
    expect(visibleSteps()).toEqual(STEPS.slice(3, 6));

    rerender(<ThreadTodoCard {...props(card([true, true, true, true]))} />);
    expect(visibleSteps()).toEqual(STEPS.slice(3, 6));

    rerender(<ThreadTodoCard {...props(card([true, true, true, true, true, true]))} />);
    expect(visibleSteps()).toEqual(STEPS.slice(5, 8));
  });

  it("clamps the description while the card rests and lifts it when opened", () => {
    render(<ThreadTodoCard {...props(card())} />);
    const detail = screen.getByText(LONG_DETAIL.trim(), { exact: false });
    expect(detail.classList.contains("is-clamped")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Show all 8 steps" }));
    expect(detail.classList.contains("is-clamped")).toBe(false);
  });

  it("offers Show more when only the description is cut", () => {
    reportClampedDetailAsCut();
    render(<ThreadTodoCard {...props(card([], { items: undefined }))} />);

    const toggle = screen.getByRole("button", { name: "Show more" });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("puts Show more under the description, above a handoff's prompt", () => {
    // The toggle used to sit under the whole body, below the prompt's own
    // Show less, and read as the prompt's control.
    reportClampedDetailAsCut();
    render(<ThreadTodoCard {...props(card([], { kind: "handoff", items: undefined, action: HANDOFF }))} />);
    const detail = screen.getByText(LONG_DETAIL.trim(), { exact: false });
    const prompt = screen.getByRole("region", { name: "Proposed prompt" });

    const more = screen.getByRole("button", { name: "Show more" });
    expect(precedes(detail, more)).toBe(true);
    expect(precedes(more, prompt)).toBe(true);

    fireEvent.click(more);
    const less = screen.getByRole("button", { name: "Show less" });
    expect(precedes(detail, less)).toBe(true);
    expect(precedes(less, prompt)).toBe(true);
  });

  it("puts Show all steps under the step window, above a handoff's prompt", () => {
    render(<ThreadTodoCard {...props(card([], { kind: "handoff", action: HANDOFF }))} />);
    const steps = screen.getByRole("list", { name: /^Steps for the new thread/ });
    const prompt = screen.getByRole("region", { name: "Proposed prompt" });

    const toggle = screen.getByRole("button", { name: "Show all 8 steps" });
    expect(precedes(steps, toggle)).toBe(true);
    expect(precedes(toggle, prompt)).toBe(true);
  });

  it("puts Show more above a card's prerequisites", () => {
    reportClampedDetailAsCut();
    render(
      <ThreadTodoCard
        {...props(card([], {
          kind: "handoff",
          action: HANDOFF,
          items: [
            { id: "p1", text: "Merge the protocol change", checked: false, prerequisite: true },
            { id: "s1", text: "Read the owner's version", checked: false },
          ],
        }))}
      />,
    );
    const detail = screen.getByText(LONG_DETAIL.trim(), { exact: false });
    const prerequisites = screen.getByRole("list", { name: /^Before you start/ });

    const more = screen.getByRole("button", { name: "Show more" });
    expect(precedes(detail, more)).toBe(true);
    expect(precedes(more, prerequisites)).toBe(true);
  });

  it("scrolls a keyboard-opened toggle into view", () => {
    const scrollIntoView = stubScrollIntoView();
    render(<ThreadTodoCard {...props(card())} />);
    const toggle = screen.getByRole("button", { name: "Show all 8 steps" });

    // Enter and Space dispatch a click with detail 0.
    fireEvent.click(toggle, { detail: 0 });
    expect(screen.getByRole("button", { name: "Show less" })).toBe(toggle);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(toggle);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
  });

  it("leaves a clicked-open card where it is", () => {
    const scrollIntoView = stubScrollIntoView();
    render(<ThreadTodoCard {...props(card())} />);

    fireEvent.click(screen.getByRole("button", { name: "Show all 8 steps" }), { detail: 1 });
    expect(screen.getByRole("button", { name: "Show less" })).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls the opened body instead of growing the card", () => {
    render(<ThreadTodoCard {...props(card())} />);
    const toggle = screen.getByRole("button", { name: "Show all 8 steps" });
    const body = document.getElementById(toggle.getAttribute("aria-controls") ?? "");
    expect(body?.classList.contains("thread-todo-card__body")).toBe(true);
    expect(body?.classList.contains("is-expanded")).toBe(false);

    fireEvent.click(toggle);
    expect(body?.classList.contains("is-expanded")).toBe(true);
  });

  it("draws no toggle on a short card", () => {
    render(
      <ThreadTodoCard
        {...props(card([], {
          detail: "Merge once CI is green.",
          items: [
            { id: "a", text: "Re-run the macOS lane", checked: false },
            { id: "b", text: "Squash merge", checked: false },
          ],
        }))}
      />,
    );
    expect(visibleSteps()).toEqual(["Re-run the macOS lane", "Squash merge"]);
    expect(screen.queryByRole("button", { name: /^Show / })).toBeNull();
  });
});
