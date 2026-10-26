import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadReviewItem, ThreadTodo } from "@pwragent/shared";
import { ThreadTodoCard, type ThreadTodoCardProps } from "../ThreadTodoCard";
import { threadTodoMarkdown, threadTodosMarkdown } from "../thread-todo-copy";

/**
 * A checklist card had no way out: no Copy tool, and a right-click fell
 * through to Chromium's text menu, so 16 planned steps had to be retyped
 * into a new thread. The card now copies itself as Markdown from its title
 * row and from a right-click menu. See "To-do Card Copy UX Review" in the
 * PwrAgent design project.
 */

const copied = vi.hoisted(() => [] as string[]);
vi.mock("../../../lib/copy-text", () => ({
  copyText: vi.fn((text: string) => {
    copied.push(text);
    return Promise.resolve();
  }),
}));

beforeEach(() => {
  copied.length = 0;
});

afterEach(() => {
  cleanup();
  window.getSelection()?.removeAllRanges();
  vi.useRealTimers();
});

const STEPS = [
  "Confirm the model is available",
  "Inspect the remote bridge branch",
  "Add command and environment configuration",
  "Expose managed servers through thread selection",
  "Define process and session ownership",
];

function card(checked: boolean[] = [], overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return {
    id: "plan",
    backend: "claude",
    threadId: "thread-a",
    kind: "reminder",
    status: "open",
    title: "Add stdio server support",
    detail: "What remains is gateway-managed configuration.",
    items: STEPS.map((text, index) => ({ id: `s${index + 1}`, text, checked: checked[index] ?? false })),
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function props(todo: ThreadTodo, extra: Partial<ThreadTodoCardProps> = {}): ThreadTodoCardProps {
  return {
    todo,
    running: false,
    now: 0,
    onRun: vi.fn(),
    onStartReview: vi.fn(),
    onResolve: vi.fn(),
    onSetItemChecked: vi.fn(),
    ...extra,
  };
}

function menuItems(): string[] {
  return within(screen.getByRole("menu")).getAllByRole("menuitem").map((item) => item.textContent ?? "");
}

async function choose(label: string): Promise<void> {
  const item = within(screen.getByRole("menu"))
    .getAllByRole("menuitem")
    .find((entry) => entry.textContent?.startsWith(label));
  if (!item) throw new Error(`No menu item ${label}`);
  await act(async () => {
    fireEvent.click(item);
  });
}

describe("to-do card Markdown", () => {
  it("writes the title, description and every step as a task list", () => {
    expect(threadTodoMarkdown(card([true]))).toBe([
      "## Add stdio server support",
      "",
      "What remains is gateway-managed configuration.",
      "",
      "- [x] Confirm the model is available",
      "- [ ] Inspect the remote bridge branch",
      "- [ ] Add command and environment configuration",
      "- [ ] Expose managed servers through thread selection",
      "- [ ] Define process and session ownership",
    ].join("\n"));
  });

  it("adds a start-thread card's prompt and a review's findings", () => {
    const handoff = card([], {
      items: undefined,
      detail: undefined,
      action: { type: "start_thread", prompt: "Build the gateway." },
    });
    expect(threadTodoMarkdown(handoff)).toBe("## Add stdio server support\n\n### Prompt\n\nBuild the gateway.");

    const finding = (id: string, status: ThreadReviewItem["status"], priority?: number): ThreadReviewItem => ({
      id, title: `Finding ${id}`, status, priority, createdAt: 0, updatedAt: 0,
    });
    const review = card([], { items: undefined, detail: undefined, kind: "review" });
    expect(threadTodoMarkdown(review, [finding("a", "open", 1), finding("b", "addressed"), finding("c", "dismissed", 2)]))
      .toBe("## Add stdio server support\n\n- [ ] P1 Finding a\n- [x] Finding b\n- [x] ~~P2 Finding c~~ (declined)");
  });

  it("heads prerequisites apart from the steps", () => {
    const handoff = card([true, false], {
      detail: undefined,
      items: [
        { id: "p1", text: "Clone the repository", checked: false, prerequisite: true },
        ...card([true, false]).items!.slice(0, 2),
      ],
      action: { type: "start_thread", prompt: "Build the gateway." },
    });
    expect(threadTodoMarkdown(handoff)).toBe([
      "## Add stdio server support",
      "",
      "### Before you start",
      "",
      "- [ ] Clone the repository",
      "",
      "### Steps",
      "",
      "- [x] Confirm the model is available",
      "- [ ] Inspect the remote bridge branch",
      "",
      "### Prompt",
      "",
      "Build the gateway.",
    ].join("\n"));
  });

  it("separates cards with a blank line", () => {
    const one = card([], { items: undefined, detail: undefined, title: "One" });
    const two = card([], { items: undefined, detail: undefined, title: "Two" });
    expect(threadTodosMarkdown([one, two])).toBe("## One\n\n## Two");
  });
});

describe("to-do card copy", () => {
  it("copies the whole card from the title row, not the resting window of steps", async () => {
    vi.useFakeTimers();
    render(<ThreadTodoCard {...props(card())} />);

    // The card rests at three steps.
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy to-do" }));
    });

    expect(copied).toEqual([threadTodoMarkdown(card())]);
    expect(copied[0]).toContain(STEPS[4]);
    expect(screen.getByRole("button", { name: "To-do copied" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1_500);
    });
    expect(screen.getByRole("button", { name: "Copy to-do" })).toBeTruthy();
  });

  it("keeps the title row to the title and its tools", () => {
    // Progress, age and three tools in one row left a 340px card's title
    // about 150px. The counts sit on the project row instead.
    const { container } = render(<ThreadTodoCard {...props(card([true]))} />);

    const head = container.querySelector(".thread-todo-card__head")!;
    expect(head.textContent).toBe("Add stdio server support");
    const meta = container.querySelector(".thread-todo-card__meta")!;
    expect(meta.querySelector(".thread-todo-card__progress")?.textContent).toBe("1 of 5");
    expect(meta.querySelector(".thread-todo-card__age")?.textContent).toBe("now");
  });

  it("offers Copy step for the step under a right-click", async () => {
    render(<ThreadTodoCard {...props(card())} />);

    fireEvent.contextMenu(screen.getByText(STEPS[1]));

    expect(menuItems()).toEqual(["Copy step", "Copy to-do5 steps"]);
    await choose("Copy step");
    expect(copied).toEqual([STEPS[1]]);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("offers the open steps once some are ticked, and every card in the stack", async () => {
    const todo = card([true, true]);
    const other = card([], { id: "other", title: "Rotate the signing key", items: undefined });
    render(<ThreadTodoCard {...props(todo, { copyAllTodos: [todo, other] })} />);

    fireEvent.contextMenu(screen.getByRole("heading", { name: todo.title }));

    expect(menuItems()).toEqual(["Copy to-do5 steps", "Copy open steps3", "Copy all to-dos2"]);
    await choose("Copy open steps");
    expect(copied.at(-1)).toBe(
      "- [ ] Add command and environment configuration\n"
      + "- [ ] Expose managed servers through thread selection\n"
      + "- [ ] Define process and session ownership",
    );

    fireEvent.contextMenu(screen.getByRole("heading", { name: todo.title }));
    await choose("Copy all to-dos");
    expect(copied.at(-1)).toBe(threadTodosMarkdown([todo, other]));
  });

  it("counts and copies the steps without the prerequisites", async () => {
    const todo = card([true], {
      items: [
        { id: "p1", text: "Clone the repository", checked: false, prerequisite: true },
        ...card([true]).items!,
      ],
    });
    render(<ThreadTodoCard {...props(todo)} />);

    fireEvent.contextMenu(screen.getByText("Clone the repository"));
    expect(menuItems()).toEqual(["Copy step", "Copy to-do5 steps", "Copy open steps4"]);
    await choose("Copy open steps");
    expect(copied.at(-1)).not.toContain("Clone the repository");
  });

  it("leads with Copy selection when text inside the card is selected", async () => {
    render(<ThreadTodoCard {...props(card())} />);
    const detail = screen.getByText("What remains is gateway-managed configuration.");
    const range = document.createRange();
    range.setStart(detail.firstChild!, 16);
    range.setEnd(detail.firstChild!, 31);
    window.getSelection()?.addRange(range);

    fireEvent.contextMenu(detail);

    expect(menuItems()[0]).toBe("Copy selection");
    await choose("Copy selection");
    expect(copied).toEqual(["gateway-managed"]);
  });

  it("keeps the selection a right press would otherwise replace", () => {
    render(<ThreadTodoCard {...props(card())} />);

    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 });
    screen.getByText(STEPS[0]).dispatchEvent(press);

    expect(press.defaultPrevented).toBe(true);
  });

  it("does not reopen the menu for a right-click on the menu itself", () => {
    render(<ThreadTodoCard {...props(card())} />);
    fireEvent.contextMenu(screen.getByText(STEPS[0]));
    const menu = screen.getByRole("menu");

    // The menu portals out of the card, but React bubbles its events
    // through the card.
    fireEvent.contextMenu(within(menu).getAllByRole("menuitem")[0]!);

    // The menu's own right-click closes it; the card must not open it again.
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
