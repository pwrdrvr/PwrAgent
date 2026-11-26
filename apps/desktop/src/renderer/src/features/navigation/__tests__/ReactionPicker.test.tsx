import { useRef, useState } from "react";
import "@testing-library/jest-dom/vitest";
import {
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

function PickerHarness(props: {
  initialOpen?: boolean;
  current?: string[];
  onSelect?: (emoji: string) => void;
  onDismiss?: () => void;
}) {
  const [open, setOpen] = useState(props.initialOpen ?? true);
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
        current={props.current ?? []}
        anchorRef={triggerRef}
        onSelect={(emoji) => {
          props.onSelect?.(emoji);
          setOpen(false);
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

  it("records added reactions in Recent and shows them on next open", () => {
    const onSelect = vi.fn();
    render(<PickerHarness onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: "Thumbs up" }));
    expect(onSelect).toHaveBeenCalledWith("👍");

    // Reopen the picker: Recent should now surface 👍 above Quick.
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

  it("provides Numbers (0-10) and all 26 Letters (A-Z) under the Numbers & Letters tab", () => {
    render(<PickerHarness />);

    fireEvent.click(screen.getByRole("tab", { name: "Numbers & Letters" }));

    const numbers = screen.getByRole("group", { name: "Numbers" });
    const letters = screen.getByRole("group", { name: "Letters" });

    expect(within(numbers).getAllByRole("button")).toHaveLength(11);
    expect(within(letters).getAllByRole("button")).toHaveLength(26);
    expect(
      within(letters).getByRole("button", { name: "Letter Z" }),
    ).toHaveTextContent("🅩");
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
