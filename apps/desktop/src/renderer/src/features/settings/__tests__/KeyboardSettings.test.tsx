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

function press(target: HTMLElement, init: KeyboardEventInit) {
  fireEvent.keyDown(target, init);
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
