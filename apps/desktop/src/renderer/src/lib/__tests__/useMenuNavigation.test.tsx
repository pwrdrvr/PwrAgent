import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StrictMode, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMenuNavigation } from "../useMenuNavigation";
import { useModalDialog } from "../useModalDialog";
import { pressEscape, pressKey, pressTab } from "../../test/tab-walk";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

const button = (label: string): HTMLButtonElement =>
  screen.getByRole("button", { name: label });

type Item = { label: string; disabled?: boolean; closes?: boolean };

/**
 * A menu button whose menu portals to <body>, as the sidebar's menus render
 * outside the row that opened them.
 */
function MenuButton(props: {
  items: Item[];
  menuTabIndex?: number;
  onSelect?: (label: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuNavigation({
    open,
    menuRef,
    triggerRef,
    onClose: () => setOpen(false),
  });
  return (
    <>
      <button type="button">Before trigger</button>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        Actions
      </button>
      <button type="button">After trigger</button>
      <button type="button" onClick={() => setOpen(false)}>
        Close from outside
      </button>
      {open
        ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Actions"
            tabIndex={props.menuTabIndex}
          >
            {props.items.map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  props.onSelect?.(item.label);
                  if (item.closes !== false) setOpen(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body,
        )
        : null}
    </>
  );
}

/** Opens the menu the way the keyboard does: focus the trigger, press it. */
function openMenu(): void {
  // A real click focuses the button; jsdom's click() does not.
  button("Actions").focus();
  act(() => button("Actions").click());
}

const ITEMS: Item[] = [
  { label: "Disabled first", disabled: true },
  { label: "Pin" },
  { label: "Rename" },
  { label: "Disabled middle", disabled: true },
  { label: "Archive" },
];

function Modal(props: { onClose: () => void; children?: ReactNode }) {
  const ref = useModalDialog({ onClose: props.onClose });
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Dialog">
      <button type="button">Dialog first</button>
      {props.children}
      <button type="button">Dialog last</button>
    </div>,
    document.body,
  );
}

describe("useMenuNavigation, opening", () => {
  it("moves focus to the first enabled item", () => {
    render(
      <StrictMode>
        <MenuButton items={ITEMS} />
      </StrictMode>,
    );
    openMenu();
    expect(focusedLabel()).toBe("Pin");
  });

  it("focuses the menu itself when every item is disabled", () => {
    render(
      <MenuButton
        items={[{ label: "Only", disabled: true }]}
        menuTabIndex={-1}
      />,
    );
    openMenu();
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    pressTab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("After trigger");
  });
});

describe("useMenuNavigation, arrows", () => {
  it("steps through enabled items and wraps at both ends", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    const visited: Array<string | undefined> = [];
    for (let i = 0; i < 4; i++) {
      pressKey("ArrowDown");
      visited.push(focusedLabel());
    }
    expect(visited).toEqual(["Rename", "Archive", "Pin", "Rename"]);
    pressKey("ArrowUp");
    expect(focusedLabel()).toBe("Pin");
    pressKey("ArrowUp");
    expect(focusedLabel()).toBe("Archive");
  });

  it("jumps to either end with Home and End", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    pressKey("End");
    expect(focusedLabel()).toBe("Archive");
    pressKey("Home");
    expect(focusedLabel()).toBe("Pin");
  });

  it("claims the arrows it spends and leaves modified ones alone", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    expect(pressKey("ArrowDown").defaultPrevented).toBe(true);
    const chord = new KeyboardEvent("keydown", {
      key: "ArrowDown",
      metaKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.activeElement!.dispatchEvent(chord);
    });
    expect(chord.defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("Rename");
  });

  it("does not steer arrows while focus is outside the menu", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    button("Before trigger").focus();
    expect(pressKey("ArrowDown").defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("Before trigger");
  });
});

describe("useMenuNavigation, closing", () => {
  it("closes on Escape, returns focus to the trigger, and claims the key", () => {
    const windowListener = vi.fn();
    window.addEventListener("keydown", windowListener);
    render(<MenuButton items={ITEMS} />);
    openMenu();
    const event = pressEscape();
    window.removeEventListener("keydown", windowListener);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(event.defaultPrevented).toBe(true);
    // The find bar and the composer's autocomplete close on an Escape that
    // reaches window unclaimed.
    expect(windowListener).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe("Actions");
  });

  it("closes on Tab and moves on from the trigger", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    pressKey("ArrowDown");
    pressTab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("After trigger");
  });

  it("closes on Shift+Tab and moves back from the trigger", () => {
    render(<MenuButton items={ITEMS} />);
    openMenu();
    pressTab({ shift: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("Before trigger");
  });

  it("returns focus to the trigger after an item closes the menu", () => {
    const onSelect = vi.fn();
    render(<MenuButton items={ITEMS} onSelect={onSelect} />);
    openMenu();
    pressKey("ArrowDown");
    act(() => (document.activeElement as HTMLElement).click());
    expect(onSelect).toHaveBeenCalledWith("Rename");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("Actions");
  });

  it("leaves focus alone when the menu closes without holding it", () => {
    // A click on blank space outside drops focus to <body> before the
    // sidebar's window listener closes the menu. That is not a keyboard
    // close, and focus must not jump back to the trigger.
    render(<MenuButton items={ITEMS} />);
    openMenu();
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => button("Close from outside").click());
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });
});

describe("useMenuNavigation, over a dialog", () => {
  it("takes the Escape, and the dialog takes the next one", () => {
    const onCloseDialog = vi.fn();
    render(
      <Modal onClose={onCloseDialog}>
        <MenuButton items={ITEMS} />
      </Modal>,
    );
    openMenu();
    expect(focusedLabel()).toBe("Pin");
    pressEscape();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onCloseDialog).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe("Actions");
    pressEscape();
    expect(onCloseDialog).toHaveBeenCalledTimes(1);
  });

  it("closes on Tab without letting focus out of the dialog", () => {
    // The menu portals out of the dialog's trap. The trap sees Tab first, in
    // its capture listener, and must leave the menu to close itself.
    render(
      <Modal onClose={() => undefined}>
        <MenuButton items={ITEMS} />
      </Modal>,
    );
    openMenu();
    pressTab();
    expect(screen.queryByRole("menu")).toBeNull();
    // On the trigger, not the dialog's first control: the trap's deferred
    // check finds focus already back inside and leaves it there.
    expect(focusedLabel()).toBe("Actions");
    expect(screen.getByRole("dialog")).toContainElement(
      document.activeElement as HTMLElement,
    );
  });
});
