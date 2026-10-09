import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KeybindingWriteRequest,
  KeybindingsSnapshot,
} from "../../../../../shared/keybindings";
import { _resetKeybindingsStoreForTests } from "../../../lib/keybindings-store";
import { KeyboardSettings } from "../KeyboardSettings";

const FILE_PATH = "/Users/operator/.pwragent/keybindings.toml";

/** A bridge whose file is a map in memory, written the way main writes it. */
function installKeybindingsApi(
  initial: Record<string, string[]> = {},
  options: { readError?: string } = {},
) {
  let overrides: Record<string, string[]> = { ...initial };
  const snapshot = (): KeybindingsSnapshot => ({ overrides: { ...overrides }, filePath: FILE_PATH });
  const writes: KeybindingWriteRequest[] = [];
  const writeKeybindings = vi.fn(async (request: KeybindingWriteRequest) => {
    writes.push(request);
    if (request.kind === "reset_all") {
      overrides = {};
    } else if (request.kind === "reset") {
      const { [request.actionId]: _removed, ...rest } = overrides;
      overrides = rest;
    } else {
      overrides = { ...overrides, [request.actionId]: [...request.chords] };
    }
    return snapshot();
  });
  Object.defineProperty(window, "pwragent", {
    configurable: true,
    value: {
      platform: "darwin",
      readKeybindings: async () => options.readError === undefined
        ? snapshot()
        : { ...snapshot(), error: options.readError },
      writeKeybindings,
      onKeybindingsChanged: () => () => undefined,
    },
  });
  return { writes, writeKeybindings };
}

function row(name: string): HTMLElement {
  return screen.getByText(name, { selector: ".settings-keyboard__name" }).closest("li")!;
}

async function renderPage() {
  render(<KeyboardSettings />);
  // The first read replaces the defaults with the file's overrides.
  await act(async () => undefined);
}

/** Press a chord and let its key go, as the recorder saves on release. */
function press(target: HTMLElement, init: KeyboardEventInit) {
  fireEvent.keyDown(target, init);
  fireEvent.keyUp(target, init);
}

beforeEach(() => {
  _resetKeybindingsStoreForTests();
});

afterEach(() => {
  cleanup();
  act(() => _resetKeybindingsStoreForTests());
  delete (window as Window & { pwragent?: unknown }).pwragent;
});

