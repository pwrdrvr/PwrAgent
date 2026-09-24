import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarMapCardMenu } from "../StarMapCardMenu";
import { StarMapRenameDialog } from "../StarMapRenameDialog";
import { pressEscape, tabEscapes } from "../../../test/tab-walk";

afterEach(() => {
  cleanup();
});

/** The card kebab opens the dialog, as the map does. */
function Host(props: { onLayerKeyDown?: (key: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  return (
    <div onKeyDown={(event) => props.onLayerKeyDown?.(event.key)}>
      <StarMapCardMenu
        threadTitle="Sprocket cache"
        actions={[
          { key: "rename", label: "Rename", onSelect: () => setRenaming(true) },
        ]}
      />
      {renaming ? (
        <StarMapRenameDialog
          currentTitle="Sprocket cache"
          onCancel={() => setRenaming(false)}
          onSubmit={() => setRenaming(false)}
        />
      ) : null}
    </div>
  );
}

function open(props: { onLayerKeyDown?: (key: string) => void } = {}): HTMLElement {
  render(<Host {...props} />);
  const kebab = screen.getByRole("button", { name: "Actions for Sprocket cache" });
  kebab.focus();
  act(() => kebab.click());
  const item = screen.getByRole("menuitem", { name: "Rename" });
  item.focus();
  act(() => item.click());
  return screen.getByRole("dialog", { name: "Rename Sprocket cache" });
}

describe("StarMapRenameDialog, keyboard", () => {
  it("opens with the name selected in its field", () => {
    open();
    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Thread name" }),
    );
  });

  it("keeps Tab inside the dialog", () => {
    const dialog = open();
    expect(tabEscapes(dialog)).toEqual({ forward: [], backward: [] });
  });

  it("cancels on Escape without the map seeing the key", () => {
    const onLayerKeyDown = vi.fn();
    open({ onLayerKeyDown });
    pressEscape();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onLayerKeyDown).not.toHaveBeenCalledWith("Escape");
  });

  it("returns focus to the kebab the menu item was in", () => {
    // The menu item that opened the dialog is gone by the time it closes.
    open();
    pressEscape();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Actions for Sprocket cache" }),
    );
  });
});
