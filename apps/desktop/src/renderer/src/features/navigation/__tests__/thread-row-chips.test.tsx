import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MessagingThreadBindingSummary,
  NavigationThreadSummary,
} from "@pwragent/shared";
import { ThreadRow } from "../ThreadRow";

// Regression coverage for the unified chip-flow refactor (#188 / plan
// 2026-05-05-001). The historical bug pattern was:
//
//   1. Per-chip-type containers stacked binding chips on their own line
//      and broke ordering/wrapping with the reaction picker.
//   2. Nested `<button>` elements (binding chip inside the row's
//      `<button>`) ate inner clicks — making the binding chip
//      effectively unclickable, or making the click select the thread
//      instead of opening the binding menu.
//
// These tests freeze the contract that motivated the refactor:
//   - Every chip is a sibling inside a single `.thread-row__chips`
//     container — no per-type wrappers.
//   - Interactive chips are `<span role="button">` (NOT `<button>`),
//     and their click events do not propagate into the row's
//     onSelectThread handler.
//   - The add-reaction trigger is the SmileyIcon SVG (not a "+" or
//     the OS-rendered 🙂 emoji which read as bright yellow on dark).

const baseThread: NavigationThreadSummary = {
  id: "thread-chips",
  title: "Chip flow thread",
  titleSource: "explicit",
  summary: "Test row for chip-flow regression",
  source: "codex",
  gitBranch: "feat/chips",
  executionMode: "default",
  updatedAt: Date.now(),
  inbox: { inInbox: false },
  linkedDirectories: [],
};

