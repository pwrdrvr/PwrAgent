import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pressTab } from "../../../test/tab-walk";
import { ThreadLockDialog, type ThreadLockDialogProps } from "../ThreadLockDialog";

const RECENTS = ["Claude Design", "Waiting on PR review", "Handed to repair thread"];

function recentNotesApi(notes: string[] = RECENTS) {
  return {
    listRecentThreadLockNotes: vi.fn(async () => ({ notes })),
    rememberThreadLockNote: vi.fn(async ({ note }: { note: string }) => ({ notes: [note, ...notes] })),
  };
}

async function renderDialog(overrides: Partial<ThreadLockDialogProps> = {}) {
  const props: ThreadLockDialogProps = {
    threadTitle: "Sandboxer remote compute",
    mode: "lock",
    onCancel: vi.fn(),
    onSubmit: vi.fn(async () => undefined),
    recentNotesApi: recentNotesApi(),
    ...overrides,
  };
  render(<ThreadLockDialog {...props} />);
  if (props.recentNotesApi?.listRecentThreadLockNotes) {
    await screen.findByRole("group", { name: "Recent notes" });
  }
  return props;
}

function chip(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

function press(key: string) {
  act(() => {
    fireEvent.keyDown(document.activeElement ?? document.body, { key });
  });
}

describe("ThreadLockDialog recent notes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("offers recent notes as chips, none of them chosen on an empty note", async () => {
    await renderDialog();
    const group = screen.getByRole("group", { name: "Recent notes" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((button) => button.textContent)).toEqual(RECENTS);
    expect(chips.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "false", "false"]);
  });

  it("draws no row when nothing was remembered", async () => {
    const api = recentNotesApi([]);
    render(
      <ThreadLockDialog
        mode="lock"
        recentNotesApi={api}
        threadTitle="Sandboxer remote compute"
        onCancel={vi.fn()}
        onSubmit={vi.fn(async () => undefined)}
      />,
    );
    await waitFor(() => expect(api.listRecentThreadLockNotes).toHaveBeenCalled());
    expect(screen.queryByRole("group", { name: "Recent notes" })).toBeNull();
  });

  it("marks the chip matching the current note as pressed", async () => {
    await renderDialog({ mode: "edit", initialNote: "Claude Design" });
    expect(chip("Claude Design").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Waiting on PR review").getAttribute("aria-pressed")).toBe("false");
  });

  it("is one Tab stop: Tab from the note lands on the first chip, then leaves for Cancel", async () => {
    await renderDialog();
    const note = screen.getByRole("textbox", { name: "Note" });
    expect(document.activeElement).toBe(note);

    pressTab();
    expect(document.activeElement).toBe(chip("Claude Design"));
    pressTab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("enters the row on the chip matching the note", async () => {
    await renderDialog({ mode: "edit", initialNote: "Waiting on PR review" });
    pressTab();
    expect(document.activeElement).toBe(chip("Waiting on PR review"));
  });

  it("moves between chips with the arrows, Home and End, without wrapping", async () => {
    await renderDialog();
    pressTab();
    press("ArrowRight");
    expect(document.activeElement).toBe(chip("Waiting on PR review"));
    press("End");
    expect(document.activeElement).toBe(chip("Handed to repair thread"));
    press("ArrowRight");
    expect(document.activeElement).toBe(chip("Handed to repair thread"));
    press("Home");
    expect(document.activeElement).toBe(chip("Claude Design"));
    press("ArrowLeft");
    expect(document.activeElement).toBe(chip("Claude Design"));
  });

  it("fills the note from a chip and hands focus to the primary button", async () => {
    const props = await renderDialog();
    pressTab();
    press("ArrowRight");
    fireEvent.click(document.activeElement as HTMLElement);

    const note = screen.getByRole("textbox", { name: "Note" }) as HTMLTextAreaElement;
    expect(note.value).toBe("Waiting on PR review");
    expect(chip("Waiting on PR review").getAttribute("aria-pressed")).toBe("true");
    const lock = screen.getByRole("button", { name: "Lock Thread" });
    expect(document.activeElement).toBe(lock);
    // Picking a chip never saves on its own.
    expect(props.onSubmit).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(lock);
    });
    expect(props.onSubmit).toHaveBeenCalledWith("Waiting on PR review");
  });

  it("remembers a note only once the lock is saved", async () => {
    const api = recentNotesApi();
    const onSubmit = vi.fn(async (_note: string): Promise<void> => {
      throw new Error("Thread is gone.");
    });
    await renderDialog({ onSubmit, recentNotesApi: api });
    const note = screen.getByRole("textbox", { name: "Note" });
    fireEvent.change(note, { target: { value: "Pairing with design" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lock Thread" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Thread is gone.");
    expect(api.rememberThreadLockNote).not.toHaveBeenCalled();

    onSubmit.mockImplementation(async () => undefined);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lock Thread" }));
    });
    expect(api.rememberThreadLockNote).toHaveBeenCalledWith({ note: "Pairing with design" });
  });

  it("still locks when remembering the note fails", async () => {
    const api = recentNotesApi();
    api.rememberThreadLockNote.mockRejectedValue(new Error("database is locked"));
    const props = await renderDialog({ recentNotesApi: api });
    fireEvent.change(screen.getByRole("textbox", { name: "Note" }), { target: { value: "Claude Design" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Lock Thread" }));
    });
    expect(props.onSubmit).toHaveBeenCalledWith("Claude Design");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
