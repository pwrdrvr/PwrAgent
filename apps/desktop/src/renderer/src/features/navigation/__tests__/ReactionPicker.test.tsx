import { useRef, useState } from "react";
import "@testing-library/jest-dom/vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReactionPicker } from "../ReactionPicker";
import { REACTION_RECENTS_STORAGE_KEY } from "../reaction-picker-model";
import { HOVER_TRANSITION_GRACE_MS } from "../../../lib/useHoverTransitionGrace";

function PickerHarness(props: {
  initialOpen?: boolean;
  current?: string[];
  onSelect?: (emoji: string) => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? true);
  const [reactions, setReactions] = useState<string[]>(props.current ?? []);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Open reactions
      </button>
      <ReactionPicker
        open={open}
        current={reactions}
        anchorRef={triggerRef}
        onSelect={(emoji) => {
          props.onSelect?.(emoji);
          setReactions((prev) =>
            prev.includes(emoji)
              ? prev.filter((item) => item !== emoji)
              : [...prev, emoji],
          );
        }}
        onDismiss={() => {
          props.onDismiss?.();
          setOpen(false);
        }}
      />
    </div>
  );
}

beforeEach(() => {
  window.localStorage.removeItem(REACTION_RECENTS_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  window.localStorage.removeItem(REACTION_RECENTS_STORAGE_KEY);
  vi.restoreAllMocks();
});

describe("ReactionPicker", () => {
  it("skips localStorage reads and portal work while closed", () => {
    const getItemSpy = vi.spyOn(Storage.prototype, "getItem");

    render(<PickerHarness initialOpen={false} />);

    expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();
    expect(getItemSpy).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open reactions" }));
    expect(
      screen.getByRole("dialog", { name: "Add reaction" }),
    ).toBeInTheDocument();
    expect(getItemSpy).toHaveBeenCalledWith(REACTION_RECENTS_STORAGE_KEY);
  });

  it("opens as a searchable dialog focused on search with thumbs up first and no OS shortcut hint", () => {
    render(<PickerHarness current={["🚀"]} />);

    const dialog = screen.getByRole("dialog", { name: "Add reaction" });
    const searchInput = within(dialog).getByRole("searchbox", {
      name: "Search emoji",
    });

    expect(searchInput).toHaveFocus();
    expect(dialog.textContent).not.toContain("⌘⌃Space");
    expect(dialog.textContent).not.toContain("Custom");

    const quickGroup = within(dialog).getByRole("group", { name: "Quick" });
    const quickButtons = within(quickGroup).getAllByRole("button");
    expect(quickButtons[0]).toHaveAccessibleName("Thumbs up");
    expect(quickButtons[0]).toHaveAttribute("aria-pressed", "false");

    const rocketButton = within(quickGroup).getByRole("button", {
      name: "Rocket",
    });
    expect(rocketButton).toHaveAttribute("aria-pressed", "true");
    expect(rocketButton).toHaveClass("is-active");
  });

  it("re-measures placement after portal mount and ignores internal grid scrolls", () => {
    const originalInnerWidth = window.innerWidth;
    const originalInnerHeight = window.innerHeight;
    Object.defineProperty(window, "innerWidth", { value: 1280, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });

    let anchorRectCalls = 0;
    const origGetBoundingClientRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      if (this.classList.contains("reaction-picker")) {
        return {
          top: 0,
          bottom: 230,
          left: 0,
          right: 316,
          width: 316,
          height: 230,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        } as DOMRect;
      }
      if (this.tagName === "BUTTON" && this.textContent === "Open reactions") {
        anchorRectCalls++;
        return {
          top: 500,
          bottom: 520,
          left: 200,
          right: 224,
          width: 24,
          height: 20,
          x: 200,
          y: 500,
          toJSON: () => ({}),
        } as DOMRect;
      }
      return origGetBoundingClientRect.call(this);
    });

    try {
      render(<PickerHarness />);
      const dialog = screen.getByRole("dialog", { name: "Add reaction" });
      // With default height 378px, anchor.bottom(520)+6+378 > 792 would have
      // flipped above to top=116. After re-measuring at 230px, 520+6+230=756<=792
      // so it stays below at top=526px.
      expect(dialog).toHaveAttribute("data-placement", "below");
      expect(dialog).toHaveStyle({ top: "526px", left: "200px" });

      const callsBeforeGridScroll = anchorRectCalls;
      const body = dialog.querySelector(".reaction-picker__body") as HTMLElement;
      fireEvent.scroll(body);
      expect(anchorRectCalls).toBe(callsBeforeGridScroll);
    } finally {
      Object.defineProperty(window, "innerWidth", {
        value: originalInnerWidth,
        configurable: true,
      });
      Object.defineProperty(window, "innerHeight", {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it("preserves exact stored VS16 variant strings when toggling active reactions off", () => {
    const onSelect = vi.fn();
    render(<PickerHarness current={["❤", "☀", "☀️"]} onSelect={onSelect} />);

    // "❤" matches Quick's "❤️" by normalized key; clicking toggles off "❤"
    // and keeps the picker open for additional toggles.
    const heartButton = screen.getByRole("button", { name: "Red heart" });
    expect(heartButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(heartButton);
    expect(onSelect).toHaveBeenCalledWith("❤");
    expect(heartButton).toHaveAttribute("aria-pressed", "false");

    // "On this thread" dedupes "☀"/"☀️" and passes stored "☀" without closing.
    onSelect.mockClear();
    const activeGroup = screen.getByRole("group", { name: "On this thread" });
    const activeButtons = within(activeGroup).getAllByRole("button");
    expect(activeButtons).toHaveLength(1);
    fireEvent.click(activeButtons[0]!);
    expect(onSelect).toHaveBeenCalledWith("☀");
  });

  it("stays open while clicking multiple emojis without shifting Quick, then closes after leaving", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const onDismiss = vi.fn();
      render(<PickerHarness onSelect={onSelect} onDismiss={onDismiss} />);

      const dialog = screen.getByRole("dialog", { name: "Add reaction" });

      // Leaving before any pick does NOT auto-close the dialog.
      fireEvent.mouseEnter(dialog);
      fireEvent.mouseLeave(dialog);
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Add reaction" })).toBeInTheDocument();

      // Re-enter and click multiple emojis in one go: picker stays open and
      // does not insert a "Recent" row mid-session to shift buttons under the mouse.
      fireEvent.mouseEnter(dialog);
      const thumbsUp = screen.getByRole("button", { name: "Thumbs up" });
      const rocket = screen.getByRole("button", { name: "Rocket" });
      fireEvent.click(thumbsUp);
      fireEvent.click(rocket);

      expect(onSelect).toHaveBeenNthCalledWith(1, "👍");
      expect(onSelect).toHaveBeenNthCalledWith(2, "🚀");
      expect(thumbsUp).toHaveAttribute("aria-pressed", "true");
      expect(rocket).toHaveAttribute("aria-pressed", "true");
      expect(screen.queryByRole("group", { name: "Recent" })).toBeNull();
      expect(onDismiss).not.toHaveBeenCalled();

      // Leaving after picking starts the grace delay; re-entering cancels it.
      fireEvent.mouseLeave(dialog);
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS - 50);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.mouseEnter(dialog);
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Leaving and staying out closes once the grace delay elapses.
      fireEvent.mouseLeave(dialog);
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS);
      });
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores synthetic stationary mouseleave after picking when layout shrinks during search or category switch", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<PickerHarness onDismiss={onDismiss} />);

      const dialog = screen.getByRole("dialog", { name: "Add reaction" });
      const searchInput = within(dialog).getByRole("searchbox", {
        name: "Search emoji",
      });

      // Pointer enters and clicks an emoji at stationary coordinates (220, 300).
      fireEvent.mouseEnter(dialog, { clientX: 220, clientY: 300 });
      fireEvent.mouseMove(dialog, { clientX: 220, clientY: 300 });
      fireEvent.mouseDown(dialog, { clientX: 220, clientY: 300 });
      fireEvent.click(screen.getByRole("button", { name: "Thumbs up" }), {
        clientX: 220,
        clientY: 300,
      });

      // Typing shrinks the popover; Chromium fires a synthetic mouseleave at
      // the exact same stationary coordinates. The picker must stay open.
      fireEvent.change(searchInput, { target: { value: "rocket" } });
      fireEvent.mouseLeave(dialog, { clientX: 220, clientY: 300 });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();
      expect(screen.getByRole("dialog", { name: "Add reaction" })).toBeInTheDocument();

      // Same for switching to a category tab whose layout shift moves under the cursor.
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear search" }));
      const flagsTab = within(dialog).getByRole("tab", { name: "Flags" });
      fireEvent.mouseMove(dialog, { clientX: 180, clientY: 120 });
      fireEvent.mouseDown(flagsTab, { clientX: 180, clientY: 120 });
      fireEvent.click(flagsTab, { clientX: 180, clientY: 120 });
      fireEvent.mouseLeave(dialog, { clientX: 180, clientY: 120 });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Actually moving the pointer away from the popover closes after the grace delay.
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS);
      });
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a pending leave timer on in-picker interactions while keeping post-pick leave-close armed", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<PickerHarness onDismiss={onDismiss} />);

      const dialog = screen.getByRole("dialog", { name: "Add reaction" });
      const searchInput = within(dialog).getByRole("searchbox", {
        name: "Search emoji",
      });

      fireEvent.click(screen.getByRole("button", { name: "Thumbs up" }));

      // Arm the leave timer, then type in search (interact_inside) before it fires.
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS - 50);
      });
      fireEvent.change(searchInput, { target: { value: "fire" } });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Arm again, then clear search (interact_inside).
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear search" }));
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Arm again, then switch category tab (interact_inside).
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      fireEvent.click(within(dialog).getByRole("tab", { name: "Numbers & Letters" }));
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // Arm again, then use keyboard ArrowDown from search (interact_inside).
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      fireEvent.keyDown(searchInput, { key: "ArrowDown" });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).not.toHaveBeenCalled();

      // hasPicked was preserved across all interact_inside events, so a
      // subsequent real pointer leave still closes after the grace delay.
      fireEvent.mouseLeave(dialog, { clientX: 40, clientY: 120 });
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS);
      });
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes immediately on an outside click after picking without waiting for the leave delay", () => {
    vi.useFakeTimers();
    try {
      const onDismiss = vi.fn();
      render(<PickerHarness onDismiss={onDismiss} />);

      const dialog = screen.getByRole("dialog", { name: "Add reaction" });
      fireEvent.click(screen.getByRole("button", { name: "Thumbs up" }));
      fireEvent.mouseLeave(dialog);

      fireEvent.pointerDown(document.body);
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();

      // Timer was cancelled so advancing time does not double-dismiss.
      act(() => {
        vi.advanceTimersByTime(HOVER_TRANSITION_GRACE_MS + 100);
      });
      expect(onDismiss).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters across the full Unicode catalog and selects the top match on Enter", async () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);

    const searchInput = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(searchInput, { target: { value: "avocado" } });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Avocado" }),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("🥑");
  });

  it("ignores Enter and ArrowDown during active IME composition in the search input", () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);

    const searchInput = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.keyDown(searchInput, { key: "Enter", isComposing: true });
    fireEvent.keyDown(searchInput, { key: "Enter", keyCode: 229 });
    fireEvent.keyDown(searchInput, { key: "ArrowDown", isComposing: true });

    expect(onSelect).not.toHaveBeenCalled();
    expect(searchInput).toHaveFocus();
  });

  it("records added reactions in Recent and shows them on next open", () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Thumbs up" }));
    expect(onSelect).toHaveBeenCalledWith("👍");
    // Stays open for multi-select until explicitly dismissed or pointer leaves.
    expect(screen.getByRole("dialog", { name: "Add reaction" })).toBeInTheDocument();

    // Close and reopen the picker: Recent should now surface 👍 above Quick.
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Open reactions" }));
    const recentGroup = screen.getByRole("group", { name: "Recent" });
    expect(
      within(recentGroup).getByRole("button", { name: "Thumbs up" }),
    ).toBeInTheDocument();
  });

  it("allows selecting pasted custom skin-tone emojis directly from search", () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);

    const searchInput = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.change(searchInput, { target: { value: "👍🏽" } });

    expect(screen.getByRole("button", { name: "Use 👍🏽" })).toBeInTheDocument();
    fireEvent.keyDown(searchInput, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("👍🏽");
  });

  it("provides Numbers (0-10) and all 26 Letters (A-Z) and navigates cleanly between sections", () => {
    render(<PickerHarness />);

    fireEvent.click(screen.getByRole("tab", { name: "Numbers & Letters" }));

    const numbers = screen.getByRole("group", { name: "Numbers" });
    const letters = screen.getByRole("group", { name: "Letters" });

    expect(within(numbers).getAllByRole("button")).toHaveLength(11);
    expect(within(letters).getAllByRole("button")).toHaveLength(26);
    expect(
      within(letters).getByRole("button", { name: "Letter Z" }),
    ).toHaveTextContent("🅩");

    // ArrowDown from 8️⃣ (row 1, col 0 of Numbers) lands on Letter A (row 0, col 0 of Letters).
    const number8 = within(numbers).getByRole("button", { name: "Number 8" });
    const letterA = within(letters).getByRole("button", { name: "Letter A" });
    act(() => {
      number8.focus();
    });
    fireEvent.keyDown(number8, { key: "ArrowDown" });
    expect(letterA).toHaveFocus();

    fireEvent.keyDown(letterA, { key: "ArrowUp" });
    expect(number8).toHaveFocus();
  });

  it("clears stale preview and scroll offset on grid type-ahead into search", () => {
    render(<PickerHarness />);

    const dialog = screen.getByRole("dialog", { name: "Add reaction" });
    const searchInput = within(dialog).getByRole("searchbox", {
      name: "Search emoji",
    });
    const body = dialog.querySelector(".reaction-picker__body") as HTMLElement;
    body.scrollTop = 120;

    const rocket = screen.getByRole("button", { name: "Rocket" });
    act(() => {
      rocket.focus();
    });
    expect(within(dialog).getByText("Rocket")).toBeInTheDocument();

    fireEvent.keyDown(rocket, { key: "f" });
    expect(searchInput).toHaveFocus();
    expect(searchInput).toHaveValue("f");
    expect(body.scrollTop).toBe(0);

    // Top search match should be highlighted and shown in the preview footer
    // rather than remaining stuck on Rocket.
    const firstMatch = body.querySelector('[data-reaction-index="0"]');
    expect(firstMatch).toHaveClass("is-match");
    expect(within(dialog).queryByText("Rocket")).toBeNull();
  });

  it("shows hovered emoji name and shortcode in the footer and Active when already present", () => {
    render(<PickerHarness current={["🚀"]} />);

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Thumbs up" }));
    expect(screen.getByText("Thumbs up")).toBeInTheDocument();
    expect(screen.getByText(":+1:")).toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByRole("button", { name: "Rocket" }));
    expect(screen.getByText("Rocket")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("supports keyboard navigation between search and the 2D grid, and closes cleanly on Escape", () => {
    const onDismiss = vi.fn();
    render(<PickerHarness onDismiss={onDismiss} />);

    const searchInput = screen.getByRole("searchbox", { name: "Search emoji" });
    fireEvent.keyDown(searchInput, { key: "ArrowDown" });
    const thumbsUp = screen.getByRole("button", { name: "Thumbs up" });
    expect(thumbsUp).toHaveFocus();

    fireEvent.keyDown(thumbsUp, { key: "ArrowRight" });
    const thumbsDown = screen.getByRole("button", { name: "Thumbs down" });
    expect(thumbsDown).toHaveFocus();

    // ArrowUp on the top row returns focus to search.
    fireEvent.keyDown(thumbsDown, { key: "ArrowUp" });
    expect(searchInput).toHaveFocus();

    // Escape closes via useDismissableLayer and returns focus to the trigger.
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open reactions" }),
    ).toHaveFocus();
  });

  it("toggles closed cleanly when clicking the trigger button while open", () => {
    const onDismiss = vi.fn();
    render(<PickerHarness onDismiss={onDismiss} />);

    const trigger = screen.getByRole("button", { name: "Open reactions" });
    fireEvent.pointerDown(trigger);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.click(trigger);
    expect(screen.queryByRole("dialog", { name: "Add reaction" })).toBeNull();
  });
});