describe("KeyboardSettings", () => {
  it("lists every action with its chords in macOS notation", async () => {
    installKeybindingsApi();
    await renderPage();

    expect(screen.getByText(/apply to every profile on this machine/)).toBeInTheDocument();
    const rename = within(row("Rename Thread"));
    expect(rename.getByText("⌥⌘R")).toBeInTheDocument();
    expect(rename.getByText("F2")).toBeInTheDocument();
    expect(within(row("Keep at Top")).getByText("Not set")).toBeInTheDocument();
    expect(within(row("Quit")).getByText("⌘Q")).toBeInTheDocument();
    expect(screen.getByText(FILE_PATH)).toBeInTheDocument();
  });

  it("records a new chord and saves it", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" });
    expect(recorder).toHaveFocus();
    // Option composes "π"; the recorder reads the physical key.
    press(recorder, { key: "π", code: "KeyP", metaKey: true, altKey: true });

    await waitFor(() => expect(writes).toEqual([
      { kind: "set", actionId: "threads.toggle_pin", chords: ["CmdOrCtrl+Alt+P"] },
    ]));
    // The write is logged when it starts; the row leaves recording once it
    // resolves, which a slow runner can see later.
    expect(await within(row("Pin / Unpin")).findByText("⌥⌘P")).toBeInTheDocument();
    expect(within(row("Pin / Unpin")).getByRole("img", { name: "Changed" })).toBeInTheDocument();
  });

  it("names a clash and moves the chord only when asked", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" });
    press(recorder, { key: "f", code: "KeyF", metaKey: true, shiftKey: true });

    const notice = within(row("Pin / Unpin")).getByRole("alert");
    expect(notice).toHaveTextContent("⇧⌘F runs Search Threads.");
    expect(writes).toEqual([]);

    fireEvent.click(within(notice).getByRole("button", { name: "Move It Here" }));
    await waitFor(() => expect(writes).toEqual([
      { kind: "set", actionId: "navigation.search_threads", chords: [] },
      { kind: "set", actionId: "threads.toggle_pin", chords: ["CmdOrCtrl+Shift+F"] },
    ]));
    // The loss is visible: Search Threads reads Not set, with Reset.
    expect(await within(row("Pin / Unpin")).findByText("⇧⌘F")).toBeInTheDocument();
    expect(within(row("Search Threads")).getByText("Not set")).toBeInTheDocument();
    expect(within(row("Search Threads")).getByRole("button", { name: "Reset Search Threads" }))
      .toBeInTheDocument();
  });

  it("refuses a chord the system keeps, with its reason", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Mark Unread / Read" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Mark Unread / Read" });
    press(recorder, { key: "h", code: "KeyH", metaKey: true });
    expect(within(row("Mark Unread / Read")).getByRole("alert"))
      .toHaveTextContent("macOS uses ⌘H to hide the app.");

    press(recorder, { key: "e", code: "KeyE" });
    expect(within(row("Mark Unread / Read")).getByRole("alert"))
      .toHaveTextContent("Needs a modifier");
    expect(writes).toEqual([]);
  });

  it("shows the keys as they are held, and saves only when they are let go", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" });
    expect(recorder).toHaveAccessibleDescription("Press the keys together, then let go. Escape cancels.");

    fireEvent.keyDown(recorder, { key: "Meta", code: "MetaLeft", metaKey: true });
    fireEvent.keyDown(recorder, { key: "Shift", code: "ShiftLeft", metaKey: true, shiftKey: true });
    expect(within(recorder).getByText("⇧⌘")).toBeInTheDocument();
    expect(recorder).toHaveAccessibleDescription("Keep holding, and press another key.");

    fireEvent.keyDown(recorder, { key: "k", code: "KeyK", metaKey: true, shiftKey: true });
    expect(within(recorder).getByText("⇧⌘K")).toBeInTheDocument();
    expect(recorder).toHaveAccessibleDescription("Let go to save ⇧⌘K.");
    expect(writes).toEqual([]);

    // macOS may drop K's own keyup while ⌘ is down; letting go of ⌘ saves.
    fireEvent.keyUp(recorder, { key: "Meta", code: "MetaLeft", shiftKey: true });
    await waitFor(() => expect(writes).toEqual([
      { kind: "set", actionId: "threads.toggle_pin", chords: ["CmdOrCtrl+Shift+K"] },
    ]));
    expect(await within(row("Pin / Unpin")).findByText("⇧⌘K")).toBeInTheDocument();
  });

  it("drops a modifier from the preview when it is let go", async () => {
    installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" });
    fireEvent.keyDown(recorder, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.keyDown(recorder, { key: "Meta", code: "MetaLeft", altKey: true, metaKey: true });
    expect(within(recorder).getByText("⌥⌘")).toBeInTheDocument();
    fireEvent.keyUp(recorder, { key: "Alt", code: "AltLeft", metaKey: true });
    expect(within(recorder).getByText("⌘")).toBeInTheDocument();
  });

  it("records the letter printed on the key", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    // AZERTY: the key printed M sits where QWERTY has ;.
    press(
      screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" }),
      { key: "M", code: "Semicolon", metaKey: true, shiftKey: true },
    );
    await waitFor(() => expect(writes).toEqual([
      { kind: "set", actionId: "threads.toggle_pin", chords: ["CmdOrCtrl+Shift+M"] },
    ]));
  });

  it("waits out an input method, and says Backspace does not clear", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Pin / Unpin" }));
    const recorder = screen.getByRole("textbox", { name: "Record a shortcut for Pin / Unpin" });
    fireEvent.keyDown(recorder, { key: "Process", code: "KeyK", metaKey: true, isComposing: true });
    expect(within(row("Pin / Unpin")).getByRole("alert"))
      .toHaveTextContent("Finish typing in the input method, then press a shortcut.");

    press(recorder, { key: "Backspace", code: "Backspace" });
    expect(within(row("Pin / Unpin")).getByRole("alert"))
      .toHaveTextContent("Backspace does not clear a shortcut. Use the × beside a shortcut to remove it.");
    expect(writes).toEqual([]);
  });

  it("cancels on Escape without saving", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Rename Thread" }));
    press(screen.getByRole("textbox", { name: "Record a shortcut for Rename Thread" }), { key: "Escape" });

    expect(screen.queryByRole("textbox", { name: /Record a shortcut/ })).not.toBeInTheDocument();
    expect(writes).toEqual([]);
  });

  it("notes a chord that edits text, and still saves it", async () => {
    const { writes } = installKeybindingsApi();
    await renderPage();

    fireEvent.click(screen.getByRole("button", { name: "Change Back" }));
    press(
      screen.getByRole("textbox", { name: "Record a shortcut for Back" }),
      { key: "ArrowLeft", code: "ArrowLeft", metaKey: true },
    );

    await waitFor(() => expect(writes).toEqual([
      { kind: "set", actionId: "navigation.back", chords: ["CmdOrCtrl+Left"] },
    ]));
    expect(await within(row("Back")).findByText(/edits text in a field/)).toBeInTheDocument();
  });

  it("filters to changed actions and resets one or all", async () => {
    const { writes } = installKeybindingsApi({ "threads.copy_link": ["CmdOrCtrl+Alt+C"] });
    await renderPage();

    fireEvent.click(screen.getByRole("radio", { name: "Changed" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(within(row("Copy Thread Link")).getByText("⌥⌘C")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset Copy Thread Link" }));
    await waitFor(() => expect(writes).toEqual([
      { kind: "reset", actionId: "threads.copy_link" },
    ]));
    expect(await screen.findByText("Every shortcut has its default.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset All" })).toBeDisabled();
  });

  it("confirms Reset All, listing what each shortcut goes back to", async () => {
    const { writes } = installKeybindingsApi({
      "threads.copy_link": ["CmdOrCtrl+Alt+C"],
      "navigation.search_threads": [],
    });
    await renderPage();

    const resetAll = screen.getByRole("button", { name: "Reset All" });
    // A real click focuses the button; the dialog returns focus to it.
    resetAll.focus();
    fireEvent.click(resetAll);
    const dialog = screen.getByRole("dialog", { name: "Reset 2 shortcuts to their defaults?" });
    const items = within(within(dialog).getByRole("list", { name: "Shortcuts to reset" }))
      .getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "Copy Thread Link⌥⌘C→Not set",
      "Search ThreadsNot set→⇧⌘F",
    ]);
    expect(writes).toEqual([]);

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(resetAll).toHaveFocus();
    expect(writes).toEqual([]);

    fireEvent.click(resetAll);
    fireEvent.click(screen.getByRole("button", { name: "Reset 2 Shortcuts" }));
    await waitFor(() => expect(writes).toEqual([{ kind: "reset_all" }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("filters by a chord's label", async () => {
    installKeybindingsApi();
    await renderPage();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter shortcuts" }), {
      target: { value: "⇧⌘P" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(row("Pin / Unpin")).toBeInTheDocument();
  });

  it("reports a file that does not parse", async () => {
    installKeybindingsApi({}, { readError: "Expected ']' at line 1" });
    await renderPage();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "keybindings.toml could not be read, so every shortcut has its default until the file is fixed. Expected ']' at line 1",
    );
  });
});
