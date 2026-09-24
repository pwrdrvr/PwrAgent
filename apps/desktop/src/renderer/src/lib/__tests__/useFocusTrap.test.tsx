import { act, cleanup, render, screen } from "@testing-library/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFocusTrap } from "../useFocusTrap";
import { pressTab } from "../../test/tab-walk";

let opener: HTMLButtonElement;

beforeEach(() => {
  opener = document.createElement("button");
  opener.textContent = "Opener";
  document.body.appendChild(opener);
  opener.focus();
});

afterEach(() => {
  cleanup();
  opener.remove();
  vi.restoreAllMocks();
});

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

const button = (label: string): HTMLButtonElement =>
  screen.getByRole("button", { name: label });

function Dialog(props: {
  open: boolean;
  hideMiddle?: boolean;
  autoFocusLast?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: props.open, containerRef: ref });
  if (!props.open) return null;
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button
        type="button"
        style={props.hideMiddle ? { display: "none" } : undefined}
      >
        Middle
      </button>
      <button type="button" autoFocus={props.autoFocusLast}>
        Last
      </button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves focus into the dialog on open", () => {
    render(<Dialog open />);
    expect(focusedLabel()).toBe("First");
  });

  it("wraps Tab from the last control to the first", () => {
    render(<Dialog open />);
    button("Last").focus();
    expect(pressTab().defaultPrevented).toBe(true);
    expect(focusedLabel()).toBe("First");
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    render(<Dialog open />);
    pressTab({ shift: true });
    expect(focusedLabel()).toBe("Last");
  });

  it("leaves a mid-cycle Tab to the browser", () => {
    render(<Dialog open />);
    expect(pressTab().defaultPrevented).toBe(false);
    expect(focusedLabel()).toBe("Middle");
  });

  it("pulls focus back when it has left the dialog", () => {
    render(<Dialog open />);
    opener.focus();
    pressTab();
    expect(focusedLabel()).toBe("First");
    opener.focus();
    pressTab({ shift: true });
    expect(focusedLabel()).toBe("Last");
  });

  it("sends Shift+Tab from the focused container to the last control", () => {
    // ImageLightbox opens with focus on its frame, the trap's own container,
    // and a click on a dialog's blank area focuses a tabIndex={-1} container.
    render(<Dialog open />);
    const dialog = screen.getByRole("dialog");
    dialog.focus();
    pressTab({ shift: true });
    expect(focusedLabel()).toBe("Last");
    dialog.focus();
    pressTab();
    expect(focusedLabel()).toBe("First");
  });

  it("skips a hidden control when it works out the edges", () => {
    render(<Dialog open hideMiddle />);
    button("Last").focus();
    pressTab({ shift: true });
    expect(focusedLabel()).toBe("First");
  });

  it("returns focus to whatever opened it", () => {
    const { rerender } = render(<Dialog open={false} />);
    rerender(<Dialog open />);
    expect(focusedLabel()).toBe("First");
    rerender(<Dialog open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it("captures the opener before autoFocus moves focus inside", () => {
    // React applies autoFocus while committing, before any effect can look.
    const { rerender } = render(<Dialog open={false} />);
    rerender(<Dialog open autoFocusLast />);
    rerender(<Dialog open={false} />);
    expect(document.activeElement).toBe(opener);
  });

  it("leaves focus alone when the caller moved it out deliberately", () => {
    const { rerender } = render(<Dialog open />);
    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    rerender(<Dialog open={false} />);
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("does not resurrect an opener that has been unmounted", () => {
    const { rerender } = render(<Dialog open />);
    opener.remove();
    expect(() => rerender(<Dialog open={false} />)).not.toThrow();
  });
});

/**
 * A dialog opened from a menu item. The menu closes in the same commit that
 * mounts the dialog, so the item the trap captured is gone by the time the
 * dialog closes.
 */
function MenuLaunched(props: { linkById?: boolean }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <span className="menu-shell">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-controls={props.linkById && menuOpen ? "actions-menu" : undefined}
          onClick={() => setMenuOpen(true)}
        >
          Actions
        </button>
        {menuOpen ? (
          <div role="menu" id={props.linkById ? "actions-menu" : undefined}>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                setDialogOpen(true);
              }}
            >
              Rename…
            </button>
          </div>
        ) : null}
      </span>
      <Dialog open={dialogOpen} />
      {dialogOpen ? (
        <button type="button" onClick={() => setDialogOpen(false)}>
          Close dialog
        </button>
      ) : null}
    </>
  );
}

