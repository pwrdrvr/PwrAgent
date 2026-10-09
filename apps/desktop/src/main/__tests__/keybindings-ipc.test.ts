import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const sent: Array<{ channel: string; payload: unknown }> = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      handlers.delete(channel);
    }),
  },
}));

vi.mock("../log", () => ({
  getMainLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));

vi.mock("../window-channels", () => ({
  subscribersForChannel: vi.fn(() => [
    {
      send: (channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      },
    },
  ]),
}));

let root: string;
let filePath: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "pwragent-keybindings-"));
  filePath = path.join(root, "keybindings.toml");
  handlers.clear();
  sent.length = 0;
});

afterEach(async () => {
  const { _resetKeybindingsIpcForTests } = await import("../ipc/keybindings");
  _resetKeybindingsIpcForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("keybindings store", () => {
  it("reads a missing file as no overrides", async () => {
    const { readKeybindingsFile } = await import("../keybindings/keybindings-store");
    expect(readKeybindingsFile(filePath)).toEqual({ overrides: {}, filePath });
  });

  it("writes only the changed action, in its group's table", async () => {
    const { readKeybindingsFile, writeKeybindingsFile } = await import(
      "../keybindings/keybindings-store"
    );
    const snapshot = writeKeybindingsFile(filePath, {
      kind: "set",
      actionId: "threads.copy_link",
      chords: ["cmdorctrl+alt+c"],
    });

    expect(snapshot.overrides).toEqual({ "threads.copy_link": ["CmdOrCtrl+Alt+C"] });
    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("[threads]");
    expect(source).toContain('copy_link = ["CmdOrCtrl+Alt+C"]');
    expect(source).not.toContain("rename");
    expect(readKeybindingsFile(filePath).overrides).toEqual(snapshot.overrides);
  });

  it("reads an empty list as an unbound action", async () => {
    const { readKeybindingsFile, writeKeybindingsFile } = await import(
      "../keybindings/keybindings-store"
    );
    writeKeybindingsFile(filePath, {
      kind: "set",
      actionId: "navigation.search_threads",
      chords: [],
    });
    expect(readKeybindingsFile(filePath).overrides).toEqual({
      "navigation.search_threads": [],
    });
  });

  it("keeps the operator's comments and unknown keys across a save", async () => {
    const { writeKeybindingsFile } = await import("../keybindings/keybindings-store");
    fs.writeFileSync(
      filePath,
      [
        "# my shortcuts",
        "[threads]",
        "# F2 is muscle memory",
        'rename = ["F2"]',
        'someday = ["CmdOrCtrl+J"]',
        "",
      ].join("\n"),
    );

    const snapshot = writeKeybindingsFile(filePath, {
      kind: "set",
      actionId: "threads.archive",
      chords: ["CmdOrCtrl+Backspace"],
    });

    const source = fs.readFileSync(filePath, "utf8");
    expect(source).toContain("# my shortcuts");
    expect(source).toContain("# F2 is muscle memory");
    expect(source).toContain('someday = ["CmdOrCtrl+J"]');
    expect(snapshot.overrides).toEqual({
      "threads.rename": ["F2"],
      "threads.archive": ["CmdOrCtrl+Backspace"],
    });
  });

  it("removes an action on reset, and every action on reset all", async () => {
    const { writeKeybindingsFile } = await import("../keybindings/keybindings-store");
    writeKeybindingsFile(filePath, { kind: "set", actionId: "threads.rename", chords: ["F2"] });
    writeKeybindingsFile(filePath, { kind: "set", actionId: "threads.lock", chords: ["CmdOrCtrl+Alt+L"] });

    expect(
      writeKeybindingsFile(filePath, { kind: "reset", actionId: "threads.rename" }).overrides,
    ).toEqual({ "threads.lock": ["CmdOrCtrl+Alt+L"] });
    expect(writeKeybindingsFile(filePath, { kind: "reset_all" }).overrides).toEqual({});
  });

  it("moves a chord between actions in one save, or not at all", async () => {
    const { readKeybindingsFile, writeKeybindingsFile } = await import(
      "../keybindings/keybindings-store"
    );
    writeKeybindingsFile(filePath, { kind: "set", actionId: "threads.lock", chords: ["CmdOrCtrl+Alt+L"] });

    expect(() =>
      writeKeybindingsFile(filePath, {
        kind: "set_many",
        changes: [
          { actionId: "threads.lock", chords: [] },
          { actionId: "threads.rename", chords: ["Nope+"] },
        ],
      }),
    ).toThrow(/not a keyboard shortcut/);
    // The bad half wrote nothing, so Lock keeps its chord.
    expect(readKeybindingsFile(filePath).overrides).toEqual({ "threads.lock": ["CmdOrCtrl+Alt+L"] });
    expect(
      writeKeybindingsFile(filePath, {
        kind: "set_many",
        changes: [
          { actionId: "threads.lock", chords: [] },
          { actionId: "threads.rename", chords: ["CmdOrCtrl+Alt+L"] },
        ],
      }).overrides,
    ).toEqual({ "threads.lock": [], "threads.rename": ["CmdOrCtrl+Alt+L"] });
  });

  it("drops a chord that does not parse and keeps the rest", async () => {
    const { readKeybindingsFile } = await import("../keybindings/keybindings-store");
    fs.writeFileSync(filePath, '[threads]\nrename = ["Banana+Q", "F2", "f2"]\n');
    expect(readKeybindingsFile(filePath).overrides).toEqual({ "threads.rename": ["F2"] });
  });

  it("applies the defaults and reports a file that does not parse, and refuses to rewrite it", async () => {
    const { readKeybindingsFile, writeKeybindingsFile } = await import(
      "../keybindings/keybindings-store"
    );
    const broken = '[threads\nrename = ["F2"\n';
    fs.writeFileSync(filePath, broken);

    const snapshot = readKeybindingsFile(filePath);
    expect(snapshot.overrides).toEqual({});
    expect(snapshot.error).toBeTruthy();
    expect(() =>
      writeKeybindingsFile(filePath, { kind: "set", actionId: "threads.rename", chords: ["F2"] }),
    ).toThrow();
    expect(fs.readFileSync(filePath, "utf8")).toBe(broken);
  });

  it("refuses an unknown action and a chord that does not parse", async () => {
    const { writeKeybindingsFile } = await import("../keybindings/keybindings-store");
    expect(() =>
      writeKeybindingsFile(filePath, {
        kind: "set",
        actionId: "threads.nope" as "threads.rename",
        chords: ["F2"],
      }),
    ).toThrow(/Unknown/);
    expect(() =>
      writeKeybindingsFile(filePath, { kind: "set", actionId: "threads.rename", chords: ["Nope+"] }),
    ).toThrow(/not a keyboard shortcut/);
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it("sees an atomic replace of the file", async () => {
    const { watchKeybindingsFile } = await import("../keybindings/keybindings-store");
    const onChange = vi.fn();
    const watcher = watchKeybindingsFile(filePath, onChange, { debounceMs: 10 });
    try {
      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, '[threads]\nrename = ["F2"]\n');
      fs.renameSync(tmp, filePath);
      await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
    } finally {
      watcher.close();
    }
  });
});

describe("keybindings ipc", () => {
  it("serves the snapshot and broadcasts a write to every window", async () => {
    const { registerKeybindingsIpcHandlers, onKeybindingsChanged } = await import(
      "../ipc/keybindings"
    );
    const { KEYBINDINGS_CHANGED_CHANNEL, KEYBINDINGS_READ_CHANNEL, KEYBINDINGS_WRITE_CHANNEL } =
      await import("../../shared/ipc");
    registerKeybindingsIpcHandlers({ filePath });
    const listener = vi.fn();
    onKeybindingsChanged(listener);

    expect(await handlers.get(KEYBINDINGS_READ_CHANNEL)?.({})).toEqual({
      overrides: {},
      filePath,
    });

    const written = await handlers.get(KEYBINDINGS_WRITE_CHANNEL)?.({}, {
      kind: "set",
      actionId: "threads.toggle_pin",
      chords: ["CmdOrCtrl+Alt+P"],
    });

    const expected = {
      overrides: { "threads.toggle_pin": ["CmdOrCtrl+Alt+P"] },
      filePath,
    };
    expect(written).toEqual(expected);
    expect(sent).toEqual([{ channel: KEYBINDINGS_CHANGED_CHANNEL, payload: expected }]);
    expect(listener).toHaveBeenCalledWith(expected);
    expect(await handlers.get(KEYBINDINGS_READ_CHANNEL)?.({})).toEqual(expected);
  });

  it("refuses a malformed write request", async () => {
    const { registerKeybindingsIpcHandlers } = await import("../ipc/keybindings");
    const { KEYBINDINGS_WRITE_CHANNEL } = await import("../../shared/ipc");
    registerKeybindingsIpcHandlers({ filePath });
    const write = handlers.get(KEYBINDINGS_WRITE_CHANNEL)!;

    expect(() => write({}, null)).toThrow();
    expect(() => write({}, { kind: "set", actionId: "threads.nope", chords: [] })).toThrow();
    expect(() => write({}, { kind: "set", actionId: "threads.rename", chords: [1] })).toThrow();
    expect(() => write({}, { kind: "move", actionId: "threads.rename" })).toThrow();
    expect(() => write({}, { kind: "set_many", changes: [] })).toThrow();
    expect(() => write({}, {
      kind: "set_many",
      changes: [{ actionId: "threads.nope", chords: [] }],
    })).toThrow();
    expect(sent).toEqual([]);
  });
});