const telegramBinding: MessagingThreadBindingSummary = {
  bindingId: "binding-tg-1",
  platform: "telegram",
  conversationKind: "topic",
  conversationTitle: "Wood chuck joke",
  parentTitle: "PwrDrvr",
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ThreadRow chip flow", () => {
  function renderRow(
    overrides: Partial<React.ComponentProps<typeof ThreadRow>> = {},
  ) {
    const onSelectThread = vi.fn();
    const onUnbindMessagingBinding = vi.fn(async () => undefined);
    const onSetReaction = vi.fn(async () => undefined);
    const onOpenContextMenu = vi.fn();
    const props: React.ComponentProps<typeof ThreadRow> = {
      thread: {
        ...baseThread,
        messagingBindings: [telegramBinding],
        reactions: ["🙂"],
      },
      onSelectThread,
      onOpenContextMenu,
      onUnbindMessagingBinding,
      onSetReaction,
      ...overrides,
    };
    const utils = render(<ThreadRow {...props} />);
    return { ...utils, onSelectThread, onUnbindMessagingBinding, onSetReaction };
  }

  it("renders every chip as a sibling inside a single .thread-row__chips container", () => {
    const { container } = renderRow();
    const chipFlow = container.querySelectorAll(".thread-row__chips");
    expect(chipFlow.length).toBe(1);
    // All known chip types should live inside that single container,
    // not in any per-type wrapper.
    const flow = chipFlow[0]!;
    expect(flow.querySelector(".thread-row__chip--binding")).not.toBeNull();
    expect(flow.querySelector(".thread-row__chip--reaction")).not.toBeNull();
    expect(flow.querySelector(".thread-row__chip--add-reaction")).not.toBeNull();
  });

  it("uses span[role=button] for the binding chip (not nested <button>)", () => {
    const { container } = renderRow();
    const bindingChip = container.querySelector(".thread-row__chip--binding");
    expect(bindingChip).not.toBeNull();
    // The historical bug was a nested <button>. Lock the role+tag shape.
    expect(bindingChip?.tagName).toBe("SPAN");
    expect(bindingChip?.getAttribute("role")).toBe("button");
  });

  it("does not invoke onSelectThread when a binding chip is clicked", () => {
    const { container, onSelectThread, onUnbindMessagingBinding } = renderRow();
    const bindingChip = container.querySelector(
      ".thread-row__chip--binding",
    ) as HTMLElement;
    fireEvent.click(bindingChip);
    // Click on the chip opens the unbind menu, but must not bubble up
    // and select the thread (the regression that motivated the
    // refactor).
    expect(onSelectThread).not.toHaveBeenCalled();
    // The handler is wired to the menu, not the unbind RPC — opening
    // the menu does not call onUnbindMessagingBinding directly.
    expect(onUnbindMessagingBinding).not.toHaveBeenCalled();
  });

  it("does not invoke onSelectThread when the add-reaction smiley is clicked", () => {
    const { container, onSelectThread } = renderRow();
    const addReaction = container.querySelector(
      ".thread-row__chip--add-reaction",
    ) as HTMLElement;
    expect(addReaction).not.toBeNull();
    fireEvent.click(addReaction);
    expect(onSelectThread).not.toHaveBeenCalled();
  });

  it("does not invoke onSelectThread when an existing reaction chip is clicked", () => {
    const { container, onSelectThread, onSetReaction } = renderRow();
    const reaction = container.querySelector(
      ".thread-row__chip--reaction",
    ) as HTMLElement;
    fireEvent.click(reaction);
    expect(onSelectThread).not.toHaveBeenCalled();
    // But onSetReaction IS invoked — the reaction toggle still works.
    expect(onSetReaction).toHaveBeenCalledOnce();
  });

  it("renders SmileyIcon SVG as the add-reaction trigger (regression: not '+' or OS emoji)", () => {
    const { container } = renderRow();
    const addReaction = container.querySelector(
      ".thread-row__chip--add-reaction",
    );
    // Stroke-based SVG icon, not the OS-rendered 🙂 emoji (which
    // ignored the chip's foreground color and looked yellow), and
    // not the literal "+" plus sign that we used pre-refactor.
    expect(addReaction?.querySelector("svg")).not.toBeNull();
    expect(addReaction?.textContent ?? "").not.toContain("🙂");
    expect(addReaction?.textContent ?? "").not.toContain("+");
  });

  it("still selects the thread when the row body (outside chips) is clicked", () => {
    const { onSelectThread } = renderRow();
    // The row's accessible name is the thread title; click that to
    // hit the row button, not a chip.
    const rowButton = screen.getByRole("button", { name: /Chip flow thread/i });
    fireEvent.click(rowButton);
    expect(onSelectThread).toHaveBeenCalledOnce();
  });

  it("orders chips: meta → PR → bindings → reactions → add-reaction", () => {
    const threadWithEverything: NavigationThreadSummary = {
      ...baseThread,
      messagingBindings: [telegramBinding],
      reactions: ["🙂"],
      prs: [
        {
          number: 123,
          org: "pwrdrvr",
          repo: "PwrAgent",
          state: "passing",
          url: "https://github.com/pwrdrvr/PwrAgent/pull/123",
        },
      ],
    };
    const { container } = renderRow({ thread: threadWithEverything });
    const flow = container.querySelector(".thread-row__chips") as HTMLElement;
    const chipNodes = Array.from(flow.children) as HTMLElement[];
    // Find the index of each known chip class. Order check is by index;
    // we don't assert the count of meta chips since that depends on
    // ThreadMetaChips internals.
    const indexOf = (selector: string): number =>
      chipNodes.findIndex((el) => el.matches(selector) || el.querySelector(selector) !== null);
    const prIdx = indexOf(".thread-row__chip--pr, [data-pr-chip]");
    const bindingIdx = indexOf(".thread-row__chip--binding, .thread-row__chip-wrap");
    const reactionIdx = indexOf(".thread-row__chip--reaction");
    const addReactionIdx = indexOf(".thread-row__chip--add-reaction");
    // Each chip type that's present comes after the previous one.
    if (prIdx >= 0 && bindingIdx >= 0) expect(prIdx).toBeLessThan(bindingIdx);
    if (bindingIdx >= 0 && reactionIdx >= 0) expect(bindingIdx).toBeLessThan(reactionIdx);
    if (reactionIdx >= 0 && addReactionIdx >= 0) {
      expect(reactionIdx).toBeLessThan(addReactionIdx);
    }
  });
});