describe("useFocusTrap, opened from a menu item", () => {
  it.each([
    ["the trigger beside the menu", false],
    ["the trigger that names the menu in aria-controls", true],
  ])("returns focus to %s", (_label, linkById) => {
    render(<MenuLaunched linkById={linkById} />);
    act(() => button("Actions").click());
    const item = screen.getByRole("menuitem");
    item.focus();
    act(() => item.click());
    expect(focusedLabel()).toBe("First");
    act(() => button("Close dialog").click());
    expect(document.activeElement).toBe(button("Actions"));
  });
});

/** A caller that knows where focus belongs once the opener is gone. */
function WithReturnTarget(props: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  useFocusTrap({ open: props.open, containerRef: ref, returnFocusRef: backRef });
  return (
    <>
      <button ref={backRef} type="button">Row actions</button>
      {props.open ? (
        <div ref={ref} role="dialog" tabIndex={-1}>
          <button type="button">Only</button>
        </div>
      ) : null}
    </>
  );
}

describe("useFocusTrap, with a return target", () => {
  it("returns focus there once the opener is gone", () => {
    const { rerender } = render(<WithReturnTarget open={false} />);
    rerender(<WithReturnTarget open />);
    opener.remove();
    rerender(<WithReturnTarget open={false} />);
    expect(document.activeElement).toBe(button("Row actions"));
  });

  it("still prefers the opener while it is in the document", () => {
    const { rerender } = render(<WithReturnTarget open={false} />);
    rerender(<WithReturnTarget open />);
    rerender(<WithReturnTarget open={false} />);
    expect(document.activeElement).toBe(opener);
  });
});

/** A second trap in its own subtree, as a nested Markdown viewer portals. */
function Stacked(props: { upper: boolean }) {
  const lowerRef = useRef<HTMLDivElement>(null);
  const upperRef = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: lowerRef });
  useFocusTrap({ open: props.upper, containerRef: upperRef });
  return (
    <div>
      <div ref={lowerRef} role="dialog" tabIndex={-1}>
        <button type="button">Lower first</button>
        <button type="button">Lower last</button>
      </div>
      {props.upper ? (
        <div ref={upperRef} role="alertdialog" tabIndex={-1}>
          <button type="button">Upper first</button>
          <button type="button">Upper middle</button>
          <button type="button">Upper last</button>
        </div>
      ) : null}
    </div>
  );
}

describe("useFocusTrap, stacked", () => {
  it("lets only the upper dialog answer Tab while it is open", () => {
    const { rerender } = render(<Stacked upper={false} />);
    rerender(<Stacked upper />);
    expect(focusedLabel()).toBe("Upper first");
    pressTab();
    expect(focusedLabel()).toBe("Upper middle");
    pressTab();
    expect(focusedLabel()).toBe("Upper last");
    pressTab();
    expect(focusedLabel()).toBe("Upper first");
    pressTab({ shift: true });
    expect(focusedLabel()).toBe("Upper last");
  });

  it("pulls stray focus into the upper dialog, not the one beneath it", () => {
    const { rerender } = render(<Stacked upper={false} />);
    rerender(<Stacked upper />);
    opener.focus();
    pressTab();
    expect(focusedLabel()).toBe("Upper first");
  });

  it("hands Tab back to the lower dialog once the upper one closes", () => {
    const { rerender } = render(<Stacked upper={false} />);
    button("Lower last").focus();
    rerender(<Stacked upper />);
    rerender(<Stacked upper={false} />);
    expect(focusedLabel()).toBe("Lower last");
    pressTab();
    expect(focusedLabel()).toBe("Lower first");
  });
});

