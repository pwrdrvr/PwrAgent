import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useMenuFocus } from "../useMenuFocus";

function Harness() {
  const [open, setOpen] = useState(false);
  // Mirrors the sidebar menus: the first render is unplaced and hidden, and
  // a layout pass places it.
  const [placed, setPlaced] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useMenuFocus(menuRef, open && placed, () => {
    setOpen(false);
    setPlaced(false);
  });
  useLayoutEffect(() => {
    if (open && !placed) setPlaced(true);
  }, [open, placed]);
  const close = () => {
    setOpen(false);
    setPlaced(false);
  };
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open thread actions
      </button>
      {open ? (
        <div
          ref={menuRef}
          role="menu"
          style={{ visibility: placed ? undefined : "hidden" }}
        >
          <button role="menuitem" type="button" onClick={close}>
            Pin
          </button>
          <button disabled role="menuitem" type="button">
            Move Up
          </button>
          <button role="menuitem" type="button" onClick={close}>
            Rename Thread
          </button>
          <button role="menuitem" type="button" onClick={close}>
            Archive Thread
          </button>
        </div>
      ) : null}
    </>
  );
}

function openMenu(): HTMLElement {
  const opener = screen.getByRole("button", { name: "Open thread actions" });
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}

function item(name: string): HTMLElement {
  return screen.getByRole("menuitem", { name });
}

afterEach(() => {
  cleanup();
});

describe("useMenuFocus", () => {
  it("focuses the first item once the menu is placed", () => {
    render(<Harness />);
    openMenu();

    expect(item("Pin")).toHaveFocus();
  });

  it("moves between enabled items with the arrow keys, Home and End", () => {
    render(<Harness />);
    openMenu();

    fireEvent.keyDown(item("Pin"), { key: "ArrowDown" });
    expect(item("Rename Thread")).toHaveFocus();
    fireEvent.keyDown(item("Rename Thread"), { key: "ArrowDown" });
    expect(item("Archive Thread")).toHaveFocus();
    fireEvent.keyDown(item("Archive Thread"), { key: "ArrowDown" });
    expect(item("Pin")).toHaveFocus();
    fireEvent.keyDown(item("Pin"), { key: "ArrowUp" });
    expect(item("Archive Thread")).toHaveFocus();
    fireEvent.keyDown(item("Archive Thread"), { key: "Home" });
    expect(item("Pin")).toHaveFocus();
    fireEvent.keyDown(item("Pin"), { key: "End" });
    expect(item("Archive Thread")).toHaveFocus();
  });

  it("returns focus to the opener on Escape", () => {
    render(<Harness />);
    const opener = openMenu();

    fireEvent.keyDown(item("Pin"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("hands Tab back to the opener and lets it move on from there", () => {
    render(<Harness />);
    const opener = openMenu();

    const allowed = fireEvent.keyDown(item("Pin"), { key: "Tab" });

    expect(allowed).toBe(true);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("returns focus to the opener when an item closes the menu", () => {
    render(<Harness />);
    const opener = openMenu();
    act(() => item("Archive Thread").focus());

    fireEvent.click(item("Archive Thread"));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(opener).toHaveFocus();
  });
});
