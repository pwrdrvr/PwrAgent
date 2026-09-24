import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDismissableLayer } from "../useDismissableLayer";
import { useModalDialog } from "../useModalDialog";
import { pressEscape, pressTab, walkTab } from "../../test/tab-walk";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const focusedLabel = (): string | undefined =>
  (document.activeElement as HTMLElement | null)?.textContent ?? undefined;

const button = (label: string): HTMLButtonElement =>
  screen.getByRole("button", { name: label });

function Modal(props: {
  label: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const ref = useModalDialog({ onClose: props.onClose });
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label={props.label}>
      <button type="button">{props.label} first</button>
      {props.children}
      <button type="button">{props.label} last</button>
    </div>,
    document.body,
  );
}

/** A Markdown viewer opening a second viewer from a link inside it. */
function NestedViewers() {
  const [outer, setOuter] = useState(true);
  const [inner, setInner] = useState(false);
  return (
    <>
      {outer ? (
        <Modal label="Outer" onClose={() => setOuter(false)}>
          <button type="button" onClick={() => setInner(true)}>
            Open linked document
          </button>
          {inner ? <Modal label="Inner" onClose={() => setInner(false)} /> : null}
        </Modal>
      ) : null}
    </>
  );
}

describe("useModalDialog, Escape", () => {
  it("closes the dialog and claims the key", () => {
    const onClose = vi.fn();
    const windowListener = vi.fn();
    const ancestorKeyDown = vi.fn();
    window.addEventListener("keydown", windowListener);
    render(
      <div onKeyDown={ancestorKeyDown}>
        <Modal label="Dialog" onClose={onClose} />
      </div>,
    );
    const event = pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    // ThreadFindBar and the composer's autocomplete listen on window; the
    // Star Map layer listens through the React tree the dialog portals out of.
    expect(windowListener).not.toHaveBeenCalled();
    expect(ancestorKeyDown).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowListener);
  });

  it("closes only the dialog on top", () => {
    render(<NestedViewers />);
    // A real click focuses the button; jsdom's click() does not.
    button("Open linked document").focus();
    act(() => button("Open linked document").click());
    expect(focusedLabel()).toBe("Inner first");
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Outer" })).toBeInTheDocument();
    expect(focusedLabel()).toBe("Open linked document");
    pressEscape();
    expect(screen.queryByRole("dialog", { name: "Outer" })).toBeNull();
  });

  it("gives Escape to the inner dialog when both mount in one commit", () => {
    // React runs child effects first, so the inner layer registers first.
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Modal label="Outer" onClose={outer}>
        <Modal label="Inner" onClose={inner} />
      </Modal>,
    );
    button("Inner first").focus();
    pressEscape();
    expect(inner).toHaveBeenCalledTimes(1);
    expect(outer).not.toHaveBeenCalled();
  });

  it("falls to the newest dialog when focus is nowhere", () => {
    const outer = vi.fn();
    const inner = vi.fn();
    render(
      <Modal label="Outer" onClose={outer}>
        <Modal label="Inner" onClose={inner} />
      </Modal>,
    );
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    pressEscape();
    expect(outer.mock.calls.length + inner.mock.calls.length).toBe(1);
  });

  it("claims nothing while focus sits in a surface it does not know", () => {
    const onClose = vi.fn();
    render(<Modal label="Dialog" onClose={onClose} />);
    const palette = document.createElement("input");
    document.body.appendChild(palette);
    palette.focus();
    const event = pressEscape();
    expect(onClose).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    palette.remove();
  });

  it("still claims the key when the dialog refuses to close", () => {
    const windowListener = vi.fn();
    window.addEventListener("keydown", windowListener);
    render(<Modal label="Saving" onClose={() => undefined} />);
    expect(pressEscape().defaultPrevented).toBe(true);
    expect(windowListener).not.toHaveBeenCalled();
    window.removeEventListener("keydown", windowListener);
  });

  it("leaves an Escape that cancels IME composition alone", () => {
    const onClose = vi.fn();
    render(<Modal label="Rename" onClose={onClose} />);
    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    act(() => {
      document.activeElement!.dispatchEvent(event);
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("reads the latest onClose without reordering the stack", () => {
    const first = vi.fn();
    const latest = vi.fn();
    const { rerender } = render(<Modal label="Dialog" onClose={first} />);
    rerender(<Modal label="Dialog" onClose={latest} />);
    pressEscape();
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

/** ProjectPicker inside the composer's Move to Project dialog. */
function Picker() {
  const [open, setOpen] = useState(false);
  const surfaceRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useDismissableLayer({
    open,
    onDismiss: () => setOpen(false),
    surfaceRef,
    triggerRef,
  });
  return (
    <span ref={surfaceRef}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        Choose a project
      </button>
      {open ? (
        <input aria-label="Find a directory" autoFocus />
      ) : null}
    </span>
  );
}

describe("useDismissableLayer inside a modal dialog", () => {
  it("closes the popup first, returns focus to its trigger, then the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal label="Move to Project" onClose={onClose}>
        <Picker />
      </Modal>,
    );
    act(() => button("Choose a project").click());
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Find a directory" }),
    );
    pressEscape();
    expect(screen.queryByRole("textbox", { name: "Find a directory" })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(focusedLabel()).toBe("Choose a project");
    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("useModalDialog, Tab", () => {
  it("keeps a 60-Tab walk inside the dialog in both directions", () => {
    const outside = document.createElement("button");
    outside.textContent = "Behind the dialog";
    document.body.appendChild(outside);
    render(<Modal label="Dialog" onClose={() => undefined} />);
    const dialog = screen.getByRole("dialog");
    expect(walkTab(60).every((el) => dialog.contains(el))).toBe(true);
    expect(walkTab(60, { shift: true }).every((el) => dialog.contains(el))).toBe(true);
    outside.remove();
  });

  it("walks the stacked dialog on top without the lower one pulling focus back", () => {
    render(<NestedViewers />);
    act(() => button("Open linked document").click());
    pressTab();
    expect(focusedLabel()).toBe("Inner last");
    pressTab();
    expect(focusedLabel()).toBe("Inner first");
  });
});