/** A dialog with a scrolling body after its last control. */
function Scrolly(props: { nestButton?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap({ open: true, containerRef: ref });
  return (
    <div ref={ref} role="dialog" tabIndex={-1}>
      <button type="button">Open in editor</button>
      <button type="button">Close</button>
      <div className="doc-body" style={{ overflowY: "auto" }}>
        <p>A long document.</p>
        {props.nestButton ? <button type="button">Copy path</button> : null}
      </div>
    </div>
  );
}

describe("useFocusTrap, keyboard-focusable scrollers", () => {
  /** jsdom does no layout; give the body the overflow Chromium would see. */
  function overflow(el: HTMLElement): void {
    Object.defineProperty(el, "scrollHeight", { configurable: true, value: 900 });
    Object.defineProperty(el, "clientHeight", { configurable: true, value: 400 });
  }
  const body = (): HTMLElement => document.querySelector<HTMLElement>(".doc-body")!;

  it("still lands initial focus on the first control", () => {
    render(<Scrolly />);
    overflow(body());
    expect(focusedLabel()).toBe("Open in editor");
  });

  it("leaves Tab from the last button to the browser, which reaches the body", () => {
    render(<Scrolly />);
    overflow(body());
    button("Close").focus();
    const event = new KeyboardEvent("keydown", {
      key: "Tab",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      document.activeElement!.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it("wraps Shift+Tab from the first button to the body", () => {
    render(<Scrolly />);
    overflow(body());
    // jsdom will not focus a div without a tabindex; Chromium does.
    const focus = vi.spyOn(body(), "focus");
    pressTab({ shift: true });
    expect(focus).toHaveBeenCalled();
  });

  it("does not count a body that does not overflow", () => {
    render(<Scrolly />);
    button("Close").focus();
    pressTab();
    expect(focusedLabel()).toBe("Open in editor");
  });

  it("does not count a body that holds a control of its own", () => {
    render(<Scrolly nestButton />);
    overflow(body());
    const focus = vi.spyOn(body(), "focus");
    button("Copy path").focus();
    pressTab();
    expect(focus).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe("Open in editor");
  });
});

/** A menu portalled out of the dialog that closes itself on Tab. */
function PortalMenu(props: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { onClose } = props;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    // The ARIA menu pattern: Tab closes the menu, while focus is in it.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Tab" && ref.current?.contains(document.activeElement)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return createPortal(
    <div ref={ref} role="menu">
      <button type="button" role="menuitem" tabIndex={-1}>
        Copy
      </button>
    </div>,
    document.body,
  );
}

function DialogWithMenu() {
  const ref = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState(false);
  useFocusTrap({ open: true, containerRef: ref });
  return (
    <>
      <div ref={ref} role="dialog" tabIndex={-1}>
        <button type="button" onClick={() => setMenu(true)}>
          First
        </button>
        <button type="button">Last</button>
      </div>
      {menu ? <PortalMenu onClose={() => setMenu(false)} /> : null}
    </>
  );
}

describe("useFocusTrap, a menu portalled out of the dialog", () => {
  function openMenu(): void {
    render(<DialogWithMenu />);
    act(() => button("First").click());
    expect(focusedLabel()).toBe("Copy");
  }

  it("lets Tab close the menu, then lands focus back in the dialog", () => {
    openMenu();
    pressTab();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("First");
  });

  it("lands Shift+Tab from the menu on the dialog's last control", () => {
    openMenu();
    pressTab({ shift: true });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(focusedLabel()).toBe("Last");
  });
});
