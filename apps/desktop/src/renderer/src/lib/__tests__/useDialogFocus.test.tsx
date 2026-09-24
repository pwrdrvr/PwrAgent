import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDialogFocus } from "../useDialogFocus";

function Dialog(props: {
  onClose: () => void;
  onEscape?: () => void;
  returnFocus?: () => HTMLElement | null | undefined;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useDialogFocus(dialogRef, true, {
    initialFocus: cancelRef,
    onEscape: props.onEscape ?? props.onClose,
    returnFocus: props.returnFocus,
  });
  return (
    <div ref={dialogRef} aria-modal="true" aria-label="Confirm" role="dialog">
      <input aria-label="Reason" />
      <button ref={cancelRef} type="button" onClick={props.onClose}>
        Cancel
      </button>
      <button type="button" onClick={props.onClose}>
        Confirm
      </button>
    </div>
  );
}

function Harness(props: { onEscape?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Elsewhere</button>
      {open ? (
        <Dialog onClose={() => setOpen(false)} onEscape={props.onEscape} />
      ) : null}
    </>
  );
}

function openDialog(): HTMLElement {
  const opener = screen.getByRole("button", { name: "Open" });
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}

afterEach(() => {
  cleanup();
});

describe("useDialogFocus", () => {
  it("moves focus to the initial control and returns it to the opener on close", () => {
    render(<Harness />);
    const opener = openDialog();

    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab inside the dialog", () => {
    render(<Harness />);
    openDialog();
    const reason = screen.getByRole("textbox", { name: "Reason" });
    const confirm = screen.getByRole("button", { name: "Confirm" });

    act(() => confirm.focus());
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(reason).toHaveFocus();

    fireEvent.keyDown(reason, { key: "Tab", shiftKey: true });
    expect(confirm).toHaveFocus();

    // Focus that got behind the backdrop comes back in on the next Tab.
    act(() => screen.getByRole("button", { name: "Elsewhere" }).focus());
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    expect(reason).toHaveFocus();
  });

  it("leaves a Tab between two inner stops to the browser", () => {
    render(<Harness />);
    openDialog();
    const cancel = screen.getByRole("button", { name: "Cancel" });

    const allowed = fireEvent.keyDown(cancel, { key: "Tab" });

    expect(allowed).toBe(true);
    expect(cancel).toHaveFocus();
  });

  it("calls onEscape from any control inside the dialog", () => {
    const onEscape = vi.fn();
    render(<Harness onEscape={onEscape} />);
    openDialog();

    fireEvent.keyDown(screen.getByRole("button", { name: "Confirm" }), {
      key: "Escape",
    });

    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("keeps focus that a close moved on purpose", () => {
    function MovesFocus() {
      const [open, setOpen] = useState(true);
      const nextRef = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button ref={nextRef} type="button">
            Next
          </button>
          {open ? (
            <Dialog
              onClose={() => {
                nextRef.current?.focus();
                setOpen(false);
              }}
            />
          ) : null}
        </>
      );
    }
    const opener = document.createElement("button");
    document.body.append(opener);
    act(() => opener.focus());
    render(<MovesFocus />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();
    opener.remove();
  });

  it("falls back to returnFocus when the opener unmounted on the way", () => {
    const anchor = document.createElement("button");
    anchor.textContent = "Row actions";
    document.body.append(anchor);
    function Fallback() {
      const [open, setOpen] = useState(true);
      return open ? (
        <Dialog onClose={() => setOpen(false)} returnFocus={() => anchor} />
      ) : null;
    }
    render(<Fallback />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(anchor).toHaveFocus();
    anchor.remove();
  });
});
